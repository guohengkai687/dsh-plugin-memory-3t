/**
 * GitVcs：记忆库的 git 回溯管理层（v0.2 新增）。
 *
 * 设计要点：
 * - 零运行时依赖：直接 spawn 系统 git（默认二进制名 'git'，可注入便于测试降级路径）。
 * - 嵌套仓库（默认）：`<库根>/.git` 自带完整历史，与宿主仓库隔离（v0.1 的
 *   maintainGitignore 已把 .memory 从宿主忽略，二者天然衔接）；`vcs.gitDir`
 *   可把元数据目录分离出去（--separate-git-dir，绝对/相对记忆库根路径）。
 * - 提交策略：写操作 `record()` → 防抖（debounceMs）+ 写入计数（batch）触发合并提交；
 *   边界事件（digest / turn-stopping / agent/created / consolidate / restore）显式 `flush()`。
 * - 恢复语义：`git restore --source=<ref>` 只改工作区、绝不重写历史；恢复前自动
 *   checkpoint（把未提交变更落一个提交），恢复本身也是新提交（可撤销的撤销）。
 * - 派生物 index.json 由库内 .gitignore 忽略，不进版本历史（可重建的缓存）。
 * - fail-open：git 不可用 / init / commit 失败 → 标记降级并记录 lastError，
 *   绝不向调用链抛错；恢复类命令的**参数错误**（ref 不存在、路径逃逸）除外，那是业务错误。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { safeJoin } from './paths.js'

export type VcsLayer = 'l1' | 'l2' | 'l3'

export interface VcsIdentity {
  name: string
  email: string
}

export interface VcsConfig {
  /** 全局开关；false 时完全跳过 git（等同 v0.1 行为）。 */
  enabled: boolean
  /** 事件驱动自动提交（防抖 + batch）；false 时仅边界事件提交。 */
  autoCommit: boolean
  /** 防抖窗口（ms）：窗口内无新写入才合并提交。 */
  debounceMs: number
  /** 写入计数阈值：未提交写入达到该值立即提交（防持续写入饿死提交）。 */
  batch: number
  /** 初始化分支名（git ≥ 2.28 用 init -b，旧版 init 后 symbolic-ref 切分支）。 */
  branch: string
  /** 本地 git 身份兜底（写入仓库 .git/config，不依赖全局配置）。 */
  identity: VcsIdentity
  /**
   * 分离 git 目录（--separate-git-dir）：绝对路径原样，相对路径基于记忆库根解析。
   * 默认 undefined = 嵌套 <库>/.git。gitDir 位于库内时自动写入库内 .gitignore，
   * 防止 git 把仓库元数据当工作区内容跟踪。
   */
  gitDir?: string
}

export interface VcsStatus {
  available: boolean
  enabled: boolean
  ready: boolean
  degraded: boolean
  branch: string | null
  commits: number
  latestCommit: string | null
  latestMessage: string | null
  pendingWrites: number
  lastError: string | null
}

export interface CommitInfo {
  hash: string
  short: string
  /** ISO 时间。 */
  date: string
  message: string
  /** 该提交触及的文件数（-1 表示统计失败）。 */
  files: number
}

export interface DiffEntry {
  path: string
  status: 'A' | 'M' | 'D'
  added: number
  deleted: number
}

export interface RestoreResult {
  dryRun: boolean
  ref: string
  targets: string[]
  /** 恢复将（或已）应用的变更清单。 */
  changes: DiffEntry[]
  /** 恢复前自动保存的检查点提交；无未提交变更时为 null。 */
  checkpointCommit: string | null
  applied: boolean
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function run(gitBinary: string, args: string[], cwd: string, timeoutMs = 15_000): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(gitBinary, args, {
      cwd,
      windowsHide: true,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`git 执行超时: git ${args.join(' ')}`))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** 生成提交信息：`[dev-memory] <原因|auto> (<操作清单:去重前8条>)`。 */
export function buildCommitMessage(ops: string[], reason?: string): string {
  const head = reason !== undefined && reason !== '' ? reason : 'auto'
  const body = [...new Set(ops)]
  const detail = body.length > 0 ? ` (${body.slice(0, 8).join('; ')})` : ''
  return `[dev-memory] ${head}${detail}`
}

/** 解析 git --numstat 输出为变更明细。 */
export function parseNumstat(text: string): DiffEntry[] {
  const out: DiffEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const added = Number(parts[0])
    const deleted = Number(parts[1])
    if (!Number.isFinite(added) || !Number.isFinite(deleted)) continue
    const path = parts
      .slice(2)
      .join('\t')
      .replace(/^"|"$/g, '')
      .replace(/\\t/g, '\t')
    const status: DiffEntry['status'] = added > 0 && deleted > 0 ? 'M' : added > 0 ? 'A' : deleted > 0 ? 'D' : 'M'
    out.push({ path, status, added, deleted })
  }
  return out
}

const LAYER_TO_DIR: Record<string, string | undefined> = {
  l1: 'runtime',
  runtime: 'runtime',
  l2: 'docs',
  docs: 'docs',
  l3: 'spaces',
  spaces: 'spaces',
}

/** 绝对路径 → 库根相对路径（POSIX 分隔符），逃逸即抛错。 */
export function toGitRel(root: string, abs: string): string {
  const rel = relative(root, abs)
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep)) {
    throw new Error(`path escapes memory root: ${abs}`)
  }
  return rel.split(sep).join('/')
}

/**
 * 把 restore 的目标（层名 / 库内相对路径 / 整库标记 'all'）展开为 git 可用的根相对路径（防逃逸）。
 * 'all'（或与 'all' 混用时）表示整库时间片：恢复全部被 git 跟踪的内容到指定 ref。
 */
export function expandTargets(root: string, targets: string[]): string[] {
  const out: string[] = []
  for (const raw of targets) {
    const t = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    if (t === '') continue
    if (t === 'all') {
      return ['.']
    }
    const dir = LAYER_TO_DIR[t]
    if (dir !== undefined) {
      out.push(dir)
      continue
    }
    if (t.includes(':') || t.startsWith('/') || t.split('/').some((seg) => seg === '..')) {
      throw new Error(`devmemory_restore: target 必须是库内相对路径或层名（或 'all' 整库）: ${t}`)
    }
    const abs = safeJoin(root, ...t.split('/'))
    out.push(toGitRel(root, abs))
  }
  return [...new Set(out)]
}

export class GitVcs {
  readonly root: string
  private readonly config: VcsConfig
  private available = false
  private ready = false
  private pending = 0
  private readonly recent: string[] = []
  private timer: NodeJS.Timeout | null = null
  private chain: Promise<unknown> = Promise.resolve()
  /** 最近一次 git 故障信息（v0.4 起对外公开，供诊断记录读取）。 */
  lastError: string | null = null

  constructor(root: string, config: VcsConfig, private readonly gitBinary = 'git') {
    this.root = root
    this.config = config
  }

  get pendingWrites(): number {
    return this.pending
  }

  /** 配置开关（boot 渲染用）。 */
  get enabled(): boolean {
    return this.config.enabled
  }

  /** 仓库就绪态（v0.4 诊断用：init 后可直接判降级，无需再跑 git 命令）。 */
  get isReady(): boolean {
    return this.ready
  }

  /** 串行化所有 git 操作（避免 index.lock 竞争与交错提交）。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => undefined)
    return next
  }

  private async run(args: string[]): Promise<RunResult> {
    return run(this.gitBinary, args, this.root)
  }

  // ---------------------------------------------------------------- 初始化

  async init(): Promise<void> {
    if (!this.config.enabled) return
    await this.probe()
    if (!this.available) {
      this.lastError = 'git 未在 PATH 中找到，版本回溯已降级为仅本地存储'
      return
    }
    try {
      await this.ensureRepo()
      await this.ensureIdentity()
      await this.ensureIgnore()
      const head = await this.latestCommit()
      if (head === null) {
        await this.commitInternal('[dev-memory] init memory library')
      }
      this.ready = true
      this.lastError = null
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.ready = false
    }
  }

  private async probe(): Promise<void> {
    try {
      const res = await run(this.gitBinary, ['--version'], this.root)
      this.available = res.code === 0 && /^git version /u.test(res.stdout.trim())
    } catch {
      this.available = false
    }
  }

  private async ensureRepo(): Promise<void> {
    if (existsSync(resolve(this.root, '.git'))) return
    const gitDir = this.gitDirAbsolute()
    if (gitDir !== null) {
      if (gitDir === this.root) throw new Error('gitDir 不能等于记忆库根（否则无工作区）')
      // git 不负责创建分离目录的父链，先建（Windows 上会报 Invalid path）
      await mkdir(dirname(gitDir), { recursive: true, mode: 0o700 })
      const res = await this.run(['init', '-b', this.config.branch, `--separate-git-dir=${gitDir}`])
      if (res.code !== 0) {
        // git < 2.28 不支持 init -b：init 后切分支
        const plain = await this.run(['init', `--separate-git-dir=${gitDir}`])
        if (plain.code !== 0) throw new Error(plain.stderr.trim() || 'git init 失败')
        const head = await this.run(['symbolic-ref', 'HEAD', `refs/heads/${this.config.branch}`])
        if (head.code !== 0) throw new Error(`切换分支 ${this.config.branch} 失败: ${head.stderr.trim()}`)
      }
      return
    }
    const res = await this.run(['init', '-b', this.config.branch])
    if (res.code !== 0) {
      // git < 2.28 不支持 init -b：init 后切分支
      const plain = await this.run(['init'])
      if (plain.code !== 0) throw new Error(plain.stderr.trim() || 'git init 失败')
      const head = await this.run(['symbolic-ref', 'HEAD', `refs/heads/${this.config.branch}`])
      if (head.code !== 0) throw new Error(`切换分支 ${this.config.branch} 失败: ${head.stderr.trim()}`)
    }
  }

  /** gitDir 的绝对路径（相对值基于记忆库根解析）；未配置时为 null。 */
  private gitDirAbsolute(): string | null {
    const gitDir = this.config.gitDir
    if (gitDir === undefined || gitDir === '') return null
    return isAbsolute(gitDir) ? gitDir : resolve(this.root, gitDir)
  }

  /** 本地身份兜底：全局已配身份则尊重，否则写入仓库级默认身份。 */
  private async ensureIdentity(): Promise<void> {
    const name = await this.run(['config', 'user.name'])
    if (name.code !== 0 || name.stdout.trim() === '') {
      await this.run(['config', 'user.name', this.config.identity.name])
    }
    const email = await this.run(['config', 'user.email'])
    if (email.code !== 0 || email.stdout.trim() === '') {
      await this.run(['config', 'user.email', this.config.identity.email])
    }
  }

  /** 库内 .gitignore：忽略可重建的派生物（index.json、vectors/）与库内 gitDir 元数据、诊断记录 diag/。 */
  private async ensureIgnore(): Promise<void> {
    const path = resolve(this.root, '.gitignore')
    // v0.6.1：index.json.dirty 为跨进程持久化脏标记（派生物，不进版本历史）
    const lines = ['index.json', 'index.json.dirty', 'vectors/', 'diag/']
    const gitDir = this.gitDirAbsolute()
    if (gitDir !== null && gitDir !== this.root) {
      const rel = relative(this.root, gitDir)
      if (rel !== '' && !rel.startsWith('..' + sep) && !isAbsolute(rel)) {
        lines.push(rel.split(sep).join('/'))
      }
    }
    try {
      const existing = await readFile(path, 'utf8')
      const present = new Set(existing.split(/\r?\n/))
      const missing = lines.filter((line) => !present.has(line))
      if (missing.length > 0) {
        await writeFile(path, existing.replace(/\s+$/, '') + '\n' + missing.join('\n') + '\n', { mode: 0o600 })
      }
    } catch {
      await writeFile(path, lines.join('\n') + '\n', { mode: 0o600 })
    }
  }

  private async latestCommit(): Promise<string | null> {
    const res = await this.run(['log', '-1', '--format=%H'])
    if (res.code !== 0) return null
    const line = res.stdout.trim()
    return line === '' ? null : line
  }

  private async commitInternal(message: string): Promise<{ hash: string } | null> {
    const add = await this.run(['add', '-A'])
    if (add.code !== 0) throw new Error(`git add 失败: ${add.stderr.trim()}`)
    const status = await this.run(['-c', 'core.quotepath=false', 'status', '--porcelain'])
    if (status.stdout.trim() === '') return null
    const commit = await this.run(['commit', '-m', message])
    if (commit.code !== 0) throw new Error(`git commit 失败: ${commit.stderr.trim()}`)
    const hash = await this.latestCommit()
    return hash === null ? null : { hash }
  }

  // ---------------------------------------------------------------- 写入登记与提交

  /** 写操作登记（所有 store 写路径调用）。只计数并触发防抖，不实际提交。 */
  record(layer: VcsLayer, op: string): void {
    if (!this.ready) return
    this.pending += 1
    this.recent.push(`${layer}: ${op}`)
    if (this.recent.length > 12) this.recent.splice(0, this.recent.length - 12)
    if (!this.config.autoCommit) return
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.enqueue(() => this.flushInner())
      }, this.config.debounceMs)
      this.timer.unref?.()
    }
    if (this.pending >= this.config.batch) {
      void this.enqueue(() => this.flushInner())
    }
  }

  /** 显式提交边界（digest / turn-stopping / agent/created / consolidate）。 */
  async flush(reason?: string): Promise<{ hash: string; message: string } | null> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    return this.enqueue(() => this.flushInner(reason))
  }

  private async flushInner(reason?: string): Promise<{ hash: string; message: string } | null> {
    if (!this.ready || this.pending === 0) return null
    const message = buildCommitMessage(this.recent, reason)
    this.recent.length = 0
    this.pending = 0
    try {
      const commit = await this.commitInternal(message)
      return commit === null ? null : { hash: commit.hash, message }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      return null
    }
  }

  // ---------------------------------------------------------------- 查询与恢复

  async status(): Promise<VcsStatus> {
    const base: VcsStatus = {
      available: this.available,
      enabled: this.config.enabled,
      ready: this.ready,
      degraded: this.config.enabled && !this.ready,
      branch: null,
      commits: 0,
      latestCommit: null,
      latestMessage: null,
      pendingWrites: this.pending,
      lastError: this.lastError,
    }
    if (!this.available || !this.config.enabled || !this.ready) return base
    return this.enqueue(async () => {
      try {
        const branchRes = await this.run(['rev-parse', '--abbrev-ref', 'HEAD'])
        if (branchRes.code !== 0) throw new Error(branchRes.stderr.trim() || 'git rev-parse 失败')
        const branch = branchRes.stdout.trim()
        const countRes = await this.run(['rev-list', '--count', 'HEAD'])
        if (countRes.code !== 0) throw new Error(countRes.stderr.trim() || 'git rev-list 失败')
        const commits = countRes.stdout.trim() === '' ? 0 : Number(countRes.stdout.trim())
        const latestRes = await this.run(['log', '-1', '--format=%h%x09%s'])
        if (latestRes.code !== 0) throw new Error(latestRes.stderr.trim() || 'git log 失败')
        const latestRaw = latestRes.stdout.trim()
        const tab = latestRaw.indexOf('\t')
        const latestCommit = tab === -1 ? (latestRaw === '' ? null : latestRaw) : latestRaw.slice(0, tab)
        const latestMessage = tab === -1 ? null : latestRaw.slice(tab + 1) || null
        return {
          ...base,
          branch: branch || null,
          commits: Number.isFinite(commits) ? commits : 0,
          latestCommit,
          latestMessage,
          lastError: null,
        }
      } catch (error) {
        // git 命令失败（如仓库被删）：自愈 ready 标志，进入降级
        this.ready = false
        return {
          ...base,
          ready: false,
          degraded: true,
          lastError: error instanceof Error ? error.message : String(error),
        }
      }
    })
  }

  /** 最近提交列表；可选按库内路径过滤。 */
  async history(limit: number, paths: string[] = []): Promise<CommitInfo[]> {
    if (!this.ready) return []
    return this.enqueue(async () => {
      const args = [
        '-c',
        'core.quotepath=false',
        'log',
        '-n',
        String(Math.max(1, Math.min(50, Math.floor(limit)))),
        '--format=%H%x09%ct%x09%s',
      ]
      if (paths.length > 0) args.push('--', ...paths)
      const res = await this.run(args)
      if (res.code !== 0) return []
      const out: CommitInfo[] = []
      for (const line of res.stdout.split(/\r?\n/)) {
        if (line.trim() === '') continue
        const tab1 = line.indexOf('\t')
        const tab2 = tab1 === -1 ? -1 : line.indexOf('\t', tab1 + 1)
        if (tab1 === -1 || tab2 === -1) continue
        const hash = line.slice(0, tab1)
        const ts = Number(line.slice(tab1 + 1, tab2))
        const message = line.slice(tab2 + 1)
        out.push({ hash, short: hash.slice(0, 7), date: new Date(ts * 1000).toISOString(), message, files: await this.fileCount(hash) })
      }
      return out
    })
  }

  private async fileCount(hash: string): Promise<number> {
    try {
      const res = await this.run(['show', '--format=', '--numstat', hash])
      if (res.code !== 0) return -1
      return res.stdout.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('-')).length
    } catch {
      return -1
    }
  }

  /**
   * 变更明细：ref 给定时为该提交相对其父提交的变更；
   * 省略 ref 时为当前未提交变更（工作区 vs HEAD，先落暂存区让未跟踪文件可见）。
   */
  async diff(opt: { ref?: string; paths?: string[] } = {}): Promise<DiffEntry[]> {
    if (!this.ready) return []
    return this.enqueue(async () => {
      const args = ['-c', 'core.quotepath=false']
      if (opt.ref !== undefined && opt.ref !== '') {
        args.push('show', '--numstat', '--format=', opt.ref)
      } else {
        await this.run(['add', '-A'])
        args.push('diff', '--cached', '--numstat', 'HEAD')
      }
      if (opt.paths !== undefined && opt.paths.length > 0) args.push('--', ...opt.paths)
      const res = await this.run(args)
      if (res.code !== 0) return []
      return parseNumstat(res.stdout)
    })
  }

  /**
   * 恢复：把目标路径恢复到指定 ref 的状态。
   * 安全网：dry-run 先行 → checkpoint（未提交变更先提交）→ 只改工作区不回写历史 → 恢复本身留痕提交。
   */
  async restore(opt: { ref: string; targets: string[]; dryRun?: boolean }): Promise<RestoreResult> {
    return this.enqueue(async () => {
      const dryRun = opt.dryRun !== false
      const result: RestoreResult = { dryRun, ref: opt.ref, targets: [], changes: [], checkpointCommit: null, applied: false }
      if (!this.ready) return result
      const targets = expandTargets(this.root, opt.targets)
      result.targets = targets
      // 预览：diff(ref vs 当前工作区) = restore 将应用的变更
      const preview = await this.run(['-c', 'core.quotepath=false', 'diff', '--numstat', opt.ref, '--', ...targets])
      if (preview.code !== 0) {
        throw new Error(preview.stderr.trim() || `git diff 失败（ref 可能不存在: ${opt.ref}）`)
      }
      result.changes = parseNumstat(preview.stdout)
      if (dryRun) return result
      if (this.timer !== null) {
        clearTimeout(this.timer)
        this.timer = null
      }
      const checkpoint = await this.flushInner('restore 前检查点')
      result.checkpointCommit = checkpoint?.hash ?? null
      const apply = await this.run(['restore', `--source=${opt.ref}`, '--', ...targets])
      if (apply.code !== 0) {
        throw new Error(apply.stderr.trim() || `git restore 失败（ref=${opt.ref}）`)
      }
      await this.commitInternal(`restore ${opt.ref} ${targets.join(' ')}`.slice(0, 100))
      result.applied = true
      return result
    })
  }
}