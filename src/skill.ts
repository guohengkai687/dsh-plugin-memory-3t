/**
 * dev-memory skill 内容加载：读取包内 skills/dev-memory.md。
 *
 * 构建后该文件位于 dist/skill.js 相邻的包根 skills/ 下，
 * `new URL('../skills/dev-memory.md', import.meta.url)` 始终指向包根。
 */

import { readFileSync } from 'node:fs'

let cached: string | null = null

export function loadMemorySkillContent(): string {
  if (cached !== null) return cached
  const url = new URL('../skills/dev-memory.md', import.meta.url)
  cached = readFileSync(url, 'utf8')
  return cached
}

export const MEMORY_SKILL_NAME = 'dev-memory'

export const MEMORY_SKILL_DESCRIPTION =
  '三层长期记忆协议：按层读写记忆（L1 会话流水 / L2 知识笔记 / L3 长期事实，库根 <工作区>/.memory/），执行 recall / remember / note / consolidate，低频运维走 devmemory_admin（link / forget / history / diff / restore / diag / seed）；记忆库由 git 管理版本，可回溯；WebUI 面板与参数可在 DSH 设置「记忆管理」页管理（v0.5、v0.7）。'

export const MEMORY_SKILL_WHEN_TO_USE =
  '用户提到旧事/偏好/决策、说"记住/忘掉/整理一下记忆"、需要检索项目历史或会话历史、会话收尾沉淀时。'

export const MEMORY_SKILL_INVOCATION = { modelInvocable: true, userInvocable: false } as const