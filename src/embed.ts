/**
 * EmbeddingClient：Ollama 本地向量嵌入（v0.2 剩余项一）。
 *
 * 设计（对齐 DESIGN §7.2）：
 * - 零运行时依赖：用 Node 全局 fetch 调 Ollama HTTP API（/api/embeddings 旧式、
 *   /api/embed 新式自动探测），endpoint/model 可配。
 * - 纯增强不是主路径：任何失败（超时 / 非 2xx / 解析失败）返回 null，
 *   调用方走 fail-open 降级回 BM25，绝不打断会话。
 * - 向量存 `<库>/vectors/<base64url(docKey)>.json`（派生物，由库内 .gitignore 忽略）。
 * - fetch 实现可注入（测试用 mock；默认 globalThis.fetch）。
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'

import { safeJoin } from './paths.js'

export interface EmbeddingStatus {
  enabled: boolean
  ready: boolean
  degraded: boolean
  model: string
  endpoint: string
  /** 当前向量文件数（仅 enabled 时有意义）。 */
  vectorCount: number
  lastError: string | null
}

/** recall 融合权重：0.6 × 余弦相似度 + 0.4 × 归一化 BM25。 */
export const VECTOR_FUSION_WEIGHT = 0.6

export interface VectorFile {
  docKey: string
  model: string
  dim: number
  vec: number[]
}

/** docKey（含 `:` `/` 等不便做文件名的字符）→ 安全文件名（base64url）。 */
export function encodeDocKey(docKey: string): string {
  return Buffer.from(docKey, 'utf8').toString('base64url')
}

export function decodeDocKey(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf8')
}

/** 余弦相似度；任一向量为空返回 0。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 融合分：有向量 → weight 余弦 + (1-weight) 归一化 BM25；无向量 → 0.4 归一化 BM25（不劣于纯降级）。 */
export function fuseScore(cosine: number | null, bm25Norm: number): number {
  if (cosine === null) return bm25Norm
  return VECTOR_FUSION_WEIGHT * cosine + (1 - VECTOR_FUSION_WEIGHT) * bm25Norm
}

interface EmbedResponse {
  embedding?: number[]
  embeddings?: number[][]
}

export class EmbeddingClient {
  /** 可注入 fetch（测试 mock；默认 globalThis.fetch）。 */
  fetchImpl: typeof fetch

  private ready = false
  private lastError: string | null = null

  constructor(
    private readonly cfg: { enabled: boolean; endpoint: string; model: string; timeoutMs: number },
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch
  }

  get enabled(): boolean {
    return this.cfg.enabled
  }

  get isReady(): boolean {
    return this.ready
  }

  get isDegraded(): boolean {
    return this.cfg.enabled && !this.ready
  }

  get error(): string | null {
    return this.lastError
  }

  get model(): string {
    return this.cfg.model
  }

  get endpoint(): string {
    return this.cfg.endpoint
  }

  /** 探测 Ollama 服务（失败只标记 lastError，返回 false，不抛错；禁用时短路不触碰网络）。 */
  async ping(): Promise<boolean> {
    if (!this.cfg.enabled) return false
    try {
      const res = await this.fetchImpl(`${this.cfg.endpoint}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(Math.min(this.cfg.timeoutMs, 1500)),
      })
      const ok = res.ok
      this.ready = ok
      if (!ok) this.lastError = `Ollama 探测失败: HTTP ${res.status}`
      return ok
    } catch (error) {
      this.ready = false
      this.lastError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  /**
   * 生成文本向量。任何失败（超时/非 2xx/解析失败）返回 null（fail-open）。
   * 版本兼容：先试旧式 /api/embeddings（{embedding}），404 时回退新式 /api/embed（{embeddings:[...]}）。
   */
  async embed(text: string): Promise<number[] | null> {
    if (!this.cfg.enabled) return null
    const body = { model: this.cfg.model, prompt: text }
    try {
      let res = await this.fetchImpl(`${this.cfg.endpoint}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      })
      if (res.status === 404) {
        res = await this.fetchImpl(`${this.cfg.endpoint}/api/embed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.cfg.model, input: text }),
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        })
      }
      if (!res.ok) {
        this.lastError = `Ollama embedding HTTP ${res.status}`
        return null
      }
      const parsed = (await res.json()) as EmbedResponse
      const vec = parsed.embedding ?? parsed.embeddings?.[0] ?? null
      if (vec === null || !Array.isArray(vec) || vec.length === 0 || !vec.every((n) => typeof n === 'number')) {
        this.lastError = 'Ollama embedding 响应缺少向量'
        return null
      }
      this.ready = true
      this.lastError = null
      return vec
    } catch (error) {
      this.ready = false
      this.lastError = error instanceof Error ? error.message : String(error)
      return null
    }
  }

  // ---------------------------------------------------------------- 向量文件（<库>/vectors/）

  private vectorPath(root: string, docKey: string): string {
    return safeJoin(root, 'vectors', `${encodeDocKey(docKey)}.json`)
  }

  async saveVector(root: string, docKey: string, vec: number[]): Promise<void> {
    const path = this.vectorPath(root, docKey)
    await mkdir(safeJoin(root, 'vectors'), { recursive: true, mode: 0o700 })
    const file: VectorFile = { docKey, model: this.cfg.model, dim: vec.length, vec }
    await writeFile(path, JSON.stringify(file), { mode: 0o600 })
  }

  async loadVector(root: string, docKey: string): Promise<number[] | null> {
    try {
      const raw = await readFile(this.vectorPath(root, docKey), 'utf8')
      const parsed = JSON.parse(raw) as VectorFile
      if (!Array.isArray(parsed.vec) || parsed.vec.length === 0 || !parsed.vec.every((n) => typeof n === 'number')) return null
      return parsed.vec
    } catch {
      return null
    }
  }

  async deleteVector(root: string, docKey: string): Promise<void> {
    try {
      await rm(this.vectorPath(root, docKey), { force: true })
    } catch {
      /* 派生物清理失败不影响业务 */
    }
  }

  async countVectors(root: string): Promise<number> {
    try {
      return (await readdir(safeJoin(root, 'vectors'))).filter((n) => n.endsWith('.json')).length
    } catch {
      return 0
    }
  }
}