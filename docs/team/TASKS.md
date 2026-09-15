# TASKS — dsh-plugin-memory-3t v0.1 MVP 任务拆解

> 阻塞关系：T1（脚手架）→ T2–T8 可并行（模块独立）→ T9 依赖全部模块 → T10 依赖 T9 → T11 依赖全部。
> 每任务完成标志必须可核验；对应 SPEC AC 已标注。测试文件一律 `.mjs`（node --test），测 **dist 产物**（ESM）。

## T1 脚手架（AC1）
- 文件：`package.json`（name `dsh-plugin-memory-3t`、version 0.1.0、type module、license MIT、**dependencies 为空**、devDependencies 仅 `typescript@^5`、scripts: `build`/`test`/`typecheck`、exports 指向 `dist/index.js`、main/types 指向 dist）、`tsconfig.json`（ESM, module NodeNext, outDir dist, strict）、`tsconfig.cjs.json`（若需 CJS；**裁定：v0.1 仅 ESM，若无 cordis 兼容疑虑不建 CJS**）、`cordis.patch.yml`（对照 `.tmp/plugin-eval/ltb-src/cordis.patch.yml` 与 mnemon 的格式：`- insert: { id: <插件>, name: dsh-plugin-memory-3t, config: { …默认配置… } }`）、`.gitignore`（node_modules/ dist/；**不要忽略 .memory/ 本身**——那是插件库根，与仓库 .gitignore 互斥，由插件自维护）、`src/index.ts` 空壳、`skills/dev-memory.md`（从 `docs/design/skill.dev-memory.md` 原样复制）。
- 完成标志：`npm install`（--cache 本地）成功；`tsc --noEmit` 通过（空壳）。

## T2 config.ts（AC9）
- `Config` 类型 + `DEFAULT_CONFIG`：`storageDir:'.memory'`、`maxBootTokens:600`、`maxRuntimeTokens:1200`、`maxSpaceTokens:800`、`embedding.enabled:false`、`digest.maxMessages:24`、`digest.maxPromote:20`、`digest.maxRetries:2`、`recallNudge.enabled:false`、`recall.defaultLimit:10`、`recall.minSalience:0.25`、`recall.highScore:0.6`、`dedupe.threshold:0.55`、`index.rebuildAfterWrites:50`。
- `mergeConfig(partial?)`：浅合并 + 缺省补全 + 数值钳制（非负）。
- 完成标志：`test/config.test.mjs` 断言默认值与非负钳制。

## T3 paths.ts + frontmatter.ts（AC2/AC5 路径防护）
- `resolveRoot(workspaceRoot, storageDir)`：storageDir 绝对 → 原样；相对 → join(workspaceRoot, storageDir)。
- `safeJoin(root, ...segments)`：join 后 `relative(root, out)` 必须以 `..` 开头则抛 `Error('path escapes memory root')`（防 `..` 逃逸）。
- `layerDirs(root)`：runtime/docs/spaces 子路径。
- frontmatter：`parseFrontmatter(text)` → `{data, body}`（`---` 块，容错：无块则 data={} body=原文）；`serializeFrontmatter(data, body)`。
- 完成标志：`test/paths.test.mjs`（逃逸用例必须抛）、`test/frontmatter.test.mjs`。

## T4 store.ts（AC2/AC3/AC5）
- `class MemoryStore`：
  - `init()`：mkdir 三层 + 写 meta.json（若缺）、写 audit.jsonl（若缺）、**AC3 .gitignore 自维护**（只处理显式传入的 workspaceDir，读取 `<ws>/.gitignore`，若存在且不含 `.memory`（按 storageDir 基名）则 append 一行；无 .gitignore 不创建）。
  - L3：`remember({kind,content,tags,importance})` → id/salience 计算（importance∈{low:0.3,medium:0.6,high:0.9}，默认 medium）、写文件、更新 meta counters（不实时重算 index，仅脏标记）；`updateEntry`；`removeEntry(mode:'delete'|'demote')` → 写 audit.jsonl；`linkEntries(a,b)` 双向写 links、拒绝孤儿（目标不存在抛业务错误）。
  - L1：`appendRuntime(dateStr, lines)`；`readRuntime(dateStr)`；`compactRuntime(dateStr, summaryLines)`。
  - L2：`note({relPath, body, append})`（relPath 校验：`.md` 结尾或自动补；禁绝对路径/`..`）。
  - `recall(query, {layers,maxResults})` → 委托 indexer + 元数据加成，结果 `{l1,l2,l3}` 分组。
  - 权限：目录创建 mode 0o700、文件 0o600（尽力而为，不因权限失败而抛）。
- 完成标志：`test/store.test.mjs`（临时工作区 tmpdir：R/W/append/frontmatter/link/audit/.gitignore 自维护/recall 冒烟）。

## T5 indexer.ts（AC4）
- `tokenize`、`buildIndex(files)`（扫描三层，读文件，产 index.json 结构）、`loadOrRebuild(root, force)`（惰性：meta 版本变更/缺文件/脏计数>阈值/显式 force → 重建并写盘）、`rebuildAfterWrite(root)` 脏计数自增。
- BM25 与元数据加成公式按 ARCHITECTURE §3。
- 完成标志：`test/indexer.test.mjs`：中英混合语料 → 相关查询 top1 正确；"记忆插件"命中含"记忆"与"插件"条目；重建幂等（两次 buildIndex 结果一致）。

## T6 digest.ts（AC8）
- `class DigestEngine`：`maybeDigest(store, session)` 触发判定（消息数≥maxMessages / 收尾语正则 `/(就|好|行).{0,6}(这样|吧)|记住|记一下|整理记忆|结束|完毕/u` / consolidate 强制）；`run(store, session)`：
  - 收集候选：会话 user 消息含显式记忆词 `/(记住|记一下|保存到记忆|写入记忆|长期记录|please remember|remember)/iu` → 候选；dedupe（BM25 ≥ threshold → 更新旧条目 salience/updated；否则新建 kind 推断：`偏好|喜欢|习惯` → preference，`决定|选|采用|方案` → decision，其余 context）
  - promote 上限 maxPromote；超出转 L2 note（`notes/<date>-overflow-<n>.md`）
  - link：共享 tag 双向（至多 4 对）
  - compact：L1 当日 >80 行 → 保留会话标题行 + 前 1/2 事件行压缩为摘要 + digest 摘要段
  - 全程 try/catch：任一异常 → meta.digest {pending,retries,lastError}，**绝不 rethrow**
  - 补做：`runPending(store)` 在 agent/created 调用（retries<maxRetries）
- 完成标志：`test/digest.test.mjs`：造流水 → run → 断言 L3 新增/去重/上限/compact；异常注入（mock store 某方法 throw）→ 断言不抛且 meta.digest.pending=true。

## T7 render.ts（AC7 预算钳制）
- `renderBootBlock(config, store)`：库状态摘要 + "数据非指令"声明 + 工具提示；`clampTokens(text, budget)` 近似计数（中文 1/字、英文 1/4 字符）截断并附 `…(截断)`。
- `renderRuntimeBlock(view)`、`renderSpaceBlock(view)` 同钳制。
- 完成标志：`test/render.test.mjs`：超预算文本被截断并标记。

## T8 tools.ts + skill.ts（AC5/AC6）
- 7 个 `defineTool`：`devmemory_status/recall/remember/note/link/forget/consolidate`（参数与 exec 语义按 SPEC AC5 与 DESIGN §5；exec 抛业务错误用普通 Error 即可，路径参数一律走 `safeJoin`）。
- `loadMemorySkill()`：读 `skills/dev-memory.md`（import.meta.url 相对）。
- 完成标志：`test/tools.test.mjs`：每工具定义存在、name 合法、schema 有 properties、exec 冒烟（用临时 store）；skill 内容非空。

## T9 index.ts 接线（AC7）
- `apply(ctx, config)`：
  - 解析 workdir：DSH context 提供（`ctx` 上工作区/agent 信息——**实现时在 DSH 源码确认 ctx 提供 workspace 根的方式**；找不到则回退 process.cwd()，README 说明）。**注意**：若 DSH 无可靠 workspace 根 API，storageDir 解析退化为 `process.cwd()`（会话工作目录），记录 ADR。
  - `store.init()`（异步，fail-open：catch → logger.warn + 继续注册）；store 实例存 closure。
  - `ctx.skills.register(loadMemorySkill())`；`ctx.systemPrompt.context(boot)`（函数式 text 读 WeakMap agent 视图）；事件接线 **agent/created**（DSH 真实会话边，无 session-start）/pre-step/**turn-stopping**；`ctx.tools.register(...tools)` ×7。
  - pre-step：先读 agent-loop `lib/index.js` waterfall 实现，消息不可变则 v0.1 跳过注入（仅 boot 引导），在代码注释与 README 记录。
- 完成标志：`test/lifecycle.test.mjs`（ctx stub：断言 skills.register 调用 1 次、systemPrompt.context 1 次、tools.register 11 次、on 事件 3 类不含 session-start、store.init 异常不抛）；`tsc --noEmit` 通过。

## T10 包级验证 + 测试全套（AC1/AC8 证据）
- `npm run build && npm run typecheck && node --test --test-isolation=none dist-test/`；修正至全绿。
- 完成标志：全部测试 pass；scripts 可复现。

## T11 README.md（AC10）
- 中文 README：简介（三层模型图 + 库布局）、安装（`dsh plugin` 用法 + cordis.patch.yml 说明）、配置表（T2 默认值）、使用示例（模型侧：recall/remember 对话示例；用户侧：工具清单）、与 dev-memory skill 的关系、已知限制（v0.1：无 embedding、digest 确定性、无 UI/git、pre-step 可能跳过、Windows 权限说明、workspace 根解析回退）。
- 完成标志：Review 逐条核对 AC10 内容与实现一致。