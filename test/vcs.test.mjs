/**
 * v0.2 git 版本回溯测试。
 *
 * - 纯逻辑单测：commit message 生成 / numstat 解析 / restore 目标展开。
 * - 真实 git 集成测试（无 git 环境自动跳过）：init → 写 → 自动/边界提交 →
 *   历史/差异 → 删除 → restore 恢复 → 一致性断言；git 缺失的降级路径用假二进制注入。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from '../dist/config.js'
import { DigestEngine } from '../dist/digest.js'
import { MemoryStore } from '../dist/store.js'
import { createTools } from '../dist/tools.js'
import { GitVcs, buildCommitMessage, expandTargets, parseNumstat, toGitRel } from '../dist/vcs.js'

const GIT_OK = (() => {
  try {
    return spawnSync('git', ['--version']).status === 0
  } catch {
    return false
  }
})()

// ---------------------------------------------------------------- 纯逻辑单测（不依赖 git）

test('vcs.buildCommitMessage: 原因 + 操作清单（去重、前 8 条）', () => {
  assert.equal(buildCommitMessage([], '会话边界'), '[dev-memory] 会话边界')
  assert.equal(buildCommitMessage(['l3: remember a', 'l1: append'], undefined), '[dev-memory] auto (l3: remember a; l1: append)')
  const many = Array.from({ length: 20 }, (_, i) => `l3: op${i % 3}`)
  const msg = buildCommitMessage(many, 'digest')
  assert.ok(msg.startsWith('[dev-memory] digest'))
  // 去重后前 8 条的唯一 op
  const count = (msg.match(/l3:/g) ?? []).length
  assert.equal(count, 3)
})

test('vcs.parseNumstat: 解析增删行与状态', () => {
  const entries = parseNumstat('1\t0\tspaces/pref-20260828-abc.md\n0\t2\tdocs/a.md\n3\t3\truntime/2026-08-28.md\n5\t0\t"weird\\tname.md"\n')
  assert.equal(entries.length, 4)
  assert.equal(entries[0].status, 'A')
  assert.equal(entries[0].added, 1)
  assert.equal(entries[1].status, 'D')
  assert.equal(entries[2].status, 'M')
  assert.equal(entries[3].path, 'weird\tname.md')
})

test('vcs.expandTargets: 层名与相对路径展开、防逃逸、all 整库', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dm3t-vcs-rel-'))
  try {
    await mkdir(join(root, 'spaces'), { recursive: true })
    await mkdir(join(root, 'docs', 'notes'), { recursive: true })
    assert.deepEqual(expandTargets(root, ['l1', 'runtime', 'l2', 'docs', 'l3', 'spaces']), ['runtime', 'docs', 'spaces'])
    assert.deepEqual(expandTargets(root, ['./docs/notes/x.md', 'spaces/y.md']), ['docs/notes/x.md', 'spaces/y.md'])
    // v0.3：all = 整库时间片（git 根相对路径 '.'）
    assert.deepEqual(expandTargets(root, ['all']), ['.'])
    // 与路径混用也归一为整库
    assert.deepEqual(expandTargets(root, ['all', 'l3']), ['.'])
    assert.throws(() => expandTargets(root, ['../evil']), /库内相对路径/)
    assert.throws(() => expandTargets(root, ['C:/evil']), /库内相对路径/)
    assert.throws(() => expandTargets(root, ['/abs']), /库内相对路径/)
    assert.equal(toGitRel(root, join(root, 'spaces', 'a.md')), 'spaces/a.md')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 集成测试（需要真实 git）

const skipNoGit = { skip: !GIT_OK && '本机无 git，跳过集成测试' }

async function makeStore(extra = {}) {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-vcs-'))
  const config = { ...DEFAULT_CONFIG, vcs: { ...DEFAULT_CONFIG.vcs, debounceMs: 50, ...extra } }
  const store = new MemoryStore(ws, config)
  await store.init()
  return { ws, store }
}

test('vcs.init: 嵌套仓库初始化（分支/身份/内部忽略/初始提交）', skipNoGit, async () => {
  const { ws, store } = await makeStore()
  try {
    const st = await store.vcs.status()
    assert.equal(st.ready, true)
    assert.equal(st.degraded, false)
    assert.equal(st.branch, 'main')
    assert.ok(st.commits >= 1)
    assert.ok(typeof st.latestCommit === 'string' && st.latestCommit.length === 7)
    const ignore = await readFile(join(store.root, '.gitignore'), 'utf8')
    assert.ok(ignore.includes('index.json'))
    // v0.4：诊断记录与派生物一样不入 git 历史
    assert.ok(ignore.includes('diag/'))
    // 本地身份兜底已写入
    const { spawnSync: ss } = await import('node:child_process')
    const cfg = ss('git', ['config', 'user.name'], { cwd: store.root, encoding: 'utf8' })
    assert.ok(cfg.stdout.trim() !== '')
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('vcs: index.json 不被跟踪（派生物忽略）', skipNoGit, async () => {
  const { ws, store } = await makeStore()
  try {
    await store.rebuildIndex()
    await store.flushVcs('测试')
    const { spawnSync: ss } = await import('node:child_process')
    const st = ss('git', ['status', '--porcelain'], { cwd: store.root, encoding: 'utf8' })
    assert.ok(!st.stdout.includes('index.json'))
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('vcs: 写→边界提交→历史可查（提交信息含协议前缀）', skipNoGit, async () => {
  const { ws, store } = await makeStore()
  try {
    await store.remember({ kind: 'preference', content: '偏好：简洁回复' })
    await store.note({ relPath: 'notes/t.md', body: '# 测试\n一行' })
    assert.ok(store.vcs.pendingWrites >= 2)
    const flushed = await store.flushVcs('测试边界')
    assert.ok(flushed !== null)
    assert.ok(flushed.message.startsWith('[dev-memory]'))
    const commits = await store.vcs.history(10)
    assert.ok(commits.length >= 2)
    assert.ok(commits[0].message.includes('测试边界'))
    assert.ok(commits.some((c) => c.message.includes('init memory library')))
    // 按层过滤：改过 l2 的提交能看到，改过 l1 的提交可能没有 → 至少返回非空
    const l2 = await store.vcs.history(10, ['docs'])
    assert.ok(l2.length >= 1)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('vcs: batch 阈值触发自动提交（不等待边界）', skipNoGit, async () => {
  const { ws, store } = await makeStore({ batch: 3, debounceMs: 60_000 })
  try {
    const before = (await store.vcs.status()).commits
    for (let i = 0; i < 3; i++) {
      await store.remember({ kind: 'context', content: `批量条目 ${i}` })
    }
    // 第 3 次写入触发 batch 提交（异步链上串行执行）
    for (let i = 0; i < 40; i++) {
      const now = (await store.vcs.status()).commits
      if (now > before) break
      await new Promise((r) => setTimeout(r, 25))
    }
    const after = (await store.vcs.status()).commits
    assert.ok(after > before, `batch 提交未触发（before=${before} after=${after}）`)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('vcs.restore: 删条目后可从历史恢复（dry-run → 执行 → 内容一致）', skipNoGit, async () => {
  const { ws, store } = await makeStore()
  try {
    const entry = await store.remember({ kind: 'entity', content: '项目 alpha 用 TypeScript', tags: ['项目'] })
    await store.flushVcs('快照')
    const snapshot = (await store.vcs.history(1))[0]
    assert.ok(snapshot !== undefined)

    // 删除并提交
    await store.removeEntry(entry.id, 'delete', '测试误删')
    await store.flushVcs('误删')
    await assert.rejects(() => store.readEntry(entry.id).then((e) => (e === null ? Promise.reject(new Error('gone')) : e)))

    // dry-run：预览能列出将被恢复的文件（快照后文件被删 → 相对快照显示 D，restore 将找回）
    const plan = await store.vcs.restore({ ref: snapshot.hash, targets: ['l3'], dryRun: true })
    assert.equal(plan.dryRun, true)
    assert.equal(plan.applied, false)
    assert.ok(plan.changes.length >= 1)
    assert.ok(plan.changes.some((c) => c.path.includes(entry.id)))

    // 留下一笔未提交写入 → 恢复前的 checkpoint 应捕获它（安全网）
    await store.note({ relPath: 'notes/before-restore.md', body: '# 未提交' })

    // 执行恢复
    const result = await store.vcs.restore({ ref: snapshot.hash, targets: ['l3'], dryRun: false })
    assert.equal(result.applied, true)
    assert.ok(typeof result.checkpointCommit === 'string', '恢复前未提交变更应被 checkpoint 提交捕获')
    const restored = await store.readEntry(entry.id)
    assert.ok(restored !== null)
    assert.equal(restored.body.trim(), '项目 alpha 用 TypeScript')
    assert.deepEqual(restored.tags, ['项目'])
    // 恢复本身留痕
    const commits = await store.vcs.history(5)
    assert.ok(commits.some((c) => c.message.includes('restore')))
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('vcs.restore: ref 不存在时报业务错误（不静默）', skipNoGit, async () => {
  const { ws, store } = await makeStore()
  try {
    await assert.rejects(() => store.vcs.restore({ ref: 'deadbeef', targets: ['l3'], dryRun: true }), /git diff 失败|unknown revision|bad revision|invalid/i)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('vcs.restore: 整库时间片（all 反转之后的删除与新增）', skipNoGit, async () => {
  const { ws, store } = await makeStore()
  try {
    const a = await store.remember({ kind: 'entity', content: '早期条目 A' })
    await store.flushVcs('快照')
    const snapshot = (await store.vcs.history(1))[0]
    assert.ok(snapshot !== undefined)

    // 快照后：删除 A + 新增 B（制造可反转的差异）
    await store.removeEntry(a.id, 'delete', '后续删除 A')
    const b = await store.remember({ kind: 'context', content: '后期条目 B' })
    await store.flushVcs('后续变更')
    assert.equal(await store.readEntry(a.id), null)
    assert.ok((await store.readEntry(b.id)) !== null)

    // dry-run：整库预览应同时看到"恢复 A（D）"与"移除 B（A）"
    const plan = await store.vcs.restore({ ref: snapshot.hash, targets: ['all'], dryRun: true })
    assert.equal(plan.dryRun, true)
    assert.deepEqual(plan.targets, ['.'])
    assert.ok(plan.changes.some((c) => c.path.includes(a.id)))
    assert.ok(plan.changes.some((c) => c.path.includes(b.id)))

    // 执行：一次反转到快照（A 回来、B 消失）
    const result = await store.vcs.restore({ ref: snapshot.hash, targets: ['all'], dryRun: false })
    assert.equal(result.applied, true)
    const a2 = await store.readEntry(a.id)
    assert.ok(a2 !== null && a2.body.includes('早期条目 A'))
    assert.equal(await store.readEntry(b.id), null)
    // 恢复本身留痕
    const commits = await store.vcs.history(8)
    assert.ok(commits.some((c) => c.message.includes('restore')))
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('vcs: git 缺失时降级（available=false, degraded=true，写入不受影响）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-vcs-nogit-'))
  try {
    await mkdir(ws, { recursive: true })
    const vcs = new GitVcs(ws, DEFAULT_CONFIG.vcs, 'no-such-git-binary-xyz')
    await vcs.init()
    const st = await vcs.status()
    assert.equal(st.available, false)
    assert.equal(st.ready, false)
    assert.equal(st.degraded, true)
    assert.ok(typeof st.lastError === 'string' && st.lastError.length > 0)
    // 降级下 record/flush 安静返回
    vcs.record('l3', 'remember x')
    assert.equal(await vcs.flush('x'), null)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('vcs: 配置关闭时完全跳过 git', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-vcs-off-'))
  try {
    const store = new MemoryStore(ws, { ...DEFAULT_CONFIG, vcs: { ...DEFAULT_CONFIG.vcs, enabled: false } })
    await store.init()
    const st = await store.vcs.status()
    assert.equal(st.enabled, false)
    assert.equal(st.ready, false)
    assert.equal(st.degraded, false)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('vcs: 记忆库文件中无 .git 时 store 行为不变（v0.1 兼容：手删 .git 后仍可用）', skipNoGit, async () => {
  // autoCommit 关闭：避免防抖定时器在手删 .git 后仍 spawn git（清理期 EBUSY）
  const { ws, store } = await makeStore({ autoCommit: false })
  try {
    await rm(join(store.root, '.git'), { recursive: true, force: true })
    const entry = await store.remember({ kind: 'preference', content: '删除 git 后仍可写入' })
    assert.ok(entry.id.startsWith('pref-'))
    const st = await store.vcs.status()
    assert.equal(st.ready, false)
  } finally {
    // 让可能残留的异步尾部静默
    await new Promise((r) => setTimeout(r, 80))
    await rm(ws, { recursive: true, force: true })
  }
})

test('vcs: 工具面冒烟（history/diff/restore 经 devmemory_* 工具真实调用）', skipNoGit, async () => {
  const { ws, store } = await makeStore()
  try {
    const tools = createTools(store, new DigestEngine(store))
    const byName = (name) => tools.find((t) => t.name === name)
    await byName('devmemory_remember').execute({ kind: 'decision', content: '决策：v0.2 引入 git 回溯' }, {})
    await byName('devmemory_consolidate').execute({}, {})
    const hist = await byName('devmemory_history').execute({ limit: 5 }, {})
    assert.ok(hist.commits.length >= 1)
    assert.equal(hist.vcs.ready, true)
    assert.ok(hist.commits[0].message.includes('[dev-memory]'))
    const diff = await byName('devmemory_diff').execute({}, {})
    assert.ok(Array.isArray(diff.files))
    // consolidate 已 flush → 当前应无未提交变更
    assert.equal(diff.total, 0)
    const dry = await byName('devmemory_restore').execute({ ref: hist.commits[0].hash, targets: ['l2'], dryRun: true }, {})
    assert.equal(dry.dryRun, true)
    assert.ok(Array.isArray(dry.changes))
    assert.equal(dry.applied, false)
    // v0.3：targets 省略 / 空 = 整库时间片（展示 all）
    const whole = await byName('devmemory_restore').execute({ ref: hist.commits[0].hash, dryRun: true }, {})
    assert.equal(whole.dryRun, true)
    assert.deepEqual(whole.targets, ['all'])
    const whole2 = await byName('devmemory_restore').execute({ ref: hist.commits[0].hash, targets: ['all', 'l3'], dryRun: true }, {})
    assert.deepEqual(whole2.targets, ['all'])
    // restore 必填参数校验
    await assert.rejects(() => byName('devmemory_restore').execute({ ref: '', targets: ['l3'] }, {}), /ref 不能为空/)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- gitDir 分离仓库（v0.2 正式化）

test('vcs.gitDir: 绝对路径分离仓库（元数据在库外）', skipNoGit, async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-gitdir-abs-'))
  const metaRoot = await mkdtemp(join(tmpdir(), 'dm3t-gitdir-meta-'))
  try {
    const store = new MemoryStore(ws, {
      ...DEFAULT_CONFIG,
      vcs: { ...DEFAULT_CONFIG.vcs, debounceMs: 50, gitDir: join(metaRoot, 'git-store') },
    })
    await store.init()
    const st = await store.vcs.status()
    assert.equal(st.ready, true)
    assert.equal(st.branch, 'main')
    assert.ok(st.commits >= 1)
    // 工作区只有 .git 文件（指向 gitDir），元数据不在库内
    const dotgitRaw = await readFile(join(store.root, '.git'), 'utf8')
    assert.ok(dotgitRaw.includes('gitdir:'), '应生成 .git 指示文件')
    // 写入 → 提交 → 历史可用
    await store.remember({ kind: 'entity', content: '分离仓库条目' })
    const flushed = await store.flushVcs('分离仓库测试')
    assert.ok(flushed !== null)
    const commits = await store.vcs.history(5)
    assert.ok(commits.some((c) => c.message.includes('分离仓库测试')))
  } finally {
    await rm(ws, { recursive: true, force: true })
    await rm(metaRoot, { recursive: true, force: true })
  }
})

test('vcs.gitDir: 相对库根路径（位于库内）→ 元数据被库内 .gitignore 忽略', skipNoGit, async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-gitdir-rel-'))
  try {
    const store = new MemoryStore(ws, {
      ...DEFAULT_CONFIG,
      vcs: { ...DEFAULT_CONFIG.vcs, debounceMs: 50, gitDir: 'meta/git-store' },
    })
    await store.init()
    const st = await store.vcs.status()
    assert.equal(st.ready, true)
    const ignore = await readFile(join(store.root, '.gitignore'), 'utf8')
    assert.ok(ignore.includes('meta/git-store'), '.gitignore 应忽略库内 gitDir：' + ignore)
    await store.remember({ kind: 'context', content: '库内 gitDir 条目' })
    await store.flushVcs('库内 gitDir')
    // git 不跟踪元数据目录本身
    const { spawnSync: ss } = await import('node:child_process')
    const files = ss('git', ['ls-files'], { cwd: store.root, encoding: 'utf8' })
    assert.ok(!files.stdout.includes('git-store'), 'git 不应跟踪 gitDir 元数据')
    assert.ok(files.stdout.includes('spaces/'), '工作区内容应被跟踪')
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('vcs.gitDir: 等于库根被拒绝 → 降级（fail-open）', skipNoGit, async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-gitdir-eq-'))
  try {
    const store = new MemoryStore(ws, {
      ...DEFAULT_CONFIG,
      vcs: { ...DEFAULT_CONFIG.vcs, gitDir: join(ws, '.memory') },
    })
    await store.init()
    const st = await store.vcs.status()
    assert.equal(st.ready, false)
    assert.ok(st.lastError !== null && st.lastError.includes('gitDir'))
    // 降级下业务写不受阻
    const entry = await store.remember({ kind: 'preference', content: 'gitDir 配置错误仍可写' })
    assert.ok(entry.id.startsWith('pref-'))
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})