/**
 * 主动追忆（recall nudge，v0.3 实现，默认关）。
 *
 * 设计（对齐 DESIGN §4.3，参考 ltb）：30–240 分钟随机间隔 + `agent.followup`。
 * 插件只在该开关开启时调度；且对每个根会话最多提醒一次、单次提醒只推给一个
 * 会话（避免打扰），提醒文案明确标注"非用户输入"，模型可忽略。
 *
 * 零运行时依赖：延时实现可注入（默认 Node setTimeout + unref，便于测试与进程退出）。
 */

export const NUDGE_MIN_MS = 30 * 60_000
export const NUDGE_MAX_MS = 240 * 60_000

/** 提醒文案：source 标注本消息来自插件（form: followup），模型应按"指令消息"处理而非真实用户输入。 */
export const NUDGE_MESSAGE =
  '（记忆插件主动提醒，非用户输入）本会话已运行一段时间。若有值得长期复用的结论，' +
  '可执行一次沉淀：用 devmemory_consolidate 触发 digest，或用 devmemory_recall 召回旧记忆核对；不需要就忽略本条。'

/** 在 [minMs, maxMs] 内取随机延时（毫秒）。 */
export function nudgeDelayMs(minMs = NUDGE_MIN_MS, maxMs = NUDGE_MAX_MS, random: () => number = Math.random): number {
  const lo = Math.max(1, minMs)
  const hi = Math.max(lo, maxMs)
  return Math.floor(lo + random() * (hi - lo))
}

export interface DelayHandle {
  cancel(): void
}

export type DelayFn = (ms: number, callback: () => void) => DelayHandle

/** 默认延时实现：Node setTimeout + unref（不阻止进程退出）。 */
export function nodeDelay(ms: number, callback: () => void): DelayHandle {
  const timer = setTimeout(callback, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export interface RecallNudgeOptions {
  /** 总开关（默认 false）。 */
  enabled: boolean
  /** 计时触发后执行的回调（发提醒 / 决策是否提醒），随后自动重新调度。 */
  onFire: () => void
  minMs?: number
  maxMs?: number
  random?: () => number
  /** 延时实现（默认 nodeDelay）。 */
  delay?: DelayFn
}

/** 主动追忆调度器：启用后按随机间隔触发，dispose 可随时停掉。 */
export class RecallNudgeController {
  private timer: DelayHandle | null = null
  private readonly opts: Required<RecallNudgeOptions>

  constructor(opts: RecallNudgeOptions) {
    this.opts = {
      enabled: opts.enabled,
      onFire: opts.onFire,
      minMs: opts.minMs ?? NUDGE_MIN_MS,
      maxMs: opts.maxMs ?? NUDGE_MAX_MS,
      random: opts.random ?? Math.random,
      delay: opts.delay ?? nodeDelay,
    }
  }

  get armed(): boolean {
    return this.timer !== null
  }

  /** 开始调度（已启用且未在调度时才生效）。 */
  start(): void {
    if (!this.opts.enabled || this.timer !== null) return
    this.arm()
  }

  /**
   * 运行时切换开关（v0.5 设置页 live 生效）：开启立即调度，关闭取消待触发计时器。
   * 已在调度中切换 off → 取消；切换 on → 立即 arm（等价 start）。
   */
  setEnabled(enabled: boolean): void {
    this.opts.enabled = enabled
    if (!enabled) {
      this.dispose()
    } else if (this.timer === null) {
      this.arm()
    }
  }

  private arm(): void {
    const ms = nudgeDelayMs(this.opts.minMs, this.opts.maxMs, this.opts.random)
    this.timer = this.opts.delay(ms, () => {
      this.timer = null
      try {
        this.opts.onFire()
      } catch {
        /* nudge 侧失败静默（fail-open） */
      }
      this.arm()
    })
  }

  dispose(): void {
    this.timer?.cancel()
    this.timer = null
  }
}

/** 追忆目标的最小形状（真实 Agent 带 followup）。 */
export interface NudgeAgent {
  followup?(message: unknown): void
}

/**
 * 从已激活的根会话里挑一个"还没提醒过、且支持 followup"的目标。
 * 一次只挑一个（单次提醒收敛），无活动流水时返回 null（不打扰）。
 */
export function pickNudgeTarget(
  rootAgents: ReadonlyMap<string, NudgeAgent>,
  nudged: ReadonlySet<string>,
  hasSessionActivity: boolean,
): { id: string; agent: NudgeAgent } | null {
  if (!hasSessionActivity) return null
  for (const [id, agent] of rootAgents) {
    if (nudged.has(id) || typeof agent.followup !== 'function') continue
    return { id, agent }
  }
  return null
}