import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFrontmatter, serializeFrontmatter } from '../dist/frontmatter.js'

test('frontmatter: 解析数组/数字/布尔/字符串', () => {
  const fm = `---
id: pref-20260115-abc
kind: preference
salience: 0.8
accesses: 3
tags: ["dsh", "记忆"]
links: []
---
第一行摘要
背景行
`
  const { data, body } = parseFrontmatter(fm)
  assert.equal(data.id, 'pref-20260115-abc')
  assert.equal(data.kind, 'preference')
  assert.equal(data.salience, 0.8)
  assert.equal(data.accesses, 3)
  assert.deepEqual(data.tags, ['dsh', '记忆'])
  assert.deepEqual(data.links, [])
  assert.equal(body.split('\n')[0], '第一行摘要')
})

test('frontmatter: 无 frontmatter 时返回空数据 + 原文', () => {
  const { data, body } = parseFrontmatter('# 纯正文\nhello')
  assert.deepEqual(data, {})
  assert.equal(body, '# 纯正文\nhello')
})

test('frontmatter: 序列化往返', () => {
  const data = { id: 'x', kind: 'context', salience: 0.5, tags: ['a', 'b'], links: [] }
  const text = serializeFrontmatter(data, '摘要行\n细节')
  const parsed = parseFrontmatter(text)
  assert.equal(parsed.data.id, 'x')
  assert.deepEqual(parsed.data.tags, ['a', 'b'])
  assert.equal(parsed.body, '摘要行\n细节\n')
})