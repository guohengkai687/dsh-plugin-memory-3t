# dsh-dev-memory-3t — 本地三层记忆插件设计方案

> 包名：`dsh-dev-memory-3t`。skill 名：`dev-memory`。工具前缀：`devmemory_*`。
> 定位：**纯本地、零服务依赖、可移植的工作区级三层记忆方案**（插件管机制，skill 管协议）。
> 参考吸收：Hindsight（知识页自动沉淀）、OpenViking（权限/韧性/失败敞开）、dsh-mnemon（三层拓扑/全局视角）、dsh-plugin-memory（boot 注入/沉淀兜底/零依赖 markdown）。

---

## 0. 一句话结论

用它之前的四个插件各自证明了不同的东西，本方案把它们收敛成一个**本地开发者**方案：
- **dsh-mnemon** 证明"三层记忆"（Runtime / Documents / Memory Spaces）是正确的心智模型，但 9 个 provider、13 个工具、57 项配置对本地用户是负担 → **我们只取三层模型，砍掉 provider 抽象、砍掉 UI/RPC、工具收敛到 7 个**。
- **dsh-plugin-memory** 证明零依赖的 markdown+git 记忆库 + 强注入保障（boot 块、沉淀兜底、主动追忆）在小规模下非常实用 → **我们照搬这套机制，并把它套进三层模型**。
- **Hindsight/OpenViking** 证明注入时机（pre-step 检查）、权限（0600）、失败敞开（不因记忆故障打断会话）是工程底线 → **写进设计约束**。

产品形状：一个 DSH 插件（`dsh-dev-memory-3t`，纯 TS、零运行时依赖、默认无副进程）+ 一个内嵌 runtime skill（`dev-memory`，可被项目级 `.dsh/skills/` 覆盖）。不需要任何外部服务；语义检索默认用本地 BM25，打开开关后可用本机 Ollama embedding 升级为向量检索。

---

## 1. 目标与非目标

### 目标
1. **三层记忆心智模型**，且注入预算严格分层，prompt 不膨胀。
2. **本地优先**：全部数据在**工作区根下的 `.memory/` 目录**（默认 `<workspace>/.memory/`），markdown 明文，无锁库、无服务进程、无网络。
3. **可移植**：记忆库是"编译产物 + 源文件"，直接拷目录即迁移；`pack/unpack` 已实现（v0.2，`dev-memory-pack` CLI，单文件 `.dmmem`）。
4. **写入有保障**：会话收尾自动沉淀（digest），不是只靠模型自觉（吸取 ltb digest-guard 的教训）。
5. **机制与协议分离**：插件管"何时写/怎么写最安全"，skill 管"模型该怎么用这套记忆"，协议可被项目级 skill 覆盖。

### 非目标（与 mnemon 划清边界）
- 不做多后端 provider 抽象（本地单后端，接口仍留薄抽象便于日后扩展）。
- 不做复杂 WebUI / RPC / 侧栏——**v0.3 起提供只读状态/检索面板**（`/dev-memory`，无写端点、loopback、fail-open），不提供管理写操作。
- 不做云端同步、不做多用户。
- 不做"主动追忆"聊天（默认关闭，见 §6.5；v0.3 已实现 recallNudge 调度但保持默认关）。

---

## 2. 三层记忆模型

| 层 | 名称 | 内容 | 生命周期 | 注入方式 | 预算（tokens） |
|---|---|---|---|---|---|
| **L1** | Runtime 工作记忆 | 当日会话流水（`runtime/YYYY-MM-DD.md`），记录"今天做了什么/讨论了什么"的紧凑摘要 | 每会话启动注入近期回放；连续会话间靠它衔接 | `agent/session-start` 后、首次 pre-step 前随 runtime context 注入 | ≤ 1200 |
| **L2** | Documents 文献记忆 | 完整知识笔记（教程、决策背景、项目档案），类似 Hindsight 的知识页 | 由 digest 或显式 `devmemory_note` 沉淀；**按需检索，不注入** | `devmemory_recall` / `devmemory_note` 工具 | 0（不主动进 prompt） |
| **L3** | Memory Spaces 长期事实 | 原子化事实条目：偏好 / 决策 / 实体 / 项目上下文，带 salience 衰减 | 由 digest 提升或显式 `devmemory_remember` 写入 | 会话启动注入 top-k 高相关命中；pre-step 按需补注 | ≤ 800 |

**分层原则（关键设计决策）**
- L2 是"检索层"不是"注入层"：完整文档永远不主动灌进 prompt，模型需要时用 `devmemory_recall` 查（吸取 mnemon 文档层 + Hindsight 知识页"按需取用"的做法）。
- L1 与 L3 是"注入层"，但各自起预算硬顶，超出的部分宁可少注入也不截断语义（截断会破坏 markdown 结构，导致模型误解）。
- 三层间可以互相提升（promote）：L1 流水里的确定事实 → L3 条目；需要完整保留的背景 → L2 笔记。**单向流动，不反向写回**，避免 L3 被流水污染。

---

## 3. 存储布局与格式

```
<workspace>/.memory/                  # 默认库根（settings 可用 storageDir 覆盖为绝对路径）
├── spaces/                           # L3：每条目一个 .md，frontmatter 元数据
│   └── pref-2019-2025-deepseek-flash.md
├── docs/                             # L2：知识笔记，允许子目录
│   └── notes/2025-01-06-dsh-plugin-seams.md
├── runtime/                          # L1：会话流水，按日一个文件
│   └── 2026-01-15.md
├── index.json                        # 检索索引（词频 + 元数据快照，惰性重建）
├── meta.json                         # schema version、库根、开关快照、digest 状态
├── diag/events.jsonl                 # 诊断与异常记录（v0.4：工具异常/降级路径，不入 git）
└── audit.jsonl                       # forget/降权审计日志
```

L3 条目格式（frontmatter + 正文）：

```markdown
---
id: pref-20260115-abc
kind: preference            # preference | decision | entity | context
created: 2026-01-15T10:00:00+08:00
updated: 2026-01-15T10:00:00+08:00
salience: 0.8               # 0..1，读写时更新，随陈旧衰减
accesses: 3                # 被 recall 命中的次数
tags: [dsh, 记忆, 偏好]
links: [entity-xxx]        # 双向关联 id，防孤儿
---
正文：一句话事实 + 扩展背景（≤ 若干行），首行为摘要句。
```

L1 流水格式：

```markdown
# 2026-01-15
## 03:20 会话 7f3a…
- 与用户讨论 DSH skill 注册机制，结论：ctx.skills.register 是标准入口，项目级可覆盖。
- 用户偏好：中文回复；技术文档用表格对比。
## digest 摘要（会话结束后由插件重写）
- 推进事实 2 条 → spaces/
- 沉淀笔记 1 篇 → docs/notes/2026-01-15-dsh-skill-seams.md
```

**忽略策略（重要工程细节）**：`.memory/` 是记忆库而非项目源码，插件初始化时若工作区存在 `.gitignore` 且未包含 `.memory/`，自动追加一条；同时避免 DSH 的项目文件扫描把记忆库当工作文件暴露给 L2 或工具上下文。

- **权限**：库目录 0700，含敏感内容文件 0600（吸取 OpenViking/ltb 的做法）。
- **可移植性**：全部 markdown + json，任何工具可读；`pack/unpack` 打包迁移（路线图 v0.2）。

---

## 4. 插件：生命周期钩子与注入（机制层）

插件注入 `['tools', 'settings', 'systemPrompt', 'skills']`（若要在 skill 里声明依赖再补 `'skills'`）。

### 4.1 注入时序

| 钩子 | 动作 | 预算 |
|---|---|---|
| `agent/session-start` | 装载 L1 近期回放（最近 2 日流水摘要）+ L3 top-k；**异步预计算**，不阻塞首步 | 合计 ≤ 2000 |
| `system-prompt/assemble` | 通过 `ctx.systemPrompt.context({name:'dev-memory-boot', order:-200})` 注入：技能提示开关、库状态、约定摘要（"查记忆用 `devmemory_recall`，不要臆造"） | ≤ 600 |
| `agent/pre-step` | 仅当 (a) 本会话命中高相关 L3 且未注入过这些条目 (b) 提醒额度未耗尽（每会话 ≤ 2 次）→ `createPluginMessage(reminder, 'instructions')` 提示"可考虑查记忆"；**只提醒不代查** | ≤ 400/次 |
| `agent/turn-stopping` | **digest**：见 §4.2 | — |
| `agent/created` | subagent 继承父会话的 L1 上下文引用与库路径（**v0.3 已实现**：按 `parentSession` 从父会话装载的视图继承 L1 回放 + L3 top-k；reminded 计数独立） | L1 回放 / L3 top-k ≤ 各自预算 |

### 4.2 digest 沉淀（turn-stopping，写入保障的核心）

触发条件（任一）：
1. 会话累计消息数 ≥ 阈值（默认 24）；
2. 用户明确收尾语（"就这样 / 结束 / 记一下"）；
3. 会话空闲超过阈值且本会话有新流水（配合 followup 提醒，默认关）。

流程（全部走模型一次"沉淀 pass"，由 skill 协议驱动、插件钳制）：
1. **extract**：从本会话流水提取候选事实与候选笔记（按 kind 分类）。
2. **dedupe**：与 L3 现有条目做相似度比对（v0 用 BM25 关键词 + 固定阈值，embedding 版用向量），明显重复则跳过或仅更新。
3. **promote**：确定事实 → 新 L3 条目（或更新旧条目 salience）；完整背景 → L2 笔记。
4. **link**：根据 tags/实体名回填双向 `links`。
5. **compact**：把 L1 当日流水重写为摘要版（保留结构化事件，去掉过程性废话）。
6. **（可选）git commit**。

失败模式：任一阶段异常 → 整体 fail-open（记入 meta.json 的 digest 状态），**绝不阻断会话**（吸取 OpenViking 的 fail-open）。未完成的 digest 在下一次 pre-step 检查时补做一次（带次数上限，防止死循环）。

### 4.3 其他保障钩子（可选配置，默认关）

- **digest guard 追着提醒**：库陈旧（上次 digest 距今天数 > N）且本会话有内容丰富对话 → 会话中 followup 一次"要不要沉淀到记忆库？"。默认半开（每会话 ≤ 1 次）。
- **主动追忆**（recall nudge，**v0.3 已实现，默认关**）：30–240 分钟随机间隔 + `agent.followup`（对齐 ltb）；每根会话至多提醒一次、文案标注"非用户输入"，避免打扰。实现见 `src/nudge.ts`（延时/随机/目标挑选全部可注入，单测覆盖）。

---

## 5. 工具集（收敛版）

从 mnemon 的 13 个收敛到 **7 个**，命名统一 `devmemory_*`，全部走 `ctx.tools` 注册并带完整 schema：

| 工具 | 作用 | 对应 mnemon | 说明 |
|---|---|---|---|
| `devmemory_status` | 层统计、索引状态、最近 digest | mnemon_status | 也兼作诊断/自检入口 |
| `devmemory_recall` | 跨层查询（`query`、`layers?`、`maxResults?`），返回命中列表含来源层 | mnemon_recall + document_search | 唯一"读"入口，fuse L1/L2/L3 |
| `devmemory_remember` | 写 L3 条目（`kind`、`content`、`tags`、`importance`） | mnemon_remember / memory_body_create | kind 枚举：preference/decision/entity/context |
| `devmemory_note` | 写/追加 L2 笔记（`title`、`body`、`tags`、`append?`） | mnemon_document_manage | 支持追加模式，避免整篇重写 |
| `devmemory_link` | 条目/笔记间建立关联 | mnemon_link | 双向写、拒绝孤儿链接 |
| `devmemory_forget` | 删除或降权（`mode: delete|demote`） | mnemon_forget | 删除写审计日志（`<库>/audit.jsonl`） |
| `devmemory_consolidate` | 手动触发一次 digest 沉淀 | （mnemon 在框架内） | 用户说"记一下/整理记忆"时调用 |

**工具设计原则**：工具只暴露"记忆操作"，不暴露"索引重建/配置修改"（配置走 settings，索引走惰性重建）；所有路径参数做正则/相对路径校验，禁止逃出库根（吸取 OpenViking URI 白名单与 mnemon 路径校验的思路）。

---

## 6. Skill：协议层（与插件如何切分）

### 6.1 为什么需要 skill（而不是只靠工具）

工具解决"能不能操作"，skill 解决"**该不该、什么时候、用什么格式**"——这是模型可读的指令，也是用户可自定义的部分。四件事由 skill 承担：

1. **recall 时机判断**：什么时候该查记忆（用户提到旧事/偏好/项目经历时），什么时候不该查（轻量寒暄）。
2. **写入纪律**：什么值得写 L3（确定的、长期的、会复用的）、什么只算流水（过程性对话）、什么进 L2（完整背景）。
3. **digest 协议**：沉淀 pass 的步骤与取舍规则（§4.2 的 extract/dedupe/promote/link/compact 的模型侧细则）。
4. **boot 引导**：如果要支持"人格/项目档案"初始化（可选），由 skill 里的 boot 章节驱动，插件只提供 `devmemory_remember` 等原语。

### 6.2 注册与覆盖

- 注册方式（与 ltb 完全一致）：插件启动时 `ctx.skills.register({ name:'dev-memory', description, whenToUse, content: <内置 skills/dev-memory.md> })`。
- 覆盖链（由 DSH 决定）：**项目级 `.dsh/skills/dev-memory/SKILL.md`（或目录 bundle）> 插件 runtime skill > 用户级 `~/.agents/skills/`**。即：用户可以给某个项目放一份自定义协议，优先级天然高于插件内置；插件随版本升级不会踩掉用户协议。
- 触发方式：`invocation: { modelInvocable: true, userInvocable: false }`（记忆协议是模型自动触发的，不需要暴露给用户的 /skill 手动入口）。

### 6.3 与 mnemon/ltb 的差异

- 相比 ltb 单层"memory"协议：我们把协议按层拆开（recall 一次查询全部三层，但写入按层分工具），并明确**三层的取舍规则**写进 skill 正文。
- 相比 mnemon（协议在 WebUI/settings 里配置，模型通过 13 个工具摸索）：我们把"怎么用"固化成一份可阅读、可覆盖的 markdown 协议，模型一次加载即懂。
- skill 正文有 **token 自约束条款**：明确"本协议 ≤ 某长度，禁止把完整笔记灌进 prompt"。

### 6.4 skill 草案

完整草案见 `docs/design/skill.dev-memory.md`（与本文档同目录；可直接作为 `ctx.skills.register` 的 `content`，运行版在 `skills/dev-memory.md`，也支持拆成 `SKILL.md` 放在项目级覆盖）。要点：

```markdown
# dev-memory 长期记忆协议
## 当你需要…时就查/写/沉淀（示例）
- 用户提到过去的事 / 偏好 / 决定 → devmemory_recall
- 用户明确说"记住/以后注意" → devmemory_remember（kind 选 preference/decision）
- 用户给了长篇背景/教程 → devmemory_note
- 会话收尾 → 跟随 digest 提示，执行沉淀 pass
## 三层的取舍（背下来）
- L1 流水：过程，不主动写，沉淀时压缩
- L2 笔记：完整背景，主动写，查询时按需取
- L3 条目：确定的长期事实，主动写，查询时最多带回 top-k
## 写入纪律
- 不确定的事实不要写 L3；写之前和现有条目去重
- 一次写一条；内容首行 = 可单独成句的摘要
## 禁止
- 禁止把整个 L2 笔记复制进 prompt
- 禁止臆造记忆；查不到就回答"记忆库中没有，我可以现在记录"
```

### 6.5 注入预算总表（防止 prompt 膨胀的硬约束）

| 来源 | 上限 | 触发 |
|---|---|---|
| boot context | ≤ 600 tokens | 每次 assembly |
| L1 回放 | ≤ 1200 tokens | 会话启动 |
| L3 top-k | ≤ 800 tokens | 会话启动 + 有需求时 |
| pre-step 提醒 | ≤ 400 tokens / 次，每会话 ≤ 2 次 | 高相关命中且未注入 |
| skill 正文 | ≤ 1000 tokens（协议自约束） | 模型按需加载 skill |

全部可经 settings 调（`maxBootTokens` / `maxRuntimeTokens` / `maxSpaceTokens` 三档），参照 mnemon 的 recallQuality policy 做成简单档位而不做 57 项配置。

### 6.6 配置项（settings 摘要）

| 键 | 默认 | 说明 |
|---|---|---|
| `storageDir` | `.memory` | 相对基准目录（workspace=工作区根 / user=用户主目录）；可为绝对路径 |
| `scope` | `workspace` | 记忆库粒度（**v0.3 已实现**）：`workspace`（每工作区一库）/ `user`（全局一库，默认 `~/.memory`，不碰工作区 `.gitignore`） |
| `maxBootTokens` / `maxRuntimeTokens` / `maxSpaceTokens` | 600 / 1200 / 800 | 三层注入预算 |
| `embedding.enabled` | false | Ollama 向量检索开关，默认本地 BM25 |
| `digest` 系列 | — | 收尾消息数阈值（24）、promote 条数上限（20）、补齐次数上限 |
| `recallNudge.enabled` | false | 主动追忆，默认关 |

---

## 7. 检索与评分

### 7.1 默认：本地 BM25 + 元数据评分（零依赖）

- `index.json` 惰性重建：扫描三层 markdown，分词（英文按词、中文按 2-gram 兜底）、维护倒排。
- 查询评分 = BM25 文本分 × 元数据加成（salience、recency、accesses、kind 权重、tag 完全命中加成），结果按来源层分组返回。
- 规模约束：≤ 几千条目规模下毫秒级；超规模提示重建或开 embedding（方案不追求亿级检索）。

### 7.2 可选：Ollama 本地 embedding（默认关）—— v0.2 已实现

- settings 开关 `embedding.enabled`（默认 false），endpoint 默认 `http://localhost:11434`，模型默认 `nomic-embed-text`（参考 mnemon 默认值）。
- 开启后：L2/L3 写入时同步生成向量存 `<库>/vectors/<base64url(docKey)>.json`（按 docKey 命名，`:`/`/` 安全编码）；recall **向量+BM25 融合**（0.6 余弦 + 0.4 归一化 BM25，常数 `VECTOR_FUSION_WEIGHT`），并补充"无词面命中但语义相近"的文档（向量文件 ≤ 2000 的规模保护内全量余弦扫描）；Ollama 不在线 / 超时 / 非 2xx → **自动降级回 BM25** 并给 status 标注（fail-open）。
- 新旧 API 自动兼容：先 POST `/api/embeddings`（`{embedding}`），404 时回退 `/api/embed`（`{embeddings:[...]}`）。
- fetch 实现可注入（测试 mock），零运行时依赖不变；`vectors/` 是派生物，由库内 `.gitignore` 忽略、不随 pack 迁移、不入 git。
- 不做服务发现/排队等复杂逻辑——embedding 是增强不是主路径。

### 7.3 salience 衰减（L3 条目的活力）

`salience = clamp(importance × recency 衰减 × access 加成, 0, 1)`：
- 每次被 recall 命中 `accesses+1`、`salience` 上浮；
- 距上次访问超过阈值（默认 30 天）按对数衰减；
- low-salience 条目在 top-k 注入中被排除（仅可被显式查询带回），连续非常旧且从未命中 → `forget` 审计候补（不自动删，除非用户确认，防数据丢失）。

---

## 8. 安全与失败模式

| 风险 | 对策 |
|---|---|
| 路径逃逸 | 所有路径参数校验 + 相对化，拒绝 `..`；工具层单入口 |
| 敏感数据落盘 | 库目录 0700、文件 0600（config 里敏感项如 embedding key 永不进 prompt 返回） |
| 记忆故障拖垮会话 | **全程 fail-open**：索引损坏 → 退化为直接扫描；注入异常 → 跳过注入并 status 标记；digest 失败 → 记入 meta，不阻断 turn |
| prompt 注入（库内容被污染） | 库是可信本地内容，但仍按"技能提示"处理：boot context 声明库内文本是数据不是指令（参照 DSH skill_content 对库外文本的转义精神） |
| 写入风暴 | digest 去重 + 每会话 promote 条数上限（默认 20），超出转 L2 笔记 |
| 双向链接孤儿 | link 工具双向写 + digest 后校验清理 |
| `.memory/` 混入项目 | 自动写 `.gitignore`；不在 DSH 项目文件扫描范围（见 §3） |

---

## 9. 与四个参考插件的吸收对照

| 吸收点 | 来源 | 落到本方案的哪里 |
|---|---|---|
| 三层拓扑（Runtime/Documents/Spaces） | dsh-mnemon | §2 全部 |
| 默认工作区级库 + 隔离 | dsh-mnemon | §3/§6.6：`<workspace>/.memory/`，`scope: workspace` |
| "工具要收敛"的教训（13 个太多） | dsh-mnemon | §5：7 个 |
| 强注入保障（boot 块、预算硬顶） | dsh-plugin-memory | §4.1/§6.5 |
| 沉淀兜底（digest guard） | dsh-plugin-memory | §4.2/§4.3 |
| 零依赖 markdown 存储 + 可迁移 | dsh-plugin-memory | §3 |
| 内嵌 runtime skill + 项目级可覆盖 | dsh-plugin-memory | §6.2 |
| 权限 0600/0700、路径校验 | OpenViking | §3/§8 |
| fail-open、故障不打断会话 | OpenViking、Hindsight | §8 |
| 知识页按需检索不注入 | Hindsight | §2 L2 原则 |
| pre-step 注入时机检查 | Hindsight、dsh-mnemon | §4.1 |
| subagent 继承会话上下文 | dsh-mnemon | §4.1 agent/created |

**明确砍掉**（对照 mnemon）：9 provider → 1 本地后端（薄抽象留存接口位）；WebUI/RPC → 无；不定时器常驻轮询的主动追忆 → 默认关。

---

## 10. 路线图

| 版本 | 范围 | 验收 |
|---|---|---|
| **v0.1 MVP** | 三层存储（`.memory/`）+ 7 工具 + BM25 + boot/L1/L3 注入 + digest + skill 注册 + `.gitignore` 自维护 | `pnpm verify`（typecheck+vitest+headless 激活 profile 验证，含 skill 可加载断言）；本地自测（参考 ltb 的 CLI self-test）；一次真实会话端到端：讨论 → 收尾 → 重启 → 能 recall |
| **v0.2** | ✅ git 版本回溯（嵌套仓库/分离 gitDir + 防抖/batch 合并提交 + 边界 flush + history/diff/restore 3 工具，10 工具）✅ 已完成；✅ Ollama embedding + 向量索引（融合 + 语义补漏 + 降级）；✅ `pack/unpack` CLI（`dev-memory-pack`）；✅ `gitDir` 分离仓库正式化；✅ 项目级 SKILL.md 覆盖示例（`docs/project-skill-override.md`） | 95/95 测试全绿（含 16 例真实 git 集成 + 6 路 embedding mock + pack 往返/防逃逸）；embedding 真机链路待有 Ollama 环境复验 |
| **v0.3** | ✅ 只读 WebUI 面板（`/dev-memory` 状态/检索，`ctx.webServer` prefix 路由，touch:false 只读，headless 静默跳过）；✅ `scope: user` 全局库（homedir 基准 + 不碰工作区 .gitignore）；✅ subagent 视图继承（`agent/created` + parentSession）；✅ restore 整库时间片（targets 省略/`all`）；✅ recallNudge 实现（30–240min 随机 + followup，默认关） | 112/112 测试全绿（含 16 例真实 git 集成 + 5 例新 nudge 调度 + 5 例 WebUI 路由 + 2 例 scope）+ 整库时间片真实 git 反转断言；WebUI 真实 HTTP 面待 web GUI 重启后打开核对 |
| **v0.3.1** | ✅ workspace 根按会话真实工作区解析：`agent.session.header.cwd` → `config.workspaceDir` 固定值 → `process.cwd()` 回退；store 按库根懒初始化 + 工具/面板 getter 动态解析（实例或 getter 双形态），多工作区会话各自建库 | 113/113 测试全绿（含 12 例真实 git 集成 + 新增会话 header.cwd 根解析回归）；web GUI 重启后 /dev-memory 指向工作区库根 |
| **v0.4** | ✅ 诊断与异常记录（DiagLog）：工具调用异常 / 生命周期失败 / 降级路径自动记入 `<库>/diag/events.jsonl`（error/unexpected 两级、参数截断防敏感、上限压缩、禁用开关）；新工具 `devmemory_diag`（summary/list/clear）；`devmemory_status`/boot/WebUI 均展示诊断计数；diag/ 不入 git、不随 pack | 全部既有测试同步（工具 10→11、status 携带 diag、config 新默认值）+ 新增 diag 单元与集成测试（记录/汇总/过滤/清空/压缩/禁用/工具异常自动记录）全绿 |
| **v0.5** | ✅ DSH 设置页「记忆管理」：WebUI 功能与参数接入设置体系——服务端 `installSettingsSection` 注册 `dev-memory` namespace（schema=可编辑表面+默认值，entry 作 base，用户层覆盖，`onChange` live 应用：`applyEffective` 原地更新组对象，面板开关摘/挂路由、diag caps、nudge 开关等实时生效；storageDir/scope/workspaceDir 启动期绑定重启生效）；客户端 tsdown bundle（`dsh.client` + `exports["./client"]`，厂商标记 `__ModuleLoader__.load`，仅外部化 react/jsx-runtime）贡献 `settings.section` 独立选项页（打开面板入口 + 库状态卡 + 完整表单）与 `settings.plugin.item` 可配置卡片；headless 与依赖缺失 fail-open 零开销；`webui.enabled` 新配置组 | 134/134 测试全绿 0 跳过（新增 settings 桥 6 例：applyEffective live/启动期边界/非法忽略/无变更/fail-open/依赖装载+schema 形状；diag.updateConfig 动态收窄压缩、nudge.setEnabled 运行时切换、config webui 组、webui 面板摘挂与开关守卫）；`client/client.js` 工厂产物与 dsh.client 声明在安装副本验证；设置页真实 GUI 面待重启后打开核对 |
| **v0.5.2** | ✅ 插件可配置卡片手风琴化：`settings.plugin.item` 卡片由"默认展开的散放表单"改为与内置 PluginCard 一致的可折叠手风琴（头部=标题+描述+展开箭头+未保存徽标，点击展开才是表单，折叠不丢草稿——表单常驻仅 `display:none` 隐藏）；卡片/表单全部改用 `--dsw-alias-*` 主题令牌（消除混用自定义 CSS 变量的"随意摆放"样式）。同款卡片结构复刻自运行构建 `dsh-client-ui-settings-plugins`（以运行编译产物为权威）。134/134 全绿 0 跳过 + client typecheck + tsdown 构建；安装副本验证 card/表单主题；发布包归档 `.memtest-pack` | 0.5.2 |
| **v0.5.3** | ✅ 设置面去重：撤销 `settings.plugin.item` 卡片槽位（与 `settings.section` 独立页功能重复、参数两处可见，用户验收要求保留独立页、删除卡片）；参数唯一编辑面 = 独立页（打开面板 + 完整表单），独立页内参数不重复（单份 SECTION_FIELDS）；删除 `client/card.tsx` 与 card 专用 locale，client bundle 29.7kB→25.1kB | 134/134 全绿 0 跳过 + client typecheck + tsdown 构建；打包重装 headless/web 两 profile（0.5.3）归档 `.memtest-pack`；GUI 核对：插件配置无卡片 |
| **v0.5.4** | ✅ 独立页纯参数面：移除页面顶部「记忆库状态」卡（v0.5 起随设置页引入，其状态行——版本回溯/检索/诊断记录——与下方表单开关主题重合，用户反馈"参数重复"）；删 status fetch、`PanelStatus` 与 status*/state* locale 键，库状态回归只读面板 `/dev-memory/` 查看；设置页 = 打开面板入口 + 参数表单；client bundle 25.1kB→19.6kB | 134/134 全绿 0 跳过 + client typecheck + tsdown 构建；打包重装 headless/web 两 profile（0.5.4）归档 `.memtest-pack`；GUI 核对：设置→记忆管理 无状态卡 |
| **v0.5.5** | ✅ 表单组首字段重复渲染修复（参数重复**真正根因**）：按用户截图逐行转录定位——每个**分组的第一个参数**出现两次（启用面板/启用诊断记录/启用主动追忆/启用 git 回溯 ×2，同组第二字段如事件保留上限仅 ×1），导航/链接/提示均单份；根因 = `form.tsx` 渲染循环 `rendered.push({ header: groupLabel(field.group), field })` 把组内首个字段**连同标题推入标题条目**、随后 `rendered.push({ field })` 再推一次（v0.5.0 引入，v0.5.3 卡片/v0.5.4 状态卡均为表面现象）；修复：标题条目只携带 header（`{ header }`），渲染处 `field !== undefined` 才输出字段行，rowKey/header key 区分；client bundle 19.6kB | 134/134 全绿 0 跳过 + 双端 typecheck + tsdown 构建；打包重装 headless/web 两 profile（0.5.5）归档 `.memtest-pack`；GUI 核对：每个参数单份、分组标题单份 |

**不做的（明确）**：多 provider、云同步、主动追忆聊天（除非用户开）、数据库后端。

---

## 附录 A：最小插件骨架（关键片段）

```ts
// src/index.ts — Cordis 插件入口
import { Context } from '@deepseek-ai/dsh'      // 实际按 DSH 插件约定 import
import { readFileSync } from 'node:fs'

export const name = 'dsh-dev-memory-3t'
export const inject = ['tools', 'settings', 'systemPrompt', 'skills']

export function apply(ctx: Context, config: Config) {
  const store = new MemoryStore(rootOf(config))   // 默认 <workspace>/.memory/，三层读写 + index + 权限
  void store.init().catch(() => ctx.logger.warn('dev-memory init deferred, fail-open'))

  // 1) runtime skill（协议层）
  ctx.skills.register({
    name: 'dev-memory',
    description: '三层长期记忆协议：按层读写记忆（L1 流水 / L2 笔记 / L3 事实条目）…',
    whenToUse: '用户提到旧事/偏好/决策、说"记住/忘掉/整理一下记忆"、会话收尾沉淀时',
    content: readFileSync(new URL('../skills/dev-memory.md', import.meta.url), 'utf8'),
    invocation: { modelInvocable: true, userInvocable: false },
  })

  // 2) boot 注入（预算约束见 config）
  ctx.systemPrompt.context({
    name: 'dev-memory-boot', order: -200,
    text: () => store.renderBootBlock(config),   // ≤ maxBootTokens
  })

  // 3) 会话启动装载 L1 + L3
  ctx.on('agent/session-start', async ({ agent }) => {
    const ctx = await store.loadSessionContext(agent)   // 异步，不阻塞首步
    agent.ctx.effect(() => { /* 挂到 agent 作用域，随 agent 销毁 */ })
  })

  // 4) pre-step 引导提醒（每会话额度内）
  ctx.on('agent/pre-step', async ({ agent, decision }, next) => {
    const reminder = await store.maybeRemind(agent)     // null 或 remind 文本
    if (reminder) decision.messages.push(createPluginMessage(reminder, 'instructions'))
    return next()
  })

  // 5) turn-stopping digest 沉淀
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    await store.digest(agent)   // extract/dedupe/promote/link/compact，全程 fail-open
  })

  // 6) 工具注册（7 个，示范 1 个）
  ctx.tools.register(devmemoryRecall, {
    description: '跨层查询记忆（L1 流水 / L2 笔记 / L3 事实）',
    schema: { query: 'string', maxResults: 'number?', layers: 'string[]?' },
    async exec({ query, maxResults }) { return store.recall(query, { maxResults }) }
  })
}
```

## 附录 B：文件清单（vs 0.3.0 实际包结构）

> 该清单为设计基线；截止 v0.5 的增量：`vcs.ts`（git 回溯）、`pack.ts`/`cli.ts`/`bin/`（打包迁移）、
> `nudge.ts`（recallNudge）、`webui.ts`（只读面板）、`diag.ts`（诊断与异常记录）、`render.ts`（boot/回放渲染）、`skill.ts`（协议加载）、
> `settings.ts`（v0.5 设置桥：schema + installSettingsSection + applyEffective）、`client/`（v0.5 浏览器 bundle：设置页/卡片/表单/locales）。
> 工具面 11 个（v0.1 的 7 个 + history/diff/restore + diag）。设计档案统一收在 `docs/design/`。

```
dsh-dev-memory-3t/
├── package.json            # name: dsh-dev-memory-3t, MIT, 零 runtime deps, peers: @deepseek-ai/cordis 等
├── cordis.patch.yml        # 按 DSH 约定 bundle patch（- insert 插件条目）
├── src/
│   ├── index.ts            # 入口（生命周期接线：session-start/pre-step/turn-stopping/created + 设置桥接线）
│   ├── store.ts            # 三层读写 + 权限 + 审计（scope: workspace|user 库根）
│   ├── indexer.ts          # BM25 索引 惰性重建/查询
│   ├── embed.ts            # Ollama embedding（可选，fail-open 降级）
│   ├── vcs.ts              # git 回溯管理层（嵌套/分离仓库、防抖提交、history/diff/restore）
│   ├── pack.ts             # pack/unpack：.dmmem 归档（排除 .git/index.json/vectors）
│   ├── cli.ts              # dev-memory-pack CLI（bin/ 入口 shim）
│   ├── nudge.ts            # recallNudge 调度（30–240min 随机 + followup，默认关；setEnabled 运行时切换）
│   ├── diag.ts             # 诊断与异常记录（v0.4，<库>/diag/events.jsonl + 汇总/明细/清空；updateConfig live）
│   ├── webui.ts            # 只读面板：/dev-memory 路由 + 静态页 + JSON API（v0.5 返回 disposer + webui.enabled 开关）
│   ├── settings.ts         # 设置桥（v0.5）：schema + installSettingsSection + applyEffective（live 生效、启动期绑定边界）
│   ├── shared.ts           # 服务端/客户端共享纯常量（设置 namespace）
│   ├── digest.ts           # 沉淀流程
│   ├── tools.ts            # 11 个 devmemory_* 工具
│   ├── config.ts           # 三档 token 预算 + scope + 开关 + webui 组（远少于 57 项）
│   ├── render.ts           # boot 块 / L1 回放 / L3 top-k 渲染与 token 钳制
│   ├── paths.ts            # 库根解析（workspace/user 基准）+ 防逃逸拼接
│   └── frontmatter.ts      # L3 条目 frontmatter 解析/序列化
├── src/client/             # v0.5 浏览器 bundle 源码（tsdown → client/client.js）
│   ├── index.tsx           # 客户端插件：settings.section 独立设置页（v0.5.3 起参数唯一编辑面，不再注册 settings.plugin.item 卡片）
│   ├── section.tsx         # 设置页（v0.5.4 起纯参数面：打开面板入口 + 完整表单，状态卡已移除）
│   ├── form.tsx            # staged 编辑表单核心（组/标量字段，scope.set/unset）
│   └── locales.ts          # zh/en 文案
├── client/                 # 构建产物（client.js + map，__ModuleLoader__ 工厂，仅外部化 react）
├── skills/dev-memory.md    # skill 协议正文（设计草案见 docs/design/skill.dev-memory.md）
├── docs/
│   ├── design/             # 设计档案（DESIGN.md + skill 草案）
│   └── team/               # 团队交接物（SPEC/ARCHITECTURE/TASKS/REVIEW/QA/TL-NOTES）
├── test/                   # node --test 单测（测 dist 产物；真实 git 集成需要放开沙箱）
└── README.md               # 中文文档（安装/配置/使用/限制/路线图）
```