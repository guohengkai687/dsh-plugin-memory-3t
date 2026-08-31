# TL-NOTES — DSH 接口签名核实（TL 亲自验证）

> 用途：工程师实现时的权威参考；与架构师 `ARCHITECTURE.md` 交叉核对，冲突时以本文件 + 源码行号为准（本文件所有内容均来自 TL 实际读过的源码）。

## 1. 工具注册（dsh-tools）

来源：`E:\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-tools\lib\index.js`

模式：`defineTool(options)`（line 830–882）返回 registry-ready 定义，再传给 `ctx.tools.register(...)`。

```ts
defineTool({
  name: 'devmemory_recall',            // string
  description: '…',                     // string
  parameters: {                         // value schema DSL（JSON 谱，见下）
    type: 'object',
    properties: {
      query: { type: 'string', description: '…' },
      maxResults: { type: 'number', description: '…' }, // 可选
      layers: { type: 'array', items: { type: 'string', enum: ['l1','l2','l3'] } },
    },
    required: ['query'],
  },
  output: {
    schema: { type: 'object', properties: { … }, required: [ … ] }, // object-rooted
    render(args, value) { return [{ type: 'text', text: String(value) }] },  // 必选；必须返回 ContentBlock[]，见 7
  },
  timeoutMs: 30_000,                    // 可选
  async execute(args, exec) { … return result },  // 必选；args 已按 schema 校验
})
```

- schema DSL：乐观 JSON 谱（`type/properties/items/enum/required/description/title/default/examples`）；`required: true` 逐属性标记；output.schema 必须 object-rooted。
- `execute(args, exec)`：args 传入前已自动校验（违规抛 `ToolArgsError`）；exec 带 `signal`、`agent` 等（code-mode 参考）。工具实现返回普通对象即可。

## 2. 注入"插件消息"到 pre-step（参考 dsh-mnemon，真实运行插件）

`dsh-mnemon` 自定义 helper（`.tmp\plugin-eval\mnemon-src\src\lifecycle.ts` line 91–103）：

```ts
function createPluginMessage(text: string, form: 'recall'|'notice'|'instructions', summary?: string) {
  return structuredClone({
    id: crypto.randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    source: { kind: 'plugin', plugin: 'dsh-mnemon', form, ...(summary ? { summary } : {}) },
  })
}
```

pre-step handler 修改决策（`lifecycle.ts` line ~328）：`return { kind: 'enter', messages: [...decision.messages, createPluginMessage(reminder, 'instructions', '…')] }`。
→ 我们的插件将 `plugin: 'dsh-plugin-memory-3t'`、`form: 'instructions'`。

## 3. 生命周期事件 payload（参考 mnemon contracts + agent-loop）

- `agent/session-start`：`{ agent, source: 'startup'|'resume'|'clear'|'compact' }`
- `agent/pre-step`（waterfall）：`{ agent, messages: HostUserMessage[], turn, step, signal }`（mnemon 接口定义；DSH agent-loop `lib/index.js` line 501 处 waterfall dispatch）
- `agent/turn-stopping`（serial）：`{ agent, turn, signal }`
- `agent/created`：`{ agent }`（mnemon `AgentEventPayload`）
- `agent.followup(input)`：agent-loop line 396 存在

## 4. Skill 注册（dsh-skill）

来源：`dsh-skill\lib\index.js` line 193–215：

```ts
ctx.skills.register({
  name: 'dev-memory',                    // kebab-case /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  description: '…',                      // 非空
  whenToUse: '…',                        // 可选
  content: readFileSync(new URL('../skills/dev-memory.md', import.meta.url), 'utf8'),
  invocation: { modelInvocable: true, userInvocable: false },  // 可选，默认双 true
  // provider 可选，默认 'runtime'
})
```
优先级：项目级 `.dsh/skills/<name>/` > runtime > 用户级 `~/.agents/skills/`。same-scope 重名 first-wins（重复仅告警）。

## 5. System Prompt context（dsh-system-prompt）

来源：`dsh-system-prompt\lib\index.js` line 196–199：

```ts
ctx.systemPrompt.context({
  name: 'dev-memory-boot',   // 非空，同 scope 内唯一
  order: -200,               // 必须有限数字；context 按 order 升序渲染
  text: () => store.renderBootBlock(config),   // string 或 (context)=>string
})
```

## 6. 本机工具链（已实测）

- node v24.15.0；`node --test --test-isolation=none` 可用。
- npm 可联网；typescript 建议 `typescript@^5` devDependency（探针 v7 native 版行为未验证）。
- Windows 无 POSIX 权限语义；0700/0600 按 Node 可设最小位实现 + README 说明，测试断言内容与存在性。

## 7. 运行时实测纠偏（2026-08 真机 headless e2e 发现）

- **`output.render` 必须返回 ContentBlock 数组**（`[{type:'text',text}]`），不能返回字符串。
  证据：`dsh-tools\lib\index.js:3415` `content = snapshotProjection('render', rendered)`——render 返回值原样成为
  tool-result 消息的嵌套 content；`dsh-llm\lib\types\content.js:29-32` `contentHasImage` 对
  `tool-result` 块 `block.content` 递归，字符串时抛 `content.some is not a function`；
  文本模型（如 deepseek-v4-flash）每次请求都跑 `projectImagesForTextModel` → 必炸。
  对照内置工具 `dsh-tool-todo\lib\index.js:167-170` 的 render 返回 `[{ type:'text', text }]`。
- 验证方式：`dsh --profile headless <任务>` 让模型真实调用工具（在任务工作目录写 `.memory/`），
  纯文本任务不触发、工具调用后下一条 LLM 请求触发。——单元测试覆盖不到，属集成面。
- `dsh plugin --profile <name> add <tarball>`：成功安装后自动把声明 `dsh.bundle.patch` 的包追加进
  `dsh.profile.bundles`（`dsh\lib\plugin-9h8shc4d.js` reconcile）；本地包需先 `npm pack`。
- headless 冒烟：`--dump-config` 验证组合树含 `# == dsh-plugin-memory-3t` 段；`--patch overlay.yml`
  可临时 `- id: <name>, disabled: true` 做对照。

## 8. v0.2 git 回溯（设计核实 + 实测）

- **选型（用户确认）**：`.memory/` 独立嵌套仓库 + 防抖(1s)/计数(8)合并提交 + 边界 flush；
  工具面 history/diff/restore（7→10）。`vcs.gitDir` 为预留分离仓库位（`--separate-git-dir`）。
- **零依赖**：`src/vcs.ts` 直接 `child_process.spawn('git', …)`，无 npm 依赖；构造函数可注入
  `gitBinary`（测试降级路径用假二进制名）。
- **降级自愈**：`status()` 对每个 git 命令检查退出码，任一失败即置 `ready=false` 并进入
  degraded（仓库被删后不再假装可用）；`record()/flush()` 在非 ready 时安静返回。
- **恢复安全网（核心语义）**：`git restore --source=<ref> -- <targets>` 只改工作区、不回写历史；
  恢复前 `flushInner('restore 前检查点')`（无未提交变更时为 null）；恢复本身是带 `restore <ref>` 
  前缀的新提交。targets 经 `expandTargets` 防逃逸（层名 l1/l2/l3 或库内相对路径，拒 `..`/绝对/盘符）。
- **忽略规则**：库内 `.gitignore` 只忽略 `index.json`；`meta.json`/`audit.jsonl` 入库。
- **Windows 实测坑**：
  - git 冷启动慢（本机单次操作 2.4–4.5s）——提交走 `enqueue` 串行 + 防抖合并，不阻塞会话；
    测试直接 `node --test` 而非 `npm test` 时不重建 dist（stale 代码易误判）。
  - 沙箱下 node spawn git 的管道 stdio 被禁（EPERM）→ 集成测试需放开权限运行；`git --version`
    探针同样受影响（曾把"有 git"误判为"无 git"而跳过全部集成测试）。
  - lifecycle 测试的 `apply()` 异步 `store.init()` 不 await → rm 目录时 git 冷启动进程仍持有
    cwd → EBUSY；已在该类测试配置 `vcs.enabled: false`（其职责是接线而非 git）。
  - `git diff --numstat <ref>` 语义：恢复预览中"快照后删掉的文件"显示为 `D` 而非 `A`。
- 集成测试 13 个（真实 git：init/忽略/边界提交/batch/restore 闭环/工具面冒烟/降级/关断/删 .git 兼容）；
  全套 71/71。

## 9. v0.2 剩余项落地（embedding / pack / gitDir 正式化）

- **版本**：0.2.0 → 0.2.1；README 路线图 v0.2 全部 ✅（git 回溯 + embedding + pack/unpack + gitDir +
  项目级 SKILL.md 覆盖示例）。测试 95/95 全绿（16 例真实 git 集成 + 6 路 embedding mock + pack 往返/防逃逸）。

### 9.1 embedding（Ollama，默认关，`src/embed.ts`）

- 零依赖：Node 全局 `fetch` + `AbortSignal.timeout`；fetch 可注入（`EmbeddingClient.fetchImpl`）——
  因本机无 Ollama 服务，真实链路用 mock 全覆盖，真机留待有 Ollama 的环境。
- **API 兼容**：先 POST `/api/embeddings`（旧），404 回退 `/api/embed`（新，`{embeddings:[...]}`）。
- 写路径只在 **L2/L3** 挂向量（L1 高频流水不嵌入，对齐 DESIGN「L2/L3 写入时同步生成」）；向量存
  `<库>/vectors/<base64url(docKey)>.json`（`:`/`/` 安全编码），与 index.json 同列派生物（库内
  .gitignore 忽略、不随 pack 迁移、不入 git）。
- **融合**：`fuseScore = 0.6×余弦 + 0.4×归一化 BM25`（无向量文档退化为 0.4×归一化 BM25）；
  语义补漏（无词面命中但向量相近）仅在向量文件 ≤ 2000 时全量扫描（规模保护）。
- 实测坑：`EmbeddingClient.ping()` 最初不禁用短路，导致禁用态测试真的去请求网络 → 补
  `if (!enabled) return false`；`devmemory_status` 工具最初漏返回 `embedding` 字段（tools.ts 显式
  组装返回值而非透传 snapshot）→ 补上。

### 9.2 pack/unpack（`src/pack.ts` + `src/cli.ts` + `bin/`）

- 产物 `.dmmem` = gzip(JSON 清单 {schemaVersion:1, files:[{path,content}]})；排除 `.git`
  （目录或指向分离 gitDir 的 `.git` 文件，精确解析 `gitdir:` 行）、`index.json`、`vectors/`。
- 解包防逃逸：`..`/绝对/盘符/空段拒绝（`validateRelPath` + safeJoin）。
- CLI bin 入口 `bin/dev-memory-pack.mjs`（含 shebang）import `dist/cli.js` 的 `main()`——tsc 不保留
  shebang 所以不放 legacy bin 单文件。
- 实测坑：`packLibrary` 最初对不存在根静默返回 0 文件成功 → 增加 `stat` 校验报错退出码 1。

### 9.3 gitDir 分离仓库正式化（`src/vcs.ts`）

- `gitDir` 相对值基于**记忆库根**解析（原实现 `resolve(config.gitDir)` 相对 process.cwd()，是 bug）。
- 实测坑（git 真机暴露，mock 测不出）：git **不给** `--separate-git-dir` 建父目录，库内相对路径
  （如 `meta/git-store`）init 直接失败（"Invalid path … No such file or directory"）→ 先
  `mkdir(dirname(gitDir), {recursive:true})`；分离仓库 init 必须带 `-b <branch>`（不带则分支
  为 master，旧 git 回退 plain init + symbolic-ref）。
- 库内 gitDir 自动写入库内 .gitignore（防止 `git add -A` 把元数据目录当工作区内容跟踪，实测
  `git ls-files` 不含 git-store）；gitDir 等于库根直接拒绝（fail-open 降级）。

### 9.4 项目级 SKILL.md 覆盖示例

- `docs/project-skill-override.md`：完整覆盖示例（协议收窄版本）+ 验证覆盖生效的办法；
  README Skill 节加链接。协议层可被项目级覆盖是 v0.1 设计承诺，v0.2 补齐示例验收。

## 10. v0.3 落地（WebUI 面板 / scope:user / subagent 继承 / 整库 restore / recallNudge）

- **版本**：0.2.1 → 0.3.0；README 路线图 v0.3 全部 ✅。测试 112/112 全绿 0 跳过（16 例真实 git 集成
  + 5 例 nudge 调度 + 5 例 WebUI 路由 + 2 例 scope + 整库时间片真实 git 反转断言）。

### 10.1 只读 WebUI 面板（`src/webui.ts`）

- **落点**：DSH host 的 `ctx.webServer`（`dsh-host-webserver\lib\types\index.d.ts`）——
  `WebServer.register({kind:'exact'|'prefix', path, handler})`，prefix 匹配 p 与 p/<anything>。
  内部插件（dsh-client-hmr / dsh-client-connection）就是这么注册的；DSH 无公开"插件 UI"框架，
  本地 HTTP 路由就是官方路径（`webserver/index-inject` 只是 index.html 注入行，不适合做页面）。
- **探测**：`ctx.get('webServer')` 优先、`ctx.webServer` 属性兜底，两路 try/catch——headless 无该
  服务时静默跳过；有竞态（webServer 晚于插件 apply 就绪）→ 首个 `agent/session-start` 补注册一次。
- **只读语义**：无任何写端点；检索走 `store.recall(..., {touch:false})` —— 页面检索不提升 L3
  accesses/salience、不产生 git 待提交（实测断言 pendingWrites===0）。
- 页面自包含（内联 CSS + 原生 JS，零外部请求）；API `/api/status` + `/api/search`（q 必填 /
  layers 白名单 / maxResults 钳制 1..50）；405/404 齐备。
- 实测坑：静态页模板里的 `</script>` 字符在 .ts 模板串里合法，但**禁止**用于 webserver 的
  `IndexInjection` script 行（那是另一个契约，与本面板无关）。

### 10.2 scope: user 全局库（`src/config.ts` / `src/paths.ts` / `src/store.ts`）

- `resolveRoot(workspaceRoot, storageDir, scope)`：user 时基准 = `os.homedir()`（相对路径基于主
  目录；绝对路径仍原样）。Windows 上 `os.homedir()` 优先 `USERPROFILE` 环境变量（实测可改）——
  scope 测试靠临时改写 USERPROFILE/HOME 指向 tmp 目录，先断言 `store.root` 再 init，绝不在真主
  目录产生副作用。
- **user 粒度跳过 `maintainGitignore()`**（库在工作区外，改工作区 .gitignore 是污染）；workspace
  粒度行为不变（有 .gitignore 才追加，不创建——设计如此，非 bug）。
- 状态面：`StoreStatusSnapshot.scope` / `devmemory_status.scope` / boot 块库根行标注"（全局库，跨
  工作区共享）"；WebUI status 同样显示。

### 10.3 subagent 视图继承（`src/index.ts`）

- 维护 `viewBySession: Map<sessionId, AgentView>`（session-start 装载后登记）；
  `agent/created` 时取 `agent.session.header.parentSession`，命中则把父视图复制给子 agent
  （`reminded` 独立计数归零）。根会话（无 parent）登记为追忆候选。
- 细节：子 agent 自己的 session-start 会重新装载（内容与父一致，天然覆盖继承值）；继承的价值在
  created → session-start 之间的 boot 装配（避免子 agent boot 无 L1/L3 注入）。

### 10.4 restore 整库时间片（`src/vcs.ts` / `src/tools.ts`）

- `expandTargets` 支持 `'all'` → git 根相对路径 `'.'`（与其它 target 混用也归一为整库）；
  工具层 targets 省略 / 空数组 / 含 all → 整库；返回展示层把内部 `'.'` 呈现为 `all`。
- 真实 git 断言：快照后删除 A + 新增 B → 整库 restore 反转到快照（A 回来、B 消失）；
  `git restore --source=<ref> -- .` 对"ref 之后新增的已跟踪文件"会从工作区删除（checkout 语义）。
- 边界：整库 restore 同样先 checkpoint、恢复本身留痕提交；`index.json`/`vectors/` 派生物不受影响。

### 10.5 recallNudge（`src/nudge.ts`，默认关）

- 30–240 分钟随机间隔（`nudgeDelayMs` 可注入 random）+ `agent.followup`（DESIGN §4.3 对齐 ltb）；
  `RecallNudgeController` 的延时实现可注入（默认 node setTimeout + unref），启用才 arm，
  触发后回调再重新调度，dispose 取消。
- 目标挑选：只挑"已激活、没提醒过、带 followup"的**根**会话（subagent 不打扰），一次一个；
  会话缓冲无内容（`sessionBuffer.length===0`）不发。文案标注"非用户输入"（skill 协议也已声明
  这类消息不是用户指令）。
- 接线：`ctx.on('dispose', () => nudge.dispose())` try/catch 包裹（stub ctx 无该事件也不崩）。

### 10.6 v0.3 已知留待真机

- WebUI 面板的真实 HTTP 面（web GUI 重启后打开 `http://127.0.0.1:<端口>/dev-memory/` 核对）；
  单测覆盖了路由逻辑与注册，未覆盖与宿主 webServer 的握手。
- recallNudge 的真机 followup（默认关，需用户开 `recallNudge.enabled: true` 后观察一轮）。

## 11. 设计档案搬迁（2026-08）

- 设计文档从仓库外的 `D:\DeepSeek\Harness\design\memory-3t\` 归纳迁入插件目录
  **`docs/design/`**（`DESIGN.md` + `skill.dev-memory.md` 草案），旧目录已删除 —— 设计档案与代码同仓，
  避免双份漂移。同步更新了 README（设计参考链接）、docs/team/{context,SPEC,ARCHITECTURE,TASKS}.md 的引用。
- DESIGN.md 附录 B 文件清单已对齐 v0.3 源码结构（vcs/pack/cli/nudge/webui/render/paths/frontmatter + 10 工具 + docs 布局）。
- 教训：设计文档应从一开始就收在插件仓库内；迁出到共享区看似集中，实则在后续版本迭代时
  （v0.2/v0.3 大量实现细节只写进 TL-NOTES 而非 DESIGN）容易与代码脱节。