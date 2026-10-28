/**
 * evolve.ts — 周演化引擎（v0.9.0 P0）。
 *
 * 一条闭环：Harvest（采集）→ Reflect（提炼）→ Consolidate（巩固）→ Forget（遗忘）→ Report（周报）。
 * 设计文档：docs/design/DESIGN-evolve-v0.9.md。
 *
 * 约束（来自实现评审）：
 * - 所有写入都经过 MemoryStore，dryRun 时不落盘、只产出报告；
 * - 每个阶段 fail-open：单个阶段抛错只记进 report.errors，不中断后续阶段；
 * - 调用方负责「按会话 cwd 解析库」（B1 教训），本文件不自取全局 active store。
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { EvolveConfig, EvolveStageName } from './config.js'
import { inferKind } from './digest.js'
import { ageInDays, decaySalience, firstSentence, maxSimilarity, mergeInto, shouldArchive, similarity, tokenizeText } from './lifecycle.js'
import type { EntryKind, EvolveState, MemoryStore, SpaceEntry } from './store.js'

/** 一次运行的可调参数（覆盖 config.evolve 的默认值）。 */
export interface EvolveRunOptions {
  now?: Date
  dryRun?: boolean
  windowDays?: number
  stages?: readonly EvolveStageName[]
}

export interface EvolveCandidate {
  text: string
  kind: EntryKind
  tags: string[]
  topicKey: string
  score: number
  evidence: string[]
}

export interface EvolveReport {
  at: string
  root: string
  windowDays: number
  dryRun: boolean
  durationMs: number
  stages: Array<{ name: EvolveStageName; ok: boolean; ms: number; notes: string[] }>
  harvest: { scannedLines: number; candidates: number; accepted: number }
  reflect: { drafts: number }
  consolidate: { created: string[]; merged: Array<{ id: string; from: string }>; skipped: number }
  forget: { decayed: number; archived: string[]; skipped: number }
  metrics: {
    entries: number
    churn: number
    coverage: number
    archiveRate: number
    indexKBPerEntry: number | null
    hitAt5: 'P2' | number
    wasteAt5: 'P2' | number
  }
  report: { path: string | null; markdown: string }
  errors: string[]
}

/** 演化判定：距上次运行 ≥ intervalDays（从未运行过视为到期）。 */
export function evolutionDue(state: EvolveState, config: EvolveConfig, now: Date = new Date()): boolean {
  if (!config.enabled) return false
  if (state.lastRunAt === null) return true
  return ageInDays(state.lastRunAt, now) >= config.intervalDays
}

/** 租约是否仍被占用（10 分钟宽限；崩溃后自动可重入）。 */
export function leaseActive(state: EvolveState, now: Date = new Date(), graceMs = 10 * 60_000): boolean {
  if (state.running === null) return false
  const started = Date.parse(state.running)
  if (!Number.isFinite(started)) return false
  return now.getTime() - started < graceMs
}

const DEFAULT_STAGES: readonly EvolveStageName[] = ['harvest', 'reflect', 'consolidate', 'forget', 'report']

/** 过滤明显不是「人类记忆」的流水行：工具回显、团队消息、运行时注入。 */
const SKIP_LINE_RE =
  /(background job |Team message from|You are a (?:teammate|subagent)|Current runtime context|system-reminder|<acp |\[dev-memory\]|^#{1,6}\s)/u

/** 显式记忆信号（与 digest 的 EXPLICIT_MEMORY_RE 同源，但扩展了决策/教训类措辞）。 */
const EXPLICIT_RE = /(记住|记一下|别忘|长期记录|决策|决定|教训|结论|方案|约定|改为|不要|必须|please remember|remember this)/iu

/** 同话题聚类：与已有候选的代表句共享 ≥ 2 个显著标签即并入（同一件事常换措辞）。 */
const MIN_SHARED_TAGS = 2

function sharedTagCount(a: string, b: string): number {
  const left = new Set(pickTags(a, 8))
  let shared = 0
  for (const tag of pickTags(b, 8)) {
    if (left.has(tag)) shared += 1
  }
  return shared
}

/** 常见 CJK 二元组停用词（只用于挑 tag，不影响打分）。 */
const TAG_STOPWORDS = new Set([
  '我们', '你们', '他们', '然后', '因为', '所以', '如果', '但是', '可以', '需要', '这个', '那个', '现在', '已经',
  '还是', '就是', '一个', '这里', '那里', '什么', '怎么', '工作', '问题', '没有', '不是', '之后', '之前', '同时',
])

function stripPrefix(line: string): string | null {
  const match = /^-\s+(?:user|assistant|digest|tool|system):\s*(.*)$/u.exec(line)
  if (match !== null) return (match[1] ?? '').trim()
  if (line.startsWith('- ')) return line.slice(2).trim()
  return null
}

/** 从一段文本里挑 top-N 标签（CJK 二元组 + 英文词，去停用词与纯数字）。 */
export function pickTags(text: string, limit = 4): string[] {
  const counts = new Map<string, number>()
  for (const token of tokenizeText(text)) {
    if (token.length < 2 || /^\d+$/u.test(token) || TAG_STOPWORDS.has(token)) continue
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token)
}

/** 主题键：用 top-2 标签排序拼接，用于把同一主题的多条流水聚成一个候选。 */
function topicKeyOf(text: string): string {
  const tags = pickTags(text, 3)
  if (tags.length === 0) return `len:${text.length}`
  return tags.slice(0, 2).sort().join('|')
}

export class EvolveEngine {
  constructor(
    private readonly store: MemoryStore,
    private readonly config: EvolveConfig,
  ) {}

  /** 运行一次演化；返回可序列化报告。 */
  async run(options: EvolveRunOptions = {}): Promise<EvolveReport> {
    const startedAt = Date.now()
    const now = options.now ?? new Date()
    const dryRun = options.dryRun ?? this.config.dryRun
    const windowDays = options.windowDays ?? this.config.windowDays
    const stages = options.stages ?? this.config.stages ?? DEFAULT_STAGES
    const since = new Date(now.getTime() - windowDays * 86_400_000)

    const report: EvolveReport = {
      at: now.toISOString(),
      root: this.store.root,
      windowDays,
      dryRun,
      durationMs: 0,
      stages: [],
      harvest: { scannedLines: 0, candidates: 0, accepted: 0 },
      reflect: { drafts: 0 },
      consolidate: { created: [], merged: [], skipped: 0 },
      forget: { decayed: 0, archived: [], skipped: 0 },
      metrics: { entries: 0, churn: 0, coverage: 0, archiveRate: 0, indexKBPerEntry: null, hitAt5: 'P2', wasteAt5: 'P2' },
      report: { path: null, markdown: '' },
      errors: [],
    }

    const entries = await this.store.listEntries()
    const ctx: StageContext = { now, since, dryRun, windowDays, entries, report }

    for (const name of stages) {
      const t0 = Date.now()
      const notes: string[] = []
      let ok = true
      try {
        if (name === 'harvest') await this.stageHarvest(ctx, notes)
        else if (name === 'reflect') await this.stageReflect(ctx, notes)
        else if (name === 'consolidate') await this.stageConsolidate(ctx, notes)
        else if (name === 'forget') await this.stageForget(ctx, notes)
        else if (name === 'report') await this.stageReport(ctx, notes)
      } catch (error) {
        ok = false
        const message = error instanceof Error ? error.message : String(error)
        report.errors.push(`${name}: ${message}`)
        notes.push(`失败：${message}`)
      }
      report.stages.push({ name, ok, ms: Date.now() - t0, notes })
    }

    report.durationMs = Date.now() - startedAt
    return report
  }

  // ------------------------------------------------------------------ harvest

  private async stageHarvest(ctx: StageContext, notes: string[]): Promise<void> {
    const dates = (await this.store.listRuntimeDates()).filter((d) => {
      const day = new Date(`${d}T00:00:00Z`)
      return day.getTime() >= ctx.since.getTime()
    })
    const existingTexts = ctx.entries.map((e) => `${e.summary}\n${e.body}`)
    interface Cluster { key: string; rep: string; texts: string[]; dates: string[] }
    const clusters: Cluster[] = []
    let scanned = 0

    for (const date of dates) {
      const raw = await this.store.readRuntime(new Date(`${date}T00:00:00Z`))
      for (const line of raw.split(/\r?\n/)) {
        const text = stripPrefix(line)
        if (text === null || text.length < 16 || text.length > 400) continue
        if (SKIP_LINE_RE.test(text)) continue
        if (text.startsWith('本轮无可沉淀候选')) continue
        scanned += 1
        const key = topicKeyOf(text)
        // 先按 topicKey 精确匹配，再按「共享 ≥2 个显著标签」并入（同一话题换了措辞也能归到一组）
        const found = clusters.find(
          (c) => c.key === key || sharedTagCount(text, c.rep) >= MIN_SHARED_TAGS,
        )
        if (found === undefined) {
          clusters.push({ key, rep: text, texts: [text], dates: [date] })
          continue
        }
        found.texts.push(text)
        if (!found.dates.includes(date)) found.dates.push(date)
        if (text.length > found.rep.length) found.rep = text
      }
    }
    ctx.report.harvest.scannedLines = scanned

    const candidates: EvolveCandidate[] = []
    for (const bucket of clusters) {
      const distinctDates = [...new Set(bucket.dates)].sort()
      if (distinctDates.length < this.config.harvest.minEvidence) continue
      // 代表句：最长的一条（信息量最大），但不超过 200 字
      const representative = bucket.texts.reduce((best, cur) => (cur.length > best.length ? cur : best), '')
      const explicit = EXPLICIT_RE.test(representative) ? 1 : 0
      const freq = Math.min(1, distinctDates.length / 3)
      const lastDate = distinctDates[distinctDates.length - 1] ?? distinctDates[0] ?? ''
      const recency = Math.max(0, 1 - ageInDays(`${lastDate}T00:00:00Z`, ctx.now) / Math.max(1, ctx.windowDays))
      const novelty = 1 - maxSimilarity(representative, existingTexts)
      const recurrence = Math.min(1, distinctDates.length / 2)
      const score = 0.35 * freq + 0.25 * explicit + 0.2 * recency + 0.1 * novelty + 0.1 * recurrence
      if (score < this.config.harvest.minScore) continue
      candidates.push({
        text: representative,
        kind: inferKind(representative),
        tags: pickTags(representative),
        topicKey: bucket.key,
        score: Math.round(score * 1000) / 1000,
        evidence: distinctDates,
      })
    }

    candidates.sort((a, b) => b.score - a.score)
    const accepted = candidates.slice(0, Math.max(1, this.config.harvest.maxCandidates))
    ctx.report.harvest.candidates = candidates.length
    ctx.report.harvest.accepted = accepted.length
    ctx.candidates = accepted
    notes.push(`扫描 ${scanned} 行 / ${dates.length} 个日文件，候选 ${candidates.length}，采纳 ${accepted.length}`)
  }

  // ------------------------------------------------------------------ reflect

  private async stageReflect(ctx: StageContext, notes: string[]): Promise<void> {
    ctx.drafts = (ctx.candidates ?? []).map((candidate) => ({
      kind: candidate.kind,
      summary: firstSentence(candidate.text, 60),
      tags: candidate.tags,
      body: [`- 来源：${candidate.evidence.join('、')}`, `- 原文：${candidate.text}`].join('\n'),
      evidence: candidate.evidence,
      score: candidate.score,
    }))
    ctx.report.reflect.drafts = ctx.drafts.length
    notes.push(`生成 ${ctx.drafts.length} 条 L3 草案（启发式 A 档，无 LLM）`)
  }

  // ------------------------------------------------------------------ consolidate

  private async stageConsolidate(ctx: StageContext, notes: string[]): Promise<void> {
    const existing = ctx.entries.filter((e) => e.status !== 'archived' && e.status !== 'superseded')
    const existingTags = new Set(existing.flatMap((e) => e.tags))
    let covered = 0

    for (const draft of ctx.drafts ?? []) {
      if (draft.tags.some((tag) => existingTags.has(tag))) covered += 1
      const incomingText = `${draft.summary}\n${draft.body}`
      let best: SpaceEntry | null = null
      let bestScore = 0
      for (const entry of existing) {
        const score = similarity(incomingText, `${entry.summary}\n${entry.body}`)
        if (score > bestScore) {
          bestScore = score
          best = entry
        }
      }

      if (best !== null && bestScore >= thresholdOf(this.config)) {
        // 合并：把草案吸收进已有条目（保留旧 id，记 mergedFrom）
        const incoming: SpaceEntry = {
          id: `evolve-${Date.now()}`,
          kind: draft.kind,
          created: ctx.now.toISOString(),
          updated: ctx.now.toISOString(),
          salience: 0.5,
          accesses: 0,
          tags: draft.tags,
          links: [],
          summary: draft.summary,
          body: draft.body,
        }
        const merged = mergeInto(best, incoming, ctx.now)
        if (!ctx.dryRun) {
          const saved = await this.store.updateEntry(best.id, {
            tags: merged.tags,
            mergedFrom: merged.mergedFrom,
            body: merged.body,
            accesses: merged.accesses,
            salience: merged.salience,
          })
          if (saved === null) {
            ctx.report.consolidate.skipped += 1
            continue
          }
          this.replaceEntry(ctx, saved)
        }
        ctx.report.consolidate.merged.push({ id: best.id, from: draft.summary.slice(0, 40) })
      } else {
        if (!ctx.dryRun) {
          const created = await this.store.remember({
            kind: draft.kind,
            content: `${draft.summary}\n${draft.body}`,
            tags: draft.tags,
            importance: 'medium',
          })
          ctx.entries.push(created)
          existing.push(created)
          ctx.report.consolidate.created.push(created.id)
        } else {
          ctx.report.consolidate.created.push(`(dry-run) ${draft.summary.slice(0, 40)}`)
        }
      }
    }

    const totalDrafts = (ctx.drafts ?? []).length
    ctx.report.metrics.coverage = totalDrafts === 0 ? 0 : covered / totalDrafts
    notes.push(`新增 ${ctx.report.consolidate.created.length} / 合并 ${ctx.report.consolidate.merged.length} / 覆盖 ${Math.round(ctx.report.metrics.coverage * 100)}%`)
  }

  // ------------------------------------------------------------------ forget

  private async stageForget(ctx: StageContext, notes: string[]): Promise<void> {
    const thresholds = this.config.forget
    const maxPrune = Math.max(0, thresholds.maxPrune)
    const active = ctx.entries.filter((e) => e.status !== 'archived' && e.status !== 'superseded')
    const archiveCandidates: Array<{ entry: SpaceEntry; salience: number }> = []

    for (const entry of active) {
      const accessesInWindow = entry.accesses > 0 && ageInDays(entry.updated, ctx.now) <= ctx.windowDays ? 1 : 0
      const nextSalience = decaySalience(entry.salience, entry.updated, accessesInWindow, ctx.now, thresholds.halfLifeDays)
      const changed = Math.abs(nextSalience - entry.salience) >= 0.01
      if (changed) {
        ctx.report.forget.decayed += 1
        entry.salience = nextSalience
        if (!ctx.dryRun) {
          const saved = await this.store.updateEntry(entry.id, { salience: nextSalience })
          if (saved !== null) this.replaceEntry(ctx, saved)
        }
      }
      if (shouldArchive({ ...entry, salience: nextSalience }, ctx.now, thresholds)) {
        archiveCandidates.push({ entry, salience: nextSalience })
      }
    }

    for (const item of archiveCandidates.slice(0, maxPrune)) {
      if (ctx.dryRun) {
        ctx.report.forget.archived.push(`(dry-run) ${item.entry.id}`)
        continue
      }
      const ok = await this.store.archiveEntry(
        item.entry.id,
        `evolve: 零访问 ${Math.floor(ageInDays(item.entry.updated, ctx.now))} 天且 salience ${item.salience.toFixed(2)} < ${thresholds.minSalience}`,
        ctx.now,
      )
      if (ok) {
        ctx.report.forget.archived.push(item.entry.id)
      } else {
        ctx.report.forget.skipped += 1
      }
    }
    ctx.report.forget.skipped += Math.max(0, archiveCandidates.length - maxPrune)
    notes.push(`衰减 ${ctx.report.forget.decayed} 条，归档 ${ctx.report.forget.archived.length} 条（上限 ${maxPrune}）`)
  }

  // ------------------------------------------------------------------ report

  private async stageReport(ctx: StageContext, notes: string[]): Promise<void> {
    const total = ctx.entries.length
    // churn 只统计"结构性变化"（新增/合并/归档）；salience 衰减不算变更，否则老库恒为 100%
    const churn =
      total === 0
        ? 0
        : (ctx.report.consolidate.created.length +
            ctx.report.consolidate.merged.length +
            ctx.report.forget.archived.length) /
          total
    ctx.report.metrics.entries = total
    ctx.report.metrics.churn = Math.round(churn * 1000) / 1000
    ctx.report.metrics.archiveRate = total === 0 ? 0 : Math.round((ctx.report.forget.archived.length / total) * 1000) / 1000
    ctx.report.metrics.indexKBPerEntry = await this.indexKBPerEntry(total)

    const day = ctx.now.toISOString().slice(0, 10)
    const from = new Date(ctx.now.getTime() - ctx.windowDays * 86_400_000).toISOString().slice(0, 10)
    const markdown = renderWeeklyReview({ day, from, report: ctx.report, dryRun: ctx.dryRun, config: this.config })
    ctx.report.report.markdown = markdown

    if (!ctx.dryRun) {
      const written = await this.store.note({ relPath: `notes/${day}-weekly-review.md`, body: markdown })
      ctx.report.report.path = written.path
      notes.push(`周报已写入 ${written.path}`)
    } else {
      notes.push('dry-run：周报未落盘（内容见 report.markdown）')
    }

    // 演化后索引里多了新条目/归档 → 标脏，交给下一次读取重建
    if (!ctx.dryRun) await this.store.rebuildIndex()
  }

  private async indexKBPerEntry(entries: number): Promise<number | null> {
    if (entries <= 0) return null
    try {
      const info = await stat(join(this.store.root, 'index.json'))
      return Math.round((info.size / 1024 / entries) * 10) / 10
    } catch {
      return null
    }
  }

  private replaceEntry(ctx: StageContext, next: SpaceEntry): void {
    const index = ctx.entries.findIndex((e) => e.id === next.id)
    if (index >= 0) ctx.entries[index] = next
  }
}

interface StageDraft {
  kind: EntryKind
  summary: string
  tags: string[]
  body: string
  evidence: string[]
  score: number
}

interface StageContext {
  now: Date
  since: Date
  dryRun: boolean
  windowDays: number
  entries: SpaceEntry[]
  report: EvolveReport
  candidates?: EvolveCandidate[]
  drafts?: StageDraft[]
}

function thresholdOf(config: EvolveConfig): number {
  return config.dedupeThreshold
}

/** 周报 markdown（同时写进 L2，可被下周的 harvest / recall 读回）。 */
export function renderWeeklyReview(input: {
  day: string
  from: string
  report: EvolveReport
  dryRun: boolean
  config: EvolveConfig
}): string {
  const { report } = input
  const pct = (n: number): string => `${Math.round(n * 100)}%`
  const list = (items: string[]): string => (items.length === 0 ? '（无）' : items.map((item) => `- ${item}`).join('\n'))
  return [
    `# 周复盘 ${input.day}（窗口 ${input.from} ~ ${input.day}）`,
    '',
    input.dryRun ? '> dry-run：本次未写库，以下为计划变更。' : '> 本次已写库（一条 `[evolve]` git 提交）。',
    '',
    '## 指标',
    '| 指标 | 值 |',
    '|---|---|',
    `| L3 条目 | ${report.metrics.entries} |`,
    `| 变更率 churn | ${pct(report.metrics.churn)} |`,
    `| 标签覆盖率 coverage | ${pct(report.metrics.coverage)} |`,
    `| 归档率 archiveRate | ${pct(report.metrics.archiveRate)} |`,
    `| 索引体积/条目 | ${report.metrics.indexKBPerEntry === null ? 'n/a' : `${report.metrics.indexKBPerEntry} KB`} |`,
    `| hit@5 / waste@5 | 待 P2（回放评估） |`,
    '',
    '## 变更',
    '### 新增 L3',
    list(report.consolidate.created),
    '',
    '### 合并',
    list(report.consolidate.merged.map((m) => `${m.id} ← ${m.from}`)),
    '',
    '### 归档',
    list(report.forget.archived),
    '',
    '### salience 衰减',
    `- ${report.forget.decayed} 条`,
    '',
    '## 采集',
    `- 扫描 ${report.harvest.scannedLines} 行流水，候选 ${report.harvest.candidates}，采纳 ${report.harvest.accepted}`,
    `- 阈值：minScore ${input.config.harvest.minScore} / minEvidence ${input.config.harvest.minEvidence}`,
    '',
    '## 运行',
    ...report.stages.map((s) => `- ${s.name}: ${s.ok ? 'ok' : '失败'}（${s.ms} ms）${s.notes.length > 0 ? ` —— ${s.notes.join('；')}` : ''}`),
    ...(report.errors.length > 0 ? ['', '### 错误', ...report.errors.map((e) => `- ${e}`)] : []),
    '',
  ].join('\n')
}

/**
 * 带租约与状态落盘的完整运行（懒触发 / 工具 / CLI 共用入口）。
 * @returns 运行报告；未启用或租约被占用时返回 null。
 */
export async function runEvolution(
  store: MemoryStore,
  config: EvolveConfig,
  options: EvolveRunOptions = {},
): Promise<EvolveReport | null> {
  const now = options.now ?? new Date()
  if (!config.enabled) return null
  const state = store.evolveState
  if (leaseActive(state, now)) return null
  await store.updateEvolveState({ running: now.toISOString() })
  try {
    const engine = new EvolveEngine(store, config)
    const report = await engine.run(options)
    if (!report.dryRun) {
      await store.flushVcs(`[evolve] weekly ${report.at.slice(0, 10)}`)
    }
    await store.updateEvolveState({
      running: null,
      lastRunAt: report.at,
      lastOutcome: report.errors.length === 0 ? 'ok' : 'partial',
      lastError: report.errors[0] ?? null,
      runs: state.runs + 1,
    })
    return report
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await store.updateEvolveState({
      running: null,
      lastRunAt: new Date().toISOString(),
      lastOutcome: 'error',
      lastError: message,
      runs: state.runs + 1,
    })
    throw error
  }
}
