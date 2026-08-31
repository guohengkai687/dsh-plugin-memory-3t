/**
 * pack/unpack：记忆库打包迁移（v0.2 剩余项二，零运行时依赖）。
 *
 * - 打包产物：单文件 `.dmmem`（gzip 的 JSON 清单：{schemaVersion, exportedAt,
 *   rootName, files:[{path, content}]}），内容为三层 markdown + meta/audit 文本。
 * - 排除不可移植/可重建的派生物：`.git`（嵌套元数据或 .git 文件）、由 .git 文件
 *   指出的分离 git 目录、`index.json`（惰性重建）、`vectors/`（embedding 派生物）、
 *   `diag/`（诊断记录，可重建）。
 * - git 历史不随包迁移（与"误删 .git"同语义：audit.jsonl 保留操作追溯，恢复目标
 *   面向 v0.2 的存量库），解包后下次插件启动自动 init 全新仓库。
 * - 解包校验：所有路径必须是相对路径、无 `..` / 空段 / 盘符，防档案逃逸。
 */

import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { safeJoin } from './paths.js'

export interface PackFile {
  path: string
  content: string
}

export interface PackArchive {
  schemaVersion: 1
  kind: 'dmmem-pack'
  exportedAt: string
  rootName: string
  files: PackFile[]
}

export interface PackResult {
  archivePath: string
  fileCount: number
  bytes: number
}

export interface UnpackResult {
  targetRoot: string
  fileCount: number
}

/** 从 .git 内部/文件读取分离 git 目录的绝对路径；无则 null。 */
export async function separateGitDir(root: string): Promise<string | null> {
  try {
    const raw = await readFile(safeJoin(root, '.git'), 'utf8')
    const match = /^gitdir:\s*(.+)$/m.exec(raw)
    if (match === null || match[1] === undefined) return null
    const dir = match[1].trim()
    return isAbsolute(dir) ? resolve(dir) : resolve(root, dir)
  } catch {
    return null
  }
}

function defaultArchivePath(root: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${basename(root)}-pack-${stamp}.dmmem`
}

async function walkFiles(root: string, relPrefix: string, gitDirRel: string | null, out: PackFile[]): Promise<void> {
  let names: Dirent[] = []
  try {
    names = await readdir(join(root, relPrefix.split('/').join(sep)), { withFileTypes: true })
  } catch {
    return
  }
  for (const name of names) {
    const rel = relPrefix === '' ? name.name : `${relPrefix}/${name.name}`
    // 排除：git 元数据（.git 目录或 .git 文件）、分离 git 目录、派生物（index/vectors/diag 可重建）
    if (name.name === '.git') continue
    if (gitDirRel !== null && (rel === gitDirRel || rel.startsWith(`${gitDirRel}/`))) continue
    if (name.name === 'index.json' || name.name === 'vectors' || name.name === 'diag') continue
    if (name.isDirectory()) {
      await walkFiles(root, rel, gitDirRel, out)
      continue
    }
    if (!name.isFile()) continue
    try {
      const content = await readFile(join(root, rel.split('/').join(sep)), 'utf8')
      out.push({ path: rel, content })
    } catch {
      /* 单个不可读文件跳过（fail-open） */
    }
  }
}

/**
 * 把记忆库打包为单个 .dmmem 文件。
 * @param root - 记忆库根（绝对路径）。
 * @param outPath - 产物路径；省略时生成 `<rootName>-pack-<ts>.dmmem`。
 */
export async function packLibrary(root: string, outPath?: string): Promise<PackResult> {
  let rootStat
  try {
    rootStat = await stat(root)
  } catch {
    throw new Error(`记忆库根不存在: ${root}`)
  }
  if (!rootStat.isDirectory()) throw new Error(`记忆库根不是目录: ${root}`)
  const files: PackFile[] = []
  const gitDirAbs = await separateGitDir(root)
  const gitDirRel = gitDirAbs === null ? null : relative(root, gitDirAbs)
  const gitDirRelPosix = gitDirRel === null || gitDirRel === '' || gitDirRel.startsWith('..' + sep) || isAbsolute(gitDirRel) ? null : gitDirRel.split(sep).join('/')
  await walkFiles(root, '', gitDirRelPosix, files)
  const archive: PackArchive = {
    schemaVersion: 1,
    kind: 'dmmem-pack',
    exportedAt: new Date().toISOString(),
    rootName: basename(root),
    files,
  }
  const buf = gzipSync(Buffer.from(JSON.stringify(archive), 'utf8'), { level: 9 })
  const archivePath = resolve(outPath ?? defaultArchivePath(root))
  await writeFile(archivePath, buf, { mode: 0o600 })
  return { archivePath, fileCount: files.length, bytes: buf.length }
}

function validateRelPath(rel: string): string {
  const p = rel.replace(/\\/g, '/')
  if (p === '' || p.includes(':') || p.startsWith('/')) throw new Error(`pack 档案含非法路径: ${rel}`)
  if (p.split('/').some((seg) => seg === '..' || seg === '')) throw new Error(`pack 档案含非法路径: ${rel}`)
  return p
}

/**
 * 解包：把 .dmmem 档案恢复到目标目录（先建后写，路径防逃逸）。
 * 目标目录可以不存在；git 仓库初始化由下次插件启动完成。
 */
export async function unpackLibrary(archivePath: string, targetRoot: string): Promise<UnpackResult> {
  let buf: Buffer
  try {
    buf = gunzipSync(await readFile(archivePath))
  } catch (error) {
    throw new Error(`pack 档案损坏或不是 .dmmem: ${archivePath}（${error instanceof Error ? error.message : String(error)}）`)
  }
  let archive: PackArchive
  try {
    archive = JSON.parse(buf.toString('utf8')) as PackArchive
  } catch (error) {
    throw new Error(`pack 档案 JSON 解析失败: ${archivePath}`)
  }
  if (archive.schemaVersion !== 1 || archive.kind !== 'dmmem-pack' || !Array.isArray(archive.files)) {
    throw new Error(`pack 档案格式不符: ${archivePath}（schemaVersion=1 / kind=dmmem-pack）`)
  }
  const root = resolve(targetRoot)
  await mkdir(root, { recursive: true, mode: 0o700 })
  let written = 0
  for (const file of archive.files) {
    if (typeof file?.path !== 'string' || typeof file?.content !== 'string') continue
    const rel = validateRelPath(file.path)
    const abs = safeJoin(root, ...rel.split('/'))
    await mkdir(dirname(abs), { recursive: true, mode: 0o700 })
    await writeFile(abs, file.content, { mode: 0o600 })
    written += 1
  }
  return { targetRoot: root, fileCount: written }
}