/**
 * v0.4 诊断与异常记录（DiagLog）测试。
 *
 * - DiagLog 单元：追加落盘 / 计数惰性装载 / 汇总聚合（分级/分工具/分来源 + 最近 + usage）/
 *   明细过滤（level/tool/origin/days/limit，新→旧）/ 清空 / 上限压缩 / 禁用开关 / fail-open / 字段截断。
 * - 集成：store 挂载 diag；工具异常自动入记（remember 空 content → error 事件含参数摘要）；
 *   devmemory_diag 三动作（summary/list/clear）；usage 按调用计数；status 携带诊断字段；
 *   boot 块在存在记录时附提示行。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from '../dist/config.js'
import { DiagLog } from '../dist/diag.js'
import { DigestEngine } from '../dist/digest.js'
import { renderBootBlock, renderStatusBlock } from '../dist/render.js'
import { MemoryStore } from '../dist/store.js'
import { createTools } from '../dist/tools.js'

function makeDiag(maxEvents = DEFAULT_CONFIG.diag.maxEvents, enabled = true) {
  return { ...DEFAULT_CONFIG.diag, maxEvents, enabled }
}

test('diag: record 追加 JSONL + 计数（惰性装载）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-diag-'))
  try {
    const log = new DiagLog(ws, makeDiag())
    await log.ensureDir()
    await log.record({ level: 'error', origin: 'tool', tool: 'devmemory_recall', message: '查询失败', args: '{"query":"x"}' })
    await log.record({ level: 'unexpected', origin: 'vcs', message: 'git 降级' })
    const raw = await readFile(log.file, 'utf8')
    const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '')
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0])
    assert.equal(first.level, 'error')
    assert.equal(first.origin, 'tool')
    assert.equal(first.tool, 'devmemory_recall')
    assert.equal(first.args, '{"query":"x"}')
    const counters = await log.counters()
    assert.equal(counters.total, 2)
    assert.equal(counters.error, 1)
    assert.equal(counters.unexpected, 1)
    assert.ok(counters.firstTs !== null && counters.lastTs !== null)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('diag: summary 聚合（分级/分来源/分工具 + 最近事件）+ usage 计数', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-diag2-'))
  try {
    const log = new DiagLog(ws, makeDiag())
    await log.ensureDir()
    log.noteUsage('devmemory_recall')
    log.noteUsage('devmemory_recall')
    log.noteUsage('devmemory_status')
    await log.record({ level: 'error', origin: 'tool', tool: 'devmemory_recall', message: 'e1' })
    await log.record({ level: 'error', origin: 'tool', tool: 'devmemory_note', message: 'e2' })
    await log.record({ level: 'unexpected', origin: 'vcs', message: 'u1' })
    const s = await log.summary()
    assert.equal(s.total, 3)
    assert.equal(s.error, 2)
    assert.equal(s.unexpected, 1)
    assert.deepEqual(s.byLevel, { error: 2, unexpected: 1 })
    assert.deepEqual(s.byOrigin, { tool: 2, vcs: 1 })
    assert.deepEqual(s.byTool, { devmemory_recall: 1, devmemory_note: 1 })
    assert.equal(s.recent.length, 3)
    assert.equal(s.recent[0].message, 'u1') // 新→旧
    assert.deepEqual(s.usage, { devmemory_recall: 2, devmemory_status: 1 }) // 内存态，按次数
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('diag: list 过滤（level/tool/origin/days/limit，新→旧）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-diag3-'))
  try {
    const log = new DiagLog(ws, makeDiag())
    await log.ensureDir()
    await log.record({ level: 'error', origin: 'tool', tool: 'devmemory_a', message: 'a-err' })
    await log.record({ level: 'unexpected', origin: 'digest', message: 'b-ux' })
    await log.record({ level: 'error', origin: 'tool', tool: 'devmemory_b', message: 'c-err' })
    const all = await log.list()
    assert.deepEqual(all.map((e) => e.message), ['c-err', 'b-ux', 'a-err'])
    const errs = await log.list({ level: 'error' })
    assert.deepEqual(errs.map((e) => e.message), ['c-err', 'a-err'])
    const toolA = await log.list({ tool: 'devmemory_a' })
    assert.deepEqual(toolA.map((e) => e.message), ['a-err'])
    const digestOnly = await log.list({ origin: 'digest' })
    assert.deepEqual(digestOnly.map((e) => e.message), ['b-ux'])
    const today = await log.list({ days: 1 })
    assert.equal(today.length, 3)
    const limited = await log.list({ limit: 2 })
    assert.equal(limited.length, 2)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('diag: clear 清空文件与计数', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-diag4-'))
  try {
    const log = new DiagLog(ws, makeDiag())
    await log.ensureDir()
    await log.record({ level: 'error', origin: 'tool', message: 'x' })
    log.noteUsage('devmemory_status')
    const { totalCleared } = await log.clear()
    assert.equal(totalCleared, 1)
    const raw = await readFile(log.file, 'utf8')
    assert.equal(raw.trim(), '')
    const counters = await log.counters()
    assert.equal(counters.total, 0)
    const s = await log.summary()
    assert.deepEqual(s.usage, {})
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('diag: 上限压缩——超上限自动压缩，只保留最新 ~maxEvents 条', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-diag5-'))
  try {
    const log = new DiagLog(ws, makeDiag(5))
    await log.ensureDir()
    for (let i = 1; i <= 22; i++) {
      await log.record({ level: i % 2 === 0 ? 'error' : 'unexpected', origin: 'tool', message: `evt-${i}` })
    }
    const raw = await readFile(log.file, 'utf8')
    const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '')
    // 压缩阈值 2×max（10）：文件行数稳定在 [max, 2×max) 区间
    assert.ok(lines.length >= 5 && lines.length <= 10, `压缩后行数应在 [5,10]，实际 ${lines.length}`)
    const s = await log.summary()
    assert.equal(s.total, lines.length)
    assert.equal(s.recent[0].message, 'evt-22') // 最新事件保留
    const kept = await log.list()
    assert.ok(!kept.some((e) => e.message === 'evt-1'), '早期事件应被压缩掉')
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('diag: 禁用开关——不落盘、计数恒 0', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-diag6-'))
  try {
    const log = new DiagLog(ws, makeDiag(2000, false))
    await log.ensureDir()
    log.noteUsage('devmemory_status')
    await log.record({ level: 'error', origin: 'tool', message: 'x' })
    const counters = await log.counters()
    assert.equal(counters.total, 0)
    assert.equal(counters.error, 0)
    await assert.rejects(stat(log.file), /ENOENT/)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('diag: fail-open——落盘失败不抛错', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-diag7-'))
  try {
    // 把 diag 路径占成文件 → append 必然失败
    await writeFile(join(ws, 'diag'), 'occupied')
    const log = new DiagLog(ws, makeDiag())
    await log.ensureDir() // mkdir 失败静默
    await log.record({ level: 'error', origin: 'tool', message: '写入会失败但不该抛错' })
    const counters = await log.counters()
    assert.equal(counters.total, 1) // 内存计数照常
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('diag: 字段截断（message/args/stack 有上限）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-diag8-'))
  try {
    const log = new DiagLog(ws, makeDiag())
    await log.ensureDir()
    const long = '甲'.repeat(500)
    await log.record({ level: 'error', origin: 'tool', tool: 'devmemory_x', message: long, args: long, stack: long })
    const [e] = await log.list({ limit: 1 })
    assert.ok(e.message.length <= 301)
    assert.ok(e.args.length <= 301)
    assert.ok(e.stack.length <= 601)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 集成：store + 工具

test('diag 集成: store.init 建 diag 目录；工具异常自动入记 + usage 计数 + status 携带诊断', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-diag-i1-'))
  try {
    const store = new MemoryStore(ws, { ...DEFAULT_CONFIG, vcs: { ...DEFAULT_CONFIG.vcs, enabled: false } })
    await store.init()
    await stat(join(store.root, 'diag', 'events.jsonl'))
    const tools = createTools(store, new DigestEngine(store))

    const statusTool = tools.find((t) => t.name === 'devmemory_status')
    const rememberTool = tools.find((t) => t.name === 'devmemory_remember')
    const diagTool = tools.find((t) => t.name === 'devmemory_diag')
    assert.ok(statusTool && rememberTool && diagTool)

    // 成功调用两次 status → usage 计数
    await statusTool.execute({})
    await statusTool.execute({})

    // 工具异常：remember 空 content → 抛错 + 自动记 error 事件（含参数摘要）
    await assert.rejects(() => rememberTool.execute({ kind: 'preference', content: '' }, {}), /content 不能为空/)
    const s = await store.diag.summary()
    assert.equal(s.total, 1)
    assert.equal(s.error, 1)
    assert.deepEqual(s.byTool, { devmemory_remember: 1 })
    assert.equal(s.byOrigin.tool, 1)
    assert.ok(s.recent[0].args.includes('content'))
    assert.equal(s.usage.devmemory_status, 2)

    // devmemory_status 携带诊断字段
    const st = await statusTool.execute({})
    assert.equal(st.diag.enabled, true)
    assert.equal(st.diag.total, 1)
    assert.equal(st.diag.recent.length, 1)

    // v0.6.2 回归：status 工具是白名单构造返回值，新增的索引陈旧度字段必须显式映射，
    // 否则 store.status() 加了字段但工具输出看不到（曾真实发生）。
    assert.ok('indexDocCount' in st, 'indexDocCount 必须出现在 devmemory_status 输出')
    assert.ok('indexStale' in st, 'indexStale 必须出现在 devmemory_status 输出')
    assert.equal(typeof st.indexStale, 'boolean')
    assert.equal(st.indexStale, false, '空库无快照，不应判为陈旧')
    assert.equal(st.indexDocCount, null, '空库尚无快照，应为 null')

    // devmemory_diag：summary 动作
    const summary = await diagTool.execute({})
    assert.equal(summary.total, 1)
    assert.deepEqual(summary.byTool, { devmemory_remember: 1 })

    // list 动作：按级别过滤
    const listErr = await diagTool.execute({ action: 'list', level: 'error', limit: 10 })
    assert.equal(listErr.total, 1)
    assert.equal(listErr.events[0].level, 'error')
    const listUx = await diagTool.execute({ action: 'list', level: 'unexpected' })
    assert.equal(listUx.total, 0)

    // clear 动作：清空后新一轮观察
    const cleared = await diagTool.execute({ action: 'clear' })
    assert.equal(cleared.cleared, true)
    assert.equal(cleared.totalCleared, 1)
    const after = await diagTool.execute({})
    assert.equal(after.total, 0)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('diag 集成: 会话状态块仅在存在记录时附诊断提示行（boot 块恒不带诊断）', () => {
  const base = {
    ready: true,
    root: '/x/.memory',
    counts: { l1: 1, l2: 1, l3: 1 },
    lastDigestAt: null,
    indexDirty: 0,
    firstRun: false,
    vcs: { enabled: true, available: true, ready: true, branch: 'main', commits: 3, pendingWrites: 0 },
    embedding: { enabled: false, ready: false, degraded: false, model: 'nomic-embed-text', vectorCount: 0 },
  }
  // v0.6.5：诊断计数属易变状态 → 只出现在每会话一次的 status 块里
  const withDiag = renderStatusBlock({ ...base, diag: { enabled: true, total: 3, error: 1, unexpected: 2 } }, 2000)
  assert.ok(withDiag.includes('devmemory_diag'))
  assert.ok(withDiag.includes('诊断'))
  const withoutDiag = renderStatusBlock(base, 2000)
  assert.ok(!withoutDiag.includes('devmemory_diag'))
  // 回归：boot 块（逐请求注入）必须静态，任何状态下都不得出现诊断计数
  const boot = renderBootBlock({ ...base, diag: { enabled: true, total: 3, error: 1, unexpected: 2 } }, 2000)
  assert.ok(!boot.includes('devmemory_diag'))
  assert.ok(!boot.includes('累计'))
})

test('diag: updateConfig 运行时切换（v0.5 设置页 live）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-diag-upd-'))
  try {
    const log = new DiagLog(ws, makeDiag())
    await log.ensureDir()
    // 关闭 → record 不落盘
    log.updateConfig({ enabled: false, maxEvents: 2000 })
    await log.record({ level: 'error', origin: 'tool', message: '不应写入' })
    assert.equal((await log.counters()).total, 0)
    const rawOff = await readFile(log.file, 'utf8')
    assert.equal(rawOff.trim(), '')
    // 重新打开 → 落盘恢复
    log.updateConfig({ enabled: true, maxEvents: 2000 })
    await log.record({ level: 'unexpected', origin: 'vcs', message: '降级 again' })
    assert.equal((await log.counters()).total, 1)
    // 动态收窄上限：maxEvents=1 → 写入越过 2× 上限时压缩，只留最新 1 条
    log.updateConfig({ enabled: true, maxEvents: 1 })
    await log.record({ level: 'unexpected', origin: 'vcs', message: 'evt-2' })
    await log.record({ level: 'unexpected', origin: 'vcs', message: 'evt-3' })
    await log.record({ level: 'unexpected', origin: 'vcs', message: 'evt-4' })
    let lines = (await readFile(log.file, 'utf8')).split(/\r?\n/).filter((l) => l.trim() !== '')
    // 写入后计数 > 2×上限才压缩：稳态在 1~2 条间摆动，但最后一条必为最新事件
    assert.ok(lines.length >= 1 && lines.length <= 2, `行数越界: ${lines.length}`)
    assert.ok(lines[lines.length - 1].includes('evt-4'))
    // 再写一条 → 触发 2× 压缩，恰好只剩最新 1 条
    await log.record({ level: 'unexpected', origin: 'vcs', message: 'evt-5' })
    lines = (await readFile(log.file, 'utf8')).split(/\r?\n/).filter((l) => l.trim() !== '')
    assert.equal(lines.length, 1)
    assert.ok(lines[0].includes('evt-5'))
    // 非法上限钳制为 0（不限）
    log.updateConfig({ enabled: true, maxEvents: NaN })
    assert.equal((await log.summary()).maxEvents, 0)
    log.updateConfig({ enabled: true, maxEvents: -5 })
    assert.equal((await log.summary()).maxEvents, 0)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})