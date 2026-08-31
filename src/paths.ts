/**
 * 路径工具：库根解析与防逃逸的安全拼接。
 *
 * 所有接受用户/模型路径参数的工具都必须经过 `safeJoin`，
 * 拒绝 `..` 越界与绝对路径，防止写出记忆库根（对齐 OpenViking 的 URI 防护思路）。
 */

import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import type { Scope } from './config.js'

/**
 * 解析记忆库根目录。
 * @param workspaceRoot - 会话工作区根（由 index.ts 解析，找不到时回退 process.cwd()）。
 * @param storageDir - 配置值：绝对路径原样使用；相对路径基于基准目录解析。
 * @param scope - 记忆库粒度（v0.3）：workspace 基准 = 工作区根；user 基准 = 用户主目录（全局一库）。
 */
export function resolveRoot(workspaceRoot: string, storageDir: string, scope: Scope = 'workspace'): string {
  const base = scope === 'user' ? homedir() : workspaceRoot
  return isAbsolute(storageDir) ? storageDir : resolve(base, storageDir)
}

/**
 * 在库根内安全拼接路径；任何逃逸（`..`、绝对路径、符号链接导致的越界由调用方另行把关）都会抛错。
 * @param root - 记忆库根（必须是 resolve 后的绝对路径）。
 * @param segments - 相对根的子路径片段。
 */
export function safeJoin(root: string, ...segments: string[]): string {
  const out = resolve(root, ...segments)
  const rel = relative(root, out)
  if (rel === '') return out
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error(`path escapes memory root: ${segments.join('/') || '(empty)'}`)
  }
  return out
}

/** 三层目录名与路径。 */
export interface LayerDirs {
  runtime: string
  docs: string
  spaces: string
}

export function layerDirs(root: string): LayerDirs {
  return {
    runtime: safeJoin(root, 'runtime'),
    docs: safeJoin(root, 'docs'),
    spaces: safeJoin(root, 'spaces'),
  }
}

/** L1 流水文件名：YYYY-MM-DD.md（本地日期）。 */
export function runtimeFileName(date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}.md`
}