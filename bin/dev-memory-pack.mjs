#!/usr/bin/env node
// dev-memory-pack：记忆库打包迁移 CLI（bin 入口；实际逻辑在 dist/cli.js）。
import { main } from '../dist/cli.js'

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`dev-memory-pack: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })