# 周演化运维指南（v0.9.0 / P0）

> 设计动机与算法细节见 [design/DESIGN-evolve-v0.9.md](design/DESIGN-evolve-v0.9.md)。
> 本文只讲"怎么开、怎么跑、怎么回滚、出问题怎么查"。

## 一句话

每个工作区的 `.memory` 库，默认每 7 天在会话启动时**自己复盘一轮**：把 L1 流水里的反复/显式内容提炼成 L3，合并重复，衰减归档死记录，写一份周报到 `docs/notes/`。全程无 LLM 调用、每轮一个 `[evolve]` git commit、被归档的条目可恢复。

## 开启 / 关闭

默认**开启**（`config.evolve.enabled = true`）。关闭的三种方式：

1. DSH 设置 →「记忆管理」→ 关掉 `evolve.enabled`。
2. 用 schema 文件 / profile 配置覆盖 `evolve.enabled: false`。
3. 临时：`devmemory_admin(op="evolve", dryRun=true)` 只看不写（但懒触发仍会跑正式轮）。

## 三种运行方式

### 1. 懒触发（默认，不用管）

`agent/session-start` 时检查：

```
now - meta.evolve.lastRunAt >= intervalDays (默认 7 天)
且 now - meta.evolve.running 超过 10 分钟租约
```

满足则后台 `void runEvolution(...)`，不阻塞会话；会话日志出现：

```
[dev-memory] 周演化完成：新增 3 / 合并 1 / 归档 2（842ms）
```

### 2. Agent 手动（会话内）

```text
devmemory_admin(op="evolve", dryRun=true)        # 先看计划
devmemory_admin(op="evolve")                     # 正式跑
devmemory_admin(op="evolve", windowDays=14)      # 采两周
devmemory_admin(op="evolve", stages=["harvest","report"])  # 只采集+出报告
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
node bin/dev-memory-evolve.mjs --root . --stages harvest,report --window 14
```

- `--root` 省略时：`$DEV_MEMORY_ROOT` → `process.cwd()`；库位 = `<root>/.memory`。
- 退出码：`0` 完成、`1` 未运行（禁用 / 租约占用 / 未到间隔）、`2` 有阶段报错（报告里 `errors` 有明细）。
- 适合 cron：`0 9 * * 1  cd /repo && node node_modules/dsh-plugin-memory-3t/bin/dev-memory-evolve.mjs --root .`

## 一轮做了什么

| 阶段 | 输入 | 输出 |
|---|---|---|
| harvest | 最近 `windowDays` 的 `runtime/*.md` | 候选列表（打分 + 证据条数） |
| reflect | 候选 | L3 草稿（kind/tags/summary） |
| consolidate | L3 草稿 + 现有 active L3 | 新建 / 合并（`mergedFrom`） |
| forget | 全部 active L3 | salience 更新 + 归档（`spaces/archive/YYYY-MM/`） |
| report | 全过程 | `docs/notes/YYYY-MM-DD-weekly-review.md` + 索引重建 |

## 出问题怎么查

| 现象 | 查什么 |
|---|---|
| 没触发 | `devmemory_status` 里 `evolve.lastRunAt`；`meta.json` 的 `evolve` 段；间隔是否 < 7 天 |
| 跑完没变化 | 报告里的 `harvest.candidates` 数量；`minScore`/`minEvidence` 是否过高；L1 里是否真有多日重复内容 |
| 归档太多想恢复 | `devmemory_admin(op="restore", id="<id>")`；`listArchived()` 在 devmemory_status 之外用 CLI/脚本查 `spaces/archive/` |
| 想整轮回滚 | `git log --grep='^\[evolve\]'` → `git revert <hash>` |
| 阶段报错 | 报告 `errors[]`；`devmemory_admin(op="diag", level="error")` |
| 卡住不跑 | `meta.evolve.running` 是否残留（>10 分钟租约会自动失效；也可手工 `updateEvolveState({running:null})`） |

## 成本

- 默认零模型调用；一轮只有分词/打分/Jaccard，84 篇库 < 1 秒。
- 每轮 1 个 git commit + 1 篇 L2 周报（几百字节到几 KB）。
- 手动 `devmemory_admin(op="evolve")` 时报告会进上下文（几百 token）。

## P0 边界

- `reflect` 仅启发式（`'llm'` 预留 P1）：只做"提炼 + 归类"，不生成洞见。
- `tune`（自调参）默认关；`hit@5/waste@5` 评估标 P2。
- 老库首轮可能批量归档，**先 dry-run 两周**再开正式。
