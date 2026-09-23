/**
 * 冷启动 seed（v0.6.5）：**无 LLM** 地从仓库的确定性信号生成项目骨架。
 *
 * 借鉴 Hindsight 的"冷仓库自动建库"（git 历史 seed + codebase survey），但做了两点关键裁剪：
 * 1. **不调用任何 LLM**——Hindsight 用 headless agent + USD 预算跑 codebase survey 合成知识页；
 *    我们只读确定性信号：git 提交历史 / package.json / README 标题 / 顶层目录。
 *    零依赖、零成本、结果可复现（同样输入 → 同样输出）。
 * 2. **不自动写 L3**——L3 是可信层，只放已确认的长期事实。这里只产出**候选清单**，
 *    是否提升由模型/用户用 devmemory_remember 决定。（Hindsight 用 LLM 自动抽取入长期记忆，
 *    语义更强，但也更容易把推断当事实写进去——这是我们有意的分歧点。）
 *
 * 产出：`<库>/docs/project/overview.md`（L2 检索层：按需 recall，**不**主动注入 prompt）。
 * 幂等：笔记已存在则不覆盖（除非 force）。
 * 全程 fail-open：任一信号采集失败只记入 `skipped`，不影响其余部分。
 */

import { execFile } from 'node:child_process'
import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Config } from './config.js'
import { layerDirs } from './paths.js'
import type { MemoryStore } from './store.js'

/** seed 产出的骨架笔记库内相对路径（固定，便于幂等判定）。 */
export const SEED_NOTE_REL_PATH = 'project/overview.md'

/** 采集到的仓库信号。 */
export interface SeedSignals {
  commits: Array<{ hash: string; date: string; subject: string }>
  dirs: string[]
  files: string[]
  readme: { file: string; firstLine: string; headings: string[] } | null
  manifest: { name: string; description: string; scripts: string[] } | null
}

/** seed 结果（工具层原样回报给模型）。 */
export interface SeedResult {
  /** L2 笔记库内相对路径。 */
  relPath: string
  /** 本次是否真的写入（false = 已存在且未 force）。 */
  written: boolean
  /** 信号计数（便于模型判断骨架的信息量）。 */
  signals: { commits: number; dirs: number; files: number; readmeHeadings: number; hasManifest: boolean }
  /** 候选 L3 事实：**未写入**，交由模型决定是否 devmemory_remember。 */
  candidates: string[]
  /** 采集失败/跳过的部分及原因。 */
  skipped: string[]
}

/** 顶层扫描要忽略的噪声目录/文件。 */
const NOISE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  '.memory',
  '.next',
  '.nuxt',
  '.output',
  '__pycache__',
  '.venv',
  'venv',
  '.env',
  'coverage',
  '.cache',
  '.idea',
  '.vscode',
  '.DS_Store',
])

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 执行 git 子进程（与 vcs.ts 同一策略：piped stdio，超时保护，失败向上抛）。 */
function runGit(args: string[], cwd: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(String(stdout ?? ''))
      },
    )
  })
}

/** 读最近 N 条提交（`--date=short`，制表符分隔，避免 subject 里的空格歧义）。 */
export async function readGitLog(
  workspaceRoot: string,
  limit: number,
): Promise<{ commits: SeedSignals['commits']; error?: string }> {
  if (limit <= 0) return { commits: [], error: 'gitCommits=0（已禁用 git 读取）' }
  try {
    const out = await runGit(
      ['log', `-n${Math.floor(limit)}`, '--date=short', '--format=%h%x09%ad%x09%s'],
      workspaceRoot,
    )
    const commits = out
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const parts = line.split('\t')
        return { hash: parts[0] ?? '', date: parts[1] ?? '', subject: parts.slice(2).join('\t').trim() }
      })
      .filter((c) => c.hash !== '')
    return { commits }
  } catch (error) {
    return { commits: [], error: `git 不可用或该目录不是仓库（${errText(error)}）` }
  }
}

/** 读 package.json 的标识信息（不存在/非法 JSON 都返回 null）。 */
export async function readManifest(
  workspaceRoot: string,
): Promise<{ name: string; description: string; scripts: string[] } | null> {
  try {
    const raw = await readFile(join(workspaceRoot, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const scripts = parsed.scripts !== null && typeof parsed.scripts === 'object'
      ? Object.keys(parsed.scripts as Record<string, unknown>).slice(0, 20)
      : []
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      description: typeof parsed.description === 'string' ? parsed.description : '',
      scripts,
    }
  } catch {
    return null
  }
}

/** 读 README 首行与 1–3 级标题（作为仓库自述的目录）。 */
export async function readReadmeHeadings(
  workspaceRoot: string,
  max = 20,
): Promise<{ file: string; firstLine: string; headings: string[] } | null> {
  for (const candidate of ['README.md', 'readme.md', 'README.MD', 'README.zh.md', 'README.zh-CN.md']) {
    try {
      const raw = await readFile(join(workspaceRoot, candidate), 'utf8')
      const lines = raw.split(/\r?\n/)
      const headings = lines
        .filter((line) => /^#{1,3}\s+\S/.test(line))
        .map((line) => line.replace(/^#+\s+/, '').trim())
        .filter((h) => h !== '')
        .slice(0, max)
      const firstLine = lines.find((line) => line.trim() !== '')?.trim() ?? ''
      return { file: candidate, firstLine: firstLine.slice(0, 200), headings }
    } catch {
      /* 试下一个候选名 */
    }
  }
  return null
}

/** 扫顶层目录/文件（剔除噪声与隐藏项，各自有界）。 */
export async function readTopLevelEntries(
  workspaceRoot: string,
  maxEntries: number,
): Promise<{ dirs: string[]; files: string[] }> {
  try {
    const entries = await readdir(workspaceRoot, { withFileTypes: true })
    const dirs: string[] = []
    const files: string[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') || NOISE.has(entry.name)) continue
      if (entry.isDirectory()) dirs.push(entry.name)
      else files.push(entry.name)
    }
    dirs.sort()
    files.sort()
    const half = Math.max(1, Math.floor(maxEntries / 2))
    return { dirs: dirs.slice(0, half), files: files.slice(0, half) }
  } catch {
    return { dirs: [], files: [] }
  }
}

/** 组装骨架笔记正文。 */
function buildSeedNote(signals: SeedSignals, skipped: string[], candidates: string[]): string {
  const today = new Date().toISOString().slice(0, 10)
  const lines: string[] = [
    '---',
    'kind: note',
    'tags: [项目, 骨架, seed]',
    `title: 项目骨架（冷启动 seed ${today}）`,
    '---',
    '',
    `# ${signals.manifest?.name !== undefined && signals.manifest.name !== '' ? signals.manifest.name : '项目'} 骨架`,
    '',
    '> 由 `devmemory_seed` 从仓库的**确定性信号**生成（无 LLM）。这是**起点骨架而非完整认知**：',
    '> 请用 `devmemory_remember` / `devmemory_note` 逐步补充真实结论，并删掉过时/无用的部分。',
    '',
  ]

  if (signals.manifest !== null) {
    lines.push('## 项目标识（来自 package.json）', '')
    if (signals.manifest.name !== '') lines.push(`- 名称：${signals.manifest.name}`)
    if (signals.manifest.description !== '') lines.push(`- 说明：${signals.manifest.description}`)
    if (signals.manifest.scripts.length > 0) lines.push(`- npm scripts：${signals.manifest.scripts.join(', ')}`)
    lines.push('')
  }

  if (signals.dirs.length > 0 || signals.files.length > 0) {
    lines.push(`## 顶层结构（${signals.dirs.length + signals.files.length} 项，已剔除依赖/构建/隐藏目录）`, '')
    for (const dir of signals.dirs) lines.push(`- \`${dir}/\``)
    for (const file of signals.files) lines.push(`- \`${file}\``)
    lines.push('')
  }

  if (signals.readme !== null) {
    lines.push(`## README 目录（${signals.readme.file}）`, '')
    if (signals.readme.firstLine !== '') lines.push(`- 首行：${signals.readme.firstLine}`)
    for (const heading of signals.readme.headings) lines.push(`- ${heading}`)
    lines.push('')
  }

  if (signals.commits.length > 0) {
    lines.push(`## 近期提交（最近 ${signals.commits.length} 条，最新在前）`, '')
    for (const commit of signals.commits) lines.push(`- ${commit.date} \`${commit.hash}\` ${commit.subject}`)
    lines.push('')
  }

  if (candidates.length > 0) {
    lines.push('## 候选 L3（**待确认**，不要当既定事实）', '')
    lines.push('> 这些只是从仓库文件推出的线索；确认后请用 `devmemory_remember` 提升为 L3，或直接忽略。', '')
    for (const candidate of candidates) lines.push(`- ${candidate}`)
    lines.push('')
  }

  if (skipped.length > 0) {
    lines.push('## 采集说明', '')
    for (const item of skipped) lines.push(`- 跳过：${item}`)
    lines.push('')
  }

  return lines.join('\n')
}

/** 由确定性信号推导候选 L3（只取"文件里明写"的，不做推断）。 */
function buildCandidates(signals: SeedSignals): string[] {
  const candidates: string[] = []
  const manifest = signals.manifest
  if (manifest !== null && manifest.name !== '') {
    candidates.push(`项目实体：${manifest.name}${manifest.description !== '' ? ` —— ${manifest.description}` : ''}（来源 package.json）`)
  }
  if (signals.readme !== null && signals.readme.firstLine !== '') {
    candidates.push(`项目自述：${signals.readme.firstLine}（来源 ${signals.readme.file} 首行）`)
  }
  if (signals.dirs.length > 0) {
    candidates.push(`主要顶层目录：${signals.dirs.join(', ')}（来源目录扫描）`)
  }
  return candidates
}

/**
 * 执行一次冷启动 seed。
 *
 * @param store - 已 init 的记忆库（写入受库根来源守卫约束：库根不可信时会被拒绝）
 * @param config - 插件配置（`config.seed`）
 * @param opts.force - 已存在骨架笔记时是否覆盖（默认 false）
 * @throws 当 `seed.enabled === false`（业务错误，工具层原样回报）
 */
export async function seedLibrary(
  store: MemoryStore,
  config: Config,
  opts: { force?: boolean } = {},
): Promise<SeedResult> {
  if (!config.seed.enabled) {
    throw new Error('冷启动 seed 已禁用（seed.enabled=false）')
  }
  const skipped: string[] = []
  const absolute = join(layerDirs(store.root).docs, SEED_NOTE_REL_PATH)

  if (opts.force !== true) {
    try {
      await access(absolute)
      // 幂等：已存在就不覆盖（避免把用户后续补充的内容冲掉）
      return {
        relPath: SEED_NOTE_REL_PATH,
        written: false,
        signals: { commits: 0, dirs: 0, files: 0, readmeHeadings: 0, hasManifest: false },
        candidates: [],
        skipped: [`骨架笔记已存在（${SEED_NOTE_REL_PATH}）；如需重建请用 force: true`],
      }
    } catch {
      /* 不存在 → 继续采集 */
    }
  }

  const workspaceRoot = store.sessionWorkspaceRoot
  const [gitResult, manifest, readme, entries] = await Promise.all([
    readGitLog(workspaceRoot, config.seed.gitCommits),
    readManifest(workspaceRoot),
    readReadmeHeadings(workspaceRoot),
    readTopLevelEntries(workspaceRoot, config.seed.maxEntries),
  ])
  if (gitResult.error !== undefined) skipped.push(gitResult.error)
  if (manifest === null) skipped.push('未找到可解析的 package.json')
  if (readme === null) skipped.push('未找到 README.md')
  if (entries.dirs.length === 0 && entries.files.length === 0) skipped.push('顶层目录扫描为空或不可读')

  const signals: SeedSignals = {
    commits: gitResult.commits,
    dirs: entries.dirs,
    files: entries.files,
    readme,
    manifest,
  }
  const candidates = buildCandidates(signals)
  const body = buildSeedNote(signals, skipped, candidates)
  await store.note({ relPath: SEED_NOTE_REL_PATH, body })

  return {
    relPath: SEED_NOTE_REL_PATH,
    written: true,
    signals: {
      commits: signals.commits.length,
      dirs: signals.dirs.length,
      files: signals.files.length,
      readmeHeadings: signals.readme?.headings.length ?? 0,
      hasManifest: signals.manifest !== null,
    },
    candidates,
    skipped,
  }
}
