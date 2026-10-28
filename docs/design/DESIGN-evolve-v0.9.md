# dsh-plugin-memory-3t — 自我学习 / 周迭代设计（v0.9.0）

> 状态：设计稿（待评审，未实现）。目标读者：维护者与实现者。
> 关联文档：`docs/design/DESIGN.md`（总体架构）、`CHANGELOG.md`（v0.8.0 修复）。

## 0. 一句话结论

现在的插件是**只会写、不会长大**的仓库：它按会话被动追加 L1、靠关键词把"记住…"提升成 L3，既不遗忘、也不评估、也没有时间维度。要变成"每周自动迭代、自动成长"，缺的不是一个定时器，而是**一条闭环**：采集 → 提炼 → 巩固 → 遗忘 → 评估 → 调参 → 报告，并且每一步都可回滚、可度量。本文给出这条闭环的可实现方案（v0.9.0）。

## 1. 目标与非目标

### 1.1 目标

| 编号 | 目标 | 可验收判据 |
|---|---|---|
| G1 | **每周自动运行**一次演化，无需人工触发 | 7 天窗口到期后，下次会话启动即后台执行；`meta.json.evolve.lastRunAt` 前移 |
| G2 | **内容自增长**：从真实会话里提炼新 L3/L2，而不是等关键词 | 每周至少新增 1 条 L3 或 1 篇 L2（有真实活动时），且新增条目被后续 recall 命中 |
| G3 | **记忆自整理**：合并重复、消解冲突、归档死条目 | L3 总量增速 ≤ 新增速率；`archive/` 只增不删；冲突条目 100% 有 `supersedes` 链接 |
| G4 | **有遗忘**：salience 随时间衰减，零访问条目退出注入 | 90 天零访问且 salience < 0.2 的条目全部归档 |
| G5 | **可评估**：每周产出可比较的指标 | 周报含 hit@5 / waste / coverage / churn 四项，且与上周可比 |
| G6 | **可回滚**：任何自动写入都能一键还原 | 每次演化是一个独立 git commit（`[evolve]` 前缀），`git revert` 即撤销；`dryRun` 模式零写盘 |
| G7 | **成本有界** | 无 LLM 档每周 < 3 s、零 token；可选 LLM 档每周 ≤ 40K tokens |

### 1.2 非目标

- 不做云端同步、不做多机一致（库仍是每工作区一个 git 仓库）。
- 不做"自动改代码/自动写 skill"（那是 skill 自演化的范畴，v0.9 只在 P2 留接口）。
- 不替换 digest 的会话内沉淀（保留现有 `DigestEngine`），演化是**周期层**，不是替代品。
- 默认不引入 LLM 依赖；LLM 复盘是可选档（需显式开启）。

## 2. 现状诊断：为什么现在"不会长"

证据取自 v0.8.0 源码与两周实测（Harness 库 84 篇 / FlexOne 库 50 篇）。

| 断点 | 证据 | 后果 |
|---|---|---|
| 候选只认关键词 | `src/digest.ts:35` `isExplicitMemoryCandidate()` 用正则匹配"记住/remember/别忘…"；`src/digest.ts:157-167` `collectCandidates()` 只用它过滤 user 消息 | 实测 5 次 digest 全部"本轮无可沉淀候选"；真实教训（如 robocopy 事故）从未自动入库，全靠人肉 `devmemory_remember` |
| 触发只在会话边界 | `src/digest.ts:72-83` `maybeDigest()`：消息数 ≥ 24 或收尾语才跑；`src/index.ts` 的 digest 钩子在 session-start / turn-stopping | 一周没开会话就没有任何沉淀；跨周没有"回看"动作 |
| 只增不减 | `salience` 仅在 digest 去重时 +0.1（`src/digest.ts:108`）、recall 命中时置 1；没有衰减函数 | 55 条 L3 里 20 条 `accesses:0` 仍长期占位；`recall.minSalience=0.25` 挡不住"一次命中就永久 1.0" |
| 无冲突消解 | 只有 `findDuplicate()` 的 token 重叠去重（`src/digest.ts:173-194`，阈值 0.55），重复即"提 0.1 分" | 同一主题的新旧结论并存；模型 recall 时可能拿到过期事实 |
| 无语义层 | `embedding.enabled` 默认 false（`src/config.ts:208`） | 去重/合并只能靠字面重叠，跨表述的同义事实无法合并 |
| 无评估 | 全仓没有任何"召回质量"指标；`accesses` 是唯一反馈信号 | 无法判断"这周的记忆让下周更聪明了吗"，也无法据此调参 |
| 无时间维度状态 | `meta.json.digest.lastRunAt` 只在 digest 时更新；没有 `evolve` 状态 | 无法判断"是否该跑周演化" |

**结论**：v0.8.0 解决了"串库/噪声/索引"，但记忆仍是**写多读少的静态档案**。周演化要补的是闭环的后半段。

## 3. 核心模型：把"自我学习"拆成可度量动作

"自我学习"在本系统里 = 用**自己的使用数据**改变自己的**内容**与**参数**，并且可回滚。四个动作：

1. **巩固（Consolidate）**：把散落在 L1 的高价值信号提炼成 L3 事实 / L2 笔记；合并重复、消解冲突。
2. **遗忘（Forget）**：按访问与时间衰减 salience，把死条目归档（不删除）。
3. **评估（Evaluate）**：用上周真实问句回放 recall，算命中/浪费/覆盖。
4. **调参（Tune）**：根据评估结果小步调整检索参数（可选，默认关）。

三个动作改变内容，一个动作改变参数 —— 这才叫"迭代"；只做 1 就是"自动整理"，只做 3 就是"报表"。

```
        ┌──────────── 每 7 天（懒触发 / CLI / 手动）────────────┐
        │                                                      │
   L1 流水 ──► Harvest ──► Reflect ──► Consolidate ──► Forget ──► Evaluate ──► Report
   L2 笔记        │           │            │             │           │           │
   L3 事实        └─ 候选打分 ─┘     合并/冲突/提升   衰减/归档   回放指标   周报+commit
                                                    └──────► Tune（可选，单步爬山）
```

## 4. 触发与调度

插件没有自己的定时器，DSH 的 `schedule_create` 是**会话级**提醒（需要有活着的会话），因此采用三级触发：

| 级别 | 机制 | 默认 | 说明 |
|---|---|---|---|
| L1 懒触发 | `agent/session-start` 钩子里检查 `now - evolve.lastRunAt >= intervalDays`，满足则 `void runEvolution()`（后台，不阻塞首步） | **开** | 零依赖、天然按库隔离；缺点是"不打开这个工作区就不会演化"——但记忆只在被使用时才有价值，可接受 |
| L2 CLI 兜底 | `node bin/dev-memory-evolve.mjs --root <ws>`，由 Windows 计划任务每周跑 | 关 | 适合"我一周都不开 DSH 也要整理"的场景；`schtasks /create /tn dsh-memory-evolve /tr "node <repo>\bin\dev-memory-evolve.mjs --root D:\DeepSeek\Harness" /sc weekly /d MON /st 09:00` |
| L3 手动 | 工具 `devmemory_evolve`（admin action=`evolve`），支持 `dryRun`、`windowDays`、`stages[]` | — | 用于调试与"我现在就想整理一下" |

**幂等性**：`evolve.lastRunAt` + `evolve.running`（带 10 分钟租约）保证同一库同一时刻只跑一次；崩溃后租约过期可重入。运行结束无论成败都写 `lastError` 与 `lastOutcome`（供周报与诊断用）。

## 5. 管线阶段（每个阶段独立 fail-open）

约定：每个阶段签名 `stage(ctx): Promise<StageResult>`，`StageResult` 含 `changed[] / skipped[] / metrics{} / notes[]`；任一阶段抛错只记录到 `evolve` 诊断（`level:'unexpected'`），不中断后续阶段；`dryRun=true` 时所有写操作走内存副本，末尾统一输出 diff。

### 5.1 Harvest（采集，窗口 days=7）

输入：L1 `runtime/*.md`（窗口内）、`docs/notes/*.md`（窗口内新增/修改）、现有 L3 全量。
输出：`Candidate[]`。

打分（可解释、可调）：

```
score(c) = 0.35 * freq(c)          // 跨会话出现次数（≥2 才算候选，≥3 加权）
         + 0.25 * explicit(c)      // 显式记忆词命中（保留现有 isExplicitMemoryCandidate 作为高权重信号，而不是唯一信号）
         + 0.20 * recency(c)       // 1 - Δt/窗口
         + 0.10 * novelty(c)       // 与现有 L3 的最大相似度越低越高（1 - maxSim）
         + 0.10 * recurrence(c)    // 同一主题在 ≥2 个不同 L1 日文件出现
```

候选生成（不依赖 LLM 的启发式）：
1. 行级切分 L1：用户消息行、digest 摘要行、`- ` 列表行；过滤工具输出/JSON/代码块/超长行。
2. 主题键 = `normalize(首句主语 + 高频 tag token)`；同主题聚合为一个候选簇。
3. 簇代表句 = 该簇内"信息量最高"的句子（token 数 × 是否含决策词 如"决定/改为/不要/必须"）。
4. 输出 `Candidate { text, kind, topicKey, tags[], score, evidence: [{date, sessionId}] }`，按 score 降序，最多 `maxCandidates=20`。

**阈值**：`score >= harvest.minScore`（默认 0.45）且 `evidence.length >= 2`（不同会话/不同日）才进入 Reflect。这条"至少两个独立来源"是防幻觉的硬约束。

### 5.2 Reflect（提炼）

两档，默认 A：

- **A 档（默认，零成本）**：把 `Candidate` 规范化为 L3 条目草案：`summary`（≤ 60 字，取代表句压缩）、`body`（证据点列表 + 来源日期）、`kind`（沿用 `inferKind` 或按决策词判定 decision/preference/entity/context）、`tags`（topicKey + 主题 token）。
- **B 档（可选，`evolve.reflect='llm'`）**：把候选簇（含证据日期）交给模型做一次"周复盘"，要求输出 JSON 数组（summary/kind/tags/body/confidence），带重试与 schema 校验；预算上限 `llm.maxCharsPerRun=60000`，超限只喂高分候选。LLM 档的产物**仍要过 5.3 的合并与 5.6 的评估**，且首周强制 `apply=false` 观察。

### 5.3 Consolidate（巩固）

对每个草案依次执行：

1. **查重合并**：`findDuplicate()` 升级为"字面 + 可选向量"双通道；`sim >= dedupe.threshold (0.55)` →
   - 合并正文（保留两个来源日期）、tags 取并集、`accesses` 相加、`salience = min(1, max(a,b)+0.05)`；
   - 记 `mergedFrom: [id...]`。
2. **冲突消解**：同 `kind + topicKey` 但结论相反/数值不同（由决策词与否定词对齐检测，或 LLM 档直接判定）→ 新条目写 `supersedes: [oldId]`，旧条目 `salience *= 0.4`、`status: 'superseded'`（不再注入，但保留在库中可追溯）。
3. **提升（promote）**：L2 笔记若在窗口内被 recall 命中 ≥ `promoteMinHits (3)` 次 → 生成 L3 草案（摘要取笔记首段），`tags` 沿用笔记 tags。
4. **L1 → L2 周摘要**：写 `docs/notes/YYYY-MM-DD-weekly-review.md`（即 5.7 的周报，本身就是一条记忆）。

写入顺序：先合并/冲突（改旧），再新增（写新），再提升；全部走 `store.remember/updateEntry/note`，并在结束时 `index.markDirty()` + `vcs.flush('evolve')`。

### 5.4 Forget（遗忘）

```
salience' = clamp01( salience * 0.5 ** (Δt_days / halfLifeDays) + accessBoost )
accessBoost = min(0.3, 0.05 * accessesInWindow)     // 窗口内被访问才有加成
```

- `halfLifeDays` 默认 90；`salience < recall.minSalience (0.25)` 的条目不参与注入（现有逻辑已按此过滤，此处只是让它自然发生）。
- **归档条件**：`accesses == 0` 且 `age > 90d` 且 `salience < 0.2` → 移动到 `spaces/archive/YYYY-MM/<id>.md`（frontmatter 加 `archivedAt`、`archiveReason`），从索引中移除；`devmemory_admin restore` 可原样恢复。
- **不删除**是硬约束：归档 = 移动 + 标记，git 历史完整。
- 每次最多归档 `maxPrune=50` 条，防止一次误判清空。

### 5.5 Evaluate（评估）

**回放集**：从窗口内 L1 抽取最多 `evalSize=20` 条用户问句（长度 ≥ 20 字符、非工具回显、去重），作为 `Q`。回放集**不落库**（含用户原文），只在本进程内存中使用；如需跨周对比，只持久化指标与哈希。

指标定义（周报与调参共用）：

| 指标 | 定义 | 健康区间 |
|---|---|---|
| `hit@5` | 对 q∈Q 跑 recall(top5)，若结果中任一条目在 q 所在会话的后续 ≤3 轮内被 remember/note/update 或文本引用（用 `accesses` 增量 + 文本包含近似）→ 命中；`hit@5 = hits/|Q|` | ≥ 0.35（冷启动除外） |
| `waste@5` | 被召回但 7 天内未再被 access 且未被引用的条目占比 | ≤ 0.5 |
| `coverage` | 新建条目中命中既有 tag 的比例（衡量"新知识是否接到旧知识上"） | ≥ 0.5 |
| `churn` | 本周 L3 变更条目数 / L3 总数 | 0.05–0.2 |
| `growth` | 索引字节 / 条目数 | 趋势下降（v0.8.0 后应稳定在 ~6 KB/条） |
| `archiveRate` | 归档数 / L3 总数 | 0–0.1 |

### 5.6 Tune（调参，可选，默认关）

单步爬山，每周最多动一个参数，幅度 ±20%，候选参数：`dedupe.threshold`、`recall.defaultLimit`、`recall.minSalience`、`forget.halfLifeDays`。

```
score = 0.5*hit@5 + 0.3*(1-waste@5) + 0.2*coverage
if score < lastScore * 0.98:  revert 到 paramsHistory 上一快照（写回 config + git commit '[evolve] revert params'）
else: 记录本周为基线
```

`paramsHistory` 存 `meta.json.evolve.paramHistory`（最近 8 条），人工可 `devmemory_admin` 查看/回滚。**默认关闭**，因为它会改变检索行为，必须等评估数据稳定（建议 ≥4 周数据后再开）。

### 5.7 Report（周报）

写 `docs/notes/YYYY-MM-DD-weekly-review.md`（L2，进 git，可被 recall 检索）：

```markdown
# 周复盘 2026-11-04（窗口 10-28 ~ 11-04）

## 指标
| 指标 | 本周 | 上周 | 趋势 |
|---|---|---|---|
| hit@5 | 0.42 | 0.35 | ↑ |
...

## 变更
- 新增 L3 4 条：…（id + 一行摘要）
- 合并 2 组：A+B → C
- 冲突消解 1 组：D supersedes E
- 归档 3 条：…（原因：90 天零访问）
- 提升 L2→L3 1 条：…

## 观察
- 本周 recall 集中在 FlexOne 的 TI 迁移主题，Harness 侧 0 次检索。
- 候选池 12 个，低于阈值 7 个（阈值 0.45）。
```

报告本身就是"系统对自己这一周的认知"，会进入 L2 并在下周被 Harvest 读到（闭环）。

## 6. 数据模型与文件布局变更

```
.memory/
├── spaces/                 # L3 事实（现有）
│   └── archive/2026-11/    # 新增：归档区（git 保留历史）
├── docs/notes/             # L2（现有；周报写这里）
├── runtime/                # L1（现有）
├── evolve/                 # 新增（.gitignore：内含回放集与打分明细，含用户原文）
│   ├── eval.jsonl          # 可选：仅当用户显式开启持久化
│   └── last-report.json
└── meta.json               # 新增 evolve 段
```

`meta.json` 新增（schemaVersion 仍为 2，字段可选、向前兼容）：

```jsonc
"evolve": {
  "lastRunAt": "2026-11-04T01:00:00.000Z",
  "lastOutcome": "ok",            // ok | partial | error
  "lastError": null,
  "running": null,                // ISO 时间戳 + 租约
  "runs": 12,
  "paramHistory": [ { "at": "...", "params": {}, "score": 0.41 } ]
}
```

L3 条目 frontmatter 新增可选字段：`supersedes: [id]`、`status: "active" | "superseded" | "archived"`、`mergedFrom: [id]`、`archivedAt`、`archiveReason`。解析器需容错（缺省视为 active）。

## 7. 配置

```ts
evolve: {
  enabled: true,
  intervalDays: 7,
  dryRun: false,          // 首周建议 true：只出报告不写库
  windowDays: 7,
  stages: ['harvest','reflect','consolidate','forget','evaluate','tune','report'], // tune 默认不在数组里
  harvest: { maxCandidates: 20, minScore: 0.45, minEvidence: 2 },
  reflect: 'heuristic',   // 'heuristic' | 'llm'
  forget: { halfLifeDays: 90, minAccessAgeDays: 90, minSalience: 0.2, maxPrune: 50 },
  evaluate: { evalSize: 20, k: 5 },
  tune: { enabled: false, step: 0.2, revertBelow: 0.98 },
  llm: { maxCharsPerRun: 60000 }
}
```

与现有配置的关系：`recall.minSalience`、`dedupe.threshold` 继续复用（Tune 改的就是它们）；`digest.*` 不动。

## 8. 安全、回滚与预算

| 风险 | 措施 |
|---|---|
| 自动写坏记忆 | `dryRun` 首周；每次运行**一个** git commit（`[evolve] weekly 2026-11-04: +4 ~2 archive 3`）；`git revert <sha>` 一键撤销 |
| 误归档 | 归档=移动不删除；`maxPrune` 上限；`devmemory_admin restore` 可恢复；周报列出每一条 |
| 幻觉条目 | Harvest 的"≥2 独立来源"硬约束；LLM 档要求 confidence 且首周只 dryRun；新条目 `accesses:0` 时 salience 从 0.5 起（不直接 1.0） |
| 多工作区串库（B1 教训） | 演化**必须**用 `storeForCall` 同源的会话库解析（按 `sessionCwd`）；懒触发时用该会话的 cwd；禁止使用进程全局 `active` |
| 调参震荡 | 默认关；单步 ±20%；下降 >2% 自动 revert；历史保留 8 轮 |
| 成本失控 | 无 LLM 档 0 token；LLM 档字符预算 + 单次运行上限；`evolve.runs` 与耗时写进诊断 |
| 隐私 | 回放集默认不落盘；`evolve/` 进 `.gitignore`；周报只写摘要不贴原文长句 |

## 9. 工具面与可见性

| 入口 | 形式 | 说明 |
|---|---|---|
| `devmemory_evolve` | 新工具（并入 admin 的 action 枚举更省 schema：`devmemory_admin { action: 'evolve', dryRun?, windowDays?, stages? }`） | 手动触发；返回 stage 级 summary |
| session-start | 懒触发 | 静默后台跑，完成后仅记一条 `info` 诊断（不打断会话） |
| WebUI | 「记忆管理」页新增"演化"卡片：上次运行时间 / 结果 / 新增·合并·归档计数 / 最近指标 | 只读展示，复用 status 通道 |
| 周报 | `docs/notes/YYYY-MM-DD-weekly-review.md` | 本身可被 recall |

**注入预算**：不新增常驻注入。boot/status 块保持不变（B1 之后 boot 已是常量），演化结果只在 status 的 diag/evolve 行出现（≤ 1 行，约 20 tokens）。

## 10. 测试计划

单元（纯函数优先，`test/lifecycle.test.mjs`）：
- 衰减：给定 salience/Δt/accesses，断言公式与边界钳制；
- 归档条件：90 天零访问 + 低 salience 才归档；有访问/新条目不归档；
- 合并：相似条目合并后 `mergedFrom`、tags 并集、accesses 相加；
- 冲突：`supersedes` 写入且旧条目 `status=superseded` 后不被 recall 返回。

集成（`test/evolve.test.mjs`，用临时 workspace）：
- `dryRun` 不改任何文件（比对目录树哈希）；
- `apply` 后 git 有一个 `[evolve]` commit 且 `git revert` 能还原；
- 幂等：同一天跑两次，第二次 `skipped: 'not-due'`；
- 租约：并发两次只有一次执行；
- 懒触发：`lastRunAt` 在 8 天前 → session-start 触发一次；2 天前 → 不触发；
- B1 隔离：两个 workspace 各自演化，互不写入。

回归：现有 205 用例全绿；`npm run typecheck`、`npm run verify:dist` 通过。

## 11. 实施阶段与工作量

| 阶段 | 内容 | 预估 | 依赖 |
|---|---|---|---|
| **P0（MVP，先跑通"会长"）** | `evolve` 配置 + 懒触发 + Harvest(启发式) + Consolidate(字面查重/提升) + Forget(衰减/归档) + Report + `dryRun` + 测试 | ~700 行（src/evolve.ts 350、src/lifecycle.ts 180、config/store/index/tools 改动 120、测试 250） | 无 |
| **P1（更聪明）** | 双通道查重（embedding 可选）、冲突消解、L2→L3 提升规则、周报增强 | ~400 行 | P0 |
| **P2（自评估）** | Evaluate 回放指标 + `tune` 单步爬山 + `paramHistory` | ~350 行 | P0/P1 + ≥2 周数据 |
| **P3（可选 LLM 复盘）** | `reflect: 'llm'`，预算与 schema 校验 | ~300 行 | P1 |

建议节奏：P0 上线后**先 dryRun 跑 2 周**，确认 diff 合理再开 `apply`；P2 至少积累 4 周指标后再开 `tune`。

> **状态（2026-10-28）**：P0 已实现并发布 **v0.9.0**。落地规模：`src/evolve.ts` 501 行、`src/lifecycle.ts` 120 行、`bin/dev-memory-evolve.mjs` 84 行、`test/evolve.test.mjs` 253 行（8 个用例）、`docs/evolve.md` 67 行，另改 `src/config.ts`(+109) / `src/store.ts`(+190) / `src/tools.ts`(+33) / `src/index.ts`(+16)。
>
> **状态（2026-10-28，v0.10.0）**：P1/P2/P3 已实现并发布 **v0.10.0**。P1 落 `src/llm.ts`（宿主 `ctx.llm.prepareCall/stream`，默认用当前会话模型，失败回退启发式）+ 语义判重（灰区 `[0.3, dedupeThreshold)` 问 MERGE/KEEP，≤5 次/轮）。P2 落 `evaluate`（回放 `recall(..., {touch:false})` 算 `hit@5/waste@5`）+ `tune`（±10% 单步、`maxDelta` 封顶、变差回滚、历史进 `meta.evolve.tuning`，默认关）。P3 落灰区互链（`links`，≤`link.maxLinks` 对/轮）+ 周报自检段（重复对/孤岛/标签覆盖率/陈旧）。`EvolveStageName` 扩到 7 个；测试 `test/llm.test.mjs`（6）+ `test/evolve.test.mjs`（13），全量 224 通过。

## 12. 风险与开放问题

1. **回放集质量**：从 L1 抓的"问句"可能包含工具回显/长 prompt，需过滤规则；否则 hit@5 不可信。
2. **hit@5 的近似**：用 `accesses` 增量推断"被用到"会漏（模型可能直接引用而不调用工具）。备选：分析后续 assistant 文本是否包含条目关键词。需在 P2 用真实数据校准。
3. **归档的不可逆感**：用户可能不习惯"条目消失"。缓解：周报逐条列出 + `devmemory_recall` 加 `includeArchived` 开关（默认关）。
4. **周报会不会污染检索**：周报是摘要型 L2，可能抢占 recall 位置。缓解：周报 tag 固定 `weekly-review`，`recall` 对单一 tag 洪泛做抑制（P1）。
5. **懒触发的时间漂移**：只在打开工作区时触发，实际间隔可能 7–14 天。可接受；如需严格周期，用 L2 CLI。
6. **是否该让演化改插件自己的代码**（真正的 self-improving）：本设计明确不做，P2 之后可评估"从重复教训生成 skill patch"的独立机制。

## 13. 验收清单（v0.9.0 done 定义）

- [x] `dryRun` 一周后，输出 diff 与周报，人工确认为"合理整理"（v0.9.0：dry-run 报告 + 8 个测试用例覆盖；真实库首轮 dry-run 已跑通，见下）
- [x] 打开 `apply` 后，每次运行产生 1 个 `[evolve]` commit，`git revert` 可还原（实测 commit 标题 `[dev-memory] [evolve] weekly YYYY-MM-DD (l2: note …weekly-review.md)`）
- [ ] `hit@5` 与 `waste@5` 在周报中连续 3 周可比较（标 P2，需回放评估）
- [x] 归档条目 100% 出现在周报"归档"节，且 `restore` 可用（`test/evolve.test.mjs` 归档/恢复用例）
- [x] 两工作区并行运行互不污染（沿用 v0.8.0 B1 的 `exec.agent.session.header.cwd` 解析，lifecycle 回归用例）
- [x] 全量测试 213 绿（205 基线 + 8 演化）、typecheck/verify:dist 通过

> 真机首轮观察（2026-10-28，`D:\DeepSeek\Harness\.memory` 55 条 L3）：dry-run 扫描 1 行流水（窗口内仅 1 个日文件）、候选 0、衰减 55 条、归档 0 条、churn 0%——符合"历史库首轮主要做衰减、不出新条目"的预期；要看到"新增 L3"需要窗口内有 ≥2 天、且同一话题被重复提到的流水。
