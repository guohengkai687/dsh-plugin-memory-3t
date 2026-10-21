#!/usr/bin/env node
/**
 * dist 新鲜度校验（v0.8.0 / F6）。
 *
 * 背景：插件以 `dist/` 作为运行产物（package.json 的 main/types/exports 都指向 dist），
 * 只改 `src/` 不重新 `npm run build` 时，磁盘上的运行代码仍是旧的；DSH 的 loader 还会
 * 按 URL 缓存 ESM 模块，容易把"改了但没生效"误判成逻辑 bug。
 *
 * 判定：`src/`（含 client/ 客户端源码）里最新的 mtime 必须早于 `dist/` 里最早的 mtime；
 * 否则说明有源码比产物新 → 退出码 1，并列出可疑文件。
 *
 * 用法：`npm run verify:dist`（CI / 发版前跑；不写任何文件）。
 */

import { readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_DIRS = ['src', 'client']
const OUTPUT_DIRS = ['dist']

async function collect(dir, filter) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await collect(full, filter)))
    } else if (entry.isFile() && filter(entry.name)) {
      const info = await stat(full)
      out.push({ path: full, mtime: info.mtimeMs })
    }
  }
  return out
}

const sourceFiles = []
for (const dir of SOURCE_DIRS) sourceFiles.push(...(await collect(join(root, dir), (n) => n.endsWith('.ts') || n.endsWith('.tsx'))))
const outputFiles = []
for (const dir of OUTPUT_DIRS) outputFiles.push(...(await collect(join(root, dir), (n) => n.endsWith('.js') || n.endsWith('.d.ts'))))

if (outputFiles.length === 0) {
  console.error('[verify-dist] dist/ 为空：先跑 `npm run build`。')
  process.exit(1)
}

const newestSource = sourceFiles.reduce((a, b) => (b.mtime > a.mtime ? b : a), { path: '', mtime: 0 })
const oldestOutput = outputFiles.reduce((a, b) => (b.mtime < a.mtime ? b : a), outputFiles[0])

if (newestSource.mtime > oldestOutput.mtime) {
  const staleBy = ((newestSource.mtime - oldestOutput.mtime) / 1000).toFixed(1)
  console.error(
    `[verify-dist] dist 落后于源码 ${staleBy}s：\n` +
      `  最新源码：${relative(root, newestSource.path)}\n` +
      `  最早产物：${relative(root, oldestOutput.path)}\n` +
      '  请跑 `npm run build` 后重试。',
  )
  process.exit(1)
}

console.log(
  `[verify-dist] OK：dist 新鲜（最新源码 ${relative(root, newestSource.path)} 早于最早产物 ${relative(root, oldestOutput.path)}）`,
)
