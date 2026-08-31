/**
 * Frontmatter 解析/序列化：L3 条目与 L2 笔记的元数据头。
 *
 * 格式：`---` 包裹的 `key: value` 行（value 支持字符串/数字/布尔/JSON 数组）。
 * 解析容错：无 frontmatter 的头文件返回空元数据 + 原文。
 */

export interface Frontmatter {
  data: Record<string, unknown>
  body: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function parseValue(raw: string): unknown {
  const value = raw.trim()
  if (value === '') return ''
  if (value.startsWith('[') && value.endsWith(']')) {
    try {
      return JSON.parse(value)
    } catch {
      /* 不是合法 JSON 数组，按字符串处理 */
    }
  }
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
  if (value === 'true') return true
  if (value === 'false') return false
  const n = Number(value)
  if (value !== '' && !Number.isNaN(n)) return n
  return value
}

export function parseFrontmatter(text: string): Frontmatter {
  const match = FRONTMATTER_RE.exec(text)
  if (!match) return { data: {}, body: text }
  const block = match[1]
  if (block === undefined) return { data: {}, body: text }
  const data: Record<string, unknown> = {}
  for (const line of block.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    if (key === '') continue
    data[key] = parseValue(line.slice(idx + 1))
  }
  return { data, body: text.slice(match[0].length) }
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return JSON.stringify(value)
  return String(value)
}

export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const lines = ['---']
  for (const [key, value] of Object.entries(data)) {
    lines.push(`${key}: ${formatValue(value)}`)
  }
  lines.push('---', '')
  const normalizedBody = body.replace(/^\n+/, '').replace(/\s+$/, '') + '\n'
  return lines.join('\n') + normalizedBody
}