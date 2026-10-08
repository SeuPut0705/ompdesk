/**
 * Settings page catalog: section ids, navigation order, deep-link
 * resolution, and the curated rows each section shows. Everything the
 * schema offers stays reachable under Advanced; curated rows only decide
 * where a setting appears first and how it is worded.
 */

import { GUI_DISPLAY_BOOL_FIELDS, GUI_DISPLAY_LEGACY_PATHS } from "../../lib/display-preferences";

export const SETTINGS_SECTION_IDS = [
	"general",
	"appearance",
	"keyboard",
	"models",
	"permissions",
	"features",
	"extensions",
	"plugins",
	"workspace",
	"ssh",
	"remote",
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
	{ id: "agent", items: ["models", "permissions", "features", "extensions", "plugins"] },
	{ id: "system", items: ["workspace", "ssh", "remote", "updates", "advanced"] },
];

/**
 * Whose settings a section shows while the focused tab runs on a paired host:
 * `app` = this device's own preferences, `host` = the host's agent (its omp,
 * files and credentials), `mixed` = both, each part marked in the section.
 */
export const SECTION_SCOPE: Record<SettingsSectionId, "app" | "host" | "mixed"> = {
	general: "mixed",
	appearance: "app",
	keyboard: "app",
	models: "host",
	permissions: "host",
	features: "host",
	extensions: "host",
	plugins: "host",
	workspace: "host",
	ssh: "host",
	remote: "app",
	updates: "mixed",
	advanced: "mixed",
};

export const EXTENSIONS_TABS = ["skills", "mcp", "hooks", "commands"] as const;
export type ExtensionsTab = (typeof EXTENSIONS_TABS)[number];
export const PLUGINS_TABS = ["plugins", "marketplaces", "templates", "memory"] as const;
export type PluginsTab = (typeof PLUGINS_TABS)[number];

/** Advanced › category: app launch/network options, each agent schema tab, then uncategorized settings. */
export const ADVANCED_LAUNCH_CATEGORY = "launch";
export const ADVANCED_OTHER_CATEGORY = "other";

/** Agent schema tabs (omp `SETTING_TABS`); a bare one deep-links into Advanced. */
const SCHEMA_TAB_IDS: Record<string, true> = {
	model: true,
	interaction: true,
	context: true,
	memory: true,
	files: true,
	shell: true,
	tools: true,
	tasks: true,
};

export interface SettingsTarget {
	section: SettingsSectionId;
	/** Section-local sub-view (a tab, an Advanced category, a sub-section anchor). */
	sub?: string;
}

/**
 * `openSettings(target)` → page section. Targets are `section` or
 * `section:sub` (`extensions:mcp`, `plugins:marketplaces`, `advanced:model`,
 * `models:compare`); a bare agent schema tab id opens that Advanced category.
 */
export function resolveSettingsTarget(target: string | null | undefined): SettingsTarget {
	const [head = "", ...rest] = (target ?? "").split(":");
	const sub = rest.length > 0 ? rest.join(":") : undefined;
	if ((SETTINGS_SECTION_IDS as readonly string[]).includes(head)) return { section: head as SettingsSectionId, sub };
	// FirstRun's provider flows and the old Providers window share one page.
	if (head === "providers") return { section: "models" };
	if (SCHEMA_TAB_IDS[head]) return { section: "advanced", sub: head };
	return { section: "general" };
}

/** Curated agent-schema rows and the section that shows them (human copy: `settings.field.<path>`). */
export const CURATED_SCHEMA_ROWS: Readonly<Record<string, SettingsSectionId>> = {
	steeringMode: "general",
	followUpMode: "general",
	interruptMode: "general",
	"compaction.enabled": "general",
	"tui.renderMermaid": "appearance",
	defaultThinkingLevel: "models",
	"retry.modelFallback": "models",
	"retry.maxRetries": "models",
	"tools.approvalMode": "permissions",
	"tools.approval": "permissions",
	"secrets.enabled": "permissions",
	"plan.enabled": "features",
	"goal.enabled": "features",
	"ttsr.enabled": "features",
	"advisor.enabled": "features",
	"memory.backend": "features",
};

export interface GuiSearchItem {
	/** Row id suffix: the row renders as `setting-gui-<id>`. */
	id: string;
	section: SettingsSectionId;
	sub?: string;
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
		section: "appearance" as const,
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
		section: "advanced",
		sub: ADVANCED_LAUNCH_CATEGORY,
		labelKey: "settings.gui.proxy",
		aliases: "proxyUrl proxy network 프록시 네트워크",
	},
	{
		id: "launch",
		section: "advanced",
		sub: ADVANCED_LAUNCH_CATEGORY,
		labelKey: "settings.launch.title",
		aliases: "launchProfiles launch systemPrompt profile sessionDir 실행 시작 인수",
	},
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
