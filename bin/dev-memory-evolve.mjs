#!/usr/bin/env node
// dev-memory-evolve：周演化的 CLI 入口（懒触发之外的手动/定时兜底）。
//
// 用法：
//   node bin/dev-memory-evolve.mjs [--root <工作区>] [--dry-run] [--window <天>]
//                                  [--stages harvest,reflect,consolidate,forget,report]
//                                  [--json]
//
// 行为：解析库位 → init → runEvolution（带租约与状态落盘）→ 打印报告。
// 已由会话懒触发跑过的库仍会强制执行（CLI 是显式动作），除非租约被占用。
import { resolve } from 'node:path'

const { DEFAULT_CONFIG, mergeConfig } = await import('../dist/config.js')
const { MemoryStore } = await import('../dist/store.js')
const { runEvolution } = await import('../dist/evolve.js')

const STAGES = ['harvest', 'reflect', 'consolidate', 'forget', 'evaluate', 'tune', 'report']

function parseArgs(argv) {
  const out = { root: undefined, dryRun: false, windowDays: undefined, stages: undefined, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') out.root = argv[++i]
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--window') out.windowDays = Number(argv[++i])
    else if (arg === '--stages') out.stages = String(argv[++i] ?? '').split(',').filter(Boolean)
    else if (arg === '--json') out.json = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`未知参数: ${arg}`)
  }
  return out
}

function usage() {
  return [
    'dev-memory-evolve — 周演化（采集 → 提炼 → 合并 → 衰减/归档 → 周报）',
    '',
    '用法: node bin/dev-memory-evolve.mjs [选项]',
    '  --root <dir>      工作区目录（默认 $DEV_MEMORY_ROOT，再退回当前目录；库位 = <dir>/.memory）',
    '  --dry-run         只出报告，不写库',
    '  --window <days>   采集窗口天数（默认 config.evolve.windowDays）',
    '  --stages <list>   阶段子集，逗号分隔（默认全部）',
    '  --json            以 JSON 输出报告（机器可用）',
    '',
    '提示：首次在已用库上跑建议先 --dry-run 看计划；归档条目可用 devmemory_admin op=restore 恢复；',
    '      阈值（minScore/minEvidence/halfLifeDays/minSalience/maxPrune）在 config.evolve 里调。',
  ].join('\n')
}

async function main(argv) {
  const options = parseArgs(argv)
  if (options.help === true) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  if (options.stages !== undefined) {
    const bad = options.stages.filter((s) => !STAGES.includes(s))
    if (bad.length > 0) throw new Error(`未知阶段: ${bad.join(',')}（可用：${STAGES.join(',')}）`)
  }
  const workspaceRoot = resolve(options.root ?? process.env.DEV_MEMORY_ROOT ?? process.cwd())
  const store = new MemoryStore(workspaceRoot, mergeConfig({}))
  await store.init()
  const config = store.config.evolve
  if (!options.json) process.stderr.write(`dev-memory-evolve: 工作区根 ${workspaceRoot}，库根 ${store.root}\n`)
  const report = await runEvolution(store, config, {
    dryRun: options.dryRun,
    ...(Number.isFinite(options.windowDays) ? { windowDays: options.windowDays } : {}),
    ...(options.stages !== undefined ? { stages: options.stages } : {}),
  })
  if (report === null) {
    process.stderr.write('dev-memory-evolve: 未运行（evolve 被禁用，或已有演化在跑）\n')
    return 1
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`${report.report.markdown}\n`)
    if (report.report.path !== null) process.stdout.write(`周报已写入: ${report.report.path}\n`)
  }
  return report.errors.length === 0 ? 0 : 2
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`dev-memory-evolve: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
