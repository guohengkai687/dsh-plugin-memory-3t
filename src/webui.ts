/**
 * 只读 WebUI 面板（v0.3）：状态 + 检索。
 *
 * 通过 DSH 的 webServer 服务（dsh-host-webserver，web 会话进程内可用）注册
 * prefix 路由 `/dev-memory`：
 * - GET /dev-memory 与 /dev-memory/ → 自包含静态页（无任何外部资源）
 * - GET /dev-memory/api/status                      → JSON 库状态
 * - GET /dev-memory/api/search?q=..&layers=l1,l2&maxResults=.. → JSON 检索结果
 * - GET /dev-memory/api/diag                        → JSON 诊断汇总（v0.4）
 *
 * 纯只读：不提供任何写端点；检索也不提升 L3 salience（touch:false），
 * 浏览面板不会改动记忆库。headless（无 webServer）时静默跳过、不注册。
 */

import type { Config } from './config.js'
import type { MemoryStore } from './store.js'

/** 面板路由前缀（与 webServer prefix 路由规则一致，绝对路径、无尾斜杠）。 */
export const WEB_PANEL_PATH = '/dev-memory'

export interface WebServerRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}

export interface WebServerLike {
  register(route: WebServerRoute): () => void
}

/** node:http 形状的最小化类型（仅结构使用，不引入运行时依赖）。 */
interface ReqLike {
  url?: string
  method?: string
}

interface ResLike {
  writeHead(statusCode: number, headers?: Record<string, string | number>): unknown
  end(chunk?: string): unknown
}

function isWebServerLike(value: unknown): value is WebServerLike {
  return typeof value === 'object' && value !== null && typeof (value as WebServerLike).register === 'function'
}

/** 从插件 ctx 找 webServer 服务（get 优先，属性兜底；两路都 try/catch 保 fail-open）。 */
export function findWebServer(ctx: unknown): WebServerLike | null {
  const c = ctx as { get?(name: string, strict?: boolean): unknown; webServer?: unknown } | null
  if (c === null || typeof c !== 'object') return null
  try {
    if (typeof c.get === 'function') {
      const svc = c.get('webServer')
      if (isWebServerLike(svc)) return svc
    }
  } catch {
    /* 服务不可用 */
  }
  try {
    if (isWebServerLike(c.webServer)) return c.webServer
  } catch {
    /* 服务不可用 */
  }
  return null
}

/**
 * 注册只读面板路由。返回卸载函数；headless（无 webServer）、开关关闭
 * （config.webui.enabled=false，v0.5）或注册失败 → 返回 null（静默跳过）。
 * store 参数支持实例或惰性 getter（v0.3.1：每次请求取当前工作区的库，会话工作区切换后面板自动跟新库）。
 * v0.5：返回 disposer 供设置页 live 重挂载（关 → 摘路由，开 → 重新注册）。
 */
export function registerWebPanel(
  ctx: unknown,
  storeOrGetter: MemoryStore | (() => MemoryStore),
  config: Config,
): (() => void) | null {
  if (config.webui.enabled !== true) return null
  const getStore = (): MemoryStore =>
    typeof storeOrGetter === 'function' ? (storeOrGetter as () => MemoryStore)() : storeOrGetter
  const server = findWebServer(ctx)
  if (server === null) return null
  try {
    const dispose = server.register({
      kind: 'prefix',
      path: WEB_PANEL_PATH,
      handler: (req, res) => {
        void handleWebRequest(req as ReqLike, res as ResLike, getStore(), config).catch(() => {
          /* 面板请求异常一律吞掉（只读面板绝不影响主链路） */
        })
      },
    })
    return typeof dispose === 'function' ? () => { try { dispose() } catch { /* 卸载失败静默 */ } } : () => {}
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 页面

const PANEL_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; background:#0f1115; color:#d7dae0; }
  main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color:#8b93a3; font-size: 13px; margin-bottom: 20px; }
  .card { background:#171b23; border:1px solid #262c38; border-radius:10px; padding:16px 18px; margin-bottom:16px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:10px; }
  .k { color:#8b93a3; font-size:12px; margin-bottom:2px; }
  .v { font-size:14px; word-break:break-all; }
  .badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; margin-left:6px; }
  .ok { background:#14351f; color:#5fd68a; } .warn { background:#3a2d12; color:#e6b45c; } .off { background:#262c38; color:#8b93a3; }
  input[type=text], select { background:#10141b; color:#d7dae0; border:1px solid #2a3240; border-radius:8px; padding:9px 12px; font-size:14px; }
  input[type=text] { flex:1; min-width:220px; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .layers label { font-size:13px; margin-right:6px; cursor:pointer; }
  button { background:#2b5cd9; color:#fff; border:0; border-radius:8px; padding:9px 18px; font-size:14px; cursor:pointer; }
  button:hover { background:#3569ea; }
  .hits h3 { margin:14px 0 6px; font-size:14px; color:#9aa4b5; }
  .hit { background:#141922; border:1px solid #262c38; border-radius:8px; padding:10px 12px; margin-bottom:8px; }
  .hit .meta { font-size:12px; color:#8b93a3; margin-bottom:2px; }
  .hit .sum { font-size:13px; white-space:pre-wrap; word-break:break-word; }
  .empty { color:#8b93a3; font-size:13px; padding:10px 0; }
  .err { color:#e06c75; font-size:13px; }
`

/** 生成只读面板页面（自包含：内联 CSS + 原生 JS，零外部请求）。 */
export function renderIndexPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dev-memory 记忆面板（只读）</title>
<style>${PANEL_CSS}</style>
</head>
<body>
<main>
  <h1>dev-memory 记忆面板 <span class="badge off">只读</span></h1>
  <div class="sub">dsh-plugin-memory-3t · 本地三层记忆 · 本页不提供任何写入操作</div>
  <div class="card"><div class="grid" id="status"><div class="k">加载中…</div></div></div>
  <div class="card">
    <div class="row" style="justify-content:space-between">
      <div><h2 style="font-size:15px;margin:0">诊断记录（异常与不符合预期行为）</h2></div>
      <span class="badge off">只读</span>
    </div>
    <div id="diag"><div class="empty">加载中…</div></div>
  </div>
  <div class="card">
    <div class="row">
      <input type="text" id="q" placeholder="检索记忆：跨 L1 流水 / L2 笔记 / L3 事实" onkeydown="if(event.key==='Enter')search()">
      <span class="layers">
        <label><input type="checkbox" id="l1" checked> L1</label>
        <label><input type="checkbox" id="l2" checked> L2</label>
        <label><input type="checkbox" id="l3" checked> L3</label>
      </span>
      <button onclick="search()">检索</button>
    </div>
    <div id="result" class="hits"></div>
  </div>
</main>
<script>
const LAYER_LABEL = { l1: 'L1 流水', l2: 'L2 笔记', l3: 'L3 事实' };
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
async function loadStatus() {
  try {
    const s = await getJSON('/dev-memory/api/status');
    const vcsBadge = !s.vcs.enabled ? '<span class="badge off">VCS off</span>'
      : s.vcs.ready ? '<span class="badge ok">VCS on ' + esc(s.vcs.branch) + ' · ' + s.vcs.commits + ' 提交</span>'
      : '<span class="badge warn">VCS 降级</span>';
    const emb = s.embedding.enabled
      ? (s.embedding.ready ? '<span class="badge ok">向量+BM25</span>' : '<span class="badge warn">向量降级 BM25</span>')
      : '<span class="badge off">BM25</span>';
    const scope = s.scope === 'user' ? '全局库（跨工作区共享）' : '工作区库';
    document.getElementById('status').innerHTML =
      '<div><div class="k">库根</div><div class="v">' + esc(s.root) + '</div></div>' +
      '<div><div class="k">粒度 / 就绪</div><div class="v">' + esc(scope) + (s.ready ? ' · 就绪' : ' · 未就绪') + '</div></div>' +
      '<div><div class="k">条目</div><div class="v">L1 ' + s.counts.l1 + ' · L2 ' + s.counts.l2 + ' · L3 ' + s.counts.l3 + '</div></div>' +
      '<div><div class="k">最近 digest</div><div class="v">' + esc(s.lastDigestAt ?? '从未') + '</div></div>' +
      '<div><div class="k">版本回溯</div><div class="v">' + vcsBadge + '</div></div>' +
      '<div><div class="k">检索</div><div class="v">' + emb + '</div></div>';
  } catch (e) {
    document.getElementById('status').innerHTML = '<div class="k err">status 加载失败：' + esc(e.message) + '</div>';
  }
}
async function search() {
  const box = document.getElementById('result');
  box.innerHTML = '<div class="empty">检索中…</div>';
  const q = document.getElementById('q').value.trim();
  if (q === '') { box.innerHTML = '<div class="empty">输入关键词后检索。</div>'; return; }
  const layers = ['l1','l2','l3'].filter((l) => document.getElementById(l).checked).join(',');
  try {
    const r = await getJSON('/dev-memory/api/search?q=' + encodeURIComponent(q) + '&layers=' + encodeURIComponent(layers));
    let html = '';
    for (const layer of ['l1','l2','l3']) {
      const hits = r.hits[layer] || [];
      if (hits.length === 0) continue;
      html += '<h3>' + LAYER_LABEL[layer] + '（' + hits.length + '）</h3>';
      for (const h of hits) {
        html += '<div class="hit"><div class="meta">score ' + Number(h.score).toFixed(3) + ' · ' + esc(h.id) + '</div>' +
          '<div class="sum">' + esc(h.summary) + '</div></div>';
      }
    }
    if (html === '') html = '<div class="empty">无命中（记忆库中没有相关内容）。</div>';
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = '<div class="err">检索失败：' + esc(e.message) + '</div>';
  }
}
async function loadDiag() {
  const box = document.getElementById('diag');
  try {
    const d = await getJSON('/dev-memory/api/diag');
    const s = d.summary || {};
    if (!s.enabled) { box.innerHTML = '<div class="empty">诊断记录已禁用（diag.enabled=false）。</div>'; return; }
    const levelBadge = (l) => l === 'error' ? '<span class="badge" style="background:#3a1a1a;color:#e06c75">error</span>' : '<span class="badge warn">unexpected</span>';
    let html = '<div class="grid">' +
      '<div><div class="k">累计事件</div><div class="v">' + (s.total ?? 0) + '</div></div>' +
      '<div><div class="k">error（异常）</div><div class="v">' + (s.error ?? 0) + '</div></div>' +
      '<div><div class="k">unexpected（不符预期）</div><div class="v">' + (s.unexpected ?? 0) + '</div></div>' +
      '<div><div class="k">本进程工具调用</div><div class="v">' + Object.values(s.usage || {}).reduce((a, b) => a + b, 0) + '</div></div>' +
      '</div>';
    const recent = s.recent || [];
    if (recent.length === 0) {
      html += '<div class="empty" style="margin-top:10px">暂无异常记录（记录会随使用自动积累）。</div>';
    } else {
      html += '<div style="margin-top:10px"><div class="k">最近 ' + recent.length + ' 条</div></div>';
      for (const e of recent.slice(0, 5)) {
        html += '<div class="hit"><div class="meta">' + levelBadge(e.level) + ' · ' + esc(e.origin) + (e.tool ? ' · ' + esc(e.tool) : '') + ' · ' + esc(new Date(e.ts).toLocaleString()) + '</div>' +
          '<div class="sum">' + esc(e.message) + '</div></div>';
      }
    }
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = '<div class="err">诊断加载失败：' + esc(e.message) + '</div>';
  }
}
loadStatus();
loadDiag();
</script>
</body>
</html>`
}

// ---------------------------------------------------------------- API

/** 解析 /api/search 查询串；非法返回 null。layers 逗号分隔，maxResults 钳制 1..50。 */
export function parseSearchQuery(url: string): { query: string; layers: string[]; maxResults: number } | null {
  let parsed: URL
  try {
    parsed = new URL(url, 'http://localhost')
  } catch {
    return null
  }
  const query = parsed.searchParams.get('q')?.trim() ?? ''
  if (query === '') return null
  const layers = (parsed.searchParams.get('layers') ?? '')
    .split(',')
    .map((l) => l.trim())
    .filter((l): l is 'l1' | 'l2' | 'l3' => l === 'l1' || l === 'l2' || l === 'l3')
  const rawLimit = Number(parsed.searchParams.get('maxResults'))
  const maxResults = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, Math.floor(rawLimit))) : 10
  return { query, layers, maxResults }
}

function sendJson(res: ResLike, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function sendPage(res: ResLike, page: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(page)
}

function methodOf(req: ReqLike): string {
  return (req.method ?? 'GET').toUpperCase()
}

/**
 * 路由分派：状态 / 检索 / 首页；其余 404。
 * 检索用 touch:false——只读语义，浏览面板不提升 L3 活跃度、不改写文件。
 */
export async function handleWebRequest(req: ReqLike, res: ResLike, store: MemoryStore, _config: Config): Promise<void> {
  const url = req.url ?? '/'
  const pathname = (() => {
    try {
      return new URL(url, 'http://localhost').pathname
    } catch {
      return url
    }
  })()
  if (pathname === WEB_PANEL_PATH || pathname === WEB_PANEL_PATH + '/') {
    sendPage(res, renderIndexPage())
    return
  }
  if (pathname === `${WEB_PANEL_PATH}/api/status`) {
    if (methodOf(req) !== 'GET' && methodOf(req) !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    try {
      sendJson(res, 200, await store.status())
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (pathname === `${WEB_PANEL_PATH}/api/search`) {
    if (methodOf(req) !== 'GET' && methodOf(req) !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    const parsed = parseSearchQuery(url)
    if (parsed === null) {
      sendJson(res, 400, { error: 'q 不能为空' })
      return
    }
    try {
      const result = await store.recall(parsed.query, {
        layers: parsed.layers.length > 0 ? (parsed.layers as Array<'l1' | 'l2' | 'l3'>) : undefined,
        maxResults: parsed.maxResults,
        touch: false,
      })
      sendJson(res, 200, {
        query: parsed.query,
        layers: parsed.layers.length > 0 ? parsed.layers : ['l1', 'l2', 'l3'],
        maxResults: parsed.maxResults,
        hits: result,
      })
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (pathname === `${WEB_PANEL_PATH}/api/diag`) {
    if (methodOf(req) !== 'GET' && methodOf(req) !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    try {
      // 只读汇总：诊断记录不在本面板提供任何写操作（clear 走 devmemory_diag 工具）
      const summary = await store.diag.summary()
      sendJson(res, 200, { summary })
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  sendJson(res, 404, { error: 'not found' })
}