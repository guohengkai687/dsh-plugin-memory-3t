/**
 * v0.7 MCP stdio 服务器集成测试。
 *
 * 全部用例都**真实 spawn** `node bin/dev-memory-mcp.mjs --root <临时目录>`，
 * 通过 stdin/stdout 走换行分隔的 JSON-RPC 2.0（MCP stdio 帧格式）全链路验证：
 *   1. initialize 回 serverInfo + tools capability（含 protocolVersion 回显/回退）
 *   2. tools/list 暴露全部 devmemory_* 工具且 inputSchema 根为 object
 *   3. tools/call 只读工具返回非空文本
 *   4. 写→读往返（remember → recall，证明 MCP 面真的驱动了记忆库）
 *   5. 未知方法 -32601；损坏行不杀进程（有 id → -32700，无 id → 静默忽略）
 *   6. notifications/initialized 不产生任何响应
 *   7. --storage-dir / DEV_MEMORY_ROOT 生效
 *   8. 错误分档：工具业务失败 → result + isError；未知工具名 → -32602
 *
 * 注意：测试**故意不改弱**（不检测沙箱、不跳过 spawn）。若运行环境禁止 Node 以管道
 * stdio spawn 子进程（harness 文件沙箱下可能 EPERM），用例会明确失败并在消息里带上
 * stderr，而不是静默通过。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = join(HERE, '..', 'bin', 'dev-memory-mcp.mjs')

/** 必须暴露的 11 个工具（工具集可增（v0.6.5 起另有 devmemory_seed），故断言"齐全"而非"恰好"）。 */
const REQUIRED_TOOLS = [
  'devmemory_status',
  'devmemory_recall',
  'devmemory_remember',
  'devmemory_note',
  'devmemory_link',
  'devmemory_forget',
  'devmemory_consolidate',
  'devmemory_history',
  'devmemory_diff',
  'devmemory_restore',
  'devmemory_diag',
]

const TIMEOUT_MS = 30000

/** 极简 MCP stdio 客户端：写一行 JSON-RPC，按 id 取响应，能断言"某消息没有响应"。 */
class McpClient {
  #child
  #buffer = ''
  #queue = []
  #waiters = []
  #stderr = ''
  #exit = null
  #spawnError = null
  #seq = 0

  constructor(args, env = {}) {
    try {
      this.#child = spawn(process.execPath, [BIN, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
        windowsHide: true,
      })
    } catch (error) {
      // 不弱化用例（仍然失败），只把环境原因说清楚：某些沙箱禁止以管道 stdio spawn 子进程
      // （harness 文件沙箱下报 spawn EPERM），此时本套件无法运行，需要在正常环境里跑。
      throw new Error(
        `无法启动 MCP 服务器子进程（${error?.code ?? '?'} ${error?.message ?? error}）：` +
          '本用例需要允许「管道 stdio spawn 子进程」的运行环境（沙箱下会 EPERM）。',
        { cause: error },
      )
    }
    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk) => this.#ingest(chunk))
    this.#child.stderr.setEncoding('utf8')
    this.#child.stderr.on('data', (chunk) => {
      this.#stderr += chunk
    })
    // 对端已退出时的 EPIPE 不算测试失败；由 waitMessage/close 给出可读错误。
    this.#child.stdin.on('error', () => {})
    this.#child.on('error', (error) => {
      this.#spawnError = error
      this.#failWaiters(`服务器进程启动失败: ${error.message}`)
    })
    this.#child.on('exit', (code, signal) => {
      this.#exit = { code, signal }
      this.#failWaiters(`服务器提前退出（code=${code} signal=${signal}）; stderr: ${this.#stderr.trim()}`)
    })
  }

  get stderr() {
    return this.#stderr
  }

  get exitInfo() {
    return this.#exit
  }

  /** 仍在队列里未被消费的消息数：用于断言"通知不产生响应"。 */
  get pendingCount() {
    return this.#queue.length
  }

  #ingest(chunk) {
    this.#buffer += chunk
    let index = this.#buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line !== '') {
        let message
        try {
          message = JSON.parse(line)
        } catch {
          message = { __unparsableStdout: line }
        }
        this.#deliver(message)
      }
      index = this.#buffer.indexOf('\n')
    }
  }

  #deliver(message) {
    for (let i = 0; i < this.#waiters.length; i += 1) {
      const waiter = this.#waiters[i]
      if (waiter.pred(message)) {
        this.#waiters.splice(i, 1)
        clearTimeout(waiter.timer)
        waiter.resolve(message)
        return
      }
    }
    this.#queue.push(message)
  }

  #failWaiters(message) {
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(message))
    }
  }

  #write(text) {
    if (this.#spawnError !== null) throw new Error(`服务器进程启动失败: ${this.#spawnError.message}`)
    this.#child.stdin.write(`${text}\n`)
  }

  send(message) {
    this.#write(JSON.stringify(message))
  }

  /** 写一行原始文本（用于注入损坏 JSON）。 */
  sendRaw(text) {
    this.#write(text)
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', ...(params === undefined ? {} : { params }), method })
  }

  request(method, params) {
    this.#seq += 1
    const id = this.#seq
    this.send({ jsonrpc: '2.0', id, ...(params === undefined ? {} : { params }), method })
    return this.waitMessage((message) => message.id === id)
  }

  waitMessage(pred, timeoutMs = TIMEOUT_MS) {
    if (this.#spawnError !== null) {
      return Promise.reject(new Error(`服务器进程启动失败: ${this.#spawnError.message}`))
    }
    for (let i = 0; i < this.#queue.length; i += 1) {
      const message = this.#queue[i]
      if (pred(message)) {
        this.#queue.splice(i, 1)
        return Promise.resolve(message)
      }
    }
    return new Promise((resolve, reject) => {
      const waiter = { pred, resolve, reject, timer: null }
      waiter.timer = setTimeout(() => {
        const i = this.#waiters.indexOf(waiter)
        if (i !== -1) this.#waiters.splice(i, 1)
        reject(new Error(`等待响应超时（${timeoutMs}ms）; stderr: ${this.#stderr.trim()}`))
      }, timeoutMs)
      this.#waiters.push(waiter)
    })
  }

  /** 关闭 stdin 并等进程退出（EOF 必须让服务器干净退出）。 */
  async close(timeoutMs = TIMEOUT_MS) {
    if (this.#exit !== null) return this.#exit
    this.#child.stdin.end()
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#child.kill('SIGKILL')
        reject(new Error(`服务器未在 ${timeoutMs}ms 内退出（stdin EOF 未生效）; stderr: ${this.#stderr.trim()}`))
      }, timeoutMs)
      this.#child.once('exit', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal })
      })
      if (this.#exit !== null) {
        clearTimeout(timer)
        resolve(this.#exit)
      }
    })
  }
}

async function makeRoot() {
  return await mkdtemp(join(tmpdir(), 'dm3t-mcp-'))
}

async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

/** 取 tools/call 响应里的首个文本块（顺带校验形状）。 */
function textOf(response) {
  assert.equal(response.error, undefined, `应为 result 而非 error: ${JSON.stringify(response.error)}`)
  const content = response.result?.content
  assert.ok(Array.isArray(content) && content.length > 0, 'content 必须是非空数组')
  assert.equal(content[0].type, 'text')
  assert.equal(typeof content[0].text, 'string')
  assert.ok(content[0].text.length > 0, '文本内容不得为空')
  return content[0].text
}

test('mcp: initialize 返回 serverInfo 与 tools capability', async () => {
  const root = await makeRoot()
  const client = new McpClient(['--root', root, '--no-vcs'])
  try {
    const response = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dm3t-test', version: '1.0.0' },
    })
    assert.equal(response.error, undefined)
    assert.equal(response.result.protocolVersion, '2025-06-18')
    assert.equal(response.result.serverInfo.name, 'dsh-plugin-memory-3t')
    assert.equal(typeof response.result.serverInfo.version, 'string')
    assert.ok(response.result.serverInfo.version.length > 0)
    assert.ok(response.result.capabilities.tools !== undefined, 'capabilities.tools 必须存在')
    assert.equal(typeof response.result.capabilities.tools, 'object')

    // 客户端不声明 protocolVersion → 回退到服务器默认值（仍是可用的协议版本）
    const fallback = await client.request('initialize', {})
    assert.equal(typeof fallback.result.protocolVersion, 'string')
    assert.ok(/^\d{4}-\d{2}-\d{2}$/u.test(fallback.result.protocolVersion))
  } finally {
    await client.close()
    await cleanup(root)
  }
})

test('mcp: tools/list 暴露全部 devmemory_* 工具且 inputSchema 为 object', async () => {
  const root = await makeRoot()
  const client = new McpClient(['--root', root, '--no-vcs'])
  try {
    const { result } = await client.request('tools/list')
    assert.ok(Array.isArray(result.tools), 'tools 必须是数组')
    assert.ok(result.tools.length >= REQUIRED_TOOLS.length, `工具数应 ≥ ${REQUIRED_TOOLS.length}，实际 ${result.tools.length}`)
    for (const tool of result.tools) {
      assert.match(tool.name, /^devmemory_/u, `工具名应以 devmemory_ 开头: ${tool.name}`)
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} 的 inputSchema 根必须是 object`)
      assert.equal(typeof tool.description, 'string')
      assert.ok(tool.description.length > 10, `${tool.name} 描述过短`)
    }
    const names = new Set(result.tools.map((tool) => tool.name))
    for (const required of REQUIRED_TOOLS) assert.ok(names.has(required), `缺少工具 ${required}`)
  } finally {
    await client.close()
    await cleanup(root)
  }
})

test('mcp: tools/call 只读工具返回非空文本', async () => {
  const root = await makeRoot()
  const client = new McpClient(['--root', root, '--no-vcs'])
  try {
    const response = await client.request('tools/call', { name: 'devmemory_status', arguments: {} })
    assert.equal(response.result.isError, false)
    const status = JSON.parse(textOf(response))
    assert.equal(status.ready, true)
    assert.equal(status.scope, 'workspace')
    assert.ok(status.root.endsWith('.memory'), `库根应为 <root>/.memory，实际 ${status.root}`)
  } finally {
    await client.close()
    await cleanup(root)
  }
})

test('mcp: remember → recall 往返（MCP 面真的驱动记忆库）', async () => {
  const root = await makeRoot()
  // 这条用例刻意用默认配置（git 版本回溯开着）：EOF 收尾会 flush，顺带覆盖收尾路径。
  const client = new McpClient(['--root', root])
  try {
    const marker = `mcproundtrip${Date.now().toString(36)}`
    const write = await client.request('tools/call', {
      name: 'devmemory_remember',
      arguments: { kind: 'context', content: `${marker}：由 MCP 集成测试写入的三层记忆往返标记。`, tags: ['mcp-test'] },
    })
    assert.equal(write.result.isError, false)
    const written = JSON.parse(textOf(write))
    assert.match(written.id, /^ctx-/u, `remember 应返回 L3 条目 id，实际 ${written.id}`)

    const read = await client.request('tools/call', {
      name: 'devmemory_recall',
      arguments: { query: marker, layers: ['l3'] },
    })
    assert.equal(read.result.isError, false)
    const recalled = textOf(read)
    assert.ok(recalled.includes(marker), `recall 应命中刚写入的内容: ${recalled}`)
    assert.ok(recalled.includes(written.id), `recall 结果应包含条目 id ${written.id}`)
  } finally {
    const exit = await client.close()
    assert.equal(exit.code, 0, `stdin EOF 后应正常退出，实际 code=${exit.code} signal=${exit.signal}; stderr: ${client.stderr}`)
    await cleanup(root)
  }
})

test('mcp: 未知方法 -32601；损坏行不杀进程（有 id → -32700，无 id → 静默忽略）', async () => {
  const root = await makeRoot()
  const client = new McpClient(['--root', root, '--no-vcs'])
  try {
    const unknown = await client.request('bogus/method', {})
    assert.equal(unknown.result, undefined)
    assert.equal(unknown.error.code, -32601)
    assert.match(unknown.error.message, /bogus\/method/u)

    // 损坏 JSON（能抠出 id）→ 解析错误 -32700，进程继续
    client.sendRaw('{"jsonrpc":"2.0","id":4242,"method":"tools/list"')
    const parseError = await client.waitMessage((message) => message.id === 4242)
    assert.equal(parseError.error.code, -32700)

    // 损坏 JSON（无 id）→ 静默忽略，不得崩溃：后续请求仍必须得到正常响应
    client.sendRaw('这不是 JSON')
    const alive = await client.request('initialize', { protocolVersion: '2025-06-18' })
    assert.equal(alive.error, undefined)
    assert.equal(alive.result.serverInfo.name, 'dsh-plugin-memory-3t')
    assert.equal(client.exitInfo, null, '进程不应因损坏输入而退出')
  } finally {
    await client.close()
    await cleanup(root)
  }
})

test('mcp: notifications/initialized 不产生任何响应', async () => {
  const root = await makeRoot()
  const client = new McpClient(['--root', root, '--no-vcs'])
  try {
    await client.request('initialize', { protocolVersion: '2025-06-18' })
    client.notify('notifications/initialized')
    const response = await client.request('tools/list')
    assert.equal(response.error, undefined)
    // 通知在 tools/list 之前入队处理：若它产生了响应，此刻必留在未被消费的队列里。
    assert.equal(client.pendingCount, 0, 'notifications/initialized 不得产生任何响应')
  } finally {
    await client.close()
    await cleanup(root)
  }
})

test('mcp: --storage-dir 与 DEV_MEMORY_ROOT 生效', async () => {
  const root = await makeRoot()
  // 不给 --root，仅用环境变量指定工作区根；库目录名走 --storage-dir。
  const client = new McpClient(['--storage-dir=mem-alt', '--no-vcs'], { DEV_MEMORY_ROOT: root })
  try {
    const response = await client.request('tools/call', { name: 'devmemory_status', arguments: {} })
    const status = JSON.parse(textOf(response))
    assert.ok(status.root.endsWith('mem-alt'), `库根应用 --storage-dir 覆盖，实际 ${status.root}`)
    assert.ok(status.root.startsWith(root), `库根应基于 DEV_MEMORY_ROOT 解析，实际 ${status.root}`)
  } finally {
    await client.close()
    await cleanup(root)
  }
})

test('mcp: 工具业务失败 → result + isError；未知工具名 → -32602', async () => {
  const root = await makeRoot()
  const client = new McpClient(['--root', root, '--no-vcs'])
  try {
    // 工具内部抛错（空 query）→ JSON-RPC result + isError:true（错误是给模型看的数据）
    const failed = await client.request('tools/call', { name: 'devmemory_recall', arguments: { query: '   ' } })
    assert.equal(failed.error, undefined, '工具业务失败不应升级为 JSON-RPC error')
    assert.equal(failed.result.isError, true)
    assert.ok(failed.result.content[0].text.includes('query 不能为空'), failed.result.content[0].text)

    // 未知工具名属于参数问题 → -32602
    const unknownTool = await client.request('tools/call', { name: 'devmemory_nope', arguments: {} })
    assert.equal(unknownTool.error.code, -32602)
  } finally {
    await client.close()
    await cleanup(root)
  }
})

test('mcp(v0.7.0): --tools core 暴露 6 个工具（5 高频 + admin）', async () => {
  const root = await makeRoot()
  const core = new McpClient(['--root', root, '--no-vcs', '--tools', 'core'])
  try {
    const { result } = await core.request('tools/list')
    const names = result.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, ['devmemory_admin', 'devmemory_consolidate', 'devmemory_note', 'devmemory_recall', 'devmemory_remember', 'devmemory_status'])
    // admin 的 op 覆盖全部低频动作（含 diag/restore 等危险操作）
    const admin = result.tools.find((tool) => tool.name === 'devmemory_admin')
    assert.deepEqual([...admin.inputSchema.properties.op.enum].sort(), ['diag', 'diff', 'forget', 'history', 'link', 'restore', 'seed'])
    assert.equal(admin.inputSchema.type, 'object')
  } finally {
    await core.close()
    await cleanup(root)
  }
})

test('mcp(v0.7.0): --tools=core 等价写法与非法值退出码', async () => {
  const root = await makeRoot()
  const inline = new McpClient(['--root', root, '--no-vcs', '--tools=core'])
  try {
    const { result } = await inline.request('tools/list')
    assert.equal(result.tools.length, 6, '--tools=core 内联写法应同样生效')
  } finally {
    await inline.close()
    await cleanup(root)
  }
  // 非法值 → main() 返回 2（用法错误），stdout 不得出现 JSON-RPC 响应
  const { main } = await import('../dist/mcp.js')
  const code = await main(['--root', root, '--tools', 'nope'])
  assert.equal(code, 2, '非法 --tools 应以退出码 2 结束')
})
