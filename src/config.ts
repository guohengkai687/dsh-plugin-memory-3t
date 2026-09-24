import { isVolatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'

/**
 * 配置：类型、默认值与合并。
 *
 * v0.1 配置面刻意收敛（对比 mnemon 的 57 项）：只有注入预算三档、存储根、
 * digest/recall/索引参数与两个开关位。所有数值均做非负钳制。
 */

export interface EmbeddingConfig {
  /** 向量检索开关。默认 false（纯 BM25）；开启后 L2/L3 写入同步生成向量，检索走向量+BM25 融合。 */
  enabled: boolean
  /** Ollama HTTP API 地址（默认 http://localhost:11434）；以 /api/embeddings 等路径访问。 */
  endpoint: string
  /** 嵌入模型（默认 nomic-embed-text，参考 mnemon 默认值）。 */
  model: string
  /** 单次 embedding 调用超时（毫秒，默认 3000）。超时/不可用自动降级回 BM25，不打断会话。 */
  timeoutMs: number
}

export interface DigestConfig {
  /** 会话消息数达到该值即触发 digest（配合收尾语 / 显式 consolidate）。 */
  maxMessages: number
  /** 单次 digest 最多提升到 L3 的条目数，超出转 L2 笔记。 */
  maxPromote: number
  /** digest 失败后的补做次数上限，防止死循环。 */
  maxRetries: number
}

export interface RecallConfig {
  /** 单次查询默认返回条数上限（每层）。 */
  defaultLimit: number
  /** 注入 top-k 的最低 salience 门槛。 */
  minSalience: number
  /** 视为"高相关"的分数门槛（用于 pre-step 提醒）。 */
  highScore: number
}

export interface DedupeConfig {
  /** 与现有 L3 条目 BM25 分数 ≥ 该值视为重复。 */
  threshold: number
}

export interface IndexConfig {
  /** 写入次数超过该值后，下次查询前自动重建 BM25 倒排索引。 */
  rebuildAfterWrites: number
}

export interface VcsIdentityConfig {
  /** 本地 git 身份兜底（不依赖用户全局配置）。 */
  name: string
  email: string
}

export interface DiagConfig {
  /** 诊断记录开关（v0.4，默认 true）：记录调用异常与不符合预期的行为到 <库>/diag/events.jsonl。 */
  enabled: boolean
  /** 事件保留上限（默认 2000；0 = 不限）。超过 2 倍上限自动压缩，只保留最新 maxEvents 条。 */
  maxEvents: number
}

export interface WebUiConfig {
  /**
   * 只读 WebUI 面板开关（v0.5，默认 true）：false 时不再注册 /dev-memory 路由。
   * 可在 DSH 设置页「记忆管理」里实时切换（关 = 路由摘除，开 = 重新挂载）。
   */
  enabled: boolean
}

/**
 * 冷启动 seed 配置（v0.6.5，借鉴 Hindsight 的"冷仓库自动建库"）。
 *
 * **无 LLM**：只读仓库里的确定性信号（git 提交历史 / package.json / README 标题 / 顶层目录），
 * 生成一篇 L2 项目骨架笔记 + 一份"候选 L3"清单。**不自动写 L3**——L3 是可信层，
 * 只接受模型或用户确认过的事实（候选清单交给模型决定是否 devmemory_remember）。
 */
export interface SeedConfig {
  /** 允许 devmemory_seed 工具（默认 true；纯读取仓库 + 写一篇 L2，无外部依赖）。 */
  enabled: boolean
  /**
   * 会话启动时若库为空则自动 seed 一次（默认 **false**：写库是显式动作，由 skill 引导模型按需调用；
   * 设为 true 即复刻 Hindsight 的"零配置开箱"行为）。
   */
  auto: boolean
  /** 读取最近多少条 git 提交（默认 30；0 = 不读 git）。 */
  gitCommits: number
  /** 顶层目录条目上限（默认 40，避免大仓库把骨架撑爆）。 */
  maxEntries: number
}

export interface VcsConfig {
  /** 版本回溯开关；false 时完全跳过 git（等同 v0.1 行为）。 */
  enabled: boolean
  /** 事件驱动自动提交（防抖 + 计数合并）；false 时仅边界事件提交。 */
  autoCommit: boolean
  /** 防抖窗口（毫秒）：窗口内无新写入才合并提交。 */
  debounceMs: number
  /** 写入计数阈值：未提交写入达到该值立即提交。 */
  batch: number
  /** 初始化分支名。 */
  branch: string
  identity: VcsIdentityConfig
  /**
   * 分离 git 目录（--separate-git-dir）：绝对路径原样，相对路径基于记忆库根解析。
   * 默认 undefined = 嵌套 <库>/.git。
   */
  gitDir?: string
}

/** 记忆库粒度：workspace（每工作区一库，默认）/ user（全局一库，v0.3）。 */
export type Scope = 'workspace' | 'user'

/**
 * L3 长期事实的注入方式（v0.6.6）。
 *
 * 背景（实测）：L3 的 `salience desc, accesses desc` top-5 与"当前任务是否相关"
 * 无关——48 条里 20 条 salience 已达 1.0，排序实际由历史 accesses 决定，
 * 选出的清一色是老发版记录；且单条摘要无长度上限，5 条即 922 tokens > 800 预算，
 * 整块被从块尾砍掉一条。
 *
 * - `off`（默认）：**不注入** L3。需要时用 `devmemory_recall` 按需查（与 L2 同一策略）。
 * - `salience`：沿用旧行为（按 salience/accesses 取 top-k，逐条钳制）。
 * - `query`：用会话首条用户消息跑 BM25，只注入命中且分数达 `recall.highScore` 的 top-k。
 */
export type L3Inject = 'off' | 'salience' | 'query'

/**
 * 工具暴露面（v0.7.0）。
 *
 * 背景（2026-09-23 实测，见 .memory/docs/notes/2026-09-23-memory-3t-token-cost-evaluation.md）：
 * DSH 每次模型调用都会带上全部工具的 schema（实测 39 个工具 = 9203 tokens），
 * 其中 12 个 devmemory_* 占 2081 tokens / 调用——**占插件全部开销的 ~99%**，
 * 而低频运维工具（diag/history/diff/restore/forget/link/seed）在整个 3 天窗口里
 * 只被调用了 12 次（1188 次调用中）。
 *
 * - `core`（默认）：高频 5 件套 + 一个 action 式 `devmemory_admin` 覆盖全部低频运维，
 *   常驻 schema 从 2081 → ~800 tokens/调用。
 * - `full`：保留 v0.6 的 12 个独立工具（兼容旧习惯 / 需要逐工具粒度的场景）。
 */
export type ToolsProfile = 'core' | 'full'

export interface Config {
  /** 记忆库根。相对路径基于基准目录解析：workspace 基准 = 会话工作区根；user 基准 = 用户主目录；绝对路径原样使用。 */
  storageDir: string
  /** 记忆库粒度（v0.3）：workspace=每工作区一库；user=跨工作区共享一库（默认 ~/.memory）。 */
  scope: Scope
  /**
   * 工作区根覆盖（v0.3.1）：置为非空路径时，workspace 粒度固定以该目录为基准解析 storageDir
   * （忽略会话工作区，用于显式钉死库位 / 多工作区共存场景）；空串 = 自动——
   * 按会话真实工作区根（session.header.cwd）解析，缺省回退进程 cwd。
   */
  workspaceDir: string
  maxBootTokens: number
  maxRuntimeTokens: number
  maxSpaceTokens: number
  /** 会话视图（状态块 + L1 回放 + L3 块）一次性注入的**全局**预算（v0.6.6）。 */
  maxViewTokens: number
  /** L3 长期事实注入方式（v0.6.6，默认 off = 不注入）。 */
  l3Inject: L3Inject
  /**
   * L1 回放单行最大字符数（v0.7.0，默认 160）：流水行是 user prompt **原文**，
   * 长 prompt 会整段占掉回放预算。超长按此处摘要（尾随 `…`），保留"谁在什么时候问了什么"。
   */
  l1MaxCharsPerLine: number
  /**
   * subagent 是否也注入会话视图（v0.7.0，默认 false）。
   *
   * 背景（实测）：扇出场景下每个子代理都继承一份视图（各自 ~1.3–3.2k tokens），
   * 而 3 天窗口里 28 个子代理会话**一次都没调用过记忆工具**。默认关 =
   * 子代理仍有记忆工具与静态 boot 协议，但不注入状态块/L1 回放/召回提醒。
   */
  subagentInject: boolean
  /** 工具暴露面（v0.7.0，默认 core = 5 高频工具 + 1 个 action 式 admin）。 */
  toolsProfile: ToolsProfile
  embedding: EmbeddingConfig
  digest: DigestConfig
  recall: RecallConfig
  dedupe: DedupeConfig
  index: IndexConfig
  /** 主动追忆（recall nudge，v0.3 实现）：默认关；开启后按 30–240 分钟随机间隔经 agent.followup 温和提醒一次。 */
  recallNudge: { enabled: boolean }
  /** git 版本回溯管理（v0.2 新增）。 */
  vcs: VcsConfig
  /** 诊断与异常记录（v0.4 新增）：记录调用异常与不符合预期的行为，供定期审查优化插件。 */
  diag: DiagConfig
  /** 只读 WebUI 面板（v0.5 新增开关）：false 时摘除 /dev-memory 路由。 */
  webui: WebUiConfig
  /** 冷启动 seed（v0.6.5）：无 LLM 地从仓库确定性信号生成项目骨架 L2。 */
  seed: SeedConfig
}

export const DEFAULT_CONFIG: Config = {
  storageDir: '.memory',
  scope: 'workspace',
  workspaceDir: '',
  maxBootTokens: 600,
  maxRuntimeTokens: 1200,
  maxSpaceTokens: 800,
  maxViewTokens: 2000,
  // v0.6.6：默认不注入 L3——salience 排序选不出"相关"，只会把老条目顶上来占预算；
  // 需要时由模型用 devmemory_recall 按需查（与 L2 一致）。
  l3Inject: 'off',
  // v0.7.0：L1 回放逐行摘要；子代理默认不注入；工具默认走精简暴露面
  l1MaxCharsPerLine: 160,
  subagentInject: false,
  toolsProfile: 'core',
  embedding: { enabled: false, endpoint: 'http://localhost:11434', model: 'nomic-embed-text', timeoutMs: 3000 },
  digest: { maxMessages: 24, maxPromote: 20, maxRetries: 2 },
  recall: { defaultLimit: 10, minSalience: 0.25, highScore: 0.6 },
  dedupe: { threshold: 0.55 },
  index: { rebuildAfterWrites: 50 },
  recallNudge: { enabled: false },
  vcs: {
    enabled: true,
    autoCommit: true,
    debounceMs: 1000,
    batch: 8,
    branch: 'main',
    identity: { name: 'dsh-dev-memory', email: 'dev-memory@dsh.local' },
  },
  diag: { enabled: true, maxEvents: 2000 },
  webui: { enabled: true },
  // v0.6.5：auto 默认 false——写库是显式动作（由 skill 引导模型在空库时调用 devmemory_seed）；
  // 想复刻 Hindsight 的零配置开箱行为，把它设为 true。
  seed: { enabled: true, auto: false, gitCommits: 30, maxEntries: 40 },
}

// ------------------------------------------------------------ 宿主表单 schema（DSH 0.1.7+）

/**
 * DSH 0.1.7 起插件参数表单来自插件自身导出的 schemastery `Config`：
 * `ctx.settings` 只投影**声明了 `.volatile()`** 的字段，命名空间就是 profile 条目 id
 * （cordis.patch.yml 里的 `id: dsh-plugin-memory-3t`），改动持久化到 profile 的
 * cordis.patch.yml，并由 loader 在不重挂载插件的前提下把新值提交进运行中的 volatile 引用
 * （事件 `loader/volatile-update`，见 settings.ts）。
 *
 * 字段分类：
 * - **volatile**（live）：设置表单可编辑，改完立即生效（`applyEffective` 原地更新运行中 config）。
 * - **普通字段**（storageDir / scope / workspaceDir）：启动期绑定库根，改动会触发插件重挂载
 *   （等价"重启后生效"），故意不进设置表单。
 *
 * 约束（schemastery 强制）：volatile 必须位于固定对象路径，且**不能嵌在另一个 volatile
 * 字段内部**——因此这里只把整组（如 `vcs`）或顶层标量标为 volatile，组内字段不再单独标记。
 * 组级 volatile 也意味着表单按"整组对象"读写：客户端写回的是合并后的完整组对象，
 * 组内未暴露的字段（identity / branch / gitDir 等）不会因表单保存而丢失。
 */
export const Config = z.object({
  // 启动期绑定（普通字段：变更 → 插件重挂载）
  storageDir: z.string().default('.memory'),
  scope: z.union(['workspace', 'user']).default('workspace'),
  workspaceDir: z.string().default(''),

  // 注入预算与检索策略（live）
  maxBootTokens: z.number().min(0).default(600).volatile(),
  maxRuntimeTokens: z.number().min(0).default(1200).volatile(),
  maxSpaceTokens: z.number().min(0).default(800).volatile(),
  maxViewTokens: z.number().min(0).default(2000).volatile(),
  l3Inject: z.union(['off', 'salience', 'query']).default('off').volatile(),
  l1MaxCharsPerLine: z.number().min(0).default(160).volatile(),
  subagentInject: z.boolean().default(false).volatile(),
  toolsProfile: z.union(['core', 'full']).default('core').volatile(),

  embedding: z
    .object({
      enabled: z.boolean().default(false),
      endpoint: z.string().default('http://localhost:11434'),
      model: z.string().default('nomic-embed-text'),
      timeoutMs: z.number().min(0).default(3000),
    })
    .default({ enabled: false, endpoint: 'http://localhost:11434', model: 'nomic-embed-text', timeoutMs: 3000 })
    .volatile(),

  digest: z
    .object({
      maxMessages: z.number().min(0).default(24),
      maxPromote: z.number().min(0).default(20),
      maxRetries: z.number().min(0).default(2),
    })
    .default({ maxMessages: 24, maxPromote: 20, maxRetries: 2 })
    .volatile(),

  recall: z
    .object({
      defaultLimit: z.number().min(0).default(10),
      minSalience: z.number().min(0).default(0.25),
      highScore: z.number().min(0).default(0.6),
    })
    .default({ defaultLimit: 10, minSalience: 0.25, highScore: 0.6 })
    .volatile(),

  dedupe: z.object({ threshold: z.number().min(0).default(0.55) }).default({ threshold: 0.55 }).volatile(),

  index: z.object({ rebuildAfterWrites: z.number().min(0).default(50) }).default({ rebuildAfterWrites: 50 }).volatile(),

  recallNudge: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }).volatile(),

  vcs: z
    .object({
      enabled: z.boolean().default(true),
      autoCommit: z.boolean().default(true),
      debounceMs: z.number().min(0).default(1000),
      batch: z.number().min(1).default(8),
      branch: z.string().default('main'),
      identity: z
        .object({
          name: z.string().default('dsh-dev-memory'),
          email: z.string().default('dev-memory@dsh.local'),
        })
        .default({ name: 'dsh-dev-memory', email: 'dev-memory@dsh.local' }),
      gitDir: z.string(),
    })
    .default({
      enabled: true,
      autoCommit: true,
      debounceMs: 1000,
      batch: 8,
      branch: 'main',
      identity: { name: 'dsh-dev-memory', email: 'dev-memory@dsh.local' },
    })
    .volatile(),

  diag: z
    .object({
      enabled: z.boolean().default(true),
      maxEvents: z.number().min(0).default(2000),
    })
    .default({ enabled: true, maxEvents: 2000 })
    .volatile(),

  webui: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }).volatile(),

  seed: z
    .object({
      enabled: z.boolean().default(true),
      auto: z.boolean().default(false),
      gitCommits: z.number().min(0).default(30),
      maxEntries: z.number().min(1).default(40),
    })
    .default({ enabled: true, auto: false, gitCommits: 30, maxEntries: 40 })
    .volatile(),
})

/**
 * 把 loader 解析后的配置摊平成普通值。
 *
 * DSH 0.1.7 起 volatile 字段的解析结果是 cosmokit 的**引用**（`{ get() }`，由 loader
 * 原地提交新值），不是普通值。本插件的运行期模型是"一份可变 config 对象 + 各模块按引用读取"
 * （见 index.ts），所以每次读取前把顶层引用解引用成普通值；volatile 只标在顶层字段上
 * （见 `Config`），因此只需处理顶层。
 * @param partial - loader 解析后的配置（含 volatile 引用）或任意用户部分配置。
 * @returns 顶层字段均为普通值的配置对象。
 */
function plainConfigFields(partial: unknown): Record<string, unknown> {
  if (typeof partial !== 'object' || partial === null) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(partial as Record<string, unknown>)) {
    out[key] = isVolatile(value) ? value.get() : value
  }
  return out
}

function clampNonNegative(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return n >= 0 ? n : fallback
}

/**
 * 合并用户配置（可部分提供、可嵌套），缺失字段取默认值，数值非负钳制。
 * @param partial - 来自 cordis entry 的配置（DSH 0.1.7 下 volatile 字段是引用，先解引用）。
 */
export function mergeConfig(partial: unknown): Config {
  const p = plainConfigFields(partial)
  const digest = (p.digest ?? {}) as Record<string, unknown>
  const recall = (p.recall ?? {}) as Record<string, unknown>
  const dedupe = (p.dedupe ?? {}) as Record<string, unknown>
  const index = (p.index ?? {}) as Record<string, unknown>
  const embedding = (p.embedding ?? {}) as Record<string, unknown>
  const recallNudge = (p.recallNudge ?? {}) as Record<string, unknown>
  const vcs = (p.vcs ?? {}) as Record<string, unknown>
  const vcsIdentity = (vcs.identity ?? {}) as Record<string, unknown>
  const diag = (p.diag ?? {}) as Record<string, unknown>
  const webui = (p.webui ?? {}) as Record<string, unknown>
  const seed = (p.seed ?? {}) as Record<string, unknown>
  const defaultIdentity = DEFAULT_CONFIG.vcs.identity
  const branch = typeof vcs.branch === 'string' && /^[a-zA-Z0-9._/-]+$/.test(vcs.branch.trim()) ? vcs.branch.trim() : DEFAULT_CONFIG.vcs.branch
  const vcsOut: VcsConfig = {
    enabled: vcs.enabled !== false,
    autoCommit: vcs.autoCommit !== false,
    debounceMs: clampNonNegative(vcs.debounceMs, DEFAULT_CONFIG.vcs.debounceMs),
    batch: Math.max(1, clampNonNegative(vcs.batch, DEFAULT_CONFIG.vcs.batch)),
    branch,
    identity: {
      name: typeof vcsIdentity.name === 'string' && vcsIdentity.name.trim() !== '' ? vcsIdentity.name.trim() : defaultIdentity.name,
      email: typeof vcsIdentity.email === 'string' && vcsIdentity.email.trim() !== '' ? vcsIdentity.email.trim() : defaultIdentity.email,
    },
    ...(typeof vcs.gitDir === 'string' && vcs.gitDir.trim() !== '' ? { gitDir: vcs.gitDir.trim() } : {}),
  }
  return {
    storageDir: typeof p.storageDir === 'string' && p.storageDir.length > 0 ? p.storageDir : DEFAULT_CONFIG.storageDir,
    scope: p.scope === 'user' ? 'user' : 'workspace',
    workspaceDir:
      typeof p.workspaceDir === 'string' && p.workspaceDir.trim() !== '' ? p.workspaceDir.trim() : DEFAULT_CONFIG.workspaceDir,
    maxBootTokens: clampNonNegative(p.maxBootTokens, DEFAULT_CONFIG.maxBootTokens),
    maxRuntimeTokens: clampNonNegative(p.maxRuntimeTokens, DEFAULT_CONFIG.maxRuntimeTokens),
    maxSpaceTokens: clampNonNegative(p.maxSpaceTokens, DEFAULT_CONFIG.maxSpaceTokens),
    maxViewTokens: clampNonNegative(p.maxViewTokens, DEFAULT_CONFIG.maxViewTokens),
    // v0.6.6：只认三个合法值，其余（含未配置）落回默认 off
    l3Inject: p.l3Inject === 'salience' || p.l3Inject === 'query' ? p.l3Inject : DEFAULT_CONFIG.l3Inject,
    // v0.7.0：L1 逐行摘要上限（0 = 不摘要，保持 v0.6 行为）
    l1MaxCharsPerLine: Math.floor(clampNonNegative(p.l1MaxCharsPerLine, DEFAULT_CONFIG.l1MaxCharsPerLine)),
    // v0.7.0：子代理注入（默认 false）；工具暴露面（默认 core）
    subagentInject: p.subagentInject === true,
    toolsProfile: p.toolsProfile === 'full' ? 'full' : DEFAULT_CONFIG.toolsProfile,
    embedding: {
      enabled: embedding.enabled === true,
      endpoint:
        typeof embedding.endpoint === 'string' && /^https?:\/\//i.test(embedding.endpoint.trim())
          ? embedding.endpoint.trim().replace(/\/+$/, '')
          : DEFAULT_CONFIG.embedding.endpoint,
      model: typeof embedding.model === 'string' && embedding.model.trim() !== '' ? embedding.model.trim() : DEFAULT_CONFIG.embedding.model,
      timeoutMs: clampNonNegative(embedding.timeoutMs, DEFAULT_CONFIG.embedding.timeoutMs),
    },
    digest: {
      maxMessages: clampNonNegative(digest.maxMessages, DEFAULT_CONFIG.digest.maxMessages),
      maxPromote: clampNonNegative(digest.maxPromote, DEFAULT_CONFIG.digest.maxPromote),
      maxRetries: clampNonNegative(digest.maxRetries, DEFAULT_CONFIG.digest.maxRetries),
    },
    recall: {
      defaultLimit: clampNonNegative(recall.defaultLimit, DEFAULT_CONFIG.recall.defaultLimit),
      minSalience: clampNonNegative(recall.minSalience, DEFAULT_CONFIG.recall.minSalience),
      highScore: clampNonNegative(recall.highScore, DEFAULT_CONFIG.recall.highScore),
    },
    dedupe: { threshold: clampNonNegative(dedupe.threshold, DEFAULT_CONFIG.dedupe.threshold) },
    index: { rebuildAfterWrites: clampNonNegative(index.rebuildAfterWrites, DEFAULT_CONFIG.index.rebuildAfterWrites) },
    recallNudge: { enabled: recallNudge.enabled === true },
    vcs: vcsOut,
    diag: {
      enabled: diag.enabled !== false,
      maxEvents: Math.max(0, Math.floor(clampNonNegative(diag.maxEvents, DEFAULT_CONFIG.diag.maxEvents))),
    },
    webui: { enabled: webui.enabled !== false },
    // v0.6.5：auto 默认 false（显式写库），gitCommits=0 可关掉 git 读取
    seed: {
      enabled: seed.enabled !== false,
      auto: seed.auto === true,
      gitCommits: Math.floor(clampNonNegative(seed.gitCommits, DEFAULT_CONFIG.seed.gitCommits)),
      maxEntries: Math.max(1, Math.floor(clampNonNegative(seed.maxEntries, DEFAULT_CONFIG.seed.maxEntries))),
    },
  }
}