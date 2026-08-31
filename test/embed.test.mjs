/**
 * v0.2 embedding 测试。
 *
 * - 纯逻辑：余弦相似度 / 融合分 / docKey 编码往返。
 * - 客户端：可注入 fetch mock —— 旧式 /api/embeddings、新式 /api/embed 回退、
 *   网络失败 fail-open、禁用时短路。
 * - 集成：MemStore（vcs 关）开启 embedding 后写路径生成向量文件、recall 融合排名、
 *   语义补漏、Ollama 不可用自动降级回 BM25。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from '../dist/config.js'
import { EmbeddingClient, cosineSimilarity, decodeDocKey, encodeDocKey, fuseScore } from '../dist/embed.js'
import { MemoryStore } from '../dist/store.js'

/** Ollama API 的极简 Response 形状（客户端只用 ok/status/json）。 */
function resp(ok, status, json) {
  return { ok, status, json: async () => json }
}

/**
 * 可控假 fetch：按文本标记返回方向向量。
 * - 含 '量子' / 'C品' / 精确 '语义查询' → [0,1,0]
 * - 含 'TypeScript' → [0,0,1]
 * - 其他 → [0.5,0.5,0]
 */
function makeFakeFetch({ dead = false, api404 = false } = {}) {
  const vecFor = (text) => {
    if (text === '语义查询') return [0, 1, 0]
    if (text.includes('语义')) return [0, 1, 0]
    if (text.includes('量子') || text.includes('C品')) return [0, 1, 0]
    if (text.includes('TypeScript')) return [0, 0, 1]
    return [0.5, 0.5, 0]
  }
  let embedFallback = false
  return async (url, opts = {}) => {
    if (dead) throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
    const urlStr = String(url)
    if (urlStr.endsWith('/api/tags')) return resp(true, 200, {})
    if (urlStr.endsWith('/api/embeddings') && api404 && !embedFallback) {
      embedFallback = true
      return resp(false, 404, {})
    }
    const body = JSON.parse(opts.body ?? '{}')
    const text = body.prompt ?? (Array.isArray(body.input) ? String(body.input[0] ?? '') : String(body.input ?? ''))
    const vec = vecFor(text)
    if (urlStr.endsWith('/api/embed')) return resp(true, 200, { embeddings: [vec] })
    return resp(true, 200, { embedding: vec })
  }
}

async function makeStore(embedding) {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-embed-'))
  const config = {
    ...DEFAULT_CONFIG,
    vcs: { ...DEFAULT_CONFIG.vcs, enabled: false },
    embedding: { ...DEFAULT_CONFIG.embedding, ...embedding },
  }
  const store = new MemoryStore(ws, config)
  return { ws, store }
}

// ---------------------------------------------------------------- 纯逻辑

test('embed.cosineSimilarity: 方向与标量', () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1)
  assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0)
  assert.equal(cosineSimilarity([2, 0, 0], [1, 0, 0]), 1)
  assert.equal(cosineSimilarity([], [1]), 0)
  assert.equal(cosineSimilarity([1, 0], [1]), 0)
})

test('embed.fuseScore: 融合权重与无向量降级', () => {
  assert.equal(fuseScore(0.8, 0.2), 0.6 * 0.8 + 0.4 * 0.2)
  assert.equal(fuseScore(null, 0.35), 0.35)
  assert.equal(fuseScore(1, 0), 0.6)
})

test('embed.docKey 编码往返（含 : / 等不便字符）', () => {
  for (const key of ['l2:notes/x.md', 'l3:pref-20260828-abc', 'l1:2026-08-28.md']) {
    assert.equal(decodeDocKey(encodeDocKey(key)), key)
  }
  assert.ok(!encodeDocKey('l2:notes/x.md').includes('/'))
  assert.ok(!encodeDocKey('l2:notes/x.md').includes(':'))
})

// ---------------------------------------------------------------- 客户端

test('embed.client: 旧式 API 成功 → ready', async () => {
  const client = new EmbeddingClient(
    { enabled: true, endpoint: 'http://x', model: 'nomic-embed-text', timeoutMs: 100 },
    makeFakeFetch(),
  )
  const vec = await client.embed('量子计算')
  assert.deepEqual(vec, [0, 1, 0])
  assert.equal(client.isReady, true)
  assert.equal(client.error, null)
})

test('embed.client: 404 自动回退新式 /api/embed', async () => {
  const client = new EmbeddingClient(
    { enabled: true, endpoint: 'http://x', model: 'm', timeoutMs: 100 },
    makeFakeFetch({ api404: true }),
  )
  const vec = await client.embed('C品说明')
  assert.deepEqual(vec, [0, 1, 0])
  assert.equal(client.isReady, true)
})

test('embed.client: 网络失败 fail-open（null + 降级标记）', async () => {
  const client = new EmbeddingClient(
    { enabled: true, endpoint: 'http://x', model: 'm', timeoutMs: 100 },
    makeFakeFetch({ dead: true }),
  )
  assert.equal(await client.embed('任意'), null)
  assert.equal(client.isReady, false)
  assert.equal(client.isDegraded, true)
  assert.ok(client.error !== null)
})

test('embed.client: 禁用时短路且不触碰 fetch', async () => {
  let called = 0
  const client = new EmbeddingClient(
    { enabled: false, endpoint: 'http://x', model: 'm', timeoutMs: 100 },
    async () => {
      called += 1
      return resp(true, 200, {})
    },
  )
  assert.equal(await client.embed('任意'), null)
  assert.equal(called, 0)
  assert.equal(await client.ping(), false)
  assert.equal(called, 0)
})

test('embed.client: 向量文件存取删除往返', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-embed-file-'))
  try {
    const client = new EmbeddingClient(
      { enabled: true, endpoint: 'http://x', model: 'm', timeoutMs: 100 },
      makeFakeFetch(),
    )
    await client.saveVector(ws, 'l3:pref-abc', [1, 2, 3])
    assert.deepEqual(await client.loadVector(ws, 'l3:pref-abc'), [1, 2, 3])
    assert.equal(await client.countVectors(ws), 1)
    await client.deleteVector(ws, 'l3:pref-abc')
    assert.equal(await client.loadVector(ws, 'l3:pref-abc'), null)
    assert.equal(await client.countVectors(ws), 0)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 集成（vcs 关）

test('embed.store: 开启后 L2/L3 写路径生成向量文件', async () => {
  const { ws, store } = await makeStore({ enabled: true })
  try {
    store.embedding.fetchImpl = makeFakeFetch()
    await store.init()
    const a = await store.remember({ kind: 'entity', content: 'alpha 项目用 TypeScript', tags: ['项目'] })
    await store.note({ relPath: 'notes/q.md', body: '量子计算是研究前沿' })
    assert.equal(await store.embedding.countVectors(store.root), 2)
    assert.deepEqual(await store.embedding.loadVector(store.root, a.id), [0, 0, 1])
    assert.deepEqual(await store.embedding.loadVector(store.root, 'l2:notes/q.md'), [0, 1, 0])
    const names = await readdir(join(store.root, 'vectors'))
    assert.ok(names.length === 2)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('embed.store: recall 向量融合重排（C 词面相同但语义更近 → 升到首位）', async () => {
  const { ws, store } = await makeStore({ enabled: true })
  try {
    store.embedding.fetchImpl = makeFakeFetch()
    await store.init()
    await store.remember({ kind: 'entity', content: 'alpha 项目用 TypeScript', tags: [] }) // vec [0,0,1]
    const c = await store.remember({ kind: 'entity', content: 'alpha C品 长尾说明', tags: [] }) // vec [0,1,0]
    const result = await store.recall('alpha', { touch: false })
    assert.ok(result.l3.length >= 2)
    // C 融合分 ≥ 0.6；A 融合分 = 0.4 × 归一化 BM25 < 0.6 → C 居首
    assert.equal(result.l3[0].id, c.id)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('embed.store: 语义补漏——无词面命中但向量相近也能召回', async () => {
  const { ws, store } = await makeStore({ enabled: true })
  try {
    store.embedding.fetchImpl = makeFakeFetch()
    await store.init()
    await store.remember({ kind: 'entity', content: 'alpha 项目用 TypeScript', tags: [] })
    await store.note({ relPath: 'notes/q.md', body: '量子计算是研究前沿' }) // vec [0,1,0]，与查询同向
    const result = await store.recall('语义查询', { touch: false }) // 词面无重叠
    assert.ok(result.l1.length === 0)
    assert.ok(result.l2.length >= 1, '应通过向量补漏召回 L2 笔记')
    assert.ok(result.l2[0].id.includes('notes/q.md'))
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('embed.store: Ollama 不可用 → 写不受阻、recall 降级 BM25、status 标注', async () => {
  const { ws, store } = await makeStore({ enabled: true })
  try {
    store.embedding.fetchImpl = makeFakeFetch({ dead: true })
    await store.init()
    const a = await store.remember({ kind: 'entity', content: 'alpha 项目用 TypeScript', tags: [] })
    assert.equal(await store.embedding.countVectors(store.root), 0)
    const result = await store.recall('alpha', { touch: false })
    assert.ok(result.l3.length >= 1)
    assert.equal(result.l3[0].id, a.id)
    const st = await store.status()
    assert.equal(st.embedding.enabled, true)
    assert.equal(st.embedding.degraded, true)
    assert.equal(st.embedding.vectorCount, 0)
    assert.ok(st.embedding.lastError !== null)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('embed.store: 默认关闭时不生成向量目录', async () => {
  const { ws, store } = await makeStore({ enabled: false })
  try {
    await store.init()
    await store.remember({ kind: 'entity', content: 'alpha 项目用 TypeScript', tags: [] })
    assert.equal(await store.embedding.countVectors(store.root), 0)
    const st = await store.status()
    assert.equal(st.embedding.enabled, false)
    assert.equal(st.embedding.degraded, false)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})