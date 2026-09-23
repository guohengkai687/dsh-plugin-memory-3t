import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { mergeConfig } from '../dist/config.js'
import {
  SEED_NOTE_REL_PATH,
  readGitLog,
  readManifest,
  readReadmeHeadings,
  readTopLevelEntries,
  seedLibrary,
} from '../dist/seed.js'
import { MemoryStore } from '../dist/store.js'

/** git 可用性（集成测试用；无 git 环境跳过）。 */
const GIT_OK = (() => {
  try {
    const r = spawnSync('git', ['--version'], { encoding: 'utf8' })
    return r.status === 0 && /^git version /u.test((r.stdout ?? '').trim())
  } catch {
    return false
  }
})()

/** 造一个"有仓库形状"的临时工作区（package.json + README + 目录）。 */
async function makeFixture() {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-seed-'))
  await writeFile(
    join(ws, 'package.json'),
    JSON.stringify({ name: 'demo-app', description: '一个演示项目', scripts: { build: 'tsc', test: 'node --test' } }),
  )
  await writeFile(join(ws, 'README.md'), '# Demo App\n\n介绍文字\n\n## 安装\n\n## 用法\n\n### 细节\n')
  await mkdir(join(ws, 'src'), { recursive: true })
  await mkdir(join(ws, 'docs'), { recursive: true })
  await mkdir(join(ws, 'node_modules'), { recursive: true })
  await mkdir(join(ws, 'dist'), { recursive: true })
  await writeFile(join(ws, 'index.ts'), 'export const x = 1\n')
  return ws
}

test('seed: 信号采集——manifest / README 标题 / 顶层结构（剔除噪声与隐藏项）', async () => {
  const ws = await makeFixture()
  try {
    const manifest = await readManifest(ws)
    assert.equal(manifest.name, 'demo-app')
    assert.equal(manifest.description, '一个演示项目')
    assert.deepEqual(manifest.scripts, ['build', 'test'])

    const readme = await readReadmeHeadings(ws)
    assert.equal(readme.file, 'README.md')
    assert.equal(readme.firstLine, '# Demo App')
    assert.deepEqual(readme.headings, ['Demo App', '安装', '用法', '细节'])

    const entries = await readTopLevelEntries(ws, 40)
    assert.ok(entries.dirs.includes('src'), '应采集到 src/')
    assert.ok(entries.dirs.includes('docs'))
    assert.ok(entries.files.includes('package.json'))
    assert.ok(!entries.dirs.includes('node_modules'), 'node_modules 属噪声，应剔除')
    assert.ok(!entries.dirs.includes('dist'), 'dist 属噪声，应剔除')
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('seed: 采集缺失信号时返回 null 且不抛（fail-open）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-seed-bare-'))
  try {
    assert.equal(await readManifest(ws), null)
    assert.equal(await readReadmeHeadings(ws), null)
    const entries = await readTopLevelEntries(ws, 40)
    assert.deepEqual(entries, { dirs: [], files: [] })
    // gitCommits=0 → 明确跳过（不算错误）
    const g = await readGitLog(ws, 0)
    assert.deepEqual(g.commits, [])
    assert.match(g.error, /gitCommits=0/)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('seed: seedLibrary 生成 L2 骨架 + 候选 L3（不写 L3），且幂等', async () => {
  const ws = await makeFixture()
  const store = new MemoryStore(ws, mergeConfig({ storageDir: '.memory', vcs: { enabled: false } }))
  try {
    await store.init()
    const before = await store.status()
    assert.equal(before.availability, 'empty', '库应为空（三态中的 empty）')

    const result = await seedLibrary(store, store.config)
    assert.equal(result.written, true)
    assert.equal(result.relPath, SEED_NOTE_REL_PATH)
    assert.equal(result.signals.hasManifest, true)
    assert.equal(result.signals.readmeHeadings, 4)
    assert.ok(result.signals.dirs >= 2)
    assert.ok(result.candidates.length >= 2, '应产出候选 L3: ' + JSON.stringify(result.candidates))
    assert.ok(result.candidates.some((c) => c.includes('demo-app')))

    // 笔记落盘在 L2（docs/project/overview.md）且含关键小节
    const raw = await readFile(join(ws, '.memory', 'docs', SEED_NOTE_REL_PATH), 'utf8')
    assert.ok(raw.includes('# demo-app 骨架'), raw.slice(0, 200))
    assert.ok(raw.includes('## 项目标识（来自 package.json）'))
    assert.ok(raw.includes('## 顶层结构'))
    assert.ok(raw.includes('## README 目录'))
    assert.ok(raw.includes('## 候选 L3（**待确认**'))
    assert.ok(raw.includes('不调用任何 LLM') || raw.includes('无 LLM'))

    // 关键纪律：**不得**自动写入任何 L3
    assert.equal((await store.listEntries()).length, 0, 'seed 不得自动写 L3（候选需模型确认）')
    // 库不再是 empty
    assert.equal((await store.status()).availability, 'ok')

    // 幂等：再跑一次不覆盖
    const again = await seedLibrary(store, store.config)
    assert.equal(again.written, false)
    assert.match(again.skipped.join(' '), /已存在/)
    // force 才覆盖
    const forced = await seedLibrary(store, store.config, { force: true })
    assert.equal(forced.written, true)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('seed: seed.enabled=false 时拒绝执行（业务错误）', async () => {
  const ws = await makeFixture()
  const store = new MemoryStore(ws, mergeConfig({ storageDir: '.memory', vcs: { enabled: false }, seed: { enabled: false } }))
  try {
    await store.init()
    await assert.rejects(() => seedLibrary(store, store.config), /已禁用/)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('seed: 真实 git 仓库读取提交历史', { skip: !GIT_OK && '本机无 git，跳过集成测试' }, async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-seed-git-'))
  const git = (args) =>
    spawnSync('git', args, {
      cwd: ws,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    })
  try {
    git(['init', '-b', 'main'])
    await writeFile(join(ws, 'a.txt'), 'a\n')
    git(['add', '.'])
    git(['commit', '-m', 'feat: 第一条提交'])
    await writeFile(join(ws, 'b.txt'), 'b\n')
    git(['add', '.'])
    git(['commit', '-m', 'fix: 第二条提交'])

    const store = new MemoryStore(ws, mergeConfig({ storageDir: '.memory', vcs: { enabled: false } }))
    await store.init()
    const result = await seedLibrary(store, store.config)
    assert.ok(result.signals.commits >= 2, '应读到至少 2 条提交: ' + JSON.stringify(result.signals))
    const raw = await readFile(join(ws, '.memory', 'docs', SEED_NOTE_REL_PATH), 'utf8')
    assert.ok(raw.includes('feat: 第一条提交'), '骨架应包含提交主题')
    assert.ok(raw.includes('## 近期提交'))
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})
