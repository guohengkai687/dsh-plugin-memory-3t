# REVIEW — dsh-dev-memory-3t v0.1（审查记录）

> 审查方式：架构师/工程师子代理在会话环境中无法产出文件（两次尝试均无输出），
> 按 skill 降级预案由 TL 以串行角色完成审查（标准轴 + 规格轴，按 REVIEW-GUIDE 执行）。
> 审查者执行了 `npm run typecheck` 与 `npm test`（实跑，非转述）。

## 处理记录（审查中发现 → 处置）

| 编号 | 级别 | 问题 | 处置 |
|---|---|---|---|
| R1 | major | `config.embedding.enabled` 合并逻辑 `!== false` 使默认值错开为 true | 改为 `=== true`；`config.test.mjs` 覆盖默认值 |
| R2 | major | digest 去重走缓存索引，写入后新条目查不到 → 重复内容重复建 | 改为扫描式 token 重叠比对；`digest.test.mjs` 去重用例通过 |
| R3 | major | digest 失败补做 `runPending` 未在 session-start 接线（架构缺口） | 接线 + `runPending` 单测（56 用例新增） |
| R4 | major | `buildIndex` 产出非确定 `builtAt`，幂等断言不稳定 | 测试剔除时间戳字段后 deepEqual |
| R5 | minor | lifecycle 测试 `process.chdir` 在 test 并发下互相污染 | test script 加 `--test-concurrency=1` |
| R6 | minor | 测试 finally 的 `rm` 与后台异步写入竞争（ENOTEMPTY） | settle() 延迟后清理 |
| R7 | info | session 流水记录仅存 user 消息；assistant 详述不进 L1 | 如实：skill 引导显式 remember/note 承担；README 限制说明 |
| R8 | info | `devmemory_consolidate` 手动 digest 用空消息列表 → 回落读当日流水 | 行为正确（collectCandidates 回落），README 已描述 |

## 标准轴结论（REVIEW-GUIDE A1–A8）

- A1 TS strict：`npm run typecheck` 零错误 ✅
- A2 零运行时依赖：`dependencies` 为空；devDeps 仅 typescript/@types/node ✅
- A3 命名一致性：src 无 `memory3t`/`mnemon_` 残留；7 工具 `devmemory_*`、skill `dev-memory`、boot `dev-memory-boot`、包名 `dsh-dev-memory-3t` ✅
- A4 结构：无 TODO 占位；模块职责单一（config/paths/frontmatter/indexer/store/digest/render/tools/skill/index）✅
- A5 fail-open：store.init / digest 全流程 / pre-step / session-start / 工具注册均 try/catch 降级，不 rethrow 到会话 ✅（digest fail-open 有异常注入测试）
- A6 安全：所有路径参数过 safeJoin / note relPath 校验；audit.jsonl；无密钥进 prompt ✅
- A7 权限：0o700/0o600 尽力而为；Windows 说明入 README ✅
- A8 提交面：cordis.patch.yml（insert 块 + 默认 config）与 README 安装说明/配置表一致 ✅

## 规格轴结论

逐条 AC 证据见 `QA.md`。审查复核：实现与 SPEC 无偏离；ADR 已在 ARCHITECTURE §7 记录。
**Blockers：0（无未处置 blocker）。**

## 遗留（非 blocker，路线图）

- embedding / recall nudge 开关位未实现检索本体（v0.2）
- git 自动提交 / pack-unpack / WebUI（v0.2–v0.3）
- subagent 视图继承简化（v0.3）