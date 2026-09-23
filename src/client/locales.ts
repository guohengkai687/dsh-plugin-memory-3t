/**
 * 「记忆管理」设置页文案（zh/en）。
 * 键与 ui-settings 插件的 locale.register 约定一致（普通字符串字典）。
 */

export type LocaleKey =
  | 'nav'
  | 'openPanel'
  | 'openPanelHint'
  | 'groupWebui'
  | 'webuiEnabled'
  | 'webuiEnabledHint'
  | 'groupDiag'
  | 'diagEnabled'
  | 'diagEnabledHint'
  | 'diagMaxEvents'
  | 'diagMaxEventsHint'
  | 'groupNudge'
  | 'nudgeEnabled'
  | 'nudgeEnabledHint'
  | 'groupVcs'
  | 'vcsEnabled'
  | 'vcsEnabledHint'
  | 'vcsAutoCommit'
  | 'vcsAutoCommitHint'
  | 'vcsDebounceMs'
  | 'vcsBatch'
  | 'groupEmbedding'
  | 'embeddingEnabled'
  | 'embeddingEnabledHint'
  | 'embeddingEndpoint'
  | 'embeddingModel'
  | 'embeddingTimeoutMs'
  | 'groupDigestRecall'
  | 'digestMaxMessages'
  | 'recallMinSalience'
  | 'l3Inject'
  | 'l3InjectHint'
  | 'l3InjectOff'
  | 'l3InjectSalience'
  | 'l3InjectQuery'
  | 'groupBudgets'
  | 'groupSeed'
  | 'seedEnabled'
  | 'seedEnabledHint'
  | 'seedAuto'
  | 'seedAutoHint'
  | 'seedGitCommits'
  | 'seedGitCommitsHint'
  | 'seedMaxEntries'
  | 'maxBootTokens'
  | 'maxRuntimeTokens'
  | 'maxSpaceTokens'
  | 'maxViewTokens'
  | 'maxViewTokensHint'
  | 'l1MaxCharsPerLine'
  | 'l1MaxCharsPerLineHint'
  | 'subagentInject'
  | 'subagentInjectHint'
  | 'toolsProfile'
  | 'toolsProfileHint'
  | 'toolsProfileCore'
  | 'toolsProfileFull'
  | 'restartNote'
  | 'save'
  | 'saving'
  | 'discard'
  | 'reset'
  | 'unsaved'
  | 'saved'
  | 'saveFailed'
  | 'readOnly'
  | 'loading'
  | 'unavailable'

export type LocaleDict = Record<LocaleKey, string>

export const zh: LocaleDict = {
  nav: '记忆管理',
  openPanel: '打开记忆面板',
  openPanelHint: '状态、检索、诊断汇总在只读面板 /dev-memory/ 中查看（新标签页打开）。',
  groupWebui: 'WebUI 只读面板',
  webuiEnabled: '启用面板',
  webuiEnabledHint: '关闭后摘除 /dev-memory 路由（实时生效）。',
  groupDiag: '诊断与异常记录',
  diagEnabled: '启用诊断记录',
  diagEnabledHint: '记录调用异常与不符合预期的行为到 <库>/diag/events.jsonl（实时生效）。',
  diagMaxEvents: '事件保留上限',
  diagMaxEventsHint: '0 = 不限；超过 2 倍上限自动压缩只留最新 N 条（实时生效）。',
  groupNudge: '主动追忆（recall nudge）',
  nudgeEnabled: '启用主动追忆',
  nudgeEnabledHint: '30–240 分钟随机间隔经 agent.followup 温和提醒一次（实时生效）。',
  groupVcs: '版本回溯（git）',
  vcsEnabled: '启用 git 回溯',
  vcsEnabledHint: '关闭后完全跳过 git（实时生效，已有提交历史保留）。',
  vcsAutoCommit: '自动提交',
  vcsAutoCommitHint: '事件驱动自动提交（防抖+计数合并）；关闭则仅边界事件提交。',
  vcsDebounceMs: '防抖窗口（毫秒）',
  vcsBatch: '提交计数阈值（条）',
  groupEmbedding: '向量检索（Ollama，可选）',
  embeddingEnabled: '启用向量检索',
  embeddingEnabledHint: '开启后 L2/L3 写入同步生成向量；检索走向量+BM25 融合（实时生效）。',
  embeddingEndpoint: 'Ollama 地址',
  embeddingModel: '嵌入模型',
  embeddingTimeoutMs: '超时（毫秒）',
  groupDigestRecall: 'digest / recall 细调',
  digestMaxMessages: 'digest 触发消息数',
  recallMinSalience: '注入 top-k 最低 salience',
  l3Inject: 'L3 长期事实注入',
  l3InjectHint:
    '默认「不注入」：L3 的 salience 排序选不出与当前任务相关的事实，会拿老条目占预算；需要时让模型用 devmemory_recall 按需查。下一会话生效。',
  l3InjectOff: '不注入（推荐）',
  l3InjectSalience: '按 salience 取 top-5',
  l3InjectQuery: '按会话首条消息检索',
  groupSeed: '冷启动 seed（项目骨架）',
  seedEnabled: '启用冷启动 seed 能力',
  seedEnabledHint: '库为空时由模型调用，从 git 历史 / package.json / README / 顶层结构生成项目骨架（无 LLM、零成本）。',
  seedAuto: '库为空时自动 seed 一次',
  seedAutoHint: '开启即复刻 Hindsight 的"零配置开箱"；默认关——写库是显式动作，由 skill 引导模型按需调用。下一次会话启动生效。',
  seedGitCommits: '读取提交条数',
  seedGitCommitsHint: 'seed 读最近多少条 git 提交（0 = 不读 git）。',
  seedMaxEntries: '顶层条目上限',
  groupBudgets: '注入预算（字符）',
  maxBootTokens: 'boot 块',
  maxRuntimeTokens: '运行时流水',
  maxSpaceTokens: 'L3 空间',
  maxViewTokens: '会话视图总量',
  maxViewTokensHint: '状态块 + L1 回放 + L3 三块合计上限，按序扣减（防止前一块挤光后面）。',
  l1MaxCharsPerLine: 'L1 单行摘要字数',
  l1MaxCharsPerLineHint: '流水行是提问原文，超长按此字数截断（0 = 不摘要）。注入只保留"哪天问过什么"。',
  subagentInject: '子代理也注入视图',
  subagentInjectHint: '默认关：子代理保留记忆工具但不自动注入状态块/流水/提醒（扇出场景实测零使用）。',
  toolsProfile: '工具暴露面',
  toolsProfileHint: 'core = 5 个高频工具 + 1 个 action 式 admin（省约 1.2k tokens/次调用）；full = v0.6 的 12 个独立工具。改动需重启插件生效。',
  toolsProfileCore: '精简（推荐）',
  toolsProfileFull: '完整（12 工具）',
  restartNote: '工作区根 / 库粒度（scope / workspaceDir / storageDir）在设置页暂不提供修改，属启动期绑定，需编辑配置文件后重启。',
  save: '保存',
  saving: '保存中…',
  discard: '丢弃',
  reset: '恢复默认',
  unsaved: '有未保存修改',
  saved: '已保存',
  saveFailed: '保存失败，请重试',
  readOnly: '当前设置文档只读（进程内 memory 模式），请重启后再改。',
  loading: '加载中…',
  unavailable: '设置命名空间不可用（服务端设置桥未激活）。',
}

export const en: LocaleDict = {
  nav: 'Memory',
  openPanel: 'Open memory panel',
  openPanelHint: 'Status, search, and diagnostics live in the read-only panel /dev-memory (opens in a new tab).',
  groupWebui: 'WebUI read-only panel',
  webuiEnabled: 'Enable panel',
  webuiEnabledHint: 'Disabling unmounts the /dev-memory route (applies live).',
  groupDiag: 'Diagnostics',
  diagEnabled: 'Enable diagnostics',
  diagEnabledHint: 'Record invocation errors and unexpected behavior to <library>/diag/events.jsonl (live).',
  diagMaxEvents: 'Event retention cap',
  diagMaxEventsHint: '0 = unlimited; above 2× the cap compaction keeps the newest N (live).',
  groupNudge: 'Recall nudge',
  nudgeEnabled: 'Enable proactive reminder',
  nudgeEnabledHint: 'Gentle followup every 30–240 min via agent.followup (live).',
  groupVcs: 'Git versioning',
  vcsEnabled: 'Enable git backtrack',
  vcsEnabledHint: 'Disabling skips git entirely (live; existing history is kept).',
  vcsAutoCommit: 'Auto commit',
  vcsAutoCommitHint: 'Event-driven auto commits (debounced+batched); off = boundary commits only.',
  vcsDebounceMs: 'Debounce window (ms)',
  vcsBatch: 'Commit batch threshold',
  groupEmbedding: 'Vector search (Ollama, optional)',
  embeddingEnabled: 'Enable vector search',
  embeddingEnabledHint: 'Writes generate vectors; search fuses vectors with BM25 (live).',
  embeddingEndpoint: 'Ollama endpoint',
  embeddingModel: 'Embedding model',
  embeddingTimeoutMs: 'Timeout (ms)',
  groupDigestRecall: 'Digest / recall tuning',
  digestMaxMessages: 'Messages before digest',
  recallMinSalience: 'Min salience for boot top-k',
  l3Inject: 'L3 fact injection',
  l3InjectHint:
    'Default “off”: salience ranking cannot tell relevance, so stale facts crowd the budget — let the model call devmemory_recall instead. Takes effect next session.',
  l3InjectOff: 'Off (recommended)',
  l3InjectSalience: 'Top-5 by salience',
  l3InjectQuery: 'Retrieve by first message',
  groupSeed: 'Cold-start seed (project skeleton)',
  seedEnabled: 'Enable cold-start seeding',
  seedEnabledHint:
    'Lets the model generate a project skeleton from git history / package.json / README / top-level layout. No LLM, zero cost.',
  seedAuto: 'Auto-seed when the library is empty',
  seedAutoHint:
    'Turn on to mimic Hindsight’s zero-setup behaviour. Off by default — writing is explicit, driven by the skill. Takes effect on the next session start.',
  seedGitCommits: 'Commits to read',
  seedGitCommitsHint: 'How many recent git commits seed reads (0 = skip git).',
  seedMaxEntries: 'Top-level entry cap',
  groupBudgets: 'Injection budget (chars)',
  maxBootTokens: 'Boot block',
  maxRuntimeTokens: 'Runtime stream',
  maxSpaceTokens: 'L3 space',
  maxViewTokens: 'Session view total',
  maxViewTokensHint: 'Combined cap for status + L1 replay + L3, deducted in order (no block can starve the rest).',
  l1MaxCharsPerLine: 'L1 line summary length',
  l1MaxCharsPerLineHint: 'Stream lines are raw prompts; longer ones are cut at this many chars (0 = no summary).',
  subagentInject: 'Inject view into subagents',
  subagentInjectHint: 'Off by default: subagents keep the memory tools but get no auto-injected status/stream/reminder.',
  toolsProfile: 'Tool surface',
  toolsProfileHint: 'core = 5 hot tools + one action-style admin (saves ~1.2k tokens per call); full = the 12 separate tools. Restart the plugin to apply.',
  toolsProfileCore: 'Core (recommended)',
  toolsProfileFull: 'Full (12 tools)',
  restartNote: 'Library root / scope (workspaceDir / scope / storageDir) are boot-time bindings; edit the config file and restart.',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  reset: 'Reset',
  unsaved: 'Unsaved changes',
  saved: 'Saved',
  saveFailed: 'Save failed, retry',
  readOnly: 'Settings document is read-only (in-process memory mode); restart to edit.',
  loading: 'Loading…',
  unavailable: 'Settings namespace unavailable (server bridge inactive).',
}