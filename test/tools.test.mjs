import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTools, CORE_TOOL_NAMES, FULL_TOOL_NAMES } from '../dist/tools.js'
import { MemoryStore } from '../dist/store.js'
import { DigestEngine } from '../dist/digest.js'
import { DEFAULT_CONFIG, mergeConfig } from '../dist/config.js'

const TOOL_NAMES = [...FULL_TOOL_NAMES]
const NAME_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
/** 近似 token（与 src/render.ts 同口径），用于 v0.7.0 的 schema 瘦身回归。 */
function approxTokens(text) {
  let cjk = 0, other = 0
  for (const ch of String(text)) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 4)
}

test('tools(v0.7.0): core 面 = 5 高频 + 1 个 admin', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-tools-'))
  try {
    const store = new MemoryStore(ws, DEFAULT_CONFIG)
    await store.init()
    const tools = createTools(store, new DigestEngine(store), { profile: 'core' })
    assert.equal(tools.length, 6)
    assert.deepEqual(tools.map((t) => t.name).sort(), [...CORE_TOOL_NAMES].sort())
    for (const tool of tools) assert.match(tool.name, NAME_RE)
    // admin 的 op 覆盖全部 7 个低频动作
    const admin = tools.find((t) => t.name === 'devmemory_admin')
    assert.deepEqual(
      [...admin.parameters.properties.op.enum].sort(),
      ['diag', 'diff', 'forget', 'history', 'link', 'restore', 'seed'],
    )
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('tools(v0.7.0): full 面仍是 12 个独立工具（兼容 v0.6）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-tools-full-'))
  try {
    const store = new MemoryStore(ws, DEFAULT_CONFIG)
    await store.init()
    const tools = createTools(store, new DigestEngine(store), { profile: 'full' })
    assert.equal(tools.length, 12)
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort())
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('tools(v0.7.0): core 面 schema 显著小于 full 面（瘦身回归）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-tools-size-'))
  try {
    const store = new MemoryStore(ws, DEFAULT_CONFIG)
    await store.init()
    const engine = new DigestEngine(store)
    const size = (profile) =>
      approxTokens(JSON.stringify(createTools(store, engine, { profile }).map((t) => ({
        name: t.name, description: t.description, parameters: t.parameters,
      }))))
    const core = size('core')
    const full = size('full')
    // v0.6.6 实测（真实 DSH 请求头、同口径）= 2081 tokens/调用；core 目标 < 1000
    assert.ok(core < full * 0.8, `core=${core} 应显著小于 full=${full}`)
    assert.ok(core < 1000, `core 面 schema 应 < 1000 tokens，实测 ${core}`)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('tools(v0.7.0): admin 分发到各低频动作（link/forget/diag/seed/history）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-tools-admin-'))
  try {
    const store = new MemoryStore(ws, configNoVcs())
    await store.init()
    const tools = createTools(store, new DigestEngine(store), { profile: 'core' })
    const admin = tools.find((t) => t.name === 'devmemory_admin')
    // seed：冷启动骨架
    const seeded = await admin.execute({ op: 'seed' }, {})
    assert.ok(typeof seeded.relPath === 'string' && seeded.relPath.endsWith('.md'))
    // remember + link + forget（demote）
    const a = await tools.find((t) => t.name === 'devmemory_remember').execute({ kind: 'entity', content: '实体 A：记忆插件', tags: ['x'] }, {})
    const b = await tools.find((t) => t.name === 'devmemory_remember').execute({ kind: 'entity', content: '实体 B：三层记忆', tags: ['y'] }, {})
    const linked = await admin.execute({ op: 'link', a: a.id, b: b.id }, {})
    assert.deepEqual(linked.aLinks, [b.id])
    const demoted = await admin.execute({ op: 'forget', id: b.id, mode: 'demote', reason: '测试' }, {})
    assert.equal(demoted.ok, true)
    // diag / history
    const diag = await admin.execute({ op: 'diag', action: 'summary' }, {})
    assert.ok(diag !== undefined)
    const history = await admin.execute({ op: 'history', limit: 3 }, {})
    assert.ok(Array.isArray(history.commits))
    // 未知 op 报错（不静默）
    await assert.rejects(() => admin.execute({ op: 'nope' }, {}), /未知 op/)
    await store.flushVcs('测试清理：等待自动提交完成')
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

/** 关掉 vcs 的配置：admin 冒烟不需要 git，避免临时目录句柄竞争。 */
function configNoVcs() {
  return mergeConfig({ vcs: { enabled: false } })
}

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