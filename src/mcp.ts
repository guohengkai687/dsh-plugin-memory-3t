/**
 * dev-memory-mcp：零运行时依赖的 MCP（Model Context Protocol）stdio 服务器。
 *
 * 目的：把本插件既有的 `devmemory_*` 工具（本次实现时为 11 个；工具集仍在增长，
 * 数量由 `createTools` 决定，此处不做硬编码）暴露给任意支持 MCP 的编码 agent
 * （Claude Code / Cursor / 自研 agent 等），使其能直接读写本工作区的三层记忆库。
 *
 * ── 为什么手写协议（不引 @modelcontextprotocol/sdk）────────────────────────────
 * 本项目的第一硬约束是**零运行时依赖**（package.json 里现有依赖只是 DSH 本体的
 * 声明，核心逻辑不 import 任何第三方包）。MCP stdio 传输本身极薄：
 *   1) 帧格式 = 一行一个 JSON-RPC 2.0 消息（换行分隔，非 LSP 的 Content-Length 头）；
 *   2) 服务器侧只需实现 initialize / notifications\/initialized / tools\/list / tools\/call
 *      四个方法 + ping，全部是纯数据变换。
 * 引入官方 SDK 会带来一整棵传递依赖树（zod、eventsource、express/raw-body…），
 * 为一个 ~300 行的协议实现付出供应链与体积代价，与本项目的立场不符。
 * 因此协议、帧、错误码全部手写，且**工具实现完全复用** `createTools`，保证
 * MCP 面与 DSH 面永远同源（不复制 schema、不复制渲染）。
 *
 * ── 用法 / 配置解析（本进程没有 DSH 会话，库位必须显式解析）─────────────────────
 *   dev-memory-mcp [options]
 *
 *   --root <dir>            工作区根（记忆库的基准目录）。默认 process.cwd()；
 *                           亦可用环境变量 DEV_MEMORY_ROOT 指定。--root 优先级更高。
 *   --storage-dir <name>    库目录名/路径，默认 `.memory`（相对 root 解析；绝对路径原样）；
 *                           亦可用环境变量 DEV_MEMORY_STORAGE_DIR。
 *   --scope <workspace|user> 记忆库粒度，默认 workspace（每工作区一库）；
 *                           user = 全局一库（基准为用户主目录，此时 --root 仅用于 .gitignore 推断）。
 *   --no-vcs                关闭 git 版本回溯（默认开启，等同 mergeConfig 默认值）。
 *   --vcs-branch <name>     git 初始化分支名（默认 main）。
 *   --embedding             开启 Ollama 向量检索融合（默认关闭，纯 BM25）。
 *   -h, --help              打印用法（写 stderr）并退出 0。
 *
 * 退出码：0 正常（含 stdin EOF 收尾）/ 1 运行时失败（初始化/服务异常）/ 2 用法错误。
 *
 * ── 协议实现约定 ────────────────────────────────────────────────────────────
 * - 帧：stdin 按 `\n` 切分，逐行 JSON.parse；无换行的末行在 EOF 时也会处理。
 * - **stdout 只走协议**（一行一个响应）；一切诊断/用法/错误说明一律写 stderr。
 * - 请求按到达顺序串行处理（单条 promise 链），避免并发写同一记忆库。
 * - 无 `id` 的消息视为通知：**一律不响应**（notifications\/initialized 静默接受）。
 * - 错误分两档（贯穿一致，勿混）：
 *     a) 协议级失败 → JSON-RPC `error`：解析失败 -32700、非法请求 -32600、
 *        未知方法 -32601、参数非法（含未知工具名/arguments 非对象）-32602、
 *        处理器内部异常 -32603；
 *     b) **工具业务失败 → JSON-RPC `result` + `isError: true`**（MCP 约定：工具执行
 *        错误是给模型看的**数据**而非协议失败，客户端应原样回喂模型；同时也与插件
 *        "记忆故障只降级、不打断会话"的 fail-open 立场一致）。
 * - 工具返回值经该工具自己的 `output.render` 渲染成文本块，故 MCP 返回的 text
 *   与 DSH 面上模型看到的文本逐字节相同。
 * - stdin EOF → 排空已入队请求 → flush git（提交悬挂写入）→ 退出 0。
 *
 * 复用面（本次未改动任何既有源文件）：`MemoryStore` + `mergeConfig` + `createTools`。
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { DEFAULT_CONFIG, mergeConfig, type Scope } from './config.js'
import { DigestEngine } from './digest.js'
import { MemoryStore } from './store.js'
import { createTools, type ToolDefinition, type ToolsProfile } from './tools.js'

/** 客户端未声明 protocolVersion 时的回退值（MCP 2025-06-18 修订版）。 */
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

/** MCP serverInfo.name（与包名一致，便于客户端识别）。 */
const SERVER_NAME = 'dsh-plugin-memory-3t'

/** JSON-RPC 2.0 错误码。 */
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

/** initialize 后给客户端的一段使用提示（可选字段，纯引导）。 */
const SERVER_INSTRUCTIONS =
  '本地三层记忆库（L1 会话流水 / L2 知识笔记 / L3 长期事实）。查记忆用 devmemory_recall（唯一读入口），' +
  '写入用 devmemory_remember（L3）/ devmemory_note（L2）；查不到要明说，不要臆造。' +
  '收尾时用 devmemory_consolidate 沉淀并提交 git 版本。'

const USAGE = `dev-memory-mcp —— 三层记忆库 MCP stdio 服务器（零运行时依赖）

用法：
  dev-memory-mcp [options]

选项：
  --root <dir>              工作区根（默认 process.cwd()；环境变量 DEV_MEMORY_ROOT）
  --storage-dir <name>      库目录名/路径（默认 .memory；环境变量 DEV_MEMORY_STORAGE_DIR）
  --scope <workspace|user>  记忆库粒度（默认 workspace）
  --no-vcs                  关闭 git 版本回溯
  --vcs-branch <name>       git 分支名（默认 main）
  --embedding               开启 Ollama 向量检索融合（默认关闭）
  --tools <core|full>       工具暴露面（默认 full = 12 个独立工具；core = 5 高频 + 1 个 action 式 admin）
  -h, --help                显示本帮助

环境变量：
  DEV_MEMORY_ROOT           同 --root
  DEV_MEMORY_STORAGE_DIR    同 --storage-dir

示例：
  dev-memory-mcp --root D:/work/my-project
  DEV_MEMORY_ROOT=/home/me/proj dev-memory-mcp --storage-dir .memory --no-vcs

退出码：0 正常 / 1 运行时失败 / 2 用法错误。stdout 仅承载 JSON-RPC，诊断一律走 stderr。`

/** 解析后的启动选项。 */
interface CliOptions {
  root: string
  storageDir: string
  scope: Scope
  vcsEnabled: boolean
  vcsBranch: string | undefined
  embeddingEnabled: boolean
  /**
   * 工具暴露面（v0.7.0）：默认 `full`——MCP 客户端看不到本插件的 boot 块与
   * dev-memory skill，逐工具粒度更稳；想让对方模型少带 ~1.2k tokens/调用时开 `--tools=core`。
   */
  toolsProfile: ToolsProfile
  help: boolean
}

type ParseResult = { ok: true; options: CliOptions } | { ok: false; message: string }

/**
 * 解析命令行（含 `--flag=value` 与 `--flag value` 两种写法）。
 * 环境变量提供默认值，显式参数优先。
 */
function parseArgs(argv: string[]): ParseResult {
  const envRoot = process.env.DEV_MEMORY_ROOT?.trim()
  const envStorage = process.env.DEV_MEMORY_STORAGE_DIR?.trim()
  const options: CliOptions = {
    root: envRoot !== undefined && envRoot !== '' ? envRoot : process.cwd(),
    storageDir: envStorage !== undefined && envStorage !== '' ? envStorage : DEFAULT_CONFIG.storageDir,
    scope: 'workspace',
    vcsEnabled: true,
    vcsBranch: undefined,
    embeddingEnabled: false,
    toolsProfile: 'full',
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] ?? ''
    const eq = raw.indexOf('=')
    const key = eq === -1 ? raw : raw.slice(0, eq)
    const inline = eq === -1 ? undefined : raw.slice(eq + 1)
    /** 取参数值：优先 `--k=v`，否则吃掉下一个 argv。 */
    const need = (name: string): string | null => {
      if (inline !== undefined) return inline
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) return null
      i += 1
      return next
    }
    switch (key) {
      case '--root': {
        const value = need(key)
        if (value === null || value.trim() === '') return { ok: false, message: '--root 需要非空目录路径' }
        options.root = value.trim()
        break
      }
      case '--storage-dir': {
        const value = need(key)
        if (value === null || value.trim() === '') return { ok: false, message: '--storage-dir 需要非空值' }
        options.storageDir = value.trim()
        break
      }
      case '--scope': {
        const value = need(key)
        if (value !== 'workspace' && value !== 'user') return { ok: false, message: '--scope 必须为 workspace 或 user' }
        options.scope = value
        break
      }
      case '--vcs-branch': {
        const value = need(key)
        if (value === null || value.trim() === '') return { ok: false, message: '--vcs-branch 需要非空分支名' }
        options.vcsBranch = value.trim()
        break
      }
      case '--no-vcs':
        options.vcsEnabled = false
        break
      case '--embedding':
        options.embeddingEnabled = true
        break
      case '--tools': {
        const value = need(key)
        if (value !== 'core' && value !== 'full') return { ok: false, message: '--tools 必须为 core 或 full' }
        options.toolsProfile = value
        break
      }
      case '-h':
      case '--help':
        options.help = true
        break
      default:
        return { ok: false, message: `未知参数: ${raw}` }
    }
  }
  return { ok: true, options }
}

/** JSON-RPC id（数字/字符串；缺失或非法时用 null）。 */
type JsonRpcId = string | number | null

interface IdLookup {
  present: boolean
  value: JsonRpcId
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** stderr 诊断（stdout 是协议通道，绝不可污染）。 */
function log(message: string): void {
  process.stderr.write(`dev-memory-mcp: ${message}\n`)
}

/** 读取包版本（serverInfo.version）；读不到就回退一个安全值，不阻断启动。 */
async function readVersion(): Promise<string> {
  try {
    const text = await readFile(new URL('../package.json', import.meta.url), 'utf8')
    const pkg = JSON.parse(text) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** 从原始（可能损坏的）行里尽力抠出 id，用于回一个可定位的解析错误。 */
function sniffId(raw: string): JsonRpcId | null {
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/u.exec(raw)
  const token = match?.[1]
  if (token === undefined) return null
  try {
    const parsed: unknown = JSON.parse(token)
    return typeof parsed === 'string' || typeof parsed === 'number' ? parsed : null
  } catch {
    return null
  }
}

function idOf(message: Record<string, unknown>): IdLookup {
  if (!('id' in message)) return { present: false, value: null }
  const raw = message.id
  return { present: true, value: typeof raw === 'string' || typeof raw === 'number' ? raw : null }
}

function resultResponse(id: JsonRpcId, value: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result: value }
}

function errorResponse(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/** MCP 文本内容块。 */
interface TextContent {
  type: 'text'
  text: string
}

/** 工具 schema → MCP inputSchema（MCP 要求根节点为 object）。 */
function inputSchemaOf(tool: ToolDefinition): Record<string, unknown> {
  return tool.parameters.type === 'object' ? tool.parameters : { ...tool.parameters, type: 'object' }
}

/**
 * 工具返回值 → MCP 内容块：复用该工具自己的 `output.render`，
 * 使 MCP 面与 DSH 面渲染完全同源（render 返回 ContentBlock[]，此处只做形状对齐）。
 */
function renderContent(tool: ToolDefinition, args: Record<string, unknown>, value: unknown): TextContent[] {
  try {
    const blocks = tool.output.render(args, value)
    const out: TextContent[] = []
    for (const block of blocks) {
      if (isObject(block) && typeof block.text === 'string') out.push({ type: 'text', text: block.text })
    }
    if (out.length > 0) return out
  } catch {
    /* 渲染失败回退 JSON 文本，不把渲染问题升级成协议错误 */
  }
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  return [{ type: 'text', text }]
}

interface ServeOptions {
  tools: ToolDefinition[]
  serverInfo: { name: string; version: string }
  store: MemoryStore
}

/**
 * 启动 stdio 服务循环；返回进程退出码（stdin EOF 且排空后 resolve）。
 * 消息处理串行化（单条 promise 链），保证同一记忆库上的写入顺序确定。
 */
async function serve(options: ServeOptions): Promise<number> {
  const byName = new Map<string, ToolDefinition>(options.tools.map((tool) => [tool.name, tool]))
  let pendingWrites = 0
  let draining = false
  let settled = false
  let settle: (code: number) => void = () => undefined
  const done = new Promise<number>((res) => {
    settle = res
  })

  const finish = (code: number): void => {
    if (settled) return
    settled = true
    settle(code)
  }

  /** 写一行响应到 stdout（唯一协议出口）；写空后才允许 EOF 收尾退出。 */
  const send = (message: unknown): void => {
    let line: string
    try {
      line = `${JSON.stringify(message)}\n`
    } catch {
      line = `${JSON.stringify(errorResponse(null, INTERNAL_ERROR, '响应序列化失败'))}\n`
    }
    pendingWrites += 1
    try {
      process.stdout.write(line, () => {
        pendingWrites -= 1
        if (draining && pendingWrites === 0) finish(0)
      })
    } catch (error) {
      pendingWrites -= 1
      log(`stdout 写入失败（对端可能已关闭）: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** tools/call：执行业务工具；业务失败 → result + isError（见文件头错误分档说明）。 */
  const callTool = async (id: JsonRpcId, params: unknown): Promise<void> => {
    if (!isObject(params) || typeof params.name !== 'string' || params.name.trim() === '') {
      send(errorResponse(id, INVALID_PARAMS, 'tools/call 需要参数 { name: string, arguments?: object }'))
      return
    }
    const tool = byName.get(params.name)
    if (tool === undefined) {
      send(errorResponse(id, INVALID_PARAMS, `未知工具: ${params.name}`))
      return
    }
    const rawArgs = params.arguments
    if (rawArgs !== undefined && !isObject(rawArgs)) {
      send(errorResponse(id, INVALID_PARAMS, 'tools/call 的 arguments 必须是对象'))
      return
    }
    const args = rawArgs ?? {}
    try {
      // exec 上下文在 MCP 侧无意义（既有工具都只读 args），传空对象保持签名一致。
      const value = await tool.execute(args, {})
      send(resultResponse(id, { content: renderContent(tool, args, value), isError: false }))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      send(resultResponse(id, { content: [{ type: 'text', text: `错误: ${detail}` }], isError: true }))
    }
  }

  const dispatch = async (id: JsonRpcId, method: string, params: unknown): Promise<void> => {
    try {
      switch (method) {
        case 'initialize': {
          // 回显客户端协议版本（能找到共同语言）；缺失时给默认值。
          const requested =
            isObject(params) && typeof params.protocolVersion === 'string' && params.protocolVersion !== ''
              ? params.protocolVersion
              : DEFAULT_PROTOCOL_VERSION
          send(
            resultResponse(id, {
              protocolVersion: requested,
              capabilities: { tools: { listChanged: false } },
              serverInfo: options.serverInfo,
              instructions: SERVER_INSTRUCTIONS,
            }),
          )
          return
        }
        case 'ping':
          send(resultResponse(id, {}))
          return
        case 'tools/list':
          send(
            resultResponse(id, {
              tools: options.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: inputSchemaOf(tool),
              })),
            }),
          )
          return
        case 'tools/call':
          await callTool(id, params)
          return
        default:
          // 通知类（notifications/*）无 id 已在 handleLine 拦下；带 id 的未知方法一律 -32601。
          if (method.startsWith('notifications/')) return
          send(errorResponse(id, METHOD_NOT_FOUND, `未实现的方法: ${method}`))
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log(`处理 ${method} 失败: ${detail}`)
      send(errorResponse(id, INTERNAL_ERROR, `内部错误: ${detail}`))
    }
  }

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim()
    if (trimmed === '') return
    let message: unknown
    try {
      message = JSON.parse(trimmed)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const id = sniffId(trimmed)
      if (id !== null) send(errorResponse(id, PARSE_ERROR, `JSON 解析失败: ${detail}`))
      else log(`忽略无法解析的输入行（无 id，无法定位请求）: ${detail}`)
      return
    }
    if (!isObject(message)) {
      send(errorResponse(null, INVALID_REQUEST, 'JSON-RPC 消息必须是对象'))
      return
    }
    const id = idOf(message)
    const method = typeof message.method === 'string' && message.method !== '' ? message.method : null
    if (method === null) {
      if (id.present) send(errorResponse(id.value, INVALID_REQUEST, 'method 必须是字符串'))
      else log('忽略缺少 method 的通知')
      return
    }
    // 通知（无 id）：无论是否认识都不得响应；notifications/initialized 静默接受。
    if (!id.present) {
      if (!method.startsWith('notifications/')) log(`忽略未实现的通知: ${method}`)
      return
    }
    await dispatch(id.value, method, message.params)
  }

  let queue: Promise<void> = Promise.resolve()
  const enqueue = (line: string): void => {
    queue = queue
      .then(() => handleLine(line))
      .catch((error) => {
        log(`处理输入行异常（已忽略，进程继续）: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /** 行缓冲（跨 data 事件保留半行）。 */
  let buffer = ''

  const shutdown = (): void => {
    if (draining) return
    draining = true
    const rest = buffer
    buffer = ''
    if (rest.trim() !== '') enqueue(rest)
    void queue
      .then(() => options.store.flushVcs('MCP 会话结束（stdin EOF）'))
      .catch((error) => {
        log(`收尾 git flush 失败（忽略，记忆内容已落盘）: ${error instanceof Error ? error.message : String(error)}`)
      })
      .then(() => {
        log('stdin 已结束，正常退出')
        if (pendingWrites === 0) finish(0)
      })
  }

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      enqueue(line)
      index = buffer.indexOf('\n')
    }
  })
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  process.stdin.on('error', (error: unknown) => {
    log(`stdin 读取失败: ${error instanceof Error ? error.message : String(error)}`)
    shutdown()
  })

  return done
}

/** MCP 服务器主入口；返回进程退出码（与 src/cli.ts 的 main 约定一致）。 */
export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    process.stderr.write(`dev-memory-mcp: ${parsed.message}\n\n${USAGE}\n`)
    return 2
  }
  const options = parsed.options
  if (options.help) {
    process.stderr.write(`${USAGE}\n`)
    return 0
  }

  const workspaceRoot = resolve(options.root)
  // 只有显式给出的项才进 mergeConfig，其余取插件默认值（单一真相源）。
  const rawConfig: Record<string, unknown> = {
    storageDir: options.storageDir,
    scope: options.scope,
    vcs: {
      enabled: options.vcsEnabled,
      ...(options.vcsBranch === undefined ? {} : { branch: options.vcsBranch }),
    },
    ...(options.embeddingEnabled ? { embedding: { enabled: true } } : {}),
  }
  const store = new MemoryStore(workspaceRoot, mergeConfig(rawConfig))
  try {
    await store.init()
  } catch (error) {
    log(`记忆库初始化失败（${store.root}）: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  const tools = createTools(store, new DigestEngine(store), { profile: options.toolsProfile })
  const serverInfo = { name: SERVER_NAME, version: await readVersion() }
  log(
    `已就绪：工作区根 ${workspaceRoot}，库根 ${store.root}，工具 ${tools.length} 个，` +
      `vcs=${store.config.vcs.enabled ? 'on' : 'off'}，embedding=${store.config.embedding.enabled ? 'on' : 'off'}，` +
      `tools=${options.toolsProfile}`,
  )
  const code = await serve({ tools, serverInfo, store })
  // 兜底：极少数情况下仍有存活句柄（第三方 keep-alive 等）会拖住事件循环，
  // 宽限后强制退出（unref 定时器不阻止正常退出，只在循环仍活着时生效）。
  const guard = setTimeout(() => process.exit(code), 500)
  guard.unref()
  return code
}
