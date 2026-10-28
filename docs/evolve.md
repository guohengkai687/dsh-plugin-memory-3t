# 周演化运维指南（v0.9.0 起；v0.10.0 完成 P1–P3）

> 设计动机与算法细节见 [design/DESIGN-evolve-v0.9.md](design/DESIGN-evolve-v0.9.md)。
> 本文只讲"怎么开、怎么跑、怎么回滚、出问题怎么查"。

## 一句话

每个工作区的 `.memory` 库，默认每 7 天在会话启动时**自己复盘一轮**：把 L1 流水里的反复/显式内容用**当前会话的大模型**提炼成 L3，合并重复（字面 + 语义），衰减归档死记录，给相关条目互链，回放本周提问算 `hit@5/waste@5`，最后写一份周报到 `docs/notes/`。每轮一个 `[evolve]` git commit、被归档的条目可恢复；模型不可用时自动退回启发式。

## 开启 / 关闭

默认**开启**（`config.evolve.enabled = true`）。关闭的四种方式：

1. DSH 设置 →「记忆管理」→ 关掉 `evolve.enabled`。
2. 只在本地跑（不调模型）：`config.evolve.reflect = 'heuristic'`（其余阶段照常）。
3. 用 schema 文件 / profile 配置覆盖 `evolve.enabled: false`。
4. 临时：`devmemory_admin(op="evolve", dryRun=true)` 只看不写（但懒触发仍会跑正式轮）。

## 三种运行方式

### 1. 懒触发（默认，不用管）

`agent/session-start` 时检查：

```
now - meta.evolve.lastRunAt >= intervalDays (默认 7 天)
且 now - meta.evolve.running 超过 10 分钟租约
```

满足则后台 `void runEvolution(...)`，不阻塞会话；会话日志出现：

```
[dev-memory] 周演化完成：新增 3 / 合并 1 / 归档 2 / 互链 4 / 提炼=llm（1842ms）
```

### 2. Agent 手动（会话内）

```text
devmemory_admin(op="evolve", dryRun=true)        # 先看计划
devmemory_admin(op="evolve")                     # 正式跑
devmemory_admin(op="evolve", llm=false)          # 本轮强制启发式
devmemory_admin(op="evolve", windowDays=14)      # 采两周
devmemory_admin(op="evolve", stages=["harvest","evaluate","report"])  # 只采集+评估+出报告
```

### 3. CLI（cron / 脚本 / 无 agent 环境）

```bash
# 预览
node bin/dev-memory-evolve.mjs --root /path/to/workspace --dry-run

# 正式
node bin/dev-memory-evolve.mjs --root /path/to/workspace

# 机器可读
node bin/dev-memory-evolve.mjs --root . --json > report.json

# 只跑部分阶段 / 换窗口
node bin/dev-memory-evolve.mjs --root . --stages harvest,evaluate,report --window 14
```

- CLI 没有宿主 LLM 服务，`reflect` 永远是启发式（报告里 `llm.used=false`）；需要 LLM 提炼就在会话里手动触发，或走懒触发。
- `--root` 省略时：`$DEV_MEMORY_ROOT` → `process.cwd()`；库位 = `<root>/.memory`。
- 退出码：`0` 完成、`1` 未运行（禁用 / 租约占用 / 未到间隔）、`2` 有阶段报错（报告里 `errors` 有明细）。
- 适合 cron：`0 9 * * 1  cd /repo && node node_modules/dsh-plugin-memory-3t/bin/dev-memory-evolve.mjs --root .`

## 一轮做了什么

| 阶段 | 输入 | 输出 |
|---|---|---|
| harvest | 最近 `windowDays` 的 `runtime/*.md` | 候选列表（打分 + 证据条数）+ 最多 8 条回放问题 |
| reflect | 候选 + 现有 L3 标题 | L3 草稿（LLM 优先，失败回退启发式） |
| consolidate | L3 草稿 + 现有 active L3 | 新建 / 合并（字面或语义，`mergedFrom`）+ 灰区互链（`links`） |
| forget | 全部 active L3 | salience 更新 + 归档（`spaces/archive/YYYY-MM/`） |
| evaluate | 回放问题 + 索引 | `hit@5` / `waste@5`（回放不增 accesses） |
| tune | 指标 + `meta.evolve.tuning` | 阈值微调 / 回滚（默认关） |
| report | 全过程 | `docs/notes/YYYY-MM-DD-weekly-review.md` + 索引重建 |

## LLM 用在哪（P1）

| 环节 | 触发条件 | 次数上限 | 失败表现 |
|---|---|---|---|
| 提炼（reflect） | `reflect: 'llm'` 且有可用路由 | 1 | 回退启发式，`report.llm.failures += 1`，不算演化失败 |
| 语义判重（consolidate） | 相似度落在 `[0.3, dedupeThreshold)` 且 `semanticMerge` | 5 | 当作 KEEP（保留新条目） |
| 路由 | `config.evolve.llm.provider/model` 显式覆盖 > 当前会话模型 | — | 两者都没有 → 全程启发式 |

预算：`llm.maxTokens` 默认 800、`llm.timeoutMs` 默认 60000；报告里有 `llm {used, source, route, calls, failures}`。

## 指标与调参（P2）

- `hit@5`：本周真实提问里，前 5 条命中与提问有词面交集的占比——**高 = 库记得住你问过什么**。
- `waste@5`：命中的前 5 条里，得分低于 top×0.3 的占比——**高 = 召回凑数**。
- 开启 tune：`config.evolve.tune.enabled = true`。规则：`hit@5 < 0.5` → `minScore` 降 10%；`waste@5 > 0.6` → 升 10%；单次变化不超过 `tune.maxDelta`（默认 0.2，即 baseline×0.8–1.2）；若比上轮 `hit@5` 低 >0.02 → 回滚 baseline。
- 历史在 `meta.json#evolve.tuning.history`（最近 20 条），可用 `devmemory_status` 或直接看文件。
- 指标是**相对值**：样本少（<4 条提问）时波动大，建议开 tune 前先积累两周数据。

## 出问题怎么查

| 现象 | 查什么 |
|---|---|
| 没触发 | `devmemory_status` 里 `evolve.lastRunAt`；`meta.json` 的 `evolve` 段；间隔是否 < 7 天 |
| 跑完没变化 | 报告里的 `harvest.candidates` 数量；`minScore`/`minEvidence` 是否过高；L1 里是否真有多日重复内容 |
| LLM 没生效 | 报告 `llm {used, source, route}`；宿主是否有可用 provider；`config.evolve.llm` 是否写错 |
| LLM 一直失败 | `report.llm.failures` + `errors`；常见原因：无 provider、额度用尽、超时（调大 `llm.timeoutMs`）、返回非 JSON |
| 归档太多想恢复 | `devmemory_admin(op="restore", id="<id>")`；`listArchived()` 在 devmemory_status 之外用 CLI/脚本查 `spaces/archive/` |
| 想整轮回滚 | `git log --grep='^\[evolve\]'` → `git revert <hash>` |
| 阶段报错 | 报告 `errors[]`；`devmemory_admin(op="diag", level="error")` |
| 卡住不跑 | `meta.evolve.running` 是否残留（>10 分钟租约会自动失效；也可手工 `updateEvolveState({running:null})`） |

## 成本

- 本地阶段零模型调用：分词/打分/Jaccard/回放，84 篇库 < 1 秒。
- LLM 阶段默认开：通常一轮 1–3 次调用（提炼 1 + 灰区判重 ≤5），每轮 `maxTokens` ≤800。
- 每轮 1 个 git commit + 1 篇 L2 周报（几 KB）；手动触发时报告进上下文（几百 token）。

## 边界（v0.10.0 现状）

- 提炼与判重已用 LLM；**洞见式归纳（P4 方向）**还没有——当前只做"提炼 + 归类 + 合并"。
- `tune` 默认关，且只在 `hit@5/waste@5` 两个指标上小步调整。
- 回放问题取自 L1 用户行，样本少时指标噪声大。
- 老库首轮可能批量归档，**先 dry-run 两周**再开正式。
