/**
 * devmemory_* 工具定义。
 *
 * v0.7.0（实测驱动的工具瘦身，见 .memory/docs/notes/2026-09-23-memory-3t-token-cost-evaluation.md）：
 * DSH 每次模型调用都携带全部工具的 schema（实测 39 工具 = 9203 tokens），
 * 12 个 devmemory_* 占 2081 tokens/调用——**占插件全部 token 开销的 ~99%**，
 * 而低频运维工具在 3 天窗口的 1188 次调用里只被用到 12 次。因此：
 *
 * - 默认 `profile: 'core'`：5 个高频工具（status/recall/remember/note/consolidate）
 *   + 1 个 action 式 `devmemory_admin`（op = link/forget/history/diff/restore/diag/seed）。
 * - `profile: 'full'`：保留 v0.6 的 12 个独立工具（兼容逐工具粒度的调用习惯，MCP 默认走它）。
 * - 所有描述同步精简：协议细节由 boot 块与 dev-memory skill 承担，schema 只讲"做什么/何时用"。
 *
 * schema 用纯 JSON 谱；output 一律 object-rooted 且带 render；
 * execute 内的路径参数全部经 store 的 safeJoin 防逃逸。
 */

import type { DigestEngine } from './digest.js'
import { seedLibrary } from './seed.js'
import type { EntryKind, Importance, MemoryStore } from './store.js'

/**
 * DSH tool-result 契约：`output.render` 必须返回 ContentBlock 数组
 * （如 `[{ type: 'text', text }]`），字符串会让 tool-result 消息的嵌套
 * content 变成字符串，进而使 LLM 文本模型消息投影（contentHasImage 递归）
 * 抛 `content.some is not a function`。对照内置工具 dsh-tool-todo。
 */
export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): TextBlock[] }
  execute(args: Record<string, unknown>, exec: unknown): Promise<unknown>
}

/** 工具暴露面（v0.7.0）；与 `config.toolsProfile` 同一取值域。 */
export type ToolsProfile = 'core' | 'full'

export interface CreateToolsOptions {
  /** 默认 `core`（精简暴露面）；`full` = v0.6 的 12 个独立工具。 */
  profile?: ToolsProfile
}

const JSON_OBJECT_OUTPUT = { type: 'object', properties: {} } as const

function text(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** render 统一出口：把任意值渲染为 DSH 要求的 ContentBlock 文本块数组。 */
function renderText(value: unknown): TextBlock[] {
  return [{ type: 'text', text: text(value) }]
}

export type StoreGetter = MemoryStore | (() => MemoryStore)
export type EngineGetter = DigestEngine | (() => DigestEngine)

/** 低频运维动作：core 面合并进 `devmemory_admin`，full 面各自成工具。 */
interface AdminAction {
  /** full 面工具名。 */
  tool: string
  /** admin 面 `op` 取值。 */
  op: string
  /** full 面描述（精简版）。 */
  description: string
  /** 参数 properties（不含 dispatcher 字段）。 */
  properties: Record<string, unknown>
  required: string[]
  execute(args: Record<string, unknown>): Promise<unknown>
}

/** 构建全部工具；store/engine 由插件入口注入（支持实例或惰性 getter，v0.3.1 会话工作区解析用 getter）。 */
export function createTools(
  storeOrGetter: StoreGetter,
  engineOrGetter: EngineGetter,
  options: CreateToolsOptions = {},
): ToolDefinition[] {
  /** 惰性取当前工作区的记忆库：getter 时每次调用求值（会话工作区切换后工具自动跟新库）。 */
  const store = (): MemoryStore =>
    typeof storeOrGetter === 'function' ? (storeOrGetter as () => MemoryStore)() : storeOrGetter
  const engine = (): DigestEngine =>
    typeof engineOrGetter === 'function' ? (engineOrGetter as () => DigestEngine)() : engineOrGetter
  const str = (args: Record<string, unknown>, key: string): string | undefined => {
    const v = args[key]
    return typeof v === 'string' ? v : undefined
  }
  const num = (args: Record<string, unknown>, key: string): number | undefined => {
    const v = args[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  const bool = (args: Record<string, unknown>, key: string): boolean | undefined => {
    const v = args[key]
    return typeof v === 'boolean' ? v : undefined
  }
  const strArray = (args: Record<string, unknown>, key: string): string[] | undefined => {
    const v = args[key]
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
  }

  /** 诊断参数摘要（截断字符串参数，防敏感记忆内容整段落盘）。 */
  const sanitizeArgs = (args: Record<string, unknown>): string => {
    try {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(args)) {
        if (v === undefined) continue
        if (typeof v === 'string') out[k] = v.length > 60 ? `${v.slice(0, 60)}…` : v
        else if (Array.isArray(v)) out[k] = v.slice(0, 8).map((x) => (typeof x === 'string' ? (x.length > 30 ? `${x.slice(0, 30)}…` : x) : String(x))).join(',')
        else out[k] = String(v)
      }
      const json = JSON.stringify(out)
      return json.length > 300 ? `${json.slice(0, 300)}…` : json
    } catch {
      return '{}'
    }
  }

  /**
   * 诊断埋点包裹（v0.4）：每次调用记 usage（进程内内存计数）；execute 抛错时自动
   * 落一条 error 级诊断（工具名 + 参数摘要 + 消息 + 堆栈），随后原样重抛（行为不变）。
   * v0.7.0：admin 面把 op 一并写进消息，否则 7 个动作的错误在诊断里无法区分。
   */
  const wrapDiag = (tool: ToolDefinition): ToolDefinition => {
    const execute = tool.execute
    return {
      ...tool,
      execute: async (args, exec) => {
        const s = store()
        s.diag.noteUsage(tool.name)
        const op = tool.name === 'devmemory_admin' ? str(args ?? {}, 'op') : undefined
        const label = op !== undefined ? `${tool.name}:${op}` : tool.name
        try {
          return await execute(args, exec)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await s.diag
            .record({
              level: 'error',
              origin: 'tool',
              tool: label,
              message,
              args: sanitizeArgs(args ?? {}),
              stack: error instanceof Error ? (error.stack ?? undefined) : undefined,
            })
            .catch(() => undefined)
          throw error
        }
      },
    }
  }

  /** 层名 → 库内目录名（历史/差异的路径过滤）。 */
  const layerPaths = (layers: string[] | undefined): string[] => {
    if (layers === undefined || layers.length === 0) return []
    const out: string[] = []
    for (const layer of layers) {
      if (layer === 'l1') out.push('runtime')
      else if (layer === 'l2') out.push('docs')
      else if (layer === 'l3') out.push('spaces')
    }
    return out
  }

  /** 历史/差异的路径过滤：层名或库内相对路径（仅校验非法形态，读取无害）。 */
  const filterPaths = (layers: string[] | undefined, path: string | undefined): string[] => {
    if (path !== undefined && path.trim() !== '') {
      const p = path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
      if (p.includes(':') || p.startsWith('/') || p.split('/').some((s) => s === '..')) {
        throw new Error(`路径过滤必须是层名或库内相对路径: ${path}`)
      }
      return [p]
    }
    return layerPaths(layers)
  }

  const LAYERS_PROP = {
    type: 'array',
    items: { type: 'string', enum: ['l1', 'l2', 'l3'] },
    description: '层过滤。',
  }

  // ---------------------------------------------------------------- 高频工具（core 面常驻）

  const statusTool: ToolDefinition = {
    name: 'devmemory_status',
    description: '记忆库状态：条目数、库根、索引陈旧度、git 回溯、向量检索、诊断计数。诊断/自检用。',
    parameters: { type: 'object', properties: {} },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => renderText(value) },
    async execute() {
      const s = store()
      const status = await s.status()
      const digest = s.digestState
      return {
        ready: status.ready,
        root: status.root,
        scope: status.scope,
        counts: status.counts,
        lastDigestAt: status.lastDigestAt,
        digestPending: digest.pending,
        digestRetries: digest.retries,
        digestLastError: digest.lastError,
        indexDirty: status.indexDirty,
        // v0.6.2：索引快照陈旧度（此工具为白名单构造，漏映射会让 store 新增字段不可见）
        indexDocCount: status.indexDocCount,
        indexStale: status.indexStale,
        firstRun: status.firstRun,
        vcs: status.vcs,
        embedding: status.embedding,
        // v0.4：诊断计数 + 最近 5 条记录
        diag: { ...(await s.diag.counters()), recent: await s.diag.list({ limit: 5 }) },
      }
    },
  }

  const recallTool: ToolDefinition = {
    name: 'devmemory_recall',
    description: '跨层查记忆（L1 流水/L2 笔记/L3 事实，唯一读入口）。查到就用；查不到要明说"记忆库中没有"，绝不臆造。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言查询。' },
        maxResults: { type: 'number', description: '每层条数（默认 10）。' },
        layers: LAYERS_PROP,
      },
      required: ['query'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => renderText(value) },
    async execute(args) {
      const query = str(args, 'query') ?? ''
      if (query.trim() === '') throw new Error('devmemory_recall: query 不能为空')
      const maxResults = num(args, 'maxResults')
      const layers = strArray(args, 'layers') as Array<'l1' | 'l2' | 'l3'> | undefined
      return store().recall(query, { maxResults, layers })
    },
  }

  const rememberTool: ToolDefinition = {
    name: 'devmemory_remember',
    description: '写 L3 长期事实。只写确定且长期复用的；一次一条；content 首行是可独立成句的一句话摘要。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '首行=一句话摘要，后接背景。' },
        kind: { type: 'string', enum: ['preference', 'decision', 'entity', 'context'], description: '类别。' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，可选。' },
        importance: { type: 'string', enum: ['low', 'medium', 'high'], description: '默认 medium。' },
      },
      required: ['content', 'kind'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => renderText(value) },
    async execute(args) {
      const content = str(args, 'content') ?? ''
      const kind = str(args, 'kind') as EntryKind
      if (content.trim() === '') throw new Error('devmemory_remember: content 不能为空')
      if (!['preference', 'decision', 'entity', 'context'].includes(kind)) {
        throw new Error('devmemory_remember: kind 必须为 preference|decision|entity|context')
      }
      const importance = str(args, 'importance') as Importance | undefined
      if (importance !== undefined && !['low', 'medium', 'high'].includes(importance)) {
        throw new Error('devmemory_remember: importance 必须为 low|medium|high')
      }
      const entry = await store().remember({ kind, content, tags: strArray(args, 'tags'), importance })
      return { id: entry.id, kind: entry.kind, summary: entry.summary }
    },
  }

  const noteTool: ToolDefinition = {
    name: 'devmemory_note',
    description: '写 L2 知识笔记（教程/方案/排查过程，含完整背景）。长内容用 append 追加，不要整篇重写。',
    parameters: {
      type: 'object',
      properties: {
        relPath: { type: 'string', description: 'docs/ 下相对路径，自动补 .md。' },
        body: { type: 'string', description: 'markdown 正文。' },
        append: { type: 'boolean', description: '追加而非覆盖（默认 false）。' },
      },
      required: ['relPath', 'body'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => renderText(value) },
    async execute(args) {
      const relPath = str(args, 'relPath') ?? ''
      const body = str(args, 'body') ?? ''
      if (relPath.trim() === '') throw new Error('devmemory_note: relPath 不能为空')
      if (body.trim() === '') throw new Error('devmemory_note: body 不能为空')
      const append = bool(args, 'append') ?? false
      const result = await store().note({ relPath, body, append })
      return { path: result.path }
    },
  }

  const consolidateTool: ToolDefinition = {
    name: 'devmemory_consolidate',
    description: '立即 digest 沉淀（去重提升 L3 / 超限转 L2 / 压缩 L1）并提交 git。用户说"记一下/整理记忆"时调用。',
    parameters: { type: 'object', properties: {} },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => renderText(value) },
    async execute() {
      const s = store()
      const key = `manual-${Date.now()}`
      const summaries = await engine().maybeDigest({ key, messages: [], forced: true })
      await s.flushVcs('digest')
      // v0.4：digest 失败（待补做）→ 落 error 诊断
      if (s.digestState.pending) {
        void s.diag
          .record({
            level: 'error',
            origin: 'digest',
            tool: 'devmemory_consolidate',
            message: `digest 失败待补做（重试 ${s.digestState.retries} 次）: ${s.digestState.lastError ?? '未知原因'}`,
          })
          .catch(() => undefined)
      }
      return {
        triggered: true,
        summaries: summaries ?? ['digest 未产生新沉淀（或失败，见 status）'],
        vcs: await s.vcs.status(),
      }
    },
  }

  // ---------------------------------------------------------------- 低频运维动作

  const adminActions: AdminAction[] = [
    {
      tool: 'devmemory_link',
      op: 'link',
      description: '在两条 L3 条目间建立双向关联（拒绝孤儿/自链）。',
      properties: {
        a: { type: 'string', description: 'L3 id。' },
        b: { type: 'string', description: 'L3 id。' },
      },
      required: ['a', 'b'],
      async execute(args) {
        const a = str(args, 'a') ?? ''
        const b = str(args, 'b') ?? ''
        const result = await store().linkEntries(a, b)
        return { a: result.a.id, b: result.b.id, aLinks: result.a.links, bLinks: result.b.links }
      },
    },
    {
      tool: 'devmemory_forget',
      op: 'forget',
      description: '删除或降权 L3 条目（先用 recall 确认存在）：demote 降权（默认），delete 删除并写审计。',
      properties: {
        id: { type: 'string', description: 'L3 id。' },
        mode: { type: 'string', enum: ['delete', 'demote'], description: 'delete 删除；demote 降权（默认）。' },
        reason: { type: 'string' },
      },
      required: ['id'],
      async execute(args) {
        const id = str(args, 'id') ?? ''
        const mode = str(args, 'mode') === 'delete' ? 'delete' : 'demote'
        const reason = str(args, 'reason') ?? ''
        const ok = await store().removeEntry(id, mode, reason)
        if (!ok) throw new Error(`devmemory_forget: 条目不存在 ${id}`)
        return { id, mode, ok: true }
      },
    },
    {
      tool: 'devmemory_history',
      op: 'history',
      description: '记忆库 git 提交历史（可按层或库内路径过滤）。回溯排查用。',
      properties: {
        limit: { type: 'number', description: '条数（默认 10，diag 默认 20）。' },
        layers: LAYERS_PROP,
        path: { type: 'string', description: '库内路径（与 layers 二选一）。' },
      },
      required: [],
      async execute(args) {
        const limit = Math.max(1, Math.min(50, Math.floor(num(args, 'limit') ?? 10)))
        const layers = strArray(args, 'layers')
        const paths = filterPaths(layers, str(args, 'path'))
        const commits = await store().vcs.history(limit, paths)
        return { vcs: await store().vcs.status(), commits }
      },
    },
    {
      tool: 'devmemory_diff',
      op: 'diff',
      description: '指定提交相对父提交的变更明细（文件级 A/M/D）；ref 省略时看未提交变更。',
      properties: {
        ref: { type: 'string', description: '省略=未提交变更。' },
        layers: LAYERS_PROP,
        path: { type: 'string', description: '库内路径（与 layers 二选一）。' },
      },
      required: [],
      async execute(args) {
        const ref = str(args, 'ref')
        const layers = strArray(args, 'layers')
        const paths = filterPaths(layers, str(args, 'path'))
        const entries = await store().vcs.diff({ ref, paths })
        return { vcs: await store().vcs.status(), ref: ref ?? '(未提交)', files: entries, total: entries.length }
      },
    },
    {
      tool: 'devmemory_restore',
      op: 'restore',
      description:
        '把库恢复到指定提交（危险，先 dryRun 预览）。只改内容不回写历史；默认整库时间片；恢复后建议 recall 核对。',
      properties: {
        ref: { type: 'string', description: 'hash 或 HEAD~N。' },
        targets: { type: 'array', items: { type: 'string' }, description: 'l1/l2/l3 或路径；省略=整库。' },
        dryRun: { type: 'boolean', description: '默认 true（仅预览）。' },
      },
      required: ['ref'],
      async execute(args) {
        const ref = str(args, 'ref') ?? ''
        const targets = strArray(args, 'targets')
        if (ref.trim() === '') throw new Error('devmemory_restore: ref 不能为空')
        const dryRun = bool(args, 'dryRun') ?? true
        // targets 省略 / 空数组 / 含 all → 整库时间片（v0.3）
        const whole = targets === undefined || targets.length === 0 || targets.includes('all')
        const result = await store().vcs.restore({ ref: ref.trim(), targets: whole ? ['all'] : targets, dryRun })
        if (!result.dryRun && result.applied) {
          // 恢复改动内容 → 索引失效，下次查询前自动重建
          store().index.markDirty()
        }
        // 展示层：内部 '.' 统一呈现为 'all'
        const shown = { ...result, targets: result.targets.length === 1 && result.targets[0] === '.' ? ['all'] : result.targets }
        // v0.4：真实恢复但零变更 → 不符合预期行为（ref 可能已与当前状态一致）
        if (!result.dryRun && result.applied && result.changes.length === 0) {
          void store()
            .diag.record({
              level: 'unexpected',
              origin: 'restore',
              tool: 'devmemory_restore',
              message: `恢复执行完成但无任何变更（ref=${ref}，目标可能已与该提交一致）`,
              args: sanitizeArgs(args),
            })
            .catch(() => undefined)
        }
        return shown
      },
    },
    {
      tool: 'devmemory_diag',
      op: 'diag',
      description: '诊断与异常记录（工具报错 / 降级路径 / 生命周期失败）：summary 汇总、list 明细、clear 清空。',
      properties: {
        action: { type: 'string', enum: ['summary', 'list', 'clear'], description: '默认 summary。' },
        level: { type: 'string', enum: ['error', 'unexpected'] },
        tool: { type: 'string' },
        origin: { type: 'string' },
        days: { type: 'number' },
        
      },
      required: [],
      async execute(args) {
        const s = store()
        const action = str(args, 'action') ?? 'summary'
        if (action === 'list') {
          const levelRaw = str(args, 'level')
          const events = await s.diag.list({
            level: levelRaw === 'error' || levelRaw === 'unexpected' ? levelRaw : undefined,
            tool: str(args, 'tool'),
            origin: str(args, 'origin'),
            days: num(args, 'days'),
            limit: num(args, 'limit'),
          })
          return { total: events.length, events }
        }
        if (action === 'clear') {
          const { totalCleared } = await s.diag.clear()
          return { cleared: true, totalCleared }
        }
        return s.diag.summary()
      },
    },
    {
      tool: 'devmemory_seed',
      op: 'seed',
      description:
        '冷启动骨架（库为空时用）：从 git 历史 / package.json / README / 顶层结构生成一篇 L2 骨架笔记，不调用 LLM；候选 L3 只返回不写入。幂等。',
      properties: {
        force: { type: 'boolean', description: '覆盖已存在的骨架。' },
      },
      required: [],
      async execute(args) {
        const s = store()
        // config 从 store 上取（createTools 不额外接收 config，避免签名膨胀）
        return seedLibrary(s, s.config, { force: bool(args, 'force') === true })
      },
    },
  ]

  const adminTool: ToolDefinition = {
    name: 'devmemory_admin',
    description:
      '低频运维（一次一件）：op=link 关联 L3 / forget 删除降权 / history git 历史 / diff 变更明细 / restore 恢复提交 / diag 诊断记录 / seed 冷启动骨架。',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: adminActions.map((a) => a.op),
          description: '运维动作。',
        },
        ...Object.assign({}, ...adminActions.map((a) => a.properties)),
      },
      required: ['op'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => renderText(value) },
    async execute(args) {
      const op = str(args, 'op') ?? ''
      const action = adminActions.find((a) => a.op === op)
      if (action === undefined) {
        throw new Error(`devmemory_admin: 未知 op=${op}（可用：${adminActions.map((a) => a.op).join('/')}）`)
      }
      return action.execute(args)
    },
  }

  const coreTools: ToolDefinition[] = [statusTool, recallTool, rememberTool, noteTool, consolidateTool]
  const legacyTools: ToolDefinition[] = adminActions.map((action) => ({
    name: action.tool,
    description: action.description,
    parameters: { type: 'object', properties: action.properties, ...(action.required.length > 0 ? { required: action.required } : {}) },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => renderText(value) },
    execute: (args: Record<string, unknown>) => action.execute(args),
  }))

  const tools = options.profile === 'full' ? [...coreTools, ...legacyTools] : [...coreTools, adminTool]
  return tools.map(wrapDiag)
}

/** core 面常驻工具名（测试与文档用）。 */
export const CORE_TOOL_NAMES = [
  'devmemory_status',
  'devmemory_recall',
  'devmemory_remember',
  'devmemory_note',
  'devmemory_consolidate',
  'devmemory_admin',
] as const

/** full 面工具名（v0.6 的 12 个独立工具）。 */
export const FULL_TOOL_NAMES = [
  'devmemory_status',
  'devmemory_recall',
  'devmemory_remember',
  'devmemory_note',
  'devmemory_link',
  'devmemory_forget',
  'devmemory_consolidate',
  'devmemory_history',
  'devmemory_diff',
  'devmemory_restore',
  'devmemory_diag',
  'devmemory_seed',
] as const
