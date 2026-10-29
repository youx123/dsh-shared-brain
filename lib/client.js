window.__ModuleLoader__.load({
	id: "dsh-shared-brain",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");

		/** 字典命名空间。 */
		const NS = "sharedBrain";
		/** 设置页席位 id。 */
		const SECTION_ID = "shared-brain";
		/** 侧边栏席位 id。 */
		const DOCK_ID = "shared-brain-dock";
		/** 浮层席位 id。 */
		const OVERLAY_ID = "shared-brain-panel";
		/** 宿主接口（见 lib/bridge.js）。 */
		const STATUS_PATH = "/api/dsh-shared-brain/status";
		const MUTATE_PATH = "/api/dsh-shared-brain/mutate";

		const zh = {
			nav: "共享大脑",
			title: "共享大脑",
			intro: "一个人设、一份记忆，跨所有会话共用。这里管理大脑的七个模块：记忆按性质分成底线、认知、情感、本能四类，各自带权重；声音决定「怎么说话」；网络与自动互动是能力开关。",
			loading: "读取中…",
			refresh: "刷新",
			saved: "已保存",
			failed: "操作失败",
			modulesTitle: "记忆模块",
			voiceTitle: "声音",
			capTitle: "能力开关",
			weightLabel: "权重",
			enabled: "启用",
			disabled: "停用",
			entries: "条",
			average: "平均权重",
			always: "常驻注入",
			boost: "召回加成",
			limit: "最多注入",
			never: "不会注入",
			tone: "语气",
			tonePlaceholder: "例如：傲娇 + 软萌",
			tics: "口头禅",
			ticsPlaceholder: "用逗号或换行分隔，例如：哼！，才、才不是……，嘿嘿",
			emoji: "表情",
			address: "自称",
			voiceNote: "声音与人设合并：这里改的是「怎么说」，人设本身在「大肥鱼」设置页里改。",
			networkTitle: "网络",
			networkNote: "开启后允许对外获取信息用于学习。默认关闭，避免擅自出网。",
			agentiveTitle: "自动互动",
			agentiveNote: "开启后允许主动行为（主动搭话、主动提醒）。默认关闭，避免擅自插嘴。",
			proactiveTitle: "自动互动 · 定时主动",
			proactiveNote: "开启后，插件会按设定的间隔给活跃会话发一条「主动检查」的指令（followup 会唤醒会话，等于自己开新一轮）。所有会话都算，包括别的插件开的子会话。",
			proactiveInterval: "主动间隔",
			proactiveIntervalUnit: "分钟",
			proactiveIntervalApply: "保存间隔",
			proactiveNow: "立刻主动一次",
			proactiveRunning: "定时器运行中",
			proactiveStopped: "定时器未运行",
			proactiveFired: "已主动",
			proactiveSkipped: "跳过",
			proactiveTracking: "盯着",
			proactiveLastFired: "最近一次",
			proactiveNever: "还没主动过",
			proactiveStatusHint: "「立刻主动一次」会立刻给当前所有活跃会话（含别的插件开的）发一条检查指令，用来验证自动互动是不是真的在跑。",
			clear: "清空该模块",
			clearAll: "清空全部记忆",
			confirmClear: "确认清空？",
			latestTitle: "最近的记忆",
			empty: "还没有记忆",
			manualTitle: "手动底线",
			manualNote: "底线不会自动生效：只有你自己钉在这里的条目，才会每次都强制注入。",
			manualPlaceholder: "写下一条不可协商的约束，例如：不要在没有确认前删除文件",
			manualAdd: "钉住这条底线",
			manualEmpty: "还没有钉住的底线",
			manualPinned: "已钉住",
			manualUnpin: "取消钉住",
			manualRemove: "删除",
			lifetimeTitle: "记忆寿命",
			lifetimePermanent: "永久",
			lifetimeTemporary: "临时",
			temporaryHint: "临时的记忆到期后自动消失（默认 24 小时）。",
			scopeTitle: "自动互动的生效范围",
			scopeAll: "全部会话",
			scopeSession: "指定会话",
			scopeHint: "选「指定会话」后，只有被勾选的会话里才允许主动行为。",
			scopeEmpty: "还没发现任何会话。先随便打开一个会话（或新建一个），这里的列表就会自己长出来。",
			scopeCurrent: "当前",
			scopeLive: "开着",
			scopeManual: "手动填会话 ID",
			scopeManualAdd: "加入",
			scopeManualHint: "列表里找不到时，可以把会话 ID 直接粘进来。",
			scopeCount: "个会话",
			scopeRefresh: "刷新会话",
			scopeUnknown: "（未知会话）",
			personaAssigned: "已单独指定的会话",
			scopeSessions: "会话",
			personaTitle: "人设",
			personaNote: "人设由共享大脑自己管理，不再依赖别的插件；切换后所有会话立刻生效，不用重启。",
			personaCurrent: "当前人设",
			personaUse: "启用",
			personaEdit: "编辑正文",
			personaNew: "新建人设",
			personaNewName: "新名字",
			personaNewBody: "写这个人设的正文",
			personaSave: "保存人设",
			personaDelete: "删除",
			personaBundled: "内置",
			personaCustom: "自定义",
			personaEmpty: "还没有人设",
			timeWindowTitle: "只在这些时段主动",
			windowOn: "时间窗已开",
			windowOff: "时间窗关闭",
			timeWindowHint: "开启后，只有在这个时间段内才会主动提建议；之外就只回应用户明确交代的事。格式 HH:MM。",
			emojiTitle: "表情包目录",
			emojiNote: "把表情丢进这个目录就够了：.txt 一行一个（或「名字: 表情」），图片（.png/.gif/.webp…）的文件名就是情绪名。本鱼会定时自己扫进来，不用一个个手动加。",
			emojiDirPlaceholder: "表情目录路径（留空用默认目录）",
			emojiSave: "保存目录",
			emojiAdd: "加一个表情",
			emojiName: "名字",
			emojiValue: "表情",
			emojiEmpty: "目录里还没有表情",
			emojiCount: "个表情",
			emojiDefaultDir: "默认目录",
			emojiDefault: "默认表情",
			emojiDefaultPlaceholder: "目录里挑不到合适的时用它，比如 🐟",
			emojiAuto: "自动加载",
			emojiAutoOn: "定时自动加载已开",
			emojiAutoOff: "定时自动加载已关",
			emojiAutoToggleOn: "关掉自动加载",
			emojiAutoToggleOff: "开启自动加载",
			emojiInterval: "间隔",
			emojiIntervalUnit: "分钟",
			emojiIntervalApply: "保存间隔",
			emojiRescan: "立即重扫",
			emojiScanned: "上次扫描",
			emojiNever: "还没扫过",
			emojiTextCount: "文字",
			emojiImageCount: "图片",
			emojiImageTag: "图",
			emojiChangeTitle: "最近变更",
			emojiAutoHint: "默认每 5 分钟扫一次目录，新丢进去的表情会自己长出来；关掉后只有点「立即重扫」才更新。",
			personaSession: "给某个会话单独指定",
			personaSessionNone: "不指定（跟随全局）",
			personaSessionHint: "选一个会话再选一个人设，就只有那个会话用人设；选「不指定」就回到全局。",
			personaSessionSave: "应用",
			searchFilterModule: "模块",
			searchFilterLifetime: "寿命",
			searchFilterPinned: "只看钉住的",
			searchFilterAll: "全部",
			scopeGlobal: "全局",
			scopeWorkspace: "仅工作区",
			scopeToggle: "作用域",

			speechTitle: "语音与唱歌",
			speechNote: "这些是给将来的语音 / 唱歌模块用的物理参数，不要念出来。",
			speechVoice: "音色 ID",
			speechVoiceIdPlaceholder: "例如：zh-CN-XiaoxiaoNeural",
			speechVoiceName: "音色名称",
			speechVoicePlaceholder: "例如：zh-CN-XiaoxiaoNeural",
			speechRate: "语速",
			speechPitch: "音调",
			speechVolume: "音量",
			speechSing: "唱法",
			speechSingStyle: "唱法风格",
			speechSingStylePlaceholder: "例如：轻哼",
			speechSingBpm: "速度 BPM",
			speechSingKey: "调性",
			speechSingKeyPlaceholder: "例如：C",
			speechSingEnabled: "允许唱歌",
			searchTitle: "搜索记忆",
			searchPlaceholder: "按关键词或标签搜记忆",
			searchButton: "搜索",
			searchEmpty: "没找到相关记忆",
			searchResult: "条结果",
			dockSummary: "大脑",
			dockOpen: "打开面板",
			dockFailed: "共享大脑读取失败",
			panelTitle: "共享大脑",
			panelHint: "在这里调模块权重、开关能力与改声音风格，改完立即生效。",
			close: "关闭",
			moduleLabels: {
				bottomline: "底线",
				cognition: "认知",
				emotion: "情感",
				instinct: "本能",
				voice: "声音",
				network: "网络",
				agentive: "自动互动",
			},
		};

		const en = {
			nav: "Shared Brain",
			title: "Shared Brain",
			intro: "One persona, one memory, shared across every session. The brain has seven modules: memories are split into bottom line, cognition, emotion and instinct, each with its own weight; voice decides how it speaks; network and agentive are capability switches.",
			loading: "Loading…",
			refresh: "Refresh",
			saved: "Saved",
			failed: "Action failed",
			modulesTitle: "Memory modules",
			voiceTitle: "Voice",
			capTitle: "Capability switches",
			weightLabel: "Weight",
			enabled: "Enabled",
			disabled: "Disabled",
			entries: "items",
			average: "Avg weight",
			always: "Always injected",
			boost: "Recall boost",
			limit: "Max injected",
			never: "Never injected",
			tone: "Tone",
			tonePlaceholder: "e.g. playful and a little tsundere",
			tics: "Catchphrases",
			ticsPlaceholder: "Comma or newline separated, e.g. hmph, it's not for you,",
			emoji: "Emoji",
			address: "Self reference",
			voiceNote: "Voice is merged with the persona: this changes how it speaks, the persona itself is edited in the persona settings page.",
			networkTitle: "Network",
			networkNote: "Allow fetching outside information to learn. Off by default so it never goes out on its own.",
			agentiveTitle: "Agentive",
			agentiveNote: "Allow proactive behaviour (starting topics, reminders). Off by default so it never interrupts on its own.",
			proactiveTitle: "Agentive · scheduled nudges",
			proactiveNote: "When on, the plugin sends a proactive check to live sessions on the interval you set (a followup wakes the session, so it starts a new turn by itself). Every session counts, including sessions other plugins opened.",
			proactiveInterval: "Nudge interval",
			proactiveIntervalUnit: "minutes",
			proactiveIntervalApply: "Save interval",
			proactiveNow: "Nudge right now",
			proactiveRunning: "Timer running",
			proactiveStopped: "Timer not running",
			proactiveFired: "nudged",
			proactiveSkipped: "skipped",
			proactiveTracking: "watching",
			proactiveLastFired: "last nudge",
			proactiveNever: "never nudged yet",
			proactiveStatusHint: "\"Nudge right now\" sends a check to every live session immediately (including ones other plugins opened) so you can see whether the agentive loop really runs.",
			clear: "Clear module",
			clearAll: "Clear all memories",
			confirmClear: "Clear for sure?",
			latestTitle: "Recent memories",
			empty: "No memories yet",
			manualTitle: "Manual bottom line",
			manualNote: "The bottom line never applies on its own: only entries you pin here are forced into every prompt.",
			manualPlaceholder: "Write a non-negotiable rule, e.g. never delete files without confirmation",
			manualAdd: "Pin this rule",
			manualEmpty: "No pinned rules yet",
			manualPinned: "Pinned",
			manualUnpin: "Unpin",
			manualRemove: "Remove",
			lifetimeTitle: "Memory lifetime",
			lifetimePermanent: "Permanent",
			lifetimeTemporary: "Temporary",
			temporaryHint: "Temporary memories disappear when they expire (24 hours by default).",
			scopeTitle: "Agentive scope",
			scopeAll: "All sessions",
			scopeSession: "Selected sessions",
			scopeHint: "With \"Selected sessions\", proactive behaviour only happens inside the ticked sessions.",
			scopeEmpty: "No sessions found yet. Open or create one and this list will fill itself in.",
			scopeCurrent: "current",
			scopeLive: "open",
			scopeManual: "Paste a session id",
			scopeManualAdd: "Add",
			scopeManualHint: "If a session is not listed, paste its id here.",
			scopeCount: "sessions",
			scopeRefresh: "Refresh sessions",
			scopeUnknown: "(unknown session)",
			personaAssigned: "Sessions with their own persona",
			scopeSessions: "Sessions",
			personaTitle: "Persona",
			personaNote: "The shared brain owns the persona now — no other plugin needed. Switching applies to every session immediately, no restart.",
			personaCurrent: "Current persona",
			personaUse: "Activate",
			personaEdit: "Edit text",
			personaNew: "New persona",
			personaNewName: "New name",
			personaNewBody: "Write the persona text",
			personaSave: "Save persona",
			personaDelete: "Delete",
			personaBundled: "Bundled",
			personaCustom: "Custom",
			personaEmpty: "No persona yet",
			timeWindowTitle: "Only active in this window",
			windowOn: "Window on",
			windowOff: "Window off",
			timeWindowHint: "When on, proactivity only happens inside this range; outside it just answers what is asked. Format HH:MM.",
			emojiTitle: "Emoji folder",
			emojiNote: "Just drop files in this folder: .txt (one per line, or \"name: emoji\") and images (.png/.gif/.webp…, file name = mood name). The fish scans it on a timer — no manual adding.",
			emojiDirPlaceholder: "Emoji folder path (empty = default)",
			emojiSave: "Save folder",
			emojiAdd: "Add emoji",
			emojiName: "Name",
			emojiValue: "Emoji",
			emojiEmpty: "No emoji in this folder yet",
			emojiCount: "emoji",
			emojiDefaultDir: "Default folder",
			emojiDefault: "Default emoji",
			emojiDefaultPlaceholder: "Used when nothing in the folder fits, e.g. 🐟",
			emojiAuto: "Auto load",
			emojiAutoOn: "Timed auto-load is on",
			emojiAutoOff: "Timed auto-load is off",
			emojiAutoToggleOn: "Turn auto-load off",
			emojiAutoToggleOff: "Turn auto-load on",
			emojiInterval: "Every",
			emojiIntervalUnit: "min",
			emojiIntervalApply: "Save interval",
			emojiRescan: "Rescan now",
			emojiScanned: "Last scan",
			emojiNever: "not scanned yet",
			emojiTextCount: "text",
			emojiImageCount: "images",
			emojiImageTag: "img",
			emojiChangeTitle: "Recent changes",
			emojiAutoHint: "Scans the folder every 5 minutes by default, so new files show up on their own; turn it off to update only on \"Rescan now\".",
			personaSession: "Override for one session",
			personaSessionNone: "No override (follow global)",
			personaSessionHint: "Pick a session and a persona; only that session uses it. Pick \"no override\" to go back to global.",
			personaSessionSave: "Apply",
			searchFilterModule: "Module",
			searchFilterLifetime: "Lifetime",
			searchFilterPinned: "Pinned only",
			searchFilterAll: "All",
			scopeGlobal: "Global",
			scopeWorkspace: "Workspace only",
			scopeToggle: "Scope",

			speechTitle: "Voice & singing",
			speechNote: "Physical parameters for the future voice / singing module. Do not read them out.",
			speechVoice: "Voice ID",
			speechVoiceIdPlaceholder: "e.g. zh-CN-XiaoxiaoNeural",
			speechVoiceName: "Voice name",
			speechVoicePlaceholder: "e.g. zh-CN-XiaoxiaoNeural",
			speechRate: "Rate",
			speechPitch: "Pitch",
			speechVolume: "Volume",
			speechSing: "Singing",
			speechSingStyle: "Sing style",
			speechSingStylePlaceholder: "e.g. soft hum",
			speechSingBpm: "Tempo BPM",
			speechSingKey: "Key",
			speechSingKeyPlaceholder: "e.g. C",
			speechSingEnabled: "Allow singing",
			searchTitle: "Search memories",
			searchPlaceholder: "Search memories by text or tag",
			searchButton: "Search",
			searchEmpty: "No matching memory",
			searchResult: "results",
			dockSummary: "Brain",
			dockOpen: "Open panel",
			dockFailed: "Failed to read shared brain",
			panelTitle: "Shared Brain",
			panelHint: "Adjust module weights, toggle capabilities and tune the voice. Changes apply immediately.",
			close: "Close",
			moduleLabels: {
				bottomline: "Bottom line",
				cognition: "Cognition",
				emotion: "Emotion",
				instinct: "Instinct",
				voice: "Voice",
				network: "Network",
				agentive: "Agentive",
			},
		};

		const styles = {
			section: {
				display: "flex",
				flexDirection: "column",
				gap: "12px",
				maxWidth: "760px",
				color: "var(--dsw-alias-label-primary)",
			},
			heading: { margin: 0, fontSize: "18px", fontWeight: 600 },
			subHeading: { margin: "6px 0 0", fontSize: "15px", fontWeight: 600 },
			intro: { margin: 0, fontSize: "13px", color: "var(--dsw-alias-label-tertiary)" },
			hint: { margin: 0, fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" },
			card: {
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				padding: "14px 16px",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "10px",
				fontSize: "13px",
			},
			moduleRow: {
				display: "grid",
				gridTemplateColumns: "minmax(72px, auto) minmax(0, 1fr) auto",
				alignItems: "center",
				gap: "10px",
			},
			moduleName: { fontWeight: 600 },
			moduleMeta: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" },
			badge: {
				fontSize: "11px",
				padding: "1px 7px",
				borderRadius: "999px",
				border: "1px solid var(--dsw-alias-border-l2)",
				color: "var(--dsw-alias-label-tertiary)",
			},
			badgeOn: {
				fontSize: "11px",
				padding: "1px 7px",
				borderRadius: "999px",
				border: "1px solid var(--dsw-alias-border-l2)",
				color: "var(--dsw-alias-state-business-primary, #4b7bec)",
			},
			slider: { width: "100%", accentColor: "var(--dsw-alias-state-business-primary, #4b7bec)" },
			weightValue: { fontSize: "12px", fontVariantNumeric: "tabular-nums", minWidth: "34px", textAlign: "right" },
			button: {
				font: "inherit",
				fontSize: "12px",
				padding: "4px 10px",
				borderRadius: "8px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
			},
			primaryButton: {
				font: "inherit",
				fontSize: "12px",
				padding: "4px 10px",
				borderRadius: "8px",
				border: "1px solid transparent",
				background: "var(--dsw-alias-state-business-primary, #4b7bec)",
				color: "#fff",
				cursor: "pointer",
			},
			dangerButton: {
				font: "inherit",
				fontSize: "12px",
				padding: "4px 10px",
				borderRadius: "8px",
				border: "1px solid var(--dsw-alias-border-danger, #d14343)",
				background: "transparent",
				color: "var(--dsw-alias-label-danger, #d14343)",
				cursor: "pointer",
			},
			input: {
				font: "inherit",
				fontSize: "13px",
				padding: "6px 10px",
				borderRadius: "8px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "inherit",
				width: "100%",
				boxSizing: "border-box",
			},
			textarea: {
				font: "inherit",
				fontSize: "12px",
				lineHeight: 1.6,
				padding: "10px 12px",
				borderRadius: "10px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "inherit",
				width: "100%",
				minHeight: "70px",
				resize: "vertical",
				boxSizing: "border-box",
			},
			field: { display: "flex", flexDirection: "column", gap: "4px" },
			fieldLabel: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" },
			toggle: {
				font: "inherit",
				fontSize: "12px",
				padding: "3px 10px",
				borderRadius: "999px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
				whiteSpace: "nowrap",
			},
			toggleOn: {
				font: "inherit",
				fontSize: "12px",
				padding: "3px 10px",
				borderRadius: "999px",
				border: "1px solid transparent",
				background: "var(--dsw-alias-state-business-primary, #4b7bec)",
				color: "#fff",
				cursor: "pointer",
				whiteSpace: "nowrap",
			},
			list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "6px" },
			row: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				padding: "8px 10px",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "10px",
				fontSize: "12px",
			},
			rowText: { flex: "1 1 auto", minWidth: 0, wordBreak: "break-word" },
			messageOk: { margin: 0, fontSize: "12px", color: "var(--dsw-alias-state-success, #2e9e5b)" },
			messageError: { margin: 0, fontSize: "12px", color: "var(--dsw-alias-label-danger, #d14343)" },
			// 侧边栏（输入框上方的小条）
			dock: {
				display: "flex",
				alignItems: "center",
				flexWrap: "wrap",
				gap: "6px",
				fontSize: "11px",
				color: "var(--dsw-alias-label-tertiary)",
			},
			dockChip: {
				font: "inherit",
				fontSize: "11px",
				padding: "1px 8px",
				borderRadius: "999px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "var(--dsw-alias-label-primary)",
				cursor: "pointer",
			},
			// 浮层面板
			modalBackdrop: {
				position: "fixed",
				inset: "0",
				zIndex: 1000,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				padding: "24px",
				background: "rgba(0, 0, 0, 0.35)",
			},
			modalPanel: {
				width: "min(520px, 100%)",
				maxHeight: "min(80vh, 640px)",
				overflowY: "auto",
				padding: "16px",
				borderRadius: "14px",
				background: "var(--dsw-alias-bg-layer, #fff)",
				color: "var(--dsw-alias-label-primary, #111)",
				boxShadow: "0 12px 40px rgba(0, 0, 0, 0.28)",
				display: "flex",
				flexDirection: "column",
				gap: "10px",
			},
			modalHeading: { margin: 0, fontSize: "14px", fontWeight: 600 },
			searchRow: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "8px", alignItems: "center" },
				chipRow: { display: "flex", flexWrap: "wrap", gap: "6px" },
				inline: { display: "flex", flexDirection: "column", gap: "4px", minWidth: "0" },
		};

		/** 读一次状态。 */
		function fetchStatus() {
			if (typeof fetch !== "function") return Promise.reject(new Error("fetch unavailable"));
			return fetch(STATUS_PATH, { headers: { accept: "application/json" } }).then((response) => {
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return response.json().then((body) => {
					if (!body || body.ok !== true) throw new Error((body && body.error) || "malformed payload");
					return body.value;
				});
			});
		}

		/** 提交一次变更。 */
		function postMutate(payload) {
			if (typeof fetch !== "function") return Promise.reject(new Error("fetch unavailable"));
			return fetch(MUTATE_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			}).then((response) => response.json().then((body) => {
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				if (!body || body.ok !== true) throw new Error((body && body.error) || "request rejected");
				return body.value;
			}));
		}

		/** 模块 id → 本地化名字。 */
		function labelOf(t, id, labels) {
			const fromDict = t(`moduleLabels.${id}`);
			if (typeof fromDict === "string" && fromDict.length > 0 && fromDict !== `moduleLabels.${id}`) return fromDict;
			if (labels && typeof labels[id] === "string") return labels[id];
			return id;
		}

		/**
		 * 一条记忆模块的卡片：名字、计数、权重滑杆、启停开关。
		 */
		function ModuleCard(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const module = props.module;
			const id = props.id;
			const label = labelOf(t, id, props.labels);
			const profile = props.profiles ? props.profiles[id] : undefined;
			const onWeight = typeof props.onWeight === "function" ? props.onWeight : () => {};
			const onToggle = typeof props.onToggle === "function" ? props.onToggle : () => {};
			const onClear = typeof props.onClear === "function" ? props.onClear : () => {};

			const meta = [];
			meta.push(`${module.count} ${t("entries")}`);
			if (typeof module.avgWeight === "number" && module.count > 0) {
				meta.push(`${t("average")} ${module.avgWeight.toFixed(2)}`);
			}
			if (profile && profile.always) meta.push(t("always"));
			else if (profile && profile.boost) meta.push(`${t("boost")} +${profile.boost.toFixed(1)}`);
			if (profile && profile.limit > 0) meta.push(`${t("limit")} ${profile.limit}`);

			return jsxRuntime.jsxs("div", { style: styles.card, children: [
				jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
					jsxRuntime.jsx("div", { style: styles.moduleName, children: label }, "module-name-" + id),
					jsxRuntime.jsxs("div", { style: styles.moduleMeta, children: [
						jsxRuntime.jsx("div", { children: meta.join(" · ") }, "module-meta-text-" + id),
						jsxRuntime.jsx("input", {
							type: "range",
							min: 0,
							max: 1,
							step: 0.05,
							value: module.weight,
							style: styles.slider,
							disabled: props.busy === true,
							onChange: (event) => onWeight(id, Number(event && event.target ? event.target.value : 0)),
						}, "module-slider-" + id),
					] }, "module-meta-" + id),
					jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
						jsxRuntime.jsx("span", { style: styles.weightValue, children: Number(module.weight ?? 0).toFixed(2) }, "module-weight-" + id),
						jsxRuntime.jsx("button", {
							type: "button",
							style: module.enabled ? styles.toggleOn : styles.toggle,
							disabled: props.busy === true,
							onClick: () => onToggle(id, !module.enabled),
							children: module.enabled ? t("enabled") : t("disabled"),
						}, "module-toggle-" + id),
					] }, "module-actions-" + id),
				] }, "module-row-" + id),
				module.count > 0
					? jsxRuntime.jsx("div", { style: styles.moduleMeta, children: module.top.map((item) => item.text).join(" / ") }, "module-top-" + id)
					: null,
				module.count > 0 && props.canClear === true
					? jsxRuntime.jsx("div", { children: jsxRuntime.jsx("button", {
						type: "button",
						style: styles.dangerButton,
						disabled: props.busy === true,
						onClick: () => onClear(id),
						children: t("clear"),
					}, "module-clear-" + id) }, "module-clear-wrap-" + id)
					: null,
			] }, "module-" + id);
		}

		/**
		 * 声音卡片：语气、口头禅、表情、自称。
		 */
		function VoiceCard(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const voice = props.voice;
			const style = voice.style || {};
			const busy = props.busy === true;
			const onSave = typeof props.onSave === "function" ? props.onSave : () => {};

			return jsxRuntime.jsxs("div", { style: styles.card, children: [
				jsxRuntime.jsx("h3", { style: styles.subHeading, children: t("voiceTitle") }, "voice-heading"),
				jsxRuntime.jsx("p", { style: styles.hint, children: t("voiceNote") }, "voice-note"),
				jsxRuntime.jsxs("label", { style: styles.field, children: [
					jsxRuntime.jsx("span", { style: styles.fieldLabel, children: t("tone") }, "voice-tone-label"),
					jsxRuntime.jsx("input", {
						type: "text",
						style: styles.input,
						value: style.tone || "",
						placeholder: t("tonePlaceholder"),
						disabled: busy,
						onChange: (event) => onSave({ tone: event && event.target ? event.target.value : "" }, false),
					}, "voice-tone-input"),
				] }, "voice-tone-field"),
				jsxRuntime.jsxs("label", { style: styles.field, children: [
					jsxRuntime.jsx("span", { style: styles.fieldLabel, children: t("tics") }, "voice-tics-label"),
					jsxRuntime.jsx("textarea", {
						style: styles.textarea,
						value: Array.isArray(style.tics) ? style.tics.join("\\n") : "",
						placeholder: t("ticsPlaceholder"),
						disabled: busy,
						onChange: (event) => onSave({ tics: (event && event.target ? event.target.value : "").split(/[\\n,，]/).map((s) => s.trim()).filter((s) => s.length > 0) }, false),
					}, "voice-tics-input"),
				] }, "voice-tics-field"),
				jsxRuntime.jsxs("label", { style: styles.field, children: [
					jsxRuntime.jsx("span", { style: styles.fieldLabel, children: t("address") }, "voice-address-label"),
					jsxRuntime.jsx("input", {
						type: "text",
						style: styles.input,
						value: style.address || "",
						disabled: busy,
						onChange: (event) => onSave({ address: event && event.target ? event.target.value : "" }, false),
					}, "voice-address-input"),
				] }, "voice-address-field"),
				jsxRuntime.jsx("button", {
					type: "button",
					style: styles.primaryButton,
					disabled: busy,
					onClick: () => onSave({}, true),
					children: t("saved"),
				}, "voice-save"),
			] }, "voice-card");
		}

		/**
		 * 能力开关卡片：网络、自动互动。
		 */
		function CapabilityCard(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const modules = props.modules || {};
			const busy = props.busy === true;
			const onToggle = typeof props.onToggle === "function" ? props.onToggle : () => {};
			const entries = [
				{ id: "network", title: t("networkTitle"), note: t("networkNote") },
				{ id: "agentive", title: t("agentiveTitle"), note: t("agentiveNote") },
			];
			return jsxRuntime.jsxs("div", { style: styles.card, children: [
				jsxRuntime.jsx("h3", { style: styles.subHeading, children: t("capTitle") }, "cap-heading"),
				jsxRuntime.jsxs("div", { style: styles.list, children: entries.map((entry) => {
					const module = modules[entry.id] || { enabled: false, count: 0 };
					return jsxRuntime.jsxs("div", { style: styles.row, children: [
						jsxRuntime.jsxs("div", { style: styles.rowText, children: [
							jsxRuntime.jsx("div", { style: styles.moduleName, children: entry.title }, "cap-title-" + entry.id),
							jsxRuntime.jsx("div", { style: styles.moduleMeta, children: entry.note }, "cap-note-" + entry.id),
						] }, "cap-text-" + entry.id),
						jsxRuntime.jsx("button", {
							type: "button",
							style: module.enabled ? styles.toggleOn : styles.toggle,
							disabled: busy,
							onClick: () => onToggle(entry.id, !module.enabled),
							children: module.enabled ? t("enabled") : t("disabled"),
						}, "cap-toggle-" + entry.id),
					] }, "cap-row-" + entry.id);
				}) }, "cap-list"),
			] }, "cap-card");
		}

		/**
		 * 手动底线卡片：只有钉在这里的条目才会每次强制注入。
		 */
		function ManualBottomlineCard(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const module = props.module || { items: [] };
			const items = Array.isArray(module.items) ? module.items : [];
			const busy = props.busy === true;
			const draft = typeof props.draft === "string" ? props.draft : "";
			const onDraft = typeof props.onDraft === "function" ? props.onDraft : () => {};
			const onAdd = typeof props.onAdd === "function" ? props.onAdd : () => {};
			const onPin = typeof props.onPin === "function" ? props.onPin : () => {};
			const onRemove = typeof props.onRemove === "function" ? props.onRemove : () => {};

			return jsxRuntime.jsxs("div", { style: styles.card, children: [
				jsxRuntime.jsx("h3", { style: styles.subHeading, children: t("manualTitle") }, "manual-heading"),
				jsxRuntime.jsx("p", { style: styles.hint, children: t("manualNote") }, "manual-note"),
				jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
					jsxRuntime.jsx("input", {
						type: "text",
						style: styles.input,
						value: draft,
						placeholder: t("manualPlaceholder"),
						disabled: busy,
						onChange: (event) => onDraft(event && event.target ? event.target.value : ""),
					}, "manual-input"),
					jsxRuntime.jsx("button", {
						type: "button",
						style: styles.primaryButton,
						disabled: busy || draft.trim().length === 0,
						onClick: onAdd,
						children: t("manualAdd"),
					}, "manual-add"),
				] }, "manual-row"),
				items.length === 0
					? jsxRuntime.jsx("p", { style: styles.hint, children: t("manualEmpty") }, "manual-empty")
					: jsxRuntime.jsxs("ul", { style: styles.list, children: items.map((item) => jsxRuntime.jsxs("li", { style: styles.row, children: [
						jsxRuntime.jsx("span", { style: styles.badge, children: t("manualPinned") }, "manual-badge-" + item.id),
						jsxRuntime.jsx("span", { style: styles.rowText, children: item.text }, "manual-text-" + item.id),
						jsxRuntime.jsx("button", {
							type: "button",
							style: styles.button,
							disabled: busy,
							onClick: () => onPin(item.id, false),
							children: t("manualUnpin"),
						}, "manual-unpin-" + item.id),
						jsxRuntime.jsx("button", {
							type: "button",
							style: styles.dangerButton,
							disabled: busy,
							onClick: () => onRemove(item.id),
							children: t("manualRemove"),
						}, "manual-remove-" + item.id),
					] }, "manual-" + item.id)) }, "manual-list"),
			] }, "manual-card");
		}

		/**
		 * 记忆寿命切换：永久 / 临时。
		 */
		function LifetimeToggle(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const entry = props.entry || {};
			const busy = props.busy === true;
			const onLifetime = typeof props.onLifetime === "function" ? props.onLifetime : () => {};
			const temporary = entry.lifetime === "temporary";
			return jsxRuntime.jsxs("span", { style: styles.moduleRow, children: [
				jsxRuntime.jsx("button", {
					type: "button",
					style: !temporary ? styles.toggleOn : styles.toggle,
					disabled: busy,
					onClick: () => onLifetime("permanent"),
					children: t("lifetimePermanent"),
				}, "lifetime-permanent-" + entry.id),
				jsxRuntime.jsx("button", {
					type: "button",
					style: temporary ? styles.toggleOn : styles.toggle,
					disabled: busy,
					onClick: () => onLifetime("temporary"),
					children: t("lifetimeTemporary"),
				}, "lifetime-temporary-" + entry.id),
			] }, "lifetime-" + (entry.id || "none"));
		}

		/**
		 * 自动互动的生效范围：全部会话 / 指定会话（工作区 → 会话多选）。
		 */
		function AgentiveScopeCard(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const module = props.module || {};
			const sessions = props.sessions || { workspaces: [], flat: [] };
			const busy = props.busy === true;
			const onScope = typeof props.onScope === "function" ? props.onScope : () => {};
			const onToggleSession = typeof props.onToggleSession === "function" ? props.onToggleSession : () => {};
			const scope = module.scope === "session" ? "session" : "all";
			const selected = Array.isArray(module.sessionIds) ? module.sessionIds : [];
			const manualDraft = props.manualDraft || "";
			const onManualDraft = typeof props.onManualDraft === "function" ? props.onManualDraft : () => {};
			const onManualAdd = typeof props.onManualAdd === "function" ? props.onManualAdd : () => {};
			const onRefresh = typeof props.onRefresh === "function" ? props.onRefresh : () => {};

			// 兼容两种形状：workspaces（分组）与 flat（扁平清单）
			let groups = Array.isArray(sessions.workspaces) ? sessions.workspaces.filter((ws) => Array.isArray(ws.sessions) && ws.sessions.length > 0) : [];
			if (groups.length === 0 && Array.isArray(sessions.flat) && sessions.flat.length > 0) {
				groups = [{ id: "__flat__", title: "", path: "", sessions: sessions.flat }];
			}
			const total = typeof sessions.total === "number" ? sessions.total : groups.reduce((sum, ws) => sum + (ws.sessions || []).length, 0);

			function sessionRow(session) {
				const isCurrent = session.current === true || (sessions.current && sessions.current === session.id);
				return jsxRuntime.jsxs("li", { style: styles.row, children: [
					jsxRuntime.jsx("input", {
						type: "checkbox",
						checked: selected.indexOf(session.id) >= 0,
						disabled: busy,
						onChange: () => onToggleSession(session.id),
					}, "scope-check-" + session.id),
					jsxRuntime.jsxs("div", { style: styles.rowText, children: [
						jsxRuntime.jsx("div", { style: styles.moduleName, children: session.title || session.id }, "scope-session-" + session.id),
						jsxRuntime.jsxs("div", { style: styles.moduleMeta, children: [
							String(session.id).slice(0, 8),
							session.live === true ? " · " + t("scopeLive") : "",
							session.cwd ? " · " + session.cwd : "",
						] }, "scope-meta-" + session.id),
					] }, "scope-text-" + session.id),
					isCurrent ? jsxRuntime.jsx("span", { style: styles.badgeOn, children: t("scopeCurrent") }, "scope-current-" + session.id) : null,
				] }, "scope-session-row-" + session.id);
			}

			// 已经勾选、但当前列表里找不到的会话（比如会话被归档了）也要显示，否则用户没法取消
			const knownIds = new Set();
			for (const group of groups) for (const session of group.sessions || []) knownIds.add(session.id);
			const orphanIds = selected.filter((id) => !knownIds.has(id));

			let scopeBody = null;
			if (scope === "session") {
				if (groups.length === 0) {
					scopeBody = jsxRuntime.jsxs("div", { children: [
						jsxRuntime.jsx("p", { style: styles.hint, children: t("scopeEmpty") }, "scope-empty"),
						sessions.error ? jsxRuntime.jsx("p", { style: styles.moduleMeta, children: String(sessions.error) }, "scope-error") : null,
					] }, "scope-empty-wrap");
				} else {
					const wsNodes = groups.map((workspace) => jsxRuntime.jsxs("div", { style: styles.card, children: [
						jsxRuntime.jsx("div", { style: styles.moduleName, children: workspace.title || workspace.path || workspace.id }, "scope-ws-" + workspace.id),
						jsxRuntime.jsx("ul", { style: styles.list, children: (workspace.sessions || []).map((session) => sessionRow(session)) }, "scope-sessions-" + workspace.id),
					] }, "scope-ws-card-" + workspace.id));
					scopeBody = jsxRuntime.jsxs("div", { style: styles.list, children: [
						...wsNodes,
						orphanIds.length === 0 ? null : jsxRuntime.jsx("ul", { style: styles.list, children: orphanIds.map((id) => jsxRuntime.jsxs("li", { style: styles.row, children: [
							jsxRuntime.jsx("input", { type: "checkbox", checked: true, disabled: busy, onChange: () => onToggleSession(id) }, "scope-orphan-check-" + id),
							jsxRuntime.jsx("span", { style: styles.rowText, children: String(id).slice(0, 8) + " " + t("scopeUnknown") }, "scope-orphan-" + id),
						] }, "scope-orphan-row-" + id)) }, "scope-orphans"),
						jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
							jsxRuntime.jsx("input", {
								style: styles.input,
								value: manualDraft,
								placeholder: t("scopeManual"),
								disabled: busy,
								onChange: (event) => onManualDraft(event && event.target ? event.target.value : ""),
							}, "scope-manual-input"),
							jsxRuntime.jsx("button", {
								type: "button",
								style: styles.button,
								disabled: busy || !String(manualDraft || "").trim(),
								onClick: onManualAdd,
								children: t("scopeManualAdd"),
							}, "scope-manual-add"),
						] }, "scope-manual-row"),
						jsxRuntime.jsx("p", { style: styles.hint, children: t("scopeManualHint") }, "scope-manual-hint"),
						sessions.error ? jsxRuntime.jsx("p", { style: styles.moduleMeta, children: String(sessions.error) }, "scope-error") : null,
					] }, "scope-workspaces");
				}
			}

			// 时间窗：设了窗口就只在窗口内主动
			const window = module.timeWindow || { enabled: false, start: "09:00", end: "23:00" };
			const onWindow = typeof props.onWindow === "function" ? props.onWindow : () => {};

			return jsxRuntime.jsxs("div", { style: styles.card, children: [
				jsxRuntime.jsx("h3", { style: styles.subHeading, children: t("scopeTitle") }, "scope-heading"),
				jsxRuntime.jsx("p", { style: styles.hint, children: t("scopeHint") }, "scope-hint"),
				jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
					jsxRuntime.jsx("button", {
						type: "button",
						style: scope === "all" ? styles.toggleOn : styles.toggle,
						disabled: busy,
						onClick: () => onScope("all"),
						children: t("scopeAll"),
					}, "scope-all"),
					jsxRuntime.jsx("button", {
						type: "button",
						style: scope === "session" ? styles.toggleOn : styles.toggle,
						disabled: busy,
						onClick: () => onScope("session"),
						children: t("scopeSession"),
					}, "scope-session"),
					jsxRuntime.jsx("span", { style: styles.moduleMeta, children: total + " " + t("scopeCount") }, "scope-total"),
					jsxRuntime.jsx("button", {
						type: "button",
						style: styles.button,
						disabled: busy,
						onClick: onRefresh,
						children: t("scopeRefresh"),
					}, "scope-refresh"),
				] }, "scope-row"),
				scope === "session" ? scopeBody : null,
				jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
					jsxRuntime.jsx("span", { style: styles.moduleName, children: t("timeWindowTitle") }, "window-label"),
					jsxRuntime.jsx("button", {
						type: "button",
						style: window.enabled ? styles.toggleOn : styles.toggle,
						disabled: busy,
						onClick: () => onWindow({ enabled: !window.enabled }),
						children: window.enabled ? t("windowOn") : t("windowOff"),
					}, "window-toggle"),
					jsxRuntime.jsx("input", {
						style: styles.input,
						value: window.start,
						disabled: busy || !window.enabled,
						onChange: (event) => onWindow({ enabled: true, start: event.target.value }),
					}, "window-start"),
					jsxRuntime.jsx("input", {
						style: styles.input,
						value: window.end,
						disabled: busy || !window.enabled,
						onChange: (event) => onWindow({ enabled: true, end: event.target.value }),
					}, "window-end"),
				] }, "window-row"),
				jsxRuntime.jsx("p", { style: styles.hint, children: t("timeWindowHint") }, "window-hint"),
			] }, "scope-card");
		}

		/**
		 * 自动互动卡片：定时真的给活跃会话发主动指令。
		 */
		function ProactiveCard(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const proactive = props.proactive || {};
			const busy = props.busy === true;
			const enabled = proactive.enabled === true;
			const runtime = proactive.runtime || {};
			const intervalMinutes = Math.max(1, Math.round(Number(proactive.intervalMs || 900000) / 60000));
			const intervalValue = props.intervalDraft !== null && props.intervalDraft !== undefined
				? String(props.intervalDraft)
				: String(intervalMinutes);
			const onToggle = typeof props.onToggle === "function" ? props.onToggle : () => {};
			const onInterval = typeof props.onInterval === "function" ? props.onInterval : () => {};
			const onIntervalDraft = typeof props.onIntervalDraft === "function" ? props.onIntervalDraft : () => {};
			const onNow = typeof props.onNow === "function" ? props.onNow : () => {};

			const lastFiredAt = Number(runtime.lastFiredAt || 0);
			const statusBits = [
				runtime.running ? t("proactiveRunning") : t("proactiveStopped"),
				t("proactiveFired") + " " + Number(runtime.fired || 0),
				t("proactiveSkipped") + " " + Number(runtime.skipped || 0),
				t("proactiveTracking") + " " + Number(runtime.trackedAgents || 0) + " " + t("scopeCount"),
				t("proactiveLastFired") + "：" + (lastFiredAt ? new Date(lastFiredAt).toLocaleString("zh-CN") : t("proactiveNever")),
			];

			return jsxRuntime.jsxs("div", { style: styles.card, children: [
				jsxRuntime.jsx("h3", { style: styles.subHeading, children: t("proactiveTitle") }, "proactive-heading"),
				jsxRuntime.jsx("p", { style: styles.hint, children: t("proactiveNote") }, "proactive-note"),
				jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
					jsxRuntime.jsx("span", { style: styles.fieldLabel, children: t("proactiveInterval") }, "proactive-interval-label"),
					jsxRuntime.jsx("input", {
						style: styles.input,
						value: intervalValue,
						disabled: busy,
						onChange: (event) => onIntervalDraft(event && event.target ? event.target.value : ""),
					}, "proactive-interval-input"),
					jsxRuntime.jsx("span", { style: styles.moduleMeta, children: t("proactiveIntervalUnit") }, "proactive-interval-unit"),
					jsxRuntime.jsx("button", {
						type: "button",
						style: styles.button,
						disabled: busy,
						onClick: () => onInterval(intervalValue),
						children: t("proactiveIntervalApply"),
					}, "proactive-interval-save"),
					jsxRuntime.jsx("button", {
						type: "button",
						style: styles.button,
						disabled: busy,
						onClick: onNow,
						children: t("proactiveNow"),
					}, "proactive-now"),
				] }, "proactive-interval-row"),
				jsxRuntime.jsx("p", { style: styles.hint, children: statusBits.join(" · ") }, "proactive-status"),
				jsxRuntime.jsx("p", { style: styles.hint, children: t("proactiveStatusHint") }, "proactive-status-hint"),
			] }, "proactive-card");
		}

		/**
		 * 表情包卡片：设置目录、看目录里有什么、往目录里加一个。
		 */
		function EmojiCard(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const emoji = props.emoji || { dir: "", exists: false, items: [], count: 0 };
			const busy = props.busy === true;
			const draft = props.draft || { dir: "", name: "", value: "" };
			const onDraft = typeof props.onDraft === "function" ? props.onDraft : () => {};
			const onSaveDir = typeof props.onSaveDir === "function" ? props.onSaveDir : () => {};
			const onAdd = typeof props.onAdd === "function" ? props.onAdd : () => {};
			const items = Array.isArray(emoji.items) ? emoji.items : [];
			const emojiDirText = String(emoji.dir ?? "");
			const auto = emoji.auto || {};
			const autoEnabled = auto.enabled !== false;
			const autoMinutes = Math.max(1, Math.round(Number(auto.intervalMs || 300000) / 60000));
			const scannedAt = Number(auto.scannedAt || 0);
			const changes = Array.isArray(auto.changes) ? auto.changes : [];
			const lastChange = changes.length ? changes[0] : null;
			const intervalValue = props.intervalDraft !== null && props.intervalDraft !== undefined
				? String(props.intervalDraft)
				: String(autoMinutes);
			const onToggleAuto = typeof props.onToggleAuto === "function" ? props.onToggleAuto : () => {};
			const onRescan = typeof props.onRescan === "function" ? props.onRescan : () => {};
			const onInterval = typeof props.onInterval === "function" ? props.onInterval : () => {};
			const onIntervalDraft = typeof props.onIntervalDraft === "function" ? props.onIntervalDraft : () => {};

			const changeText = lastChange
				? [
					(lastChange.added || []).length ? "+" + (lastChange.added || []).join("、") : "",
					(lastChange.removed || []).length ? "-" + (lastChange.removed || []).join("、") : "",
				].filter((part) => part.length > 0).join(" ")
				: "";
			const statusBits = [
				t("emojiScanned") + "：" + (scannedAt ? new Date(scannedAt).toLocaleString("zh-CN") : t("emojiNever")),
				emoji.exists ? t("emojiTextCount") + " " + Number(emoji.textCount || 0) + " / " + t("emojiImageCount") + " " + Number(emoji.imageCount || 0) : "",
				changeText ? t("emojiChangeTitle") + "：" + changeText : "",
			].filter((part) => String(part || "").length > 0);

			const rows = items.length
				? items.map((item) => jsxRuntime.jsxs("li", { style: styles.row, children: [
					jsxRuntime.jsx("span", { style: styles.rowText, children: item.name }, "emoji-name-" + item.name),
					jsxRuntime.jsx("span", { style: styles.moduleMeta, children: item.kind === "image" ? "[" + t("emojiImageTag") + "]" + (item.size ? " " + Math.round(item.size / 1024) + "KB" : "") : item.value }, "emoji-value-" + item.name),
				] }, "emoji-row-" + item.name))
				: [jsxRuntime.jsx("p", { style: styles.hint, children: t("emojiEmpty") }, "emoji-empty")];

			return jsxRuntime.jsxs("div", { style: styles.card, children: [
				jsxRuntime.jsx("h3", { style: styles.subHeading, children: t("emojiTitle") }, "emoji-heading"),
				jsxRuntime.jsx("p", { style: styles.hint, children: t("emojiNote") }, "emoji-note"),
				jsxRuntime.jsx("p", { style: styles.hint, children: [emoji.exists ? String(emoji.count || 0) + " " + t("emojiCount") : (emoji.error || ""), emojiDirText].filter((part) => String(part || "").length > 0).join(" · ") }, "emoji-path"),
				jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
					jsxRuntime.jsx("span", { style: styles.fieldLabel, children: t("emojiAuto") }, "emoji-auto-label"),
					jsxRuntime.jsx("button", {
						type: "button",
						style: styles.button,
						disabled: busy,
						onClick: () => onToggleAuto(!autoEnabled),
						children: autoEnabled ? t("emojiAutoToggleOn") : t("emojiAutoToggleOff"),
					}, "emoji-auto-toggle"),
					jsxRuntime.jsx("span", { style: styles.moduleMeta, children: autoEnabled ? t("emojiAutoOn") : t("emojiAutoOff") }, "emoji-auto-state"),
				] }, "emoji-auto-row"),
				jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
					jsxRuntime.jsx("span", { style: styles.fieldLabel, children: t("emojiInterval") }, "emoji-interval-label"),
					jsxRuntime.jsx("input", {
						style: styles.input,
						value: intervalValue,
						disabled: busy,
						onChange: (event) => onIntervalDraft(event && event.target ? event.target.value : ""),
					}, "emoji-interval-input"),
					jsxRuntime.jsx("span", { style: styles.moduleMeta, children: t("emojiIntervalUnit") }, "emoji-interval-unit"),
					jsxRuntime.jsx("button", {
						type: "button",
						style: styles.button,
						disabled: busy,
						onClick: () => onInterval(intervalValue),
						children: t("emojiIntervalApply"),
					}, "emoji-interval-save"),
					jsxRuntime.jsx("button", {
						type: "button",
						style: styles.button,
						disabled: busy,
						onClick: onRescan,
						children: t("emojiRescan"),
					}, "emoji-rescan"),
				] }, "emoji-interval-row"),
				jsxRuntime.jsx("p", { style: styles.hint, children: statusBits.join(" · ") }, "emoji-auto-status"),
				jsxRuntime.jsx("p", { style: styles.hint, children: t("emojiAutoHint") }, "emoji-auto-hint"),
				jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
					jsxRuntime.jsx("span", { style: styles.fieldLabel, children: t("emojiDefault") }, "emoji-default-label"),
					jsxRuntime.jsx("input", {
						style: styles.input,
						value: String(props.defaultEmoji || ""),
						placeholder: t("emojiDefaultPlaceholder"),
						disabled: busy,
						onChange: (event) => {
							const onDefaultEmoji = typeof props.onDefaultEmoji === "function" ? props.onDefaultEmoji : () => {};
							onDefaultEmoji(event && event.target ? event.target.value : "");
						},
					}, "emoji-default-input"),
					jsxRuntime.jsx("button", {
						type: "button",
						style: styles.button,
						disabled: busy,
						onClick: () => {
							const commit = typeof props.onDefaultEmojiCommit === "function" ? props.onDefaultEmojiCommit : () => {};
							commit();
						},
						children: t("emojiSave"),
					}, "emoji-default-save"),
				] }, "emoji-default-row"),
				jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
					jsxRuntime.jsx("input", {
						style: styles.input,
						value: draft.dir || "",
						placeholder: t("emojiDirPlaceholder"),
						disabled: busy,
						onChange: (event) => onDraft({ dir: event && event.target ? event.target.value : "" }),
					}, "emoji-dir-input"),
					jsxRuntime.jsx("button", {
						type: "button",
						style: styles.button,
						disabled: busy,
						onClick: onSaveDir,
						children: t("emojiSave"),
					}, "emoji-dir-save"),
				] }, "emoji-dir-row"),
				jsxRuntime.jsxs("ul", { style: styles.list, children: rows }, "emoji-list"),
				jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
					jsxRuntime.jsx("input", {
						style: styles.input,
						value: draft.name || "",
						placeholder: t("emojiName"),
						disabled: busy,
						onChange: (event) => onDraft({ name: event && event.target ? event.target.value : "" }),
					}, "emoji-name-input"),
					jsxRuntime.jsx("input", {
						style: styles.input,
						value: draft.value || "",
						placeholder: t("emojiValue"),
						disabled: busy,
						onChange: (event) => onDraft({ value: event && event.target ? event.target.value : "" }),
					}, "emoji-value-input"),
					jsxRuntime.jsx("button", {
						type: "button",
						style: styles.primaryButton,
						disabled: busy,
						onClick: onAdd,
						children: t("emojiAdd"),
					}, "emoji-add"),
				] }, "emoji-add-row"),
			] }, "emoji-card");
		}

		/**
		 * 人设卡片：列出全部人设、切换、编辑/新建、删除。
		 */
		function PersonaCard(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const persona = props.persona || {};
			const list = Array.isArray(persona.list) ? persona.list : (Array.isArray(persona.list && persona.list.list) ? persona.list.list : []);
			const busy = props.busy === true;
			const onUse = typeof props.onUse === "function" ? props.onUse : () => {};
			const onSave = typeof props.onSave === "function" ? props.onSave : () => {};
			const onDelete = typeof props.onDelete === "function" ? props.onDelete : () => {};
			const editing = props.editing === true;
			const draftName = typeof props.draftName === "string" ? props.draftName : "";
			const draftText = typeof props.draftText === "string" ? props.draftText : "";
			const onDraft = typeof props.onDraft === "function" ? props.onDraft : () => {};
			const onEdit = typeof props.onEdit === "function" ? props.onEdit : () => {};

			// 「按会话指定」：把工作区里的会话摊平成一个下拉列表
			const sessionDraft = props.sessionDraft || { sessionId: "", personaId: "" };
			const onSessionDraft = typeof props.onSessionDraft === "function" ? props.onSessionDraft : () => {};
			const onSessionPersona = typeof props.onSessionPersona === "function" ? props.onSessionPersona : () => {};
			const onClearSessionPersona = typeof props.onClearSessionPersona === "function" ? props.onClearSessionPersona : () => {};
			const sessionSource = props.sessions || {};
			const sessionOptions = [];
			const seenSessions = new Set();
			const pushSession = (session, workspaceTitle) => {
				if (!session || typeof session.id !== "string" || seenSessions.has(session.id)) return;
				seenSessions.add(session.id);
				const suffix = [];
				if (workspaceTitle) suffix.push(workspaceTitle);
				if (session.current === true || sessionSource.current === session.id) suffix.push(t("scopeCurrent"));
				sessionOptions.push({ id: session.id, title: (session.title || String(session.id).slice(0, 8)) + (suffix.length ? " · " + suffix.join(" · ") : "") });
			};
			for (const workspace of Array.isArray(sessionSource.workspaces) ? sessionSource.workspaces : []) {
				for (const session of workspace.sessions || []) pushSession(session, workspace.title || workspace.path || "");
			}
			for (const session of Array.isArray(sessionSource.flat) ? sessionSource.flat : []) pushSession(session, "");
			const noSessions = sessionOptions.length === 0;

			// 已经单独指定了人设的会话：显示成「会话 → 人设」，可以取消
			const bySession = (persona.bySession && typeof persona.bySession === "object") ? persona.bySession : {};
			const assignedRows = Object.keys(bySession).map((sessionId) => {
				const option = sessionOptions.find((item) => item.id === sessionId);
				const personaId = bySession[sessionId];
				const personaName = (list.find((item) => item.id === personaId) || {}).name || personaId;
				return jsxRuntime.jsxs("li", { style: styles.row, children: [
					jsxRuntime.jsx("span", { style: styles.rowText, children: (option ? option.title : String(sessionId).slice(0, 8) + " " + t("scopeUnknown")) + " → " + personaName }, "persona-assigned-" + sessionId),
					jsxRuntime.jsx("button", {
						type: "button",
						style: styles.button,
						disabled: busy,
						onClick: () => onClearSessionPersona(sessionId),
						children: t("personaSessionNone"),
					}, "persona-assigned-clear-" + sessionId),
				] }, "persona-assigned-row-" + sessionId);
			});

			const rows = list.map((item) => jsxRuntime.jsxs("div", { style: styles.row, children: [
				jsxRuntime.jsx("span", { style: styles.rowText, children: item.name + (item.bundled ? " · " + t("personaBundled") : " · " + t("personaCustom")) }, "persona-name-" + item.id),
				item.id === persona.current
					? jsxRuntime.jsx("span", { style: styles.badgeOn, children: t("personaCurrent") }, "persona-current-" + item.id)
					: jsxRuntime.jsx("button", {
						type: "button",
						style: styles.toggle,
						disabled: busy,
						onClick: () => onUse(item.id),
						children: t("personaUse"),
					}, "persona-use-" + item.id),
				jsxRuntime.jsx("button", {
					type: "button",
					style: styles.button,
					disabled: busy,
					onClick: () => onEdit(item.id),
					children: t("personaEdit"),
				}, "persona-edit-" + item.id),
				item.bundled === true
					? null
					: jsxRuntime.jsx("button", {
						type: "button",
						style: styles.dangerButton,
						disabled: busy,
						onClick: () => onDelete(item.id),
						children: t("personaDelete"),
					}, "persona-delete-" + item.id),
			] }, "persona-row-" + item.id));

			return jsxRuntime.jsxs("div", { style: styles.card, children: [
				jsxRuntime.jsx("h3", { style: styles.subHeading, children: t("personaTitle") }, "persona-heading"),
				jsxRuntime.jsx("p", { style: styles.hint, children: t("personaNote") }, "persona-note"),
				rows.length === 0
					? jsxRuntime.jsx("p", { style: styles.hint, children: t("personaEmpty") }, "persona-empty")
					: jsxRuntime.jsxs("div", { style: styles.list, children: rows }, "persona-list"),
				editing
					? jsxRuntime.jsxs("div", { style: styles.card, children: [
						jsxRuntime.jsxs("label", { style: styles.field, children: [
							jsxRuntime.jsx("span", { style: styles.fieldLabel, children: t("personaNewName") }, "persona-name-label"),
							jsxRuntime.jsx("input", {
								type: "text",
								style: styles.input,
								value: draftName,
								disabled: busy,
								onChange: (event) => onDraft({ name: event && event.target ? event.target.value : "" }),
							}, "persona-name-input"),
						] }, "persona-name-field"),
						jsxRuntime.jsxs("label", { style: styles.field, children: [
							jsxRuntime.jsx("span", { style: styles.fieldLabel, children: t("personaNewBody") }, "persona-body-label"),
							jsxRuntime.jsx("textarea", {
								style: styles.textarea,
								value: draftText,
								disabled: busy,
								onChange: (event) => onDraft({ text: event && event.target ? event.target.value : "" }),
							}, "persona-body-input"),
						] }, "persona-body-field"),
						jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
							jsxRuntime.jsx("button", {
								type: "button",
								style: styles.primaryButton,
								disabled: busy,
								onClick: () => onSave(),
								children: t("personaSave"),
							}, "persona-save"),
							jsxRuntime.jsx("button", {
								type: "button",
								style: styles.button,
								disabled: busy,
								onClick: () => onEdit(""),
								children: t("close"),
							}, "persona-cancel"),
						] }, "persona-actions"),
					] }, "persona-editor")
					: jsxRuntime.jsx("button", {
						type: "button",
						style: styles.button,
						disabled: busy,
						onClick: () => onEdit("__new__"),
						children: t("personaNew"),
					}, "persona-new"),
				jsxRuntime.jsx("h4", { style: styles.subHeading, children: t("personaSession") }, "persona-session-heading"),
				jsxRuntime.jsx("p", { style: styles.hint, children: t("personaSessionHint") }, "persona-session-hint"),
				noSessions ? jsxRuntime.jsx("p", { style: styles.hint, children: t("scopeEmpty") }, "persona-session-empty") : null,
				assignedRows.length === 0 ? null : jsxRuntime.jsxs("div", { children: [
					jsxRuntime.jsx("p", { style: styles.fieldLabel, children: t("personaAssigned") }, "persona-assigned-label"),
					jsxRuntime.jsx("ul", { style: styles.list, children: assignedRows }, "persona-assigned-list"),
				] }, "persona-assigned"),
				jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
					jsxRuntime.jsxs("select", {
						style: styles.input,
						value: sessionDraft.sessionId || "",
						disabled: busy,
						onChange: (event) => onSessionDraft({ ...sessionDraft, sessionId: event && event.target ? event.target.value : "" }),
						children: [
							jsxRuntime.jsx("option", { value: "", children: t("personaSessionNone") }, "session-none"),
							...sessionOptions.map((option) => jsxRuntime.jsx("option", { value: option.id, children: option.title }, "session-opt-" + option.id)),
						],
					}, "persona-session-select"),
					jsxRuntime.jsxs("select", {
						style: styles.input,
						value: sessionDraft.personaId || "",
						disabled: busy,
						onChange: (event) => onSessionDraft({ ...sessionDraft, personaId: event && event.target ? event.target.value : "" }),
						children: [
							jsxRuntime.jsx("option", { value: "", children: t("personaSessionNone") }, "persona-opt-none"),
							...list.map((item) => jsxRuntime.jsx("option", { value: item.id, children: item.name }, "persona-opt-" + item.id)),
						],
					}, "persona-session-persona-select"),
					jsxRuntime.jsx("button", {
						type: "button",
						style: styles.primaryButton,
						disabled: busy || !sessionDraft.sessionId,
						onClick: onSessionPersona,
						children: t("personaSessionSave"),
					}, "persona-session-save"),
				] }, "persona-session-row"),
			] }, "persona-card");
		}

		/**
		 * 语音与唱歌参数卡片：音色、语速、音调、音量、唱法。
		 */
		function SpeechCard(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const speech = props.speech || {};
			const sing = speech.sing || {};
			const busy = props.busy === true;
			const onSave = typeof props.onSave === "function" ? props.onSave : () => {};
			const onDraft = typeof props.onDraft === "function" ? props.onDraft : () => {};

			return jsxRuntime.jsxs("div", { style: styles.card, children: [
				jsxRuntime.jsx("h3", { style: styles.subHeading, children: t("speechTitle") }, "speech-heading"),
				jsxRuntime.jsx("p", { style: styles.hint, children: t("speechNote") }, "speech-note"),
				jsxRuntime.jsxs("label", { style: styles.field, children: [
					jsxRuntime.jsx("span", { style: styles.fieldLabel, children: t("speechVoice") }, "speech-voice-label"),
					jsxRuntime.jsx("input", {
						type: "text",
						style: styles.input,
						value: speech.voiceId || "",
						placeholder: t("speechVoiceIdPlaceholder"),
						disabled: busy,
						onChange: (event) => onDraft({ voiceId: event && event.target ? event.target.value : "" }),
					}, "speech-voice-id-input"),
				] }, "speech-voice-id-field"),
				jsxRuntime.jsxs("label", { style: styles.field, children: [
					jsxRuntime.jsx("span", { style: styles.fieldLabel, children: t("speechVoiceName") }, "speech-voice-name-label"),
					jsxRuntime.jsx("input", {
						type: "text",
						style: styles.input,
						value: speech.voiceName || "",
						placeholder: t("speechVoicePlaceholder"),
						disabled: busy,
						onChange: (event) => onDraft({ voiceName: event && event.target ? event.target.value : "" }),
					}, "speech-voice-name-input"),
				] }, "speech-voice-name-field"),
				jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
					jsxRuntime.jsx("span", { style: styles.moduleName, children: t("speechRate") }, "speech-rate-label"),
					jsxRuntime.jsx("input", {
						type: "range",
						min: 0.5,
						max: 2,
						step: 0.05,
						value: Number(speech.rate ?? 1),
						style: styles.slider,
						disabled: busy,
						onChange: (event) => onDraft({ rate: Number(event && event.target ? event.target.value : 1) }),
					}, "speech-rate-slider"),
					jsxRuntime.jsx("span", { style: styles.weightValue, children: Number(speech.rate ?? 1).toFixed(2) }, "speech-rate-value"),
				] }, "speech-rate-row"),
				jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
					jsxRuntime.jsx("span", { style: styles.moduleName, children: t("speechPitch") }, "speech-pitch-label"),
					jsxRuntime.jsx("input", {
						type: "range",
						min: 0.5,
						max: 2,
						step: 0.05,
						value: Number(speech.pitch ?? 1),
						style: styles.slider,
						disabled: busy,
						onChange: (event) => onDraft({ pitch: Number(event && event.target ? event.target.value : 1) }),
					}, "speech-pitch-slider"),
					jsxRuntime.jsx("span", { style: styles.weightValue, children: Number(speech.pitch ?? 1).toFixed(2) }, "speech-pitch-value"),
				] }, "speech-pitch-row"),
				jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
					jsxRuntime.jsx("span", { style: styles.moduleName, children: t("speechVolume") }, "speech-volume-label"),
					jsxRuntime.jsx("input", {
						type: "range",
						min: 0,
						max: 1,
						step: 0.05,
						value: Number(speech.volume ?? 0.9),
						style: styles.slider,
						disabled: busy,
						onChange: (event) => onDraft({ volume: Number(event && event.target ? event.target.value : 0.9) }),
					}, "speech-volume-slider"),
					jsxRuntime.jsx("span", { style: styles.weightValue, children: Number(speech.volume ?? 0.9).toFixed(2) }, "speech-volume-value"),
				] }, "speech-volume-row"),
				jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
					jsxRuntime.jsx("span", { style: styles.moduleName, children: t("speechSingEnabled") }, "speech-sing-label"),
					jsxRuntime.jsx("button", {
						type: "button",
						style: sing.enabled === true ? styles.toggleOn : styles.toggle,
						disabled: busy,
						onClick: () => onDraft({ sing: { enabled: sing.enabled !== true } }),
						children: sing.enabled === true ? t("enabled") : t("disabled"),
					}, "speech-sing-toggle"),
				] }, "speech-sing-row"),
				sing.enabled === true
					? jsxRuntime.jsxs("div", { style: styles.list, children: [
						jsxRuntime.jsxs("label", { style: styles.field, children: [
							jsxRuntime.jsx("span", { style: styles.fieldLabel, children: t("speechSingStyle") }, "speech-sing-style-label"),
							jsxRuntime.jsx("input", {
								type: "text",
								style: styles.input,
								value: sing.style || "",
								placeholder: t("speechSingStylePlaceholder"),
								disabled: busy,
								onChange: (event) => onDraft({ sing: { enabled: true, style: event && event.target ? event.target.value : "" } }),
							}, "speech-sing-style-input"),
						] }, "speech-sing-style-field"),
						jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
							jsxRuntime.jsx("span", { style: styles.moduleName, children: t("speechSingBpm") }, "speech-sing-bpm-label"),
							jsxRuntime.jsx("input", {
								type: "range",
								min: 40,
								max: 240,
								step: 5,
								value: Number(sing.bpm ?? 90),
								style: styles.slider,
								disabled: busy,
								onChange: (event) => onDraft({ sing: { enabled: true, bpm: Number(event && event.target ? event.target.value : 90) } }),
							}, "speech-sing-bpm-slider"),
							jsxRuntime.jsx("span", { style: styles.weightValue, children: String(sing.bpm ?? 90) }, "speech-sing-bpm-value"),
						] }, "speech-sing-bpm-row"),
						jsxRuntime.jsxs("label", { style: styles.field, children: [
							jsxRuntime.jsx("span", { style: styles.fieldLabel, children: t("speechSingKey") }, "speech-sing-key-label"),
							jsxRuntime.jsx("input", {
								type: "text",
								style: styles.input,
								value: sing.key || "",
								placeholder: t("speechSingKeyPlaceholder"),
								disabled: busy,
								onChange: (event) => onDraft({ sing: { enabled: true, key: event && event.target ? event.target.value : "" } }),
							}, "speech-sing-key-input"),
						] }, "speech-sing-key-field"),
					] }, "speech-sing-detail")
					: null,
				jsxRuntime.jsx("button", {
					type: "button",
					style: styles.primaryButton,
					disabled: busy,
					onClick: () => onSave(),
					children: t("saved"),
				}, "speech-save"),
			] }, "speech-card");
		}

		/**
		 * 记忆搜索卡片。
		 */
		function MemorySearchCard(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const busy = props.busy === true;
			const query = typeof props.query === "string" ? props.query : "";
			const onQuery = typeof props.onQuery === "function" ? props.onQuery : () => {};
			const onSearch = typeof props.onSearch === "function" ? props.onSearch : () => {};
			const result = props.result || null;
			const filters = props.filters || { module: "", lifetime: "", pinned: false };
			const onFilter = typeof props.onFilter === "function" ? props.onFilter : () => {};
			const moduleOptions = Array.isArray(props.modules) ? props.modules : ["bottomline", "cognition", "emotion", "instinct"];

			const filterRow = jsxRuntime.jsxs("div", { style: styles.moduleRow, children: [
				jsxRuntime.jsxs("select", {
					style: styles.input,
					value: filters.module || "",
					disabled: busy,
					onChange: (event) => onFilter({ module: event && event.target ? event.target.value : "" }),
					children: [
						jsxRuntime.jsx("option", { value: "", children: t("searchFilterModule") + "：" + t("searchFilterAll") }, "filter-module-all"),
						...moduleOptions.map((id) => jsxRuntime.jsx("option", { value: id, children: labelOf(t, id, props.labels) }, "filter-module-" + id)),
					],
				}, "search-filter-module"),
				jsxRuntime.jsxs("select", {
					style: styles.input,
					value: filters.lifetime || "",
					disabled: busy,
					onChange: (event) => onFilter({ lifetime: event && event.target ? event.target.value : "" }),
					children: [
						jsxRuntime.jsx("option", { value: "", children: t("searchFilterLifetime") + "：" + t("searchFilterAll") }, "filter-life-all"),
						jsxRuntime.jsx("option", { value: "permanent", children: t("lifetimePermanent") }, "filter-life-permanent"),
						jsxRuntime.jsx("option", { value: "temporary", children: t("lifetimeTemporary") }, "filter-life-temporary"),
					],
				}, "search-filter-lifetime"),
				jsxRuntime.jsx("button", {
					type: "button",
					style: filters.pinned ? styles.toggleOn : styles.toggle,
					disabled: busy,
					onClick: () => onFilter({ pinned: !filters.pinned }),
					children: t("searchFilterPinned"),
				}, "search-filter-pinned"),
			] }, "search-filter-row");

			let body = null;
			if (result && Array.isArray(result.hits)) {
				body = result.hits.length === 0
					? jsxRuntime.jsx("p", { style: styles.hint, children: t("searchEmpty") }, "search-empty")
					: jsxRuntime.jsxs("ul", { style: styles.list, children: result.hits.map((hit) => jsxRuntime.jsxs("li", { style: styles.row, children: [
						jsxRuntime.jsx("span", { style: styles.badge, children: labelOf(t, hit.module, props.labels) }, "search-module-" + hit.id),
						jsxRuntime.jsx("span", { style: styles.rowText, children: hit.text }, "search-text-" + hit.id),
						jsxRuntime.jsx("span", { style: styles.badge, children: hit.lifetime === "temporary" ? t("lifetimeTemporary") : t("lifetimePermanent") }, "search-life-" + hit.id),
					] }, "search-hit-" + hit.id)) }, "search-list");
			}

			return jsxRuntime.jsxs("div", { style: styles.card, children: [
				jsxRuntime.jsx("h3", { style: styles.subHeading, children: t("searchTitle") }, "search-heading"),
				jsxRuntime.jsxs("div", { style: styles.searchRow, children: [
					jsxRuntime.jsx("input", {
						type: "text",
						style: styles.input,
						value: query,
						placeholder: t("searchPlaceholder"),
						disabled: busy,
						onChange: (event) => onQuery(event && event.target ? event.target.value : ""),
					}, "search-input"),
					jsxRuntime.jsx("button", {
						type: "button",
						style: styles.primaryButton,
						disabled: busy,
						onClick: onSearch,
						children: t("searchButton"),
					}, "search-button"),
				] }, "search-row"),
				filterRow,
				result
					? jsxRuntime.jsx("p", { style: styles.hint, children: String(result.total ?? 0) + " " + t("searchResult") }, "search-count")
					: null,
				body,
			] }, "search-card");
		}

		/**
		 * 面板主体：设置页与侧边栏浮层共用。
		 */
		function BrainPanel(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const [state, setState] = react.useState({ status: "loading" });
			const [busy, setBusy] = react.useState(false);
			const [message, setMessage] = react.useState(null);
			const [pending, setPending] = react.useState(null);
			const [voiceDraft, setVoiceDraft] = react.useState(null);
			const [speechDraft, setSpeechDraft] = react.useState(null);
			const [personaDraft, setPersonaDraft] = react.useState(null);
			const [personaEditing, setPersonaEditing] = react.useState("");
			const [searchQuery, setSearchQuery] = react.useState("");
			const [searchResult, setSearchResult] = react.useState(null);
			const [searchFilters, setSearchFilters] = react.useState({ module: "", lifetime: "", pinned: false });
			const [emojiDraft, setEmojiDraft] = react.useState(null);
			const [emojiMinutes, setEmojiMinutes] = react.useState(null);
			const [proactiveMinutes, setProactiveMinutes] = react.useState(null);
			const [sessionPersonaDraft, setSessionPersonaDraft] = react.useState({ sessionId: "", personaId: "" });
			const [defaultEmoji, setDefaultEmoji] = react.useState(null);
			const [manualSession, setManualSession] = react.useState("");

			const load = react.useCallback(() => {
				setState({ status: "loading" });
				fetchStatus()
					.then((value) => setState({ status: "ready", value }))
					.catch((error) => setState({ status: "error", message: error && error.message ? error.message : String(error) }));
			}, []);

			react.useEffect(() => { load(); }, [load]);

			const run = react.useCallback((payload, note) => {
				setBusy(true);
				setMessage(null);
				postMutate(payload)
					.then((value) => {
						setState({ status: "ready", value });
						setMessage({ kind: "ok", text: note || t("saved") });
					})
					.catch((error) => setMessage({ kind: "error", text: error && error.message ? error.message : String(error) }))
					.then(() => setBusy(false));
			}, [t]);

			const onWeight = react.useCallback((id, weight) => {
				// 拖动过程中不请求；松手才提交。`onChange` 每次像素移动都会触发。
				setPending({ id, weight });
			}, []);

			const commitWeight = react.useCallback(() => {
				if (!pending) return;
				const { id, weight } = pending;
				setPending(null);
				run({ action: "setWeight", module: id, weight });
			}, [pending, run]);

			react.useEffect(() => {
				if (!pending) return undefined;
				const timer = setTimeout(commitWeight, 220);
				return () => clearTimeout(timer);
			}, [pending, commitWeight]);

			const onToggle = react.useCallback((id, enabled) => {
				run({ action: "setEnabled", module: id, enabled });
			}, [run]);

			const onClear = react.useCallback((id) => {
				run({ action: "clear", module: id });
			}, [run]);

			const onVoice = react.useCallback((patch, commit) => {
				setVoiceDraft((previous) => {
					const base = previous || (state.value && state.value.voice ? state.value.voice.style : {}) || {};
					const next = { ...base, ...patch };
					if (commit === true) {
						run({ action: "setVoice", ...next });
						return next;
					}
					return next;
				});
			}, [state.value, run]);

			const [manualDraft, setManualDraft] = react.useState("");
			const latestRef = react.useRef([]);
			const modulesRef = react.useRef({});

			const onManualAdd = react.useCallback(() => {
				const text = manualDraft.trim();
				if (!text) return;
				run({ action: "addItem", module: "bottomline", text, pinned: true, lifetime: "permanent" });
				setManualDraft("");
			}, [manualDraft, run]);

			const onManualPin = react.useCallback((id, pinned) => {
				run({ action: "pinItem", module: "bottomline", id, pinned });
			}, [run]);

			const onManualRemove = react.useCallback((id) => {
				run({ action: "removeItem", module: "bottomline", id });
			}, [run]);

			const onLifetime = react.useCallback((id, lifetime) => {
				const entry = (latestRef.current || []).find((item) => item.id === id);
				run({ action: "setLifetime", module: entry ? entry.module : "cognition", id, lifetime });
			}, [run]);

			const onScope = react.useCallback((scope) => {
				run({ action: "setAgentiveScope", scope });
			}, [run]);

			const onSpeechDraft = react.useCallback((patch) => {
				setSpeechDraft((previous) => {
					const base = previous || (state.value && state.value.speech) || {};
					const next = { ...base, ...patch };
					if (patch && patch.sing) next.sing = { ...(base.sing || {}), ...patch.sing };
					return next;
				});
			}, [state.value]);

			const onSpeechSave = react.useCallback(() => {
				setSpeechDraft((previous) => {
					const base = previous || (state.value && state.value.speech) || {};
					run({ action: "setSpeech", ...base });
					return base;
				});
			}, [state.value, run]);

			const onPersonaUse = react.useCallback((id) => {
				run({ action: "selectPersona", id });
			}, [run]);

			const onPersonaEdit = react.useCallback((id) => {
				const list = (state.value && state.value.persona && state.value.persona.list && state.value.persona.list.list) || [];
				if (!id || id === "__new__") {
					setPersonaEditing("__new__");
					setPersonaDraft({ name: "", text: "" });
					return;
				}
				const found = list.find((item) => item.id === id);
				setPersonaEditing(id);
				setPersonaDraft({ name: found ? found.name : "", text: found && found.text ? found.text : "" });
			}, [state.value]);

			const onPersonaDraft = react.useCallback((patch) => {
				setPersonaDraft((previous) => ({ name: "", text: "", ...(previous || {}), ...patch }));
			}, []);

			const onPersonaSave = react.useCallback(() => {
				const draft = personaDraft || { name: "", text: "" };
				const name = String(draft.name || "").trim();
				const text = String(draft.text || "").trim();
				if (!name || !text) return;
				const payload = personaEditing && personaEditing !== "__new__"
					? { action: "savePersona", id: personaEditing, name, text }
					: { action: "savePersona", name, text };
				run(payload);
				setPersonaEditing("");
				setPersonaDraft(null);
			}, [personaDraft, personaEditing, run]);

			const onPersonaDelete = react.useCallback((id) => {
				run({ action: "deletePersona", id });
			}, [run]);

			const onWindow = react.useCallback((patch) => {
				const current = (modulesRef.current && modulesRef.current.agentive && modulesRef.current.agentive.timeWindow) || { enabled: false, start: "09:00", end: "23:00" };
				const next = { ...current, ...patch };
				run({ action: "setAgentiveTimeWindow", enabled: next.enabled === true, start: next.start, end: next.end });
			}, [run]);

			const onEmojiDraft = react.useCallback((patch) => {
				setEmojiDraft((previous) => ({ dir: "", name: "", value: "", ...(previous || {}), ...patch }));
			}, []);

			const onEmojiSaveDir = react.useCallback(() => {
				setEmojiDraft((previous) => {
					const draft = previous || {};
					run({ action: "setEmojiDir", dir: String(draft.dir || "").trim() });
					return draft;
				});
			}, [run]);

			const onEmojiToggleAuto = react.useCallback((enabled) => {
				run({ action: "setEmojiAuto", enabled: enabled === true });
			}, [run]);

			const onEmojiInterval = react.useCallback((minutes) => {
				const value = Number(minutes);
				if (!Number.isFinite(value) || value <= 0) {
					setMessage({ kind: "error", text: t("emojiInterval") + " > 0" });
					return;
				}
				setEmojiMinutes(null);
				run({ action: "setEmojiAuto", enabled: true, intervalMinutes: value });
			}, [run, t]);

			const onEmojiRescan = react.useCallback(() => {
				run({ action: "rescanEmoji" });
			}, [run]);

			const onProactiveInterval = react.useCallback((minutes) => {
				const value = Number(minutes);
				if (!Number.isFinite(value) || value <= 0) {
					setMessage({ kind: "error", text: t("proactiveInterval") + " > 0" });
					return;
				}
				setProactiveMinutes(null);
				run({ action: "setAgentiveInterval", intervalMinutes: value });
			}, [run, t]);

			const onProactiveNow = react.useCallback(() => {
				run({ action: "runProactive" });
			}, [run]);

			const onEmojiAdd = react.useCallback(() => {
				setEmojiDraft((previous) => {
					const draft = previous || {};
					const name = String(draft.name || "").trim();
					const value = String(draft.value || "").trim();
					if (!name || !value) return draft;
					run({ action: "addEmoji", name, value });
					return { dir: draft.dir || "", name: "", value: "" };
				});
			}, [run]);

			const onRefreshSessions = react.useCallback(() => {
				setBusy(true);
				setMessage(null);
				postMutate({ action: "refreshSessions" })
					.then((value) => {
						setState({ status: "ready", value });
						const snapshot = (value && value.sessions) || {};
						setMessage({ kind: "ok", text: t("scopeRefresh") + "：" + String(snapshot.total ?? 0) + " " + t("scopeCount") });
					})
					.catch((error) => setMessage({ kind: "error", text: error && error.message ? error.message : String(error) }))
					.then(() => setBusy(false));
			}, [t]);

			const onClearSessionPersona = react.useCallback((sessionId) => {
				run({ action: "setSessionPersona", sessionId, id: "" });
			}, [run]);

			const onDefaultEmoji = react.useCallback((value) => {
				setDefaultEmoji(String(value || ""));
			}, []);

			const onDefaultEmojiCommit = react.useCallback(() => {
				run({ action: "setVoice", emoji: defaultEmoji === null ? "" : defaultEmoji });
				setDefaultEmoji(null);
			}, [defaultEmoji, run]);

			const onManualSessionAdd = react.useCallback(() => {
				const id = String(manualSession || "").trim();
				if (!id) return;
				const current = (modulesRef.current && modulesRef.current.agentive) || {};
				const selected = Array.isArray(current.sessionIds) ? current.sessionIds.slice() : [];
				if (selected.indexOf(id) < 0) selected.push(id);
				setManualSession("");
				run({ action: "setAgentiveScope", scope: "session", sessionIds: selected });
			}, [manualSession, run]);

			const onSessionPersona = react.useCallback(() => {
				const draft = sessionPersonaDraft || { sessionId: "", personaId: "" };
				if (!draft.sessionId) return;
				run({ action: "setSessionPersona", sessionId: draft.sessionId, id: draft.personaId || "" });
			}, [sessionPersonaDraft, run]);

			const onSearchFilter = react.useCallback((patch) => {
				setSearchFilters((previous) => ({ ...(previous || {}), ...patch }));
			}, []);

			const onSearch = react.useCallback(() => {
				setBusy(true);
				const filters = searchFilters || {};
				const payload = { action: "searchMemory", query: searchQuery, limit: 30 };
				if (filters.module) payload.module = filters.module;
				if (filters.lifetime) payload.lifetime = filters.lifetime;
				if (filters.pinned) payload.pinned = true;
				postMutate(payload)
					.then((value) => setSearchResult(value && value.result ? value.result : { total: 0, hits: [] }))
					.catch((error) => setMessage({ kind: "error", text: error && error.message ? error.message : String(error) }))
					.then(() => setBusy(false));
			}, [searchQuery, searchFilters]);

			const onToggleSession = react.useCallback((sessionId) => {
				const current = (modulesRef.current && modulesRef.current.agentive) || {};
				const selected = Array.isArray(current.sessionIds) ? current.sessionIds.slice() : [];
				const index = selected.indexOf(sessionId);
				if (index >= 0) selected.splice(index, 1);
				else selected.push(sessionId);
				run({ action: "setAgentiveScope", scope: "session", sessionIds: selected });
			}, [run]);

			if (state.status === "loading") {
				return jsxRuntime.jsx("div", { style: styles.section, children: jsxRuntime.jsx("p", { style: styles.hint, children: t("loading") }, "loading") });
			}
			if (state.status === "error") {
				return jsxRuntime.jsxs("div", { style: styles.section, children: [
					jsxRuntime.jsx("p", { style: styles.messageError, children: state.message || t("failed") }, "error-text"),
					jsxRuntime.jsx("button", { type: "button", style: styles.button, onClick: load, children: t("refresh") }, "retry"),
				] }, "error");
			}

			const value = state.value;
			const modules = value.modules || {};
			const labels = value.labels || {};
			const profiles = value.profiles || {};
			const memoryModules = Array.isArray(value.memoryModules) ? value.memoryModules : ["bottomline", "cognition", "emotion", "instinct"];
			const voice = { ...(value.voice || {}), style: voiceDraft || (value.voice && value.voice.style) || {} };
			const latest = value.memory && Array.isArray(value.memory.latest) ? value.memory.latest : [];
			latestRef.current = latest;
			modulesRef.current = modules;
			const sessions = value.sessions || { workspaces: [] };
			const bottomline = modules.bottomline || { items: [], count: 0, avgWeight: 0, top: [] };

			return jsxRuntime.jsxs("div", { style: styles.section, children: [
				message === null
					? null
					: jsxRuntime.jsx("p", { style: message.kind === "ok" ? styles.messageOk : styles.messageError, children: message.text }, "message"),
				jsxRuntime.jsx("h3", { style: styles.subHeading, children: t("modulesTitle") }, "modules-heading"),
				jsxRuntime.jsxs("div", { style: styles.list, children: memoryModules.map((id) => jsxRuntime.jsx(ModuleCard, {
					id,
					module: modules[id] || { enabled: true, weight: 0.5, count: 0, avgWeight: 0, top: [] },
					labels,
					profiles,
					busy,
					canClear: true,
					t,
					onWeight,
					onToggle,
					onClear,
				}, "module-card-" + id)) }, "module-list"),
				jsxRuntime.jsx(ManualBottomlineCard, {
				module: bottomline,
				busy,
				draft: manualDraft,
				t,
				onDraft: setManualDraft,
				onAdd: onManualAdd,
				onPin: onManualPin,
				onRemove: onManualRemove,
			}, "manual-card-wrap"),
			jsxRuntime.jsx(VoiceCard, { voice, busy, t, onSave: onVoice }, "voice-card-wrap"),
				jsxRuntime.jsx(SpeechCard, {
					speech: speechDraft || (value && value.speech) || {},
					busy,
					t,
					onDraft: onSpeechDraft,
					onSave: onSpeechSave,
				}, "speech-card-wrap"),
				jsxRuntime.jsx(PersonaCard, {
					persona: (value && value.persona) || {},
					busy,
					t,
					editing: personaEditing !== "",
					draftName: (personaDraft && personaDraft.name) || "",
					draftText: (personaDraft && personaDraft.text) || "",
					sessions,
					sessionDraft: sessionPersonaDraft,
					onSessionDraft: setSessionPersonaDraft,
					onSessionPersona,
					onClearSessionPersona,
					onUse: onPersonaUse,
					onEdit: onPersonaEdit,
					onDraft: onPersonaDraft,
					onSave: onPersonaSave,
					onDelete: onPersonaDelete,
				}, "persona-card-wrap"),
				jsxRuntime.jsx(EmojiCard, {
					emoji: (value && value.emoji) || {},
					defaultEmoji: defaultEmoji !== null ? defaultEmoji : ((value && value.voice && value.voice.style && value.voice.style.emoji) || ""),
					onDefaultEmoji,
					onDefaultEmojiCommit,
					busy,
					t,
					draft: emojiDraft || { dir: (value && value.emoji && value.emoji.dir) || "", name: "", value: "" },
					onDraft: onEmojiDraft,
					onSaveDir: onEmojiSaveDir,
					onAdd: onEmojiAdd,
					intervalDraft: emojiMinutes,
					onIntervalDraft: setEmojiMinutes,
					onToggleAuto: onEmojiToggleAuto,
					onInterval: onEmojiInterval,
					onRescan: onEmojiRescan,
				}, "emoji-card-wrap"),
				jsxRuntime.jsx(MemorySearchCard, {
					busy,
					t,
					query: searchQuery,
					labels,
					modules: memoryModules,
					filters: searchFilters,
					onFilter: onSearchFilter,
					result: searchResult,
					onQuery: setSearchQuery,
					onSearch: onSearch,
				}, "search-card-wrap"),
			jsxRuntime.jsx(CapabilityCard, { modules, busy, t, onToggle }, "cap-card-wrap"),
			jsxRuntime.jsx(AgentiveScopeCard, {
				module: modules.agentive || {},
				sessions,
				busy,
				t,
				onScope,
				onToggleSession,
				onWindow,
				manualDraft: manualSession,
				onManualDraft: setManualSession,
				onManualAdd: onManualSessionAdd,
				onRefresh: onRefreshSessions,
			}, "scope-card-wrap"),
			jsxRuntime.jsx(ProactiveCard, {
				proactive: (value && value.proactive) || {},
				busy,
				t,
				intervalDraft: proactiveMinutes,
				onIntervalDraft: setProactiveMinutes,
				onInterval: onProactiveInterval,
				onNow: onProactiveNow,
			}, "proactive-card-wrap"),
	
				jsxRuntime.jsxs("div", { style: styles.card, children: [
					jsxRuntime.jsx("h3", { style: styles.subHeading, children: t("latestTitle") }, "latest-heading"),
				jsxRuntime.jsx("p", { style: styles.hint, children: t("temporaryHint") }, "latest-hint"),
					latest.length === 0
						? jsxRuntime.jsx("p", { style: styles.hint, children: t("empty") }, "latest-empty")
						: jsxRuntime.jsx("ul", { style: styles.list, children: latest.map((entry) => jsxRuntime.jsxs("li", { style: styles.row, children: [
							jsxRuntime.jsx("span", { style: styles.badge, children: labelOf(t, entry.module, labels) }, "latest-module-" + entry.id),
							jsxRuntime.jsx("span", { style: styles.rowText, children: entry.text }, "latest-text-" + entry.id),
							jsxRuntime.jsx("span", { style: styles.badge, children: Number(entry.weight ?? 0).toFixed(2) }, "latest-weight-" + entry.id),
						jsxRuntime.jsx(LifetimeToggle, { entry, busy, t, onLifetime }, "latest-lifetime-" + entry.id),
						] }, "latest-" + entry.id)) }, "latest-list"),
					jsxRuntime.jsx("button", {
						type: "button",
						style: styles.dangerButton,
						disabled: busy,
						onClick: () => run({ action: "clear" }),
						children: t("clearAll"),
					}, "clear-all"),
				] }, "latest-card"),
			] }, "brain-panel");
		}

		/**
		 * 设置页里的小节。
		 */
		function SharedBrainSettingsSection(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			return jsxRuntime.jsxs("div", { style: styles.section, children: [
				jsxRuntime.jsx("h2", { style: styles.heading, children: t("title") }, "title"),
				jsxRuntime.jsx("p", { style: styles.intro, children: t("intro") }, "intro"),
				jsxRuntime.jsx(BrainPanel, { t }, "panel"),
			] }, "shared-brain-settings");
		}

		/**
		 * 浮层打开状态（模块级，供 dock 与 overlay 共享）。
		 */
		const panelStore = {
			value: { open: false },
			listeners: new Set(),
			get() { return this.value; },
			set(next) {
				this.value = { ...this.value, ...next };
				for (const listener of this.listeners) listener(this.value);
			},
			subscribe(listener) {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			},
		};

		/**
		 * 输入框上方的「大脑」小条：概览 + 打开面板。
		 */
		function BrainDock(props) {
			const t = typeof props?.t === "function" ? props.t : (key) => key;
			const [state, setState] = react.useState({ status: "loading" });
			const [panel, setPanel] = react.useState(panelStore.get());

			react.useEffect(() => { panelStore.subscribe((next) => setPanel(next)); }, []);

			const load = react.useCallback(() => {
				fetchStatus()
					.then((value) => setState({ status: "ready", value }))
					.catch(() => setState({ status: "error" }));
			}, []);

			react.useEffect(() => { load(); }, [load]);

			if (state.status === "error") {
				return jsxRuntime.jsx("div", { style: styles.dock, children: t("dockFailed") }, "dock-failed");
			}
			if (state.status !== "ready") return null;

			const value = state.value;
			const modules = value.modules || {};
			const total = value.memory ? value.memory.total : 0;
			const bottomline = modules.bottomline ? modules.bottomline.count : 0;
			const net = modules.network && modules.network.enabled ? "🌐" : "";
			const agentive = modules.agentive && modules.agentive.enabled ? "✨" : "";

			return jsxRuntime.jsxs("div", { style: styles.dock, children: [
				jsxRuntime.jsx("span", { children: `${t("dockSummary")} · ${total}` }, "dock-total"),
				jsxRuntime.jsx("span", { style: styles.badge, children: `${labelOf(t, "bottomline", value.labels)} ${bottomline}` }, "dock-bottomline"),
				net.length > 0 ? jsxRuntime.jsx("span", { style: styles.badge, children: net }, "dock-net") : null,
				agentive.length > 0 ? jsxRuntime.jsx("span", { style: styles.badge, children: agentive }, "dock-agentive") : null,
				jsxRuntime.jsx("button", {
					type: "button",
					style: styles.dockChip,
					onClick: () => panelStore.set({ open: true }),
					children: t("dockOpen"),
				}, "dock-open"),
			] }, "brain-dock");
		}

		/**
		 * 侧边栏浮层：点开就是完整的模块配置面板。
		 */
		function BrainPanelOverlay(props) {
			const t = typeof props?.t === "function" ? props.t : (key) => key;
			const [state, setState] = react.useState(panelStore.get());

			react.useEffect(() => panelStore.subscribe((next) => setState(next)), []);

			const close = () => panelStore.set({ open: false });

			if (state.open !== true) return null;

			return jsxRuntime.jsx("div", { style: styles.modalBackdrop,
				onClick: (event) => {
					if (event && event.target === event.currentTarget) close();
				}, children: jsxRuntime.jsxs("div", { style: styles.modalPanel,
				role: "dialog",
				"aria-modal": true,
				"aria-label": t("panelTitle"), children: [
				jsxRuntime.jsx("h3", { style: styles.modalHeading, children: t("panelTitle") }, "panel-title"),
				jsxRuntime.jsx("p", { style: styles.hint, children: t("panelHint") }, "panel-hint"),
				jsxRuntime.jsx(BrainPanel, { t }, "panel-body"),
				jsxRuntime.jsx("button", {
					type: "button",
					style: styles.button,
					onClick: close,
					children: t("close"),
				}, "panel-close"),
			] }, "brain-panel-overlay") });
		}

		/** 需要的客户端服务：slot 注册表与本地化字典。 */
		const inject = ["slots", "locale"];

		/**
		 * 把「共享大脑」注册成设置页里的小节 + 侧边栏入口。
		 * @param ctx - 浏览器插件上下文。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-shared-brain: dictionaries");
			const t = ctx.locale.bind(NS);

			// 设置页小节。
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: SECTION_ID,
				order: 19,
				label: () => t("nav"),
				locale: NS,
				inject: () => ({ t }),
			}, SharedBrainSettingsSection));

			// 输入框上方的小条：概览 + 打开面板。
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: DOCK_ID,
				order: 61,
				locale: NS,
				inject: () => ({ t }),
			}, BrainDock));

			// 侧边栏浮层：点开就是完整面板。
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: OVERLAY_ID,
				order: 51,
				locale: NS,
				inject: () => ({ t }),
			}, BrainPanelOverlay));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.NS = NS;
		exports.SECTION_ID = SECTION_ID;
		exports.SharedBrainSettingsSection = SharedBrainSettingsSection;
		exports.BrainDock = BrainDock;
		exports.BrainPanelOverlay = BrainPanelOverlay;
		exports.BrainPanel = BrainPanel;
		return module.exports;
	},
});
