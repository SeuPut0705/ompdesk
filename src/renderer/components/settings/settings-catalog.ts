/**
 * Canonical Settings ownership. Navigation, schema editors and search share
 * this catalog so each setting has exactly one editing destination.
 */

import { GUI_DISPLAY_BOOL_FIELDS, GUI_DISPLAY_LEGACY_PATHS } from "../../lib/display-preferences";
import { PLATFORM } from "../../lib/keymap";

export const SETTINGS_SECTION_IDS = [
	"general",
	"appearance",
	"keyboard",
	"models",
	"agent",
	"tools",
	"permissions",
	"workspace",
	"schedules",
	"connections",
	"updates",
	"advanced",
] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export interface SettingsNavGroup {
	id: "app" | "agent" | "system";
	items: readonly SettingsSectionId[];
}

/** Left sub-nav: flat, always fully visible, grouped by who the setting is for. */
export const SETTINGS_NAV: readonly SettingsNavGroup[] = [
	{ id: "app", items: ["general", "appearance", "keyboard"] },
	{ id: "agent", items: ["models", "agent", "tools", "permissions", "workspace", "schedules"] },
	{ id: "system", items: ["connections", "updates", "advanced"] },
];

/**
 * Whose settings a section shows while the focused tab runs on a paired host:
 * `app` = this device's own preferences, `host` = the host's agent (its omp,
 * files and credentials), `mixed` = both, each part marked in the section.
 */
export const SECTION_SCOPE: Record<SettingsSectionId, "app" | "host" | "mixed"> = {
	general: "app",
	appearance: "app",
	keyboard: "app",
	models: "host",
	permissions: "host",
	agent: "host",
	tools: "host",
	workspace: "host",
	// Runs this computer's omp: a paired host's tab never moves them.
	schedules: "app",
	connections: "mixed",
	updates: "mixed",
	advanced: "host",
};

export const EXTENSIONS_TABS = ["skills", "mcp", "hooks", "contextFiles", "commands"] as const;
export type ExtensionsTab = (typeof EXTENSIONS_TABS)[number];
export const PLUGINS_TABS = ["plugins", "marketplaces", "templates"] as const;
export type PluginsTab = (typeof PLUGINS_TABS)[number];

export interface SettingsTarget {
	section: SettingsSectionId;
	/** Section-local sub-view (a tab, an Advanced category, a sub-section anchor). */
	sub?: string;
}

/** Canonical deep links use section ids with an optional editor/group anchor. */
export function resolveSettingsTarget(target: string | null | undefined): SettingsTarget {
	const [head = "", ...rest] = (target ?? "").split(":");
	const sub = rest.length > 0 ? rest.join(":") : undefined;
	if ((SETTINGS_SECTION_IDS as readonly string[]).includes(head)) return { section: head as SettingsSectionId, sub };
	return { section: "general" };
}

/** Curated agent-schema rows and the section that shows them (human copy: `settings.field.<path>`). */
export const CURATED_SCHEMA_ROWS: Readonly<Record<string, SettingsSectionId>> = {
	steeringMode: "agent",
	followUpMode: "agent",
	interruptMode: "agent",
	"compaction.enabled": "agent",
	"tui.renderMermaid": "agent",
	defaultThinkingLevel: "models",
	"retry.modelFallback": "agent",
	"retry.maxRetries": "agent",
	"tools.approvalMode": "permissions",
	"tools.approval": "permissions",
	"secrets.enabled": "permissions",
	"plan.enabled": "agent",
	"goal.enabled": "agent",
	"ttsr.enabled": "agent",
	"advisor.enabled": "agent",
	"memory.backend": "agent",
};

/** Structured settings are edited only by their dedicated editor. */
export const CUSTOM_SCHEMA_EDITORS: Readonly<
	Record<string, { section: SettingsSectionId; sub: string; rowId: string }>
> = {
	modelRoles: { section: "models", sub: "roles", rowId: "settings-models-roles" },
	"task.agentAccountPools": { section: "models", sub: "account-pools", rowId: "settings-models-account-pools" },
	"compaction.modelThresholds": { section: "agent", sub: "context", rowId: "settings-models-compaction-limits" },
	disabledExtensions: { section: "tools", sub: "other-extensions", rowId: "settings-tools-other-extensions" },
};

/** Unknown future stock keys deliberately remain reachable in Other settings. */
export function schemaSettingsOwner(entry: { path: string; tab?: string; group?: string }): SettingsSectionId {
	const path = entry.path;
	const custom = CUSTOM_SCHEMA_EDITORS[path];
	if (custom) return custom.section;
	const curated = CURATED_SCHEMA_ROWS[path];
	if (curated) return curated;
	if (/^(codexResets|claudeResets|providers)\./.test(path) || path === "modelRoleStorage") return "models";
	if (/^(tools\.approval|secrets\.|security\.)/.test(path)) return "permissions";
	if (/^(workspace|git|worktree)\./.test(path)) return "workspace";
	if (/^(update|power)\./.test(path)) return "updates";
	if (
		/^(retry|advisor|plan|goal|ttsr|memory|autolearn|mnemopi|hindsight|sharpshooter|compaction|prewalk|vision|prompt|task)\./.test(
			path,
		)
	)
		return "agent";
	if (path === "disabledExtensions") return "tools";
	if (entry.tab === "interaction") {
		if (entry.group === "Approvals") return "permissions";
		if (entry.group === "Startup & Updates" || entry.group === "Power") return "updates";
		if (entry.group === "Git") return "workspace";
		if (entry.group === "Skills") return "tools";
	}
	if (
		entry.tab === "model" &&
		["Prompt", "Retry & Fallback", "Advisor", "Prewalk", "Vision"].includes(entry.group ?? "")
	)
		return "agent";
	if (entry.tab === "tasks" && entry.group === "Commands & Skills") return "tools";
	switch (entry.tab) {
		case "model":
			return "models";
		case "providers":
			return "models";
		case "appearance":
			return "agent";
		case "interaction":
		case "context":
		case "memory":
		case "tasks":
			return "agent";
		case "files":
		case "shell":
		case "tools":
			return "tools";
		default:
			return "advanced";
	}
}

export type AgentSettingsGroup = "messages" | "modes" | "context" | "io";
/** Agent's four groups are shared by composition and search breadcrumbs. */
export function agentSettingsGroup(entry: { path: string; tab?: string; group?: string }): AgentSettingsGroup {
	if (/^(advisor|plan|goal|ttsr|task)\./.test(entry.path) || entry.tab === "tasks") return "modes";
	if (
		/^(compaction|memory|autolearn|mnemopi|hindsight|sharpshooter)\./.test(entry.path) ||
		entry.tab === "context" ||
		entry.tab === "memory"
	)
		return "context";
	if (entry.tab === "interaction" || entry.tab === "appearance") return "io";
	return "messages";
}

export interface GuiSearchItem {
	/** Row id suffix: the row renders as `setting-gui-<id>`. */
	id: string;
	section: SettingsSectionId;
	sub?: string;
	rowId?: string;
	labelKey: string;
	/** Extra match terms (wire names, other-language synonyms). */
	aliases: string;
}

/** Search metadata for renderer-owned settings; points at existing rows, never a second store. */
export const GUI_SEARCH_ITEMS: readonly GuiSearchItem[] = [
	{ id: "language", section: "general", labelKey: "settings.gui.language", aliases: "language lang 언어" },
	{
		id: "replyLanguage",
		section: "general",
		labelKey: "settings.gui.replyLanguage",
		aliases: "reply language conversation answer agent 대화 언어 답변",
	},
	{
		id: "profileName",
		section: "general",
		labelKey: "settings.gui.profileName",
		aliases: "profile name nickname title address call me 프로필 이름 호칭 별명",
	},
	{
		id: "profileExperience",
		section: "general",
		labelKey: "settings.gui.profileExperience",
		aliases: "profile experience level beginner expert vibe coder junior 프로필 경험 입문자 전문가",
	},
	{
		id: "notifications",
		section: "general",
		labelKey: "settings.gui.notifications",
		aliases: "notifications 알림",
	},
	{
		id: "panelDefault",
		section: "general",
		labelKey: "settings.gui.panelDefault",
		aliases: "panelTab side panel 사이드 패널",
	},
	{
		id: "notificationSound",
		section: "general",
		labelKey: "settings.gui.notificationSound",
		aliases: "notification sound chime volume test 알림 소리 알림음 볼륨",
	},
	{
		id: "linkPreview",
		section: "general",
		labelKey: "settings.gui.linkPreview",
		aliases: "link preview browser open links 링크 미리보기 브라우저",
	},
	{
		id: "panelSide",
		section: "general",
		labelKey: "settings.gui.panelSide",
		aliases: "side panel left right flip position 사이드 패널 왼쪽 오른쪽 위치",
	},
	// The row exists on Windows only (macOS keeps running with no window anyway).
	...(PLATFORM === "windows"
		? [
				{
					id: "closeToTray",
					section: "general",
					labelKey: "settings.gui.closeToTray",
					aliases: "close window tray hide quit 창 닫기 트레이 숨기기 종료",
				} satisfies GuiSearchItem,
			]
		: []),
	{
		id: "keepAwakeWorking",
		section: "general",
		labelKey: "settings.gui.keepAwakeWorking",
		aliases: "keep awake sleep power prevent 잠자기 절전 깨어 있기",
	},
	{
		id: "githubAccount",
		section: "general",
		rowId: "setting-github-account",
		labelKey: "githubAuth.settings.title",
		aliases: "github gh login sign in sign out account switch git identity user.name user.email 깃허브 로그인 계정",
	},
	{ id: "theme", section: "appearance", labelKey: "settings.gui.theme", aliases: "theme dark light 테마 다크 라이트" },
	{
		id: "followAgentTheme",
		section: "appearance",
		labelKey: "settings.gui.followAgentTheme",
		aliases: "theme override terminal 테마",
	},
	{
		id: "fontSize",
		section: "appearance",
		labelKey: "settings.gui.fontSize",
		aliases: "fontSize font size 글꼴",
	},
	{
		id: "compactDensity",
		section: "appearance",
		labelKey: "settings.gui.compactDensity",
		aliases: "compactDensity compact density 간격 밀도",
	},
	{
		id: "colorBlindMode",
		section: "appearance",
		labelKey: "settings.gui.colorBlindMode",
		aliases: "colorBlindMode color blind 색각 색맹",
	},
	{
		id: "transcriptDetail",
		section: "appearance",
		labelKey: "settings.gui.transcriptDetail",
		aliases: "transcriptDetail tools detail transcript 대화 도구",
	},
	{
		id: "thinkingExpanded",
		section: "appearance",
		labelKey: "settings.gui.thinkingExpanded",
		aliases: "thinkingExpanded reasoning thinking 사고 추론",
	},
	{
		id: "lineNumbers",
		section: "appearance",
		labelKey: "codeblock.lineNumbers",
		aliases: "codeLineNumbers code lines 코드 줄 번호",
	},
	...GUI_DISPLAY_BOOL_FIELDS.map((id, index) => ({
		id,
		section: id === "titleState" || id === "showProgress" ? ("general" as const) : ("appearance" as const),
		labelKey: `settings.display.${id}`,
		aliases: `${GUI_DISPLAY_LEGACY_PATHS[index]} display 표시`,
	})),
	{
		id: "pasteMenuThreshold",
		section: "appearance",
		labelKey: "settings.display.pasteMenuThreshold",
		aliases: "paste.largeMenuThreshold paste 붙여넣기",
	},
	{
		id: "proxy",
		section: "general",
		labelKey: "settings.gui.proxy",
		aliases: "proxyUrl proxy network 프록시 네트워크",
	},
	{
		id: "launch",
		section: "workspace",
		labelKey: "settings.launch.title",
		aliases: "launchProfiles launch systemPrompt profile sessionDir 실행 시작 인수",
	},
	{
		id: "worktreeAutoClean",
		section: "workspace",
		labelKey: "settings.agentWorktrees.auto",
		aliases: "worktree auto clean orphaned cleanup remove 워크트리 자동 정리",
	},
	{
		id: "agentWorktrees",
		section: "workspace",
		rowId: "setting-agent-worktrees",
		labelKey: "settings.agentWorktrees",
		aliases: "worktree list clear orphaned omp wt 워크트리 정리",
	},
	{
		id: "roles",
		section: "models",
		sub: "roles",
		rowId: "settings-models-roles",
		labelKey: "settings.models.roles",
		aliases: "modelRoles advisor slow fast default roles 모델 역할 어드바이저",
	},
	{
		id: "pools",
		section: "models",
		sub: "account-pools",
		rowId: "settings-models-account-pools",
		labelKey: "accountPools.title",
		aliases: "task.agentAccountPools accounts pools 계정 풀",
	},
	{
		id: "rotation",
		section: "models",
		sub: "rotation",
		rowId: "settings-models-rotation",
		labelKey: "providers.rotation.label",
		aliases: "accountRotation quota even rotation 계정 순환",
	},
	{
		id: "reset-passes",
		section: "models",
		sub: "reset-passes",
		rowId: "settings-models-reset-passes",
		labelKey: "resetPasses.use",
		aliases: "codex claude reset passes redeem 초기화권 리셋",
	},
	{
		id: "setup",
		section: "models",
		sub: "setup",
		rowId: "settings-models-setup",
		labelKey: "modelSetup.title",
		aliases: "model setup assistant 자동 설정 도우미",
	},
	{
		// Row id `setting-gui-builtinRea` (BuiltinReaRow); `tools:mcp` opens its tab.
		id: "builtinRea",
		section: "tools",
		sub: "mcp",
		labelKey: "mcp.rea.title",
		aliases: "rea mcp builtin built-in reverse engineering binary npx node 내장 리버스 엔지니어링 바이너리",
	},
	{
		id: "ssh",
		section: "connections",
		sub: "ssh",
		rowId: "settings-connections-ssh",
		labelKey: "ssh.title",
		aliases: "ssh host hostname port key user project SSH 호스트 포트 키",
	},
	{
		id: "remote",
		section: "connections",
		sub: "remote",
		rowId: "settings-connections-remote",
		labelKey: "settings.connections.sharing",
		aliases: "remote pairing address sharing keep awake 원격 기기 페어링 주소 공유 잠자기",
	},
	{
		id: "auth",
		section: "updates",
		sub: "auth",
		rowId: "settings-updates-auth",
		labelKey: "updates.auth.tokenLabel",
		aliases: "github token auth updates 인증 토큰 업데이트",
	},
	{
		id: "accounts",
		section: "models",
		sub: "accounts",
		rowId: "settings-models-accounts",
		labelKey: "settings.models.providers",
		aliases: "provider account login credentials OAuth API key 프로바이더 계정 로그인 인증",
	},
	{
		id: "custom",
		section: "models",
		sub: "custom",
		rowId: "settings-models-custom",
		labelKey: "settings.models.custom",
		aliases:
			"models.yml providers endpoint API baseUrl transport discovery price capabilities 직접 추가 엔드포인트 URL 가격",
	},
	...[
		"systemPrompt",
		"appendSystemPrompt",
		"addDirs",
		"tools",
		"noRules",
		"noLsp",
		"planYolo",
		"profile",
		"sessionDir",
		"config",
	].map(field => ({
		id: `launch-${field}`,
		section: "workspace" as const,
		sub: `launch-${field}`,
		rowId: `settings-workspace-launch-${field}`,
		labelKey: `settings.launch.${field}`,
		aliases: `launchProfiles.${field} launch ${field} 실행`,
	})),
];

/** Launch-profile text fields that commit on blur (switches/chips apply immediately). */
export type LaunchTextField = "systemPrompt" | "appendSystemPrompt" | "profile" | "sessionDir" | "config";
export const LAUNCH_TEXT_FIELDS: readonly LaunchTextField[] = [
	"systemPrompt",
	"appendSystemPrompt",
	"profile",
	"sessionDir",
	"config",
];
/** Prompt fields keep whitespace verbatim (the CLI takes the literal value); the rest trim. */
export const LAUNCH_VERBATIM_FIELDS: Partial<Record<LaunchTextField, true>> = {
	systemPrompt: true,
	appendSystemPrompt: true,
};
