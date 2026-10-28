import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createLlmClient, extractJson, resolveRoute, sessionRouteOf } from '../dist/llm.js'

/** 造一个最小宿主 llm 服务：prepareCall 回显 config，stream 吐给定分片。 */
function fakeService(chunks, seen = []) {
  return {
    async prepareCall(config) {
      seen.push(config)
      return {
        config: { ...config, purpose: 'test' },
        async *stream(options) {
          seen.push(options)
          for (const chunk of chunks) yield chunk
        },
      }
    },
  }
}

test('llm(v0.10.0): extractJson 支持围栏/嵌套/前缀废话，坏输入返回 null', () => {
  assert.deepEqual(extractJson('```json\n[{"a":1}]\n```'), [{ a: 1 }])
  assert.deepEqual(extractJson('好的，结果如下：{"x":{"y":2}} 完毕'), { x: { y: 2 } })
  assert.equal(extractJson('没有任何 JSON'), null)
  assert.equal(extractJson('[1,2'), null)
})

test('llm(v0.10.0): sessionRouteOf 读 agent.session.header.config', () => {
  assert.deepEqual(sessionRouteOf({ session: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } } } }), {
    provider: 'deepseek',
    model: 'deepseek-chat',
  })
  assert.equal(sessionRouteOf({ session: { header: { config: { provider: 'deepseek' } } } }), undefined)
  assert.equal(sessionRouteOf(undefined), undefined)
})

test('llm(v0.10.0): resolveRoute 显式配置 > 会话 > none', () => {
  const explicit = resolveRoute({
    service: {},
    explicit: { provider: 'p', model: 'm' },
    session: { provider: 's', model: 'sm' },
  })
  assert.equal(explicit.source, 'config')
  assert.deepEqual(explicit.route, { provider: 'p', model: 'm' })

  const session = resolveRoute({ service: {}, explicit: { provider: '', model: null }, session: { provider: 's', model: 'sm' } })
  assert.equal(session.source, 'session')
  assert.deepEqual(session.route, { provider: 's', model: 'sm' })

  assert.equal(resolveRoute({ service: {} }).route, null)
})

test('llm(v0.10.0): createLlmClient 在缺服务/缺路由时返回 null', () => {
  assert.equal(createLlmClient({ service: undefined, session: { provider: 'p', model: 'm' } }), null)
  assert.equal(createLlmClient({ service: {}, session: { provider: 'p', model: 'm' } }), null)
  assert.equal(createLlmClient({ service: fakeService([]), session: undefined, explicit: null }), null)
})

test('llm(v0.10.0): complete 走 prepareCall + stream，拼接 text-delta', async () => {
  const seen = []
  const service = fakeService(
    [
      { type: 'text-delta', text: '你好' },
      { type: 'text-delta', text: '，记忆' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    seen,
  )
  const client = createLlmClient({ service, session: { provider: 'deepseek', model: 'deepseek-chat' } })
  assert.ok(client !== null)
  assert.equal(client.source, 'session')
  const text = await client.complete({ system: 'sys', prompt: 'q' })
  assert.equal(text, '你好，记忆')
  assert.deepEqual(seen[0], { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 800 })
  assert.equal(seen[1].system, 'sys')
  assert.equal(seen[1].messages[0].content[0].text, 'q')
  assert.equal(seen[1].purpose, 'test', 'prepareCall 的 config 要展开进 stream 选项')
})

test('llm(v0.10.0): finish=error 抛错（供调用方回退启发式）', async () => {
  const service = fakeService([{ type: 'finish', reason: { kind: 'error', failure: { code: 'x', message: '额度用尽' } } }])
  const client = createLlmClient({ service, explicit: { provider: 'p', model: 'm' } })
  assert.ok(client !== null)
  await assert.rejects(() => client.complete({ system: 's', prompt: 'q' }), /额度用尽/u)
})
