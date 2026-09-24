/**
 * v0.7.1 设置桥测试（DSH 0.1.7 模型）。
 *
 * - applyEffective：可 live 字段原地更新 + 变更组；storageDir/scope/workspaceDir
 *   属启动期绑定（传入也不应用）；非法类型忽略。
 * - installDevMemorySettings：监听 `loader/volatile-update`，把 loader 提交后的 volatile
 *   引用解引用、补齐默认值后交回 hooks.apply；无 ctx.on / on 抛错 → fail-open。
 * - installSettingsPresentationPolicy：无 inject / 无 fiber / 无 settings 服务 → fail-open；
 *   正常路径必须以插件自身 fiber 为 owner 注册 `{ auto: false }`。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createVolatile, isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'

import { DEFAULT_CONFIG, mergeConfig } from '../dist/config.js'
import { DEV_MEMORY_ENTRY_ID, DEV_MEMORY_SETTINGS_NS } from '../dist/shared.js'
import {
  SETTINGS_SURFACE_DEFAULTS,
  applyEffective,
  installDevMemorySettings,
  installSettingsPresentationPolicy,
} from '../dist/settings.js'

test('settings: 常量（i18n 用 dev-memory，设置命名空间 = profile 条目 id）', () => {
  assert.match(DEV_MEMORY_SETTINGS_NS, /^[a-z][a-z0-9-]*$/)
  assert.equal(DEV_MEMORY_SETTINGS_NS, 'dev-memory')
  assert.equal(DEV_MEMORY_ENTRY_ID, 'dsh-plugin-memory-3t')
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

test('settings: volatile 桥解引用引用、补齐默认值并回放有效配置', () => {
  const rawConfig = {
    maxBootTokens: createVolatile(321),
    webui: createVolatile({ enabled: false }),
    diag: { enabled: true, maxEvents: 2000 },
  }
  // 前提：这些确实是 cosmokit 引用（与 loader 提交的形态一致）
  assert.equal(isVolatile(rawConfig.maxBootTokens), true)
  assert.equal(isVolatile(rawConfig.webui), true)

  const seen = []
  let handler
  installDevMemorySettings(
    {
      on: (event, fn) => {
        assert.equal(event, 'loader/volatile-update')
        handler = fn
      },
    },
    rawConfig,
    { apply: (next) => seen.push(next) },
  )
  assert.equal(typeof handler, 'function')
  assert.deepEqual(seen, [])

  // 模拟 loader 的 volatile-only 提交：引用内容变化，但不重挂载插件
  updateVolatile(rawConfig.maxBootTokens, createVolatile(999))
  handler()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].maxBootTokens, 999)
  assert.equal(seen[0].webui.enabled, false)
  assert.equal(seen[0].diag.maxEvents, 2000)
  // 未提供的字段补齐默认值
  assert.equal(seen[0].storageDir, DEFAULT_CONFIG.storageDir)
  assert.equal(seen[0].recall.minSalience, DEFAULT_CONFIG.recall.minSalience)
})

test('settings: installDevMemorySettings fail-open（无 on / on 抛错 / hooks 抛错）', () => {
  const hooks = { apply: () => { throw new Error('hook 抛错不应外泄') } }
  assert.equal(installDevMemorySettings({}, {}, { apply: () => {} }), undefined)
  assert.equal(installDevMemorySettings(null, {}, { apply: () => {} }), undefined)
  assert.equal(
    installDevMemorySettings({ on: () => { throw new Error('boom') } }, {}, { apply: () => {} }),
    undefined,
  )
  // hooks.apply 抛错 → 事件回调内部吞掉（loader 侧同样不允许监听器抛错）
  const handler = (() => {
    let fn
    installDevMemorySettings({ on: (_event, h) => { fn = h } }, {}, hooks)
    return fn
  })()
  assert.doesNotThrow(() => handler())
})

test('settings: installSettingsPresentationPolicy fail-open 且以插件 fiber 注册策略', () => {
  // 无 inject / 无 fiber / ctx 非法 → 静默跳过
  assert.equal(installSettingsPresentationPolicy(null), undefined)
  assert.equal(installSettingsPresentationPolicy({}), undefined)
  assert.equal(installSettingsPresentationPolicy({ inject: () => {} }), undefined)
  assert.equal(installSettingsPresentationPolicy({ inject: () => {}, fiber: {} }), undefined)
  // inject 抛错 → 静默跳过
  assert.equal(
    installSettingsPresentationPolicy({ fiber: {}, inject: () => { throw new Error('boom') } }),
    undefined,
  )

  const fiber = { id: 'plugin-fiber' }
  const calls = []
  const child = {
    effect: (fn) => {
      fn()
      return () => {}
    },
    settings: {
      configure: (presentation, owner) => {
        calls.push([presentation, owner])
        return () => {}
      },
    },
  }
  installSettingsPresentationPolicy({
    fiber,
    inject: (names, cb) => {
      assert.deepEqual([...names], ['settings'])
      cb(child)
    },
  })
  assert.deepEqual(calls, [[{ auto: false }, fiber]])
})
