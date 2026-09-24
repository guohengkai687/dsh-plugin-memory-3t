/**
 * 参数设置桥（v0.7.1 迁移到 DSH 0.1.7 模型）。
 *
 * DSH 0.1.7 起设置体系换了模型（旧的 `installSettingsSection` / `settingsNamespace` /
 * `SettingsProvider` 全部移除）：
 * - 可编辑字段由插件自己导出的 schemastery `Config` 声明（`src/config.ts`，`.volatile()` 标记），
 *   宿主 `ctx.settings` 按 profile 条目 id（= 包名 `dsh-plugin-memory-3t`）投影成表单，
 *   写入持久化到 profile 的 cordis.patch.yml；
 * - volatile 字段的改动**不重挂载插件**：loader 把新值提交进插件持有的引用，再向插件 fiber
 *   派发 `loader/volatile-update`；
 * - 客户端「记忆管理」页通过 `ctx.configForms.get(条目 id)` 读写同一份值。
 *
 * 服务端职责（本文件，node 侧）：
 * - 监听 `loader/volatile-update`，把新值重新归一化（mergeConfig）后经 applyEffective
 *   原地写入运行中 config：组对象原地更新——store/GitVcs/EmbeddingClient/DiagLog 均持有
 *   相同对象引用，随读随见；并返回"变更组"供 index 触发 live 钩子
 *   （WebUI 重挂载 / diag caps / nudge 开关）。
 * - 声明"本插件自带设置页"（`configure({ auto: false }, ctx.fiber)`），避免宿主再按 schema
 *   生成一个重复页面。
 * - 全部路径 fail-open：没有 settings 服务 / 没有 loader（headless、单测）→ 静默跳过。
 *
 * 边界：storageDir / scope / workspaceDir 属启动期库根绑定，是**普通字段**（非 volatile），
 * 改动会重挂载插件（等价"重启后生效"），applyEffective 不做修改；其余字段 live 应用。
 */

import { mergeConfig, type Config } from './config.js'
import { DEV_MEMORY_SETTINGS_NS } from './shared.js'

export { DEV_MEMORY_SETTINGS_NS }

/** applyEffective 返回的变更组：true = 该组有字段被 live 应用。 */
export interface ConfigChange {
  webui?: boolean
  diag?: boolean
  nudge?: boolean
  vcs?: boolean
  embedding?: boolean
  digest?: boolean
  recall?: boolean
  /** v0.6.5：冷启动 seed 参数变更。 */
  seed?: boolean
  /** v0.7.0：工具暴露面变更（注册发生在 apply 期，需重启插件生效）。 */
  tools?: boolean
  budgets?: boolean
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 把解析后的有效配置 live 应用到运行中 target（原地更新各组对象）。
 * 只应用可 live 生效的字段；storageDir / scope / workspaceDir 保持 entry 值。
 * @param target - 运行中 config（插件 apply 时 mergeConfig 的对象，各模块持有引用）。
 * @param next - settings 解析出的有效配置（schema 验证过，但防御式再校验）。
 * @returns 发生变更的组（供 index 触发 live 钩子）。
 */
export function applyEffective(target: Config, next: unknown): ConfigChange {
  const change: ConfigChange = {}
  const n = (next ?? {}) as Record<string, unknown>
  const groups = (name: string): Record<string, unknown> => {
    const g = n[name]
    return typeof g === 'object' && g !== null && !Array.isArray(g) ? (g as Record<string, unknown>) : {}
  }

  // 注入预算（boot/runtime/space 每次渲染读取，live 生效）
  const boot = asNum(n.maxBootTokens)
  const runtime = asNum(n.maxRuntimeTokens)
  const space = asNum(n.maxSpaceTokens)
  if (boot !== undefined && boot >= 0 && target.maxBootTokens !== boot) {
    target.maxBootTokens = Math.floor(boot)
    change.budgets = true
  }
  if (runtime !== undefined && runtime >= 0 && target.maxRuntimeTokens !== runtime) {
    target.maxRuntimeTokens = Math.floor(runtime)
    change.budgets = true
  }
  if (space !== undefined && space >= 0 && target.maxSpaceTokens !== space) {
    target.maxSpaceTokens = Math.floor(space)
    change.budgets = true
  }
  // v0.6.6：会话视图全局预算 + L3 注入方式（下一个会话的首个 pre-step 生效）
  const view = asNum(n.maxViewTokens)
  if (view !== undefined && view >= 0 && target.maxViewTokens !== Math.floor(view)) {
    target.maxViewTokens = Math.floor(view)
    change.budgets = true
  }
  const l3Inject = asStr(n.l3Inject)
  if ((l3Inject === 'off' || l3Inject === 'salience' || l3Inject === 'query') && target.l3Inject !== l3Inject) {
    target.l3Inject = l3Inject
    change.recall = true
  }
  // v0.7.0：L1 逐行摘要上限（渲染时读取，live 生效；下一个会话视图生效）
  const l1Max = asNum(n.l1MaxCharsPerLine)
  if (l1Max !== undefined && l1Max >= 0 && target.l1MaxCharsPerLine !== Math.floor(l1Max)) {
    target.l1MaxCharsPerLine = Math.floor(l1Max)
    change.budgets = true
  }
  // v0.7.0：subagent 注入开关（会话启动边读取，下个子代理生效）
  const subagentInject = asBool(n.subagentInject)
  if (subagentInject !== undefined && target.subagentInject !== subagentInject) {
    target.subagentInject = subagentInject
    change.budgets = true
  }
  // v0.7.0：工具暴露面（注册发生在 apply 期，改动需重启插件生效——与文档一致）
  const toolsProfile = asStr(n.toolsProfile)
  if ((toolsProfile === 'core' || toolsProfile === 'full') && target.toolsProfile !== toolsProfile) {
    target.toolsProfile = toolsProfile
    change.tools = true
  }

  // 注意：storageDir / scope / workspaceDir 不在此处应用（启动期库根绑定，重启生效）

  // WebUI 面板开关（v0.5）
  const webui = groups('webui')
  const webuiEnabled = asBool(webui.enabled)
  if (webuiEnabled !== undefined && target.webui.enabled !== webuiEnabled) {
    target.webui.enabled = webuiEnabled
    change.webui = true
  }

  // 诊断记录（DiagLog 持有 config.diag 同引用；updateConfig 由 index live 钩子补发）
  const diag = groups('diag')
  const diagEnabled = asBool(diag.enabled)
  if (diagEnabled !== undefined && target.diag.enabled !== diagEnabled) {
    target.diag.enabled = diagEnabled
    change.diag = true
  }
  const maxEvents = asNum(diag.maxEvents)
  if (maxEvents !== undefined && maxEvents >= 0 && target.diag.maxEvents !== Math.floor(maxEvents)) {
    target.diag.maxEvents = Math.floor(maxEvents)
    change.diag = true
  }

  // 主动追忆（RecallNudgeController 由 index live 钩子 setEnabled）
  const nudge = groups('recallNudge')
  const nudgeEnabled = asBool(nudge.enabled)
  if (nudgeEnabled !== undefined && target.recallNudge.enabled !== nudgeEnabled) {
    target.recallNudge.enabled = nudgeEnabled
    change.nudge = true
  }

  // 版本回溯（GitVcs 持有 config.vcs 同引用，逐次读取 enabled/autoCommit/debounceMs/batch）
  const vcs = groups('vcs')
  const vcsEnabled = asBool(vcs.enabled)
  if (vcsEnabled !== undefined && target.vcs.enabled !== vcsEnabled) {
    target.vcs.enabled = vcsEnabled
    change.vcs = true
  }
  const autoCommit = asBool(vcs.autoCommit)
  if (autoCommit !== undefined && target.vcs.autoCommit !== autoCommit) {
    target.vcs.autoCommit = autoCommit
    change.vcs = true
  }
  const debounceMs = asNum(vcs.debounceMs)
  if (debounceMs !== undefined && debounceMs >= 0 && target.vcs.debounceMs !== Math.floor(debounceMs)) {
    target.vcs.debounceMs = Math.floor(debounceMs)
    change.vcs = true
  }
  const batch = asNum(vcs.batch)
  if (batch !== undefined && batch >= 1 && target.vcs.batch !== Math.floor(batch)) {
    target.vcs.batch = Math.floor(batch)
    change.vcs = true
  }

  // 向量检索（EmbeddingClient 持有 config.embedding 同引用，逐次读取）
  const embedding = groups('embedding')
  const embEnabled = asBool(embedding.enabled)
  if (embEnabled !== undefined && target.embedding.enabled !== embEnabled) {
    target.embedding.enabled = embEnabled
    change.embedding = true
  }
  const endpoint = asStr(embedding.endpoint)
  if (endpoint !== undefined && endpoint.trim() !== '' && target.embedding.endpoint !== endpoint.trim()) {
    target.embedding.endpoint = endpoint.trim().replace(/\/+$/, '')
    change.embedding = true
  }
  const model = asStr(embedding.model)
  if (model !== undefined && model.trim() !== '' && target.embedding.model !== model.trim()) {
    target.embedding.model = model.trim()
    change.embedding = true
  }
  const timeoutMs = asNum(embedding.timeoutMs)
  if (timeoutMs !== undefined && timeoutMs >= 0 && target.embedding.timeoutMs !== Math.floor(timeoutMs)) {
    target.embedding.timeoutMs = Math.floor(timeoutMs)
    change.embedding = true
  }

  // digest / recall 细调（读取时取用，live 生效）
  const digest = groups('digest')
  const maxMessages = asNum(digest.maxMessages)
  if (maxMessages !== undefined && maxMessages >= 0 && target.digest.maxMessages !== Math.floor(maxMessages)) {
    target.digest.maxMessages = Math.floor(maxMessages)
    change.digest = true
  }
  const recall = groups('recall')
  const minSalience = asNum(recall.minSalience)
  if (minSalience !== undefined && minSalience >= 0 && minSalience <= 1 && target.recall.minSalience !== minSalience) {
    target.recall.minSalience = minSalience
    change.recall = true
  }

  // 冷启动 seed（v0.6.5；工具与 auto 开关都按引用读取，live 生效——auto 需下一次会话启动才生效）
  const seed = groups('seed')
  const seedEnabled = asBool(seed.enabled)
  if (seedEnabled !== undefined && target.seed.enabled !== seedEnabled) {
    target.seed.enabled = seedEnabled
    change.seed = true
  }
  const seedAuto = asBool(seed.auto)
  if (seedAuto !== undefined && target.seed.auto !== seedAuto) {
    target.seed.auto = seedAuto
    change.seed = true
  }
  const gitCommits = asNum(seed.gitCommits)
  if (gitCommits !== undefined && gitCommits >= 0 && target.seed.gitCommits !== Math.floor(gitCommits)) {
    target.seed.gitCommits = Math.floor(gitCommits)
    change.seed = true
  }
  const maxEntries = asNum(seed.maxEntries)
  if (maxEntries !== undefined && maxEntries >= 1 && target.seed.maxEntries !== Math.floor(maxEntries)) {
    target.seed.maxEntries = Math.floor(maxEntries)
    change.seed = true
  }

  return change
}

// ------------------------------------------------- 可编辑参数面（默认值形状）


/**
 * 提供参数面默认值的形状（与 `src/config.ts` 的 `Config` schema 默认值一一对应，
 * 由 `test/config.test.mjs` 断言不漂移）。
 */
export const SETTINGS_SURFACE_DEFAULTS = {
  webui: { enabled: true },
  diag: { enabled: true, maxEvents: 2000 },
  recallNudge: { enabled: false },
  vcs: { enabled: true, autoCommit: true, debounceMs: 1000, batch: 8 },
  embedding: { enabled: false, endpoint: 'http://localhost:11434', model: 'nomic-embed-text', timeoutMs: 3000 },
  digest: { maxMessages: 24 },
  recall: { minSalience: 0.25 },
  seed: { enabled: true, auto: false, gitCommits: 30, maxEntries: 40 },
  workspaceDir: '',
  scope: 'workspace',
  maxBootTokens: 600,
  maxRuntimeTokens: 1200,
  maxSpaceTokens: 800,
  maxViewTokens: 2000,
  l3Inject: 'off',
  l1MaxCharsPerLine: 160,
  subagentInject: false,
  toolsProfile: 'core',
} as const

// ---------------------------------------------------------------- install

/** 设置桥钩子：apply 收到一次完整有效配置（attach 时 + 每次用户设置变更）。 */
export interface DevMemorySettingsHooks {
  /** 应用有效配置到运行中 target 并做 live 副作用（由 index 提供）。 */
  apply(next: unknown): void
}

// ------------------------------------------------- volatile 配置桥（DSH 0.1.7+）

/** 设置桥钩子：每次 volatile 配置提交（或首次装配）后收到一份完整有效配置。 */
export interface DevMemorySettingsHooks {
  /** 应用有效配置到运行中 target 并做 live 副作用（由 index 提供）。 */
  apply(next: unknown): void
}

/** loader 把 volatile 新值提交进运行引用后派发给插件自身 fiber 的事件。 */
const VOLATILE_UPDATE_EVENT = 'loader/volatile-update'

/**
 * 安装 volatile 配置桥（fail-open）：无 loader / 无 `ctx.on` → 静默跳过。
 *
 * loader 在 volatile-only 变更时不重挂载插件，而是把新值写进 `rawConfig` 里的引用，
 * 再派发 `loader/volatile-update`。这里据此重新解引用 + 归一化，得到一份完整有效配置
 * 交给 hooks.apply（applyEffective 原地写入运行中 config）。
 * @param ctx - 插件 ctx（需具备 on，headless stub 无则跳过）。
 * @param rawConfig - 插件收到的 entry 配置（volatile 字段为引用，随 loader 更新）。
 * @param hooks - apply 回调。
 */
export function installDevMemorySettings(ctx: unknown, rawConfig: unknown, hooks: DevMemorySettingsHooks): void {
  const c = ctx as { on?(event: string, handler: (...args: unknown[]) => unknown): unknown } | null
  if (c === null || typeof c !== 'object' || typeof c.on !== 'function') return
  try {
    c.on(VOLATILE_UPDATE_EVENT, () => {
      try {
        hooks.apply(mergeConfig(rawConfig))
      } catch {
        /* 应用失败不中断设置链路（fail-open） */
      }
    })
  } catch {
    /* ctx.on 不可用 → 跳过 */
  }
}

/**
 * 声明"本插件自带设置页"，抑制宿主按 schema 自动生成重复页面（DSH 0.1.7+）。
 *
 * 按官方约定：在 `apply` 里开一个可选的 `ctx.inject(['settings'], …)` 子作用域，
 * 用 `child.effect` 注册 `configure({ auto: false }, ctx.fiber)`——owner 必须是插件自己的
 * fiber（默认值是 settings 服务自身的 fiber）。策略只影响"是否自动生成页面"，
 * 不影响表单读取与写入。
 * @param ctx - 插件 ctx（需具备 inject 与 fiber，headless/测试 stub 无则跳过）。
 */
export function installSettingsPresentationPolicy(ctx: unknown): void {
  const c = ctx as {
    fiber?: unknown
    inject?(name: readonly string[], callback: (scoped: unknown) => void): unknown
  } | null
  if (c === null || typeof c !== 'object' || typeof c.inject !== 'function' || c.fiber === undefined) return
  try {
    c.inject(['settings'], (scoped) => {
      const s = scoped as {
        effect?(fn: () => unknown, label?: string): unknown
        settings?: { configure?(presentation: { auto?: boolean }, owner?: unknown): unknown }
      } | null
      if (s === null || typeof s !== 'object' || typeof s.effect !== 'function') return
      const configure = s.settings?.configure
      if (typeof configure !== 'function') return
      const owner = c.fiber
      try {
        s.effect(() => configure.call(s.settings, { auto: false }, owner))
      } catch {
        /* 策略已注册 / 服务不可用 → 跳过（fail-open） */
      }
    })
  } catch {
    /* ctx.inject 不可用 → 跳过 */
  }
}