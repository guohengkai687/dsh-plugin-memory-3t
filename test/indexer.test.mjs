import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, buildIndex, bm25Score, searchIndex } from '../dist/indexer.js'

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