import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  approximateTokens,
  clampEntrySummary,
  clampTokens,
  dropReplayedPrompts,
  isReplayedPrompt,
  normalizeForDedup,
  renderBootBlock,
  renderRuntimeBlock,
  renderSpaceBlock,
  renderStatusBlock,
  takeWithinBudget,
} from '../dist/render.js'

/** 一份"已完成积累"的库状态（含各种易变字段，用于验证 boot/status 的分工）。 */
const STATUS = {
  ready: true,
  root: '/x/.memory',
  counts: { l1: 1, l2: 2, l3: 3 },
  lastDigestAt: null,
  indexDirty: 0,
  firstRun: false,
  vcs: { enabled: true, available: true, ready: true, branch: 'main', commits: 5, pendingWrites: 0 },
  embedding: { enabled: false, ready: false, degraded: false, model: 'nomic-embed-text', vectorCount: 0 },
}

test('render: 近似 token 计数', () => {
  assert.equal(approximateTokens('中文'), 2)
  assert.ok(approximateTokens('english words here') > 3)
})

test('render: clampTokens 短文本原样', () => {
  const out = clampTokens('你好', 100)
  assert.equal(out, '你好')
})

test('render: clampTokens 超预算截断并标记', () => {
  const long = '甲'.repeat(500)
  const out = clampTokens(long, 100)
  assert.ok(approximateTokens(out) <= 100 + 20)
  assert.ok(out.endsWith('…(记忆注入已按 token 预算截断)'))
  assert.ok(out.length < long.length)
})

test('render(v0.6.6): clampTokens/clampEntrySummary 在短文本上必须终止（防死循环回归）', () => {
  // 复现原缺陷：预算小于标记本身的开销时，`Math.max(1, floor(len*0.8))` 在 len<5 时原地踏步
  const out = clampTokens('极短文本', 1)
  assert.ok(out.endsWith('…(记忆注入已按 token 预算截断)'), out)
  assert.equal(clampEntrySummary('极短文本', 1).endsWith('…'), true)
  assert.equal(clampEntrySummary('极短文本', 0), '')
})

test('render: boot 块含数据非指令声明与工具指引', () => {
  const out = renderBootBlock(STATUS, 2000)
  assert.ok(out.includes('数据'))
  assert.ok(out.includes('devmemory_recall'))
  assert.ok(out.includes('devmemory_remember'))
  assert.ok(out.includes('库根：/x/.memory'))
})

test('render: boot 块静态化——不同易变状态产出逐字节相同（不破坏 prefix 缓存）', () => {
  const a = renderBootBlock(STATUS, 2000)
  const b = renderBootBlock(
    {
      ...STATUS,
      counts: { l1: 987, l2: 96, l3: 95 },
      indexStale: true,
      indexDocCount: 12,
      diag: { enabled: true, total: 42, error: 7, unexpected: 35 },
      vcs: { enabled: true, available: true, ready: true, branch: 'other', commits: 4242, pendingWrites: 17 },
      embedding: { enabled: true, ready: true, degraded: false, model: 'm', vectorCount: 888 },
    },
    2000,
  )
  assert.equal(a, b, 'boot 块不得随条目数/提交数/待提交数/向量数/诊断数变化')
  // 显式反证：易变信息不得出现在 boot 块里（v0.6.5 前它们都在这里逐请求重复注入）
  for (const volatile of ['L3 条目', '次提交', '待提交', '条向量', '索引快照与库内不一致', '累计']) {
    assert.ok(!a.includes(volatile), `boot 块不应包含易变信息：${volatile}`)
  }
})

test('render: boot 块在库不可用时附降级告警（唯一非静态分支）', () => {
  const out = renderBootBlock({ ...STATUS, availability: 'unavailable', unavailableReason: 'init 抛错' }, 2000)
  assert.ok(out.includes('不可用'), '不可用时应显式告警: ' + out)
  assert.ok(out.includes('init 抛错'))
  // 正常态不得出现该告警
  assert.ok(!renderBootBlock(STATUS, 2000).includes('不可用'))
})

test('render: boot 块 user scope 标注全局库', () => {
  const out = renderBootBlock({ ...STATUS, root: 'C:/Users/x/.memory', scope: 'user', counts: { l1: 1, l2: 1, l3: 1 } }, 2000)
  assert.ok(out.includes('库根：C:/Users/x/.memory（全局库，跨工作区共享）'))
})

test('render: status 块承载易变状态（计数 / VCS / 检索）', () => {
  const out = renderStatusBlock(STATUS, 2000)
  assert.ok(out.includes('L3 3 条'), out)
  assert.ok(out.includes('L2 2 篇'), out)
  assert.ok(out.includes('VCS on（main，5 次提交）'), out)
  assert.ok(out.includes('检索：BM25（本地）'), out)
  assert.ok(out.includes('会话状态'), out)
})

test('render: status 块 VCS 降级/禁用与向量降级提示', () => {
  const degraded = renderStatusBlock(
    {
      ...STATUS,
      counts: { l1: 0, l2: 0, l3: 0 },
      firstRun: true,
      vcs: { enabled: true, available: false, ready: false, branch: null, commits: 0, pendingWrites: 0 },
      embedding: { enabled: true, ready: false, degraded: true, model: 'nomic-embed-text', vectorCount: 0 },
    },
    2000,
  )
  assert.ok(degraded.includes('VCS off（git 不可用'), degraded)
  assert.ok(degraded.includes('向量开启但 Ollama 不可用'), degraded)
  assert.ok(degraded.includes('空（冷启动）'), degraded)

  const disabled = renderStatusBlock(
    {
      ...STATUS,
      counts: { l1: 0, l2: 0, l3: 0 },
      firstRun: true,
      vcs: { enabled: false, available: false, ready: false, branch: null, commits: 0, pendingWrites: 0 },
      embedding: { enabled: true, ready: true, degraded: false, model: 'nomic-embed-text', vectorCount: 3 },
    },
    2000,
  )
  assert.ok(disabled.includes('VCS off（已禁用）'), disabled)
  assert.ok(disabled.includes('向量+BM25 融合（nomic-embed-text，3 条向量）'), disabled)
})

test('render: status 块在索引陈旧与有诊断时给出告警行', () => {
  const out = renderStatusBlock(
    {
      ...STATUS,
      indexStale: true,
      indexDocCount: 1,
      counts: { l1: 0, l2: 0, l3: 2 },
      diag: { enabled: true, total: 5, error: 2, unexpected: 3 },
    },
    2000,
  )
  assert.ok(out.includes('索引快照与库内不一致（快照 1 篇 vs 库内 2 篇）'), out)
  assert.ok(out.includes('诊断：累计 5 条'), out)
})

test('render: runtime 块为空列表返回空串', () => {
  assert.equal(renderRuntimeBlock('今天', [], 1000), '')
})

test('render: space 块为空返回空串', () => {
  assert.equal(renderSpaceBlock([], 1000), '')
})

// ---------------------------------------------------------------------------
// v0.6.6：L3 逐条钳制 / 全局预算 / L1 去重
// ---------------------------------------------------------------------------

test('render: clampEntrySummary 逐条钳制超长摘要', () => {
  const short = '偏好：中文回复'
  assert.equal(clampEntrySummary(short, 100), short)
  const long = '甲'.repeat(500)
  const out = clampEntrySummary(long, 100)
  assert.ok(out.length <= 100, '钳制后不得超过预算：' + out.length)
  assert.ok(out.endsWith('…'), '应带截断标记')
  assert.equal(clampEntrySummary(long, 0), '')
})

test('render: space 块逐条钳制后全文不超预算（修复"最后一条被切半句"）', () => {
  // 实测根因：5 条各 277/116/198/157/166 tokens 合计 922 > 800 预算 → 整块从块尾砍掉一条
  const entries = Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, summary: '甲'.repeat(300), tags: [] }))
  const out = renderSpaceBlock(entries, 300, 50)
  assert.ok(approximateTokens(out) <= 300, '整块不得超预算：' + approximateTokens(out))
  const lines = out.split('\n').filter((line) => line.startsWith('- '))
  assert.equal(lines.length, 5, '5 条都应保留（各自钳制，而不是把整块砍到尾）')
  assert.ok(!out.includes('记忆注入已按 token 预算截断'), '逐条钳制后不应触发整块截断')
})

test('render: takeWithinBudget 消费型额度（防止前块挤光后块）', () => {
  assert.equal(takeWithinBudget(500, 1200), 500, '想要的比剩余多时只能拿剩余')
  assert.equal(takeWithinBudget(500, 100), 100)
  assert.equal(takeWithinBudget(0, 100), 0)
  assert.equal(takeWithinBudget(-5, 100), 0, '负剩余归零')
})

test('render: dropReplayedPrompts 剔除本会话已可见的用户消息（保留跨会话流水）', () => {
  const block = [
    '[dev-memory L1 流水] 最近会话（摘要）',
    '## 2026-09-23',
    '- user: 帮我重构这个插件的注入逻辑，把会话视图改成一次性注入',
    '- user: 跨会话留下的旧流水应当保留，因为它不在当前上下文里',
  ].join('\n')
  const out = dropReplayedPrompts(block, ['帮我重构这个插件的注入逻辑，把会话视图改成一次性注入'])
  assert.ok(!out.includes('帮我重构'), '重复回放必须被剔除：' + out)
  assert.ok(out.includes('跨会话留下的旧流水'), '非重复流水必须保留')
  assert.ok(out.includes('## 2026-09-23'), '标题结构不得破坏')
})

test('render: 写入侧 500 字截断的前缀也能识别为重复', () => {
  const prompt = '乙'.repeat(600) // L1 只存前 500 字
  const known = ['乙'.repeat(600)]
  assert.ok(isReplayedPrompt('乙'.repeat(500), known), '截断前缀应判为重复')
  assert.ok(!isReplayedPrompt('丙'.repeat(500), known))
  // 短句不做前缀判定，避免误杀
  assert.ok(!isReplayedPrompt('继续', ['继续写代码']))
})

test('render: dropReplayedPrompts 全部被剔除时返回空串（调用方据此不注入该块）', () => {
  const only = '这条流水的内容此刻已经完整地出现在当前会话上下文里了'
  const block = ['[dev-memory L1 流水] 最近会话（摘要）', '## 2026-09-23', `- user: ${only}`].join('\n')
  assert.equal(dropReplayedPrompts(block, [only]), '')
  assert.equal(dropReplayedPrompts('', []), '')
  // 无内容行（输入侧就没回放可去）不得被误判为空
  const empty = '[dev-memory L1 流水] 最近会话（摘要）'
  assert.equal(dropReplayedPrompts(empty, [only]), empty)
})

test('render: normalizeForDedup 折叠空白（与写入侧对齐）', () => {
  assert.equal(normalizeForDedup('  a\n\tb   c '), 'a b c')
})
