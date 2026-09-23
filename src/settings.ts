/**
 * 设置页桥（v0.5 新增）：把 dsh-plugin-memory-3t 的 WebUI 功能与可调参数接入
 * DSH 设置体系（settings namespace + 客户端「记忆管理」设置页/卡片）。
 *
 * 服务端职责（本文件，node 侧）：
 * - 动态加载 `@deepseek-ai/dsh-settings` 与 `schemastery`：未安装 / headless
 *   （无 settings 服务）/ import 失败 → fail-open 跳过，插件行为与 v0.4 完全一致。
 * - 用 installSettingsSection 注册 namespace `dev-memory`：组成层 entry 配置
 *   （mergeConfig 后的完整 Config）作 base，schema 描述可编辑表面（含默认值），
 *   用户设置文档覆盖其上；resolve = schema 默认值 → base → 用户层。
 * - onChange（含首次 attach）把有效配置经 applyEffective 实时写入运行中 config：
 *   组对象原地更新——store/GitVcs/EmbeddingClient/DiagLog 均持有相同对象引用，
 *   随读随见；并返回"变更组"供 index 触发 live 钩子
 *   （WebUI 重挂载 / diag caps / nudge 开关）。
 *
 * 边界：storageDir / scope / workspaceDir 属启动期库根绑定，中间会话不切换，
 * 设置页标注"重启后生效"，applyEffective 不做修改；其余字段 live 应用。
 */

import type { Config } from './config.js'
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

// ---------------------------------------------------------------- schema

interface SettingsDeps {
  installSettingsSection: <T>(
    ctx: unknown,
    ns: string,
    schema: unknown,
    entry: T,
    hooks: { setSource(current: () => T): void; onChange(): void },
  ) => void
  settingsNamespace: (value: string) => string
  z: {
    object(shape: Record<string, unknown>): unknown
    boolean(): unknown
    string(): unknown
    number(): unknown
  }
}

/** schemastery 包名：优先 @deepseek-ai 分叉，回退官方包。 */
const SCHEMASTERY_SPECIFIERS = ['@deepseek-ai/schemastery', 'schemastery'] as const

/** 动态加载设置依赖；任一缺失返回 null（调用方 fail-open）。 */
async function loadSettingsDeps(): Promise<SettingsDeps | null> {
  try {
    const settings = (await import('@deepseek-ai/dsh-settings')) as unknown as {
      installSettingsSection?: SettingsDeps['installSettingsSection']
      settingsNamespace?: SettingsDeps['settingsNamespace']
    }
    const z = await loadSchemastery()
    const installSettingsSection = settings.installSettingsSection
    const settingsNamespace = settings.settingsNamespace
    // schemastery 的默认导出是 callable 函数（挂 .object/.string/.number 等），
    // 不是普通 object——用 typeof !== 'object' 判定会误判为缺失。
    if (typeof installSettingsSection !== 'function' || typeof settingsNamespace !== 'function' || (typeof z !== 'object' && typeof z !== 'function') || z === null) {
      return null
    }
    const zx = z as { boolean(): unknown; string(): unknown; number(): unknown; object(shape: Record<string, unknown>): unknown }
    if (typeof zx.boolean !== 'function' || typeof zx.string !== 'function' || typeof zx.number !== 'function' || typeof zx.object !== 'function') {
      return null
    }
    return {
      installSettingsSection: installSettingsSection as SettingsDeps['installSettingsSection'],
      settingsNamespace: settingsNamespace as SettingsDeps['settingsNamespace'],
      z: {
        boolean: () => zx.boolean(),
        string: () => zx.string(),
        number: () => zx.number(),
        object: (shape) => zx.object(shape),
      },
    }
  } catch {
    return null
  }
}

/** 依次尝试 schemastery 包名，返回默认导出；全部失败 → null。 */
async function loadSchemastery(): Promise<unknown> {
  for (const specifier of SCHEMASTERY_SPECIFIERS) {
    try {
      const mod = (await import(specifier)) as { default?: unknown }
      if (mod.default !== undefined) return mod.default
    } catch {
      /* 尝试下一个 */
    }
  }
  return null
}

/**
 * 构建可编辑表面 schema（与客户端表单字段一致；全部带默认值，使
 * resolve = schema 默认值 → base(entry) → 用户层 总能给出完整可读面）。
 */
function buildSettingsSchema(z: SettingsDeps['z']): unknown {
  return z.object({
    webui: z.object({ enabled: z.boolean() }),
    diag: z.object({
      enabled: z.boolean(),
      maxEvents: z.number(),
    }),
    recallNudge: z.object({ enabled: z.boolean() }),
    vcs: z.object({
      enabled: z.boolean(),
      autoCommit: z.boolean(),
      debounceMs: z.number(),
      batch: z.number(),
    }),
    embedding: z.object({
      enabled: z.boolean(),
      endpoint: z.string(),
      model: z.string(),
      timeoutMs: z.number(),
    }),
    digest: z.object({ maxMessages: z.number() }),
    recall: z.object({ minSalience: z.number() }),
    // v0.6.5：冷启动 seed（无 LLM 生成项目骨架）
    seed: z.object({
      enabled: z.boolean(),
      auto: z.boolean(),
      gitCommits: z.number(),
      maxEntries: z.number(),
    }),
    workspaceDir: z.string(),
    scope: z.string(),
    maxBootTokens: z.number(),
    maxRuntimeTokens: z.number(),
    maxSpaceTokens: z.number(),
    // v0.6.6：会话视图全局预算 + L3 注入方式（off/salience/query）
    maxViewTokens: z.number(),
    l3Inject: z.string(),
  })
}

/** 提供 schema 默认值的形状（与 buildSettingsSchema 字段一一对应）。 */
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
} as const

// ---------------------------------------------------------------- install

/** 设置桥钩子：apply 收到一次完整有效配置（attach 时 + 每次用户设置变更）。 */
export interface DevMemorySettingsHooks {
  /** 应用有效配置到运行中 target 并做 live 副作用（由 index 提供）。 */
  apply(next: unknown): void
}

/**
 * 安装设置桥（fail-open）：无 settings 服务 / 依赖缺失 / 注册失败 → 静默跳过。
 * 注册 ns=`dev-memory`：base=entry（组成层），用户文档覆盖，resolve 即有效配置；
 * 每次变更（含首次 attach）调用 hooks.apply。
 * @param ctx - 插件 ctx（需具备 inject，headless stub 无则跳过）。
 * @param entry - 组成层 entry 配置（mergeConfig 后的完整 Config）。
 * @param hooks - apply 回调。
 */
export function installDevMemorySettings(ctx: unknown, entry: Config, hooks: DevMemorySettingsHooks): void {
  const c = ctx as { inject?(name: readonly string[], callback: (scoped: unknown) => void): unknown } | null
  if (c === null || typeof c !== 'object' || typeof c.inject !== 'function') return
  try {
    c.inject(['settings'], (scoped) => {
      void (async () => {
        try {
          const deps = await loadSettingsDeps()
          if (deps === null) return
          let source: () => unknown = () => entry
          deps.installSettingsSection(scoped, deps.settingsNamespace(DEV_MEMORY_SETTINGS_NS), buildSettingsSchema(deps.z), entry, {
            setSource: (current) => {
              source = current as () => unknown
            },
            onChange: () => {
              try {
                hooks.apply(source())
              } catch {
                /* 应用失败不中断设置链路（fail-open） */
              }
            },
          })
        } catch {
          /* 依赖缺失/注册失败 → 跳过（fail-open） */
        }
      })()
    })
  } catch {
    /* ctx.inject 不可用 → 跳过 */
  }
}

// 为方便测试暴露构建器
export { buildSettingsSchema, loadSettingsDeps }