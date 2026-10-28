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
      harvest: { scannedLines: 3, candidates: 1, accepted: 1 },
      reflect: { drafts: 1 },
      consolidate: { created: ['ctx-1'], merged: [], skipped: 0 },
      forget: { decayed: 1, archived: [], skipped: 0 },
      metrics: { entries: 2, churn: 0.5, coverage: 1, archiveRate: 0, indexKBPerEntry: 1.2, hitAt5: 'P2', wasteAt5: 'P2' },
      report: { path: null, markdown: '' },
      errors: [],
    },
  })
  assert.match(markdown, /# 周复盘 2026-10-28/)
  assert.match(markdown, /dry-run/)
  assert.match(markdown, /ctx-1/)
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
  assert.equal(run.stages.length, 5)
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
