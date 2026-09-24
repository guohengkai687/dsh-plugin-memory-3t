/**
 * 版本与 wire 契约的自检：版本号不漂移 + v4 消息来源 kind 形态正确。
 * 这两个值都是"外部可见契约"（日志与 session 日志都写死它们），漂移会很难查。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { PRODUCER_SOURCE_KIND } from '../dist/index.js'
import { DEV_MEMORY_ENTRY_ID, DEV_MEMORY_SETTINGS_NS, PLUGIN_VERSION } from '../dist/shared.js'

test('version: PLUGIN_VERSION 与 package.json 的 version 一致', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(PLUGIN_VERSION, pkg.version)
})

test('version: v4 生产者 source kind 形态（非空、且不是被弃用的字面量 plugin）', () => {
  assert.equal(PRODUCER_SOURCE_KIND, 'plugin:dsh-plugin-memory-3t')
  assert.notEqual(PRODUCER_SOURCE_KIND, 'plugin')
  assert.ok(PRODUCER_SOURCE_KIND.length > 0)
})

test('version: 设置命名空间 = profile 条目 id，i18n 命名空间保持独立', () => {
  assert.equal(DEV_MEMORY_ENTRY_ID, 'dsh-plugin-memory-3t')
  assert.equal(DEV_MEMORY_SETTINGS_NS, 'dev-memory')
})
