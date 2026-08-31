# REVIEW-GUIDE — 审查者双轴检查清单（TL 备）

> 供审查者子代理使用。报告产出 `docs/team/REVIEW.md`，格式：每发现一条 = `[blocker|major|minor] 编号: 问题 → 期望 → 实际`。blocker/major 必须打回工程师修复；minor 记录即可。

## A. 标准轴（代码质量与工程规范）

- **A1** TS strict：`tsc --noEmit` 零错误；无 `any` 滥用；类型自洽。
- **A2** 零运行时依赖：package.json `dependencies` 为空；peerDependencies 仅声明必要项（若 DSH 约定要求）。
- **A3** 命名一致性：工具 `devmemory_*` ×7、skill `dev-memory`、boot context `dev-memory-boot`、包名 `dsh-plugin-memory-3t`——全文无残留 `memory3t`/`dsh-memory-3t` 旧名。
- **A4** 结构：无未完成 TODO 占位；注释解释"为什么"而非复述"做什么"；模块职责单一。
- **A5** 错误处理：所有外部可触发路径 fail-open（记忆故障不得抛到会话）；digest 全流程 try/catch；索引损坏退化为扫描/报状态。
- **A6** 安全：路径参数全部过 `safeJoin`（`..` 逃逸拒绝）；audit 日志存在；无密钥/敏感信息进 prompt 返回。
- **A7** 权限：目录 0o700 / 文件 0o600 尽力而为且不因权限失败抛错（Windows 说明）。
- **A8** 提交面：cordis.patch.yml 与 INSTALL 说明一致（指向 dist 产物或源码的表述自洽）；README 配置表与代码默认值一致。

## B. 规格轴（逐条 AC 证据）

- **AC1 包结构**：文件齐全；`npm run build` 产出 dist；`npm run typecheck` 过。
- **AC2 三层存储**：`<root>/runtime|docs|spaces` 布局与 frontmatter 格式符合 ARCHITECTURE §2；meta.json/audit.jsonl 存在并被读写。
- **AC3 .gitignore 自维护**：有测试且逻辑正确（存在且缺 `.memory` 才追加；不创建文件当没 .gitignore）。
- **AC4 BM25**：中英分词；查询分组排序；中文 2-gram 用例真实断言通过。
- **AC5 7 工具**：defineTool 定义完整（name/description/parameters object-rooted output+render/execute）；schema 约束（enum kind、required）；路径校验用例。
- **AC6 skill**：`ctx.skills.register` name 合法 kebab、content 非空且 == `skills/dev-memory.md`（与 design 源文件一致）。
- **AC7 生命周期**：事件接线存在；session-start 装载视图不阻塞；boot context order=-200 且 text 函数化；pre-step 决策（注入或按 ADR#3 明确跳过并记录）；turn-stopping digest。
- **AC8 digest**：确定性逻辑（候选提取/dedupe/promote 上限/link/compact）；fail-open 异常注入测试；meta.digest 状态写盘；补做逻辑。
- **AC9 配置**：默认值与 SPEC 一致；数值钳制。
- **AC10 README**：中文、含安装/配置/使用/限制；限制诚实（无 embedding、digest 确定性、Windows 权限、workspace 根回退、pre-step 可能跳过）。

## C. 执行验证（审查者必须自己跑，不轻信报告）

```powershell
cd D:\DeepSeek\Harness\dsh-plugin-memory-3t
npm run typecheck          # 必须零错误
npm test                   # 必须全绿；记录用例数与失败数
```

审查者不改代码；发现 blocker/major → 在 REVIEW.md 记录并明确"打回"。