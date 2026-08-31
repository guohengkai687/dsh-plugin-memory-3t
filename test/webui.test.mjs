/**
 * v0.3 只读 WebUI 面板测试。
 *
 * - 页面：自包含、只读标注、包含 API 端点引用。
 * - 查询解析：q 必填、layers 白名单、maxResults 钳制。
 * - 路由（mock res）：status / search（touch:false 只读）/ 404 / 405。
 * - 注册：无 webServer 静默跳过；有则 prefix 路由可派发。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from '../dist/config.js'
import { MemoryStore } from '../dist/store.js'
import {
  WEB_PANEL_PATH,
  findWebServer,
  handleWebRequest,
  parseSearchQuery,
  registerWebPanel,
  renderIndexPage,
} from '../dist/webui.js'

function makeRes() {
  const chunks = []
  return {
    _status: null,
    _headers: null,
    writeHead(status, headers) {
      this._status = status
      this._headers = headers
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk))
    },
    body() {
      return chunks.join('')
    },
  }
}

test('webui: 页面自包含且只读标注', () => {
  const page = renderIndexPage()
  assert.ok(page.includes('dev-memory 记忆面板'))
  assert.ok(page.includes('只读'))
  assert.ok(page.includes('/dev-memory/api/status'))
  assert.ok(page.includes('/dev-memory/api/search'))
  assert.ok(page.includes('/dev-memory/api/diag'))
  assert.ok(page.includes('诊断记录'))
  assert.ok(page.includes('<script>'))
  assert.ok(!page.includes('http://') || page.includes('localhost'), '页面不应携带外部资源引用')
})

test('webui: 搜索参数解析（q 必填 / layers 白名单 / maxResults 钳制）', () => {
  const ok = parseSearchQuery('/dev-memory/api/search?q=alpha&layers=l1,l3&maxResults=99')
  assert.deepEqual(ok, { query: 'alpha', layers: ['l1', 'l3'], maxResults: 50 })
  const clamped = parseSearchQuery('/dev-memory/api/search?q=x&layers=l2,evil&maxResults=-3')
  assert.deepEqual(clamped.layers, ['l2'])
  assert.equal(clamped.maxResults, 1)
  const empty = parseSearchQuery('/dev-memory/api/search?q=%20%20')
  assert.equal(empty, null)
  const noQ = parseSearchQuery('/dev-memory/api/search?layers=l1')
  assert.equal(noQ, null)
})

test('webui: findWebServer 三种形态', () => {
  const server = { register() {} }
  assert.equal(findWebServer({}), null)
  assert.equal(findWebServer(null), null)
  assert.equal(findWebServer({ get: () => server }), server)
  assert.equal(findWebServer({ webServer: server }), server)
  // get 抛错时回退属性
  assert.equal(findWebServer({ get: () => { throw new Error('nope') }, webServer: server }), server)
  // 非服务形状 → null
  assert.equal(findWebServer({ get: () => ({ nope: true }) }), null)
})

test('webui: registerWebPanel 静默跳过（无 webServer/开关关）或注册 prefix 路由并返回卸载函数', () => {
  const store = {}
  // 无 webServer → null（不再注册）
  assert.equal(registerWebPanel({}, store, DEFAULT_CONFIG), null)
  // 开关关（v0.5）→ null，且不触碰 server
  let touched = false
  const offServer = {
    register() {
      touched = true
      return () => {}
    },
  }
  assert.equal(registerWebPanel({ get: () => offServer }, store, { ...DEFAULT_CONFIG, webui: { enabled: false } }), null)
  assert.equal(touched, false, 'webui.enabled=false 时不得注册路由')

  const registered = []
  const disposed = []
  const fakeServer = {
    register(route) {
      registered.push(route)
      return () => disposed.push(route.path)
    },
  }
  const dispose = registerWebPanel({ get: () => fakeServer }, store, DEFAULT_CONFIG)
  assert.equal(typeof dispose, 'function')
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, WEB_PANEL_PATH)
  assert.equal(typeof registered[0].handler, 'function')
  // 卸载函数可摘除路由（v0.5 live 重挂载用）
  dispose()
  assert.deepEqual(disposed, [WEB_PANEL_PATH])
})

test('webui: 路由分派（status / search 只读 / 404 / 405）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-webui-'))
  try {
    const store = new MemoryStore(ws, { ...DEFAULT_CONFIG, vcs: { ...DEFAULT_CONFIG.vcs, enabled: false } })
    await store.init()
    const entry = await store.remember({ kind: 'entity', content: '项目 alpha 使用 TypeScript', tags: ['项目'] })

    // 首页
    const home = makeRes()
    await handleWebRequest({ url: '/dev-memory/', method: 'GET' }, home, store, DEFAULT_CONFIG)
    assert.equal(home._status, 200)
    assert.match(home._headers['content-type'], /text\/html/)
    assert.ok(home.body().includes('dev-memory 记忆面板'))

    // status：JSON + scope + 诊断计数（v0.4）
    const st = makeRes()
    await handleWebRequest({ url: '/dev-memory/api/status', method: 'GET' }, st, store, DEFAULT_CONFIG)
    assert.equal(st._status, 200)
    assert.match(st._headers['content-type'], /application\/json/)
    const status = JSON.parse(st.body())
    assert.equal(status.ready, true)
    assert.equal(status.scope, 'workspace')
    assert.equal(status.counts.l3, 1)
    assert.equal(status.diag.enabled, true)
    assert.ok(typeof status.diag.total === 'number')

    // diag（v0.4）：只读汇总，先种一条事件再查
    await store.diag.record({ level: 'unexpected', origin: 'vcs', message: 'git 降级（测试）' })
    const dg = makeRes()
    await handleWebRequest({ url: '/dev-memory/api/diag', method: 'GET' }, dg, store, DEFAULT_CONFIG)
    assert.equal(dg._status, 200)
    const diag = JSON.parse(dg.body())
    assert.equal(diag.summary.total, 1)
    assert.equal(diag.summary.unexpected, 1)
    assert.equal(diag.summary.byOrigin.vcs, 1)

    // 405：诊断端点拒绝写方法（只读）
    const dgPost = makeRes()
    await handleWebRequest({ url: '/dev-memory/api/diag', method: 'POST' }, dgPost, store, DEFAULT_CONFIG)
    assert.equal(dgPost._status, 405)

    // search：命中 l3 且 touch:false（只读，不提升 salience/accesses）
    const sr = makeRes()
    await handleWebRequest(
      { url: '/dev-memory/api/search?q=' + encodeURIComponent('TypeScript 项目'), method: 'GET' },
      sr,
      store,
      DEFAULT_CONFIG,
    )
    assert.equal(sr._status, 200)
    const search = JSON.parse(sr.body())
    assert.equal(search.query, 'TypeScript 项目')
    assert.ok(search.hits.l3.length >= 1)
    const after = await store.readEntry(entry.id)
    assert.equal(after?.accesses, 0, 'WebUI 检索不得提升 L3 活跃度（只读）')

    // search：层过滤排除 l3
    const sr2 = makeRes()
    await handleWebRequest(
      { url: '/dev-memory/api/search?q=' + encodeURIComponent('TypeScript') + '&layers=l1,l2', method: 'GET' },
      sr2,
      store,
      DEFAULT_CONFIG,
    )
    const search2 = JSON.parse(sr2.body())
    assert.equal(search2.hits.l3.length, 0)

    // search：空 q → 400
    const bad = makeRes()
    await handleWebRequest({ url: '/dev-memory/api/search?q=', method: 'GET' }, bad, store, DEFAULT_CONFIG)
    assert.equal(bad._status, 400)

    // 405：写方法拒绝
    const post = makeRes()
    await handleWebRequest({ url: '/dev-memory/api/status', method: 'POST' }, post, store, DEFAULT_CONFIG)
    assert.equal(post._status, 405)

    // 404：未知路由
    const nf = makeRes()
    await handleWebRequest({ url: '/dev-memory/api/nope', method: 'GET' }, nf, store, DEFAULT_CONFIG)
    assert.equal(nf._status, 404)

    // 搜索不产生 git 待提交（只读保证）
    assert.equal(store.vcs.pendingWrites, 0)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})