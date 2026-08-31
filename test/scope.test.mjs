/**
 * v0.3 scope:user 全局库测试。
 *
 * 独立文件：会临时改写 USERPROFILE/HOME（Windows 上 os.homedir 优先 USERPROFILE），
 * 与其他文件错峰（--test-concurrency=1 顺序执行），finally 恢复环境与临时目录。
 * 先断言库根解析正确，再 init（避免在真实主目录产生副作用）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from '../dist/config.js'
import { MemoryStore } from '../dist/store.js'

test('scope: user 全局库建在用户主目录且不碰工作区 .gitignore', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-scope-ws-'))
  const fakeHome = await mkdtemp(join(tmpdir(), 'dm3t-scope-home-'))
  const backup = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
  }
  const cwd = process.cwd()
  try {
    process.chdir(ws)
    process.env.USERPROFILE = fakeHome
    process.env.HOME = fakeHome
    process.env.HOMEDRIVE = undefined
    process.env.HOMEPATH = undefined

    const store = new MemoryStore(ws, {
      ...DEFAULT_CONFIG,
      scope: 'user',
      storageDir: '.memory',
      vcs: { ...DEFAULT_CONFIG.vcs, enabled: false },
    })
    assert.equal(store.root, join(fakeHome, '.memory'), 'user scope 相对路径应基于用户主目录解析')
    await store.init()

    // 库真的建在 fakeHome（而不是工作区）
    const { access } = await import('node:fs/promises')
    await access(join(fakeHome, '.memory', 'spaces'))
    // 工作区 .gitignore 未被创建 / 未被改（user scope 绝不污染工作区）
    await assert.rejects(access(join(ws, '.gitignore')), /ENOENT/)
  } finally {
    for (const [key, value] of Object.entries(backup)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    process.chdir(cwd)
    await new Promise((r) => setTimeout(r, 80))
    await rm(ws, { recursive: true, force: true })
    await rm(fakeHome, { recursive: true, force: true })
  }
})

test('scope: workspace 默认库在工作区且自维护 .gitignore', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-scope-ws2-'))
  const cwd = process.cwd()
  try {
    process.chdir(ws)
    // 模拟已有 git 项目：.gitignore 存在时维护行为是"追加"（不创建是设计，避免污染非 git 目录）
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(ws, '.gitignore'), 'node_modules/\n')
    const store = new MemoryStore(ws, { ...DEFAULT_CONFIG, vcs: { ...DEFAULT_CONFIG.vcs, enabled: false } })
    await store.init()
    assert.equal(store.root, join(ws, '.memory'))
    const { access, readFile } = await import('node:fs/promises')
    await access(join(store.root, 'spaces'))
    // workspace 粒度：工作区 .gitignore 应追加 .memory（v0.1 行为保留）
    const ignore = await readFile(join(ws, '.gitignore'), 'utf8')
    assert.ok(ignore.includes('.memory'))
    assert.equal(store.config.scope, 'workspace')
  } finally {
    process.chdir(cwd)
    await new Promise((r) => setTimeout(r, 80))
    await rm(ws, { recursive: true, force: true })
  }
})