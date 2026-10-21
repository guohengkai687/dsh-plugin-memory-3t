# Changelog

本文件记录 dsh-plugin-memory-3t 的版本变更。版本号与 `package.json` / `src/shared.ts`
的 `PLUGIN_VERSION` 一致（`test/version.test.mjs` 断言），发版打 `v<version>` tag。

## v0.8.0 — 2026-10-21

审计（2026-10-21，对 `D:\DeepSeek\Harness\.memory` 与 `D:\GitLabCode\FlexOne014_master\.memory`
两个真实库的存储/用量取证）暴露的问题集中修复。**唯一破坏性变更**：索引快照
`schemaVersion` 3 → 4（序号倒排），旧 `index.json` 一律判废、下次访问自动重建，
无需手工迁移。

### B1（严重）多工作区串库：工具读写、boot 块、状态块按错误库根解析

- 现象（有实证）：同一 dsh 进程里 A/B 两个工作区交替使用时，B 会话的 `devmemory_recall`
  命中 A 工作区库的条目；B 会话的 `devmemory_remember` 把内容写进 A 工作区库
  （2026-10-12 14:42 的 `ctx-20261012-f6286829316` 落在 FlexOne 库，内容却是 Harness 的
  robocopy/junction 事故教训）；同一会话的 runtime-context 里「库根」在 seq=11/230/465 是
  Harness、seq=130/425 变成 FlexOne。
- 根因：`ensureStore()` 的 `active` 是**进程级**单值（进程最后绑定的那本库），而工具注册
  `createTools(() => ensureStore().store, ...)` 的 getter 不传调用方会话；boot 块又读全局
  `cachedStatus`——三者都跟着"最后绑定"走，不是跟着"是谁在调用"走。
- 修复：
  - `src/index.ts`：工具 getter 改签名 `(exec) => storeForCall(exec).store`，`storeForCall`
    从 DSH 宿主真实传入的 `exec.agent` 取 `session.header.cwd`，走
    `ensureStore(cwd, { sessionContext: true })`（同时吃到 v0.6.5 写入守卫）；无 `exec.agent`
    的路径（MCP `tool.execute(args, {})`、headless）保持旧回退。
  - `src/tools.ts`：`StoreGetter`/`EngineGetter` 接受 `exec`，`wrapDiag` 用
    `AsyncLocalStorage` 把"本次调用解析出的 store/engine"绑定到执行期，13 个工具主体无需改
    签名；`devmemory_admin` 分发到子动作同样继承绑定。
  - `src/render.ts`：boot 块改为**纯常量**（`renderBootBlock(budget)` 不再接收 status），
    删掉动态「库根」行与不可用告警；「库根」下放到每会话一次的 `renderStatusBlock`（那里的
    status 由该会话自己的 store 产出）。副作用：boot 文本不再随会话变化，前缀缓存更稳。
  - `src/index.ts`：删除全局 `cachedStatus` 与 `bootStatus()`（串根传播面），状态信息统一由
    会话视图承载。
- 回归：`test/lifecycle.test.mjs` 改为按 `exec.agent` 断言双工作区库根与写读闭环。

### F1 诊断噪声：正常生命周期探测被记成 unexpected

- 会话启动边 `agent/created`、`agent/created → agent/session-start` 升级是**正常**事件，
  却按 `unexpected` 落盘（两个真实库共 155 条，占全部事件的 99%），把真正需要看的降级记录
  淹掉。
- 修复：`DiagLevel` 增加 `'info'`；两类启动探测改记 `info`；`DiagCounters`/`byLevel`/WebUI
  徽章与计数卡、`devmemory_diag` 的 `level` 入参同步支持 `info`；状态块只在
  `error + unexpected > 0` 时报警。

### F5 历史噪声归正（不删证据）

- 已落盘的历史事件（`会话启动边=…`、`会话启动边升级：…`、`TEMP-DIAG …`）在读取时按
  `normalizedLevel()` 统一归为 `info`；`compact()` 重写文件时顺手改写级别。老库无需手工清理。
- 已删代码留下的 `TEMP-DIAG` 计数不再计入异常，清理后不会"复活"。

### F2 Windows 下 L2 笔记 docKey 分隔符不一致

- 索引侧用 `path.join` 产出 `l2:notes\x.md`，向量侧用 `l2:notes/x.md`，导致 embedding
  融合路径按 docKey 命中/去重对不上号（Windows 上向量检索对 L2 事实上失效）。
- 修复：`listMarkdownFiles()` 的相对键统一 posix 分隔符，三层 docKey 与向量文件键一致。

### F3 索引陈旧告警常驻 + `indexDocCount` 少报

- `index.json.dirty` 常驻时 `status()` 只读旧快照，于是状态块永久显示「索引快照与库内不一致
  （快照 N 篇 vs 库内 M 篇）」，真实的"快照比库内少 6 篇"反而没人信。
- 修复：`status()` 在检测到脏标记时先走一次 `index.get(scan)`（84 篇量级毫秒级），拿到重建后
  的真实 `docCount` 再渲染；空库由 `null` 变为 `0`。

### F4 索引体积：docKey 在倒排里重复 → 序号倒排（-71%）

- 旧格式 `postings: { term: { docKey: tf } }` 把 ~40 字节的 docKey 在每条倒排项里重复。
  真实库 82 篇实测：`index.json` 1,444,099 B，其中 31,308 条 docKey 出现。
- 修复：`IndexFile` 增加 `docKeys: string[]`，`postings` 改为
  `{ term: { docIndex: tf } }`，`searchIndex` 先建 `docIndexByKey` 反查表；BM25 / 覆盖率 /
  标题加权语义不变。同一份库快照换算：**1,444,099 B → 413,536 B（0.286×，约 -71%）**。
- `schemaVersion` 3 → 4；`loadFromDisk()` 额外校验 `docKeys.length === docCount`，不符即判废重建。

### F6 发版与计数卫生

- `meta.json` 的 `counters.entriesTotal/notedTotal` 落后于真实库（35/24 vs 实际 55/13）：
  启动时 `reconcileCounters()` 按磁盘实扫**只向上修正**，不再只依赖写路径累加。
- 版本号统一升 `0.8.0`（`package.json` + `src/shared.ts` 的 `PLUGIN_VERSION`）。
- 新增 `npm run verify:dist`（`scripts/verify-dist.mjs`）：源码 mtime 晚于 dist 产物时退出码 1，
  拦住"改了 src 没 build"的假性 bug。
- 补齐历史缺 tag：`v0.6.1`（6488b27）、`v0.6.4`（73d60be）。**v0.7.1–v0.7.3 从未有独立提交**
  （三者为 0.7.4 同一工作树内的连续发版），因此不补假 tag；`v0.7.4` = 6ec445f 覆盖其全部内容。

### 测试

- 全量：`node --test --test-isolation=none --test-concurrency=1 "test/*.test.mjs"` →
  205 tests / 181 pass / 14 skip / 10 fail；10 个 fail 全部是 `test/mcp.test.mjs` 在受限沙箱下
  `spawn EPERM`（与本次改动无关，放开权限单跑该文件 **10/10 pass**）。
- 受影响 7 个文件（diag / indexer / lifecycle / render / guard / meta / tools）：
  **86 tests / 85 pass / 0 fail / 1 skip**。
- `npm run typecheck` 与 `npm run build` 均通过；`npm run verify:dist` 通过。

## v0.7.4 — 2026-09-24（tag: v0.7.4 = 6ec445f）

- 适配 DSH 0.1.7 设置模型（表单来自插件自带 schemastery `Config` 的 volatile 字段，客户端改用
  `ctx.configForms`，不再依赖 `@deepseek-ai/dsh-settings`）。
- 修 session format v4 注入消息来源：生产者自有 kind `plugin:dsh-plugin-memory-3t`
  （旧的 `{kind:'plugin',plugin}` 会让本轮运行以 "requires a producer-owned source kind" 失败）。
- 启动日志自报版本（loader 按 URL 缓存 ESM → 重装不重启会继续跑旧模块）。
- `meta.json` 重构为 schemaVersion 2（只保留库身份与库自身状态，v1 自动迁移）。
- 同批发布的 v0.7.1 / v0.7.2 / v0.7.3 为 0.7.4 之前的三次连续发版，无独立提交与 tag。

## v0.7.0 — 2026-09-23（tag: v0.7.0 = 284207e）

- 工具瘦身：常驻面 12 → 6 个（5 高频 + 1 个 action 式 `devmemory_admin`），schema
  2,081 → 919 tokens/次调用（-55.8%）。
- 子代理默认不注入（`subagentInject: false`）；L1 回放逐行摘要 + 整行截断；
  检索加覆盖率与标题命中加权（index schema 2 → 3）；修注入依赖事件顺序导致 headless
  单步会话静默丢注入。

## v0.6.6 / v0.6.5 / v0.6.3 / v0.6.2 / v0.6.0

- v0.6.6（3c4b6c8）：注入瘦身——L3 默认不注入、逐条钳制、全局视图预算、L1 回放去重。
- v0.6.5（f4a8af4）：事件勘误 + 注入时机重构 + 三态可用性 + 库根写入守卫 + 冷启动 seed + MCP 面。
- v0.6.3（9560f84）：库根 A→B→A 切换复用已初始化 store；v0.6.2（5a4ef75）：status 暴露索引
  快照一致性；v0.6.1（6488b27）：修索引陈旧导致 recall 恒为空。
- v0.6.0（1e5ab19）：更名 `dsh-dev-memory-3t` → `dsh-plugin-memory-3t`。
