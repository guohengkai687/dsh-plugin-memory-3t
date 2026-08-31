import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approximateTokens, clampTokens, renderBootBlock, renderRuntimeBlock, renderSpaceBlock } from '../dist/render.js'

test('render: 近似 token 计数', () => {
  assert.equal(approximateTokens('中文'), 2)
  assert.ok(approximateTokens('english words here') > 3)
})

test('render: clampTokens 短文本原样', () => {
  const out = clampTokens('你好', 100)
  assert.equal(out, '你好')
})

test('render: clampTokens 超预算截断并标记', () => {
  const long = '甲'.repeat(500)
  const out = clampTokens(long, 100)
  assert.ok(approximateTokens(out) <= 100 + 20)
  assert.ok(out.endsWith('…(记忆注入已按 token 预算截断)'))
  assert.ok(out.length < long.length)
})

test('render: boot 块含数据非指令声明', () => {
  const out = renderBootBlock(
    {
      ready: true,
      root: '/x/.memory',
      counts: { l1: 1, l2: 2, l3: 3 },
      lastDigestAt: null,
      indexDirty: 0,
      firstRun: false,
      vcs: { enabled: true, available: true, ready: true, branch: 'main', commits: 5, pendingWrites: 0 },
      embedding: { enabled: false, ready: false, degraded: false, model: 'nomic-embed-text', vectorCount: 0 },
    },
    2000,
  )
  assert.ok(out.includes('数据'))
  assert.ok(out.includes('devmemory_recall'))
  assert.ok(out.includes('L3 条目 3'))
  assert.ok(out.includes('VCS on（main，5 次提交）'))
  assert.ok(out.includes('检索：BM25（本地）'))
})

test('render: boot 块 vcs 降级提示', () => {
  const out = renderBootBlock(
    {
      ready: true,
      root: '/x/.memory',
      counts: { l1: 0, l2: 0, l3: 0 },
      lastDigestAt: null,
      indexDirty: 0,
      firstRun: true,
      vcs: { enabled: true, available: false, ready: false, branch: null, commits: 0, pendingWrites: 0 },
      embedding: { enabled: true, ready: false, degraded: true, model: 'nomic-embed-text', vectorCount: 0 },
    },
    2000,
  )
  assert.ok(out.includes('VCS off（git 不可用'))
  assert.ok(out.includes('向量开启但 Ollama 不可用'))
})

test('render: boot 块 vcs 禁用提示', () => {
  const out = renderBootBlock(
    {
      ready: true,
      root: '/x/.memory',
      counts: { l1: 0, l2: 0, l3: 0 },
      lastDigestAt: null,
      indexDirty: 0,
      firstRun: true,
      vcs: { enabled: false, available: false, ready: false, branch: null, commits: 0, pendingWrites: 0 },
      embedding: { enabled: true, ready: true, degraded: false, model: 'nomic-embed-text', vectorCount: 3 },
    },
    2000,
  )
  assert.ok(out.includes('VCS off（已禁用）'))
  assert.ok(out.includes('向量+BM25 融合（nomic-embed-text，3 条向量）'))
})

test('render: boot 块 user scope 标注全局库', () => {
  const out = renderBootBlock(
    {
      ready: true,
      root: 'C:/Users/x/.memory',
      scope: 'user',
      counts: { l1: 1, l2: 1, l3: 1 },
      lastDigestAt: null,
      indexDirty: 0,
      firstRun: false,
      vcs: { enabled: true, available: true, ready: true, branch: 'main', commits: 3, pendingWrites: 0 },
      embedding: { enabled: false, ready: false, degraded: false, model: 'nomic-embed-text', vectorCount: 0 },
    },
    2000,
  )
  assert.ok(out.includes('库根：C:/Users/x/.memory（全局库，跨工作区共享）'))
})

test('render: runtime 块为空列表返回空串', () => {
  assert.equal(renderRuntimeBlock('今天', [], 1000), '')
})

test('render: space 块为空返回空串', () => {
  assert.equal(renderSpaceBlock([], 1000), '')
})