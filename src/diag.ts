/**
 * DiagLog：诊断与异常记录（v0.4 新增）。
 *
 * 目标：插件被调用做记忆管理（devmemory_* 工具、生命周期钩子、digest/vcs/embedding
 * 等工作路径）时，把"调用异常"与"不符合预期的行为"（含 fail-open 降级路径）落盘，
 * 供使用一段时间后审查、汇总，用于优化插件。
 *
 * 设计要点：
 * - 存储：`<库>/diag/events.jsonl`（追加式 JSONL，0600），与三层记忆内容分离，
 *   不入 git 历史（vcs.ensureIgnore 忽略 diag/）、不随 pack 迁移（可重建）。
 * - 级别：`error`（调用异常/失败）/ `unexpected`（降级、回退、不符合预期的行为）。
 * - 计数：内存计数惰性装载（首次访问扫一遍文件），后续 append 只增计数，status/boot
 *   读取零扫描；summary/list 才重新读文件做聚合。
 * - 上限：`diag.maxEvents`（默认 2000，0=不限）。事件数超过 2 倍上限时压缩，
 *   只保留最新 maxEvents 条（防无限增长）。
 * - 工具使用计数：`noteUsage()` 只记进程内内存计数（不落盘），汇总时并出，
 *   用于观察"哪个工具被频繁调用"。
 * - 全程 fail-open：任何磁盘/解析失败都静默吞掉，绝不打断记忆业务。
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { safeJoin } from './paths.js'

export type DiagLevel = 'error' | 'unexpected'

export interface DiagEvent {
  /** ISO 时间。 */
  ts: string
  level: DiagLevel
  /** 来源：init / session / digest / vcs / embed / tool / pre-step / webui / skill / nudge / restore / lifecycle / diag。 */
  origin: string
  /** 异常/行为描述（截断）。 */
  message: string
  /** 归属工具名（工具异常时）。 */
  tool?: string
  /** 工具调用参数摘要（截断，防敏感内容整段落盘）。 */
  args?: string
  /** 错误堆栈（截断，仅 error 级）。 */
  stack?: string
}

export interface DiagConfig {
  /** 诊断记录开关（默认 true）。 */
  enabled: boolean
  /** 事件保留上限（默认 2000；0 = 不限）。超过 2 倍上限触发压缩，只保留最新 maxEvents 条。 */
  maxEvents: number
}

export interface DiagCounters {
  enabled: boolean
  total: number
  error: number
  unexpected: number
  firstTs: string | null
  lastTs: string | null
}

export interface DiagSummary extends DiagCounters {
  maxEvents: number
  byLevel: Record<DiagLevel, number>
  /** 按工具统计的异常数（仅 tool origin 事件）。 */
  byTool: Record<string, number>
  byOrigin: Record<string, number>
  /** 最近事件（新→旧，最多 8 条）。 */
  recent: DiagEvent[]
  /** 本进程各工具调用次数（内存态，重启清零；不入 events 文件）。 */
  usage: Record<string, number>
}

const CAP_MESSAGE = 300
const CAP_STACK = 600
const CAP_ARGS = 300

function truncate(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text
}

export class DiagLog {
  readonly file: string
  private readonly config: DiagConfig
  private loaded = false
  private total = 0
  private errors = 0
  private unexpected = 0
  private firstTs: string | null = null
  private lastTs: string | null = null
  private readonly usage = new Map<string, number>()

  constructor(root: string, config: DiagConfig) {
    this.config = { enabled: config.enabled, maxEvents: Math.max(0, Math.floor(config.maxEvents)) }
    this.file = safeJoin(root, 'diag', 'events.jsonl')
  }

  get enabled(): boolean {
    return this.config.enabled
  }

  /**
   * 实时更新诊断配置（v0.5 设置页 live 生效）：切换开关 / 调整保留上限。
   * 上限收窄不主动压缩文件，等待下次写入触发的 2× 压缩逻辑。
   */
  updateConfig(next: DiagConfig): void {
    this.config.enabled = next.enabled !== false
    const max = typeof next.maxEvents === 'number' && Number.isFinite(next.maxEvents)
      ? Math.max(0, Math.floor(next.maxEvents))
      : 0
    this.config.maxEvents = max
  }

  /** 初始化诊断目录（store.init 调用一次；不可写静默跳过）。 */
  async ensureDir(): Promise<void> {
    if (!this.config.enabled) return
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      await appendFile(this.file, '', { flag: 'a', mode: 0o600 })
    } catch {
      /* 诊断不可写不阻断启动 */
    }
  }

  /** 惰性装载计数（首次访问扫一遍文件；单行损坏只计入 total）。 */
  private async loadCounts(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(this.file, 'utf8')
      for (const line of raw.split(/\r?\n/)) {
        if (line.trim() === '') continue
        this.total += 1
        try {
          const e = JSON.parse(line) as DiagEvent
          if (e.level === 'error') this.errors += 1
          else if (e.level === 'unexpected') this.unexpected += 1
          if (typeof e.ts === 'string') {
            if (this.firstTs === null || e.ts < this.firstTs) this.firstTs = e.ts
            if (this.lastTs === null || e.ts > this.lastTs) this.lastTs = e.ts
          }
        } catch {
          /* 损坏行只计总数 */
        }
      }
    } catch {
      /* 文件不存在/不可读 → 视为空 */
    }
  }

  /**
   * 记录一条事件。全部 fail-open：保留上限之内始终落盘；
   * 记录失败静默吞掉，绝不向调用链抛错。
   */
  async record(input: {
    level: DiagLevel
    origin: string
    message: string
    tool?: string
    args?: string
    stack?: string
  }): Promise<void> {
    if (!this.config.enabled) return
    await this.loadCounts()
    const event: DiagEvent = {
      ts: new Date().toISOString(),
      level: input.level,
      origin: input.origin,
      message: truncate(input.message, CAP_MESSAGE),
      ...(input.tool !== undefined ? { tool: input.tool } : {}),
      ...(input.args !== undefined ? { args: truncate(input.args, CAP_ARGS) } : {}),
      ...(input.stack !== undefined ? { stack: truncate(input.stack, CAP_STACK) } : {}),
    }
    this.total += 1
    if (input.level === 'error') this.errors += 1
    else this.unexpected += 1
    this.lastTs = event.ts
    if (this.firstTs === null) this.firstTs = event.ts
    try {
      await appendFile(this.file, JSON.stringify(event) + '\n', { mode: 0o600 })
    } catch {
      /* 落盘失败静默（fail-open） */
    }
    if (this.config.maxEvents > 0 && this.total > this.config.maxEvents * 2) {
      await this.compact().catch(() => undefined)
    }
  }

  /** 压缩：保留最新 maxEvents 条（上限 0 时永不压缩）。 */
  private async compact(): Promise<void> {
    const max = this.config.maxEvents
    if (max <= 0) return
    const raw = await readFile(this.file, 'utf8')
    const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '')
    if (lines.length <= max) return
    const kept = lines.slice(lines.length - max)
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, kept.length > 0 ? kept.join('\n') + '\n' : '', { mode: 0o600 })
    await rename(tmp, this.file)
    // 重算计数
    this.total = kept.length
    this.errors = 0
    this.unexpected = 0
    this.firstTs = null
    this.lastTs = null
    for (const line of kept) {
      try {
        const e = JSON.parse(line) as DiagEvent
        if (e.level === 'error') this.errors += 1
        else if (e.level === 'unexpected') this.unexpected += 1
        if (typeof e.ts === 'string') {
          if (this.firstTs === null || e.ts < this.firstTs) this.firstTs = e.ts
          if (this.lastTs === null || e.ts > this.lastTs) this.lastTs = e.ts
        }
      } catch {
        /* ignore */
      }
    }
  }

  /** 本进程工具使用计数（内存态，重置/重启清零；不落盘）。 */
  noteUsage(toolName: string): void {
    this.usage.set(toolName, (this.usage.get(toolName) ?? 0) + 1)
  }

  /** 计数快照（status / boot 用；首次访问惰性扫描，之后走内存）。 */
  async counters(): Promise<DiagCounters> {
    await this.loadCounts()
    return {
      enabled: this.config.enabled,
      total: this.total,
      error: this.errors,
      unexpected: this.unexpected,
      firstTs: this.firstTs,
      lastTs: this.lastTs,
    }
  }

  /** 明细：按级别/工具/来源/时间窗过滤，新→旧，默认最近 20 条（上限 100）。 */
  async list(opts: {
    level?: DiagLevel
    tool?: string
    origin?: string
    days?: number
    limit?: number
  } = {}): Promise<DiagEvent[]> {
    await this.loadCounts()
    const since = opts.days !== undefined && Number.isFinite(opts.days) && opts.days > 0 ? Date.now() - opts.days * 86_400_000 : null
    const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 20)))
    const out: DiagEvent[] = []
    try {
      const raw = await readFile(this.file, 'utf8')
      for (const line of raw.split(/\r?\n/)) {
        if (line.trim() === '') continue
        try {
          const e = JSON.parse(line) as DiagEvent
          if (opts.level !== undefined && e.level !== opts.level) continue
          if (opts.tool !== undefined && e.tool !== opts.tool) continue
          if (opts.origin !== undefined && e.origin !== opts.origin) continue
          if (since !== null && new Date(e.ts).getTime() < since) continue
          out.push(e)
        } catch {
          /* 跳过损坏行 */
        }
      }
    } catch {
      /* 文件缺失 → 空明细 */
    }
    return out.reverse().slice(0, limit)
  }

  /** 汇总：分级/分工具/分来源计数 + 最近事件 + 本进程工具使用次数。 */
  async summary(): Promise<DiagSummary> {
    await this.loadCounts()
    const byLevel: Record<DiagLevel, number> = { error: 0, unexpected: 0 }
    const byTool: Record<string, number> = {}
    const byOrigin: Record<string, number> = {}
    const recent: DiagEvent[] = []
    try {
      const raw = await readFile(this.file, 'utf8')
      const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '')
      for (const line of lines) {
        try {
          const e = JSON.parse(line) as DiagEvent
          if (e.level === 'error') byLevel.error += 1
          else if (e.level === 'unexpected') byLevel.unexpected += 1
          if (e.origin !== undefined) byOrigin[e.origin] = (byOrigin[e.origin] ?? 0) + 1
          if (e.tool !== undefined) byTool[e.tool] = (byTool[e.tool] ?? 0) + 1
        } catch {
          /* 损坏行不计入分组 */
        }
      }
      for (const line of lines.slice(-8)) {
        try {
          recent.push(JSON.parse(line) as DiagEvent)
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* 文件缺失 */
    }
    recent.reverse()
    const usage: Record<string, number> = {}
    for (const [name, count] of [...this.usage.entries()].sort((a, b) => b[1] - a[1])) {
      usage[name] = count
    }
    return {
      enabled: this.config.enabled,
      maxEvents: this.config.maxEvents,
      total: this.total,
      error: this.errors,
      unexpected: this.unexpected,
      firstTs: this.firstTs,
      lastTs: this.lastTs,
      byLevel,
      byTool,
      byOrigin,
      recent,
      usage,
    }
  }

  /** 清空记录（清空后开启新一轮观察窗口）；返回被清空的事件数。 */
  async clear(): Promise<{ totalCleared: number }> {
    await this.loadCounts()
    const totalCleared = this.total
    try {
      await writeFile(this.file, '', { mode: 0o600 })
    } catch {
      /* 清空失败静默 */
    }
    this.total = 0
    this.errors = 0
    this.unexpected = 0
    this.firstTs = null
    this.lastTs = null
    this.usage.clear()
    return { totalCleared }
  }
}