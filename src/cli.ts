/**
 * dev-memory-pack CLI：记忆库打包迁移入口（v0.2 剩余项二）。
 *
 * 用法：
 *   dev-memory-pack pack <记忆库根> [--out <产物路径>]
 *   dev-memory-pack unpack <档案.dmmem> <目标目录>
 *
 * 零运行时依赖；产物为单文件 .dmmem（gzip JSON），排除 .git/index.json/vectors。
 * 供 bin/dev-memory-pack.mjs 与本仓库手工调用（node dist/cli.js）。
 */

import { packLibrary, unpackLibrary } from './pack.js'

const USAGE = `dev-memory-pack v0.3 —— 记忆库打包迁移

用法：
  dev-memory-pack pack <记忆库根> [--out <产物路径>]
      打包记忆库为单文件 .dmmem（排除 .git / index.json / vectors 派生物）
  dev-memory-pack unpack <档案.dmmem> <目标目录>
      把档案恢复到目标目录（目录可不存在；git 仓库由下次插件启动初始化）

示例：
  dev-memory-pack pack .memory --out backup-2026-08.dmmem
  dev-memory-pack unpack backup-2026-08.dmmem D:/workspace/.memory`

/** CLI 主入口；返回进程退出码（0 成功 / 1 业务错误 / 2 用法错误）。 */
export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  try {
    if (cmd === 'pack') {
      const root = rest[0]
      if (root === undefined) return usageFail()
      const outIdx = rest.indexOf('--out')
      const out = outIdx === -1 ? undefined : rest[outIdx + 1]
      if (outIdx !== -1 && out === undefined) return usageFail()
      const result = await packLibrary(root, out)
      process.stdout.write(
        `${JSON.stringify({ ok: true, ...result, excluded: ['.git', 'index.json', 'vectors/'] }, null, 2)}\n`,
      )
      return 0
    }
    if (cmd === 'unpack') {
      const [archive, target] = rest
      if (archive === undefined || target === undefined) return usageFail()
      const result = await unpackLibrary(archive, target)
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
      return 0
    }
    process.stdout.write(USAGE + '\n')
    return 2
  } catch (error) {
    process.stderr.write(`dev-memory-pack: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

function usageFail(): number {
  process.stdout.write(USAGE + '\n')
  return 2
}