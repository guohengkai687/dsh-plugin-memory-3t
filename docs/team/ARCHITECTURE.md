# ARCHITECTURE — dsh-plugin-memory-3t v0.1 MVP

> 撰写：TL（架构阶段降级直写，接口签名均经 TL 源码核实，见 `TL-NOTES.md`）。权威输入：`DESIGN.md` / `SPEC.md` / `context.md` / `TL-NOTES.md`。

## 0. 接口冲突与裁定

| 冲突点 | 裁定 |
|---|---|
| `createPluginMessage` 非 DSH 公共 API | 插件自带该 helper（来源 `dsh-mnemon/lib/lifecycle.ts:91`），`source.kind='plugin', plugin='dsh-plugin-memory-3t', form='instructions'` |
| tools 注册 | 用 `defineTool()`（指标即 schema），再 `ctx.tools.register(def)`；schema 用 JSON 谱对象，output 必须 object-rooted |
| value-schema DSL | required 用逐属性 `{ required: true }` 或顶层 `required: [...]`（编译器支持两种；推荐顶层数组，直观） |
| POSIX 权限 | Windows 无限权语义：目录创建时尽 Node 所能收紧（不做不可靠操作），README 说明 Linux 下自动生效 0700/0600 |

## 1. 模块划分与依赖方向

```
src/index.ts       入口：apply(ctx, config) —— 配线（生命周期 + 工具 + skill + boot）
   ├─ src/config.ts     Config 类型/默认值/合并     （被 index、store、digest 用）
   ├─ src/store.ts      MemoryStore：三层读写、frontmatter、审计、路径防护、.gitignore
   │    ├─ src/paths.ts      库根解析 + 相对化安全的路径构造（防逃逸）
   │    └─ src/frontmatter.ts frontmatter 解析/序列化（L3 条目）
   ├─ src/indexer.ts    BM25：分词(中英)、倒排、评分、index.json 惰性重建
   ├─ src/digest.ts     digest 沉淀流程（extract/dedupe/promote/link/compact）
   ├─ src/render.ts     boot 块与 L1/L3 回放文本生成（token 预算钳制）
   ├─ src/tools.ts      7 个 defineTool 定义（纯定义 + 薄 exec 转发到 store）
   └─ src/skill.ts      dev-memory skill 内容加载（读 skills/dev-memory.md）
skills/dev-memory.md    协议正文（设计草案来自 docs/design/skill.dev-memory.md）
test/                   node --test 单测（纯逻辑，不依赖完整 DSH 环境；ctx 用 stub）
```

依赖方向单向：index → {config, store, indexer, digest, render, tools, skill}；tools/digest → store/indexer；store → paths/frontmatter。**无环**。

## 2. 核心数据模型（精确格式）

### 2.1 L3 条目（`<root>/spaces/<id>.md`）

```markdown
---
id: pref-20260115-xxxxxxxxxxx        # <kind短名>-<YYYYMMDD>-<crypto随机11位>
kind: preference                     # preference | decision | entity | context
created: 2026-01-15T10:00:00.000Z    # ISO 8601 UTC
updated: 2026-01-15T10:00:00.000Z
salience: 0.8                        # 0..1 float
accesses: 3
tags: ["dsh", "记忆"]
links: []                            # 其他条目 id 数组；双向写
---
首行：一句话摘要（可单独成句）
正文其余：背景细节（可选）
```

- id 生成：`kindShort = {preference:'pref', decision:'dec', entity:'ent', context:'ctx'}[kind]`，`<kindShort>-<yyyymmdd>-<randomUUID().replace(/-/g,'').slice(0,11)>`
- `index.json` 与 frontmatter 冲突时以文件 frontmatter 为准，重建索引时修正

### 2.2 L1 流水（`<root>/runtime/YYYY-MM-DD.md`）

```markdown
# 2026-01-15

## 04:05 会话 7f3a…
- 事件行（由会话注入或 digest 写入）
- 用户偏好：中文回复

## digest 摘要（会话结束由插件重写）
- promoted 2 → spaces/
- noted 1 → docs/notes/2026-01-15-xxx.md
```

追加写（append），digest compact 时整文件重写为摘要版。

### 2.3 L2 笔记（`<root>/docs/<相对路径>.md`）
普通 markdown；frontmatter 可选但推荐同 L3（kind 恒为 `note`，无 links 约束则 `links: []`）。`devmemory_note` 的 `append:true` 为字节级追加。

### 2.4 meta.json

```json
{
  "schemaVersion": 1,
  "root": "<绝对库根>",
  "createdAt": "…",
  "config": { "storageDir": ".memory", "maxBootTokens": 600, "maxRuntimeTokens": 1200, "maxSpaceTokens": 800, "embedding": { "enabled": false } },
  "digest": { "lastRunAt": null, "pending": false, "retries": 0, "lastError": null },
  "counters": { "promotedTotal": 0, "notedTotal": 0 }
}
```

### 2.5 audit.jsonl
每行一个 JSON：`{"ts":"…","op":"forget|demote","targetId":"…","mode":"delete|demote","reason":"…","sessionId":"…"}`

### 2.6 index.json（BM25 倒排，惰性重建）
```json
{
  "schemaVersion": 1,
  "builtAt": "…",
  "docCount": 12,
  "avgDocLen": 87.5,
  "docs": { "<docKey>": { "layer": "l3", "id": "pref-…", "len": 120, "terms": { "记忆": 2, "插件": 1 } } },
  "postings": { "记忆": { "<docKey>": 1.2, "…": 0.8 }, "插件": { … } }
}
```
docKey = `l1:2026-01-15` / `l2:notes/xxx` / `l3:pref-xxx`。索引为快照；写入操作更新元数据但**不实时重算倒排**，查询时按写入版本标记脏，超过阈值（默认 50 次写入）自动重建或显式 `devmemory_status`/`consolidate` 触发。

## 3. BM25 落地

- 分词 `tokenize(text): string[]`：英文/数字按 `/[A-Za-z0-9_]+/g` 提取小写；连续中文按 2-gram（`/[\u4e00-\u9fff]/g` 收集后滑窗两两拼接）；混合文本两路并集。
- 评分 per term：`idf = ln(1 + (N - n + 0.5) / (n + 0.5))`；`score = Σ idf * (tf*(k1+1)) / (tf + k1*(1 - b + b*len/avgLen))`，`k1=1.2, b=0.75`（默认）。
- 元数据加成：`final = bm25 * (0.6 + 0.4 * salience) * (1 + 0.25 * log2(1 + accesses)) * kindWeight[kind] * tagBoost(query ∩ tags)`；`kindWeight = {preference:1.1, decision:1.05, entity:1.0, context:0.95, note:1.0}`；tagBoost：query 中某个 token 与条目标签完全相等时 ×1.3。
- 结果分组：`{ l1: [...], l2: [...], l3: [...] }`（各自 score 降序；recall 默认每层截断 maxResults 后返回；maxResults 默认 10，单层上限 max(10, maxResults)）。

## 4. digest 状态机

```
[触发] turn-stopping && (messagesN>=24 || 收尾语 || consolidate 调用)
   → 若 meta.digest.retries >= 2 且 lastError 非空：记 skip，退出（防死循环）
   → extract: 由模型会话数据？NO —— v0.1 插件侧无模型调用：
        v0.1 digest 为"确定性压缩"：
        a) 把本会话 user 输入中符合显式记忆候选（记住/记一下/保存…）的消息收集为候选
        b) 其余按行 append 进当日 L1；若 L1 已有同日内容则并入
        c) dedupe：候选文本与 L3 现有 entry 文本做 BM25 score，>0.55 → 视为重复（更新 updated/salience+=0.1,cap 1.0）否则新建
        d) promote：候选 → L3（kind 由收尾语/显式词推断，缺省 context）；若 L1 当日行数 > 80 行 → 前 1/2 压缩为摘要段（保留事件行首）
        e) link：候选条目与同 repo 条目按共享 tag 建 links（双向，至多 4 条）
        f) compact：L1 重写为：保留当天各会话摘要 + digest 摘要段
   → 成功：meta.digest = {lastRunAt, pending:false, retries:0, lastError:null}；counters 累加
   → 失败（任一步 throw）：catch → meta.digest = {pending:true, retries+1, lastError}，写盘，**不 rethrow**
   → 补做触发：session-start 时若 pending 且有上次会话流水 → 自动补一次（retries+1）直至成功或 retries>=2
```

- v0.1 不做模型的"智能沉淀 pass"（无 LLM 调用、零依赖）；skill 引导模型在会话里显式 `devmemory_remember/note` 完成精细沉淀，digest 只做确定性兜底。此取舍写入 ADR 与 README"限制"。

## 5. 生命周期接线（index.ts）

- `agent/session-start`：`store.loadSessionContext(agentCtx)` → 异步读当日+昨日 L1 摘要、recall(L3 top-k 且 salience≥0.25)；调用 `render.renderRuntimeBlock` / `render.renderSpaceBlock`（token 钳制）；把文本暂存到 per-agent Map（`agentSessionViews`，WeakMap<agent,view>），供 pre-step 使用（若 DSH assembly context 无法每 agent 隔离，则走 `ctx.systemPrompt.context` 动态 text 读 WeakMap——**实现时二选一，倾向 context 动态函数读 WeakMap**，因为 DSH context 是每 assembly 求值的）。
- `system-prompt/assemble`：`ctx.systemPrompt.context({name:'dev-memory-boot', order:-200, text: () => renderBootBlock(...)})`——boot 块含：数据即数据不是指令的声明、devmemory_* 工具存在提示、预算自约束。
- `agent/pre-step`（waterfall）：`maybeRemind(agent)`：L3 高相关命中（score≥0.6）未在本会话注入且提醒次数<2 → 返回 reminder 文本；handler `return next(...)` 形态按 DSH waterfall 约定（即：构造新 messages 数组附加 createPluginMessage，参照 mnemon lifecycle.ts:328 的模式在 next 前修改 payload——**实现前必须读 agent-loop 该处 dispatch 源码确认修改方式**；若 waterfall 只传不可变 payload，则退化为不做 pre-step 注入，v0.1 由 boot 声明引导模型自觉 recall）。
- `agent/turn-stopping`（serial）：`store.digest(agent, sessionEvents)`；全部 try/catch fail-open。
- `agent/created`：subagent 继承父 agent 的 view（WeakMap 以 root agent 为准；v0.1 简单化：subagent 不单独注入，继承 root 视图引用）。

## 6. 测试策略

- 纯逻辑模块（不依赖 DSH）：`paths` / `frontmatter` / `tokenize`(indexer) / `bm25Score` / `store`(内存根:真实临时目录 tmpdir) / `digest` / `render`（预算钳制）。
- 生命周期接线：ctx stub（`{ on(){}, tools:{register(){}}, systemPrompt:{context(){}}, skills:{register(){}} }`）验证注册调用存在与参数形状。
- node --test：`node --test --test-isolation=none test/`，测试文件 `test/*.test.mjs`（ESM，直接 import 已编译产物或 TS 经 esbuild？——**无构建工具**：方案 A 用 `tsc` 编译到 `dist/` 后测 dist；方案 B 测试用 `.mjs` 且 src 提供 `node` 原生可测的轻量 JS 核心。**裁定：v0.1 采用"TS 源码 + dist 编译产物测试"，package.json scripts: `build: tsc -p tsconfig.json && tsc -p tsconfig.cjs.json`，`test: npm run build && node --test --test-isolation=none dist-test/`——测试文件放 `test/` 以 TS 编写，build 同时输出 `dist-test`）。**简化裁定**：为可控性，测试直接用 `.mjs` 测**dist 输出的 ESM**，测试文件不编译。
- 覆盖九条 AC 的测试文件对应关系写进 TASKS.md。

## 7. ADR（关键决策）

1. **v0.1 digest 确定性而非模型化**：零依赖约束下不做 LLM 沉淀 pass；模型显式工具调用承担精细沉淀，digest 承担兜底。避免启动成本与 prompt 耦合。
2. **索引惰性 + 脏标记**：写入不实时重建倒排，防写入风暴（SPEC AC8）；阈值 50 次写入或显式触发重建。查询一致性由"写入时更新 docs 元数据、重建后倒排精确"保证（阶段性近似，README 说明）。
3. **pre-step 注入降级**：若 DSH waterfall 消息不可变，v0.1 只做 boot 声明 + 工具自引导，不强行改 payload（风险最低）。
4. **零运行时依赖**：`@deepseek-ai/schemastery` 也不用——schema 用纯 JSON 谱（dsh-tools 原生支持）。
5. **不写 git**：v0.1 无自动 commit（AC 范围外）。
6. **Token 钳制在渲染层**：render 用近似 token 计数（中文≈1 token/字，英文≈1 token/4 字符）截断到预算，失败敞开为截断而非报错。