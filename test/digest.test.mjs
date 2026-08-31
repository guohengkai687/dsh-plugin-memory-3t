import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../dist/store.js'
import { DigestEngine, isExplicitMemoryCandidate, inferKind } from '../dist/digest.js'
import { DEFAULT_CONFIG } from '../dist/config.js'

async function withStore(fn) {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-digest-'))
  try {
    const config = { ...DEFAULT_CONFIG }
    const store = new MemoryStore(ws, config)
    await store.init()
    await fn(store, ws)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
}

test('digest: 显式候选识别', () => {
  assert.ok(isExplicitMemoryCandidate('请记住：用户喜欢用中文回复'))
  assert.ok(isExplicitMemoryCandidate('please remember this detail'))
  assert.ok(!isExplicitMemoryCandidate('你好'))
})

test('digest: kind 推断', () => {
  assert.equal(inferKind('记住我喜欢喝咖啡'), 'preference')
  assert.equal(inferKind('我们决定采用方案B'), 'decision')
  assert.equal(inferKind('项目叫 alpha'), 'entity')
})

test('digest: forced 触发并提升候选到 L3', async () => {
  await withStore(async (store) => {
    const engine = new DigestEngine(store)
    const summaries = await engine.maybeDigest({
      key: 's1',
      forced: true,
      messages: [
        { role: 'user', text: '请记住：用户喜欢用中文回复' },
        { role: 'user', text: '请记住：我们决定采用方案B，因为维护成本低' },
      ],
    })
    assert.ok(summaries.length >= 2)
    const entries = await store.listEntries()
    assert.ok(entries.some((e) => e.kind === 'preference' && e.summary.includes('中文回复')))
    assert.ok(entries.some((e) => e.kind === 'decision'))
  })
})

test('digest: 重复内容去重不新建', async () => {
  await withStore(async (store) => {
    const engine = new DigestEngine(store)
    await engine.maybeDigest({ key: 's1', forced: true, messages: [{ role: 'user', text: '记住：用户喜欢咖啡' }] })
    await engine.maybeDigest({ key: 's2', forced: true, messages: [{ role: 'user', text: '记住：用户喜欢咖啡' }] })
    const entries = await store.listEntries()
    const hits = entries.filter((e) => e.summary.includes('咖啡'))
    assert.equal(hits.length, 1)
  })
})

test('digest: maxPromote 上限生效（专用配置）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-digest2-'))
  try {
    const config = structuredClone(DEFAULT_CONFIG)
    config.digest.maxPromote = 1
    config.digest.maxMessages = 1000
    const store = new MemoryStore(ws, config)
    await store.init()
    const engine = new DigestEngine(store)
    await engine.maybeDigest({
      key: 's1', forced: true,
      messages: [
        { role: 'user', text: '记住：A 项目用 Node' },
        { role: 'user', text: '记住：B 项目用 Go' },
        { role: 'user', text: '记住：C 项目用 Rust' },
      ],
    })
    const entries = await store.listEntries()
    assert.equal(entries.length, 1)
    const notes = await readdir(join(store.root, 'docs'))
    assert.ok(notes.length >= 1) // 溢出笔记
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('digest: fail-open —— remember 抛错时不 rethrow 且记 pending', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-digest3-'))
  try {
    const store = new MemoryStore(ws, DEFAULT_CONFIG)
    await store.init()
    // 用一个覆写 remember 抛错的子类
    const BrokenStore = class extends MemoryStore {
      async remember() {
        throw new Error('磁盘爆炸')
      }
    }
    const broken = new BrokenStore(ws, DEFAULT_CONFIG)
    await broken.init()
    const engine = new DigestEngine(broken)
    const result = await engine.maybeDigest({
      key: 's1', forced: true,
      messages: [{ role: 'user', text: '记住：某事很重要' }],
    })
    assert.equal(result, null) // 失败返回 null 而非抛出
    const state = broken.digestState
    assert.equal(state.pending, true)
    assert.equal(state.retries, 1)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('digest: 未触发（消息少且非收尾）时返回 null', async () => {
  await withStore(async (store) => {
    const engine = new DigestEngine(store)
    const result = await engine.maybeDigest({ key: 's1', messages: [{ role: 'user', text: '早上好' }] })
    assert.equal(result, null)
  })
})

test('digest: runPending 在 pending 状态下补做并重置', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-digest4-'))
  try {
    const store = new MemoryStore(ws, DEFAULT_CONFIG)
    await store.init()
    const engine = new DigestEngine(store)
    // 伪造 pending 状态
    await store.updateDigestState({ pending: true, retries: 1, lastError: 'boom', lastRunAt: null })
    // 流水里有候选行
    await store.appendRuntime(new Date(), '- 记住：用户喜欢用英文回复')
    const summaries = await engine.runPending('retry-1')
    assert.ok(Array.isArray(summaries))
    const state = store.digestState
    assert.equal(state.pending, false)
    const entries = await store.listEntries()
    assert.ok(entries.some((e) => e.summary.includes('英文回复')))
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})