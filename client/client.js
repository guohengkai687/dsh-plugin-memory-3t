window.__ModuleLoader__.load({
	id: "dsh-plugin-memory-3t",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/shared.ts
		/**
		* 服务端与客户端 bundle 共享的纯常量（零依赖，可被浏览器 bundle 内联）。
		*/
		/** 客户端 i18n 字典命名空间（本插件自有，与宿主设置命名空间无关）。 */
		const DEV_MEMORY_SETTINGS_NS = "dev-memory";
		/**
		* DSH 设置表单的命名空间 = profile 条目 id（cordis.patch.yml 的 `id:`）。
		* 服务端 `Config`（volatile 字段）与客户端 `ctx.configForms.get(...)` 都用它。
		*/
		const DEV_MEMORY_ENTRY_ID = "dsh-plugin-memory-3t";
		//#endregion
		//#region src/client/form.tsx
		/**
		* 「记忆管理」表单核心：在宿主配置表单（DSH 0.1.7 `ctx.configForms`）之上做 staged 编辑
		* （草稿 → 保存）。
		*
		* - form：ctx.configForms.get('dsh-plugin-memory-3t')（宿主 profile 条目的设置文档读写；
		*   0.1.1 的 ctx.settingsScope 已随旧设置体系移除）。
		* - 字段分两类：组字段（值在 snapshot.value[group][key]，保存时整体写回该组对象，
		*   保留同组其它已生效字段）与标量字段（snapshot.value[key]）。
		* - 保存 = 逐草稿 form.set(fieldOrGroup, value)；丢弃 = 只清草稿不写。
		*   组字段写回的是"解析值"（含 base 层），不会误删用户层以外的继承字段；
		*   宿主端写入持久化到 profile 的 cordis.patch.yml，volatile 字段不重挂载即生效。
		* - 纯注入样式（无 CSS 文件），随设置对话框外壳主题走。
		*/
		const style$1 = {
			wrap: {
				display: "flex",
				flexDirection: "column",
				gap: 7
			},
			group: {
				margin: "14px 0 3px",
				fontSize: 12,
				fontWeight: 600,
				color: "var(--dsw-alias-label-tertiary)"
			},
			row: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 12,
				padding: "9px 0",
				borderBottom: "1px solid var(--dsw-alias-border-l2)"
			},
			rowLabel: {
				display: "flex",
				flexDirection: "column",
				gap: 2,
				minWidth: 0
			},
			label: {
				fontSize: 13,
				color: "var(--dsw-alias-label-primary)"
			},
			hint: {
				fontSize: 12,
				color: "var(--dsw-alias-label-tertiary)",
				lineHeight: 1.35
			},
			control: {
				flex: "0 0 auto",
				display: "flex",
				alignItems: "center"
			},
			input: {
				background: "var(--dsw-alias-bg-layer-3)",
				color: "var(--dsw-alias-label-primary)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 8,
				padding: "2px 12px",
				fontSize: 13,
				width: 110,
				height: 34,
				fontFamily: "inherit",
				boxSizing: "border-box"
			},
			check: {
				width: 16,
				height: 16,
				accentColor: "var(--dsw-alias-brand-primary)",
				cursor: "pointer"
			},
			footer: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				marginTop: 10,
				justifyContent: "flex-end"
			},
			btn: {
				appearance: "none",
				background: "var(--dsw-alias-label-primary)",
				color: "var(--dsw-alias-bg-layer-3)",
				border: 0,
				borderRadius: 8,
				padding: "5px 14px",
				fontSize: 13,
				cursor: "pointer"
			},
			btnGhost: {
				appearance: "none",
				background: "0 0",
				color: "var(--dsw-alias-label-secondary)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 8,
				padding: "5px 14px",
				fontSize: 13,
				cursor: "pointer"
			},
			status: {
				fontSize: 12,
				color: "var(--dsw-alias-label-tertiary)"
			},
			error: {
				fontSize: 12,
				color: "var(--dsw-alias-label-error)"
			},
			note: {
				fontSize: 12,
				color: "var(--dsw-alias-label-tertiary)",
				marginTop: 2,
				lineHeight: 1.5
			},
			disabled: {
				opacity: .4,
				cursor: "default"
			}
		};
		function groupOf(snap, group) {
			const v = snap.value?.[group];
			return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
		}
		function groupLabel(group) {
			switch (group) {
				case "webui": return "groupWebui";
				case "diag": return "groupDiag";
				case "recallNudge": return "groupNudge";
				case "vcs": return "groupVcs";
				case "embedding": return "groupEmbedding";
				case "seed": return "groupSeed";
				default: return "groupDigestRecall";
			}
		}
		function DevMemoryForm({ form, t, fields, compact = false, onDirtyChange }) {
			const [snap, setSnap] = (0, react.useState)(() => form.getSnapshot());
			const [drafts, setDrafts] = (0, react.useState)({});
			const [saving, setSaving] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const [saved, setSaved] = (0, react.useState)(false);
			(0, react.useEffect)(() => form.subscribe(() => setSnap(form.getSnapshot())), [form]);
			const dirty = Object.keys(drafts).length > 0;
			(0, react.useEffect)(() => onDirtyChange?.(dirty), [onDirtyChange, dirty]);
			/** 展示态 = 生效值叠加草稿（组草稿是完整组对象，直接覆盖）。 */
			const effective = (0, react.useMemo)(() => {
				const out = { ...snap.value ?? {} };
				for (const [key, value] of Object.entries(drafts)) out[key] = value;
				return out;
			}, [snap, drafts]);
			const fieldValue = (field) => {
				if (field.group !== void 0) {
					const g = effective[field.group];
					return typeof g === "object" && g !== null ? g[field.key] : void 0;
				}
				return effective[field.key];
			};
			const stage = (field, next) => {
				setError(null);
				setSaved(false);
				setDrafts((prev) => {
					if (field.group !== void 0) {
						const base = groupOf(snap, field.group);
						const prior = prev[field.group];
						const merged = {
							...base,
							...typeof prior === "object" && prior !== null ? prior : {},
							[field.key]: next
						};
						return {
							...prev,
							[field.group]: merged
						};
					}
					return {
						...prev,
						[field.key]: next
					};
				});
			};
			const save = async () => {
				const entries = Object.entries(drafts);
				if (entries.length === 0 || saving) return;
				setSaving(true);
				setError(null);
				try {
					for (const [key, value] of entries) if (await form.set(key, value) === false) throw new Error(t("saveFailed"));
					setDrafts({});
					setSaved(true);
					window.setTimeout(() => setSaved(false), 2500);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setSaving(false);
				}
			};
			const discard = () => {
				setDrafts({});
				setError(null);
				setSaved(false);
			};
			if (snap.status === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: style$1.status,
				children: t("loading")
			});
			if (snap.status !== "ready") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: style$1.status,
				children: t("unavailable")
			});
			if (!snap.writable) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: style$1.status,
				children: t("readOnly")
			});
			const rendered = [];
			let lastGroup;
			for (const field of fields) {
				if (!compact && field.group !== void 0 && field.group !== lastGroup) rendered.push({ header: groupLabel(field.group) });
				rendered.push({ field });
				lastGroup = field.group;
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: style$1.wrap,
				children: [
					!compact && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: style$1.note,
						children: t("restartNote")
					}),
					rendered.map(({ header, field }, index) => {
						const rowKey = field !== void 0 ? `${field.group ?? "scalar"}:${field.key}` : `header:${index}`;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [header !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: style$1.group,
							children: t(header)
						}), field !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: style$1.row,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: style$1.rowLabel,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: style$1.label,
									children: t(field.label)
								}), !compact && field.hint !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: style$1.hint,
									children: t(field.hint)
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: style$1.control,
								children: field.kind === "toggle" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									style: style$1.check,
									checked: fieldValue(field) === true,
									disabled: saving,
									onChange: (event) => stage(field, event.target.checked)
								}) : field.kind === "select" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
									style: {
										...style$1.input,
										width: 172,
										paddingRight: 4
									},
									value: typeof fieldValue(field) === "string" ? fieldValue(field) : "",
									disabled: saving,
									onChange: (event) => stage(field, event.target.value),
									children: field.options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: option.value,
										children: t(option.label)
									}, option.value))
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "number",
									style: style$1.input,
									value: typeof fieldValue(field) === "number" ? Number(fieldValue(field)) : "",
									min: field.min,
									step: field.step ?? 1,
									disabled: saving,
									onChange: (event) => {
										const raw = event.target.value.trim();
										if (raw === "") {
											stage(field, void 0);
											return;
										}
										const n = Number(raw);
										if (!Number.isFinite(n)) return;
										const clipped = field.min !== void 0 && n < field.min ? field.min : n;
										const next = (field.step ?? 1) % 1 !== 0 ? Number(clipped.toFixed(4)) : Math.floor(clipped);
										stage(field, next);
									}
								})
							})]
						})] }, header !== void 0 ? `${rowKey}-header` : rowKey);
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: style$1.footer,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: {
									...style$1.btn,
									...saving || !dirty ? style$1.disabled : {}
								},
								disabled: !dirty || saving,
								onClick: () => void save(),
								children: t(saving ? "saving" : "save")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: {
									...style$1.btnGhost,
									...saving || !dirty ? style$1.disabled : {}
								},
								disabled: !dirty || saving,
								onClick: discard,
								children: t("discard")
							}),
							dirty && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: style$1.status,
								children: t("unsaved")
							}),
							saved && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: style$1.status,
								children: t("saved")
							}),
							error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: style$1.error,
								children: error
							})
						]
					})
				]
			});
		}
		/** 独立设置页的完整字段表。 */
		const SECTION_FIELDS = [
			{
				kind: "toggle",
				group: "webui",
				key: "enabled",
				label: "webuiEnabled",
				hint: "webuiEnabledHint"
			},
			{
				kind: "toggle",
				group: "diag",
				key: "enabled",
				label: "diagEnabled",
				hint: "diagEnabledHint"
			},
			{
				kind: "number",
				group: "diag",
				key: "maxEvents",
				label: "diagMaxEvents",
				hint: "diagMaxEventsHint",
				min: 0,
				step: 100
			},
			{
				kind: "toggle",
				group: "recallNudge",
				key: "enabled",
				label: "nudgeEnabled",
				hint: "nudgeEnabledHint"
			},
			{
				kind: "toggle",
				group: "vcs",
				key: "enabled",
				label: "vcsEnabled",
				hint: "vcsEnabledHint"
			},
			{
				kind: "toggle",
				group: "vcs",
				key: "autoCommit",
				label: "vcsAutoCommit",
				hint: "vcsAutoCommitHint"
			},
			{
				kind: "number",
				group: "vcs",
				key: "debounceMs",
				label: "vcsDebounceMs",
				min: 0,
				step: 100
			},
			{
				kind: "number",
				group: "vcs",
				key: "batch",
				label: "vcsBatch",
				min: 1
			},
			{
				kind: "toggle",
				group: "embedding",
				key: "enabled",
				label: "embeddingEnabled",
				hint: "embeddingEnabledHint"
			},
			{
				kind: "number",
				group: "embedding",
				key: "timeoutMs",
				label: "embeddingTimeoutMs",
				min: 0,
				step: 100
			},
			{
				kind: "number",
				group: "digest",
				key: "maxMessages",
				label: "digestMaxMessages",
				min: 0
			},
			{
				kind: "number",
				group: "recall",
				key: "minSalience",
				label: "recallMinSalience",
				min: 0,
				step: .05
			},
			{
				kind: "select",
				key: "l3Inject",
				label: "l3Inject",
				hint: "l3InjectHint",
				options: [
					{
						value: "off",
						label: "l3InjectOff"
					},
					{
						value: "salience",
						label: "l3InjectSalience"
					},
					{
						value: "query",
						label: "l3InjectQuery"
					}
				]
			},
			{
				kind: "toggle",
				group: "seed",
				key: "enabled",
				label: "seedEnabled",
				hint: "seedEnabledHint"
			},
			{
				kind: "toggle",
				group: "seed",
				key: "auto",
				label: "seedAuto",
				hint: "seedAutoHint"
			},
			{
				kind: "number",
				group: "seed",
				key: "gitCommits",
				label: "seedGitCommits",
				hint: "seedGitCommitsHint",
				min: 0,
				step: 10
			},
			{
				kind: "number",
				group: "seed",
				key: "maxEntries",
				label: "seedMaxEntries",
				min: 1,
				step: 10
			},
			{
				kind: "number",
				key: "maxBootTokens",
				label: "maxBootTokens",
				min: 0,
				step: 100
			},
			{
				kind: "number",
				key: "maxRuntimeTokens",
				label: "maxRuntimeTokens",
				min: 0,
				step: 100
			},
			{
				kind: "number",
				key: "maxSpaceTokens",
				label: "maxSpaceTokens",
				min: 0,
				step: 100
			},
			{
				kind: "number",
				key: "maxViewTokens",
				label: "maxViewTokens",
				hint: "maxViewTokensHint",
				min: 0,
				step: 100
			},
			{
				kind: "number",
				key: "l1MaxCharsPerLine",
				label: "l1MaxCharsPerLine",
				hint: "l1MaxCharsPerLineHint",
				min: 0,
				step: 20
			},
			{
				kind: "toggle",
				key: "subagentInject",
				label: "subagentInject",
				hint: "subagentInjectHint"
			},
			{
				kind: "select",
				key: "toolsProfile",
				label: "toolsProfile",
				hint: "toolsProfileHint",
				options: [{
					value: "core",
					label: "toolsProfileCore"
				}, {
					value: "full",
					label: "toolsProfileFull"
				}]
			}
		];
		//#endregion
		//#region src/client/section.tsx
		const style = {
			wrap: {
				display: "flex",
				flexDirection: "column",
				gap: 14
			},
			linkRow: {
				display: "flex",
				alignItems: "center",
				gap: 10,
				flexWrap: "wrap"
			},
			link: {
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				background: "var(--dsw-alias-label-primary)",
				color: "var(--dsw-alias-bg-layer-3)",
				textDecoration: "none",
				borderRadius: 8,
				padding: "6px 14px",
				fontSize: 13,
				fontWeight: 500
			},
			hint: {
				fontSize: 12,
				color: "var(--dsw-alias-label-tertiary)"
			}
		};
		function DevMemorySection({ t, form }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: style.wrap,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: style.linkRow,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
						href: "/dev-memory/",
						target: "_blank",
						rel: "noreferrer",
						style: style.link,
						children: t("openPanel")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: style.hint,
						children: t("openPanelHint")
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DevMemoryForm, {
					form,
					t,
					fields: SECTION_FIELDS
				})]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		const zh = {
			nav: "记忆管理",
			openPanel: "打开记忆面板",
			openPanelHint: "状态、检索、诊断汇总在只读面板 /dev-memory/ 中查看（新标签页打开）。",
			groupWebui: "WebUI 只读面板",
			webuiEnabled: "启用面板",
			webuiEnabledHint: "关闭后摘除 /dev-memory 路由（实时生效）。",
			groupDiag: "诊断与异常记录",
			diagEnabled: "启用诊断记录",
			diagEnabledHint: "记录调用异常与不符合预期的行为到 <库>/diag/events.jsonl（实时生效）。",
			diagMaxEvents: "事件保留上限",
			diagMaxEventsHint: "0 = 不限；超过 2 倍上限自动压缩只留最新 N 条（实时生效）。",
			groupNudge: "主动追忆（recall nudge）",
			nudgeEnabled: "启用主动追忆",
			nudgeEnabledHint: "30–240 分钟随机间隔经 agent.followup 温和提醒一次（实时生效）。",
			groupVcs: "版本回溯（git）",
			vcsEnabled: "启用 git 回溯",
			vcsEnabledHint: "关闭后完全跳过 git（实时生效，已有提交历史保留）。",
			vcsAutoCommit: "自动提交",
			vcsAutoCommitHint: "事件驱动自动提交（防抖+计数合并）；关闭则仅边界事件提交。",
			vcsDebounceMs: "防抖窗口（毫秒）",
			vcsBatch: "提交计数阈值（条）",
			groupEmbedding: "向量检索（Ollama，可选）",
			embeddingEnabled: "启用向量检索",
			embeddingEnabledHint: "开启后 L2/L3 写入同步生成向量；检索走向量+BM25 融合（实时生效）。",
			embeddingEndpoint: "Ollama 地址",
			embeddingModel: "嵌入模型",
			embeddingTimeoutMs: "超时（毫秒）",
			groupDigestRecall: "digest / recall 细调",
			digestMaxMessages: "digest 触发消息数",
			recallMinSalience: "注入 top-k 最低 salience",
			l3Inject: "L3 长期事实注入",
			l3InjectHint: "默认「不注入」：L3 的 salience 排序选不出与当前任务相关的事实，会拿老条目占预算；需要时让模型用 devmemory_recall 按需查。下一会话生效。",
			l3InjectOff: "不注入（推荐）",
			l3InjectSalience: "按 salience 取 top-5",
			l3InjectQuery: "按会话首条消息检索",
			groupSeed: "冷启动 seed（项目骨架）",
			seedEnabled: "启用冷启动 seed 能力",
			seedEnabledHint: "库为空时由模型调用，从 git 历史 / package.json / README / 顶层结构生成项目骨架（无 LLM、零成本）。",
			seedAuto: "库为空时自动 seed 一次",
			seedAutoHint: "开启即复刻 Hindsight 的\"零配置开箱\"；默认关——写库是显式动作，由 skill 引导模型按需调用。下一次会话启动生效。",
			seedGitCommits: "读取提交条数",
			seedGitCommitsHint: "seed 读最近多少条 git 提交（0 = 不读 git）。",
			seedMaxEntries: "顶层条目上限",
			groupBudgets: "注入预算（字符）",
			maxBootTokens: "boot 块",
			maxRuntimeTokens: "运行时流水",
			maxSpaceTokens: "L3 空间",
			maxViewTokens: "会话视图总量",
			maxViewTokensHint: "状态块 + L1 回放 + L3 三块合计上限，按序扣减（防止前一块挤光后面）。",
			l1MaxCharsPerLine: "L1 单行摘要字数",
			l1MaxCharsPerLineHint: "流水行是提问原文，超长按此字数截断（0 = 不摘要）。注入只保留\"哪天问过什么\"。",
			subagentInject: "子代理也注入视图",
			subagentInjectHint: "默认关：子代理保留记忆工具但不自动注入状态块/流水/提醒（扇出场景实测零使用）。",
			toolsProfile: "工具暴露面",
			toolsProfileHint: "core = 5 个高频工具 + 1 个 action 式 admin（省约 1.2k tokens/次调用）；full = v0.6 的 12 个独立工具。改动需重启插件生效。",
			toolsProfileCore: "精简（推荐）",
			toolsProfileFull: "完整（12 工具）",
			restartNote: "工作区根 / 库粒度（scope / workspaceDir / storageDir）在设置页暂不提供修改，属启动期绑定，需编辑配置文件后重启。",
			save: "保存",
			saving: "保存中…",
			discard: "丢弃",
			reset: "恢复默认",
			unsaved: "有未保存修改",
			saved: "已保存",
			saveFailed: "保存失败，请重试",
			readOnly: "当前设置文档只读（进程内 memory 模式），请重启后再改。",
			loading: "加载中…",
			unavailable: "设置表单不可用：宿主未挂载本插件条目，或当前 profile 没有设置服务。"
		};
		const en = {
			nav: "Memory",
			openPanel: "Open memory panel",
			openPanelHint: "Status, search, and diagnostics live in the read-only panel /dev-memory (opens in a new tab).",
			groupWebui: "WebUI read-only panel",
			webuiEnabled: "Enable panel",
			webuiEnabledHint: "Disabling unmounts the /dev-memory route (applies live).",
			groupDiag: "Diagnostics",
			diagEnabled: "Enable diagnostics",
			diagEnabledHint: "Record invocation errors and unexpected behavior to <library>/diag/events.jsonl (live).",
			diagMaxEvents: "Event retention cap",
			diagMaxEventsHint: "0 = unlimited; above 2× the cap compaction keeps the newest N (live).",
			groupNudge: "Recall nudge",
			nudgeEnabled: "Enable proactive reminder",
			nudgeEnabledHint: "Gentle followup every 30–240 min via agent.followup (live).",
			groupVcs: "Git versioning",
			vcsEnabled: "Enable git backtrack",
			vcsEnabledHint: "Disabling skips git entirely (live; existing history is kept).",
			vcsAutoCommit: "Auto commit",
			vcsAutoCommitHint: "Event-driven auto commits (debounced+batched); off = boundary commits only.",
			vcsDebounceMs: "Debounce window (ms)",
			vcsBatch: "Commit batch threshold",
			groupEmbedding: "Vector search (Ollama, optional)",
			embeddingEnabled: "Enable vector search",
			embeddingEnabledHint: "Writes generate vectors; search fuses vectors with BM25 (live).",
			embeddingEndpoint: "Ollama endpoint",
			embeddingModel: "Embedding model",
			embeddingTimeoutMs: "Timeout (ms)",
			groupDigestRecall: "Digest / recall tuning",
			digestMaxMessages: "Messages before digest",
			recallMinSalience: "Min salience for boot top-k",
			l3Inject: "L3 fact injection",
			l3InjectHint: "Default “off”: salience ranking cannot tell relevance, so stale facts crowd the budget — let the model call devmemory_recall instead. Takes effect next session.",
			l3InjectOff: "Off (recommended)",
			l3InjectSalience: "Top-5 by salience",
			l3InjectQuery: "Retrieve by first message",
			groupSeed: "Cold-start seed (project skeleton)",
			seedEnabled: "Enable cold-start seeding",
			seedEnabledHint: "Lets the model generate a project skeleton from git history / package.json / README / top-level layout. No LLM, zero cost.",
			seedAuto: "Auto-seed when the library is empty",
			seedAutoHint: "Turn on to mimic Hindsight’s zero-setup behaviour. Off by default — writing is explicit, driven by the skill. Takes effect on the next session start.",
			seedGitCommits: "Commits to read",
			seedGitCommitsHint: "How many recent git commits seed reads (0 = skip git).",
			seedMaxEntries: "Top-level entry cap",
			groupBudgets: "Injection budget (chars)",
			maxBootTokens: "Boot block",
			maxRuntimeTokens: "Runtime stream",
			maxSpaceTokens: "L3 space",
			maxViewTokens: "Session view total",
			maxViewTokensHint: "Combined cap for status + L1 replay + L3, deducted in order (no block can starve the rest).",
			l1MaxCharsPerLine: "L1 line summary length",
			l1MaxCharsPerLineHint: "Stream lines are raw prompts; longer ones are cut at this many chars (0 = no summary).",
			subagentInject: "Inject view into subagents",
			subagentInjectHint: "Off by default: subagents keep the memory tools but get no auto-injected status/stream/reminder.",
			toolsProfile: "Tool surface",
			toolsProfileHint: "core = 5 hot tools + one action-style admin (saves ~1.2k tokens per call); full = the 12 separate tools. Restart the plugin to apply.",
			toolsProfileCore: "Core (recommended)",
			toolsProfileFull: "Full (12 tools)",
			restartNote: "Library root / scope (workspaceDir / scope / storageDir) are boot-time bindings; edit the config file and restart.",
			save: "Save",
			saving: "Saving…",
			discard: "Discard",
			reset: "Reset",
			unsaved: "Unsaved changes",
			saved: "Saved",
			saveFailed: "Save failed, retry",
			readOnly: "Settings document is read-only (in-process memory mode); restart to edit.",
			loading: "Loading…",
			unavailable: "Settings form unavailable: the Host does not mount this plugin entry, or this profile has no settings service."
		};
		//#endregion
		//#region src/client/index.tsx
		/** 本客户端插件的完整 id（与包名一致，用于 dsh.client 发现与 __ModuleLoader__ id）。 */
		const PLUGIN_ID = "dsh-plugin-memory-3t";
		/** settings.section 导航顺序：默认 General/Models 之后、插件市场(40)之后。 */
		const SECTION_ORDER = 46;
		const name = PLUGIN_ID;
		/** 依赖的客户端服务（0.1.7：`configForms` 取代 `settingsScope`）。 */
		const inject = [
			"slots",
			"locale",
			"configForms"
		];
		function apply(ctx) {
			const NS = DEV_MEMORY_SETTINGS_NS;
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), `${PLUGIN_ID}: settings dictionaries`);
			const form = ctx.configForms.get(DEV_MEMORY_ENTRY_ID);
			ctx.effect(() => ctx.configForms.whileServed([DEV_MEMORY_ENTRY_ID], () => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: PLUGIN_ID,
				order: SECTION_ORDER,
				label: () => t("nav"),
				locale: NS
			}, (() => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DevMemorySection, {
				t,
				form
			}))))), `${PLUGIN_ID}: settings section`);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map