import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG } from '../dist/config.js'
import { evolutionDue, leaseActive, pickTags, renderWeeklyReview, runEvolution } from '../dist/evolve.js'
import { decaySalience, mergeInto, shouldArchive, similarity, tokenSet } from '../dist/lifecycle.js'
import { MemoryStore } from '../dist/store.js'

const DAY = 86_400_000
const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'dev-memory-evolve.mjs')

/** 构造一份把阈值放宽到「单日单条即可采纳」的 config（集成测试用）。 */
function looseConfig(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    evolve: {
      ...DEFAULT_CONFIG.evolve,
      ...overrides,
      harvest: { ...DEFAULT_CONFIG.evolve.harvest, minScore: 0, minEvidence: 1, ...(overrides.harvest ?? {}) },
      forget: { ...DEFAULT_CONFIG.evolve.forget, ...(overrides.forget ?? {}) },
    },
  }
}

async function makeStore(config = looseConfig()) {
  const root = await mkdtemp(join(tmpdir(), 'evolve-'))
  const store = new MemoryStore(root, config)
  await store.init()
  return { root, store }
}

function iso(ms) {
  return new Date(ms).toISOString()
}

async function readMaybe(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** 直接改条目文件的 frontmatter 来「伪造年龄」（updateEntry 会强制刷新 updated）。 */
async function backdate(root, id, { updated, salience, accesses }) {
  const path = join(root, '.memory', 'spaces', `${id}.md`)
  let raw = await readFile(path, 'utf8')
  raw = raw.replace(/^updated: .*$/mu, `updated: ${updated}`)
  if (salience !== undefined) raw = raw.replace(/^salience: .*$/mu, `salience: ${salience}`)
  if (accesses !== undefined) raw = raw.replace(/^accesses: .*$/mu, `accesses: ${accesses}`)
  await writeFile(path, raw, 'utf8')
}

// ---------------------------------------------------------------- 纯函数

test('evolve(v0.9.0): decaySalience 半衰期 90 天减半，访问加成封顶 0.3', () => {
  const now = new Date('2026-10-28T00:00:00.000Z')
  const old = iso(now.getTime() - 90 * DAY)
  assert.equal(decaySalience(1, old, 0, now, 90).toFixed(2), '0.50')
  assert.equal(decaySalience(1, old, 4, now, 90).toFixed(2), '0.70')
  assert.equal(decaySalience(1, old, 100, now, 90), 0.8)
  assert.equal(decaySalience(1, iso(now.getTime()), 0, now, 90), 1)
})

test('evolve(v0.9.0): shouldArchive 只在零访问 + 超龄 + 低 salience 时成立', () => {
  const now = new Date('2026-10-28T00:00:00.000Z')
  const thresholds = { halfLifeDays: 90, minAccessAgeDays: 90, minSalience: 0.2 }
  const base = {
    id: 'ctx-1',
    kind: 'context',
    content: '旧条目',
    tags: [],
    created: iso(now.getTime() - 200 * DAY),
    updated: iso(now.getTime() - 200 * DAY),
    accesses: 0,
    salience: 0.1,
    importance: 'medium',
    links: [],
    source: '',
  }
  assert.equal(shouldArchive(base, now, thresholds), true)
  assert.equal(shouldArchive({ ...base, accesses: 1 }, now, thresholds), false)
  assert.equal(shouldArchive({ ...base, salience: 0.5 }, now, thresholds), false)
  assert.equal(shouldArchive({ ...base, updated: iso(now.getTime() - 10 * DAY) }, now, thresholds), false)
  assert.equal(shouldArchive({ ...base, status: 'superseded' }, now, thresholds), false)
})

test('evolve(v0.9.0): similarity 为 Jaccard，mergeInto 合并 tags/accesses/mergedFrom', () => {
  assert.equal(similarity('pnpm 安装 失败', 'pnpm 安装 失败'), 1)
  assert.equal(similarity('pnpm 安装 失败', 'git 推送 超时'), 0)
  assert.ok(similarity('pnpm 安装 失败', 'pnpm 安装 报错') > 0)
  assert.equal(tokenSet('AB ab').size, 1)

  const now = new Date('2026-10-28T00:00:00.000Z')
  const base = {
    id: 'ctx-a',
    kind: 'context',
    content: 'pnpm 安装失败要清缓存后重装，这是长期约定。',
    body: 'pnpm 安装失败要清缓存后重装，这是长期约定。',
    tags: ['pnpm'],
    created: iso(now.getTime() - DAY),
    updated: iso(now.getTime() - DAY),
    accesses: 2,
    salience: 0.5,
    importance: 'medium',
    links: ['ctx-x'],
    source: 's',
  }
  const incoming = {
    ...base,
    id: 'ctx-b',
    content: 'pnpm 安装报错时先清缓存，再重装依赖，必须照做。',
    body: 'pnpm 安装报错时先清缓存，再重装依赖，必须照做。这是更完整的描述，应该被保留为合并后的正文。',
    tags: ['安装'],
    accesses: 3,
    salience: 0.8,
  }
  const merged = mergeInto(base, incoming, now)
  assert.equal(merged.id, 'ctx-a')
  assert.deepEqual([...merged.tags].sort(), ['pnpm', '安装'].sort())
  assert.equal(merged.accesses, 5)
  assert.deepEqual(merged.mergedFrom, ['ctx-b'])
  assert.ok(merged.salience >= 0.8)
  assert.equal(merged.body, incoming.body)
})

test('evolve(v0.9.0): evolutionDue / leaseActive / pickTags / 周报渲染', () => {
  const now = new Date('2026-10-28T00:00:00.000Z')
  const empty = { lastRunAt: null, running: null, runs: 0, lastOutcome: null, lastError: null }
  assert.equal(evolutionDue(empty, DEFAULT_CONFIG.evolve, now), true)
  assert.equal(evolutionDue({ ...empty, lastRunAt: iso(now.getTime() - 6 * DAY), runs: 1, lastOutcome: 'ok' }, DEFAULT_CONFIG.evolve, now), false)
  assert.equal(evolutionDue({ ...empty, lastRunAt: iso(now.getTime() - 8 * DAY), runs: 1, lastOutcome: 'ok' }, DEFAULT_CONFIG.evolve, now), true)
  assert.equal(evolutionDue(empty, { ...DEFAULT_CONFIG.evolve, enabled: false }, now), false)

  assert.equal(leaseActive(empty, now), false)
  assert.equal(leaseActive({ ...empty, running: iso(now.getTime() - 60_000) }, now), true)
  assert.equal(leaseActive({ ...empty, running: iso(now.getTime() - 20 * 60_000) }, now), false)

  const tags = pickTags('pnpm 安装失败 清除缓存 重装依赖 pnpm', 3)
  assert.ok(tags.length <= 3)
  assert.ok(tags.includes('pnpm'))
  assert.ok(tags.every((t) => t.length >= 2 && !/^\d+$/u.test(t)))

  const markdown = renderWeeklyReview({
    day: '2026-10-28',
    from: '2026-10-21',
    dryRun: true,
    config: DEFAULT_CONFIG.evolve,
    report: {
      at: 'x',
      root: 'r',
      windowDays: 7,
      dryRun: true,
      durationMs: 1,
      stages: [{ name: 'harvest', ok: true, ms: 1, notes: ['ok'] }],
      harvest: { scannedLines: 3, candidates: 1, accepted: 1, minScore: 0.45 },
      reflect: { drafts: 1, mode: 'llm' },
      consolidate: { created: ['ctx-1'], merged: [{ id: 'ctx-2', from: 'x', how: 'semantic' }], skipped: 0, linked: [{ a: 'ctx-1', b: 'ctx-3' }] },
      forget: { decayed: 1, archived: [], skipped: 0 },
      metrics: { entries: 2, churn: 0.5, coverage: 1, archiveRate: 0, indexKBPerEntry: 1.2, hitAt5: 0.75, wasteAt5: 0.25 },
      audit: { duplicates: 1, orphans: 2, tagCoverage: 0.5, stale: 0 },
      tune: { applied: true, minScore: 0.41, dedupeThreshold: 0.55, action: 'lower-minScore' },
      llm: { used: true, source: 'session', route: 'deepseek/deepseek-chat', calls: 2, failures: 0 },
      report: { path: null, markdown: '' },
      errors: [],
    },
  })
  assert.match(markdown, /# 周复盘 2026-10-28/)
  assert.match(markdown, /dry-run/)
  assert.match(markdown, /ctx-1/)
  assert.match(markdown, /hit@5（回放召回） \| 75%/)
  assert.match(markdown, /deepseek\/deepseek-chat/)
  assert.match(markdown, /lower-minScore/)
})

// ---------------------------------------------------------------- 集成

test('evolve(v0.9.0): dry-run 不写库，正式运行写 L3 + 周报 + 演化状态', async (t) => {
  const { root, store } = await makeStore()
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const now = new Date('2026-10-28T00:00:00.000Z')
  for (const day of ['2026-10-26', '2026-10-27']) {
    await store.appendRuntime(new Date(`${day}T10:00:00.000Z`), '- user: 记住：这个项目必须支持 Node 22，不要引入新的运行时依赖。')
    await store.appendRuntime(new Date(`${day}T10:05:00.000Z`), '- user: 决策：所有提交都必须走 pnpm 而不是 npm。')
  }
  const before = await store.listEntries()
  const notePath = join(root, '.memory', 'docs', 'notes', '2026-10-28-weekly-review.md')

  const dry = await runEvolution(store, store.config.evolve, { now, dryRun: true })
  assert.ok(dry !== null)
  assert.equal(dry.dryRun, true)
  assert.equal((await store.listEntries()).length, before.length, 'dry-run 不得新增条目')
  assert.equal(await readMaybe(notePath), null, 'dry-run 不得写周报')
  assert.match(dry.report.markdown, /dry-run/)

  const run = await runEvolution(store, store.config.evolve, { now })
  assert.ok(run !== null)
  assert.equal(run.dryRun, false)
  assert.equal(run.stages.length, 7)
  assert.ok(run.stages.every((s) => s.ok), `阶段失败: ${JSON.stringify(run.stages)}`)
  const after = await store.listEntries()
  assert.ok(after.length > before.length, '正式运行应新增 L3')
  const note = await readMaybe(notePath)
  assert.ok(note !== null && note.includes('# 周复盘'))

  const state = store.evolveState
  assert.equal(state.running, null)
  assert.equal(state.runs, 2, 'dry-run 与正式运行各计一次')
  assert.equal(state.lastOutcome, 'ok')
  assert.equal(state.lastRunAt, run.at)
})

test('evolve(v0.9.0): 零访问超龄条目被归档（可 restore），dry-run 只报告', async (t) => {
  const { root, store } = await makeStore(looseConfig({ stages: ['forget', 'report'] }))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const now = new Date('2026-10-28T00:00:00.000Z')
  const old = await store.remember({ kind: 'context', content: '很久以前的一次临时排查记录，只此一条。' })
  await backdate(root, old.id, { updated: iso(now.getTime() - 200 * DAY), salience: 0.1, accesses: 0 })
  const kept = await store.remember({ kind: 'decision', content: '长期有效的约定：所有脚本必须 ASCII。' })
  await backdate(root, kept.id, { updated: iso(now.getTime() - 100 * DAY), salience: 0.9, accesses: 0 })

  const dry = await runEvolution(store, store.config.evolve, { now, dryRun: true })
  assert.ok(dry !== null)
  assert.ok(dry.forget.archived.some((id) => id.includes(old.id)))
  assert.equal((await store.listArchived()).length, 0)

  const run = await runEvolution(store, store.config.evolve, { now })
  assert.ok(run !== null)
  assert.ok(run.forget.archived.includes(old.id))
  const archived = await store.listArchived()
  assert.equal(archived.length, 1)
  assert.ok(archived[0].endsWith(old.id))
  assert.equal((await store.listEntries()).some((e) => e.id === old.id), false)
  assert.equal((await store.listEntries()).some((e) => e.id === kept.id), true)
  const months = await readdir(join(root, '.memory', 'spaces', 'archive'))
  assert.ok(months.length >= 1)
  const files = await readdir(join(root, '.memory', 'spaces', 'archive', months[0]))
  assert.ok(files.some((f) => f.startsWith(old.id)))

  assert.equal(await store.restoreEntry(old.id), true)
  assert.equal((await store.listArchived()).length, 0)
  assert.ok((await store.listEntries()).some((e) => e.id === old.id))
})

test('evolve(v0.9.0): 距上次运行不足 intervalDays 不触发；租约占用时跳过', async (t) => {
  const { root, store } = await makeStore()
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const now = new Date('2026-10-28T00:00:00.000Z')
  await runEvolution(store, store.config.evolve, { now })
  assert.equal(evolutionDue(store.evolveState, store.config.evolve, new Date(now.getTime() + DAY)), false)
  assert.equal(evolutionDue(store.evolveState, store.config.evolve, new Date(now.getTime() + 8 * DAY)), true)

  const future = new Date(now.getTime() + 8 * DAY)
  await store.updateEvolveState({ running: future.toISOString() })
  assert.equal(await runEvolution(store, store.config.evolve, { now: future }), null, '租约占用时直接跳过')
  assert.equal(await runEvolution(store, { ...store.config.evolve, enabled: false }, { now: future }), null)
})

test('evolve(v0.9.0): CLI 入口 --dry-run --json 不写库', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'evolve-cli-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const r = spawnSync(process.execPath, [CLI, '--root', root, '--dry-run', '--json'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const report = JSON.parse(r.stdout)
  assert.equal(report.dryRun, true)
  assert.equal(report.report.path, null)
  const day = report.at.slice(0, 10)
  assert.equal(await readMaybe(join(root, '.memory', 'docs', 'notes', `${day}-weekly-review.md`)), null)

  // 未知阶段 → 非零退出且给出可用阶段的提示
  const bad = spawnSync(process.execPath, [CLI, '--root', root, '--stages', 'nope'], { encoding: 'utf8' })
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /未知阶段/u)
})

// ---------------------------------------------------------------- v0.10.0（P1–P3）

/** 假的 LLM 客户端（形状与 dist/llm.js 的 LlmClient 一致）。 */
function fakeLlm(complete, route = { provider: 'deepseek', model: 'deepseek-chat' }) {
  return { route, source: 'session', complete }
}

test('evolve(v0.10.0): LLM 提炼解析 JSON 并落库，调用计入报告', async (t) => {
  const { root, store } = await makeStore(looseConfig({ stages: ['harvest', 'reflect', 'consolidate', 'report'] }))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const now = new Date('2026-10-28T00:00:00.000Z')
  await store.appendRuntime(new Date('2026-10-27T10:00:00.000Z'), '- user: 记住：所有提交必须走 pnpm，不要引入新的运行时依赖。')
  const seen = []
  const llm = fakeLlm(async (request) => {
    seen.push(request)
    return '```json\n[{"index":0,"kind":"decision","summary":"提交统一用 pnpm","content":"所有提交都必须走 pnpm，不引入新的运行时依赖。","tags":["pnpm","依赖"]}]\n```'
  })
  const run = await runEvolution(store, store.config.evolve, { now, llm })
  assert.ok(run !== null)
  assert.equal(run.reflect.mode, 'llm')
  assert.equal(run.llm.calls, 1)
  assert.equal(run.llm.failures, 0)
  assert.equal(run.llm.source, 'session')
  assert.match(seen[0].system, /长期记忆/u)
  const entries = await store.listEntries()
  assert.ok(entries.some((entry) => entry.summary === '提交统一用 pnpm'))
})

test('evolve(v0.10.0): LLM 失败时回退启发式且不中断', async (t) => {
  const { root, store } = await makeStore(looseConfig({ stages: ['harvest', 'reflect', 'consolidate', 'report'] }))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const now = new Date('2026-10-28T00:00:00.000Z')
  await store.appendRuntime(new Date('2026-10-27T10:00:00.000Z'), '- user: 记住：所有提交必须走 pnpm，不要引入新的运行时依赖。')
  const llm = fakeLlm(async () => {
    throw new Error('boom')
  })
  const run = await runEvolution(store, store.config.evolve, { now, llm })
  assert.ok(run !== null)
  assert.equal(run.reflect.mode, 'heuristic')
  assert.ok(run.reflect.drafts > 0)
  assert.equal(run.llm.failures, 1)
  assert.equal(run.errors.length, 0, 'LLM 失败不应算演化错误')
  assert.ok((await store.listEntries()).length > 0, '回退启发式仍应写入')
})

test('evolve(v0.10.0): evaluate 回放传 touch:false，不污染 accesses 且给出 hit@5', async (t) => {
  const { root, store } = await makeStore(looseConfig({ stages: ['harvest', 'evaluate'], reflect: 'heuristic' }))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const now = new Date('2026-10-28T00:00:00.000Z')
  const entry = await store.remember({ kind: 'decision', content: '提交必须走 pnpm，锁文件一起提交。' })
  await store.appendRuntime(new Date('2026-10-27T10:00:00.000Z'), '- user: 提交必须走 pnpm 这件事还记得吗')
  const before = await store.readEntry(entry.id)
  const run = await runEvolution(store, store.config.evolve, { now, llm: null })
  assert.ok(run !== null)
  assert.equal(typeof run.metrics.hitAt5, 'number')
  assert.equal(typeof run.metrics.wasteAt5, 'number')
  const after = await store.readEntry(entry.id)
  assert.equal(after.accesses, before.accesses, '回放不得增加 accesses')
})

test('evolve(v0.10.0): tune 在 hit@5 偏低时记录动作并落盘 tuning', async (t) => {
  const { root, store } = await makeStore(
    looseConfig({ stages: ['harvest', 'evaluate', 'tune'], reflect: 'heuristic', tune: { enabled: true, maxDelta: 0.2 } }),
  )
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const now = new Date('2026-10-28T00:00:00.000Z')
  await store.appendRuntime(new Date('2026-10-27T10:00:00.000Z'), '- user: 库根串库的问题应该怎么排查才不会再写错库')
  const run = await runEvolution(store, store.config.evolve, { now, llm: null })
  assert.ok(run !== null)
  assert.equal(run.tune.action, 'lower-minScore')
  const tuning = store.evolveState.tuning
  assert.ok(tuning !== undefined, 'tuning 应写入 meta')
  assert.equal(tuning.history.length, 1)
  assert.equal(tuning.history[0].action, 'lower-minScore')
})

test('evolve(v0.10.0): 灰区相似条目被互链（不合并）', async (t) => {
  const { root, store } = await makeStore(looseConfig({ stages: ['consolidate'], reflect: 'heuristic' }))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const now = new Date('2026-10-28T00:00:00.000Z')
  const a = await store.remember({ kind: 'decision', content: '所有提交必须走 pnpm 而不是 npm，锁文件要一起提交' })
  const b = await store.remember({ kind: 'decision', content: '所有提交必须走 pnpm 而不是 npm，CI 里也要用 pnpm 安装依赖' })
  const run = await runEvolution(store, store.config.evolve, { now, llm: null })
  assert.ok(run !== null)
  assert.ok(run.consolidate.linked.length >= 1, `未互链：${JSON.stringify(run.consolidate)}`)
  const entries = await store.listEntries()
  const linkedA = entries.find((entry) => entry.id === a.id)
  assert.ok(linkedA.links.includes(b.id))
  assert.equal(entries.length, 2, '互链不应新建或合并条目')
})
