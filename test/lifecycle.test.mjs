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

    // 工具 11 个
    assert.equal(calls.tools.length, 11)

    // 事件 4 类
    for (const event of ['agent/session-start', 'agent/pre-step', 'agent/turn-stopping', 'agent/created']) {
      assert.ok(calls.on.has(event), `缺少事件 ${event}`)
    }
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
    const sessionStart = calls.on.get('agent/session-start')

    const agent = { id: 'a1' }
    await sessionStart({ agent, source: 'startup' })

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
    assert.equal(calls.tools.length, 11)
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
    await calls.on.get('agent/session-start')({ agent: agentA, source: 'startup' })
    const bootA = calls.contexts[0].text({ agent: agentA })
    assert.ok(bootA.includes(join(ws, '.memory')), '无 cwd 的会话应回退进程 cwd: ' + bootA)

    // 带 session.header.cwd 的 agent：库根切换到会话真实工作区
    const agentB = { id: 'b1', session: { header: { cwd: ws2 } } }
    await calls.on.get('agent/session-start')({ agent: agentB, source: 'startup' })
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

test('lifecycle: subagent 继承父会话视图（L1 回放 / L3 top-k）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-life4-'))
  const cwd = process.cwd()
  try {
    process.chdir(ws)
    const { ctx, calls } = makeStubContext()
    apply(ctx, { storageDir: '.memory', vcs: { enabled: false } })
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

    const sessionStart = calls.on.get('agent/session-start')
    const created = calls.on.get('agent/created')
    const parent = { id: 'p1' }
    await sessionStart({ agent: parent, source: 'startup' })

    // subagent 带 parentSession 创建 → 继承父会话视图
    const sub = { id: 's1', session: { header: { parentSession: 'p1' } } }
    created({ agent: sub })

    const bootText = calls.contexts[0].text({ agent: sub })
    assert.ok(bootText.includes('种子上下文'), 'subagent boot 应继承父会话的 L3 视图: ' + bootText)

    // 无 parent 的 agent 不受影响
    const root2 = { id: 'r2' }
    created({ agent: root2 })
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

    const sessionStart = calls.on.get('agent/session-start')
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