import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isVolatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'
import { Config, DEFAULT_CONFIG, mergeConfig } from '../dist/config.js'

test('config: 默认值完整', () => {
  assert.equal(DEFAULT_CONFIG.storageDir, '.memory')
  assert.equal(DEFAULT_CONFIG.scope, 'workspace')
  assert.equal(DEFAULT_CONFIG.maxBootTokens, 600)
  assert.equal(DEFAULT_CONFIG.maxRuntimeTokens, 1200)
  assert.equal(DEFAULT_CONFIG.maxSpaceTokens, 800)
  assert.equal(DEFAULT_CONFIG.embedding.enabled, false)
  assert.equal(DEFAULT_CONFIG.recallNudge.enabled, false)
  assert.equal(DEFAULT_CONFIG.digest.maxRetries, 2)
  assert.equal(DEFAULT_CONFIG.dedupe.threshold, 0.55)
  // v0.4：诊断默认开、上限 2000
  assert.equal(DEFAULT_CONFIG.diag.enabled, true)
  assert.equal(DEFAULT_CONFIG.diag.maxEvents, 2000)
  // v0.5：WebUI 面板开关默认开
  assert.equal(DEFAULT_CONFIG.webui.enabled, true)
})

test('config: 空配置取默认值', () => {
  const c = mergeConfig(undefined)
  assert.deepEqual(c, DEFAULT_CONFIG)
})

test('config: 部分覆盖保留其余默认', () => {
  const c = mergeConfig({ storageDir: '/abs/path', maxBootTokens: 300 })
  assert.equal(c.storageDir, '/abs/path')
  assert.equal(c.maxBootTokens, 300)
  assert.equal(c.maxRuntimeTokens, 1200)
})

test('config: 嵌套覆盖', () => {
  const c = mergeConfig({ digest: { maxMessages: 10 }, recall: { highScore: 0.8 } })
  assert.equal(c.digest.maxMessages, 10)
  assert.equal(c.digest.maxPromote, 20)
  assert.equal(c.recall.highScore, 0.8)
})

test('config: 负数/非法数值钳制回默认', () => {
  const c = mergeConfig({ maxBootTokens: -5, maxRuntimeTokens: 'x', digest: { maxMessages: -1 } })
  assert.equal(c.maxBootTokens, 600)
  assert.equal(c.maxRuntimeTokens, 1200)
  assert.equal(c.digest.maxMessages, 24)
})

test('config: scope 为 user 时开启全局库，非法值回退 workspace', () => {
  assert.equal(mergeConfig({ scope: 'user' }).scope, 'user')
  assert.equal(mergeConfig({ scope: 'bogus' }).scope, 'workspace')
  assert.equal(mergeConfig({ scope: 42 }).scope, 'workspace')
})

test('config: embedding 默认（endpoint/model/timeoutMs）', () => {
  assert.equal(DEFAULT_CONFIG.embedding.enabled, false)
  assert.equal(DEFAULT_CONFIG.embedding.endpoint, 'http://localhost:11434')
  assert.equal(DEFAULT_CONFIG.embedding.model, 'nomic-embed-text')
  assert.equal(DEFAULT_CONFIG.embedding.timeoutMs, 3000)
})

test('config: embedding 合法覆盖 + 非法回退', () => {
  const c = mergeConfig({
    embedding: {
      enabled: true,
      endpoint: 'https://ollama.example.com:11434/',
      model: 'bge-m3',
      timeoutMs: 5000,
    },
  })
  assert.deepEqual(c.embedding, {
    enabled: true,
    endpoint: 'https://ollama.example.com:11434',
    model: 'bge-m3',
    timeoutMs: 5000,
  })
  const bad = mergeConfig({ embedding: { endpoint: 'not-a-url', model: '', timeoutMs: -1 } })
  assert.equal(bad.embedding.endpoint, 'http://localhost:11434')
  assert.equal(bad.embedding.model, 'nomic-embed-text')
  assert.equal(bad.embedding.timeoutMs, 3000)
})

test('config: diag 合法覆盖 + 非法钳制（v0.4）', () => {
  const c = mergeConfig({ diag: { enabled: false, maxEvents: 500 } })
  assert.equal(c.diag.enabled, false)
  assert.equal(c.diag.maxEvents, 500)
  // 负数/非法数值钳制回默认（与其余配置一致）；0 = 不限
  assert.equal(mergeConfig({ diag: { maxEvents: -3 } }).diag.maxEvents, 2000)
  assert.equal(mergeConfig({ diag: { maxEvents: 'x' } }).diag.maxEvents, 2000)
  assert.equal(mergeConfig({ diag: { maxEvents: 0 } }).diag.maxEvents, 0)
})

test('config: webui 面板开关（v0.5）', () => {
  assert.equal(mergeConfig({ webui: { enabled: false } }).webui.enabled, false)
  assert.equal(mergeConfig({ webui: {} }).webui.enabled, true)
  assert.equal(mergeConfig({ webui: 'x' }).webui.enabled, true)
})
test('config(v0.7.0): 工具暴露面 / subagent 注入 / L1 摘要 默认值与覆盖', () => {
  assert.equal(DEFAULT_CONFIG.toolsProfile, 'core')
  assert.equal(DEFAULT_CONFIG.subagentInject, false)
  assert.equal(DEFAULT_CONFIG.l1MaxCharsPerLine, 160)
  // 非法值回落默认
  assert.equal(mergeConfig({ toolsProfile: 'nope' }).toolsProfile, 'core')
  assert.equal(mergeConfig({ subagentInject: 'yes' }).subagentInject, false)
  // 显式覆盖
  const c = mergeConfig({ toolsProfile: 'full', subagentInject: true, l1MaxCharsPerLine: 0 })
  assert.equal(c.toolsProfile, 'full')
  assert.equal(c.subagentInject, true)
  assert.equal(c.l1MaxCharsPerLine, 0)
})

// ------------------------------------------------------------ v0.7.1：DSH 0.1.7 表单 schema

test('config(v0.7.1): Config schema 把 live 字段解析成引用、启动期字段保持普通值', () => {
  const parsed = Config({})
  // volatile 字段 → cosmokit 引用（loader 可原地提交新值，不重挂载插件）
  assert.equal(isVolatile(parsed.maxBootTokens), true)
  assert.equal(parsed.maxBootTokens.get(), 600)
  assert.equal(isVolatile(parsed.maxViewTokens), true)
  assert.equal(isVolatile(parsed.l3Inject), true)
  assert.equal(parsed.l3Inject.get(), 'off')
  // 组级 volatile：整组是一个引用
  assert.equal(isVolatile(parsed.webui), true)
  assert.deepEqual(parsed.webui.get(), { enabled: true })
  assert.equal(isVolatile(parsed.vcs), true)
  // 启动期绑定字段必须是普通值（改动 → 重挂载插件，而不是 live 提交）
  assert.equal(isVolatile(parsed.storageDir), false)
  assert.equal(parsed.storageDir, '.memory')
  assert.equal(isVolatile(parsed.scope), false)
  assert.equal(parsed.scope, 'workspace')
  assert.equal(isVolatile(parsed.workspaceDir), false)
  assert.equal(parsed.workspaceDir, '')
  // 解引用后归一化 = 运行时默认值（表单默认值与 DEFAULT_CONFIG 不漂移）
  assert.deepEqual(mergeConfig(parsed), DEFAULT_CONFIG)
})

test('config(v0.7.1): schema 解析部分组配置并补齐组内默认值', () => {
  const parsed = Config({ vcs: { enabled: false }, webui: { enabled: false }, maxBootTokens: 300 })
  assert.equal(parsed.vcs.get().enabled, false)
  assert.equal(parsed.vcs.get().autoCommit, true)
  assert.equal(parsed.vcs.get().batch, 8)
  assert.equal(parsed.webui.get().enabled, false)
  assert.equal(parsed.maxBootTokens.get(), 300)
  const merged = mergeConfig(parsed)
  assert.equal(merged.vcs.enabled, false)
  assert.equal(merged.vcs.autoCommit, true)
  assert.equal(merged.webui.enabled, false)
  assert.equal(merged.maxBootTokens, 300)
})

test('config(v0.7.1): schema 序列化含 volatile 标记，且 volatile 不嵌套', () => {
  // 宿主的 volatileForm/plainSchema 消费的就是 `new z(schema.toJSON())` 重建出来的 schema，
  // 这里用同一条路径断言（raw JSON 信封只有 uid/refs，meta 在原型上）。
  const json = Config.toJSON()
  const rebuilt = new z(json)
  const node = (parent, key) => parent?.dict?.[key]
  for (const key of ['maxBootTokens', 'maxRuntimeTokens', 'maxSpaceTokens', 'maxViewTokens', 'l3Inject', 'l1MaxCharsPerLine', 'subagentInject', 'toolsProfile', 'embedding', 'digest', 'recall', 'dedupe', 'index', 'recallNudge', 'vcs', 'diag', 'webui', 'seed']) {
    assert.equal(node(rebuilt, key)?.meta?.volatile, true, `${key} 应为 volatile（设置表单可见）`)
  }
  for (const key of ['storageDir', 'scope', 'workspaceDir']) {
    assert.equal(node(rebuilt, key)?.meta?.volatile, undefined, `${key} 不应 volatile（启动期绑定）`)
  }
  // schemastery 禁止 volatile 嵌套 volatile：组内字段不能再标
  const vcs = node(rebuilt, 'vcs')
  for (const key of ['enabled', 'autoCommit', 'debounceMs', 'batch', 'branch', 'identity', 'gitDir']) {
    assert.equal(node(vcs, key)?.meta?.volatile, undefined, `vcs.${key} 不应再标 volatile`)
  }
  const serialized = JSON.stringify(json)
  for (const key of ['webui', 'diag', 'recallNudge', 'vcs', 'embedding', 'digest', 'recall', 'seed', 'workspaceDir', 'scope', 'maxBootTokens', 'maxRuntimeTokens', 'maxSpaceTokens']) {
    assert.ok(serialized.includes(key), `schema 序列化缺字段 ${key}`)
  }
})
