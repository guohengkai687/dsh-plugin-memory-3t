/**
 * v0.3 主动追忆（recallNudge）测试。
 *
 * - 纯逻辑：随机延时在 [min,max] 内；目标挑选（只挑没提醒过的、支持 followup 的根会话）。
 * - 调度器：启用才 arm；触发后回调 + 重新调度；dispose 停止。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NUDGE_MESSAGE,
  NUDGE_MIN_MS,
  NUDGE_MAX_MS,
  RecallNudgeController,
  nudgeDelayMs,
  pickNudgeTarget,
} from '../dist/nudge.js'

test('nudge: 随机延时落在 [min,max] 内', () => {
  for (let i = 0; i < 100; i++) {
    const d = nudgeDelayMs(100, 500, () => i / 100)
    assert.ok(d >= 100 && d <= 500, `延时越界: ${d}`)
  }
  assert.equal(nudgeDelayMs(100, 500, () => 0), 100)
  assert.equal(nudgeDelayMs(100, 500, () => 0.999999), 499)
  // 默认边界符合设计（30–240 分钟）
  assert.equal(NUDGE_MIN_MS, 30 * 60_000)
  assert.equal(NUDGE_MAX_MS, 240 * 60_000)
})

test('nudge: 提醒文案标注非用户输入', () => {
  assert.ok(NUDGE_MESSAGE.includes('非用户输入'))
  assert.ok(NUDGE_MESSAGE.includes('devmemory_consolidate'))
  assert.ok(NUDGE_MESSAGE.includes('devmemory_recall'))
})

test('nudge: 目标挑选（跳过已提醒 / 无 followup / 无活动）', () => {
  const agents = new Map([
    ['root1', { followup() {} }],
    ['no-followup', {}],
    ['root3', { followup() {} }],
  ])
  // 无活动流水 → 不打扰
  assert.equal(pickNudgeTarget(agents, new Set(), false), null)
  // 有活动 → 挑第一个可用的（按注册序）
  const pick1 = pickNudgeTarget(agents, new Set(), true)
  assert.equal(pick1?.id, 'root1')
  // 已提醒 root1 → 跳过；无 followup 的跳过 → root3
  const pick2 = pickNudgeTarget(agents, new Set(['root1']), true)
  assert.equal(pick2?.id, 'root3')
  // 全部提醒过 → null
  assert.equal(pickNudgeTarget(agents, new Set(['root1', 'root3']), true), null)
})

test('nudge: 调度器启用才 arm，触发后回调并重新调度，dispose 停止', () => {
  const fired = []
  const scheduled = []
  const delay = (ms, cb) => {
    const handle = {
      ms,
      cancelled: false,
      cancel() {
        this.cancelled = true
      },
      fire() {
        cb()
      },
    }
    scheduled.push(handle)
    return handle
  }
  const controller = new RecallNudgeController({
    enabled: true,
    minMs: 100,
    maxMs: 200,
    random: () => 0.5,
    delay,
    onFire: () => {
      fired.push(scheduled.length)
    },
  })
  assert.equal(controller.armed, false)
  controller.start()
  assert.equal(controller.armed, true)
  assert.equal(scheduled.length, 1)
  assert.ok(scheduled[0].ms >= 100 && scheduled[0].ms <= 200)

  // 触发 → 回调执行 + 自动重新调度
  scheduled[0].fire()
  assert.deepEqual(fired, [1])
  assert.equal(controller.armed, true)
  assert.equal(scheduled.length, 2)

  // dispose → 停止且取消挂起的延时
  controller.dispose()
  assert.equal(controller.armed, false)
  assert.equal(scheduled[1].cancelled, true)
})

test('nudge: 开关关闭时 start 不调度', () => {
  const scheduled = []
  const controller = new RecallNudgeController({
    enabled: false,
    delay: (ms, cb) => {
      scheduled.push(ms)
      return { cancel() {} }
    },
    onFire: () => {},
  })
  controller.start()
  assert.equal(scheduled.length, 0)
  assert.equal(controller.armed, false)
})

test('nudge: setEnabled 运行时切换（v0.5 设置页 live）', () => {
  const scheduled = []
  const delay = (ms, cb) => {
    const handle = {
      cancelled: false,
      cancel() {
        this.cancelled = true
      },
      fire() {
        cb()
      },
    }
    scheduled.push(handle)
    return handle
  }
  const controller = new RecallNudgeController({
    enabled: false,
    minMs: 10,
    maxMs: 20,
    random: () => 0.5,
    delay,
    onFire: () => {},
  })
  // 初始关 → 不调度
  controller.start()
  assert.equal(scheduled.length, 0)
  // 开 → 立即调度
  controller.setEnabled(true)
  assert.equal(controller.armed, true)
  assert.equal(scheduled.length, 1)
  // 触发后自动重调度（仍开着）
  scheduled[0].fire()
  assert.equal(scheduled.length, 2)
  // 关 → 取消挂起计时器
  controller.setEnabled(false)
  assert.equal(controller.armed, false)
  assert.equal(scheduled[1].cancelled, true)
  // 再开 → 重新调度
  controller.setEnabled(true)
  assert.equal(controller.armed, true)
  assert.equal(scheduled.length, 3)
})