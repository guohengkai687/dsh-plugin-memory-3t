/**
 * lifecycle.ts — 记忆条目的生命周期纯函数（v0.9.0 周演化 / 日常 recall 共用）。
 *
 * 设计原则：本文件**没有 IO、没有 Date.now()**，时间一律由调用方传入，
 * 这样衰减、归档、合并三个判定都能被单元测试精确钉住（见 test/lifecycle.test.mjs）。
 */
import { tokenize } from './indexer.js'
import type { SpaceEntry } from './store.js'

export const MS_PER_DAY = 86_400_000

/** 遗忘判定参数（来自 config.evolve.forget）。 */
export interface ForgetThresholds {
  /** salience 半衰期（天）。 */
  halfLifeDays: number
  /** 零访问归档的最短年龄（天）。 */
  minAccessAgeDays: number
  /** 低于此 salience 视为「已死」。 */
  minSalience: number
}

/** 把任意数值钳到 [0,1]（NaN → 0）。 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** ISO 时间 → 距今的天数（解析失败按 0 处理）。 */
export function ageInDays(iso: string, now: Date): number {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, (now.getTime() - t) / MS_PER_DAY)
}

/** 窗口内访问对 salience 的加成：每次 +0.05，封顶 0.3。 */
export function accessBoost(accessesInWindow: number): number {
  return Math.min(0.3, 0.05 * Math.max(0, accessesInWindow))
}

/**
 * 衰减公式：`s' = clamp01(s * 0.5^(Δt / halfLifeDays) + accessBoost)`。
 * 含义：没人用的事实按半衰期指数掉分；本周被用过的条目有加成，但不足以抵消长期闲置。
 */
export function decaySalience(
  salience: number,
  updatedIso: string,
  accessesInWindow: number,
  now: Date,
  halfLifeDays: number,
): number {
  const halfLife = halfLifeDays > 0 ? halfLifeDays : 90
  const factor = Math.pow(0.5, ageInDays(updatedIso, now) / halfLife)
  return clamp01(salience * factor + accessBoost(accessesInWindow))
}

/**
 * 是否归档：零访问 + 年龄足够 + salience 已低于阈值。
 * 已归档/已废弃条目不重复处理（幂等）。
 */
export function shouldArchive(
  entry: Pick<SpaceEntry, 'salience' | 'accesses' | 'updated' | 'status'>,
  now: Date,
  thresholds: ForgetThresholds,
): boolean {
  if (entry.status === 'archived' || entry.status === 'superseded') return false
  if (entry.accesses > 0) return false
  if (entry.salience >= thresholds.minSalience) return false
  return ageInDays(entry.updated, now) >= thresholds.minAccessAgeDays
}

/** 文本归一化：小写 + 折叠空白（不做去标点，交给 tokenize）。 */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** 去重后的 token 集合（复用索引层的 CJK 二元组 + 英文词切分）。 */
export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(normalizeText(text)))
}

/** 保序、含重复的 token 序列（标签频次统计用）。 */
export function tokenizeText(text: string): string[] {
  return tokenize(normalizeText(text))
}

/** Jaccard 相似度（0..1）；任一侧为空视为不相似。 */
export function similarity(a: string, b: string): number {
  const ta = tokenSet(a)
  const tb = tokenSet(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const token of ta) {
    if (tb.has(token)) inter += 1
  }
  return inter / (ta.size + tb.size - inter)
}

/** 与一组文本的最大相似度（候选新颖度打分用）。 */
export function maxSimilarity(text: string, others: readonly string[]): number {
  let best = 0
  for (const other of others) {
    const s = similarity(text, other)
    if (s > best) best = s
  }
  return best
}

/** 取首句（按中英文句末标点切），并截断到 maxChars。 */
export function firstSentence(text: string, maxChars = 60): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const cut = normalized.slice(0, maxChars * 2)
  const match = /^(.+?[。！？!?.;；\n])/u.exec(cut)
  const sentence = (match?.[1] ?? normalized).trim()
  return sentence.length > maxChars ? `${sentence.slice(0, maxChars - 1)}…` : sentence
}

/**
 * 合并两条 L3：正文取较长者、tags 取并集、accesses 相加、salience 取大并 +0.05。
 * 返回的新条目保留 base 的 id 与 kind（合并是「吸收」，不是「新建」）。
 */
export function mergeInto(base: SpaceEntry, incoming: SpaceEntry, now: Date): SpaceEntry {
  const tags = [...new Set([...base.tags, ...incoming.tags])].filter((t) => t !== '')
  const mergedFrom = [...new Set([...(base.mergedFrom ?? []), ...(incoming.mergedFrom ?? []), incoming.id])]
  const body = base.body.length >= incoming.body.length ? base.body : incoming.body
  return {
    ...base,
    tags,
    mergedFrom,
    body,
    accesses: base.accesses + incoming.accesses,
    salience: clamp01(Math.max(base.salience, incoming.salience) + 0.05),
    updated: now.toISOString(),
  }
}
