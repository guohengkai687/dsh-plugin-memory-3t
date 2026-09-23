import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTools } from '../dist/tools.js'
import { MemoryStore } from '../dist/store.js'
import { DigestEngine } from '../dist/digest.js'
import { DEFAULT_CONFIG } from '../dist/config.js'

const TOOL_NAMES = ['devmemory_status', 'devmemory_recall', 'devmemory_remember', 'devmemory_note', 'devmemory_link', 'devmemory_forget', 'devmemory_consolidate', 'devmemory_history', 'devmemory_diff', 'devmemory_restore', 'devmemory_diag', 'devmemory_seed']
const NAME_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/

test('tools: 12 个工具齐全且命名合法', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-tools-'))
  try {
    const store = new MemoryStore(ws, DEFAULT_CONFIG)
    await store.init()
    const tools = createTools(store, new DigestEngine(store))
    assert.equal(tools.length, 12)
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort())
    for (const tool of tools) assert.match(tool.name, NAME_RE)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('tools: 每个工具 schema 为 object-rooted 且描述非空', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-tools2-'))
  try {
    const store = new MemoryStore(ws, DEFAULT_CONFIG)
    await store.init()
    const tools = createTools(store, new DigestEngine(store))
    for (const tool of tools) {
      assert.equal(tool.parameters.type, 'object')
      assert.ok(tool.description.length > 10)
      assert.equal(tool.output.schema.type, 'object')
      assert.equal(typeof tool.output.render, 'function')
      assert.equal(typeof tool.execute, 'function')
      // DSH 契约：render 必须返回 ContentBlock 数组（文本模型消息投影会递归 tool-result 内层 content）
      const rendered = tool.output.render({}, {})
      assert.ok(Array.isArray(rendered), `${tool.name} render 应返回 ContentBlock[]`)
      assert.equal(rendered[0]?.type, 'text')
      assert.ok(typeof rendered[0]?.text === 'string' && rendered[0].text.length > 0)
    }
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('tools: remember 冒烟（写入并返回 id）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-tools3-'))
  try {
    const store = new MemoryStore(ws, DEFAULT_CONFIG)
    await store.init()
    const tools = createTools(store, new DigestEngine(store))
    const remember = tools.find((t) => t.name === 'devmemory_remember')
    const result = await remember.execute({ kind: 'preference', content: '用户喜欢简洁的回复', tags: ['风格'] }, {})
    assert.ok(result.id.startsWith('pref-'))
    const status = await tools.find((t) => t.name === 'devmemory_status').execute({}, {})
    assert.equal(status.counts.l3, 1)
    // v0.2：status 携带 git 与向量检索状态；v0.3：携带 scope
    assert.ok(status.vcs !== undefined && typeof status.vcs.ready === 'boolean')
    assert.equal(status.embedding.enabled, false)
    assert.equal(status.embedding.degraded, false)
    assert.equal(status.scope, 'workspace')
    // git 可用环境下 remember 会触发防抖自动提交（异步 git 子进程）；
    // 若在提交结束前 rmdir 临时库会撞上句柄 EBUSY（Windows 时序问题），先 flush 等提交完成。
    await store.flushVcs('测试清理：等待自动提交完成')
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('tools: recall 冒烟（写入后可查回）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-tools4-'))
  try {
    const store = new MemoryStore(ws, DEFAULT_CONFIG)
    await store.init()
    const tools = createTools(store, new DigestEngine(store))
    await tools.find((t) => t.name === 'devmemory_remember').execute(
      { kind: 'entity', content: '项目 alpha 使用 TypeScript', tags: ['项目'] },
      {},
    )
    const result = await tools.find((t) => t.name === 'devmemory_recall').execute({ query: 'TypeScript 项目' }, {})
    assert.ok(result.l3.length >= 1)
    assert.ok(result.l3[0].summary.includes('alpha'))
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('tools: note 拒绝逃逸路径', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-tools5-'))
  try {
    const store = new MemoryStore(ws, DEFAULT_CONFIG)
    await store.init()
    const tools = createTools(store, new DigestEngine(store))
    const note = tools.find((t) => t.name === 'devmemory_note')
    await assert.rejects(() => note.execute({ relPath: '../evil.md', body: 'x' }, {}), /非法片段|escapes/)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})