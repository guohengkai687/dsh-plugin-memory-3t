/**
 * dsh-plugin-memory-3t 插件入口：机制层接线。
 *
 * - 生命周期（v0.6.5 勘误）：DSH **确实存在** `agent/session-start` 事件——
 *   `dsh-agent/lib/types/runtime-types.d.ts` 的 cordis Events 显式声明
 *   `'agent/session-start'(payload: { agent, source: SessionStartSource })`（@mode emit），
 *   `dsh-agent-loop` 在 `announce(agent)`（即 `agent/created`）之后真实发射，且
 *   `dsh-scope` 的 scope 分发表含它；`SessionStartSource = 'startup'|'resume'|'clear'|'compact'`。
 *   v0.6.4 曾判定"该事件不存在、误监听导致死代码"——**该论断有误**（详见 README「事件勘误」）。
 *   绑 `agent/created` 功能上可行（同 agent、相邻发射，故当时确实修好了库根跑偏——真正的修复
 *   是"不再在 apply 期按进程 cwd 急切建库"），但**丢失了 `source` 语义**（agent/created 的
 *   payload 只有 `{agent}`，没有 source）。
 *   v0.6.5 起**两者兼听**（同一 handler + 幂等守卫，任一边存在都能工作），并用 source 处理
 *   `clear`/`compact`（上下文被重置/压缩 → 已注入的会话视图已不在上下文里，需重装并允许再注一次）。
 * - 工作区根（v0.3.1）：按会话真实工作区 agent.session.header.cwd 解析，不再假设进程 cwd；
 *   回退链 workspaceDir 固定 > 会话工作区根 > process.cwd()（headless/旧形态）。
 * - system-prompt：dev-memory-boot context（order -200，**静态文本**：逐请求注入但逐字节恒定，
 *   不携带任何易变状态，故不破坏 prefix 缓存）。
 * - 注入时机（v0.6.5 重构）：召回内容（状态块 + L1 回放 + L3 top-k）改为**每会话首次 pre-step
 *   只注入一次**（对照 Hindsight「会话首个 prompt 仅一次」）。原因：DSH 的 systemPrompt.context
 *   会被渲染进每请求重新组装的 "Current runtime context" 快照，携带易变/大块内容等于
 *   每轮重复计费 + 历史堆积互相 supersede 的旧快照。
 * - skills：内嵌 dev-memory 协议
 * - tools：11 个 devmemory_* 工具（含 v0.4 新增 devmemory_diag 诊断汇总）
 * - diag（v0.4）：工具调用异常 / 生命周期失败 / 降级路径自动记入 <库>/diag/events.jsonl，
 *   供使用一段时间后审查汇总、优化插件（fail-open，存不进也不打断业务）。
 *
 * 全部外部可触发路径 fail-open：记忆故障只降级（跳过注入/提示 status），
 * 绝不让记忆问题打断会话。
 *
 * 注意：插件零运行时依赖，故本地定义最小 ctx 形状（DSH/Cordis 满足该形状）；
 * 安装 @deepseek-ai/cordis 作为 devDep 可获得完整类型（见 README）。
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { mergeConfig, type Config } from './config.js'
import { DigestEngine, messageText } from './digest.js'
import { NUDGE_MESSAGE, pickNudgeTarget, RecallNudgeController } from './nudge.js'
import { renderBootBlock, renderStatusBlock, type StoreStatus } from './render.js'
import { seedLibrary } from './seed.js'
import { resolveRoot } from './paths.js'
import { loadMemorySkillContent, MEMORY_SKILL_DESCRIPTION, MEMORY_SKILL_INVOCATION, MEMORY_SKILL_NAME, MEMORY_SKILL_WHEN_TO_USE } from './skill.js'
import { MemoryStore } from './store.js'
import { applyEffective, installDevMemorySettings } from './settings.js'
import { createTools } from './tools.js'
import { registerWebPanel } from './webui.js'

/** 最小插件上下文形状（运行时由 DSH/Cordis 提供）。 */
export interface PluginContext {
  logger: {
    warn(message: string): void
    info?(message: string): void
  }
  on(event: string, handler: (...args: any[]) => unknown): unknown
  /** Cordis 反射读服务（webServer 等可选服务探测用）。 */
  get?(name: string, strict?: boolean): unknown
  /** Cordis 服务注入（v0.5 设置桥用；headless stub 无则跳过）。 */
  inject?(name: readonly string[], callback: (scoped: unknown) => void): unknown
  skills: { register(skill: unknown): unknown }
  tools: { register(tool: unknown): unknown }
  systemPrompt: { context(entry: { name: string; order: number; text: (context?: unknown) => string }): unknown }
}

export const name = 'dsh-plugin-memory-3t'
export const inject = ['systemPrompt', 'skills', 'tools']

interface AgentView {
  /** 易变状态块（v0.6.5：原在 boot 块里逐请求注入，现随本视图一次性注入）。 */
  status: string
  runtime: string
  spaces: string
  reminded: number
  /** v0.6.5：会话视图是否已一次性注入过（每会话一次，clear/compact 后重置）。 */
  injected: boolean
}

interface SessionMessage {
  role: string
  text: string
}

/** 回忆触发词：命中时（且预算内）提示模型可用 devmemory_recall。 */
const RECALL_HINT_RE = /还记得|之前(?:的|聊过|说过)?|上次|以前|先前|我们说过|我们聊过|earlier|last time|before\b|remember\b/iu

const RECALL_REMINDER =
  '这些内容可能与既有记忆相关：本工作区记忆库（L1 流水 / L2 笔记 / L3 事实）可能已记录过。需要时用 devmemory_recall 查询，不要臆造记忆；查不到就明说并主动提出记录。'

/** 近邻会话消息缓冲（环形，digest 候选源之一）。 */
const SESSION_BUFFER_LIMIT = 64

function createPluginMessage(text: string, form: string, summary?: string): Record<string, unknown> {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-plugin-memory-3t', form, ...(summary === undefined ? {} : { summary }) },
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function apply(ctx: PluginContext, rawConfig: unknown): void {
  const config: Config = mergeConfig(rawConfig)
  // v0.3.1：workspace 根按会话真实工作区（agent.session.header.cwd，DSH 规范）解析，
  // 不再假设进程 cwd。优先级：config.workspaceDir 显式固定 > 会话工作区根 > process.cwd()（headless/旧形态回退）。
  const pinnedWorkspace = config.workspaceDir.trim() !== '' ? resolve(config.workspaceDir.trim()) : null

  const agentViews = new WeakMap<object, AgentView>()
  const viewBySession = new Map<string, AgentView>()
  const rootAgents = new Map<string, object>()
  const nudgedSessions = new Set<string>()
  const sessionBuffer: SessionMessage[] = []
  let cachedStatus: StoreStatus | null = null
  let initWarned = false
  /** WebUI 面板当前挂载的卸载函数（v0.5：设置页 live 重挂载用；null = 未挂载/已摘除）。 */
  let panelDispose: (() => void) | null = null

  const warn = (message: string): void => {
    try {
      ctx.logger.warn(message)
    } catch {
      /* logger 不可用时静默 */
    }
    // v0.4：所有 fail-open 警告（降级/异常）同步记入诊断日志，供定期审查优化插件
    const store = active?.store
    if (store !== undefined) {
      void store.diag
        .record({
          level: /失败/.test(message) ? 'error' : 'unexpected',
          origin: diagOriginOf(message),
          message,
        })
        .catch(() => undefined)
    }
  }

  /** 从警告文案推断诊断来源（分类用；未命中归 lifecycle）。 */
  function diagOriginOf(message: string): string {
    if (/初始化/.test(message)) return 'init'
    if (/视图装载/.test(message)) return 'session'
    if (/digest|沉淀/.test(message)) return 'digest'
    if (/补交|提交/.test(message)) return 'vcs'
    if (/注入/.test(message)) return 'pre-step'
    if (/工具注册/.test(message)) return 'tools'
    if (/WebUI|面板/.test(message)) return 'webui'
    if (/skill 注册/.test(message)) return 'skill'
    if (/nudge/.test(message)) return 'nudge'
    return 'lifecycle'
  }

  // ------------------------------------------------------------ 记忆库（按工作区懒解析，v0.3.1）

  let active: { store: MemoryStore; engine: DigestEngine; root: string } | null = null
  /**
   * 库根 → 已建实例的缓存（v0.6.3）。
   *
   * 必须缓存**实例本身**，不能只记"该根已 init 过"：库根 A→B→A 来回切换时，
   * 后者会为 A 新建一个实例却跳过它的 init()，使该实例的 GitVcs 永远停在默认值
   * （available=false / ready=false，且 lastError 为 null），自动提交被静默吞掉、
   * diag 也无任何记录。缓存实例则保证每个根只有一份实现，复访直接复用。
   */
  const storeCache = new Map<string, { store: MemoryStore; engine: DigestEngine }>()

  /**
   * 取当前工作区的记忆库。会话工作区根与已建库根不同时切换（每个库根只建一次实例、
   * 只 init 一次，fail-open）。
   * sessionCwd 缺省：
   * - 已建库 → 沿用当前库（工具/边界回调在会话内执行，会话启动已绑定正确工作区；
   *   绝不用进程 cwd 把库"切回去"）；
   * - 未建库 → 回退 process.cwd()（headless / CLI 形态与旧行为一致）。
   *
   * v0.6.4：所有**带会话上下文**的路径（agent/created / pre-step / turn-stopping）
   * 必须显式传 sessionCwd（payload.agent 的 session.header.cwd）；不带 cwd 的调用
   * 只有 headless 工具路径与 apply 期显式钉死（workspaceDir）/ user 全局库，
   * 否则会按进程 cwd 建出"跑偏"的空库。
   */
  const ensureStore = (
    sessionCwd?: string,
    opts?: { sessionContext?: boolean },
  ): { store: MemoryStore; engine: DigestEngine } => {
    const fromSession = opts?.sessionContext === true
    if (active !== null && sessionCwd === undefined && !fromSession) return active
    // v0.6.5 库根来源守卫：会话里解析不到真实工作区根时，本库根只能是"进程 cwd 推导"的不可信来源
    // （v0.6.3 的库根跑偏正是这样发生的）→ 拒绝写入，但保留读取/注入（fail-open 不打断会话）。
    const unresolvedSession =
      fromSession && pinnedWorkspace === null && config.scope === 'workspace' && (sessionCwd ?? '').trim() === ''
    const guardReason = unresolvedSession
      ? '当前会话未提供真实工作区根（session.header.cwd 缺失），本库根由进程 cwd 推导、来源不可信'
      : null
    // 已绑定会话库且本次无法解析工作区 → 沿用现有库并加守卫，绝不按进程 cwd 切库
    if (guardReason !== null && active !== null) {
      active.store.setWriteGuard(guardReason)
      return active
    }
    const workspaceRoot = pinnedWorkspace ?? sessionCwd ?? process.cwd()
    const root = resolveRoot(workspaceRoot, config.storageDir, config.scope)
    if (active !== null && active.root === root) {
      if (guardReason !== null) active.store.setWriteGuard(guardReason)
      return active
    }
    const cached = storeCache.get(root)
    if (cached !== undefined) {
      if (guardReason !== null) cached.store.setWriteGuard(guardReason)
      active = { store: cached.store, engine: cached.engine, root }
      return active
    }
    const store = new MemoryStore(workspaceRoot, config)
    if (guardReason !== null) store.setWriteGuard(guardReason)
    const engine = new DigestEngine(store)
    storeCache.set(root, { store, engine })
    active = { store, engine, root }
    void store
      .init()
      .then(async () => {
        cachedStatus = await store.status()
        ctx.logger.info?.('[dev-memory] 记忆库就绪: ' + store.root)
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        // v0.6.5：显式标记"库不可用"（≠ 空库）；markUnavailable 内部记一条 error 诊断，
        // 故此处直接走 logger，避免与 warn() 的诊断埋点重复。
        store.markUnavailable(`初始化失败: ${message}`)
        if (!initWarned) {
          initWarned = true
          try {
            ctx.logger.warn(`[dev-memory] 记忆库初始化失败（已降级为不注入记忆）: ${message}`)
          } catch {
            /* logger 不可用时静默 */
          }
        }
      })
    return active
  }

  // v0.6.4：启动绑定仅限显式钉死（workspaceDir）或 user 全局库（homedir 基准稳定）；
  // workspace 自动解析推迟到首个真实会话边（agent/created / pre-step 按会话 cwd 绑定），
  // 避免在 web 进程中按 process.cwd() 预建一个"跑偏"的空库（曾出现在 DSH 服务 cwd，即本次 bug 的表现）。
  if (pinnedWorkspace !== null || config.scope === 'user') ensureStore()

  // ------------------------------------------------------------ 只读 WebUI 面板挂载（v0.5：设置页 live 可开关）

  /** 按当前开关状态挂载/摘除面板：关 → 摘除；开且未挂载 → 注册（headless 无 webServer 保持 null）。 */
  const ensurePanel = (): void => {
    if (config.webui.enabled !== true) {
      if (panelDispose !== null) {
        try {
          panelDispose()
        } catch {
          /* 卸载失败静默 */
        }
        panelDispose = null
      }
      return
    }
    if (panelDispose !== null) return
    try {
      panelDispose = registerWebPanel(ctx, () => ensureStore().store, config)
    } catch (error) {
      warn(`[dev-memory] WebUI 面板注册失败（已跳过）: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ------------------------------------------------------------ skill（协议层）

  try {
    ctx.skills.register({
      name: MEMORY_SKILL_NAME,
      description: MEMORY_SKILL_DESCRIPTION,
      whenToUse: MEMORY_SKILL_WHEN_TO_USE,
      content: loadMemorySkillContent(),
      invocation: MEMORY_SKILL_INVOCATION,
    })
  } catch (error) {
    warn(`[dev-memory] skill 注册失败: ${error instanceof Error ? error.message : String(error)}`)
  }

  // ------------------------------------------------------------ boot context

  /** boot 用的库状态：优先最近一次 status()，未就绪时给中性占位（不误报"不可用"）。 */
  const bootStatus = (): StoreStatus => {
    if (cachedStatus !== null) return cachedStatus
    // v0.6.5：尚未跑到 status() 但库已明确标记不可用时，也要让 boot 块显式告警（降级 ≠ 空库）
    const reason = active?.store.unavailableReason ?? null
    return {
      ready: false,
      root: active?.store.root ?? '(未初始化)',
      scope: config.scope,
      counts: { l1: 0, l2: 0, l3: 0 },
      lastDigestAt: null,
      indexDirty: 0,
      firstRun: true,
      ...(reason !== null ? { availability: 'unavailable' as const, unavailableReason: reason } : {}),
      vcs: {
        enabled: config.vcs.enabled,
        available: false,
        ready: false,
        branch: null,
        commits: 0,
        pendingWrites: active?.store.vcs.pendingWrites ?? 0,
      },
      embedding: {
        enabled: config.embedding.enabled,
        ready: false,
        degraded: config.embedding.enabled,
        model: config.embedding.model,
        vectorCount: 0,
      },
      diag: { enabled: config.diag.enabled, total: 0, error: 0, unexpected: 0 },
    }
  }

  // v0.6.5：本 context 只放**静态**协议文本（逐请求注入，但逐字节恒定 → 不破坏 prefix 缓存）。
  // 召回内容（状态块 / L1 回放 / L3 top-k）不再从这里出去，见 pre-step 的每会话一次性注入。
  ctx.systemPrompt.context({
    name: 'dev-memory-boot',
    order: -200,
    text: () => renderBootBlock(bootStatus(), config.maxBootTokens),
  })

  // ------------------------------------------------------------ 生命周期

  // ------------------------------------------------------------ 会话启动边（v0.6.5：兼听两条边 + 幂等守卫）
  //
  // 勘误（v0.6.4 → v0.6.5）：`agent/session-start` **真实存在**。证据（DSH 0.1.5-rc.2 本地源码）：
  //   1. dsh-agent/lib/types/runtime-types.d.ts 的 cordis `Events` 显式声明
  //      'agent/session-start'(payload: { agent, source: SessionStartSource })，@mode emit；
  //   2. dsh-agent-loop 在 loopCtx.agents.announce(agent)（即 agent/created）之后真实发射
  //      emitAgentEvent(loopCtx, agent, "agent/session-start", { source })；
  //   3. dsh-scope/lib/invariant.js 的 scope 分发表含 "agent/session-start"。
  //   而 `agent/created` 的 payload 只有 { agent }——**source 只属于 session-start**。
  // 因此 v0.6.4 的"事件不存在→死代码"论断有误；真正治好库根跑偏的是同批改动里的
  // "workspace 自动解析不再在 apply 期按进程 cwd 急切建库" + 按 payload.agent 复绑。
  //
  // 兼听策略（确定性，不依赖事件发射顺序或定时器）：
  //   - 先到 agent/created → 记为"临时(created)"并执行全量会话启动；
  //   - 随后 agent/session-start 到达 → 只**升级记录**真实 source（不重复装载视图/补做/补交）；
  //   - source = clear/compact → 视为上下文被重置/压缩：此前注入的会话视图已不在上下文里，
  //     **重装视图并允许再注一次**（Hindsight 只注一次，压缩后只能靠模型自己调 reflect 找回；
  //     我们用 source 把这一步自动化）；
  //   - 若某版本只发其中一条边，另一条缺失也不影响（幂等守卫保证只跑一次）。
  const startedSources = new WeakMap<object, string>()

  const handleSessionStart = async (agent: object, source: string, eventName: string): Promise<void> => {
    const last = startedSources.get(agent)
    const provisional = last === 'created'
    const rerun = source === 'clear' || source === 'compact'
    // 已处理过 且 不是 clear/compact 重装 且 不是 created→真实 source 的升级 → 跳过
    if (last !== undefined && !rerun && !(provisional && source !== 'created')) return
    startedSources.set(agent, source)
    const upgradeOnly = provisional && !rerun
    if (upgradeOnly) {
      // created 先到、session-start 后到：只补记真实 source（这是核对 DSH 事件语义的现场证据）
      try {
        const { store } = ensureStore(sessionCwdOf(agent), { sessionContext: true })
        void store.diag
          .record({
            level: 'unexpected',
            origin: 'session',
            message: `会话启动边升级：agent/created → agent/session-start（source=${source || 'unknown'}）`,
          })
          .catch(() => undefined)
      } catch {
        /* 诊断记不上不影响会话 */
      }
      return
    }
    try {
      const sessionId = sessionIdOf(agent)
      const parent = parentSessionOf(agent)
      const previous = agentViews.get(agent)
      // 1) 按会话真实工作区绑定库根（subagent 通常同工作区 → 命中 storeCache 实例，开销可忽略）
      const { store, engine } = ensureStore(sessionCwdOf(agent), { sessionContext: true })
      // 1.5) v0.6.5：冷启动 seed（**默认关**）。开启后库为空即自动生成项目骨架，
      //      复刻 Hindsight 的"零配置开箱即有记忆"；默认关是因为我们坚持"写库是显式动作"
      //      （由 skill 引导模型在空库时调用 devmemory_seed）。fail-open，写不了只记诊断。
      if (config.seed.enabled && config.seed.auto) {
        try {
          const pre = await store.status()
          if (pre.availability === 'empty') {
            const seeded = await seedLibrary(store, config)
            if (seeded.written) ctx.logger.info?.(`[dev-memory] 冷启动 seed 已生成骨架: ${seeded.relPath}`)
          }
        } catch (error) {
          warn(`[dev-memory] 冷启动 seed 失败（降级）: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // 2) 视图：根会话（无父会话或父视图缺失）装载；subagent 继承父会话视图
      if (parent === undefined || !viewBySession.has(parent)) {
        const view = await loadSessionView(store, config, previous)
        agentViews.set(agent, view)
        if (sessionId !== '') viewBySession.set(sessionId, view)
        if (parent === undefined && sessionId !== '') rootAgents.set(sessionId, agent)
      } else {
        const inherited = viewBySession.get(parent)
        if (inherited !== undefined) {
          // 继承父视图内容，但 injected 置 false：subagent 有自己的上下文，需要自己那份一次注入
          const view = { ...inherited, reminded: 0, injected: false }
          agentViews.set(agent, view)
          if (sessionId !== '') viewBySession.set(sessionId, view)
        }
      }
      cachedStatus = await store.status()
      // 2.5) v0.6.5：现场记录实际走到的边与 source（供核对 DSH 版本行为；clear/compact 重装也可见）
      void store.diag
        .record({
          level: 'unexpected',
          origin: 'session',
          message: `会话启动边=${eventName} source=${source || 'unknown'}（视图${rerun ? '重装' : '装载'}）`,
        })
        .catch(() => undefined)
      // 3) digest 补做：上次 pending 且 retries 未超限
      if (store.digestState.pending) {
        try {
          await engine.runPending('agent-created')
        } catch (error) {
          warn(`[dev-memory] digest 补做失败（降级）: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // 4) 跨会话遗留的未提交写入补交（fail-open）
      if (store.vcs.pendingWrites > 0) {
        try {
          await store.flushVcs('会话启动补交')
        } catch (error) {
          warn(`[dev-memory] 会话启动补交失败（降级）: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // 5) webServer 可能晚于插件 apply 才就绪 → 首次会话补一次面板挂载
      ensurePanel()
    } catch (error) {
      // DSH 的会话启动边是 serial 且 listener 抛错会回滚 attach → 必须 fail-open，绝不向运行时抛错
      warn(`[dev-memory] 会话视图装载失败（降级）: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // agent/session-start（DSH 规范会话启动边，携带 source）
  ctx.on('agent/session-start', async (payload: unknown) => {
    const agent = isObject(payload) ? payload.agent : undefined
    if (!isObject(agent)) return
    const source = payload !== null && typeof (payload as Record<string, unknown>).source === 'string'
      ? ((payload as Record<string, unknown>).source as string)
      : ''
    await handleSessionStart(agent, source, 'agent/session-start')
  })

  // agent/created（兼容边；payload 只有 {agent}，无 source）
  ctx.on('agent/created', async (payload: unknown) => {
    const agent = isObject(payload) ? payload.agent : undefined
    if (!isObject(agent)) return
    await handleSessionStart(agent, 'created', 'agent/created')
  })

  // pre-step（waterfall）：记录 user 消息 + **每会话一次**的会话视图注入 + 引导提醒
  ctx.on('agent/pre-step', async (payload: unknown, next: () => Promise<unknown>) => {
    const stepAgent = isObject(payload) ? payload.agent : undefined
    try {
      // v0.6.4：按 payload.agent 的真实工作区绑定（多工作区并存、或插件热重载后首个步骤，都能落到正确库根）
      recordMessages(payload, sessionBuffer, ensureStore(sessionCwdOf(stepAgent), { sessionContext: true }).store)
    } catch {
      /* 流水记录失败不影响步骤 */
    }
    // v0.6.5：召回内容（状态块 + L1 回放 + L3 top-k）**每会话只注入一次**。
    // 机会式触发：视图就绪后的首个 pre-step 注入（不依赖会话启动边与首个 pre-step 的时序）。
    const viewText = takeSessionViewInjection(stepAgent, agentViews)
    const reminder = computeReminder(payload, agentViews)
    if (viewText === null && reminder === null) return next()
    try {
      const base = await next()
      if (!isObject(base) || !Array.isArray(base.messages)) return base
      const extra: Record<string, unknown>[] = []
      if (viewText !== null) {
        extra.push(
          createPluginMessage(
            viewText,
            'recall',
            'Session memory view (status + L1 replay + L3 top-k), injected once per session',
          ),
        )
      }
      if (reminder !== null) {
        extra.push(createPluginMessage(reminder.text, 'instructions', 'Optional memory recall reminder'))
      }
      return { ...base, messages: [...base.messages, ...extra] }
    } catch (error) {
      warn(`[dev-memory] pre-step 注入失败（跳过注入）: ${error instanceof Error ? error.message : String(error)}`)
      return next()
    }
  })

  // turn-stopping（serial）：digest 沉淀 + 会话边界版本提交（fail-open）
  ctx.on('agent/turn-stopping', async (payload: unknown) => {
    // v0.6.4：turn-stopping 的 payload 同样注入 agent → 按会话真实工作区绑定，digest/提交落到正确库
    const turnAgent = isObject(payload) ? payload.agent : undefined
    const { store, engine } = ensureStore(sessionCwdOf(turnAgent), { sessionContext: true })
    try {
      const summaries = await engine.maybeDigest({ key: 'root', messages: sessionBuffer })
      if (summaries !== null && summaries.length > 0) {
        for (const line of summaries) void store.appendRuntime(new Date(), `- digest: ${line}`).catch(() => undefined)
      }
      // v0.4：digest 失败（pending 待补做）→ 落 error 诊断
      if (store.digestState.pending) {
        void store.diag
          .record({
            level: 'error',
            origin: 'digest',
            message: `digest 失败待补做（重试 ${store.digestState.retries} 次）: ${store.digestState.lastError ?? '未知原因'}`,
          })
          .catch(() => undefined)
      }
      cachedStatus = await store.status()
      await store.flushVcs('会话边界')
    } catch (error) {
      warn(`[dev-memory] digest 异常（已记录状态）: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // （v0.6.4）subagent 视图继承 + 库根绑定已并入上方 agent/created 统一处理（原 created 独立块删除）

  // ------------------------------------------------------------ 主动追忆（v0.3，默认关）

  const fireNudge = (): void => {
    try {
      const target = pickNudgeTarget(rootAgents, nudgedSessions, sessionBuffer.length > 0)
      if (target === null) return
      nudgedSessions.add(target.id)
      const agent = target.agent as { followup?(message: unknown): void }
      agent.followup?.(createPluginMessage(NUDGE_MESSAGE, 'followup', 'Proactive memory nudge'))
    } catch (error) {
      // v0.4：nudge 发送失败记一条诊断（原 fail-open 静默 → 变为可审查）
      void active?.store?.diag
        .record({
          level: 'unexpected',
          origin: 'nudge',
          message: `recallNudge 发送失败: ${error instanceof Error ? error.message : String(error)}`,
        })
        .catch(() => undefined)
    }
  }
  const nudge = new RecallNudgeController({ enabled: config.recallNudge.enabled, onFire: fireNudge })
  nudge.start()
  try {
    ctx.on('dispose', () => nudge.dispose())
  } catch {
    /* stub ctx 无 dispose 事件时忽略 */
  }

  // ------------------------------------------------------------ tools

  for (const tool of createTools(() => ensureStore().store, () => ensureStore().engine)) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      warn(`[dev-memory] 工具注册失败 ${tool.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ------------------------------------------------------------ 只读 WebUI 面板（v0.3/v0.5）

  ensurePanel()

  // ------------------------------------------------------------ 设置页桥（v0.5）

  // live 钩子：设置变更生效（config 已被 applyEffective 原地更新，各模块按引用读取；
  // 此处只补副作用：WebUI 重挂载 / diag caps / nudge 开关）
  const applySettingsLive = (next: unknown): void => {
    const change = applyEffective(config, next)
    if (change.webui === true) {
      try {
        panelDispose?.()
      } catch {
        /* 卸载失败静默 */
      }
      panelDispose = null
      ensurePanel()
    }
    if (change.diag === true) {
      try {
        ensureStore().store.diag.updateConfig(config.diag)
      } catch {
        /* store 未就绪：config 已更新，下次构造生效 */
      }
    }
    if (change.nudge === true) {
      nudge.setEnabled(config.recallNudge.enabled)
    }
  }
  installDevMemorySettings(ctx, config, { apply: applySettingsLive })
}

// ------------------------------------------------------------ 内部 helpers

function sessionIdOf(agent: unknown): string {
  if (!isObject(agent)) return ''
  try {
    const id = (agent as Record<string, unknown>).id
    return typeof id === 'string' ? id : ''
  } catch {
    return ''
  }
}

/** 父会话 id（subagent 的 session.header.parentSession）；根会话无 parent → undefined。 */
function parentSessionOf(agent: unknown): string | undefined {
  if (!isObject(agent)) return undefined
  try {
    const session = (agent as Record<string, unknown>).session
    if (!isObject(session)) return undefined
    const header = (session as Record<string, unknown>).header
    if (!isObject(header)) return undefined
    const parent = (header as Record<string, unknown>).parentSession
    return typeof parent === 'string' ? parent : undefined
  } catch {
    return undefined
  }
}

/** 会话真实工作区根：agent.session.header.cwd（DSH 规范字段）；缺省 → undefined（调用方回退）。v0.3.1 */
function sessionCwdOf(agent: unknown): string | undefined {
  if (!isObject(agent)) return undefined
  try {
    const session = (agent as Record<string, unknown>).session
    if (!isObject(session)) return undefined
    const header = (session as Record<string, unknown>).header
    if (!isObject(header)) return undefined
    const cwd = (header as Record<string, unknown>).cwd
    return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

function recordMessages(payload: unknown, buffer: SessionMessage[], store: MemoryStore): void {
  const messages = isObject(payload) ? payload.messages : undefined
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (!isObject(message) || message.role !== 'user') continue
    const text = messageText(message.content)
    if (text.length < 4) continue
    buffer.push({ role: 'user', text: text.slice(0, 2000) })
    if (buffer.length > SESSION_BUFFER_LIMIT) buffer.splice(0, buffer.length - SESSION_BUFFER_LIMIT)
    void store
      .appendRuntime(new Date(), `- user: ${text.replace(/\s+/g, ' ').slice(0, 500)}`)
      .catch(() => undefined)
  }
}

function computeReminder(payload: unknown, views: WeakMap<object, AgentView>): { text: string } | null {
  const agent = isObject(payload) ? payload.agent : undefined
  if (!isObject(agent)) return null
  const view = views.get(agent)
  if (view === undefined || view.reminded >= 2) return null
  const messages = isObject(payload) ? payload.messages : undefined
  if (!Array.isArray(messages)) return null
  const text = messages.map((m) => (isObject(m) ? messageText(m.content) : '')).join('\n')
  if (!RECALL_HINT_RE.test(text)) return null
  view.reminded += 1
  return { text: RECALL_REMINDER }
}

/** 装载会话视图：L1 最近 2 日流水摘要 + L3 高活跃事实 top-k（受 token 预算钳制）。 */
async function loadSessionView(
  store: MemoryStore,
  config: Config,
  previous: AgentView | undefined,
): Promise<AgentView> {
  const status = await store.status()
  const runtimeLines: string[] = []
  const now = new Date()
  for (let offset = 0; offset < 2; offset++) {
    const date = new Date(now.getTime() - offset * 86_400_000)
    const raw = await store.readRuntime(date)
    const heading = raw.split(/\r?\n/)[0]?.trim() ?? ''
    const content = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('- ') || line.startsWith('## '))
      .slice(0, 24)
    if (content.length > 0) runtimeLines.push(`## ${heading || date.toISOString().slice(0, 10)}`, ...content.slice(0, 12))
  }
  const entries = await store.listEntries()
  const top = entries
    .filter((e) => e.salience >= config.recall.minSalience)
    .sort((a, b) => b.salience - a.salience || b.accesses - a.accesses)
    .slice(0, 5)
  const spaces = top.map((e) => ({ summary: e.summary, tags: e.tags }))
  return {
    // v0.6.5：易变状态块与会话视图一起**只注入一次**（原在 boot 块里逐请求注入）
    status: renderStatusBlock(status, config.maxBootTokens),
    runtime: renderRuntimeFromLines(runtimeLines, config),
    spaces: renderSpacesFromEntries(spaces, config),
    reminded: previous?.reminded ?? 0,
    // 每次会话启动（含 clear/compact 重装）都重置为未注入，交给 pre-step 做一次性注入
    injected: false,
  }
}

/**
 * 取出并消费"每会话一次"的会话视图注入文本（v0.6.5）。
 * 视图未就绪（会话启动尚未装载）/ 已注入过 / 无内容 → null。
 * 消费语义：一旦注入就置 `injected = true`，此后本会话不再重复注入
 * （clear/compact 时 loadSessionView 会重置该标记，从而实现"压缩后补注一次"）。
 */
function takeSessionViewInjection(agent: unknown, views: WeakMap<object, AgentView>): string | null {
  if (!isObject(agent)) return null
  const view = views.get(agent)
  if (view === undefined || view.injected) return null
  view.injected = true
  const parts = [view.status, view.runtime, view.spaces].filter((part) => part !== '')
  return parts.length > 0 ? parts.join('\n\n') : null
}

import { renderRuntimeBlock, renderSpaceBlock, clampTokens } from './render.js'

function renderRuntimeFromLines(lines: string[], config: Config): string {
  if (lines.length === 0) return ''
  return renderRuntimeBlock('最近会话（摘要）', lines, config.maxRuntimeTokens)
}

function renderSpacesFromEntries(
  entries: Array<{ summary: string; tags: string[] }>,
  config: Config,
): string {
  // 复用 renderSpaceBlock；预算不足时再整体钳制
  return clampTokens(renderSpaceBlock(entries, config.maxSpaceTokens), config.maxSpaceTokens)
}

// 导出供测试使用的内部成员（避免测试触及私有实现细节）
export { loadSessionView }