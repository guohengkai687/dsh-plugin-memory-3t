/**
 * meta.json 重构回归（v0.7.4，schemaVersion 2）。
 *
 * 背景：v1 的 meta.json 写死了"创建时那个环境"的两样东西——绝对库根与一份配置快照，
 * 库一旦换机器/换平台（实测残留过 WSL 路径 /home/kiki/dsh work space/.memory）就全是假信息。
 * v2 只保留环境无关的库身份 + 库自身状态，外加每次打开刷新的诊断字段 lastOpen。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from '../dist/config.js'
import { PLUGIN_VERSION } from '../dist/shared.js'
import { MemoryStore } from '../dist/store.js'

async function makeStore(workspace, config = DEFAULT_CONFIG) {
  const store = new MemoryStore(workspace, config)
  await store.init()
  return store
}

async function readMeta(root) {
  return JSON.parse(await readFile(join(root, 'meta.json'), 'utf8'))
}

test('meta(v0.7.4): 新库写 schemaVersion 2，且不再写死 root / 配置快照', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-meta-'))
  const store = await makeStore(ws)
  const meta = await readMeta(store.root)
  assert.equal(meta.schemaVersion, 2)
  assert.equal(meta.root, undefined, 'v2 不再写死绝对库根')
  assert.equal(meta.config, undefined, 'v2 不再存配置快照（过期副本）')
  assert.deepEqual(meta.identity, { storageDir: DEFAULT_CONFIG.storageDir, scope: DEFAULT_CONFIG.scope })
  assert.equal(meta.pluginVersion, PLUGIN_VERSION)
  assert.equal(meta.lastOpen.root, store.root)
  assert.equal(meta.lastOpen.platform, process.platform)
  assert.equal(typeof meta.createdAt, 'string')
  assert.equal(typeof meta.updatedAt, 'string')
  await rm(ws, { recursive: true, force: true })
})

test('meta(v0.7.4): v1 旧文件迁移为 v2——丢弃外部环境的 root/config，保留库自身的 createdAt/digest/counters', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-meta-legacy-'))
  const legacyRoot = '/home/kiki/dsh work space/.memory'
  await mkdir(join(ws, '.memory'), { recursive: true })
  await writeFile(
    join(ws, '.memory', 'meta.json'),
    JSON.stringify({
      schemaVersion: 1,
      root: legacyRoot,
      createdAt: '2026-09-09T08:14:05.298Z',
      config: { storageDir: '.memory', scope: 'workspace', maxBootTokens: 600 },
      digest: { lastRunAt: '2026-09-23T08:28:56.545Z', pending: false, retries: 0, lastError: null },
      counters: { notedTotal: 23, entriesTotal: 31 },
    }, null, 2),
  )
  const store = await makeStore(ws)
  const meta = await readMeta(store.root)
  assert.equal(meta.schemaVersion, 2)
  assert.equal(meta.root, undefined, '过期的绝对库根必须被丢弃')
  assert.equal(meta.config, undefined, '过期的配置快照必须被丢弃')
  assert.equal(meta.createdAt, '2026-09-09T08:14:05.298Z', '创建时间属于库自身，必须保留')
  assert.equal(meta.digest.lastRunAt, '2026-09-23T08:28:56.545Z', 'digest 状态属于库自身，必须保留')
  assert.deepEqual(meta.counters, { notedTotal: 23, entriesTotal: 31 })
  assert.equal(meta.lastOpen.root, store.root, '打开环境刷新为当前环境')
  assert.notEqual(meta.lastOpen.root, legacyRoot)
  await rm(ws, { recursive: true, force: true })
})

test('meta(v0.7.4): 已是 v2 且环境未变时不重写文件（不污染记忆库的 git 历史）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-meta-stable-'))
  const store = await makeStore(ws)
  const path = join(store.root, 'meta.json')
  const first = await readFile(path, 'utf8')
  await makeStore(ws) // 同环境再打开一次
  assert.equal(await readFile(path, 'utf8'), first, '环境身份未变 → 不应重写')
  await rm(ws, { recursive: true, force: true })
})

test('meta(v0.7.4): 库被整体搬到新路径后，lastOpen 刷新为新环境（旧库根不残留）', async () => {
  const wsA = await mkdtemp(join(tmpdir(), 'dm3t-meta-move-a-'))
  const wsB = await mkdtemp(join(tmpdir(), 'dm3t-meta-move-b-'))
  const storeA = await makeStore(wsA)
  const metaA = await readMeta(storeA.root)
  await cp(join(wsA, '.memory'), join(wsB, '.memory'), { recursive: true })
  const storeB = await makeStore(wsB)
  const metaB = await readMeta(storeB.root)
  assert.notEqual(metaB.lastOpen.root, metaA.lastOpen.root, '换路径后必须刷新')
  assert.equal(metaB.lastOpen.root, storeB.root)
  assert.equal(metaB.createdAt, metaA.createdAt, '库身份不变 → 创建时间保留')
  await rm(wsA, { recursive: true, force: true })
  await rm(wsB, { recursive: true, force: true })
})

test('meta(v0.7.4): 损坏文件按新建处理（不抛错，直接落 v2）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dm3t-meta-broken-'))
  await mkdir(join(ws, '.memory'), { recursive: true })
  await writeFile(join(ws, '.memory', 'meta.json'), '{ not json')
  const store = await makeStore(ws)
  const meta = await readMeta(store.root)
  assert.equal(meta.schemaVersion, 2)
  assert.equal(meta.lastOpen.root, store.root)
  await rm(ws, { recursive: true, force: true })
})
