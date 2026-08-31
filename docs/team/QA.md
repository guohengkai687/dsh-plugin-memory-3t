# QA — dsh-plugin-memory-3t v0.1 验收执行结果

> 执行人：TL（串行 QA，因子代理环境限制降级）。执行命令均在 `D:\DeepSeek\Harness\dsh-plugin-memory-3t` 实跑。

## 执行证据（2026-01-15）

| 命令 | 结果 |
|---|---|
| `npm run build` | ✅ 无错误（tsc 产出 dist/ 含 .js/.d.ts/.map） |
| `npm run typecheck` | ✅ 零错误 |
| `npm test` | ✅ **56 tests / 56 pass / 0 fail**（`--test-isolation=none --test-concurrency=1`） |
| `npm pack --dry-run` | ✅ 44 文件 / 49.9 kB，含 dist/、skills/dev-memory.md、cordis.patch.yml、package.json |

## 逐条 AC

| AC | 验收内容 | 证据 |
|---|---|---|
| AC1 | 包结构（package.json/tsconfig/cordis.patch.yml/src/skills/test/README） | 文件清单 + pack 清单；`npm run typecheck` 过 |
| AC2 | 三层存储（runtime/docs/spaces + meta.json + audit.jsonl，0o700/0o600） | `store.test.mjs`：init 建目录与 meta/audit、remember frontmatter、note 追加、appendRuntime；代码 0o700/0o600 |
| AC3 | .gitignore 自维护 | `store.test.mjs`：存在且缺 `.memory` 时追加（副作用：不创建文件） |
| AC4 | BM25（中英分词、分组排序、maxResults、惰性索引） | `indexer.test.mjs`：tokenize 中英/2-gram、buildIndex 幂等（去时间戳）、searchIndex 分组/过滤/截断；IndexManager 脏计数 |
| AC5 | 7 工具（schema/exec/路径校验） | `tools.test.mjs`：7 个名称/object-rooted schema/render/execute；note 逃逸拒绝 |
| AC6 | skill 注册（dev-memory，modelInvocable，content 非空） | `lifecycle.test.mjs`：skills.register ×1、name 合法、content > 500B、invocation 断言 |
| AC7 | 生命周期（session-start 装载 / boot context / pre-step 提醒 / turn-stopping digest / created） | `lifecycle.test.mjs`：context name/order=-200 文本函数、4 类事件、pre-step 注入（plugin 消息 source 断言）+ 未触发时不注入 |
| AC8 | digest（触发/去重/promote 上限/fail-open/补做） | `digest.test.mjs`：forced 提升、去重不新建、maxPromote 溢出转笔记、remember 抛错→pending+retries 且不 rethrow、runPending 复位、未触发返回 null |
| AC9 | 配置（默认值/钳制/开关位） | `config.test.mjs`：默认值 deepEqual、嵌套覆盖、负数/非法钳制 |
| AC10 | README 中文（安装/配置/使用/限制） | `README.md` 存在；Review 核对与实现一致（配置表 ↔ cordis.patch.yml ↔ config.ts） |

## 结论

- **AC1–AC10 全部通过**，证据可复现（`npm test`）。
- 已知限制（如实，见 README）：确定性 digest（无 LLM）；无 embedding/向量（开关位）；索引写后阶段性近似（50 次重建阈值）；~~workspace 根 = process.cwd()~~（v0.3.1 已改：按会话 `agent.session.header.cwd` 解析，回退执行 `workspaceDir` → `process.cwd()`）；Windows 无 POSIX 权限语义。
- 环境备注：Windows 沙箱限制 spawn/管道，测试用 `node --test --test-isolation=none`（写进 package.json script，常规环境 `npm test` 直接可用）。