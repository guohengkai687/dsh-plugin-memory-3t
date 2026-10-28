/**
 * evolve.ts — 周演化引擎（v0.10.0：P0 闭环 + P1 LLM 提炼/语义合并 + P2 回放评估/调参 + P3 互链/自检）。
 *
 * 一条闭环：Harvest（采集）→ Reflect（提炼）→ Consolidate（巩固）→ Forget（遗忘）
 *          → Evaluate（回放评估）→ Tune（阈值自调）→ Report（周报）。
 * 设计文档：docs/design/DESIGN-evolve-v0.9.md。
 *
 * 约束（来自实现评审）：
 * - 所有写入都经过 MemoryStore，dryRun 时不落盘、只产出报告；
 * - 每个阶段 fail-open：单个阶段抛错只记进 report.errors，不中断后续阶段；
 * - 调用方负责「按会话 cwd 解析库」（B1 教训），本文件不自取全局 active store；
 * - LLM 是可选增强：客户端为 null / 调用失败时回退启发式，绝不阻塞演化。
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { EvolveConfig, EvolveStageName } from './config.js'
import { inferKind } from './digest.js'
import type { LlmClient } from './llm.js'
import { extractJson } from './llm.js'
import { ageInDays, decaySalience, firstSentence, maxSimilarity, mergeInto, shouldArchive, similarity, tokenizeText } from './lifecycle.js'
import type { EntryKind, EvolveState, MemoryStore, SpaceEntry } from './store.js'

/** 一次运行的可调参数（覆盖 config.evolve 的默认值）。 */
export interface EvolveRunOptions {
  now?: Date
  dryRun?: boolean
  windowDays?: number
  stages?: readonly EvolveStageName[]
  /** v0.10.0：宿主 LLM 客户端（null = 纯启发式）。 */
  llm?: LlmClient | null
}

export interface EvolveCandidate {
  text: string
  kind: EntryKind
  tags: string[]
  topicKey: string
  score: number
  evidence: string[]
}

/** v0.10.0：一次运行里 LLM 的使用情况（用于周报与排障）。 */
export interface LlmUsage {
  used: boolean
  source: 'session' | 'config' | 'none'
  route: string | null
  calls: number
  failures: number
}

/** v0.10.0：tune 阶段的结果。 */
export interface TuneOutcome {
  applied: boolean
  minScore: number
  dedupeThreshold: number
  action: string
}

/** v0.10.0：库自检（重复/孤岛/标签覆盖/陈旧）。 */
export interface EvolveAudit {
  duplicates: number
  orphans: number
  tagCoverage: number
  stale: number
}

export interface EvolveReport {
  at: string
  root: string
  windowDays: number
  dryRun: boolean
  durationMs: number
  stages: Array<{ name: EvolveStageName; ok: boolean; ms: number; notes: string[] }>
  harvest: { scannedLines: number; candidates: number; accepted: number; minScore: number }
  reflect: { drafts: number; mode: 'heuristic' | 'llm' }
  consolidate: {
    created: string[]
    merged: Array<{ id: string; from: string; how: 'literal' | 'semantic' }>
    skipped: number
    linked: Array<{ a: string; b: string }>
  }
  forget: { decayed: number; archived: string[]; skipped: number }
  metrics: {
    entries: number
    churn: number
    coverage: number
    archiveRate: number
    indexKBPerEntry: number | null
    hitAt5: number | null
    wasteAt5: number | null
  }
  audit: EvolveAudit
  tune: TuneOutcome
  llm: LlmUsage
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

const DEFAULT_STAGES: readonly EvolveStageName[] = ['harvest', 'reflect', 'consolidate', 'forget', 'evaluate', 'tune', 'report']

/** 相似度灰区：落在 [GREY_MIN, dedupeThreshold) 的才值得让 LLM 判一次「同一条吗」。 */
const GREY_MIN = 0.3
/** 单次运行里 LLM 语义判定的上限（控成本；超出的按不同条处理）。 */
const MAX_SEMANTIC_JUDGEMENTS = 5
/** 回放评估最多取几条样本查询。 */
const MAX_SAMPLE_QUERIES = 8

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
    const tuning = this.store.evolveState.tuning
    // 生效阈值：tune 调过的优先，否则用配置（tune 关掉时永远走配置）
    const thresholds = {
      minScore: tuning?.current.minScore ?? this.config.harvest.minScore,
      dedupeThreshold: tuning?.current.dedupeThreshold ?? this.config.dedupeThreshold,
    }
    const llm = options.llm ?? null

    const report: EvolveReport = {
      at: now.toISOString(),
      root: this.store.root,
      windowDays,
      dryRun,
      durationMs: 0,
      stages: [],
      harvest: { scannedLines: 0, candidates: 0, accepted: 0, minScore: thresholds.minScore },
      reflect: { drafts: 0, mode: this.config.reflect === 'llm' && llm !== null ? 'llm' : 'heuristic' },
      consolidate: { created: [], merged: [], skipped: 0, linked: [] },
      forget: { decayed: 0, archived: [], skipped: 0 },
      metrics: { entries: 0, churn: 0, coverage: 0, archiveRate: 0, indexKBPerEntry: null, hitAt5: null, wasteAt5: null },
      audit: { duplicates: 0, orphans: 0, tagCoverage: 0, stale: 0 },
      tune: { applied: false, minScore: thresholds.minScore, dedupeThreshold: thresholds.dedupeThreshold, action: 'skipped' },
      llm: {
        used: llm !== null,
        source: llm?.source ?? 'none',
        route: llm === null ? null : `${llm.route.provider}/${llm.route.model}`,
        calls: 0,
        failures: 0,
      },
      report: { path: null, markdown: '' },
      errors: [],
    }

    const entries = await this.store.listEntries()
    const ctx: StageContext = {
      now,
      since,
      dryRun,
      windowDays,
      entries,
      report,
      thresholds,
      llm,
      sampleQueries: [],
      semanticBudget: MAX_SEMANTIC_JUDGEMENTS,
    }

    for (const name of stages) {
      const t0 = Date.now()
      const notes: string[] = []
      let ok = true
      try {
        if (name === 'harvest') await this.stageHarvest(ctx, notes)
        else if (name === 'reflect') await this.stageReflect(ctx, notes)
        else if (name === 'consolidate') await this.stageConsolidate(ctx, notes)
        else if (name === 'forget') await this.stageForget(ctx, notes)
        else if (name === 'evaluate') await this.stageEvaluate(ctx, notes)
        else if (name === 'tune') await this.stageTune(ctx, notes)
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
    const sampleSeen = new Set<string>()
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
        // v0.10.0（P2）：顺手留几条真实用户提问当回放样本（同话题只留一条）
        if (ctx.sampleQueries.length < MAX_SAMPLE_QUERIES && !sampleSeen.has(key)) {
          sampleSeen.add(key)
          ctx.sampleQueries.push(text.slice(0, 120))
        }
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
      if (score < ctx.thresholds.minScore) continue
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
    const candidates = ctx.candidates ?? []
    if (candidates.length === 0) {
      ctx.drafts = []
      ctx.report.reflect.drafts = 0
      notes.push('无候选，跳过提炼')
      return
    }
    // v0.10.0（P1）：默认走当前会话的大模型；失败或未配置时回退启发式
    if (this.config.reflect === 'llm' && ctx.llm !== null) {
      try {
        ctx.drafts = await this.reflectWithLlm(ctx, candidates)
        ctx.report.reflect.mode = 'llm'
        ctx.report.reflect.drafts = ctx.drafts.length
        notes.push(`LLM 提炼 ${ctx.drafts.length} 条 L3 草案（${ctx.llm.route.provider}/${ctx.llm.route.model}）`)
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        notes.push(`LLM 提炼失败，回退启发式：${message}`)
        ctx.report.reflect.mode = 'heuristic'
      }
    }
    ctx.drafts = candidates.map((candidate) => ({
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

  /** 让 LLM 把候选压成 0–5 条 L3 草案；解析失败会抛错，由调用方回退。 */
  private async reflectWithLlm(ctx: StageContext, candidates: EvolveCandidate[]): Promise<StageDraft[]> {
    const existingTitles = ctx.entries
      .filter((entry) => entry.status !== 'archived')
      .slice(0, 30)
      .map((entry) => `- ${entry.summary}`)
      .join('\n')
    const list = candidates
      .map((candidate, index) => `[${index}] tags=${candidate.tags.join(',')} 证据=${candidate.evidence.join('、')}\n${candidate.text}`)
      .join('\n\n')
    const system = '你是长期记忆整理器。把一周会话里的候选整理成最多 5 条长期事实（L3）。只输出 JSON 数组，不要解释。'
    const prompt = [
      '现有 L3 标题（避免重复）：',
      existingTitles === '' ? '（空）' : existingTitles,
      '',
      '候选：',
      list,
      '',
      '要求：',
      '- 最多 5 条，合并同一主题；没有值得长期保留的就输出 []',
      '- summary ≤ 40 字；content 2-5 句、脱离上下文也能读懂；tags 2-4 个中文词或英文小写词',
      '- kind 只能是 decision / preference / entity / context 之一',
      '- index 必须是上面候选的编号',
      '只输出：[{"index":0,"kind":"decision","summary":"…","content":"…","tags":["…"],"importance":"medium"}]',
    ].join('\n')
    const text = await this.completeWithLlm(ctx, system, prompt)
    const parsed = extractJson<unknown>(text)
    if (!Array.isArray(parsed)) throw new Error('LLM 返回的不是 JSON 数组')
    const drafts: StageDraft[] = []
    for (const item of parsed.slice(0, 5)) {
      if (typeof item !== 'object' || item === null) continue
      const raw = item as Record<string, unknown>
      const index = typeof raw.index === 'number' ? raw.index : Number(raw.index)
      if (!Number.isInteger(index) || index < 0 || index >= candidates.length) continue
      const source = candidates[index]
      if (source === undefined) continue
      const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
      const content = typeof raw.content === 'string' ? raw.content.trim() : ''
      if (summary === '' || content === '') continue
      const kind: EntryKind =
        raw.kind === 'decision' || raw.kind === 'preference' || raw.kind === 'entity' || raw.kind === 'context' ? raw.kind : source.kind
      const tags = Array.isArray(raw.tags)
        ? raw.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '').slice(0, 4)
        : []
      drafts.push({
        kind,
        summary: summary.slice(0, 60),
        tags: tags.length > 0 ? tags : source.tags,
        body: [`- 来源：${source.evidence.join('、')}`, `- ${content}`].join('\n'),
        evidence: source.evidence,
        score: source.score,
      })
    }
    if (drafts.length === 0) throw new Error('LLM 没有给出可用条目')
    return drafts
  }

  /** 统一的 LLM 调用入口：统计调用/失败次数（周报与排障用）。 */
  private async completeWithLlm(ctx: StageContext, system: string, prompt: string): Promise<string> {
    const llm = ctx.llm
    if (llm === null) throw new Error('没有可用的 LLM 客户端')
    ctx.report.llm.calls += 1
    try {
      return await llm.complete({
        system,
        prompt,
        maxTokens: this.config.llm.maxTokens,
        timeoutMs: this.config.llm.timeoutMs,
      })
    } catch (error) {
      ctx.report.llm.failures += 1
      throw error
    }
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

      const how = await this.decideMerge(ctx, best, bestScore, draft)
      if (best !== null && how !== null) {
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
        ctx.report.consolidate.merged.push({ id: best.id, from: draft.summary.slice(0, 40), how })
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

    await this.mineLinks(ctx, existing, notes)

    const totalDrafts = (ctx.drafts ?? []).length
    ctx.report.metrics.coverage = totalDrafts === 0 ? 0 : covered / totalDrafts
    notes.push(
      `新增 ${ctx.report.consolidate.created.length} / 合并 ${ctx.report.consolidate.merged.length} / 互链 ${ctx.report.consolidate.linked.length} / 覆盖 ${Math.round(ctx.report.metrics.coverage * 100)}%`,
    )
  }

  /**
   * v0.10.0：判断该不该并入已有条目。
   * - 相似度 ≥ 阈值 → 字面合并；
   * - 落在 [GREY_MIN, 阈值) 且开了 semanticMerge / 有 LLM / 还有判定预算 → 让模型判一次；
   * - 否则新建。
   */
  private async decideMerge(
    ctx: StageContext,
    best: SpaceEntry | null,
    bestScore: number,
    draft: StageDraft,
  ): Promise<'literal' | 'semantic' | null> {
    if (best === null) return null
    if (bestScore >= ctx.thresholds.dedupeThreshold) return 'literal'
    if (bestScore < GREY_MIN) return null
    if (!this.config.semanticMerge || ctx.llm === null || ctx.semanticBudget <= 0) return null
    ctx.semanticBudget -= 1
    try {
      const verdict = await this.completeWithLlm(
        ctx,
        '你是长期记忆去重器。只回答一个词：MERGE 或 KEEP。',
        [
          `A: ${best.summary}`,
          best.body.slice(0, 400),
          '',
          `B: ${draft.summary}`,
          draft.body.slice(0, 400),
          '',
          'A 与 B 是否在讲同一件长期事实？同一条回答 MERGE，否则回答 KEEP。',
        ].join('\n'),
      )
      return /MERGE/iu.test(verdict) && !/KEEP/iu.test(verdict) ? 'semantic' : null
    } catch {
      return null
    }
  }

  /** v0.10.0（P3）：把「相关但不同」的条目互链（每轮上限 link.maxLinks 对，单条最多 2 条边）。 */
  private async mineLinks(ctx: StageContext, entries: SpaceEntry[], notes: string[]): Promise<void> {
    if (!this.config.link.enabled) return
    const maxLinks = Math.max(0, this.config.link.maxLinks)
    if (maxLinks === 0 || entries.length < 2) return
    const pairs: Array<{ a: SpaceEntry; b: SpaceEntry; score: number }> = []
    for (let i = 0; i < entries.length; i += 1) {
      const a = entries[i]
      if (a === undefined) continue
      for (let j = i + 1; j < entries.length; j += 1) {
        const b = entries[j]
        if (b === undefined) continue
        if (a.links.includes(b.id) || b.links.includes(a.id)) continue
        const score = similarity(`${a.summary}\n${a.body}`, `${b.summary}\n${b.body}`)
        if (score >= GREY_MIN && score < ctx.thresholds.dedupeThreshold) pairs.push({ a, b, score })
      }
    }
    pairs.sort((x, y) => y.score - x.score)
    const used = new Map<string, number>()
    for (const pair of pairs) {
      if (ctx.report.consolidate.linked.length >= maxLinks) break
      const na = used.get(pair.a.id) ?? 0
      const nb = used.get(pair.b.id) ?? 0
      if (na >= 2 || nb >= 2) continue
      if (!ctx.dryRun) {
        try {
          const linked = await this.store.linkEntries(pair.a.id, pair.b.id)
          this.replaceEntry(ctx, linked.a)
          this.replaceEntry(ctx, linked.b)
        } catch {
          continue
        }
      }
      used.set(pair.a.id, na + 1)
      used.set(pair.b.id, nb + 1)
      ctx.report.consolidate.linked.push({ a: pair.a.id, b: pair.b.id })
    }
    if (ctx.report.consolidate.linked.length > 0) {
      notes.push(`互链 ${ctx.report.consolidate.linked.length} 对`)
    }
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

  // ------------------------------------------------------------------ evaluate

  /** v0.10.0（P2）：用本周真实提问回放检索，量化 hit@5 / waste@5。 */
  private async stageEvaluate(ctx: StageContext, notes: string[]): Promise<void> {
    const queries = ctx.sampleQueries.slice(0, MAX_SAMPLE_QUERIES)
    if (queries.length === 0) {
      notes.push('窗口内没有可用样本查询，hit@5 置空')
      return
    }
    let hit = 0
    let waste = 0
    for (const query of queries) {
      // touch:false —— 回放不能污染 accesses/salience
      const result = await this.store.recall(query, { maxResults: 5, touch: false })
      const hits = [...result.l1, ...result.l2, ...result.l3]
      if (hits.length === 0) continue
      const queryTokens = new Set(tokenizeText(query))
      const relevant = hits.some((item) => tokenizeText(item.summary).some((token) => queryTokens.has(token)))
      if (relevant) hit += 1
      const top = hits[0]?.score ?? 0
      if (top > 0) waste += hits.filter((item) => item.score < top * GREY_MIN).length / hits.length
    }
    const hitAt5 = hit / queries.length
    const wasteAt5 = waste / queries.length
    ctx.report.metrics.hitAt5 = Math.round(hitAt5 * 1000) / 1000
    ctx.report.metrics.wasteAt5 = Math.round(wasteAt5 * 1000) / 1000
    notes.push(`回放 ${queries.length} 条问句：hit@5 ${Math.round(hitAt5 * 100)}% / waste@5 ${Math.round(wasteAt5 * 100)}%`)
  }

  // ------------------------------------------------------------------ tune

  /** v0.10.0（P2）：按回放结果小幅调阈值；变差就回滚到基线。 */
  private async stageTune(ctx: StageContext, notes: string[]): Promise<void> {
    if (!this.config.tune.enabled) {
      notes.push('tune 未启用（config.evolve.tune.enabled=false）')
      return
    }
    const hit = ctx.report.metrics.hitAt5
    if (hit === null) {
      notes.push('没有 hit@5 数据，跳过调参')
      return
    }
    const state = this.store.evolveState.tuning
    const baseline = state?.baseline ?? { minScore: this.config.harvest.minScore, dedupeThreshold: this.config.dedupeThreshold }
    const current = state?.current ?? { ...baseline }
    const previous = state?.history[state.history.length - 1]?.hitAt5 ?? null
    const maxDelta = Math.max(0.01, Math.min(1, this.config.tune.maxDelta))
    const bound = (value: number, base: number): number =>
      Math.max(0, Math.min(1, Math.max(base * (1 - maxDelta), Math.min(base * (1 + maxDelta), value))))
    let next = { ...current }
    let action = 'keep'
    if (previous !== null && hit < previous - 0.02) {
      next = { ...baseline }
      action = 'revert（hit@5 下降超过 0.02）'
    } else if (hit < 0.5) {
      next = { ...current, minScore: bound(current.minScore - baseline.minScore * 0.1, baseline.minScore) }
      action = 'lower-minScore'
    } else if (ctx.report.metrics.wasteAt5 !== null && ctx.report.metrics.wasteAt5 > 0.6) {
      next = { ...current, minScore: bound(current.minScore + baseline.minScore * 0.1, baseline.minScore) }
      action = 'raise-minScore'
    }
    const history = [
      ...(state?.history ?? []),
      { at: ctx.now.toISOString(), hitAt5: hit, minScore: next.minScore, dedupeThreshold: next.dedupeThreshold, action },
    ].slice(-20)
    const tuning = { baseline, current: next, history }
    const changed = next.minScore !== current.minScore || next.dedupeThreshold !== current.dedupeThreshold
    if (!ctx.dryRun && (changed || state === undefined)) {
      await this.store.updateEvolveState({ tuning })
    }
    ctx.report.tune = { applied: !ctx.dryRun && changed, minScore: next.minScore, dedupeThreshold: next.dedupeThreshold, action }
    notes.push(`tune ${action}：minScore ${next.minScore.toFixed(2)}（基线 ${baseline.minScore.toFixed(2)}）`)
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
    ctx.report.audit = this.auditLibrary(ctx)
    notes.push(
      `自检：重复 ${ctx.report.audit.duplicates} / 孤岛 ${ctx.report.audit.orphans} / 标签覆盖 ${Math.round(ctx.report.audit.tagCoverage * 100)}% / 陈旧 ${ctx.report.audit.stale}`,
    )

    const day = ctx.now.toISOString().slice(0, 10)
    const from = new Date(ctx.now.getTime() - ctx.windowDays * 86_400_000).toISOString().slice(0, 10)
    const markdown = renderWeeklyReview({ day, from, report: ctx.report, dryRun: ctx.dryRun, config: this.config, thresholds: ctx.thresholds })
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

  /** v0.10.0（P3）：库自检 —— 重复对、孤岛条目、标签覆盖、陈旧条目。 */
  private auditLibrary(ctx: StageContext): EvolveAudit {
    const active = ctx.entries.filter((entry) => entry.status !== 'archived' && entry.status !== 'superseded')
    const threshold = ctx.thresholds.dedupeThreshold
    let duplicates = 0
    for (let i = 0; i < active.length; i += 1) {
      const a = active[i]
      if (a === undefined) continue
      for (let j = i + 1; j < active.length; j += 1) {
        const b = active[j]
        if (b === undefined) continue
        if (similarity(`${a.summary}\n${a.body}`, `${b.summary}\n${b.body}`) >= threshold) duplicates += 1
      }
    }
    const orphans = active.filter((entry) => entry.links.length === 0).length
    const tagged = active.filter((entry) => entry.tags.length >= 2).length
    const stale = active.filter(
      (entry) => entry.accesses === 0 && ageInDays(entry.updated, ctx.now) > this.config.forget.minAccessAgeDays,
    ).length
    return {
      duplicates,
      orphans,
      tagCoverage: active.length === 0 ? 0 : tagged / active.length,
      stale,
    }
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
  /** 本轮生效阈值（tune 调过则用调过的）。 */
  thresholds: { minScore: number; dedupeThreshold: number }
  /** 宿主注入的 LLM 客户端；null = 纯启发式。 */
  llm: LlmClient | null
  /** 本周真实用户提问（回放评估的样本）。 */
  sampleQueries: string[]
  /** 本轮还剩多少次语义判定预算。 */
  semanticBudget: number
  candidates?: EvolveCandidate[]
  drafts?: StageDraft[]
}

/** 周报 markdown（同时写进 L2，可被下周的 harvest / recall 读回）。 */
export function renderWeeklyReview(input: {
  day: string
  from: string
  report: EvolveReport
  dryRun: boolean
  config: EvolveConfig
  thresholds?: { minScore: number; dedupeThreshold: number }
}): string {
  const { report } = input
  const thresholds = input.thresholds ?? { minScore: input.config.harvest.minScore, dedupeThreshold: input.config.dedupeThreshold }
  const pct = (n: number): string => `${Math.round(n * 100)}%`
  const num = (n: number | null): string => (n === null ? 'n/a' : `${Math.round(n * 100)}%`)
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
    `| hit@5（回放召回） | ${num(report.metrics.hitAt5)} |`,
    `| waste@5（低分占比） | ${num(report.metrics.wasteAt5)} |`,
    '',
    '## 变更',
    '### 新增 L3',
    list(report.consolidate.created),
    '',
    '### 合并',
    list(report.consolidate.merged.map((m) => `${m.id} ← ${m.from}（${m.how}）`)),
    '',
    '### 互链',
    list(report.consolidate.linked.map((link) => `${link.a} ↔ ${link.b}`)),
    '',
    '### 归档',
    list(report.forget.archived),
    '',
    '### salience 衰减',
    `- ${report.forget.decayed} 条`,
    '',
    '## 采集与提炼',
    `- 扫描 ${report.harvest.scannedLines} 行流水，候选 ${report.harvest.candidates}，采纳 ${report.harvest.accepted}`,
    `- 提炼模式：${report.reflect.mode === 'llm' ? 'LLM（当前会话模型）' : '启发式'}，草案 ${report.reflect.drafts} 条`,
    `- 阈值：minScore ${thresholds.minScore.toFixed(2)} / dedupe ${thresholds.dedupeThreshold.toFixed(2)} / minEvidence ${input.config.harvest.minEvidence}`,
    '',
    '## 自检',
    `- 重复对（≥dedupe 阈值）：${report.audit.duplicates}`,
    `- 孤岛条目（无互链）：${report.audit.orphans}`,
    `- 标签覆盖率（≥2 标签）：${pct(report.audit.tagCoverage)}`,
    `- 陈旧条目（零访问且超期）：${report.audit.stale}`,
    '',
    '## 调参',
    `- 本轮回放 ${report.metrics.hitAt5 === null ? '无样本' : `hit@5 ${num(report.metrics.hitAt5)}、waste@5 ${num(report.metrics.wasteAt5)}`}`,
    `- 动作：${report.tune.action}；minScore ${report.tune.minScore.toFixed(2)} / dedupe ${report.tune.dedupeThreshold.toFixed(2)}${report.tune.applied ? '（已落盘）' : ''}`,
    '',
    '## LLM',
    `- 使用：${report.llm.used ? '是' : '否'}；来源：${report.llm.source}；路由：${report.llm.route ?? 'n/a'}`,
    `- 调用 ${report.llm.calls} 次，失败 ${report.llm.failures} 次`,
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
