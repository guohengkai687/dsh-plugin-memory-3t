/**
 * MemoryStore：三层记忆的读写中枢。
 *
 * - L3（spaces/）：frontmatter 元数据条目（id/kind/salience/accesses/tags/links）
 * - L2（docs/）：markdown 笔记（支持子目录与追加）
 * - L1（runtime/）：按日会话流水（YYYY-MM-DD.md）
 * - meta.json / audit.jsonl：状态与审计
 *
 * 所有写入只做索引脏标记，不实时重建倒排（防写入风暴）。
 * 所有路径参数经过 safeJoin 防逃逸。
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, extname, join } from 'node:path'

import type { Config } from './config.js'
import { DiagLog, type DiagCounters } from './diag.js'
import { EmbeddingClient, cosineSimilarity, fuseScore, type EmbeddingStatus } from './embed.js'
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js'
import {
  IndexManager,
  searchIndex,
  type IndexedDoc,
  type LayerId,
  type RecallHit,
  type RecallResult,
} from './indexer.js'
import { layerDirs, resolveRoot, runtimeFileName, safeJoin } from './paths.js'
import { GitVcs, type VcsStatus } from './vcs.js'

export type EntryKind = 'preference' | 'decision' | 'entity' | 'context'
export type Importance = 'low' | 'medium' | 'high'

export interface SpaceEntry {
  id: string
  kind: EntryKind
  created: string
  updated: string
  salience: number
  accesses: number
  tags: string[]
  links: string[]
  summary: string
  body: string
}

export interface RecallOptions {
  layers?: LayerId[]
  maxResults?: number
  /** 命中 L3 时是否提升 accesses/salience（默认 true）。 */
  touch?: boolean
}

export interface DigestState {
  lastRunAt: string | null
  pending: boolean
  retries: number
  lastError: string | null
}

export interface MetaFile {
  schemaVersion: 1
  root: string
  createdAt: string
  config: Config
  digest: DigestState
  counters: Record<string, number>
}

export interface StoreStatusSnapshot {
  ready: boolean
  root: string
  /** 记忆库粒度（v0.3）：workspace / user。 */
  scope: 'workspace' | 'user'
  counts: { l1: number; l2: number; l3: number }
  lastDigestAt: string | null
  indexDirty: number
  /** v0.6.1：当前快照文档数（未加载过则读磁盘）。 */
  indexDocCount: number | null
  /** v0.6.1：快照文档数与库内实际是否不一致（陈旧/超前）。 */
  indexStale: boolean
  firstRun: boolean
  /** git 版本回溯状态（v0.2）。git 不可用时自动降级。 */
  vcs: VcsStatus
  /** 向量检索状态（v0.2）。Ollama 不可用时自动降级回 BM25。 */
  embedding: EmbeddingStatus
  /** 诊断与异常记录计数（v0.4）。 */
  diag: DiagCounters
}

const KIND_SHORT: Record<EntryKind, string> = {
  preference: 'pref',
  decision: 'dec',
  entity: 'ent',
  context: 'ctx',
}

const KIND_BY_SHORT: Record<string, EntryKind> = Object.fromEntries(
  Object.entries(KIND_SHORT).map(([kind, short]) => [short, kind as EntryKind]),
) as Record<string, EntryKind>

const IMPORTANCE_SALIENCE: Record<Importance, number> = { low: 0.3, medium: 0.6, high: 0.9 }

const DEFAULT_SALIENCE_DECAY_DAYS = 30

/** 语义补漏的扫描上限：向量文件数超过该值只融合 BM25 命中，不做全量余弦扫描（规模保护）。 */
const VECTOR_SCAN_CAP = 2000

/** 生成 L3 条目 id：<kind短名>-<yyyymmdd>-<随机11位>。 */
function makeEntryId(kind: EntryKind, date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const rand = randomUUID().replace(/-/g, '').slice(0, 11)
  return `${KIND_SHORT[kind]}-${y}${m}${d}-${rand}`
}

function kindOfId(id: string): EntryKind | undefined {
  const short = id.slice(0, id.indexOf('-'))
  return short === '' ? undefined : KIND_BY_SHORT[short]
}

function entrySummary(body: string): string {
  const first = body.replace(/^\s+/, '').split(/\r?\n/)[0] ?? ''
  return first.replace(/^#+\s*/, '').trim()
}

export class MemoryStore {
  readonly root: string
  private readonly dirs: ReturnType<typeof layerDirs>
  readonly index: IndexManager
  /** git 版本回溯管理层（v0.2）。 */
  readonly vcs: GitVcs
  /** 向量嵌入客户端（v0.2，默认关闭；fetch 可注入便于测试）。 */
  readonly embedding: EmbeddingClient
  /** 诊断与异常记录（v0.4）。 */
  readonly diag: DiagLog
  private meta: MetaFile | null = null
  private vcsDegradedWarned = false
  private embeddingWarned = false

  constructor(
    workspaceRoot: string,
    public readonly config: Config,
  ) {
    this.root = resolveRoot(workspaceRoot, config.storageDir, config.scope)
    this.dirs = layerDirs(this.root)
    this.index = new IndexManager(safeJoin(this.root, 'index.json'), config.index.rebuildAfterWrites)
    this.vcs = new GitVcs(this.root, config.vcs)
    this.embedding = new EmbeddingClient(config.embedding)
    this.diag = new DiagLog(this.root, config.diag)
  }

  // ---------------------------------------------------------------- 初始化

  async init(): Promise<void> {
    await mkdir(this.dirs.runtime, { recursive: true, mode: 0o700 })
    await mkdir(this.dirs.docs, { recursive: true, mode: 0o700 })
    await mkdir(this.dirs.spaces, { recursive: true, mode: 0o700 })
    if (this.meta === null) await this.loadMeta()
    try {
      await appendFile(safeJoin(this.root, 'audit.jsonl'), '', { flag: 'a', mode: 0o600 })
    } catch {
      /* 审计文件不可写不阻断启动 */
    }
    // v0.3：scope:user 的库在工作区外，绝不改写工作区 .gitignore；workspace 粒度才自维护
    if (this.config.scope !== 'user') await this.maintainGitignore()
    // v0.4：诊断目录初始化（不可写静默跳过）
    await this.diag.ensureDir()
    await this.vcs.init()
    // v0.4：git 降级（缺失/不可用/初始化失败）记一条"不符合预期"诊断
    if (this.config.vcs.enabled && !this.vcs.isReady && !this.vcsDegradedWarned) {
      this.vcsDegradedWarned = true
      void this.diag
        .record({
          level: 'unexpected',
          origin: 'vcs',
          message: this.vcs.lastError ?? 'git 版本回溯未就绪（降级为仅本地存储，记忆读写不受影响）',
        })
        .catch(() => undefined)
    }
    // 探测向量服务（fail-open，不阻塞启动；ready 状态由后续 embed/ping 持续更新）
    if (this.config.embedding.enabled) {
      void this.embedding.ping().catch(() => undefined)
    }
  }

  /** 版本登记：fail-open，git 侧故障绝不影响业务写。 */
  private vcsRecord(layer: LayerId, op: string): void {
    try {
      this.vcs.record(layer, op)
    } catch {
      /* 忽略 */
    }
  }

  /** 显式提交边界：digest / 会话边界 / 恢复前调用。 */
  flushVcs(reason?: string): Promise<{ hash: string; message: string } | null> {
    return this.vcs.flush(reason)
  }

  // ---------------------------------------------------------------- 向量（embedding，纯增强）

  private async upsertVector(docKey: string, text: string): Promise<void> {
    if (!this.embedding.enabled) return
    try {
      const vec = await this.embedding.embed(text)
      if (vec !== null) await this.embedding.saveVector(this.root, docKey, vec)
    } catch {
      /* fail-open：向量生成失败不影响记忆写入 */
    }
  }

  private async deleteVector(docKey: string): Promise<void> {
    if (!this.embedding.enabled) return
    try {
      await this.embedding.deleteVector(this.root, docKey)
    } catch {
      /* fail-open */
    }
  }

  private async loadMeta(): Promise<void> {
    const path = safeJoin(this.root, 'meta.json')
    try {
      const raw = await readFile(path, 'utf8')
      const parsed = JSON.parse(raw) as MetaFile
      if (parsed.schemaVersion === 1 && typeof parsed.root === 'string') {
        this.meta = { ...parsed, config: { ...this.config, ...parsed.config } }
        return
      }
    } catch {
      /* 缺失或损坏 → 重建 */
    }
    const now = new Date().toISOString()
    this.meta = {
      schemaVersion: 1,
      root: this.root,
      createdAt: now,
      config: this.config,
      digest: { lastRunAt: null, pending: false, retries: 0, lastError: null },
      counters: {},
    }
    await this.writeMeta()
  }

  private async writeMeta(): Promise<void> {
    if (this.meta === null) return
    await writeFile(safeJoin(this.root, 'meta.json'), JSON.stringify(this.meta, null, 2), { mode: 0o600 })
  }

  /** AC3：`.gitignore` 自维护——存在且未含记忆库基名时追加一行。 */
  private async maintainGitignore(): Promise<void> {
    const workspace = this.workspaceRoot()
    if (workspace === null) return
    const base = this.config.storageDir.replace(/[\\/]+$/, '')
    if (base === '' || base.startsWith('..')) return
    const gitignorePath = join(workspace, '.gitignore')
    try {
      const existing = await readFile(gitignorePath, 'utf8')
      const lines = existing.split(/\r?\n/)
      if (lines.some((line) => line.trim() === base)) return
      await appendFile(gitignorePath, `\n${base}\n`, { mode: 0o644 })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') return
      // 无 .gitignore 不创建（避免污染无 git 的项目）
      return
    }
  }

  private workspaceRoot(): string | null {
    // storageDir 为绝对路径时，无法推断工作区根 → 跳过 .gitignore 维护
    const storageDir = this.config.storageDir
    if (storageDir.includes(':') || storageDir.startsWith('/') || storageDir.startsWith('\\')) return null
    return dirname(this.root)
  }

  // ---------------------------------------------------------------- meta / audit

  get digestState(): DigestState {
    return this.meta?.digest ?? { lastRunAt: null, pending: false, retries: 0, lastError: null }
  }

  async updateDigestState(patch: Partial<DigestState>): Promise<void> {
    if (this.meta === null) await this.loadMeta()
    if (this.meta === null) return
    this.meta.digest = { ...this.meta.digest, ...patch }
    await this.writeMeta()
  }

  async bumpCounter(key: string, delta = 1): Promise<void> {
    if (this.meta === null) await this.loadMeta()
    if (this.meta === null) return
    this.meta.counters[key] = (this.meta.counters[key] ?? 0) + delta
    await this.writeMeta()
  }

  private async audit(op: string, detail: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ ts: new Date().toISOString(), op, ...detail })
    try {
      await appendFile(safeJoin(this.root, 'audit.jsonl'), line + '\n', { mode: 0o600 })
    } catch {
      /* 审计失败不计入业务流程 */
    }
  }

  // ---------------------------------------------------------------- L3 spaces

  /**
   * 写 L3 条目。
   * @returns 新条目（含生成的 id）。
   */
  async remember(input: { kind: EntryKind; content: string; tags?: string[]; importance?: Importance }): Promise<SpaceEntry> {
    const kind = input.kind
    const now = new Date()
    const id = makeEntryId(kind, now)
    const lines = input.content.trim().split(/\r?\n/)
    const summary = (lines[0] ?? '').replace(/^#+\s*/, '').trim()
    if (summary === '') throw new Error('devmemory_remember: content 首行必须是一句话摘要')
    const body = input.content.trim()
    const entry: SpaceEntry = {
      id,
      kind,
      created: now.toISOString(),
      updated: now.toISOString(),
      salience: IMPORTANCE_SALIENCE[input.importance ?? 'medium'],
      accesses: 0,
      tags: [...new Set((input.tags ?? []).map((t) => t.trim()).filter((t) => t !== ''))],
      links: [],
      summary,
      body,
    }
    await this.writeEntry(entry)
    this.index.markDirty()
    this.vcsRecord('l3', `remember ${entry.id}`)
    await this.upsertVector(entry.id, `${entry.summary}\n${entry.body}`)
    void this.bumpCounter('entriesTotal')
    return entry
  }

  private async writeEntry(entry: SpaceEntry): Promise<void> {
    await mkdir(this.dirs.spaces, { recursive: true, mode: 0o700 })
    const data: Record<string, unknown> = {
      id: entry.id,
      kind: entry.kind,
      created: entry.created,
      updated: entry.updated,
      salience: entry.salience,
      accesses: entry.accesses,
      tags: entry.tags,
      links: entry.links,
    }
    const text = serializeFrontmatter(data, entry.body)
    await writeFile(safeJoin(this.dirs.spaces, `${entry.id}.md`), text, { mode: 0o600 })
  }

  async readEntry(id: string): Promise<SpaceEntry | null> {
    if (!/^[a-z0-9]+-/.test(id)) return null
    const path = safeJoin(this.dirs.spaces, `${id}.md`)
    try {
      const raw = await readFile(path, 'utf8')
      const { data, body } = parseFrontmatter(raw)
      return this.entryFromData(id, data, body)
    } catch {
      return null
    }
  }

  private entryFromData(id: string, data: Record<string, unknown>, body: string): SpaceEntry {
    const kind = KIND_BY_SHORT[id.slice(0, id.indexOf('-'))] ?? 'context'
    return {
      id,
      kind,
      created: typeof data.created === 'string' ? data.created : new Date().toISOString(),
      updated: typeof data.updated === 'string' ? data.updated : new Date().toISOString(),
      salience: typeof data.salience === 'number' ? data.salience : 0.5,
      accesses: typeof data.accesses === 'number' ? data.accesses : 0,
      tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
      links: Array.isArray(data.links) ? (data.links as string[]) : [],
      summary: entrySummary(body),
      body,
    }
  }

  async updateEntry(id: string, patch: Partial<Omit<SpaceEntry, 'id'>>): Promise<SpaceEntry | null> {
    const entry = await this.readEntry(id)
    if (entry === null) return null
    const next: SpaceEntry = {
      ...entry,
      ...patch,
      id: entry.id,
      updated: new Date().toISOString(),
    }
    await this.writeEntry(next)
    this.index.markDirty()
    this.vcsRecord('l3', `update ${id}`)
    await this.upsertVector(entry.id, `${next.summary}\n${next.body}`)
    return next
  }

  /**
   * 删除或降权 L3 条目。
   * @param mode - delete 删除文件；demote 仅 salience 减半。
   */
  async removeEntry(id: string, mode: 'delete' | 'demote', reason = ''): Promise<boolean> {
    const path = safeJoin(this.dirs.spaces, `${id}.md`)
    if (mode === 'demote') {
      const entry = await this.readEntry(id)
      if (entry === null) return false
      await this.writeEntry({ ...entry, salience: entry.salience / 2, updated: new Date().toISOString() })
      this.index.markDirty()
      this.vcsRecord('l3', `demote ${id}`)
      await this.audit('demote', { targetId: id, reason })
      return true
    }
    try {
      await rm(path)
      this.index.markDirty()
      this.vcsRecord('l3', `forget ${id}`)
      await this.audit('forget', { targetId: id, mode, reason })
      await this.deleteVector(id)
      return true
    } catch {
      return false
    }
  }

  /** 双向建立链接；任一 id 不存在则抛业务错误（拒绝孤儿链接）。 */
  async linkEntries(a: string, b: string): Promise<{ a: SpaceEntry; b: SpaceEntry }> {
    const ea = await this.readEntry(a)
    const eb = await this.readEntry(b)
    if (ea === null || eb === null) {
      const missing = ea === null ? a : b
      throw new Error(`devmemory_link: 条目不存在 ${missing}`)
    }
    if (a === b) throw new Error('devmemory_link: 不能链接自身')
    const nextA: SpaceEntry = { ...ea, links: [...new Set([...ea.links, b])], updated: new Date().toISOString() }
    const nextB: SpaceEntry = { ...eb, links: [...new Set([...eb.links, a])], updated: new Date().toISOString() }
    await this.writeEntry(nextA)
    await this.writeEntry(nextB)
    this.index.markDirty()
    this.vcsRecord('l3', `link ${a} <-> ${b}`)
    void this.bumpCounter('linksTotal')
    return { a: nextA, b: nextB }
  }

  /** 命中提升 + 惰性 salience 衰减（距上次更新超过阈值天数 ×0.9，读取时应用）。 */
  async touchEntry(id: string): Promise<void> {
    const entry = await this.readEntry(id)
    if (entry === null) return
    let salience = entry.salience
    const days = (Date.now() - new Date(entry.updated).getTime()) / 86_400_000
    if (days > DEFAULT_SALIENCE_DECAY_DAYS) salience = salience * 0.9
    const next = {
      ...entry,
      salience: Math.min(1, salience + 0.1),
      accesses: entry.accesses + 1,
      updated: new Date().toISOString(),
    }
    await this.writeEntry(next)
    // v0.6.1：触碰只改元数据（salience/accesses），不进倒排正文 → 不落持久化脏标记
    this.index.markMetadataDirty()
    this.vcsRecord('l3', `touch ${id}`)
  }

  /** 列出 L3 全部条目（status 用）。 */
  async listEntries(): Promise<SpaceEntry[]> {
    const out: SpaceEntry[] = []
    let names: string[]
    try {
      names = await readdir(this.dirs.spaces)
    } catch {
      return out
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.md')) continue
      const id = name.slice(0, -3)
      const entry = await this.readEntry(id)
      if (entry !== null) out.push(entry)
    }
    return out
  }

  // ---------------------------------------------------------------- L1 runtime

  async appendRuntime(date: Date, line: string): Promise<void> {
    const fileName = runtimeFileName(date)
    const path = safeJoin(this.dirs.runtime, fileName)
    if (/^#\s+\d{4}-\d{2}-\d{2}/.test(line)) {
      // 首行文件头特殊处理：在 init 时写入
    }
    const lineToWrite = `${line}\n`
    try {
      await appendFile(path, lineToWrite, { mode: 0o600 })
    } catch {
      await mkdir(this.dirs.runtime, { recursive: true, mode: 0o700 })
      await writeFile(path, `# ${fileName.replace('.md', '')}\n\n${lineToWrite}`, { mode: 0o600 })
    }
    this.index.markDirty()
    this.vcsRecord('l1', `append ${fileName}`)
  }

  private async ensureRuntimeHeader(date: Date): Promise<string> {
    const fileName = runtimeFileName(date)
    const path = safeJoin(this.dirs.runtime, fileName)
    try {
      const raw = await readFile(path, 'utf8')
      return raw
    } catch {
      const header = `# ${fileName.replace('.md', '')}\n`
      await writeFile(path, header, { mode: 0o600 })
      return header
    }
  }

  /** 读某日流水原始文本；文件不存在返回空串。 */
  async readRuntime(date: Date): Promise<string> {
    const fileName = runtimeFileName(date)
    try {
      return await readFile(safeJoin(this.dirs.runtime, fileName), 'utf8')
    } catch {
      return ''
    }
  }

  /** 把流水压缩为摘要版（保留数据行 + digest 摘要段）。 */
  async compactRuntime(date: Date, digestSummary: string[]): Promise<void> {
    const fileName = runtimeFileName(date)
    const path = safeJoin(this.dirs.runtime, fileName)
    const raw = await this.readRuntime(date)
    const header = `# ${fileName.replace('.md', '')}\n`
    const body = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('- ') || line.startsWith('## '))
      .join('\n')
    const out = [header, body, '', '## digest 摘要', ...digestSummary.map((s) => `- ${s}`)].join('\n') + '\n'
    await writeFile(path, out, { mode: 0o600 })
    this.index.markDirty()
    this.vcsRecord('l1', `compact ${fileName}`)
  }

  // ---------------------------------------------------------------- L2 docs

  /**
   * 写/追加 L2 笔记。relPath 必须为相对路径（允许子目录），禁绝对路径与 `..`。
   */
  async note(input: { relPath: string; body: string; append?: boolean }): Promise<{ path: string; absolute: string }> {
    let relPath = input.relPath.replace(/\\/g, '/').replace(/^\/+/, '')
    if (relPath.includes(':') || relPath.startsWith('/')) {
      throw new Error('devmemory_note: relPath 必须为记忆库内相对路径')
    }
    const segments = relPath.split('/')
    if (segments.some((s) => s === '..' || s === '')) {
      throw new Error('devmemory_note: relPath 含非法片段（空或 ..）')
    }
    if (extname(relPath).toLowerCase() !== '.md') relPath = `${relPath}.md`
    const absolute = safeJoin(this.dirs.docs, relPath)
    if (input.append) {
      await appendFile(absolute, `${input.body.replace(/\s+$/, '')}\n\n`, { mode: 0o600 })
    } else {
      if (input.body.trim() === '') throw new Error('devmemory_note: body 不能为空')
      await mkdir(dirname(absolute), { recursive: true, mode: 0o700 })
      await writeFile(absolute, `${input.body.replace(/\s+$/, '')}\n`, { mode: 0o600 })
    }
    this.index.markDirty()
    this.vcsRecord('l2', `${input.append ? 'append' : 'note'} ${relPath}`)
    await this.upsertVectorForNote(relPath, absolute)
    void this.bumpCounter('notedTotal')
    return { path: relPath, absolute }
  }

  /** L2 笔记向量：写盘后读回正文（frontmatter 之外），docKey = l2:<rel>。 */
  private async upsertVectorForNote(relPath: string, absolute: string): Promise<void> {
    if (!this.embedding.enabled) return
    try {
      const raw = await readFile(absolute, 'utf8')
      const { body } = parseFrontmatter(raw)
      await this.upsertVector(`l2:${relPath}`, body)
    } catch {
      /* fail-open */
    }
  }

  private async listMarkdownFiles(dir: string, prefix: string, out: string[]): Promise<void> {
    let names: Dirent[] = []
    try {
      names = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const name of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const rel = join(prefix, name.name)
      if (name.isDirectory()) {
        await this.listMarkdownFiles(join(dir, name.name), rel, out)
      } else if (name.isFile() && name.name.endsWith('.md')) {
        out.push(rel)
      }
    }
  }

  // ---------------------------------------------------------------- recall

  /** 扫描三层文档（索引重建用）。 */
  private async scanDocs(): Promise<IndexedDoc[]> {
    const docs: IndexedDoc[] = []
    for (const entry of await this.listEntries()) {
      docs.push({
        docKey: entry.id,
        layer: 'l3',
        id: entry.id,
        text: `${entry.summary}\n${entry.body}`,
        tags: entry.tags,
        kind: entry.kind,
        salience: entry.salience,
        accesses: entry.accesses,
      })
    }
    const noteRels: string[] = []
    await this.listMarkdownFiles(this.dirs.docs, '', noteRels)
    for (const rel of noteRels) {
      try {
        const raw = await readFile(safeJoin(this.dirs.docs, rel), 'utf8')
        const { data, body } = parseFrontmatter(raw)
        docs.push({
          docKey: `l2:${rel}`,
          layer: 'l2',
          id: rel,
          text: body,
          tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
          kind: 'note',
          salience: 0.5,
          accesses: 0,
        })
      } catch {
        /* 跳过损坏笔记 */
      }
    }
    try {
      const runtimeNames = (await readdir(this.dirs.runtime)).filter((n) => n.endsWith('.md'))
      for (const name of runtimeNames.sort()) {
        const raw = await readFile(safeJoin(this.dirs.runtime, name), 'utf8')
        const rel = `l1:${name}`
        docs.push({
          docKey: rel,
          layer: 'l1',
          id: name,
          text: raw,
          tags: [],
          salience: 0.4,
          accesses: 0,
        })
      }
    } catch {
      /* 无流水层 */
    }
    return docs
  }

  /** 轻量文档计数（只列目录不读正文）：空召回自愈 / status 校验用。 */
  private async countDocsCheap(): Promise<number> {
    let n = 0
    try {
      n += (await readdir(this.dirs.spaces)).filter((x) => x.endsWith('.md')).length
    } catch {
      /* ignore */
    }
    try {
      const rels: string[] = []
      await this.listMarkdownFiles(this.dirs.docs, '', rels)
      n += rels.length
    } catch {
      /* ignore */
    }
    try {
      n += (await readdir(this.dirs.runtime)).filter((x) => x.endsWith('.md')).length
    } catch {
      /* ignore */
    }
    return n
  }

  /**
   * 跨层回忆查询（统一读入口）。
   * 命中 L3 条目时默认提升 accesses/salience（touch）。
   */
  async recall(query: string, options: RecallOptions = {}): Promise<RecallResult> {
    const maxResults = options.maxResults ?? this.config.recall.defaultLimit
    const layers = options.layers ?? ['l1', 'l2', 'l3']
    let index = await this.index.get(() => this.scanDocs())
    let result = searchIndex(index, query, maxResults, layers)
    // v0.6.1 空召回自愈：三层全空且库内实际文档数多于快照 → 快照陈旧（如脏标记落盘失败），
    // 强制重建一次并重试；若自愈后有命中则记一条诊断，让此类故障可见。
    if (result.l1.length === 0 && result.l2.length === 0 && result.l3.length === 0) {
      const actual = await this.countDocsCheap()
      const snapshot = index.docCount
      if (actual > snapshot) {
        index = await this.index.rebuild(() => this.scanDocs())
        result = searchIndex(index, query, maxResults, layers)
        if (result.l1.length > 0 || result.l2.length > 0 || result.l3.length > 0) {
          void this.diag
            .record({
              level: 'unexpected',
              origin: 'index',
              message: `索引快照陈旧：快照 ${snapshot} 篇 vs 库内 ${actual} 篇，空召回已自动重建恢复`,
            })
            .catch(() => undefined)
        }
      }
    }
    if (this.embedding.enabled) {
      result = await this.fuseVectors(query, result, maxResults, layers)
    }
    if (options.touch !== false) {
      for (const hit of result.l3) {
        try {
          await this.touchEntry(hit.id)
        } catch {
          /* 命中提升失败不影响查询结果 */
        }
      }
    }
    // 补 summary 文本（searchIndex 只给 id）
    for (const layer of ['l1', 'l2', 'l3'] as const) {
      for (const hit of result[layer]) {
        hit.summary = await this.summaryFor(layer, hit.id).catch(() => hit.summary)
      }
    }
    return result
  }

  /**
   * 向量融合（v0.2）：BM25 命中按归一化比例与余弦相似度融合排序；
   * 向量文件数在规模保护内时，补充"无词面命中但语义相近"的文档（纯余弦分）。
   * 全程 fail-open：embedding 失败原样返回 BM25 结果。
   */
  private async fuseVectors(query: string, result: RecallResult, maxPerLayer: number, layers: LayerId[]): Promise<RecallResult> {
    try {
      const qvec = await this.embedding.embed(query)
      if (qvec === null) return result
      const vectorCount = await this.embedding.countVectors(this.root)
      const supplement = vectorCount <= VECTOR_SCAN_CAP
      const out: RecallResult = { l1: [...result.l1], l2: [...result.l2], l3: [...result.l3] }
      for (const layer of ['l1', 'l2', 'l3'] as const) {
        if (!layers.includes(layer)) continue
        const hits = out[layer]
        const maxScore = hits.length > 0 ? Math.max(1e-9, ...hits.map((h) => h.score)) : 1
        for (const hit of hits) {
          const vec = await this.embedding.loadVector(this.root, hit.docKey)
          const cos = vec === null ? null : cosineSimilarity(qvec, vec)
          hit.score = fuseScore(cos, hit.score / maxScore)
        }
        hits.sort((a, b) => b.score - a.score)
        if (!supplement) {
          out[layer] = hits.slice(0, maxPerLayer)
          continue
        }
        // 语义补漏：有向量但未被 BM25 命中的文档（纯余弦分 = 0.6 × cos）
        const supplements: RecallHit[] = []
        let names: string[] = []
        try {
          names = await readdir(safeJoin(this.root, 'vectors'))
        } catch {
          /* 无向量目录 */
        }
        for (const name of names) {
          if (!name.endsWith('.json')) continue
          try {
            const raw = await readFile(safeJoin(this.root, 'vectors', name), 'utf8')
            const parsed = JSON.parse(raw) as { docKey?: string; vec?: number[] }
            const docKey = parsed.docKey
            if (docKey === undefined || !Array.isArray(parsed.vec)) continue
            const layerOfKey = docKey.startsWith('l2:') ? 'l2' : docKey.startsWith('l1:') ? 'l1' : 'l3'
            if (layerOfKey !== layer || out[layer].some((h) => h.docKey === docKey)) continue
            const cos = cosineSimilarity(qvec, parsed.vec)
            if (cos <= 0) continue
            supplements.push({
              docKey,
              layer,
              id: layerOfKey === 'l3' ? docKey : docKey.slice(layerOfKey.length + 1),
              score: fuseScore(cos, 0),
              summary: docKey,
            })
          } catch {
            /* 跳过损坏向量文件 */
          }
        }
        if (supplements.length > 0) {
          out[layer] = [...out[layer], ...supplements].sort((a, b) => b.score - a.score).slice(0, maxPerLayer)
        }
      }
      return out
    } catch {
      return result
    }
  }

  private async summaryFor(layer: LayerId, id: string): Promise<string> {
    if (layer === 'l3') {
      const entry = await this.readEntry(id)
      return entry === null ? id : `${entry.summary}${entry.tags.length > 0 ? `  [${entry.tags.join(', ')}]` : ''}`
    }
    if (layer === 'l2') {
      try {
        const raw = await readFile(safeJoin(this.dirs.docs, id), 'utf8')
        const { data, body } = parseFrontmatter(raw)
        return `${entrySummary(body)}  [note]`
      } catch {
        return id
      }
    }
    if (layer === 'l1') {
      try {
        const raw = await readFile(safeJoin(this.dirs.runtime, id), 'utf8')
        const titles = raw.split(/\r?\n/).filter((l) => l.startsWith('## ')).slice(0, 3).join(' | ')
        return `${id}: ${titles || '流水'}`
      } catch {
        return id
      }
    }
    return id
  }

  /** 强制重建索引（status/consolidate 可用）。 */
  async rebuildIndex(): Promise<void> {
    await this.index.rebuild(() => this.scanDocs())
  }

  // ---------------------------------------------------------------- status

  private async embeddingStatus(): Promise<EmbeddingStatus> {
    const enabled = this.embedding.enabled
    // v0.4：Ollama 确认不可用（探测/调用已失败）时记一条"降级"诊断（每进程一次）
    if (enabled && !this.embedding.isReady && this.embedding.error !== null && !this.embeddingWarned) {
      this.embeddingWarned = true
      void this.diag
        .record({
          level: 'unexpected',
          origin: 'embed',
          message: `向量检索不可用（Ollama ${this.embedding.endpoint} 未响应: ${this.embedding.error}），已降级 BM25`,
        })
        .catch(() => undefined)
    }
    return {
      enabled,
      ready: enabled && this.embedding.isReady,
      degraded: enabled && !this.embedding.isReady,
      model: this.embedding.model,
      endpoint: this.embedding.endpoint,
      vectorCount: enabled ? await this.embedding.countVectors(this.root) : 0,
      lastError: enabled ? this.embedding.error : null,
    }
  }

  async status(): Promise<StoreStatusSnapshot> {
    let l1 = 0
    let l2 = 0
    let l3 = 0
    try {
      l1 = (await readdir(this.dirs.runtime)).filter((n) => n.endsWith('.md')).length
    } catch {
      /* ignore */
    }
    try {
      const rels: string[] = []
      await this.listMarkdownFiles(this.dirs.docs, '', rels)
      l2 = rels.length
    } catch {
      /* ignore */
    }
    try {
      l3 = (await readdir(this.dirs.spaces)).filter((n) => n.endsWith('.md')).length
    } catch {
      /* ignore */
    }
    const snap = await this.index.snapshotDocCount()
    return {
      ready: true,
      root: this.root,
      scope: this.config.scope,
      counts: { l1, l2, l3 },
      lastDigestAt: this.digestState.lastRunAt,
      indexDirty: this.index.dirtyCount,
      indexDocCount: snap,
      indexStale: snap === null ? l1 + l2 + l3 > 0 : snap !== l1 + l2 + l3,
      firstRun: l3 === 0 && l2 === 0 && l1 === 0,
      vcs: await this.vcs.status(),
      embedding: await this.embeddingStatus(),
      diag: await this.diag.counters(),
    }
  }
}