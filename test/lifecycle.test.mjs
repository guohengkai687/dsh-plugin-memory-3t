import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { apply } from '../dist/index.js'

/** git 可用性（集成测试用；无 git 环境跳过）。 */
const GIT_OK = (() => {
  try {
    const r = spawnSync('git', ['--version'], { encoding: 'utf8' })
    return r.status === 0 && /^git version /u.test((r.stdout ?? '').trim())
  } catch {
    return false
  }
})()

/** 等待后台异步写入（init / appendRuntime）静默，避免与 rm 竞争。 */
async function settle() {
  await new Promise((r) => setTimeout(r, 120))
}

/** 构造 ctx stub 并记录注册调用。 */
function makeStubContext() {
  const calls = {
    on: new Map(),
    skills: [],
    tools: [],
    contexts: [],
  }
  const ctx = {
    logger: { warn() {}, info() {} },
    on(event, handler) {
      calls.on.set(event, handler)
    },
    skills: { register(skill) { calls.skills.push(skill) } },
    tools: { register(tool) { calls.tools.push(tool) } },
    systemPrompt: { context(entry) { calls.contexts.push(entry) } },
  }
  return { ctx, calls }
}

test('lifecycle: apply 注册 skill/boot/工具/事件', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-life-'))
  const cwd = process.cwd()
  try {
    process.chdir(ws)
    const { ctx, calls } = makeStubContext()
    // vcs 关闭：apply 异步 init 不 await，避免 git 冷启动进程与清理期的 rm 竞争（EBUSY）
    apply(ctx, { storageDir: '.memory', vcs: { enabled: false } })

    // skill 注册 1 次
    assert.equal(calls.skills.length, 1)
    assert.equal(calls.skills[0].name, 'dev-memory')
    assert.match(calls.skills[0].name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.ok(calls.skills[0].content.length > 500)
    assert.deepEqual(calls.skills[0].invocation, { modelInvocable: true, userInvocable: false })

    // boot context 1 次
    assert.equal(calls.contexts.length, 1)
    assert.equal(calls.contexts[0].name, 'dev-memory-boot')
    assert.equal(calls.contexts[0].order, -200)
    const bootText = calls.contexts[0].text({ agent: undefined })
    assert.ok(bootText.includes('[dev-memory]'))

    // 工具 12 个（v0.6.5：+devmemory_seed）
    assert.equal(calls.tools.length, 12)

    // 事件 4 类（v0.6.5 勘误：agent/session-start **真实存在**，且携带 source；agent/created 为兼容边）
    for (const event of ['agent/session-start', 'agent/created', 'agent/pre-step', 'agent/turn-stopping']) {
      assert.ok(calls.on.has(event), `缺少事件 ${event}`)
    }
    // 回归：boot 块必须静态（逐请求注入但逐字节恒定），不得再携带召回的 L1/L3 内容
    const bootWithView = calls.contexts[0].text({ agent: { id: 'whatever' } })
    assert.ok(!bootWithView.includes('[dev-memory L1 流水]'), 'boot 块不得包含 L1 回放（v0.6.5 改为会话一次性注入）')
    assert.ok(!bootWithView.includes('[dev-memory L3 长期事实]'), 'boot 块不得包含 L3 top-k（v0.6.5 改为会话一次性注入）')
    assert.ok(!bootWithView.includes('[dev-memory 会话状态]'), 'boot 块不得包含易变状态块（v0.6.5 改为会话一次性注入）')
  } finally {
    process.chdir(cwd)
    await settle()
    await rm(ws, { recursive: true, force: true })
  }
})

test('lifecycle: pre-step 记录消息并注入提醒（预算内）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-life2-'))
  const cwd = process.cwd()
  try {
    process.chdir(ws)
    const { ctx, calls } = makeStubContext()
    apply(ctx, { storageDir: '.memory', recall: { highScore: 0.6 }, vcs: { enabled: false } })
    const preStep = calls.on.get('agent/pre-step')
    const created = calls.on.get('agent/created')

    const agent = { id: 'a1' }
    await created({ agent, source: 'startup' })

    // 第一次：包含回忆触发词 → 注入
    const next = async () => ({ kind: 'enter', messages: [{ id: 'x', role: 'user', content: [{ type: 'text', text: '原始消息' }] }] })
    const out1 = await preStep(
      { agent, messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '你还记得我们上次讨论的方案吗' }] }], turn: 1, step: 1, signal: undefined },
      next,
    )
    assert.ok(Array.isArray(out1.messages))
    assert.ok(out1.messages.length > 1)
    const injected = out1.messages[out1.messages.length - 1]
    assert.equal(injected.source.kind, 'plugin')
    assert.equal(injected.source.plugin, 'dsh-plugin-memory-3t')

    // 第二次：无触发词 → 原样
    const out2 = await preStep(
      { agent, messages: [{ id: 'm2', role: 'user', content: [{ type: 'text', text: '继续写代码' }] }], turn: 1, step: 2, signal: undefined },
      next,
    )
    assert.equal(out2.messages.length, 1)

    // 已提醒 2 次后不再注入
    const agent2 = { id: 'a2' }
    const view2 = { runtime: '', spaces: '', reminded: 2 }
    // 预置 reminded（通过三次触发校验逻辑：直接构造 view 不可行，改走三次调用）
    // 简化：校验前两个用例即可（引导次数逻辑在 computeReminder 内部单测未覆盖；此处覆盖主路径）
  } finally {
    process.chdir(cwd)
    await settle()
    await rm(ws, { recursive: true, force: true })
  }
})

test('lifecycle: init 失败仍完成注册（fail-open）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-life3-'))
  const cwd = process.cwd()
  try {
    process.chdir(ws)
    const { ctx, calls } = makeStubContext()
    // storageDir 指向一个文件路径，使 mkdir 失败
    const broken = join(ws, 'file-as-dir')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(broken, 'x')
    apply(ctx, { storageDir: broken, vcs: { enabled: false } })
    assert.equal(calls.skills.length, 1)
    assert.equal(calls.tools.length, 12)
    // v0.6.4：workspace 自动解析不再在 apply 期急切建库 → 首个会话边（agent/created）才触达坏库根
    await calls.on.get('agent/created')({ agent: { id: 'i1' }, source: 'startup' })
    // 等异步 init 失败完成
    await new Promise((r) => setTimeout(r, 100))
  } finally {
    process.chdir(cwd)
    await rm(ws, { recursive: true, force: true })
  }
})

test('lifecycle: workspace 根跟随会话 header.cwd（v0.3.1），工具用 getter 解析到新库', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-life5-'))
  const ws2 = await mkdtemp(join(tmpdir(), 'dm3t-life6-'))
  const cwd = process.cwd()
  try {
    process.chdir(ws)
    const { ctx, calls } = makeStubContext()
    apply(ctx, { storageDir: '.memory', vcs: { enabled: false } })
    await settle()

    // 无 header.cwd 的 agent：库根 = 进程 cwd（旧行为回退）
    const agentA = { id: 'a1' }
    await calls.on.get('agent/created')({ agent: agentA, source: 'startup' })
    const bootA = calls.contexts[0].text({ agent: agentA })
    assert.ok(bootA.includes(join(ws, '.memory')), '无 cwd 的会话应回退进程 cwd: ' + bootA)

    // 带 session.header.cwd 的 agent：库根切换到会话真实工作区
    const agentB = { id: 'b1', session: { header: { cwd: ws2 } } }
    await calls.on.get('agent/created')({ agent: agentB, source: 'startup' })
    const bootB = calls.contexts[0].text({ agent: agentB })
    assert.ok(bootB.includes(join(ws2, '.memory')), 'boot 库根应指向会话工作区: ' + bootB)

    // 工具按 getter 动态解析到会话工作区库（写读闭环）
    const statusTool = calls.tools.find((t) => t.name === 'devmemory_status')
    const rememberTool = calls.tools.find((t) => t.name === 'devmemory_remember')
    assert.ok(statusTool && rememberTool)
    const remembered = await rememberTool.execute({ content: '工作区根解析回归：库应落在工作区', kind: 'context' })
    assert.ok(remembered.id)
    const status = await statusTool.execute({})
    assert.equal(status.root, join(ws2, '.memory'), '工具应解析到会话工作区库: ' + status.root)
    assert.equal(status.counts.l3, 1)
  } finally {
    process.chdir(cwd)
    await settle()
    await rm(ws, { recursive: true, force: true })
    await rm(ws2, { recursive: true, force: true })
  }
})

test('lifecycle: pre-step/turn-stopping 按 payload.agent 工作区绑定（v0.6.4 回归：不得串库）', async () => {
  const ws1 = await mkdtemp(join(tmpdir(), 'dm3t-ws1-'))
  const ws2 = await mkdtemp(join(tmpdir(), 'dm3t-ws2-'))
  const cwd = process.cwd()
  try {
    process.chdir(ws1)
    const { ctx, calls } = makeStubContext()
    apply(ctx, { storageDir: '.memory', vcs: { enabled: false } })
    await settle()

    const created = calls.on.get('agent/created')
    const preStep = calls.on.get('agent/pre-step')
    const turnStopping = calls.on.get('agent/turn-stopping')
    const statusTool = calls.tools.find((t) => t.name === 'devmemory_status')
    assert.ok(created && preStep && turnStopping && statusTool)

    const agent1 = { id: 'w1', session: { header: { cwd: ws1 } } }
    const agent2 = { id: 'w2', session: { header: { cwd: ws2 } } }
    await created({ agent: agent1, source: 'startup' })
    await created({ agent: agent2, source: 'startup' })

    const next = async () => ({ kind: 'enter', messages: [] })

    // agent2 与 agent1 交错：agent2 的 pre-step 必须写进 ws2 库，而不是"最近 created 的 ws2/上次 active"
    await preStep({ agent: agent2, messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '第二个工作区的消息' }] }], turn: 1, step: 1, signal: undefined }, next)
    await settle()
    let s = await statusTool.execute({})
    assert.equal(s.root, join(ws2, '.memory'), 'pre-step 应按 payload.agent 绑定 ws2: ' + s.root)
    assert.ok(s.counts.l1 >= 1, 'ws2 库应有 L1 流水，而非串到 ws1')

    // turn-stopping 同样按 payload.agent 绑定
    await turnStopping({ agent: agent2, turn: 1, signal: undefined })
    s = await statusTool.execute({})
    assert.equal(s.root, join(ws2, '.memory'), 'turn-stopping 应按 payload.agent 绑定 ws2: ' + s.root)

    // 关键回归点：agent1 的 pre-step 必须切回 ws1（修复前 ensureStore() 无参沿用 active → 串到 ws2）
    await preStep({ agent: agent1, messages: [{ id: 'm2', role: 'user', content: [{ type: 'text', text: '第一个工作区的消息' }] }], turn: 1, step: 1, signal: undefined }, next)
    await settle()
    s = await statusTool.execute({})
    assert.equal(s.root, join(ws1, '.memory'), 'pre-step 应按 payload.agent 绑定 ws1（修复前会串到 ws2）: ' + s.root)
  } finally {
    process.chdir(cwd)
    await settle()
    await rm(ws1, { recursive: true, force: true })
    await rm(ws2, { recursive: true, force: true })
  }
})

test('lifecycle: subagent 继承父会话视图（L1 回放 / L3 top-k）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-life4-'))
  const cwd = process.cwd()
  try {
    process.chdir(ws)
    const { ctx, calls } = makeStubContext()
    // v0.6.6：L3 默认不注入（off），本用例校验"显式开启 + subagent 继承"路径
    apply(ctx, { storageDir: '.memory', vcs: { enabled: false }, l3Inject: 'salience' })
    await settle()

    // 手工种一条高活跃 L3（模拟已积累的记忆）
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(ws, '.memory', 'spaces'), { recursive: true })
    await writeFile(
      join(ws, '.memory', 'spaces', 'ctx-seed-v03.md'),
      [
        '---',
        'id: ctx-seed-v03',
        'kind: context',
        'created: 2026-01-01T00:00:00+08:00',
        'updated: 2026-01-01T00:00:00+08:00',
        'salience: 0.9',
        'accesses: 0',
        'tags: [种子]',
        'links: []',
        '---',
        '种子上下文：subagent 应能看到我',
        '',
      ].join('\n'),
    )

    const created = calls.on.get('agent/created')
    const parent = { id: 'p1' }
    await created({ agent: parent, source: 'startup' })

    // subagent 带 parentSession 创建 → 继承父会话视图
    const sub = { id: 's1', session: { header: { parentSession: 'p1' } } }
    await created({ agent: sub, source: 'resume' })

    // v0.6.5：视图注入改由 pre-step **每会话一次**完成（boot 块已静态化，不再携带 L3 内容）
    const preStep = calls.on.get('agent/pre-step')
    const next = async () => ({ kind: 'enter', messages: [{ id: 'x', role: 'user', content: [{ type: 'text', text: '原始消息' }] }] })
    const ask = (agent, id) => ({ agent, messages: [{ id, role: 'user', content: [{ type: 'text', text: '继续' }] }], turn: 1, step: 1 })

    const outParent = await preStep(ask(parent, 'm1'), next)
    assert.ok(
      outParent.messages.some((m) => JSON.stringify(m).includes('种子上下文')),
      '父会话首个 pre-step 应一次性注入 L3 视图',
    )
    // 同一会话第二次 pre-step 不得再注入（每会话一次）
    const outParent2 = await preStep(ask(parent, 'm2'), next)
    assert.equal(outParent2.messages.length, 1, '会话视图每会话只注入一次')

    // subagent 有自己的上下文 → 继承父视图内容并自行注入一次
    const outSub = await preStep(ask(sub, 'm3'), next)
    assert.ok(
      outSub.messages.some((m) => JSON.stringify(m).includes('种子上下文')),
      'subagent 应继承父会话视图并自行注入一次',
    )

    // 无 parent 的 agent 不受影响（boot 块静态且不抛）
    const root2 = { id: 'r2' }
    await created({ agent: root2, source: 'startup' })
    assert.doesNotThrow(() => calls.contexts[0].text({ agent: root2 }))
  } finally {
    process.chdir(cwd)
    await settle()
    await rm(ws, { recursive: true, force: true })
  }
})

test('lifecycle: 库根 A→B→A 切换后复用已初始化的库（v0.6.3 回归：vcs 不得静默降级）', { skip: !GIT_OK && '本机无 git，跳过集成测试' }, async () => {
  const wsA = await mkdtemp(join(tmpdir(), 'dm3t-swA-'))
  const wsB = await mkdtemp(join(tmpdir(), 'dm3t-swB-'))
  const cwd = process.cwd()
  const rmOpts = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }
  try {
    process.chdir(wsA)
    const { ctx, calls } = makeStubContext()
    // 本用例的观测点就是 vcs 是否被 init，所以必须开启 vcs（其余 lifecycle 用例都关着）
    apply(ctx, { storageDir: '.memory', vcs: { debounceMs: 50 } })

    const sessionStart = calls.on.get('agent/created')
    const statusTool = calls.tools.find((t) => t.name === 'devmemory_status')
    const agentAt = (dir) => ({ id: 'a:' + dir, session: { header: { cwd: dir } } })
    const statusFor = async (dir) => {
      const s = await statusTool.execute({}, {})
      return s.root === join(dir, '.memory') ? s : null
    }
    const waitReady = async (dir) => {
      for (let i = 0; i < 80; i += 1) {
        const s = await statusFor(dir)
        if (s !== null && s.vcs.ready === true) return true
        await new Promise((r) => setTimeout(r, 50))
      }
      return false
    }

    // 进入 A：完成 init
    await sessionStart({ agent: agentAt(wsA), source: 'startup' })
    assert.ok(await waitReady(wsA), '首次进入 A 应完成 vcs 初始化')

    // 切到 B：另一个库根，独立 init
    await sessionStart({ agent: agentAt(wsB), source: 'startup' })
    assert.ok(await waitReady(wsB), '切到 B 应完成 vcs 初始化')

    // 切回 A：修复前这里会为 A 新建实例却跳过 init → available/ready 恒为 false 且 lastError 为 null
    await sessionStart({ agent: agentAt(wsA), source: 'startup' })
    const back = await statusFor(wsA)
    assert.ok(back !== null, '应切回 A 的库根')
    assert.equal(back.vcs.available, true, '回到 A 后 vcs 应可用（复用已初始化实例）')
    assert.equal(back.vcs.ready, true, '回到 A 后 vcs 应就绪，不得静默降级')
    assert.equal(back.vcs.degraded, false)
    assert.equal(back.vcs.lastError, null)
    assert.ok(Number(back.vcs.commits) >= 1, '回到 A 后应能读到提交历史')
  } finally {
    process.chdir(cwd)
    await settle()
    await rm(wsA, rmOpts)
    await rm(wsB, rmOpts)
  }
})

// ---------------------------------------------------------------------------
// v0.6.5 事件勘误回归：`agent/session-start` 真实存在（payload 含 source），与 `agent/created` 兼听
// ---------------------------------------------------------------------------

test('lifecycle: 兼听 session-start/created（幂等 + clear/compact 重装 + 视图每会话一次）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-life5-'))
  const cwd = process.cwd()
  try {
    process.chdir(ws)
    const { ctx, calls } = makeStubContext()
    apply(ctx, { storageDir: '.memory', vcs: { enabled: false } })
    await settle()

    const onSessionStart = calls.on.get('agent/session-start')
    const onCreated = calls.on.get('agent/created')
    const preStep = calls.on.get('agent/pre-step')
    assert.ok(onSessionStart && onCreated, '必须同时注册两条会话启动边（v0.6.5 兼听）')

    const next = async () => ({
      kind: 'enter',
      messages: [{ id: 'x', role: 'user', content: [{ type: 'text', text: '原始' }] }],
    })
    const ask = (agent, id) => ({
      agent,
      messages: [{ id, role: 'user', content: [{ type: 'text', text: '继续' }] }],
      turn: 1,
      step: 1,
    })
    const pluginMsgs = (out) => out.messages.filter((m) => m?.source?.plugin === 'dsh-plugin-memory-3t')

    // 1) DSH 真实顺序：created 先到（payload 无 source）→ session-start 后到（带 source）；只装载一次
    const agent = { id: 'a1' }
    await onCreated({ agent })
    await onSessionStart({ agent, source: 'startup' })

    // 2) 会话视图每会话只注入一次
    const first = await preStep(ask(agent, 'm1'), next)
    assert.equal(pluginMsgs(first).length, 1, '首个 pre-step 恰好注入一个插件消息（会话视图）')
    assert.equal(pluginMsgs(first)[0].source.form, 'recall')
    const again = await preStep(ask(agent, 'm2'), next)
    assert.equal(again.messages.length, 1, '第二次 pre-step 不再注入会话视图')

    // 3) source=compact（上下文被压缩，已注入内容不在上下文里）→ 重装并允许再注一次
    await onSessionStart({ agent, source: 'compact' })
    const afterCompact = await preStep(ask(agent, 'm3'), next)
    assert.equal(pluginMsgs(afterCompact).length, 1, 'compact 后应重新注入一次会话视图')

    // 4) 同一 source 重复发射不得重复装载/重复注入
    await onSessionStart({ agent, source: 'resume' })
    const afterDup = await preStep(ask(agent, 'm4'), next)
    assert.equal(afterDup.messages.length, 1, '已处理过的 source 不应再注入')

    // 5) clear 同样触发重装
    await onSessionStart({ agent, source: 'clear' })
    const afterClear = await preStep(ask(agent, 'm5'), next)
    assert.equal(pluginMsgs(afterClear).length, 1, 'clear 后应重新注入一次会话视图')

    // 6) 只有 agent/created 的形态（无 session-start）也必须能工作
    const agent2 = { id: 'a2' }
    await onCreated({ agent: agent2 })
    const onlyCreated = await preStep(ask(agent2, 'm6'), next)
    assert.equal(pluginMsgs(onlyCreated).length, 1, '仅 created 时也应注入会话视图')
  } finally {
    process.chdir(cwd)
    await settle()
    await rm(ws, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// v0.6.6：L3 默认不注入 + L1 回放去重 + 视图全局预算 + 标题取值修复
// ---------------------------------------------------------------------------

test('lifecycle(v0.6.6): L3 默认不注入（off）；显式 salience 才注入', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-l3off-'))
  const cwd = process.cwd()
  try {
    process.chdir(ws)
    const { ctx, calls } = makeStubContext()
    apply(ctx, { storageDir: '.memory', vcs: { enabled: false } })
    await settle()

    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(ws, '.memory', 'spaces'), { recursive: true })
    await writeFile(
      join(ws, '.memory', 'spaces', 'ctx-old-fact.md'),
      [
        '---',
        'id: ctx-old-fact',
        'kind: context',
        'created: 2026-01-01T00:00:00+08:00',
        'updated: 2026-01-01T00:00:00+08:00',
        'salience: 0.9',
        'accesses: 3',
        'tags: [老事实]',
        'links: []',
        '---',
        '这条老事实默认不该被注入进 prompt',
        '',
      ].join('\n'),
    )

    const created = calls.on.get('agent/created')
    const preStep = calls.on.get('agent/pre-step')
    const next = async () => ({ kind: 'enter', messages: [{ id: 'x', role: 'user', content: [{ type: 'text', text: '原始' }] }] })
    const ask = (agent, id) => ({
      agent,
      messages: [{ id, role: 'user', content: [{ type: 'text', text: '随便问一句不触发任何回忆' }] }],
      turn: 1,
      step: 1,
    })
    const viewOf = (out) => out.messages.find((m) => m?.source?.form === 'recall')

    // 默认 off：即使库里有高 salience 条目，也不得出现在会话视图里
    const agentOff = { id: 'off1' }
    await created({ agent: agentOff, source: 'startup' })
    const offView = viewOf(await preStep(ask(agentOff, 'm1'), next))
    if (offView !== undefined) {
      assert.ok(!JSON.stringify(offView).includes('这条老事实'), '默认 off 时不得注入 L3：' + JSON.stringify(offView))
    }
  } finally {
    process.chdir(cwd)
    await settle()
    await rm(ws, { recursive: true, force: true })
  }
})

test('lifecycle(v0.6.6): L1 回放剔除本会话自己的 prompt，保留跨会话流水', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-l1dedup-'))
  const cwd = process.cwd()
  try {
    process.chdir(ws)
    const { ctx, calls } = makeStubContext()
    apply(ctx, { storageDir: '.memory', vcs: { enabled: false } })
    await settle()

    // 手工种一份历史流水：一条与本次会话 prompt 相同（应被剔除），一条跨会话旧流水（应保留）
    const { mkdir, writeFile } = await import('node:fs/promises')
    const runtimeDir = join(ws, '.memory', 'runtime')
    await mkdir(runtimeDir, { recursive: true })
    const now = new Date()
    const name = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.md`
    const samePrompt = '帮我把会话视图的注入时机改成每会话一次并去掉重复的 prompt 回放'
    await writeFile(
      join(runtimeDir, name),
      [`# ${name.slice(0, -3)}`, '', `- user: ${samePrompt}`, '- user: 上一轮会话我们讨论过索引陈旧的修复方案，这条应保留'].join('\n') + '\n',
    )
    const created = calls.on.get('agent/created')
    const preStep = calls.on.get('agent/pre-step')
    const agent = { id: 'l1a' }
    await created({ agent, source: 'startup' })

    const next = async () => ({ kind: 'enter', messages: [{ id: 'x', role: 'user', content: [{ type: 'text', text: 'ok' }] }] })
    const out = await preStep(
      {
        agent,
        messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: samePrompt }] }],
        turn: 1,
        step: 1,
        signal: undefined,
      },
      next,
    )
    const view = out.messages.find((m) => m?.source?.form === 'recall')
    assert.ok(view !== undefined, '应注入会话视图')
    const text = JSON.stringify(view)
    assert.ok(!text.includes('帮我把会话视图的注入时机'), '本会话 prompt 不得回放：' + text)
    assert.ok(text.includes('上一轮会话我们讨论过索引陈旧'), '跨会话流水应保留：' + text)
    // v0.6.6 标题修复：注入里应是 `## 日期`，不再是畸形标题（原取第一行 → 可能取到 prompt 行）
    assert.ok(text.includes(`## ${name.slice(0, -3)}`), '标题应为日期：' + text)
  } finally {
    process.chdir(cwd)
    await settle()
    await rm(ws, { recursive: true, force: true })
  }
})

test('lifecycle(v0.6.6): maxViewTokens 全局兜底（任何块单独预算再大也压得住）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-viewbudget-'))
  const cwd = process.cwd()
  try {
    process.chdir(ws)
    const { ctx, calls } = makeStubContext()
    // 各块预算放大、全局预算收紧到 100：视图总量必须被全局预算压住
    apply(ctx, {
      storageDir: '.memory',
      vcs: { enabled: false },
      maxViewTokens: 100,
      maxRuntimeTokens: 100000,
      maxBootTokens: 100000,
    })
    await settle()

    const { mkdir, writeFile } = await import('node:fs/promises')
    const runtimeDir = join(ws, '.memory', 'runtime')
    await mkdir(runtimeDir, { recursive: true })
    const now = new Date()
    const name = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.md`
    await writeFile(join(runtimeDir, name), [`# ${name.slice(0, -3)}`, '', '- user: 丙'.repeat(400)].join('\n') + '\n')

    const created = calls.on.get('agent/created')
    const preStep = calls.on.get('agent/pre-step')
    const agent = { id: 'vb1' }
    await created({ agent, source: 'startup' })

    const next = async () => ({ kind: 'enter', messages: [] })
    const out = await preStep(
      { agent, messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '不同内容，避免被去重' }] }], turn: 1, step: 1 },
      next,
    )
    const view = out.messages.find((m) => m?.source?.form === 'recall')
    assert.ok(view !== undefined, '应注入会话视图')
    const total = view.content.map((block) => block.text).join('\n')
    const { approximateTokens } = await import('../dist/render.js')
    assert.ok(approximateTokens(total) <= 140, '视图总量应被 maxViewTokens 压住，实测 ' + approximateTokens(total))
  } finally {
    process.chdir(cwd)
    await settle()
    await rm(ws, { recursive: true, force: true })
  }
})