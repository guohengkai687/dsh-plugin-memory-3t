/**
 * BM25 检索：倒排索引构建（惰性）、查询评分与元数据加成。
 *
 * 分词：英文/数字按词提取小写；连续中文按 2-gram 滑窗（无外部 NLP 依赖）。
 * 索引为持久化快照（index.json），写入操作只做脏标记，超阈值或显式触发才重建。
 *
 * v0.6.1 修复（索引长期陈旧的根因）：
 * 1. 索引键改为 docKey（原先误用 id，docKey 字段被 buildIndex 丢弃）：
 *    RecallHit.docKey 从此与向量文件键（l2:<rel>/l1:<name>/L3 裸 id）一致，
 *    修复 embedding 融合路径 loadVector 按 docKey 命中与补漏去重。
 * 2. 脏标记持久化为 index.json.dirty（跨进程可见）：
 *    原 get() 的两个脏分支覆盖全部 dirtyWrites>0 状态，使 rebuildAfterWrites
 *    阈值永不触发；且 loadFromDisk 会把脏计数清零，导致快照永久陈旧、召回恒为空。
 * 3. schemaVersion 提升到 2：旧快照一律判废重建（覆盖历史遗留的 1 文档快照）。
 * 4. markDirty() 只用于结构化变更（新增/修改/删除正文，写入持久化标记）；
 *    markMetadataDirty() 仅做进程内计数（salience/accesses 触碰不使快照失效）。
 */

import { mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type LayerId = 'l1' | 'l2' | 'l3'

export interface IndexedDoc {
  /** 唯一键：l1:<date> / l2:<relPath> / l3:<entryId> */
  docKey: string
  layer: LayerId
  id: string
  text: string
  tags: string[]
  kind?: string
  salience: number
  accesses: number
}

export interface IndexEntry {
  docKey: string
  layer: LayerId
  id: string
  tags: string[]
  kind?: string
  salience: number
  accesses: number
  len: number
  text: string
  /** term -> tf */
  tf: Record<string, number>
}

export interface IndexFile {
  schemaVersion: number
  builtAt: string
  docCount: number
  avgDocLen: number
  /** docKey -> 元数据（重建时从文件读回，启用作快照） */
  docs: Record<string, Omit<IndexEntry, 'tf' | 'text'>>
  /** term -> { docKey: tf } */
  postings: Record<string, Record<string, number>>
}

/** v0.6.1：升到 2——索引键从 id 改为 docKey，旧快照判废。 */
export const INDEX_SCHEMA_VERSION = 2

const EN_WORD = /[A-Za-z0-9_]+/g
const CJK_CHAR = /[\u4e00-\u9fff]/g

/**
 * 分词：英文单词（小写）+ 中文 2-gram 并集。
 * 例："记忆插件" → ["记忆","忆插","插件"]；"dsh plugin" → ["dsh","plugin"]。
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(EN_WORD)) out.push((match[0] ?? '').toLowerCase())
  const cjk: string[] = []
  for (const match of text.matchAll(CJK_CHAR)) cjk.push(match[0] ?? '')
  for (let i = 0; i < cjk.length - 1; i++) out.push((cjk[i] ?? '') + (cjk[i + 1] ?? ''))
  return out
}

function countTerms(tokens: string[]): Record<string, number> {
  const tf: Record<string, number> = {}
  for (const token of tokens) tf[token] = (tf[token] ?? 0) + 1
  return tf
}

/**
 * 从扫描到的文档构建完整索引（全量重建）。
 * 输入文档需自带评分元数据（salience/accesses/kind/tags），来自 store 的三层文件。
 * 注意：倒排以 docKey 为键（v0.6.1 修复，此前误用 id，向量融合因此对不上号）。
 */
export function buildIndex(docs: IndexedDoc[]): IndexFile {
  const entries: IndexEntry[] = docs.map((doc) => {
    const tokens = tokenize(doc.text)
    return {
      docKey: doc.docKey,
      layer: doc.layer,
      id: doc.id,
      tags: doc.tags,
      kind: doc.kind,
      salience: doc.salience,
      accesses: doc.accesses,
      len: Math.max(1, tokens.length),
      text: doc.text,
      tf: countTerms(tokens),
    }
  })
  const docCount = entries.length
  const avgDocLen = docCount === 0 ? 1 : entries.reduce((sum, e) => sum + e.len, 0) / docCount
  const metaById: IndexFile['docs'] = {}
  const postings: IndexFile['postings'] = {}
  for (const entry of entries) {
    metaById[entry.docKey] = {
      docKey: entry.docKey,
      layer: entry.layer,
      id: entry.id,
      tags: entry.tags,
      kind: entry.kind,
      salience: entry.salience,
      accesses: entry.accesses,
      len: entry.len,
    }
    for (const [term, tf] of Object.entries(entry.tf)) {
      const bucket = (postings[term] ??= {})
      bucket[entry.docKey] = tf
    }
  }
  return { schemaVersion: INDEX_SCHEMA_VERSION, builtAt: new Date().toISOString(), docCount, avgDocLen, docs: metaById, postings }
}

/** BM25 单查询评分（k1=1.2, b=0.75）。 */
export function bm25Score(
  queryTokens: string[],
  doc: { len: number; tf: Record<string, number> },
  idf: (term: string) => number,
  avgDocLen: number,
  k1 = 1.2,
  b = 0.75,
): number {
  let score = 0
  for (const token of queryTokens) {
    const tf = doc.tf[token] ?? 0
    if (tf === 0) continue
    const termIdf = idf(token)
    if (!Number.isFinite(termIdf) || termIdf <= 0) continue
    score += (termIdf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * doc.len) / avgDocLen))
  }
  return score
}

const KIND_WEIGHT: Record<string, number> = {
  preference: 1.1,
  decision: 1.05,
  entity: 1.0,
  context: 0.95,
  note: 1.0,
}

/**
 * 元数据加成：BM25 分数 × salience 加成 × access 加成 × kind 权重 × tag 命中加成。
 * @param queryTokens - 查询分词。
 * @param queryTags - 查询中与条目 tags 精确匹配的词（由调用方从 query 文本提取 token 集合后传入）。
 */
export function scored(
  bm25: number,
  entry: { salience: number; accesses: number; kind?: string; tags: string[] },
  queryTokens: string[],
): number {
  const salienceBoost = 0.6 + 0.4 * entry.salience
  const accessBoost = 1 + 0.25 * Math.log2(1 + entry.accesses)
  const kindBoost = entry.kind !== undefined ? (KIND_WEIGHT[entry.kind] ?? 1.0) : 1.0
  const tagHit = queryTokens.some((t) => entry.tags.includes(t)) ? 1.3 : 1.0
  return bm25 * salienceBoost * accessBoost * kindBoost * tagHit
}

export interface RecallHit {
  docKey: string
  layer: LayerId
  id: string
  score: number
  summary: string
}

export interface RecallResult {
  l1: RecallHit[]
  l2: RecallHit[]
  l3: RecallHit[]
}

/**
 * 对索引执行一次回忆查询：按层分组、每层分数降序截断。
 * @param index - 索引快照。
 * @param query - 查询文本。
 * @param maxPerLayer - 每层最多返回条数（默认 10）。
 * @param includeLayers - 参与检索的层（默认全部）。
 */
export function searchIndex(
  index: IndexFile,
  query: string,
  maxPerLayer = 10,
  includeLayers: LayerId[] = ['l1', 'l2', 'l3'],
): RecallResult {
  const queryTokens = [...new Set(tokenize(query))]
  const docCount = Math.max(1, index.docCount)
  const idf = (term: string): number => {
    const n = index.postings[term] === undefined ? 0 : Object.keys(index.postings[term]!).length
    return n === 0 ? 0 : Math.log(1 + (docCount - n + 0.5) / (n + 0.5))
  }
  const hits: RecallHit[] = []
  const docs = index.docs
  for (const [docKey, meta] of Object.entries(docs)) {
    // 取该文档在各查询词倒排桶中的 tf（无桶 → 未命中）
    const ownTf: Record<string, number> = {}
    for (const token of queryTokens) {
      const bucket = index.postings[token]
      if (bucket !== undefined && bucket[docKey] !== undefined) ownTf[token] = bucket[docKey]!
    }
    const raw = bm25Score(queryTokens, { len: meta.len, tf: ownTf }, idf, index.avgDocLen)
    if (raw <= 0) continue
    const layer = meta.layer
    if (!includeLayers.includes(layer)) continue
    const final = scored(raw, { salience: meta.salience, accesses: meta.accesses, kind: meta.kind, tags: meta.tags }, queryTokens)
    hits.push({ docKey, layer, id: meta.id, score: final, summary: meta.id })
  }
  hits.sort((a, b) => b.score - a.score)
  const result: RecallResult = { l1: [], l2: [], l3: [] }
  for (const hit of hits) {
    if (result[layerOf(hit.layer)].length < maxPerLayer) result[layerOf(hit.layer)].push(hit)
  }
  return result
}

function layerOf(layer: LayerId): LayerId {
  return layer
}

/** 重建原因（诊断/测试用）。 */
export type IndexRebuildReason = 'missing' | 'dirty-marker' | 'threshold' | 'force'

/**
 * 惰性索引管理器：内存缓存 + 脏计数 + 持久化 index.json。
 *
 * v0.6.1 脏标记语义：
 * - 结构化写入（markDirty）会同步落盘 index.json.dirty 标记 → 跨进程可见，
 *   任何进程下一次 get() 都会重建，杜绝"快照看似干净实则陈旧"。
 * - 仅元数据触碰（markMetadataDirty，如 recall 命中提升 salience/accesses）
 *   只加进程内计数，不落标记——否则每次 recall 命中都会触发全量重建。
 * - 内存计数达到 rebuildAfterWrites 阈值同样触发重建（修复原逻辑中被第二个
 *   脏分支短路、阈值永不生效的问题）。
 */
export class IndexManager {
  private index: IndexFile | null = null
  private dirtyWrites = 0
  private persistedDirty = false
  private lastRebuildReason: IndexRebuildReason | null = null
  private readonly dirtyPath: string

  constructor(
    private readonly indexPath: string,
    private readonly rebuildAfterWrites: number,
  ) {
    this.dirtyPath = `${indexPath}.dirty`
  }

  private async loadFromDisk(): Promise<IndexFile | null> {
    try {
      const raw = await readFile(this.indexPath, 'utf8')
      const parsed = JSON.parse(raw) as IndexFile
      if (parsed.schemaVersion !== INDEX_SCHEMA_VERSION || typeof parsed.docCount !== 'number') return null
      if (parsed.docs === undefined || parsed.postings === undefined) return null
      return parsed
    } catch {
      return null
    }
  }

  /** 是否存在持久化脏标记（跨进程）。进程内已确认过则直接命中缓存。 */
  private async hasDirtyMarker(): Promise<boolean> {
    if (this.persistedDirty) return true
    try {
      await access(this.dirtyPath)
      this.persistedDirty = true
      return true
    } catch {
      return false
    }
  }

  /** 落盘脏标记（同步、fail-open）：保证结构性写入对其它进程可见。 */
  private writeDirtyMarker(): void {
    if (this.persistedDirty) return
    try {
      writeFileSync(this.dirtyPath, new Date().toISOString(), { mode: 0o600 })
      this.persistedDirty = true
    } catch {
      /* 落盘失败（如只读目录）→ 进程内计数兜底，不阻塞写入 */
    }
  }

  private async clearDirtyMarker(): Promise<void> {
    this.persistedDirty = false
    try {
      await rm(this.dirtyPath, { force: true })
    } catch {
      /* fail-open */
    }
  }

  /**
   * 取索引；按需重建（脏标记存在 / 脏写入超阈值 / 快照缺失或不符版本 / force）。
   * @param scan - 重建时扫描三层文档的回调（由 store 提供）。
   */
  async get(scan: () => Promise<IndexedDoc[]>, force = false): Promise<IndexFile> {
    if (force) return this.rebuild(scan, 'force')
    // 跨进程脏标记 → 上次结构化写入后未重建，快照已陈旧
    if (await this.hasDirtyMarker()) return this.rebuild(scan, 'dirty-marker')
    if (this.index !== null) {
      if (this.dirtyWrites < this.rebuildAfterWrites) return this.index
      // 同进程脏写入超阈值 → 重建（v0.6.1：此前被第二个脏分支短路，阈值永不生效）
      return this.rebuild(scan, 'threshold')
    }
    const loaded = await this.loadFromDisk()
    if (loaded !== null) {
      this.index = loaded
      this.dirtyWrites = 0
      return loaded
    }
    return this.rebuild(scan, 'missing')
  }

  /** 全量重建并写盘；扫描期间若发生新写入则保留脏标记待下次重建。 */
  async rebuild(scan: () => Promise<IndexedDoc[]>, reason: IndexRebuildReason = 'missing'): Promise<IndexFile> {
    const writesBefore = this.dirtyWrites
    const docs = await scan()
    const index = buildIndex(docs)
    this.index = index
    this.lastRebuildReason = reason
    // 只在与扫描起点一致时清脏；扫描期间有新写入 → 快照落后，保留标记
    if (this.dirtyWrites === writesBefore) {
      this.dirtyWrites = 0
      await this.clearDirtyMarker()
    } else {
      this.writeDirtyMarker()
    }
    await mkdir(dirname(this.indexPath), { recursive: true, mode: 0o700 })
    await writeFile(this.indexPath, JSON.stringify(index), { mode: 0o600 })
    return index
  }

  /** 结构化变更（新增/修改/删除正文）→ 落持久化脏标记，跨进程失效。 */
  markDirty(): void {
    this.dirtyWrites += 1
    this.writeDirtyMarker()
  }

  /** 仅元数据变更（salience/accesses 触碰）→ 只做进程内计数，不使快照失效。 */
  markMetadataDirty(): void {
    this.dirtyWrites += 1
  }

  get dirtyCount(): number {
    return this.dirtyWrites
  }

  get rebuildReason(): IndexRebuildReason | null {
    return this.lastRebuildReason
  }

  /** 当前生效快照的文档数（未加载过则读磁盘；错误/缺失返回 null）。 */
  async snapshotDocCount(): Promise<number | null> {
    if (this.index !== null) return this.index.docCount
    const loaded = await this.loadFromDisk()
    return loaded === null ? null : loaded.docCount
  }
}