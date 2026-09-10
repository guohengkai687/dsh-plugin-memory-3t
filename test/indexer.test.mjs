import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tokenize, buildIndex, bm25Score, searchIndex, IndexManager, INDEX_SCHEMA_VERSION } from '../dist/indexer.js'

test('tokenize: 英文单词小写', () => {
  const tokens = tokenize('dsh plugin MEMORY')
  assert.ok(tokens.includes('dsh'))
  assert.ok(tokens.includes('plugin'))
  assert.ok(tokens.includes('memory'))
})

test('tokenize: 中文 2-gram', () => {
  const tokens = tokenize('记忆插件')
  assert.ok(tokens.includes('记忆'))
  assert.ok(tokens.includes('忆插'))
  assert.ok(tokens.includes('插件'))
})

test('tokenize: 中英混合', () => {
  const tokens = tokenize('dsh 记忆插件 plugin')
  assert.ok(tokens.includes('dsh'))
  assert.ok(tokens.includes('plugin'))
  assert.ok(tokens.includes('记忆'))
  assert.ok(tokens.includes('插件'))
})

test('buildIndex: 幂等（两次构建结果一致，忽略 builtAt 时间戳）', () => {
  const docs = [
    { docKey: 'a', layer: 'l3', id: 'a', text: '用户喜欢用中文回复 记忆插件', tags: ['中文'], salience: 0.8, accesses: 1 },
    { docKey: 'b', layer: 'l2', id: 'b', text: 'dsh plugin architecture notes', tags: ['dsh'], salience: 0.5, accesses: 0 },
  ]
  const first = buildIndex(docs)
  const second = buildIndex(docs)
  const { builtAt: _a, ...firstRest } = first
  const { builtAt: _b, ...secondRest } = second
  assert.deepEqual(firstRest, secondRest)
  assert.equal(first.docCount, 2)
})

test('bm25Score: 相关性排序（术语频次更高者更靠前）', () => {
  const avg = 10
  const idf = (t) => Math.log(1 + (3 - 1 + 0.5) / (1 + 0.5)) // 全覆盖词
  const low = bm25Score(['记忆'], { len: 10, tf: { 记忆: 1 } }, idf, avg)
  const high = bm25Score(['记忆'], { len: 10, tf: { 记忆: 5 } }, idf, avg)
  assert.ok(high > low)
})

test('searchIndex: 中文查询命中对应条目并按层分组', () => {
  const docs = [
    { docKey: 'l3:p1', layer: 'l3', id: 'p1', text: '用户偏好：用中文回复 技术文档用表格', tags: ['中文'], salience: 0.9, accesses: 5 },
    { docKey: 'l2:n1', layer: 'l2', id: 'n1', text: '记忆插件设计：三层架构 文档', tags: ['记忆'], salience: 0.5, accesses: 0 },
    { docKey: 'l1:2026-01-01', layer: 'l1', id: '2026-01-01', text: '今天聊了部署 细节', tags: [], salience: 0.4, accesses: 0 },
  ]
  const index = buildIndex(docs)
  const result = searchIndex(index, '中文回复', 10)
  assert.ok(result.l3.length >= 1)
  assert.equal(result.l3[0].id, 'p1')
  const result2 = searchIndex(index, '记忆插件', 10)
  assert.ok(result2.l2.length >= 1)
  assert.equal(result2.l2[0].id, 'n1')
})

test('searchIndex: layers 过滤', () => {
  const docs = [
    { docKey: 'l3:p1', layer: 'l3', id: 'p1', text: '中文偏好', tags: [], salience: 0.9, accesses: 0 },
    { docKey: 'l1:2026-01-01', layer: 'l1', id: '2026-01-01', text: '中文流水', tags: [], salience: 0.4, accesses: 0 },
  ]
  const index = buildIndex(docs)
  const onlyL3 = searchIndex(index, '中文', 10, ['l3'])
  assert.ok(onlyL3.l3.length >= 1)
  assert.equal(onlyL3.l1.length, 0)
})

test('searchIndex: maxPerLayer 截断', () => {
  const docs = Array.from({ length: 5 }, (_, i) => ({
    docKey: `l3:e${i}`, layer: 'l3', id: `e${i}`, text: '同一个主题 内容', tags: [], salience: 0.5 + i * 0.05, accesses: 0,
  }))
  const index = buildIndex(docs)
  const result = searchIndex(index, '主题', 2)
  assert.equal(result.l3.length, 2)
})

// ---------------------------------------------------------------- v0.6.1
// IndexManager 状态机回归：索引陈旧根因（阈值死代码 / 跨进程脏标记丢失）的覆盖。

const mkDocs = (n) =>
  Array.from({ length: n }, (_, i) => ({
    docKey: `l3:e${i}`,
    layer: 'l3',
    id: `e${i}`,
    text: `条目内容 ${i} 记忆`,
    tags: [],
    kind: 'entity',
    salience: 0.6,
    accesses: 0,
  }))

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-idx-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('buildIndex: 按 docKey 建键，SearchHit 同时保留 docKey 与 id（v0.6.1 回归）', () => {
  const docs = [
    { docKey: 'l3:a', layer: 'l3', id: 'a', text: '消息内容 记忆', tags: [], salience: 0.6, accesses: 0 },
    { docKey: 'l2:n1', layer: 'l2', id: 'n1', text: '笔记 内容', tags: [], kind: 'note', salience: 0.5, accesses: 0 },
  ]
  const index = buildIndex(docs)
  assert.ok(index.docs['l3:a'])
  assert.ok(index.docs['l2:n1'])
  assert.ok(index.docs['a'] === undefined, '不得再用 id 作为索引键')
  assert.ok(index.postings['记忆']?.['l3:a'] !== undefined)
  const hit = searchIndex(index, '记忆', 10)
  assert.equal(hit.l3[0].docKey, 'l3:a')
  assert.equal(hit.l3[0].id, 'a')
})

test('IndexManager: 首次无快照 → 重建并写盘（schemaVersion=2）', async () => {
  await withTmp(async (dir) => {
    const idxPath = join(dir, 'index.json')
    const mgr = new IndexManager(idxPath, 50)
    const idx = await mgr.get(async () => mkDocs(3))
    assert.equal(idx.docCount, 3)
    assert.equal(mgr.rebuildReason, 'missing')
    const onDisk = JSON.parse(await readFile(idxPath, 'utf8'))
    assert.equal(onDisk.schemaVersion, INDEX_SCHEMA_VERSION)
  })
})

test('IndexManager: 快照干净（无脏标记）→ 直接加载不重建', async () => {
  await withTmp(async (dir) => {
    const idxPath = join(dir, 'index.json')
    const mgr = new IndexManager(idxPath, 50)
    await mgr.get(async () => mkDocs(3))
    // 模拟新进程：重新实例化（无持久化脏标记、无内存缓存）
    const mgr2 = new IndexManager(idxPath, 50)
    const idx = await mgr2.get(async () => mkDocs(3))
    assert.equal(idx.docCount, 3)
    assert.equal(mgr2.rebuildReason, null, '干净快照不应重建')
  })
})

test('IndexManager: markDirty 落持久化标记 → 下一个进程重建（核心回归）', async () => {
  await withTmp(async (dir) => {
    const idxPath = join(dir, 'index.json')
    const mgr = new IndexManager(idxPath, 50)
    await mgr.get(async () => mkDocs(3))
    mgr.markDirty()
    await assert.doesNotReject(readFile(`${idxPath}.dirty`, 'utf8'), '标记应落盘')
    const mgr2 = new IndexManager(idxPath, 50)
    const idx = await mgr2.get(async () => mkDocs(4))
    assert.equal(idx.docCount, 4)
    assert.equal(mgr2.rebuildReason, 'dirty-marker')
    await assert.rejects(readFile(`${idxPath}.dirty`, 'utf8'), '重建后标记应清除')
  })
})

test('IndexManager: markMetadataDirty 不落标记 → 不触发跨进程重建（touch 不扫库）', async () => {
  await withTmp(async (dir) => {
    const idxPath = join(dir, 'index.json')
    const mgr = new IndexManager(idxPath, 50)
    await mgr.get(async () => mkDocs(3))
    mgr.markMetadataDirty()
    await assert.rejects(readFile(`${idxPath}.dirty`, 'utf8'), '元数据触碰不得落标记')
    const mgr2 = new IndexManager(idxPath, 50)
    const idx = await mgr2.get(async () => mkDocs(3))
    assert.equal(idx.docCount, 3)
    assert.equal(mgr2.rebuildReason, null, '无标记则沿用快照')
  })
})

test('IndexManager: 同进程脏写入超阈值 → 重建（阈值曾永不触发）', async () => {
  await withTmp(async (dir) => {
    const idxPath = join(dir, 'index.json')
    const mgr = new IndexManager(idxPath, 3)
    await mgr.get(async () => mkDocs(1))
    // markMetadataDirty 不落标记、仅进程内计数 → 靠阈值触发重建
    for (let i = 0; i < 3; i++) mgr.markMetadataDirty()
    const idx = await mgr.get(async () => mkDocs(5))
    assert.equal(idx.docCount, 5)
    assert.equal(mgr.rebuildReason, 'threshold')
  })
})

test('IndexManager: 损坏快照 → 判废重建', async () => {
  await withTmp(async (dir) => {
    const idxPath = join(dir, 'index.json')
    await writeFile(idxPath, 'not-json{{{')
    const mgr = new IndexManager(idxPath, 50)
    const idx = await mgr.get(async () => mkDocs(2))
    assert.equal(idx.docCount, 2)
    assert.equal(mgr.rebuildReason, 'missing')
  })
})

test('IndexManager: 旧 schemaVersion 快照 → 判废重建', async () => {
  await withTmp(async (dir) => {
    const idxPath = join(dir, 'index.json')
    await writeFile(idxPath, JSON.stringify({ schemaVersion: 1, docCount: 1, avgDocLen: 1, docs: {}, postings: {} }))
    const mgr = new IndexManager(idxPath, 50)
    const idx = await mgr.get(async () => mkDocs(2))
    assert.equal(idx.docCount, 2)
    assert.equal(idx.schemaVersion, INDEX_SCHEMA_VERSION)
  })
})

test('IndexManager: force 强制重建', async () => {
  await withTmp(async (dir) => {
    const idxPath = join(dir, 'index.json')
    const mgr = new IndexManager(idxPath, 50)
    await mgr.get(async () => mkDocs(2))
    const idx = await mgr.get(async () => mkDocs(7), true)
    assert.equal(idx.docCount, 7)
    assert.equal(mgr.rebuildReason, 'force')
  })
})

test('IndexManager: snapshotDocCount 未加载时读磁盘、缺失返回 null', async () => {
  await withTmp(async (dir) => {
    const idxPath = join(dir, 'index.json')
    const fresh = new IndexManager(idxPath, 50)
    assert.equal(await fresh.snapshotDocCount(), null)
    const mgr = new IndexManager(idxPath, 50)
    await mgr.get(async () => mkDocs(3))
    const other = new IndexManager(idxPath, 50)
    assert.equal(await other.snapshotDocCount(), 3)
  })
})