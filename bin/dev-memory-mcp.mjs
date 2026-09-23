#!/usr/bin/env node
// dev-memory-mcp：记忆库 MCP stdio 服务器（bin 入口；实际逻辑在 dist/mcp.js）。
//
// 注意：stdout 是 JSON-RPC 协议通道，本进程绝不允许向 stdout 写日志/提示；
// 一切诊断（含 main 抛错）都走 stderr。零运行时依赖（协议手写实现）。
import { main } from '../dist/mcp.js'

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`dev-memory-mcp: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
