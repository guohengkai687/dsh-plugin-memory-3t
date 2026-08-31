/**
 * v0.5 设置页桥测试。
 *
 * - applyEffective：可 live 字段原地更新 + 变更组；storageDir/scope/workspaceDir
 *   属启动期绑定（传入也不应用）；非法类型忽略。
 * - installDevMemorySettings：fail-open（无 inject / inject 不触发 / inject 抛错均不抛）。
 * - 依赖在场时：loadSettingsDeps 装配成功、buildSettingsSchema 形状正确、namespace 常量合法。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, mergeConfig } from '../dist/config.js'
import {
  DEV_MEMORY_SETTINGS_NS,
  SETTINGS_SURFACE_DEFAULTS,
  applyEffective,
  buildSettingsSchema,
  installDevMemorySettings,
  loadSettingsDeps,
} from '../dist/settings.js'

test('settings: namespace 常量合法且与表面默认值一致', () => {
  assert.match(DEV_MEMORY_SETTINGS_NS, /^[a-z][a-z0-9-]*$/)
  assert.equal(DEV_MEMORY_SETTINGS_NS, 'dev-memory')
  assert.equal(SETTINGS_SURFACE_DEFAULTS.webui.enabled, true)
  assert.equal(SETTINGS_SURFACE_DEFAULTS.diag.maxEvents, 2000)
})

test('settings: applyEffective 原地更新 live 字段并返回变更组', () => {
  const target = mergeConfig({})
  const next = {
    webui: { enabled: false },
    diag: { enabled: false, maxEvents: 500 },
    recallNudge: { enabled: true },
    vcs: { enabled: false, autoCommit: false, debounceMs: 2500, batch: 20 },
    embedding: { enabled: true, endpoint: 'https://ollama.example.com/', model: 'bge-m3', timeoutMs: 5000 },
    digest: { maxMessages: 12 },
    recall: { minSalience: 0.4 },
    maxBootTokens: 400,
    maxRuntimeTokens: 900,
    maxSpaceTokens: 700,
  }
  const change = applyEffective(target, next)
  assert.deepEqual(change, {
    webui: true,
    diag: true,
    nudge: true,
    vcs: true,
    embedding: true,
    digest: true,
    recall: true,
    budgets: true,
  })
  // 原地更新断言
  assert.equal(target.webui.enabled, false)
  assert.deepEqual(target.diag, { enabled: false, maxEvents: 500 })
  assert.equal(target.recallNudge.enabled, true)
  assert.deepEqual(target.vcs, {
    ...DEFAULT_CONFIG.vcs,
    enabled: false,
    autoCommit: false,
    debounceMs: 2500,
    batch: 20,
  })
  assert.deepEqual(target.embedding, {
    enabled: true,
    endpoint: 'https://ollama.example.com',
    model: 'bge-m3',
    timeoutMs: 5000,
  })
  assert.equal(target.digest.maxMessages, 12)
  assert.equal(target.recall.minSalience, 0.4)
  assert.equal(target.maxBootTokens, 400)
  assert.equal(target.maxRuntimeTokens, 900)
  assert.equal(target.maxSpaceTokens, 700)
})

test('settings: applyEffective 不触碰启动期绑定字段', () => {
  const target = mergeConfig({})
  const change = applyEffective(target, {
    storageDir: '/elsewhere',
    scope: 'user',
    workspaceDir: '/pinned',
    webui: { enabled: false },
  })
  assert.deepEqual(change, { webui: true })
  assert.equal(target.storageDir, DEFAULT_CONFIG.storageDir)
  assert.equal(target.scope, 'workspace')
  assert.equal(target.workspaceDir, '')
  assert.equal(target.webui.enabled, false)
})

test('settings: applyEffective 忽略非法类型与未知组', () => {
  const target = mergeConfig({})
  const change = applyEffective(target, {
    webui: { enabled: 'x' },
    diag: { enabled: 1, maxEvents: 'nope' },
    unknownGroup: { a: 1 },
    maxBootTokens: -3,
    recall: { minSalience: 5 },
  })
  assert.deepEqual(change, {})
  assert.equal(target.webui.enabled, true)
  assert.equal(target.diag.maxEvents, 2000)
  assert.equal(target.maxBootTokens, 600)
  assert.equal(target.recall.minSalience, 0.25)
})

test('settings: applyEffective 无变化时不报变更', () => {
  const target = mergeConfig({})
  const change = applyEffective(target, {
    webui: { enabled: true },
    diag: { enabled: true, maxEvents: 2000 },
    recallNudge: { enabled: false },
  })
  assert.deepEqual(change, {})
})

test('settings: installDevMemorySettings fail-open（无 inject / inject 不触发 / 抛错）', () => {
  const entry = mergeConfig({})
  const hooks = { apply: () => { throw new Error('不应被调用') } }
  // 无 inject
  assert.equal(installDevMemorySettings({}, entry, hooks), undefined)
  assert.equal(installDevMemorySettings(null, entry, hooks), undefined)
  // inject 从不触发回调
  assert.equal(installDevMemorySettings({ inject: () => {} }, entry, hooks), undefined)
  // inject 本身抛错
  assert.equal(installDevMemorySettings({ inject: () => { throw new Error('boom') } }, entry, hooks), undefined)
})

test('settings: 依赖在场时依赖装载与 schema 形状正确（缺依赖自动跳过）', async () => {
  let deps
  try {
    deps = await loadSettingsDeps()
  } catch {
    deps = null
  }
  if (deps === null) {
    // 依赖缺失环境（CI 离线）→ fail-open 路径本身已被上一用例覆盖
    assert.ok(true, '依赖缺失，跳过 schema 形状断言')
    return
  }
  assert.equal(typeof deps.installSettingsSection, 'function')
  assert.equal(typeof deps.settingsNamespace, 'function')
  assert.ok(typeof deps.z.object === 'function')
  const schema = buildSettingsSchema(deps.z)
  // schemastery 的 Schema 实例是 callable（schema(value) 验证），typeof 为 function
  assert.ok(schema !== null && (typeof schema === 'object' || typeof schema === 'function'))
  // 序列化形态（schema.toJSON 由 schemastery Schema 提供）应含全部表面字段
  const toJson = typeof schema.toJSON === 'function' ? schema.toJSON() : schema
  const serialized = JSON.stringify(toJson)
  for (const key of ['webui', 'diag', 'recallNudge', 'vcs', 'embedding', 'digest', 'recall', 'workspaceDir', 'scope', 'maxBootTokens', 'maxRuntimeTokens', 'maxSpaceTokens']) {
    assert.ok(serialized.includes(key), `schema 序列化缺字段 ${key}`)
  }
})