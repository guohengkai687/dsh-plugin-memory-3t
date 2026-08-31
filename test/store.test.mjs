import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../dist/store.js'
import { DEFAULT_CONFIG } from '../dist/config.js'

async function makeStore(extra = {}) {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-store-'))
  const config = { ...DEFAULT_CONFIG, ...extra }
  const store = new MemoryStore(ws, config)
  await store.init()
  return { ws, store }
}

test('store.init: 建三层目录 + meta + audit', async () => {
  const { ws, store } = await makeStore()
  const dirs = await readdir(store.root)
  assert.ok(dirs.includes('runtime'))
  assert.ok(dirs.includes('docs'))
  assert.ok(dirs.includes('spaces'))
  assert.ok(dirs.includes('meta.json'))
  assert.ok(dirs.includes('audit.jsonl'))
  await rm(ws, { recursive: true, force: true })
})

test('store.init: .gitignore 自维护（存在且缺 .memory 时追加）', async () => {
  const { ws, store } = await makeStore()
  await writeFile(join(ws, '.gitignore'), 'node_modules/\n')
  // 重建 store 触发 maintainGitignore
  const store2 = new MemoryStore(ws, DEFAULT_CONFIG)
  await store2.init()
  const content = await readFile(join(ws, '.gitignore'), 'utf8')
  assert.ok(content.includes('.memory'))
  await rm(ws, { recursive: true, force: true })
})

test('store.remember: 写 L3 条目且 frontmatter 正确', async () => {
  const { ws, store } = await makeStore()
  const entry = await store.remember({ kind: 'preference', content: '用户喜欢用中文回复\n细节：技术文档用表格', tags: ['中文', '回复'] })
  assert.match(entry.id, /^pref-\d{8}-[a-z0-9]{11}$/)
  const file = await readFile(join(store.root, 'spaces', `${entry.id}.md`), 'utf8')
  assert.ok(file.includes('kind: "preference"'))
  assert.ok(file.includes('tags: ["中文","回复"]'))
  assert.ok(file.includes('用户喜欢用中文回复'))
  assert.equal(entry.salience, 0.6) // medium
  await rm(ws, { recursive: true, force: true })
})

test('store.remember: importance 影响 salience', async () => {
  const { ws, store } = await makeStore()
  const high = await store.remember({ kind: 'decision', content: '决定采用方案B', importance: 'high' })
  assert.equal(high.salience, 0.9)
  await rm(ws, { recursive: true, force: true })
})

test('store.note: 写与追加', async () => {
  const { ws, store } = await makeStore()
  const r1 = await store.note({ relPath: 'notes/a.md', body: '# A\n一行' })
  assert.equal(r1.path, 'notes/a.md')
  await store.note({ relPath: 'notes/a.md', body: '# A\n第二行', append: true })
  const content = await readFile(join(store.root, 'docs', 'notes', 'a.md'), 'utf8')
  assert.ok(content.includes('第二行'))
  await rm(ws, { recursive: true, force: true })
})

test('store.note: 拒绝逃逸路径', async () => {
  const { ws, store } = await makeStore()
  await assert.rejects(() => store.note({ relPath: '../evil.md', body: 'x' }), /非法片段|escapes/)
  await assert.rejects(() => store.note({ relPath: 'C:/evil.md', body: 'x' }), /相对路径/)
  await rm(ws, { recursive: true, force: true })
})

test('store.recall: 中文查询命中 L3', async () => {
  const { ws, store } = await makeStore()
  await store.remember({ kind: 'preference', content: '用户喜欢用中文回复', tags: ['中文'] })
  await store.remember({ kind: 'entity', content: '项目 alpha 使用 TypeScript', tags: ['项目'] })
  const result = await store.recall('中文回复偏好')
  assert.ok(result.l3.length >= 1)
  assert.ok(result.l3.some((h) => h.summary.includes('中文回复')))
  await rm(ws, { recursive: true, force: true })
})

test('store.linkEntries: 双向关联与孤儿拒绝', async () => {
  const { ws, store } = await makeStore()
  const a = await store.remember({ kind: 'entity', content: '实体 A', tags: ['t'] })
  const b = await store.remember({ kind: 'entity', content: '实体 B', tags: ['t'] })
  const { a: nextA, b: nextB } = await store.linkEntries(a.id, b.id)
  assert.ok(nextA.links.includes(b.id))
  assert.ok(nextB.links.includes(a.id))
  await assert.rejects(() => store.linkEntries(a.id, 'ghost-123'), /条目不存在/)
  await rm(ws, { recursive: true, force: true })
})

test('store.removeEntry: delete 写审计', async () => {
  const { ws, store } = await makeStore()
  const entry = await store.remember({ kind: 'context', content: '临时上下文', tags: [] })
  const ok = await store.removeEntry(entry.id, 'delete', '测试删除')
  assert.equal(ok, true)
  const audit = await readFile(join(store.root, 'audit.jsonl'), 'utf8')
  assert.ok(audit.includes(entry.id))
  assert.ok(audit.includes('"op":"forget"'))
  await rm(ws, { recursive: true, force: true })
})

test('store.recall: 命中后 touch 更新 accesses', async () => {
  const { ws, store } = await makeStore()
  const entry = await store.remember({ kind: 'preference', content: '喜欢 Node.js 生态', tags: ['node'] })
  await store.recall('Node 生态')
  const after = await store.readEntry(entry.id)
  assert.ok(after.accesses >= 1)
  await rm(ws, { recursive: true, force: true })
})

test('store.appendRuntime: 追加与读取', async () => {
  const { ws, store } = await makeStore()
  await store.appendRuntime(new Date(2026, 0, 5), '- 第一行')
  await store.appendRuntime(new Date(2026, 0, 5), '- 第二行')
  const raw = await store.readRuntime(new Date(2026, 0, 5))
  assert.ok(raw.includes('第一行'))
  assert.ok(raw.includes('第二行'))
  await rm(ws, { recursive: true, force: true })
})