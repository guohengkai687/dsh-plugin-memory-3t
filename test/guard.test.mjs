import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mergeConfig } from '../dist/config.js'
import { renderBootBlock, renderStatusBlock } from '../dist/render.js'
import { MemoryStore } from '../dist/store.js'

function makeStore(ws, extra = {}) {
  return new MemoryStore(ws, mergeConfig({ storageDir: '.memory', vcs: { enabled: false }, ...extra }))
}

test('guard: 三态可用性 empty → ok → unavailable（降级 ≠ 空库）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-avail-'))
  const store = makeStore(ws)
  try {
    await store.init()

    const empty = await store.status()
    assert.equal(empty.availability, 'empty', '空库应为 empty')
    assert.equal(empty.firstRun, true)

    await store.remember({ kind: 'context', content: '一条已确认的事实', tags: ['t'] })
    const ok = await store.status()
    assert.equal(ok.availability, 'ok')
    assert.equal(ok.firstRun, false)

    // 故障标记：首个原因胜出（幂等），且三态切到 unavailable
    store.markUnavailable('测试注入的故障')
    store.markUnavailable('第二个原因应被忽略')
    assert.equal(store.unavailableReason, '测试注入的故障')
    const bad = await store.status()
    assert.equal(bad.availability, 'unavailable')
    assert.equal(bad.unavailableReason, '测试注入的故障')
    assert.equal(bad.firstRun, false, 'unavailable 不应被当成 firstRun 语义')

    // 渲染层必须把"降级"讲清楚，且不得同时声称"空库"
    const boot = renderBootBlock(bad, 2000)
    assert.ok(boot.includes('不可用'), boot)
    const statusBlock = renderStatusBlock(bad, 2000)
    assert.ok(statusBlock.includes('不可用'), statusBlock)
    assert.ok(!statusBlock.includes('冷启动'), 'unavailable 不得同时提示"空库/冷启动"')
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('guard: 库根来源守卫拒绝写入、保留读取，并可解除', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-guard-'))
  const store = makeStore(ws)
  try {
    await store.init()
    await store.remember({ kind: 'context', content: '守卫前写入的内容' })

    store.setWriteGuard('会话未提供真实工作区根（测试）')
    assert.match(store.writeGuardReason, /测试/)

    // 三类写入全部被拒
    await assert.rejects(() => store.remember({ kind: 'context', content: '守卫后' }), /写入被拒绝/)
    await assert.rejects(() => store.note({ relPath: 'notes/x', body: '内容' }), /写入被拒绝/)
    await assert.rejects(() => store.appendRuntime(new Date(), '- user: 内容'), /写入被拒绝/)

    // 读取与检索不受影响（fail-open：只拦写，不打断使用）
    const hit = await store.recall('守卫前')
    assert.ok(hit.l3.length >= 1, '守卫生效时检索仍应可用')
    assert.equal((await store.status()).availability, 'ok')

    // 解除守卫 → 恢复写入
    store.setWriteGuard(null)
    assert.equal(store.writeGuardReason, null)
    await store.remember({ kind: 'context', content: '守卫解除后' })
    assert.equal((await store.listEntries()).length, 2)

    // 守卫生效时记了一条 unexpected 诊断（异步落盘，稍等）
    await new Promise((r) => setTimeout(r, 120))
    const summary = await store.diag.summary()
    assert.ok(summary.total >= 1, '守卫生效应留下诊断记录')
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})
