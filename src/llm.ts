/**
 * llm.ts — 演化用的最小 LLM 调用层（v0.10.0 P1）。
 *
 * 目标：周演化里的「提炼 / 语义合并」可以调用模型，且**默认就用当前会话正在用的模型**
 * （`agent.session.header.config = { provider, model }`）。
 *
 * 约束：
 * - 本插件零运行时依赖，不 import `@deepseek-ai/dsh-llm`；只需 `ctx.llm.stream()` 的
 *   最小形状（`{ provider, model, messages, system?, maxTokens?, signal? }`），
 *   返回异步分片流（`text-delta` / `finish`）。
 * - 没有可用模型时返回 `null` 客户端，调用方回退到启发式，**绝不因为 LLM 不可用而中断演化**。
 * - 每次调用都有超时与协作取消；错误只向上抛一次，由调用方决定 fail-open。
 */

/** 模型路由（provider + model 二元组）。 */
export interface LlmRoute {
  provider: string
  model: string
}

/** 一次补全请求。 */
export interface LlmRequest {
  system: string
  prompt: string
  maxTokens?: number
  timeoutMs?: number
}

/** 演化引擎看到的客户端形状（测试可注入假客户端）。 */
export interface LlmClient {
  /** 实际使用的路由（createLlmClient 在没有可用模型时返回 null，故此处非空）。 */
  readonly route: LlmRoute
  /** 路由来源：session（当前会话模型）/ config（显式配置）。 */
  readonly source: 'session' | 'config'
  complete(request: LlmRequest): Promise<string>
}

/** DSH `llm` 服务的最小形状（运行时由宿主提供；真实 API 是 prepareCall + call.stream）。 */
export interface LlmPreparedCall {
  config: Record<string, unknown>
  stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>>
}

export interface LlmServiceLike {
  prepareCall(config: Record<string, unknown>, signal?: AbortSignal): Promise<LlmPreparedCall>
  listProviders?(): Array<{ id?: string; provider?: string }>
}

export interface LlmClientOptions {
  service: unknown
  /** 配置里显式指定的路由（`evolve.llm`）。 */
  explicit?: { provider?: string | null; model?: string | null } | undefined
  /** 当前会话的路由（`agent.session.header.config`）。 */
  session?: LlmRoute | undefined
  defaultMaxTokens?: number
  defaultTimeoutMs?: number
}

export const LLM_MAX_TOKENS_DEFAULT = 800
export const LLM_TIMEOUT_MS_DEFAULT = 60_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** 从会话对象里读当前模型路由：`agent.session.header.config.{provider,model}`。 */
export function sessionRouteOf(agent: unknown): LlmRoute | undefined {
  if (!isRecord(agent)) return undefined
  const session = isRecord(agent.session) ? agent.session : undefined
  const header = session !== undefined && isRecord(session.header) ? session.header : undefined
  const config = header !== undefined && isRecord(header.config) ? header.config : undefined
  if (config === undefined) return undefined
  const provider = nonEmpty(config.provider)
  const model = nonEmpty(config.model)
  return provider !== null && model !== null ? { provider, model } : undefined
}

/** 解析路由：显式配置 > 当前会话 > 宿主已注册的第一个 provider（不猜模型名）。 */
export function resolveRoute(options: LlmClientOptions): { route: LlmRoute | null; source: 'session' | 'config' | 'none' } {
  const explicitProvider = nonEmpty(options.explicit?.provider)
  const explicitModel = nonEmpty(options.explicit?.model)
  if (explicitProvider !== null && explicitModel !== null) {
    return { route: { provider: explicitProvider, model: explicitModel }, source: 'config' }
  }
  if (options.session !== undefined) return { route: { ...options.session }, source: 'session' }
  return { route: null, source: 'none' }
}

/** 仅当宿主提供 `llm` 服务、且能解析出完整路由时才构造客户端。 */
export function createLlmClient(options: LlmClientOptions): LlmClient | null {
  const service = options.service
  if (!isRecord(service) || typeof service.prepareCall !== 'function') return null
  const { route, source } = resolveRoute(options)
  if (route === null) return null
  const resolvedSource: 'session' | 'config' = source === 'config' ? 'config' : 'session'
  const llm = service as unknown as LlmServiceLike
  const maxTokensDefault = options.defaultMaxTokens ?? LLM_MAX_TOKENS_DEFAULT
  const timeoutDefault = options.defaultTimeoutMs ?? LLM_TIMEOUT_MS_DEFAULT

  return {
    route,
    source: resolvedSource,
    async complete(request: LlmRequest): Promise<string> {
      const timeoutMs = request.timeoutMs ?? timeoutDefault
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        // 宿主的正规入口：先 prepareCall（按 provider/model 绑定适配器），再 stream
        const call = await llm.prepareCall(
          { provider: route.provider, model: route.model, maxTokens: request.maxTokens ?? maxTokensDefault },
          controller.signal,
        )
        const chunks = call.stream({
          ...call.config,
          system: request.system,
          messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }],
          signal: controller.signal,
        })
        let text = ''
        for await (const chunk of chunks) {
          const type = nonEmpty(chunk.type)
          if (type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          else if (type === 'finish') {
            const reason = isRecord(chunk.reason) ? chunk.reason : {}
            const kind = nonEmpty(reason.kind)
            if (kind === 'error' || kind === 'aborted') {
              const failure = isRecord(reason.failure) ? reason.failure : {}
              const message = nonEmpty(failure.message) ?? kind
              throw new Error(`llm ${kind}: ${message}`)
            }
          }
        }
        return text
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/**
 * 从模型输出里提取第一个 JSON 值（允许 ```json 围栏、前后废话）。
 * 解析失败返回 null，调用方据此回退启发式。
 */
export function extractJson<T = unknown>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text)
  const candidate = (fenced?.[1] ?? text).trim()
  const start = candidate.search(/[[{]/u)
  if (start < 0) return null
  const opener = candidate[start]
  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === opener) depth += 1
    else if (char === closer) {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, index + 1)) as T
        } catch {
          return null
        }
      }
    }
  }
  return null
}
