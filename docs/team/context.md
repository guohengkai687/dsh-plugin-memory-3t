# dsh-plugin-memory-3t · v0.1 MVP — 团队交接物总入口

## 目标

交付 DSH 记忆插件 `dsh-plugin-memory-3t` v0.1 MVP：三层记忆（L1 会话流水 / L2 知识笔记 / L3 长期事实）+ 本地 BM25 检索 + 7 个 `devmemory_*` 工具 + 内嵌 skill `dev-memory` + 生命周期接入（注入/提醒/digest 沉淀），全程 fail-open。**不依赖任何外部服务**。

## 范围

- **做**：包结构、三层 markdown 存储（默认 `<workspace>/.memory/`）、BM25 索引（中文 2-gram）、7 工具、skill 注册、session-start 装载 / system-prompt boot / pre-step 提醒 / turn-stopping digest、配置（storageDir + 三档 token 预算 + 开关位）、单元测试、README。
- **不做**（v0 明确排除）：embedding/向量检索（只留配置开关位）、git 自动提交、pack/unpack CLI、WebUI、多 provider、主动追忆 nudge（配置可留开关位，默认关）。

## 关键路径

| 项 | 路径 |
|---|---|
| 设计文档（权威来源） | `D:\DeepSeek\Harness\dsh-plugin-memory-3t\docs\design\DESIGN.md`（2026-08 从 `design/memory-3t/` 归纳迁入） |
| 插件项目根 | `D:\DeepSeek\Harness\dsh-plugin-memory-3t\` |
| 团队交接物 | `D:\DeepSeek\Harness\dsh-plugin-memory-3t\docs\team\`（本目录） |
| skill 协议正文 | `D:\DeepSeek\Harness\dsh-plugin-memory-3t\docs\design\skill.dev-memory.md`（设计草案；运行版在 `skills/dev-memory.md`） |
| DSH 接口源码（签名查证） | `E:\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\{dsh-tools,dsh-skill,dsh-system-prompt,dsh-agent-loop}\lib\index.js` |

## 阶段与门禁

| 阶段 | 产物 | 出口标准 |
|---|---|---|
| Spec | `SPEC.md` | AC 编号齐全、可测 |
| Design | `ARCHITECTURE.md` + `TASKS.md` | 接口签名已对照 DSH 源码核实；TASKS 到可执行粒度 |
| 实现 | `src/**` + `test/**` + `skills/dev-memory.md` + `README.md` + `package.json`/`cordis.patch.yml`/`tsconfig.json` | `tsc --noEmit` 通过；`node --test` 全绿 |
| Review | `REVIEW.md` | 无未处置 blocker |
| QA | `QA.md` | 每条 AC 有证据 |

当前阶段：**全部完成（v0.1 MVP 交付）**。

## 阶段状态（最终）

- Spec ✅ → Design ✅（架构师子代理环境异常，TL 降级直写 ARCHITECTURE/TASKS，接口经 TL 源码核实写入 TL-NOTES.md）
- 实现 ✅ → Review ✅ → QA ✅（工程师/审查子代理同样因环境无法产出，TL 串行完成实现与审查；REVIEW.md 无未处置 blocker，QA.md 逐条 AC 有证据）
- 测试：56/56 pass；typecheck 0 错误；npm pack 44 文件。
- 交付说明见最终汇报（goal round 完成时）。

## 环境约束（Windows 沙箱）

- 测试用 `node --test --test-isolation=none`（避开子进程管道限制），**不用 vitest**。
- 依赖安装如需联网加 `--cache <项目内目录> --ignore-scripts`；尽量保持零运行时依赖，devDeps 最小化。
- headless profile 激活验证依赖 `dsh` CLI 可执行与 spawn 权限，QA 阶段尽力而为，不可行则如实记录并在 README 说明常规环境验证步骤。

## 环境侦查结论（TL 已实测，2026-01-15）

| 项 | 结论 |
|---|---|
| node | v24.15.0（满足 DSH node 要求） |
| npm | 11.12.1，**可联网安装**（本机 TLS 问题不影响 npm） |
| `node --test --test-isolation=none` | ✅ 冒烟通过（`D:\DeepSeek\Harness\.tmp\smoke\`） |
| tsc | 本机无全局/DSH 捆绑 typescript；npm 安装可用（探针装到 `D:\DeepSeek\Harness\.tmp\npm-probe`，tsc 可执行）。**建议固定 `typescript@^5` devDependency**（探针装到的 v7 是 native 版，行为可能不同，工程师自行裁决版本并记录） |
| 权限 | POSIX 0700/0600 在 Windows 无 POSIX 语义；权限实现按"设置 Node 可设的最小权限位 + 文档说明"，测试断言文件存在与内容而非 POSIX 权限 |