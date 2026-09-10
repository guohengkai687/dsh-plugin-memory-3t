/**
 * 7 个 devmemory_* 工具定义（DSH defineTool 兼容的平原对象，零 DSH 运行时依赖）。
 *
 * schema 用纯 JSON 谱；output 一律 object-rooted 且带 render；
 * execute 内的路径参数全部经 store 的 safeJoin 防逃逸。
 */

import type { DigestEngine } from './digest.js'
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

/** 构建全部工具；store/engine 由插件入口注入（支持实例或惰性 getter，v0.3.1 会话工作区解析用 getter）。 */
export function createTools(storeOrGetter: StoreGetter, engineOrGetter: EngineGetter): ToolDefinition[] {
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
   */
  const wrapDiag = (tool: ToolDefinition): ToolDefinition => {
    const execute = tool.execute
    return {
      ...tool,
      execute: async (args, exec) => {
        const s = store()
        s.diag.noteUsage(tool.name)
        try {
          return await execute(args, exec)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await s.diag
            .record({
              level: 'error',
              origin: 'tool',
              tool: tool.name,
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

  const tools: ToolDefinition[] = [
    {
      name: 'devmemory_status',
      description:
        '检查三层记忆库状态：L1 流水 / L2 笔记 / L3 事实的条目数、库根、最近一次 digest、索引脏写计数与快照陈旧度（indexDocCount/indexStale）、git 版本回溯状态、向量检索状态、诊断记录计数（v0.4）。诊断或自检用。',
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
    },
    {
      name: 'devmemory_recall',
      description:
        '跨层查询记忆（唯一读入口）：同时检索 L1 会话流水、L2 知识笔记、L3 长期事实。查到就用，查不到要明说"记忆库中没有"，绝不臆造。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '聚焦的自然语言记忆查询。' },
          maxResults: { type: 'number', description: '每层最多返回条数（默认 10）。' },
          layers: {
            type: 'array',
            items: { type: 'string', enum: ['l1', 'l2', 'l3'] },
            description: '限定检索层（默认全部）。',
          },
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
    },
    {
      name: 'devmemory_remember',
      description:
        '写入 L3 长期事实条目：preference（偏好）/ decision（决策）/ entity（实体）/ context（项目上下文）。只写确定的、长期复用的信息；一次写一条；content 首行必须是一句话摘要。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '条目内容；首行为可单独成句的一句话摘要，后接背景（可选）。' },
          kind: {
            type: 'string',
            enum: ['preference', 'decision', 'entity', 'context'],
            description: '条目类别。',
          },
          tags: { type: 'array', items: { type: 'string' }, description: '标签（用于召回与互链，可选）。' },
          importance: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: '重要度（影响初始 salience，默认 medium）。',
          },
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
    },
    {
      name: 'devmemory_note',
      description:
        '写入 L2 知识笔记（完整背景：教程、方案、排查过程）。relPath 为记忆库 docs/ 下的相对路径（可含子目录，自动补 .md）；长篇内容用 append 追加到已有笔记，不要整篇重写。',
      parameters: {
        type: 'object',
        properties: {
          relPath: { type: 'string', description: '笔记相对路径，如 notes/2026-01-15-dsh-seams.md。' },
          body: { type: 'string', description: '笔记正文（markdown）。' },
          append: { type: 'boolean', description: '追加到已有笔记而非覆盖（默认 false）。' },
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
    },
    {
      name: 'devmemory_link',
      description: '在两条 L3 条目之间建立双向关联（写入双方 links；拒绝孤儿/自链）。',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'string', description: '第一条目的 id。' },
          b: { type: 'string', description: '第二条目的 id。' },
        },
        required: ['a', 'b'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => renderText(value) },
      async execute(args) {
        const a = str(args, 'a') ?? ''
        const b = str(args, 'b') ?? ''
        const result = await store().linkEntries(a, b)
        return { a: result.a.id, b: result.b.id, aLinks: result.a.links, bLinks: result.b.links }
      },
    },
    {
      name: 'devmemory_forget',
      description:
        '删除或降权 L3 条目（操作前请先用 devmemory_recall 确认目标存在）。demote 只把 salience 减半而不是删除；delete 会写审计日志。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要处理的条目 id。' },
          mode: { type: 'string', enum: ['delete', 'demote'], description: 'delete 删除文件；demote 降权（默认 demote）。' },
          reason: { type: 'string', description: '操作原因（写入审计，可选）。' },
        },
        required: ['id'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => renderText(value) },
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
      name: 'devmemory_consolidate',
      description:
        '立即触发一次 digest 沉淀：把会话中的显式记忆内容去重后提升到 L3、超限转 L2 笔记、压缩 L1 流水，并提交 git 版本。用户说"记一下/整理记忆"时调用。',
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
    },
    {
      name: 'devmemory_history',
      description:
        '查看记忆库 git 提交历史：最近 N 次提交（hash/时间/提交信息/触及文件数），可按层（l1/l2/l3）或库内路径过滤。回溯排查用。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回最近提交条数（默认 10，上限 50）。' },
          layers: {
            type: 'array',
            items: { type: 'string', enum: ['l1', 'l2', 'l3'] },
            description: '按层过滤只显示触及该层的提交。',
          },
          path: { type: 'string', description: '库内相对路径过滤（如 docs/notes/x.md；与 layers 二选一）。' },
        },
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => renderText(value) },
      async execute(args) {
        const limit = Math.max(1, Math.min(50, Math.floor(num(args, 'limit') ?? 10)))
        const layers = strArray(args, 'layers')
        const paths = filterPaths(layers, str(args, 'path'))
        const commits = await store().vcs.history(limit, paths)
        return { vcs: await store().vcs.status(), commits }
      },
    },
    {
      name: 'devmemory_diff',
      description:
        '查看记忆库变更明细：指定提交相对其父提交改了什么（ref 省略时显示当前未提交变更），返回文件级增删行数与状态（A/M/D）。判断"这条记录记的是什么、要不要回滚"用。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '提交标识（hash 或 HEAD~N）；省略时对比当前未提交变更。' },
          layers: {
            type: 'array',
            items: { type: 'string', enum: ['l1', 'l2', 'l3'] },
            description: '按层过滤。',
          },
          path: { type: 'string', description: '库内相对路径过滤（与 layers 二选一）。' },
        },
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => renderText(value) },
      async execute(args) {
        const ref = str(args, 'ref')
        const layers = strArray(args, 'layers')
        const paths = filterPaths(layers, str(args, 'path'))
        const entries = await store().vcs.diff({ ref, paths })
        return { vcs: await store().vcs.status(), ref: ref ?? '(未提交)', files: entries, total: entries.length }
      },
    },
    {
      name: 'devmemory_restore',
      description:
        '把记忆库目标恢复到指定 git 提交的状态（危险操作，先 dryRun 预览）。恢复只改内容不回写历史：自动先保存当前状态为检查点提交，恢复本身也留一个新提交（可撤销的撤销）。targets 省略或填 all 时恢复整库时间片（全部被 git 跟踪的内容回到该提交，含之后的删除/新增一并反转）。恢复后建议用 devmemory_recall 核对。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '要恢复到的提交（hash 或 HEAD~N）。必填。' },
          targets: {
            type: 'array',
            items: { type: 'string' },
            description: '恢复对象：层名（l1/l2/l3）或库内相对路径；省略或填 ["all"] = 整库时间片。可选。',
          },
          dryRun: { type: 'boolean', description: '仅预览将变更的文件清单（默认 true，先干跑确认再执行）。' },
        },
        required: ['ref'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => renderText(value) },
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
      name: 'devmemory_diag',
      description:
        '查看诊断与异常记录汇总（v0.4）：插件在记忆管理调用中自动记录的调用异常与不符合预期的行为（工具报错 / 降级路径 / 生命周期失败，存 <库>/diag/events.jsonl）。summary 给汇总统计（分级/分工具/分来源 + 最近事件 + 本进程工具使用次数）；list 看明细；clear 清空后开启新一轮观察。使用一段时间后审查这批记录用于优化插件。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['summary', 'list', 'clear'], description: 'summary=汇总统计（默认）；list=明细；clear=清空全部记录。' },
          level: { type: 'string', enum: ['error', 'unexpected'], description: '按级别过滤（list 用）：error=调用异常；unexpected=不符合预期行为。' },
          tool: { type: 'string', description: '按工具名过滤（list 用），如 devmemory_recall。' },
          origin: { type: 'string', description: '按来源过滤（list 用），如 tool/session/digest/vcs/embed/webui/skill/nudge/restore。' },
          days: { type: 'number', description: '只看最近 N 天的记录（list 用）。' },
          limit: { type: 'number', description: '明细条数（默认 20，上限 100）。' },
        },
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => renderText(value) },
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
  ]
  return tools.map(wrapDiag)
}