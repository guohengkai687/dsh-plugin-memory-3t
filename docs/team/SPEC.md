# SPEC — dsh-dev-memory-3t v0.1 MVP

> 来源：`docs/design/DESIGN.md`（§1–§10，初版生成时位于 `design/memory-3t/`）。所有 AC 必须**可测**。

## 背景与目标

DSH 本地三层记忆插件：插件管机制（存储/注入/检索/安全），skill 管协议（模型怎么用）。参考 Hindsight / OpenViking / dsh-mnemon / dsh-plugin-memory 四插件，收敛为本地零依赖方案。

## 范围

### 做
三层 markdown 存储、BM25 检索、7 个工具、内嵌 skill、生命周期接入、配置、文档、测试。

### 不做（v0）
向量 embedding（仅留开关位）、git 自动提交、pack/unpack、WebUI、多 provider、自动追忆。

## 验收标准（AC）

**AC1 包结构**：`package.json`（name `dsh-dev-memory-3t`、MIT、零 runtime deps、exports/type 正确）、`cordis.patch.yml`（bundle patch）、`tsconfig.json`、`src/`、`skills/dev-memory.md`、`test/`、`README.md`。
- 证据：文件存在且内容完整；`tsc --noEmit` 通过。

**AC2 三层存储**：默认库根 `<workspace>/.memory/`（config `storageDir` 可覆盖）；目录 `runtime/`（L1，`YYYY-MM-DD.md` 追加）、`docs/`（L2，支持子目录与 append）、`spaces/`（L3，frontmatter：id/kind/created/updated/salience/accesses/tags/links）；`meta.json`（schema version/开关/digest 状态）、`audit.jsonl`（forget 审计）。
- 证据：单元测试覆盖读写/追加/frontmatter 解析/元数据更新；权限测试（NTFS 尽力而为，POSIX 语义在代码中按 0700/0600 设置）。

**AC3 .gitignore 自维护**：初始化时若工作区 `.gitignore` 存在且未包含 `.memory/`，自动追加一行。
- 证据：单元测试（临时工作区 + 临时 .gitignore）。

**AC4 BM25 索引**：`index.json` 惰性重建（首次/版本变更/显式触发）；分词英文按词、中文 2-gram；查询返回按来源层分组、按 score 排序；支持 `layers?`/`maxResults?`。
- 证据：单元测试：写入多条双语内容 → 查询命中排序合理；中文词"记忆插件"能命中含"记忆"与"插件"的条目。

**AC5 7 个工具**：`devmemory_status / recall / remember / note / link / forget / consolidate`，全部经 `ctx.tools.register`（照 DSH 真实签名），带 schema；路径参数校验拒绝 `..` 逃逸。
- 证据：工具注册表测试（或模块级纯函数测试 + 注册调用存在性）；路径逃逸用例被拒。

**AC6 skill 注册**：`ctx.skills.register` name `dev-memory`，content 读自 `skills/dev-memory.md`，`invocation: { modelInvocable: true, userInvocable: false }`。
- 证据：代码审查 + 可选激活验证（QA 尽力而为）。

**AC7 生命周期**：
- `agent/session-start` → 装载 L1 近期回放（≤ maxRuntimeTokens）+ L3 top-k（≤ maxSpaceTokens），异步不阻塞；
- `system-prompt/assemble` → `ctx.systemPrompt.context({name:'dev-memory-boot', order:-200})` ≤ maxBootTokens；
- `agent/pre-step` → 高相关 L3 命中未注入且额度未耗尽（每会话 ≤2 次）时注入 `createPluginMessage(reminder,'instructions')`，否则不注入；
- `agent/turn-stopping` → digest（extract/dedupe/promote/link/compact）。
- 证据：单测覆盖每钩子的纯逻辑（预算计算/提醒决策/回放生成）+ 组装测试（可在无完整 DSH 环境时用轻量 ctx stub）。

**AC8 digest 沉淀**：触发条件（消息数 ≥ 24 / 用户收尾语 / `devmemory_consolidate`）；extract→dedupe（BM25 相似度阈值）→promote（事实→L3、背景→L2）→link→compact（L1 重写摘要）；**fail-open**：任一步异常不阻断，状态记入 meta.json，下次补做（≤2 次）。
- 证据：端到端单测：造流水 → 跑 digest → 断言 L3 新增条目、L2 新增笔记、L1 被压缩、重复内容被去重；异常注入测试证明不抛。

**AC9 配置**：`storageDir`（默认 `.memory`）、`maxBootTokens=600`、`maxRuntimeTokens=1200`、`maxSpaceTokens=800`、`embedding.enabled=false`（开关位）、`digest*` 参数、`recallNudge.enabled=false`（开关位）。
- 证据：默认值单测。

**AC10 文档**：README.md 中文：安装（cordis.patch.yml 用法 + `dsh plugin` 步骤说明）、配置表、使用示例（工具/skill 说明）、已知限制。
- 证据：文档存在、与实现一致（Review 核对）。

## 明确拒绝（打回标准）

- 该做的不做 / 做一半留 TODO 占位而无说明；
- 不按 DSH 真实接口签名写（架构/实现阶段必须对照 `E:\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\*` 源码核实，README 标注假设）；
- 测试不跑 / 跑不过还宣称完成；
- 路径无校验、fail-open 缺失（记忆故障必须不能打断会话）。