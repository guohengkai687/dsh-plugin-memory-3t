# dsh-plugin-memory-3t

本地三层记忆插件（DSH），零运行时依赖、无外部服务。

> **L1 会话流水**（`runtime/`）· **L2 知识笔记**（`docs/`）· **L3 长期事实**（`spaces/`）
> 插件管机制（何时写 / 注入多少 / 检索多快 / 多安全），内嵌 skill `dev-memory` 管协议（模型该不该查、写什么、用什么格式）。协议可被项目级 `.dsh/skills/dev-memory/SKILL.md` 覆盖。

设计参考：Hindsight · OpenViking · dsh-mnemon · dsh-plugin-memory（详见 `docs/design/DESIGN.md`）。

---

## 快速开始

```bash
# 1. 构建（产出 dist/）
npm install && npm run build

# 2. 安装到 DSH profile（cordis.patch.yml 经 package.json 的 dsh.bundle.patch 声明）
dsh plugin --profile <profile> add dsh-plugin-memory-3t
# 或手动合并 cordis.patch.yml 到 profile 的 patch（bundle 层 insert）

# 3. 重启 DSH 会话。记忆库默认建在会话工作区的 .memory/ 目录
```

安装后不需要任何手工初始化：首次会话自动建库，模型通过 12 个 `devmemory_*` 工具与 `dev-memory` skill 使用记忆。

## 三层记忆模型

| 层 | 目录 | 内容 | 注入方式 | 预算 |
|---|---|---|---|---|
| L1 Runtime | `runtime/YYYY-MM-DD.md` | 当日会话流水 | **每会话一次**注入近期摘要（v0.6.6：剔除本会话自己的 prompt 回放） | ≤ 1200 tokens |
| L2 Documents | `docs/**/*.md` | 知识笔记（教程/方案/排查） | **不注入**，`devmemory_recall` 按需查 | 0 |
| L3 Spaces | `spaces/<id>.md` | 原子事实（偏好/决策/实体/上下文） | **默认不注入**（v0.6.6：`l3Inject` 默认 `off`，按需 recall）；`salience`/`query` 模式每会话一次注入 top-k | ≤ 800 tokens |

分层原则：L2 是"检索层"，完整文档永不主动进 prompt；L1/L3 是"注入层"，各自有 token 硬顶，超预算宁可少注入也不破坏 markdown 结构。

### 注入时机（v0.6.5 重构：从"每请求"改为"每会话一次"）

| 内容 | v0.6.4 及以前 | v0.6.5 起 |
|---|---|---|
| 协议声明（数据非指令、工具指引、库根） | `systemPrompt.context`，**每次请求**注入，且携带易变状态 | `systemPrompt.context`，**每次请求**注入但**逐字节静态**（不破坏 prefix 缓存） |
| 会话状态（条目数/VCS/检索/索引陈旧/诊断计数） | 混在上述块里，每次请求重复 | **每会话一次**注入（`[dev-memory 会话状态]`） |
| L1 回放 + L3 top-k | 混在上述块里，每次请求重复 | **每会话一次**注入（`[dev-memory L1 流水]` / `[dev-memory L3 长期事实]`） |

**为什么改**：DSH 的 `systemPrompt.context` 贡献会被渲染进 "Current runtime context" 快照，而该快照**在每次请求重新组装**（原文：`This snapshot supersedes earlier runtime-context snapshots`）。于是原来最多约 2600 tokens 的易变内容会在**每一轮**重新计费，历史里还会堆积 N 份互相 supersede 的旧快照，且块内易变值让 prefix 缓存每轮失效。

**改动后**：每次请求只剩约 250 tokens 的静态协议块；召回内容作为**一条插件消息**在会话首个 pre-step 注入一次后即成为正常历史（与 Hindsight「会话首个 prompt 仅一次」同构）。`clear` / `compact` 会重置注入（见上「事件勘误」），中途要更新状态用 `devmemory_status`。

## 工具

**默认 `toolsProfile: 'core'`（v0.7.0）**：5 个高频工具 + 1 个 action 式 `devmemory_admin`（低频运维合并），常驻 schema 实测比 v0.6.6 的 12 个独立工具**少约 1.1k tokens/次模型调用**。设 `toolsProfile: 'full'` 可切回 v0.6 的 12 个独立工具。

| 工具（core 面） | 作用 |
|---|---|
| `devmemory_status` | 层统计 / 索引状态 / 最近 digest / git 版本状态 / 向量检索状态 / 诊断计数 / scope（诊断自检） |
| `devmemory_recall` | 跨层查询（唯一读入口，按层分组返回命中） |
| `devmemory_remember` | 写 L3 条目（kind: preference/decision/entity/context） |
| `devmemory_note` | 写/追加 L2 笔记（防路径逃逸） |
| `devmemory_consolidate` | 立即触发 digest 沉淀 + 提交 git 版本 |
| `devmemory_admin` | 低频运维（一次一件）：`op=link` L3 互链 / `forget` 删除或降权 / `history` git 历史 / `diff` 变更明细 / `restore` 恢复提交 / `diag` 诊断记录 / `seed` 冷启动骨架 |

`full` 面 = 上面 5 个高频工具 + 下面 7 个独立工具（与 v0.6 完全一致，迁移无感）：

| full 面独立工具 | 等价 admin 调用 |
|---|---|
| `devmemory_link` | `devmemory_admin(op="link", a, b)` |
| `devmemory_forget` | `devmemory_admin(op="forget", id, mode, reason)` |
| `devmemory_history` | `devmemory_admin(op="history", limit, layers, path)` |
| `devmemory_diff` | `devmemory_admin(op="diff", ref, layers, path)` |
| `devmemory_restore` | `devmemory_admin(op="restore", ref, targets, dryRun)` |
| `devmemory_diag` | `devmemory_admin(op="diag", action, level, tool, origin, days, limit)` |
| `devmemory_seed` | `devmemory_admin(op="seed", force)` |

> **为什么合并**（2026-09-23 实测）：DSH 每次模型调用都会带上全部工具的 schema（实测 39 个工具 = 9203 tokens），其中 12 个 `devmemory_*` 占 **2081 tokens/调用 ≈ 插件全部 token 开销的 99%**；而这 7 个低频工具在 3 天窗口的 1188 次调用里只被用到 12 次。合并后 core 面实测 **943 tokens/调用（-55%）**。完整测量链路见 `.memory/docs/notes/2026-09-23-memory-3t-token-cost-evaluation.md`。

> `devmemory_admin` 的 `op` 是**必填**，参数与 full 面同名（`id`/`a`/`b`/`ref`/`targets`/`layers`/`path`/`limit`/`dryRun`/`force`/`action`/`level`/`tool`/`origin`/`days`/`mode`/`reason`）。`devmemory_restore` 的 `dryRun` 默认仍为 `true`——先预览、再执行。

> v0.4 起每个工具的执行都会被自动埋点：**调用异常**与**不符合预期的行为**（工具报错、降级路径、生命周期失败等）自动记入 `<库>/diag/events.jsonl`，`devmemory_diag` / `devmemory_status` / WebUI 面板可查看，使用一段时间后审查这批记录用于优化插件。

## Skill：dev-memory

插件通过 `ctx.skills.register` 注册内嵌协议（`skills/dev-memory.md`，`modelInvocable`，不暴露用户手动入口）。协议内容：什么时候该 recall、什么值得写 L3 / 什么进 L2、会话收尾的沉淀 pass、禁止事项（不臆造记忆、不把整个笔记灌进 prompt）。

**优先级链**（DSH 决定）：项目级 `.dsh/skills/dev-memory/SKILL.md` > 插件 runtime skill > 用户级 `~/.agents/skills/`。想自定义协议：把 `skills/dev-memory.md` 复制到项目 `.dsh/skills/dev-memory/SKILL.md` 修改即可，插件升级不会覆盖。完整覆盖示例（含一份真实覆盖版协议）见 `docs/project-skill-override.md`。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `storageDir` | `.memory` | 记忆库根：相对路径基于基准目录解析（workspace=工作区根 / user=用户主目录）；绝对路径原样 |
| `scope` | `workspace` | 记忆库粒度（v0.3）：`workspace`（每工作区一库，默认）/ `user`（全局一库，跨工作区共享，默认 `~/.memory`；user 粒度绝不改写工作区 `.gitignore`） |
| `workspaceDir` | 空 | 工作区根覆盖（v0.3.1）：置为非空路径时 workspace 粒度固定以该目录为基准解析 `storageDir`（忽略会话工作区，用于显式钉死库位）；空 = 自动按会话真实工作区根解析 |
| `maxBootTokens` | 600 | 状态块（原 boot 块）注入预算 |
| `maxRuntimeTokens` | 1200 | L1 回放预算 |
| `maxSpaceTokens` | 800 | L3 top-k 预算 |
| `maxViewTokens` | 2000 | **v0.6.6**：会话视图（状态块 + L1 回放 + L3）**全局**预算，按序扣减剩余额度，防止前一块挤光后面 |
| `l3Inject` | `off` | **v0.6.6**：L3 长期事实注入方式——`off`（默认，不注入，按需 recall）/ `salience`（按 salience+accesses 取 top-5）/ `query`（按会话首条消息 BM25 检索，门槛 `recall.highScore`）。下一会话生效 |
| `l1MaxCharsPerLine` | 160 | **v0.7.0**：L1 回放**单行正文**字符上限（0 = 不摘要）。流水行是提问原文，超长按此截断加 `…`，避免一条长 prompt 独吞回放预算 |
| `subagentInject` | false | **v0.7.0**：subagent 是否也注入会话视图/召回提醒。默认 false = 子代理保留记忆工具与静态 boot 协议，但不自动注入（扇出场景实测 28 个子代理会话零次使用记忆工具）。置 true 恢复 v0.6 行为 |
| `toolsProfile` | `core` | **v0.7.0**：工具暴露面——`core`（5 高频 + 1 个 action 式 `devmemory_admin`，省约 1.1k tokens/调用）/ `full`（v0.6 的 12 个独立工具）。改动需重启插件生效 |
| `embedding.enabled` | false | 向量检索开关（Ollama 本地）；开启后 L2/L3 写入同步生成向量，检索走向量+BM25 融合 |
| `embedding.endpoint` | `http://localhost:11434` | Ollama HTTP API 地址 |
| `embedding.model` | `nomic-embed-text` | 嵌入模型名 |
| `embedding.timeoutMs` | 3000 | 单次 embedding 超时；超时/不可用自动降级回 BM25 |
| `digest.maxMessages` | 24 | 会话消息数触发沉淀的阈值 |
| `digest.maxPromote` | 20 | 单次 digest 提升到 L3 的条数上限（超出转 L2 笔记） |
| `digest.maxRetries` | 2 | digest 失败补做上限 |
| `recall.defaultLimit` | 10 | 每层最多返回条数 |
| `recall.minSalience` | 0.25 | L3 注入的 salience 门槛 |
| `recall.highScore` | 0.6 | 高相关阈值（预留） |
| `dedupe.threshold` | 0.55 | digest 去重的 token 重叠阈值 |
| `index.rebuildAfterWrites` | 50 | 写入超过该次数后下次查询前自动重建倒排 |
| `recallNudge.enabled` | false | 主动追忆（v0.3 实现）：开启后按 30–240 分钟随机间隔对根会话 `agent.followup` 一次温和提醒（每会话至多一次；文案标注"非用户输入"，默认关不打扰） |
| `vcs.enabled` | true | git 版本回溯开关（false = 等同 v0.1 无版本管理） |
| `vcs.autoCommit` | true | 事件驱动自动提交（防抖 + 计数合并） |
| `vcs.debounceMs` | 1000 | 提交防抖窗口（毫秒） |
| `vcs.batch` | 8 | 未提交写入达到该值立即提交 |
| `vcs.branch` | main | 初始化分支名 |
| `vcs.identity.name/email` | dsh-dev-memory / dev-memory@dsh.local | 本地 git 身份兜底（不依赖全局配置） |
| `vcs.gitDir` | 未设 | 分离 git 目录（`--separate-git-dir`）：绝对路径原样，相对路径基于记忆库根解析；默认未设 = 嵌套 `<库>/.git` |
| `diag.enabled` | true | 诊断与异常记录开关（v0.4）：记录调用异常与不符合预期的行为到 `<库>/diag/events.jsonl` |
| `diag.maxEvents` | 2000 | 诊断事件保留上限（0 = 不限）；超过 2 倍上限自动压缩，只保留最新 maxEvents 条 |
| `webui.enabled` | true | 只读 WebUI 面板开关（v0.5）：false 时摘除 `/dev-memory` 路由（设置页可实时切换） |
| `seed.enabled` | true | 冷启动 seed 开关（v0.6.5）：true 时允许 `devmemory_seed`（只读仓库 + 写一篇 L2 骨架） |
| `seed.auto` | false | 会话启动时若库为空则自动 seed 一次（v0.6.5）：置 true 即复刻 Hindsight 的"零配置开箱"；默认关 = 写库是显式动作，由 skill 引导模型按需调用 |
| `seed.gitCommits` | 30 | seed 读取最近多少条 git 提交（0 = 不读 git） |
| `seed.maxEntries` | 40 | seed 顶层目录条目上限（大仓库防膨胀） |

配置方式：cordis.patch.yml 里 insert 的 `config` 块，或 DSH settings 覆盖同名字段；v0.5 起推荐在 **DSH 设置 →「记忆管理」** 页可视化管理（见下）。

## 使用示例

对话侧（模型行为，由 skill 协议引导）：

```
用户：你还记得我们上次讨论的 DSH skill 注册机制吗？
模型：devmemory_recall(query="DSH skill 注册机制") → 命中 L3/笔记 → 回答并注明来源。
      若未命中 → "记忆库中没有，我可以现在记录。"

用户：以后技术文档都用表格对比。
模型：（用户显式偏好）devmemory_remember(kind="preference", content="用户偏好：技术文档用表格对比", tags=["偏好","文档"])

用户：这段排查过程值得记录。
模型：devmemory_note(relPath="notes/2026-01-15-排查.md", body="…")

用户：就到这里吧。
模型：（会话收尾，digest 自动运行 → L1 压缩、显式内容提升 L3、超限转 L2）
```

文件侧（记忆库是纯 markdown，任何工具可读；v0.2 起由 git 管理版本）：

```
<workspace>/.memory/
├── .git/                     # 嵌套仓库（或 vcs.gitDir 分离的元数据目录；宿主仓库已忽略 .memory）
├── .gitignore                # 内部忽略：index.json / vectors/ / diag/（可重建派生物）及库内 gitDir
├── runtime/2026-01-15.md      # L1 流水：- user: … / - digest: …
├── docs/notes/…md             # L2 笔记
├── spaces/pref-20260115-xxx.md# L3 条目（frontmatter: kind/salience/accesses/tags/links）
├── index.json                 # BM25 倒排（惰性重建，不入 git）
├── vectors/                   # embedding 向量（可选，派生物，不入 git）
├── diag/events.jsonl          # 诊断与异常记录（v0.4，调用异常/不符合预期，不入 git）
├── meta.json                  # schema/配置/digest 状态
└── audit.jsonl                # forget/demote 审计（入 git，权威操作追溯）
```

## 回溯与恢复（v0.2）

记忆库的 git 机制：**每次变更合并提交**（防抖 `vcs.debounceMs` + 计数 `vcs.batch`），**边界强制落盘**（digest / 会话收尾 / 会话启动补交 / `devmemory_consolidate`）。撤销语义安全：`devmemory_restore` 只改内容、绝不重写历史——恢复前自动把当前状态存为检查点提交，恢复本身也是新提交（可撤销的撤销）。

```
模型：devmemory_history(limit=10)          → 最近提交（hash/时间/信息/文件数）
模型：devmemory_diff(ref="abc1234")        → 那次提交改了什么（文件级增删行）
模型：devmemory_restore(ref="abc1234", targets=["l3"], dryRun=true)   → 先预览
模型：devmemory_restore(ref="abc1234", targets=["l3"], dryRun=false)  → 执行（含检查点）
模型：devmemory_recall(...)                → 核对恢复结果
```

恢复目标用**具体路径或层名**（`l1`/`l2`/`l3`）；**省略 `targets` 或填 `["all"]` = 整库时间片**（v0.3：全部被 git 跟踪的内容一次回到该提交，快照之后的删除/新增一并反转；`index.json`/`vectors/` 派生物不受影响）。git 不可用时自动降级为"仅本地存储"（`devmemory_status` 可见，`VCS off`），绝不打断会话。

## 向量检索（v0.2，可选，默认关）

`embedding.enabled: true` 后，L2/L3 写入同步调**本机 Ollama**（`embedding.endpoint`，默认 `http://localhost:11434`）生成向量，存 `<库>/vectors/<docKey>.json`（派生物，不入 git）；`devmemory_recall` 走向量+BM25 融合排序（0.6 余弦 + 0.4 归一化 BM25），并补充"无词面命中但语义相近"的文档。

- 全程 fail-open：Ollama 不在线 / 超时 / 非 2xx → 自动降级回纯 BM25，写入与查询不受影响（`devmemory_status` 与 boot 块可见降级标注）。
- 自动兼容新旧 API：先试 `/api/embeddings`，404 时回退 `/api/embed`。
- 语义补漏有规模保护（向量文件 ≤ 2000 时才全量余弦扫描，更大只融合 BM25 命中）。
- 本机无 Ollama 时无需任何配置——默认关闭就是纯 BM25。

## 只读 WebUI 面板（v0.3）

web 会话（运行 DSH Web GUI 的进程）里，插件自动在宿主 webServer 注册只读面板路由：

```
http://127.0.0.1:<gui端口>/dev-memory/        # 面板首页（自包含静态页，无外部资源）
http://127.0.0.1:<gui端口>/dev-memory/api/status   # 库状态 JSON（层统计/scope/VCS/向量/digest/诊断计数）
http://127.0.0.1:<gui端口>/dev-memory/api/search?q=..&layers=l1,l2,l3&maxResults=10  # 检索 JSON
http://127.0.0.1:<gui端口>/dev-memory/api/diag     # 诊断汇总 JSON（v0.4，只读）
```

- **纯只读**：没有任何写端点；页面检索走 `touch:false`，不提升 L3 活跃度、不改写文件、不产生 git 待提交。
- headless 会话（无 webServer）自动静默跳过，不影响主链路；面板注册失败也只是少一个入口，永远 fail-open。
- 面板用途：不启新会话也能自查记忆库（状态速览 + 跨层检索）。
- **入口（v0.5）**：GUI 本身没有全局导航链接到 `/dev-memory`（v0.3 已知限制），v0.5 起从 **DSH 设置 →「记忆管理」** 页的「打开记忆面板」按钮直达，也可直接在地址栏输入 URL。`webui.enabled=false` 会摘除路由（设置页实时生效）。

## 设置页「记忆管理」（v0.5）

插件把 WebUI 功能与可调参数接入 **DSH 设置体系**（参考 dshmarket 等已安装插件的做法，`@deepseek-ai/dsh-settings` 的 `installSettingsSection` 机制）：

- **DSH 设置 →「记忆管理」**（`settings.section` 独立选项页，**v0.5.3 起为插件参数唯一编辑面**）：页面顶部提供「打开记忆面板」入口，下方是完整可编辑表单（参数只出现一次）。**v0.5.4 起移除页面顶部的「记忆库状态」卡**——其状态行（版本回溯/检索/诊断记录）与表单开关主题重合、造成"参数重复"观感；库状态（库根/粒度/条目/VCS/检索/诊断计数）回归只读面板 `/dev-memory/` 查看，设置页保持纯参数编辑面。
- v0.5.0–0.5.2 还曾在 **设置 → 插件 → 可配置** 选项卡内注册同一组参数的可折叠卡片（`settings.plugin.item`），与独立页功能重复、参数两处可见；**v0.5.3 起删除卡片槽位**，参数只在独立页一处编辑（v0.5.2 给卡片做的 `--dsw-alias-*` 主题对齐已并入独立页/表单样式）。
- 表单写的字段存入 Host 设置文档（用户层覆盖组成层 entry 配置），**多数参数实时生效**（`onChange` live 应用：面板开关摘除/重挂路由，diag 开关/上限即改即用，nudge 开关启动/停止调度，vcs/embedding/digest/recall/预算按引用读取即时生效）；`storageDir` / `scope` / `workspaceDir` 属启动期库根绑定，重启后生效。
- 无 settings 服务的环境（headless）自动跳过整个桥，插件行为与旧版完全一致（fail-open）。
- 客户端 bundle（`client/client.js`，tsdown 构建，`dsh.client` 声明）仅在 web GUI 内加载；headless 不加载、零开销。

## scope：user 全局库（v0.3）

`scope: 'user'` 把记忆库从"每工作区一库"切换为"**全局一库**"（默认 `~/.memory`，可用绝对 `storageDir` 覆盖位置），所有工作区的会话共享同一份三层记忆：

- 基准目录切换为**用户主目录**；相对 `storageDir` 基于主目录解析，绝对路径仍原样。
- user 粒度**绝不改写工作区 `.gitignore`**（库在工作区外）；VCS、pack、embedding 等其余机制不变。
- boot 块与状态（`devmemory_status.scope`）标注"全局库"，面板同样显示。

## 工作区根解析（v0.3.1）

`scope: workspace` 时记忆库的"工作区"按会话**真实工作区根**（DSH 规范字段 `agent.session.header.cwd`）解析，不再假设进程 cwd（旧行为：web GUI 进程 cwd 恰为用户主目录时，库会落到 `~/.memory` 而非工作区）：

```
workspace 根 = config.workspaceDir（非空，显式固定）
            ?: 会话 header.cwd（agent/created 边绑定；pre-step / turn-stopping 按 payload.agent 复绑）
            ?: process.cwd()（headless / 无会话信息回退）
```

- 不同工作区的会话自动落到各自的 `<工作区>/.memory`（每工作区一库）；库根随会话切换，工具/WebUI 面板按请求时的工作区动态解析。
- headless（无会话或会话无 header.cwd）保持旧行为（进程 cwd 基准），完全向后兼容。
- 需要把库钉死在某个目录（如多工作区共存同一库）用 `workspaceDir` 绝对路径。

> ### ⚠ 事件勘误（v0.6.5）：`agent/session-start` **确实存在**
>
> v0.6.4 曾把"库根跑偏"的根因判定为「DSH 不存在 `agent/session-start`，误监听不存在的边导致死代码」。**这个论断是错的**，v0.6.5 已核实并纠正（本地 DSH `0.1.5-rc.2` 源码）：
>
> | 证据 | 位置 |
> |---|---|
> | cordis `Events` 显式声明 `'agent/session-start'(payload: { agent, source: SessionStartSource })`，`@mode emit` | `dsh-agent/lib/types/runtime-types.d.ts` |
> | 真实发射：`emitAgentEvent(loopCtx, agent, "agent/session-start", { source })`，紧随 `agents.announce(agent)`（即 `agent/created`）之后 | `dsh-agent-loop/lib/index.js` |
> | scope 分发表含 `"agent/session-start"`（agent 作用域分发） | `dsh-scope/lib/invariant.js` |
> | `SessionStartSource = 'startup' \| 'resume' \| 'clear' \| 'compact'` | `dsh-agent/lib/types/*.d.ts` |
>
> 而 **`agent/created` 的 payload 只有 `{ agent }`，没有 `source`**（source 只属于 `session-start`）。
>
> **结论与处置**：
> 1. 绑 `agent/created` 功能上仍可行（同一 agent、相邻发射），所以 v0.6.4 **确实修好了**库根跑偏——但真正起作用的是同批改动里的「**`workspace` 自动解析不再在 apply 期按进程 cwd 急切建库**」+「`pre-step`/`turn-stopping` 按 `payload.agent` 复绑」，而不是"事件不存在"。
> 2. v0.6.5 起**两者兼听**（同一 handler + 幂等守卫，任一版本只发其中一条也能工作），并真正用上 `source`：`clear` / `compact` 时上下文已被重置或压缩 → **重装会话视图并允许再补注一次**（Hindsight 只注一次、压缩后只能靠模型自己调 reflect 找回；我们用 `source` 把这一步自动化）。
> 3. 绑定 `agent/created` 时记为"临时"，随后 `session-start` 到达只**升级记录真实 source**（不重复装载视图/补做/补交），并落一条 diag，便于在真实环境核对 DSH 各版本的事件语义。
>
> **v0.6.4 修复（保留，仍有效）**：v0.6.3 及以前按 `process.cwd()` 建库（web 服务 cwd 非会话工作区时，记忆全部写入"跑偏"的空库）。v0.6.4 的三条改动：①会话启动边绑定库根 + 装载 L1 回放/L3 top-k + subagent 视图继承 + digest 补做 + 未提交写入补交；②`agent/pre-step` / `agent/turn-stopping` 按 `payload.agent` 的会话 cwd 复绑库根（多工作区并存、插件热重载后首个步骤也不串库）；③`workspace` 自动解析不再在 apply 期按进程 cwd 急切建库（`workspaceDir` 钉死 / `scope:user` 仍立即绑定）。

## 注入瘦身（v0.6.6）

v0.6.5 把召回内容改成"每会话一次"后，实测仍有三个浪费点，v0.6.6 逐条修掉：

| 问题（实测） | 处置 |
|---|---|
| **L3 top-5 用不到还占预算**：48 条 L3 里 20 条 `salience` 已达 1.0，`salience desc, accesses desc` 实际由历史访问次数决定 → 选出的清一色是 8/28 的老发版记录；5 条合计 **922 tokens > 800 预算**，整块被从块尾砍掉一条（`render.ts` 的 `clampTokens` 只从尾部截） | 新增 **`l3Inject`**（默认 `off`）：默认**不注入** L3，需要时由模型 `devmemory_recall` 按需查——与 L2 同一策略。可选 `salience`（旧行为）/ `query`（用会话首条消息跑 BM25，只注入分数达 `recall.highScore` 的命中，`devmemory_recall` 同一套索引） |
| **单条摘要无长度上限**：一条 277 tokens 的条目独吞 35% 预算 | `renderSpaceBlock` 逐条先将摘要钳制到 **140 tokens**（超长加 `…`），整块不再因单条超长而截断 |
| **L1 回放把模型已有的内容念一遍**：L1 块 **1481 tokens**，大头是本会话自己的 user prompt 原文回放 | `dropReplayedPrompts`：剔除"此刻已在上下文里"的流水（等值或 500 字截断前缀），只留跨会话流水；整块剔空则不注入该块 |
| **L1 标题取错行**：原取 `raw.split(/\r?\n/)[0]`，实测取到被截断的 prompt 行（注入里出现 `## - user: …` 畸形标题） | 显式找 `# ` 头（`runtimeHeadingOf`） |
| **块之间互相挤占**：各块只有独立预算，排前面的块能吃掉整个视图预算（L1 超额的 281 tokens 直接压掉 L3） | 新增 **`maxViewTokens`**（默认 2000）全局预算，按 状态 → L1 → L3 顺序扣减剩余额度（`takeWithinBudget`） |
| **`clampTokens` 在短文本上死循环**（既有缺陷，被本轮测试暴露）：预算小于截断标记开销时 `Math.max(1, floor(len*0.8))` 会原地踏步 | 每轮至少少 1 字符（`clampTokens` / `clampEntrySummary` 同修） |

> L3 仍然可用、可写：只是默认不再"无差别地推进 prompt"。要恢复旧行为：设置页把「L3 长期事实注入」改为 `按 salience 取 top-5`，或在 `cordis.patch.yml` 里设 `l3Inject: salience`。

## 工具瘦身与注入精修（v0.7.0）

v0.6.6 之后做了一次**真实计费口径的实测**（成本台账 `cost-meter/ledger.json` + 会话日志逐条解析，窗口 = 33 会话 / 1188 次模型调用 / 1.76 亿上下文 tokens），据此做了四件事：

| 实测问题 | 处置（v0.7.0） | 效果 |
|---|---|---|
| **工具 schema 占插件开销 ~99%**：12 个 `devmemory_*` = **2081 tokens/调用**，且 DSH 每次请求都带全部 tools；7 个低频运维工具 3 天里只用了 12 次 | `toolsProfile: 'core'`（默认）：合并为 `devmemory_admin`（`op` 分发）+ 全部描述精简；`full` 保留 12 个独立工具 | core 面 **943 tokens/调用（-55%）** |
| **子代理白付注入**：28 个子代理会话（274 次调用）一次都没用过记忆工具，却各自继承一份视图 + 召回提醒 | `subagentInject: false`（默认）：子代理保留工具与静态 boot 协议，不再自动注入视图/提醒 | 每个子代理会话省一次视图注入 |
| **L1 回放切半句**：`clampTokens` 按字符砍，注入尾部出现 `Agent 98cd6262-… ` 这类残行；且单条长 prompt 能吃掉整块预算 | `clampLines` 按**整行**截断并标注省略行数；`summarizeRuntimeLine` 逐行摘要（`l1MaxCharsPerLine`，默认 160 字） | markdown 结构始终完整；长 prompt 不再独吞预算 |
| **BM25 排序失真**：查 `dsh-plugin-memory-3t 架构设计 三层记忆 实现细节`，首位命中是《DSH 浏览器卡顿排查》——长文只要反复出现 `dsh` 就能靠 tf 累积取胜 | 检索分改为 `BM25 × 覆盖率 × 标题命中`（`coverageBoost` / `titleBoost`，索引 `schemaVersion: 3` 带 `titleTf`） | 只沾一个高频词的长文被降权；标题就讲这件事的短文排前 |
| **注入依赖事件顺序**（headless 真机实测发现）：`agent/pre-step` 可能早于 `agent/created` / `agent/session-start` 触发，而视图只在启动边装载 → **单步会话整轮注入静默消失**（多步会话靠后续 pre-step 掩盖了这个问题） | `takeSessionViewInjection` 在视图缺失时按 `payload.agent` 的会话工作区**就地懒加载**；启动边之后的重装保留已注入标记（`keepInjected`），避免重复注入 | 注入不再依赖事件顺序；根会话判定改为多信号（`delegationDepth` / `origin` / `parentSession`）且空串按根会话处理 |

> 版本回落开关：`toolsProfile: 'full'` + `subagentInject: true` + `l1MaxCharsPerLine: 0` 即回到 v0.6.6 的注入/暴露行为（检索分改进无法关闭——它是纯排序质量修复，索引会自动重建）。

## 诊断与异常记录（v0.4）

插件在**每次记忆管理调用**时自动记录两类内容到 `<库>/diag/events.jsonl`（默认开，`diag.enabled=false` 可整体关闭）：

- **`error`（调用异常）**：`devmemory_*` 工具执行抛错（含工具名、参数摘要、错误信息、堆栈）、digest 失败待补做、记忆库初始化失败等。
- **`unexpected`（不符合预期的行为）**：fail-open 降级路径（git 不可用、Ollama 未响应降级 BM25、会话视图装载降级）、恢复无变更、nudge 发送失败、WebUI/skill 注册失败等。

使用一段时间后（积累到一定量），用 `devmemory_diag` 审查：

```
模型：devmemory_diag              # summary：分级/分工具/分来源统计 + 最近事件 + 本进程工具使用次数
模型：devmemory_diag(action="list", level="error", tool="devmemory_recall", limit=20)  # 明细
模型：devmemory_diag(action="clear")  # 清空记录，开启新一轮观察窗口
```

- `devmemory_status` 与 WebUI 面板也会展示诊断计数与最近 5 条；boot 块在**存在记录时**附加一行提示（`devmemory_diag` 查看）。
- 记录**不入 git 历史**（库内 `.gitignore` 忽略 `diag/`）、**不随 pack 迁移**（可重建的操作数据）；`maxEvents` 默认 2000 条，超过 2 倍上限自动压缩只保留最新。
- 防敏感：工具参数摘要截断（字符串参数 ≤ 60 字符），不会把完整记忆内容整段落盘。
- 使用场景：插件用久了之后，先 `clear` 开一个干净观察窗，用一段，再 `summary`/`list` 看"哪个工具最容易出错、哪些降级路径高频出现"，据此优化插件或调整配置。

## 冷启动 seed（v0.6.5）

新工作区的记忆库是空的——这是本插件相对 Hindsight 最大的能力缺口（Hindsight 会用 git 历史 + LLM codebase survey 自动建库）。v0.6.5 补上了**无 LLM 版**：

```
模型：devmemory_seed              # 库为空（会话状态块提示"冷启动"）时生成项目骨架
模型：devmemory_seed(force=true)  # 覆盖重建已有骨架
```

- **只读确定性信号**：git 提交历史（最近 `seed.gitCommits` 条）/ `package.json`（名称·说明·scripts）/ README（首行 + 1–3 级标题）/ 顶层目录与文件（剔除 `node_modules`/`dist`/`.git` 等噪声与隐藏项）。**零依赖、零成本、同输入同输出**。
- **产出**：`<库>/docs/project/overview.md`（L2 检索层：按需 `devmemory_recall`，**不**注入 prompt）。
- **纪律：不自动写 L3。** Hindsight 用 LLM 自动抽取入长期记忆（语义更强，也更容易把推断当事实写进去）；我们只产出**候选 L3 清单**随工具结果返回，**确认后**才由模型 `devmemory_remember` 提升。这是有意的分歧点：L3 只放已确认的事实。
- **幂等**：骨架已存在则不覆盖（`force: true` 才重建），避免冲掉后续人工补充的内容。
- **自动模式**：`seed.auto: true` 时，会话启动发现库为 `empty` 就自动 seed 一次（复刻 Hindsight 的零配置体验）；默认 **false**，因为我们坚持"写库是显式动作"，由 skill 在空库时引导模型调用。
- 全程 fail-open：git 不可用 / 无 README / 无 package.json 只记入结果的 `skipped`，不影响其余信号。

## 三态可用性与写入守卫（v0.6.5）

**三态可用性**（`availability`）——把"空库"和"库坏了"分开，避免降级被误读成"没有记忆"：

| 状态 | 含义 | 行为 |
|---|---|---|
| `ok` | 有内容 | 正常 |
| `empty` | 已初始化但为空 | 正常（提示可 `devmemory_seed` 冷启动） |
| `unavailable` | 初始化/读取失败（**降级**） | boot 块**每请求**附一行告警 + 会话状态块显式说明"本轮未注入记忆，读到的'没有相关内容'不代表历史里没有" + diag 记 `error` |

（对照 Hindsight 的"冷库/热库/服务不可达"三态判定：单一布尔会把"服务抖动"当成"已建库"从而永久静默跳过建库。我们用三态避免反向的错误——把故障当成空库。）

**库根来源守卫**——`scope: workspace` 且既没有 `workspaceDir` 固定、又拿不到 `session.header.cwd` 时，库根只能是"进程 cwd 推导"的**不可信来源**（v0.6.3 库根跑偏正是这样发生的）：

- **拒绝写入**（`devmemory_remember`/`note`/`link`/`forget` 及内部流水写入全部被拒，并给出可读错误 + diag `unexpected`）；
- **读取与检索不受影响**（fail-open：仍然不打断会话）；
- 解除方式：设置 `workspaceDir` 钉死库位，或改用 `scope: user`。
- 形状上对应 Hindsight 的 `HINDSIGHT_MCP_HARNESS` 缺失即**拒绝启动**（"错误答案会污染数据，宁可拒绝"）——我们拒绝的是写，不是启动，因为我们的读路径不会污染数据。



## MCP stdio 面（v0.6.5，跨 agent 可移植）

`devmemory_*` 工具同时以 **MCP（Model Context Protocol）stdio server** 暴露，任何支持 MCP 的编码 agent（Claude Code / Codex / Cursor / …）都能直接使用**同一份本地记忆库**——补齐了对照 Hindsight（18 种 agent + MCP）最大的可移植性缺口。

```bash
dev-memory-mcp --root D:/my/repo                    # 随插件安装的 bin
DEV_MEMORY_ROOT=D:/my/repo dev-memory-mcp --storage-dir .memory --scope workspace
```

- **手写 JSON-RPC 2.0，零依赖**：**刻意不引入 `@modelcontextprotocol/sdk`**（那正是 Hindsight 的依赖之一），以保住"零运行时依赖"这一核心定位。
- **方法**：`initialize`（回显客户端 `protocolVersion`，缺省 `2025-06-18`；`capabilities.tools` + `serverInfo` + `instructions`）、`ping`、`notifications/initialized`（静默、不应答）、`tools/list`（`{name, description, inputSchema}`，一律 object-rooted）、`tools/call`（`{content:[{type:'text',text}], isError}`）。
- **错误语义分界（有意区分两层）**：协议层失败 → JSON-RPC `error`（未知方法 `-32601` / 参数或工具名非法 `-32602` / 内部错误 `-32603` / 坏行若能恢复出 id 则 `-32700`，否则忽略并写 stderr，**进程不死**）；**工具业务失败 → JSON-RPC `result` + `isError: true`**（MCP 惯例：工具错误是模型可见的数据，不是协议故障）。
- **配置**：`--root` / `DEV_MEMORY_ROOT`（默认 cwd）、`--storage-dir` / `DEV_MEMORY_STORAGE_DIR`（默认 `.memory`）、`--scope workspace|user`、`--no-vcs`、`--vcs-branch`、`--embedding`、`--tools core|full`（v0.7.0，默认 `full`——MCP 客户端看不到本插件的 boot 块与 skill，逐工具粒度更稳；想让对方模型少带 ~1.1k tokens/调用时用 `--tools core`）、`-h/--help`；`--flag=value` 与 `--flag value` 都支持；退出码 0/1/2。
- **stdout 只走协议**（日志与诊断一律 stderr）；换行分隔 JSON、请求串行处理；stdin EOF → 排空队列 → `flushVcs` → 退出 0。
- **与 DSH 面同源**：复用同一 `MemoryStore` + `createTools`，工具文本由各工具自己的 `output.render` 产出，因此两个面输出逐字节一致。
- **边界**：MCP 面没有 DSH 会话，故库根必须由 `--root`（或 `DEV_MEMORY_ROOT`）**显式给出**——这正是"库根来源守卫"在会话面要求的同一件事，在 MCP 面变成了必填参数。会话视图注入、pre-step 提醒、WebUI/设置页等 DSH 专属能力不在 MCP 面（MCP 只暴露工具）。
- 测试：`test/mcp.test.mjs` 以**真实管道** spawn 服务器跑 8 个集成用例（initialize / tools.list / 只读 call / remember→recall 往返 / `-32601` 与坏行存活 / 通知不应答 / env 与 flag 解析 / 业务失败 `isError` 与未知工具 `-32602`）。
  > ⚠ 沙箱提示：该用例需要"允许管道 stdio spawn 子进程"的环境。在 DSH 文件沙箱（read-only / workspace-write）下 `child_process.spawn` 抓管道会 `EPERM`（已文档化的沙箱边界），此时这 8 例会失败而**非**代码缺陷；在普通 shell/CI 下全绿。

## 迁移（pack/unpack，v0.2）

记忆库是可移植的纯文件集，`dev-memory-pack` CLI（随插件安装，零依赖）打包为单文件 `.dmmem`（gzip JSON），可拷到任何机器解包：

```bash
dev-memory-pack pack .memory --out backup-2026-08.dmmem   # 打包
dev-memory-pack unpack backup-2026-08.dmmem D:/workspace/.memory  # 解包
```

- 打包内容：三层 markdown + `meta.json` / `audit.jsonl`（操作追溯）；**排除** `.git`、`index.json`、`vectors/`（不可移植/可重建的派生物）。
- git 历史不随包迁移（与"误删 .git"同语义）；解包后下次插件启动自动 init 全新仓库。
- 解包防逃逸：档案内 `..` / 绝对路径 / 空段一律拒绝。

## 开发

```bash
npm run typecheck     # tsc --noEmit（服务端） + tsc -p tsconfig.client.json --noEmit（客户端）
npm run build         # 服务端 dist/
npm run build:client  # 客户端 bundle → client/client.js（tsdown，__ModuleLoader__ 工厂产物）
npm test              # build + node --test（Windows 沙箱下用 --test-isolation=none / --test-concurrency=1）
```

（常规环境 `npm test` 直接可用；沙箱限制已内置进 script。客户端源码在 `src/client/`，仅类型引用 `@deepseek-ai/dsh-client-*`，产物只外部化 `react` / `react/jsx-runtime`。）

## 真机验证（2026-08，headless 实跑）

经 `dsh plugin --profile <name> add <tarball>` 安装后实测（真实 LLM 调用，非 mock）：

- **写入链路**：引导模型调用 `devmemory_remember` → L3 条目落盘（frontmatter 含 id/kind/salience/tags）→ `devmemory_status` 返回库状态；L1 流水同步记录 user 消息。
- **回忆链路**：全新会话提问 → 模型经 `devmemory_recall` 命中 L3，条目 `accesses` +1、`salience` 提升（touchEntry 生效）。
- **运行期修复**：`output.render` 必须返回 ContentBlock 数组（`[{type:'text',text}]`）而非字符串——字符串会让文本模型（如 deepseek-v4-flash）的消息图像投影在 tool-result 嵌套 content 处抛 `content.some is not a function`（详见 `docs/team/TL-NOTES.md` 第 7 节）。单元测试已加回归断言。
- **version 回溯链路**（v0.2）：remember → 防抖自动提交 → forget → restore 闭环 → recall 命中；本机 git log 实录 5 条提交（init / auto 合并 / forget / restore / touch），详见 `docs/team/TL-NOTES.md` 第 8 节。
- **embedding / pack**（v0.2）：本机无 Ollama 服务，embedding 用可注入 fetch 的 mock 全覆盖（成功 / 404 回退新 API / 网络失败降级 / 语义补漏 / 融合重排 / 禁用短路 6 路）；`dev-memory-pack` CLI 实测 pack→unpack 往返（单文件 `.dmmem`，派生物排除）。有 Ollama 的环境可直接开 `embedding.enabled` 走真机链路。
- **v0.3**：scope:user 全局库（homedir 解析 + 不碰工作区 .gitignore，真机建库验证）；restore 整库时间片（真实 git 一次反转到快照：删的回来、新增的消失）；subagent 视图继承（生命周期事件实测）；recallNudge 调度（随机区间 + 每会话一次钳制）；WebUI 只读面板（路由分派 / touch:false 只读 / 404/405 全单测，真实 HTTP 面待 web GUI 重启后打开 `http://127.0.0.1:<端口>/dev-memory/` 核对）。
- **v0.4（诊断与异常记录）**：工具调用异常 → `diag/events.jsonl` 自动落盘（工具名/参数摘要/堆栈）+ 生命周期/降级路径入记 + `devmemory_diag` 汇总/明细/清空 + status/boot/WebUI 都带诊断计数；压缩上限、禁用开关、参数脱敏全单测覆盖。
- **v0.5（设置页 + GUI 入口）**：路由实测 200 正常、原不可见是"GUI 无导航入口"而非 bug；按 dshmarket 模式接入 DSH 设置体系——服务端 `installSettingsSection` 注册 `dev-memory` 设置 namespace（schema 覆盖 WebUI 与参数，写入 Host 设置文档、`onChange` live 生效），客户端 tsdown bundle 贡献设置页「记忆管理」（独立选项页：打开面板入口 + 库状态卡 + 完整表单，WebUI 开关可实时摘挂路由）与插件可配置卡片；headless 零开销 fail-open。安装副本验证：dist 含 settings.js、client/client.js 携带 `__ModuleLoader__` 工厂、dsh.client 声明就位。设置页真实 GUI 面待重启后打开 设置→记忆管理 核对。
- **v0.5.2（卡片手风琴化）**：插件可配置卡片由"默认展开的散放表单"改为与内置 PluginCard 一致的可折叠手风琴——头部（标题 + 描述 + 展开箭头 + 未保存徽标）点击展开才是表单，折叠不丢草稿；表单/卡片全部改用 `--dsw-alias-*` 主题令牌（此前混用自定义变量）。134 项单测（0 skip） + client typecheck + tsdown 构建通过后打包重装 headless/web 两 profile（version 0.5.2、client/client.js 携带 handshake 与手风琴结构）；发布包统一归档 `.memtest-pack`。真实 GUI 面对照插件市场卡片样式核对。
- **v0.5.3（设置面去重）**：按用户验收——**删除「插件配置」选项卡内的可配置卡片**（`settings.plugin.item` 槽位与独立页功能重复、参数两处可见），「记忆管理」独立页（`settings.section`，打开面板 + 完整表单）成为参数唯一编辑面（单份 SECTION_FIELDS 表单）。移除 card.tsx + card 专用 locale（cardTitle/cardDesc/cardNote/expand/collapse），client bundle 29.7kB→25.1kB；134/134 单测全绿 0 跳过 + client typecheck + tsdown 构建后打包重装 headless/web 两 profile（version 0.5.3），归档 `.memtest-pack`。GUI 核对点：设置→插件→插件配置 无「记忆管理」卡片。
- **v0.5.4（独立页纯参数面）**：用户反馈"记忆管理页面仍存在参数重复"——定位到独立页顶部的「记忆库状态」卡（版本回溯/检索/诊断记录状态行）与表单开关主题重合。**移除状态卡**（含 status fetch 与 status*/state* locale 键），库状态信息回归只读面板 `/dev-memory/`；client bundle 25.1kB→19.6kB；134/134 全绿 0 跳过。GUI 核对点：设置→记忆管理 顶部无状态卡。
- **v0.5.5（表单组首字段重复渲染修复·真正根因）**：按用户截图与逐行转录定位——「记忆管理」页每个**分组的第一个参数**出现两次（启用面板/启用诊断记录/启用主动追忆/启用 git 回溯 ×2，同组第二个字段如事件保留上限 ×1），根因在 `form.tsx` 渲染循环：分组标题条目 `rendered.push({ header: groupLabel(field.group), field })` 把**组内首个字段一并推入标题条目**，随后 `rendered.push({ field })` 又推一次——该 bug 自 v0.5.0 引入，用户报"参数 2 次"的真正来源（v0.5.3/0.5.4 的卡片与状态卡是表面现象）。修复：标题条目只携带 header 不带 field（`rendered.push({ header })`），渲染处 `field !== undefined` 才渲染字段行；bundle 19.6kB；134/134 全绿 0 跳过 + typecheck + tsdown 后打包重装 headless/web（0.5.5，归档 `.memtest-pack`）。GUI 核对点：每个参数只出现一次、分组标题一次。

## 已知限制（v0.2）

- **确定性 digest（不调用 LLM）**：沉淀只处理"显式记忆词"的候选（记住/记一下…），精细沉淀依赖模型显式调用 `devmemory_remember` / `devmemory_note`（skill 引导）。模型不可用时的兜底是可靠的，但不是智能提炼。
- **embedding 依赖本机 Ollama**：默认关闭；开启后 L2/L3 写路径调本地 Ollama（endpoint/model 可配），Ollama 不在线自动降级回 BM25（fail-open，`devmemory_status` / boot 块可见）。向量与 index.json 同为可重建派生物（`vectors/` 不入 git）。
- **recallNudge 依赖 agent.followup**：开启后按 30–240 分钟随机间隔对根会话发一次 followup 提醒（会唤醒一轮模型调用，默认关、每会话至多一次；文案标注"非用户输入"）。不想要任何主动消息就保持默认关。
- **WebUI 面板仅 web 会话可用**：headless 无 webServer 自动跳过；面板按 loopback 只读服务设计，不提供鉴权（本地可信环境）。GUI 无全局导航入口（v0.3 遗留）：从设置页「记忆管理」的按钮或地址栏直达 `/dev-memory/`；关闭 `webui.enabled` 后路由摘除（设置页实时生效）。
- **索引阶段性近似**：写入只标记脏、不实时更新倒排；写入次数超 `index.rebuildAfterWrites`（默认 50）后再查询会重建。写入后的新内容在下一次重建前可能查不到（digest 去重不受影响，走扫描式比对）。
- **git 依赖**：版本回溯需要系统安装 git（`restore` 要求 ≥ 2.23）；git 缺失/不可用时自动降级，记忆读写不受影响。git 冷启动较慢（Windows 上单次操作可达秒级），提交在后台防抖合并执行，不阻塞会话。
- **单写多读**：同一 `.memory` 建议单进程写入；多 DSH 实例共享一库时 L1 append 与 git 提交可能交错（v0.1 遗留，v0.2 未做分布式锁）。
- **`.memory/.git` 被误删 / 分离 gitDir 丢失**：版本历史丢失，但 audit.jsonl（操作追溯）仍在；重新 init 会建新仓库。恢复语义依赖 git 历史，破坏后无法回溯。
- **pack 不含 git 历史**：`.dmmem` 只迁移内容 + audit；历史需在源库保留或另行用 git 迁移。
- **workspace 根 = 会话真实工作区**（v0.3.1）：按 `agent.session.header.cwd` 解析（回退 `config.workspaceDir` 固定值 → `process.cwd()`）。web GUI 会话的库落在其工作区；headless 保持进程 cwd 行为。多工作区并存时各会话各自建库。
- **pre-step 提醒**：每会话 ≤ 2 次，命中"还记得/上次/之前"等触发词才提示；只提醒不代查。
- **诊断记录（v0.4）**：`diag/` 是操作级记录（异常/不符合预期），**不入 git、不随 pack 迁移**；`devmemory_diag(action="clear")` 清空后无回收（建议开启新一轮观察前再用）。本进程工具调用次数（usage）是内存态，重启清零；异常明细是落盘的、可跨重启追溯。
- **subagent**：从父会话继承 L1 回放 / L3 top-k 视图（v0.3，`agent/created` 时按 `parentSession` 继承；展示与父视图一致）。
- **权限**：目录/文件按 0o700/0o600 设置；Windows 无 POSIX 权限语义，权限位在 Linux/macOS 生效。
- **Windows 路径**：路径断言在测试中用正斜杠归一；safeJoin 统一 anti-escape 校验（`..` 与绝对路径拒绝）。

## 路线图

- ✅ v0.2 完成：git 版本回溯（history/diff/restore）· Ollama embedding + 向量融合 · `pack/unpack` CLI · `gitDir` 分离仓库正式化 · 项目级 SKILL.md 覆盖示例
- ✅ v0.3 完成：只读 WebUI 面板（状态/检索）· `scope: user` 全局库 · subagent 视图继承 · restore 整库时间片 · `recallNudge` 实现（默认关）
- ✅ v0.3.1 完成：workspace 根按会话真实工作区（`session.header.cwd`）解析 + `workspaceDir` 覆盖项——web GUI 会话的记忆库正确落在工作区而非进程 cwd 目录
- ✅ v0.4 完成：诊断与异常记录（DiagLog）——工具调用异常 / 生命周期失败 / 降级路径自动记入 `<库>/diag/events.jsonl`，`devmemory_diag` 汇总/明细/清空，status/boot/WebUI 均展示诊断计数，供使用一段时间后审查优化插件
- ✅ v0.5 完成：DSH 设置页「记忆管理」——WebUI 功能与参数接入设置体系（独立选项页 + 插件可配置卡片，`installSettingsSection` 机制、live 生效），面板获得 GUI 入口（解决"找不到 WebUI"），headless 零开销 fail-open
- ✅ v0.5.2 完成：可配置卡片改为与内置 PluginCard 一致的可折叠手风琴（头部标题+描述+箭头+未保存徽标，展开才是表单；主题全部切到 `--dsw-alias-*` 令牌，消除"随意摆放"样式）
- ✅ v0.5.3 完成：设置面去重——「插件配置」选项卡里的可配置卡片（`settings.plugin.item`）与「记忆管理」独立页功能重复、参数两处可见，故删除卡片槽位，独立页（`settings.section`）成为参数唯一编辑面；card.tsx 移除、client bundle 缩小（29.7kB→25.1kB）
- ✅ v0.5.4 完成：独立页纯参数面——移除页面顶部「记忆库状态」卡（状态行与表单开关主题重合造成"参数重复"观感），库状态回归只读面板 `/dev-memory/`；设置页只剩打开面板入口 + 参数表单，client bundle 再缩至 19.6kB
- ✅ v0.5.5 完成（参数重复真正根因）：`form.tsx` 渲染循环把分组标题条目与组内首个字段一起 push，导致每个分组的第一个参数渲染两次（v0.5.0 引入，前述"状态卡/卡片"皆为表面现象）；修复为标题条目只含 header、字段行单独渲染，每个参数只出现一次
- ✅ v0.6.0 完成（插件更名）：`dsh-dev-memory-3t` → **`dsh-plugin-memory-3t`**——目录与 git 仓库、package.json 包名、插件注册名（`src/index.ts` `name`）、设置 `settings.section` 插槽 id（`PLUGIN_ID`）、client bundle 标识、`cordis.patch.yml` id/name、安装命令与全部文档（README/DESIGN/team）同步更名；测试断言同步（`source.plugin`）；版本升至 0.6.0 打包归档 `.memtest-pack` 并重装 headless/web 两 profile（旧归档 `dsh-dev-memory-3t-0.*.tgz` 保留为历史产物）
- ✅ v0.6.4 完成（库根跑偏修复；**根因判定于 v0.6.5 被纠正，见上「事件勘误」**）：v0.6.3 及以前按 `process.cwd()` 建库（web 服务 cwd 非工作区即"跑偏"）。三条改动**确实有效**：①会话启动边绑定库根 + 装载 L1 回放/L3 top-k + subagent 视图继承 + digest 补做 + 未提交写入补交；②`pre-step`/`turn-stopping` 按 `payload.agent` 会话 cwd 复绑（多工作区不串库）；③`workspace` 自动解析不再在 apply 期按进程 cwd 急切建库。⚠ 但当时把根因写成"DSH 无 `agent/session-start`"是**错的**，随之写下的"事件清单不含 session-start"回归断言也是错的（v0.6.5 已改为断言**必须注册**）
- ✅ v0.6.5 完成（事件勘误 + 注入时机重构 + 三项借鉴）：**①事件勘误**——`agent/session-start` 真实存在（payload `{agent, source}`，`agent/created` 无 `source`），v0.6.4 的"不存在"论断纠正，改为**兼听两条边**（幂等 + created→session-start 的 source 升级记录）并用 `source` 处理 `clear`/`compact` 的重装补注；**②注入时机重构**——boot 块静态化（逐请求但逐字节恒定、不破坏 prefix 缓存），会话状态与 L1/L3 召回改为**每会话一次**注入（原为每请求重复，最多约 2600 tokens/轮）；**③三态可用性**（`ok`/`empty`/`unavailable`，故障 ≠ 空库）；**④库根来源守卫**（会话内无法解析真实工作区时拒绝写入、保留读取）；**⑤冷启动 seed**（`devmemory_seed`，无 LLM 从 git/README/manifest/目录生成 L2 骨架 + 候选 L3，不自动写 L3）；**⑥零依赖 MCP stdio 面**（`dev-memory-mcp`，手写 JSON-RPC，无 `@modelcontextprotocol/sdk`）
- ✅ v0.6.6 完成（注入瘦身）：**①L3 默认不注入**——新增 `l3Inject: off|salience|query`（默认 `off`），实测 48 条 L3 里 20 条 salience 已顶格、排序实际由历史 accesses 决定，选出的全是老发版记录且 5 条 922 tokens > 800 预算被整块截掉；**②`maxViewTokens` 全局预算**（默认 2000，按 状态→L1→L3 顺序扣减，防前块挤光后块）；**③L3 逐条摘要钳制 140 tokens**（单条不再独吞整块）；**④L1 回放去重**（剔除本会话自己的 prompt 回放，实测 L1 块 1481 tokens 大头是重复内容）+ 标题取值修复（原取第一行 → 注入出现 `## - user: …` 畸形标题）；**⑤修 `clampTokens` 短文本死循环**（预算小于截断标记开销时 `Math.max(1, floor(len*0.8))` 原地踏步，v0.1 起潜伏）；设置页新增两项参数（下拉框字段类型）；176/176 测试全绿 0 跳过（含 git 集成 14 项 + MCP 8 项）
- v0.6（候选）：多库并存切换（named libraries）、recall 结果缓存与面板历史、scope 迁移工具（workspace→user 搬家）

## License

MIT