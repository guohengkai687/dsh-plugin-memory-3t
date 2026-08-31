/**
 * DigestEngine：会话收尾的确定性沉淀（v0.1 不调用 LLM，零依赖）。
 *
 * 流程：候选提取（显式记忆词的 user 消息）→ dedupe（BM25 阈值）→ promote
 * （事实→L3 条目，超上限转 L2 笔记）→ link（共享 tag 双向关联）→ compact
 * （L1 当日流水压缩）。全程 fail-open：任一步异常只写 meta.digest 状态，
 * 绝不 rethrow（记忆故障不得打断会话）。pending 状态由下一次会话补做。
 */

import { tokenize } from './indexer.js'
import type { EntryKind, MemoryStore, SpaceEntry } from './store.js'

export interface DigestMessage {
  role: 'user' | 'assistant' | string
  text: string
}

export interface DigestSession {
  /** 会话唯一键（同键只 digest 一次，除非 forced）。 */
  key: string
  /** 消息列表（user 候选来源）。 */
  messages: DigestMessage[]
  /** 强制触发（用户说"记一下/整理记忆"或 consolidate 工具）。 */
  forced?: boolean
  /** 触发阈值覆盖（测试用）。 */
  maxMessagesOverride?: number
}

const EXPLICIT_MEMORY_RE = /(记住|记一下|保存到记忆|写入记忆|长期记录|please remember|remember this|save this to memory)/iu

const CLOSING_RE = /(就(?:这样|到这)|结束|完毕|记一下|整理记忆|consolidate)/iu

const HUMAN_SUBSTANCE_RE = /(?:\p{Script=Han}|[a-zA-Z]){4,}/u

export function isExplicitMemoryCandidate(text: string): boolean {
  return EXPLICIT_MEMORY_RE.test(text) && HUMAN_SUBSTANCE_RE.test(text)
}

export function inferKind(text: string): EntryKind {
  if (/偏好|喜欢|习惯|prefer|preference/i.test(text)) return 'preference'
  if (/决定|选(?:择|用|定)|采用|方案|decision|decide/i.test(text)) return 'decision'
  if (/实体|人物|项目|仓库|repo|架构|entity/i.test(text)) return 'entity'
  return 'context'
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : ''))
      .join('\n')
  }
  return ''
}

/**
 * 摘要工具：把某个 L3 条目的关键信息格式化为一行（流水/日志用）。
 */
function entryLine(entry: SpaceEntry): string {
  return `${entry.kind} ${entry.summary}${entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : ''}`
}

export class DigestEngine {
  private readonly digestedKeys = new Set<string>()

  constructor(private readonly store: MemoryStore) {}

  /**
   * 判定并执行沉淀。
   * @returns 本次 digest 的摘要描述（成功时）；未触发/失败时返回 null。
   */
  async maybeDigest(session: DigestSession): Promise<string[] | null> {
    const config = this.store.config.digest
    const messageCount = session.messages.length
    const userText = session.messages.map((m) => m.text).join('\n')
    const isClosing = CLOSING_RE.test(userText)
    const threshold = session.maxMessagesOverride ?? config.maxMessages
    const triggered = session.forced === true || messageCount >= threshold || isClosing
    if (!triggered) return null
    if (!session.forced && this.digestedKeys.has(session.key)) return null
    if (!session.forced) this.digestedKeys.add(session.key)
    return this.run(session)
  }

  /** 实际执行沉淀（fail-open）。 */
  async run(session: DigestSession): Promise<string[] | null> {
    const config = this.store.config.digest
    try {
      const summaries: string[] = []
      const candidates = await this.collectCandidates(session)
      if (candidates.length === 0) {
        const state = { lastRunAt: new Date().toISOString(), pending: false, retries: 0, lastError: null }
        await this.store.updateDigestState(state)
        summaries.push('本轮无可沉淀候选（无显式记忆内容）')
        return summaries
      }
      let promoted = 0
      let deduped = 0
      let overflow = 0
      for (const candidate of candidates) {
        if (promoted >= config.maxPromote) {
          overflow += 1
          continue
        }
        const existing = await this.findDuplicate(candidate)
        if (existing !== null) {
          await this.store.updateEntry(existing.id, {
            salience: Math.min(1, existing.salience + 0.1),
            tags: [...new Set([...existing.tags])],
            body: existing.body,
            summary: existing.summary,
          })
          deduped += 1
          summaries.push(`去重更新 ${existing.id}`)
          continue
        }
        const entry = await this.store.remember({
          kind: inferKind(candidate),
          content: candidate.length > 400 ? `${candidate.slice(0, 397)}…` : candidate,
          tags: [],
        })
        promoted += 1
        summaries.push(`新条目 ${entryLine(entry)}`)
      }
      if (overflow > 0) {
        const relPath = `notes/${new Date().toISOString().slice(0, 10)}-overflow-${Date.now()}.md`
        const body = candidates
          .filter((c) => c.length > 0)
          .slice(config.maxPromote)
          .map((c) => `- ${c}`)
          .join('\n')
        if (body.trim() !== '') {
          await this.store.note({ relPath, body })
          summaries.push(`溢出转笔记 ${relPath}`)
        }
      }
      await this.linkBySharedTags()
      const date = new Date()
      const runtime = await this.store.readRuntime(date)
      if (runtime.split(/\r?\n/).filter((l) => l.startsWith('- ')).length > 80) {
        await this.store.compactRuntime(date, summaries)
        summaries.push('L1 流水已压缩')
      }
      await this.store.bumpCounter('digestTotal')
      await this.store.updateDigestState({ lastRunAt: new Date().toISOString(), pending: false, retries: 0, lastError: null })
      summaries.unshift(`digest 完成：提升 ${promoted}、去重 ${deduped}、溢出 ${overflow}`)
      return summaries
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const state = { pending: true, retries: this.store.digestState.retries + 1, lastError: message }
      await this.store.updateDigestState(state).catch(() => undefined)
      return null
    }
  }

  /** 候选提取：显式记忆词的 user 消息（缺消息时退回当日流水里的候选行）。 */
  private async collectCandidates(session: DigestSession): Promise<string[]> {
    const fromMessages = session.messages
      .filter((m) => m.role === 'user' && isExplicitMemoryCandidate(m.text))
      .map((m) => m.text.trim())
      .filter((t) => t.length > 0)
    if (fromMessages.length > 0) return [...new Set(fromMessages)]
    // 兜底：从当日流水文本提取
    const runtime = await this.store.readRuntime(new Date())
    const lines = runtime.split(/\r?\n/).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim())
    return [...new Set(lines.filter(isExplicitMemoryCandidate))]
  }

  /**
   * dedupe：对 L3 现有条目做 token 重叠比对（扫描式；不依赖可能陈旧的索引缓存）。
   * 相似度 = 交集 / max(1, min(|query|, |entry|))；≥ 阈值判重复。
   */
  private async findDuplicate(text: string): Promise<SpaceEntry | null> {
    const entries = await this.store.listEntries()
    if (entries.length === 0) return null
    const query = text.trim()
    const queryTokens = new Set(tokenize(query))
    let best: SpaceEntry | null = null
    let bestScore = 0
    for (const entry of entries) {
      const entryText = `${entry.summary}\n${entry.body}`
      const entryTokens = new Set(tokenize(entryText))
      let overlap = 0
      for (const token of queryTokens) {
        if (entryTokens.has(token)) overlap += 1
      }
      const score = overlap / Math.max(1, Math.min(queryTokens.size, entryTokens.size))
      if (score > bestScore) {
        bestScore = score
        best = entry
      }
    }
    return best !== null && bestScore >= this.store.config.dedupe.threshold ? best : null
  }

  /** link：新条目与共享 tag 的旧条目互链（至多 4 对）。 */
  private async linkBySharedTags(): Promise<void> {
    const entries = await this.store.listEntries()
    const tagged = entries.filter((e) => e.tags.length > 0)
    let pairs = 0
    for (let i = 0; i < tagged.length && pairs < 4; i++) {
      for (let j = i + 1; j < tagged.length && pairs < 4; j++) {
        const a = tagged[i]!
        const b = tagged[j]!
        const overlap = a.tags.some((t) => b.tags.includes(t))
        if (!overlap) continue
        if (a.links.includes(b.id) || b.links.includes(a.id)) continue
        try {
          await this.store.linkEntries(a.id, b.id)
          pairs += 1
        } catch {
          /* 跳过竞争 */
        }
      }
    }
  }

  /** 补做：上次 pending 且 retries 未超限时，启动一次修复运行。 */
  async runPending(sessionKey: string): Promise<string[] | null> {
    const state = this.store.digestState
    if (!state.pending) return null
    if (state.retries > this.store.config.digest.maxRetries) return null
    const runtime = await this.store.readRuntime(new Date())
    return this.run({ key: sessionKey, messages: [{ role: 'user', text: runtime }], forced: true })
  }
}

/** 供 index.ts / tools 用的纯辅助：从任意 content 形状提取文本。 */
export function messageText(content: unknown): string {
  return extractText(content)
}