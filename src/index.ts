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
import { approximateTokens, clampLines, clampTokens, dropReplayedPrompts, isReplayedPrompt, normalizeForDedup, renderBootBlock, renderRuntimeBlock, renderSpaceBlock, renderStatusBlock, takeWithinBudget, type StoreStatus } from './render.js'
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
  /**
   * v0.6.6：L3 块改为**惰性**渲染——只在首个 pre-step 注入时按 `config.l3Inject`
   * 决定要不要、以及怎么取（`query` 模式需要当时的用户消息）。
   */
  l3: string | null
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

/** L1 回放每天最多取多少行（v0.6.6）。 */
const L1_MAX_LINES_PER_DAY = 12

/** L3 单条摘要的近似 token 上限（v0.6.6：逐条钳制，避免单条独吞整块预算）。 */
const L3_ENTRY_MAX_TOKENS = 140

/** L3 注入条数上限（v0.6.6）。 */
const L3_TOP_K = 5

/** query 模式检索用的最近用户消息最长字符数（v0.6.6）。 */
const L3_QUERY_MAX_CHARS = 500

/** 会话缓冲区取多少条最近用户消息用于 L1 去重 / L3 检索（v0.6.6）。 */
const RECENT_PROMPT_LIMIT = 8

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
      //
      // v0.7.0：subagent 默认**不注入**会话视图/召回提醒（config.subagentInject=false）。
      // 实测（3 天窗口）：28 个子代理会话共 274 次调用里一次都没用过记忆工具，
      // 却各自领了一份视图 + 提醒。子代理仍保留记忆工具与静态 boot 协议，
      // 需要时自己 recall 即可——把"自动喂"改成"按需取"。
      const subagent = isSubagentAgent(agent)
      const skipInject = subagent && !config.subagentInject
      if (parent === undefined || !viewBySession.has(parent)) {
        // v0.7.0：非 clear/compact 的重装保留已注入标记——headless 实测 pre-step 可能
        // 早于本边触发，此时视图已懒加载并注入过，这里再置 false 会导致重复注入。
        const view = await loadSessionView(store, config, previous, [], { keepInjected: !rerun })
        agentViews.set(agent, view)
        if (sessionId !== '') viewBySession.set(sessionId, view)
        if (parent === undefined && sessionId !== '') rootAgents.set(sessionId, agent)
      } else {
        const inherited = viewBySession.get(parent)
        if (inherited !== undefined) {
          // 继承父视图内容；injected/reminded 由下面按 skipInject 统一置位
          const view = { ...inherited, reminded: 0, injected: false }
          agentViews.set(agent, view)
          if (sessionId !== '') viewBySession.set(sessionId, view)
        }
      }
      if (skipInject) {
        const view = agentViews.get(agent)
        if (view !== undefined) {
          // injected=true → takeSessionViewInjection 返回 null；reminded>=2 → computeReminder 返回 null
          view.injected = true
          view.reminded = 2
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
    let stepStore: MemoryStore | null = null
    try {
      // v0.6.4：按 payload.agent 的真实工作区绑定（多工作区并存、或插件热重载后首个步骤，都能落到正确库根）
      stepStore = ensureStore(sessionCwdOf(stepAgent), { sessionContext: true }).store
      recordMessages(payload, sessionBuffer, stepStore)
    } catch {
      /* 流水记录失败不影响步骤 */
    }
    // v0.6.5：召回内容（状态块 + L1 回放 + L3 块）**每会话只注入一次**。
    // 机会式触发：视图就绪后的首个 pre-step 注入（不依赖会话启动边与首个 pre-step 的时序）。
    // v0.6.6：注入前用会话缓冲区尾部做两件事——L1 去重（剔除此刻已在上下文里的用户消息）
    // 与 L3 惰性取值（query 模式按最近用户消息检索）。
    const recentPrompts = sessionBuffer.slice(-RECENT_PROMPT_LIMIT).map((message) => message.text)
    let viewText: string | null = null
    try {
      // register：懒加载出来的视图也要进 viewBySession，subagent 才能按父会话 id 继承
      viewText = await takeSessionViewInjection(stepAgent, agentViews, stepStore, config, recentPrompts, warn, (view) => {
        const id = sessionIdOf(stepAgent)
        if (id !== '') viewBySession.set(id, view)
      })
    } catch (error) {
      warn(`[dev-memory] 会话视图注入计算失败（降级跳过）: ${error instanceof Error ? error.message : String(error)}`)
    }
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
            'Session memory view (status + L1 replay + optional L3 top-k), injected once per session',
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

  for (const tool of createTools(() => ensureStore().store, () => ensureStore().engine, { profile: config.toolsProfile })) {
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
  const raw = headerFieldOf(agent, 'parentSession')
  // v0.7.0：空串/纯空白视为"无父会话"——否则根会话会被误判成 subagent 而跳过注入
  return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined
}

/**
 * 是否子代理（v0.7.0）。
 *
 * 用**多信号**判定而不是只看 parentSession：DSH 的 session header 里
 * `parentSession` / `origin: 'subagent'` / `delegationDepth` 三者都表达层级，
 * 任一命中即视为子代理；空串等退化值一律按根会话处理（fail-open 到"注入"，
 * 因为漏注入是静默失效，多注入只是多花 token）。
 */
function isSubagentAgent(agent: unknown): boolean {
  const depth = headerFieldOf(agent, 'delegationDepth')
  if (typeof depth === 'number' && depth > 0) return true
  if (headerFieldOf(agent, 'origin') === 'subagent') return true
  return parentSessionOf(agent) !== undefined
}

/** 读 agent.session.header 上的字段（缺省/异常 → undefined）。 */
function headerFieldOf(agent: unknown, key: string): unknown {
  if (!isObject(agent)) return undefined
  try {
    const session = (agent as Record<string, unknown>).session
    if (!isObject(session)) return undefined
    const header = (session as Record<string, unknown>).header
    if (!isObject(header)) return undefined
    return (header as Record<string, unknown>)[key]
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

/**
 * 装载会话视图（v0.6.6：L3 部分改为惰性）：状态块 + L1 最近 2 日流水摘要。
 *
 * 这里**不读 L3**——L3 块由 `takeSessionViewInjection` 在首个 pre-step 按需构建
 * （`config.l3Inject` 默认 `off` 时一次都不查库；`query` 模式还需要当时的用户消息）。
 *
 * @param store - 当前会话工作区的记忆库。
 * @param config - 运行中配置（预算）。
 * @param previous - 上一个视图（保留 reminded 计数）。
 * @param knownPrompts - 已在本会话上下文里的用户消息（L1 回放去重用）。
 */
async function loadSessionView(
  store: MemoryStore,
  config: Config,
  previous: AgentView | undefined,
  knownPrompts: readonly string[] = [],
  options: { keepInjected?: boolean } = {},
): Promise<AgentView> {
  const status = await store.status()
  const runtimeLines = await collectRuntimeLines(store, knownPrompts)
  return {
    // v0.6.5：易变状态块与会话视图一起**只注入一次**（原在 boot 块里逐请求注入）
    status: renderStatusBlock(status, config.maxBootTokens),
    runtime: renderRuntimeFromLines(runtimeLines, config),
    l3: null,
    reminded: previous?.reminded ?? 0,
    // v0.7.0：keepInjected——非 clear/compact 的重装不得把已注入状态重置（否则会重复注入）；
    // 默认仍为 false（每次会话启动/clear/compact 重装都重置为未注入）。
    injected: options.keepInjected === true ? (previous?.injected ?? false) : false,
  }
}

/**
 * 收集 L1 回放行（今天 + 昨天，各最多 12 行）并剔除"此刻已在上下文里"的用户消息。
 *
 * v0.6.6 修两处：
 * - **标题取值**：原取 `raw.split(/\r?\n/)[0]`，但 runtime 文件头之后可能被追加过
 *   别的内容（如 digest 补写），实测取到的是被截断的 prompt 而不是 `# 日期` 头，
 *   注入里出现 `## - user: …` 畸形标题。改为显式找 `# ` 头。
 * - **自我回放**：L1 是每个 user 消息的原文记录，会话内回放等于把模型已有的内容
 *   再念一遍（实测占 L1 块大头）。按"已在本会话上下文"的文本去重后，
 *   L1 块通常只剩跨会话流水——那才是回放的价值。
 */
async function collectRuntimeLines(store: MemoryStore, knownPrompts: readonly string[]): Promise<string[]> {
  const runtimeLines: string[] = []
  const now = new Date()
  for (let offset = 0; offset < 2; offset++) {
    const date = new Date(now.getTime() - offset * 86_400_000)
    const raw = await store.readRuntime(date)
    const heading = runtimeHeadingOf(raw) || date.toISOString().slice(0, 10)
    const content: string[] = []
    const seen = new Set<string>()
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('- ') && !line.startsWith('## ')) continue
      if (content.length >= L1_MAX_LINES_PER_DAY) break
      if (line.startsWith('- ')) {
        const text = line.slice(2)
        if (knownPrompts.length > 0 && isReplayedPrompt(text, knownPrompts)) continue
        const key = normalizeForDedup(text)
        if (seen.has(key)) continue
        seen.add(key)
      }
      content.push(line)
    }
    if (content.length > 0) runtimeLines.push(`## ${heading}`, ...content)
  }
  return runtimeLines
}

/** runtime 文件的 `# YYYY-MM-DD` 头（v0.6.6 修复：不再拿第一行当标题）。 */
function runtimeHeadingOf(raw: string): string {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('# ')) return trimmed.slice(2).trim().replace(/\.md$/iu, '')
    if (trimmed !== '') break
  }
  return ''
}

/**
 * 取出并消费"每会话一次"的会话视图注入文本（v0.6.5；v0.6.6 加全局预算与 L3 惰性）。
 *
 * 视图未就绪（会话启动尚未装载）/ 已注入过 / 无内容 → null。
 * 消费语义：一旦注入就置 `injected = true`，此后本会话不再重复注入
 * （clear/compact 时 loadSessionView 会重置该标记，从而实现"压缩后补注一次"）。
 *
 * 三块按顺序在**一个全局预算**内渲染：状态 → L1 → L3。前面块花掉的额度会从
 * 后面块的可用预算里扣掉，杜绝"排序在前的块挤光整个视图预算"（v0.6.6 修复）。
 */
async function takeSessionViewInjection(
  agent: unknown,
  views: WeakMap<object, AgentView>,
  store: MemoryStore | null,
  config: Config,
  recentPrompts: readonly string[] = [],
  onDegrade?: (message: string) => void,
  register?: (view: AgentView) => void,
): Promise<string | null> {
  if (!isObject(agent)) return null
  let view = views.get(agent)
  // v0.7.0：视图缺失时**就地懒加载**。headless 实测 `agent/pre-step` 可能早于
  // `agent/created` / `agent/session-start` 触发（单步会话没有第二次机会），
  // 原来的"等启动边装载"会让整轮注入静默消失。这里按 payload.agent 的会话工作区
  // 自己装载一份，彻底去掉对事件顺序的依赖（注释里声明的意图终于落实）。
  if (view === undefined && store !== null) {
    if (isSubagentAgent(agent) && !config.subagentInject) return null
    view = await loadSessionView(store, config, undefined, recentPrompts)
    views.set(agent, view)
    register?.(view)
  }
  if (view === undefined || view.injected) return null
  view.injected = true

  let remaining = Math.max(0, config.maxViewTokens)
  const blocks: string[] = []
  const push = (text: string, budget: number, lineAware = false): void => {
    if (text === '' || budget <= 0) return
    // v0.7.0：L1 回放走整行截断（不再切半句），其余块沿用字符级钳制
    const clamped = lineAware ? clampLines(text, budget) : clampTokens(text, budget)
    remaining -= approximateTokens(clamped)
    if (clamped !== '') blocks.push(clamped)
  }

  // 状态块：诊断/索引陈旧/降级这类安全信号优先级最高，先满足
  const statusBudget = takeWithinBudget(remaining, config.maxBootTokens)
  push(view.status, statusBudget)
  // L1 回放：去掉已在上下文里的用户消息（v0.6.6），再按剩余额度注入
  const runtimeBudget = takeWithinBudget(remaining, config.maxRuntimeTokens)
  push(dropReplayedPrompts(view.runtime, recentPrompts), runtimeBudget, true)
  // L3（v0.6.6 惰性 + 默认关闭）
  if (config.l3Inject !== 'off' && remaining > 0) {
    if (view.l3 === null) view.l3 = await lazyL3Block(store, config, recentPrompts)
    if (view.l3 === null) {
      // query 模式检索失败：降级为不注入（fail-open），交给调用方记一条诊断
      view.l3 = ''
      onDegrade?.('L3 query 注入失败（降级跳过）')
    }
    push(view.l3, takeWithinBudget(remaining, config.maxSpaceTokens))
  }
  return blocks.length > 0 ? blocks.join('\n\n') : null
}

/**
 * 惰性构建 L3 块（v0.6.6，异步）：`salience` 按 salience/accesses 取 top-k；
 * `query` 用最近用户消息跑 BM25，只保留分数达 `recall.highScore` 的命中。
 * 逐条摘要钳制交给 `renderSpaceBlock`（单条超长不再挤掉整块）。
 *
 * 失败不抛（fail-open）：返回 `null` 表示 query 模式检索失败，由调用方记一条诊断。
 *
 * @returns 块文本 / null（检索失败）
 */
async function lazyL3Block(
  store: MemoryStore | null,
  config: Config,
  recentPrompts: readonly string[],
): Promise<string | null> {
  if (store === null || config.l3Inject === 'off') return ''
  if (config.l3Inject === 'query') {
    // 只取最近一条用户消息作查询（拼接多条会引入跨话题噪声）
    const query = (recentPrompts.at(-1) ?? '').slice(0, L3_QUERY_MAX_CHARS).trim()
    if (query === '') return ''
    try {
      const result = await store.recall(query, { layers: ['l3'], maxResults: L3_TOP_K, touch: false })
      const hits = result.l3.filter((hit) => hit.score >= config.recall.highScore).slice(0, L3_TOP_K)
      if (hits.length === 0) return ''
      const byId = new Map((await store.listEntries()).map((entry) => [entry.id, entry]))
      const picked = hits
        .map((hit) => byId.get(hit.id))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        .map((entry) => ({ id: entry.id, summary: entry.summary, tags: entry.tags }))
      return renderSpaceBlock(picked, config.maxSpaceTokens, L3_ENTRY_MAX_TOKENS)
    } catch {
      return null
    }
  }
  const entries = await store.listEntries()
  const top = entries
    .filter((entry) => entry.salience >= config.recall.minSalience)
    .sort((a, b) => b.salience - a.salience || b.accesses - a.accesses)
    .slice(0, L3_TOP_K)
    .map((entry) => ({ id: entry.id, summary: entry.summary, tags: entry.tags }))
  return renderSpaceBlock(top, config.maxSpaceTokens, L3_ENTRY_MAX_TOKENS)
}

function renderRuntimeFromLines(lines: string[], config: Config): string {
  if (lines.length === 0) return ''
  // v0.7.0：逐行摘要（长 prompt 不再独吞回放预算）+ 整行截断
  return renderRuntimeBlock('最近会话（摘要）', lines, config.maxRuntimeTokens, config.l1MaxCharsPerLine)
}

// 导出供测试使用的内部成员（避免测试触及私有实现细节）
export { loadSessionView }