/**
 * Every Settings row an agent may write through `ompdesk_app`, one action each (`settings.<id>`): the stored
 * preference (`PREFS_SET`, which also applies each key's validation and main-side effects) or the stock setting
 * (`set_setting`) the row's own control writes, with the value shape and the tier of the change.
 *
 * Rows an agent never writes, or that another action covers, are listed in `ROW_NOT_WRITTEN` with the reason;
 * `app-catalog.test.ts` checks that every row of the Settings catalog is in one list or the other, so a new row
 * is a decision, not an oversight. Settings that gate what an agent may do are `never` here, whichever way they
 * are reached (a preference, a stock setting, an RPC command): `app-guard.ts` refuses them centrally.
 */
import { AUTO_MODE_PREF } from "../../../resources/gui-bridge/modes/auto-mode-contracts";
import { AUTO_TITLE_EVOLVE_PREF, AUTO_TITLE_PREF } from "../../../resources/gui-bridge/modes/auto-title-contracts";
import { NEXT_PROMPT_INLINE_PREF, NEXT_PROMPT_PREF } from "../../../resources/gui-bridge/modes/next-prompt-contracts";
import { ACCOUNT_ROTATION_PREF } from "../../shared/account-rotation";
import { AGENT_PANEL_TABS } from "../../shared/agent-control";
import { REA_PREF } from "../../shared/builtin-mcp";
import { CLI_AUTO_UPDATE_PREF } from "../../shared/cli-update";
import {
	APP_AUTO_UPDATE_PREF,
	AUTO_OPEN_CHANGES_PREF,
	AUTO_PREVIEW_DEV_SERVER_PREF,
	BATCH_NOTIFICATIONS_PREF,
	CLOSE_TO_TRAY_PREF,
	KEEP_AWAKE_WORKING_PREF,
	RESUME_INTERRUPTED_PREF,
	SCHEDULED_RETRY_PREF,
	WORKTREE_AUTO_CLEAN_PREF,
} from "../../shared/desktop-prefs";
import { EXTENSION_AUTO_UPDATE_PREF } from "../../shared/extension-update";
import { OMP_AUTO_UPDATE_PREF } from "../../shared/omp-update";
import { REPLY_LANGUAGE_PREF } from "../../shared/reply-language";
import { THEME_NAMES } from "../../shared/theme-names";
import type { PropSchema } from "./app-schema";

export type SettingTier = "change" | "sensitive";

/**
 * What `agentControlManage` ("Let agents manage other sessions", default on) does to a `sensitive` action's card.
 * Every sensitive action decides, with the reason (`app-catalog.test.ts` fails on one that does not):
 *   `lifts`   the switch skips the card; the reason says why that is safe.
 *   `always`  the card appears whatever the switch says; the reason says what it protects (erased data, code that
 *             runs, credentials, network exposure, running work). `when` narrows it to calls that need it.
 */
export type ManageRule = { always: string; when?: (args: Record<string, unknown>) => boolean } | { lifts: string };

interface Described {
	/** The Settings catalog row id (`GUI_SEARCH_ITEMS`), or the stock path of a curated schema row. */
	id: string;
	area: string;
	en: string;
	ko: string;
	tier: SettingTier;
	schema: PropSchema;
	/** Required on a `sensitive` row. */
	manage?: ManageRule;
}

export interface PrefSetting extends Described {
	kind: "pref";
	key: string;
	/** Other stored keys that move with this one (the legacy mirror of a theme). */
	mirror?: Record<string, (value: unknown) => unknown>;
	/** The value is a credential-like string: it is never read back or shown. */
	redact?: boolean;
}

export interface StockSetting extends Described {
	kind: "stock";
	path: string;
}

export type Setting = PrefSetting | StockSetting;

const bool: PropSchema = { type: "boolean" };

function pref(
	id: string,
	key: string,
	area: string,
	en: string,
	ko: string,
	schema: PropSchema = bool,
	tier: SettingTier = "change",
	extra: Partial<Pick<PrefSetting, "mirror" | "redact" | "manage">> = {},
): PrefSetting {
	return { kind: "pref", id, key, area, en, ko, schema, tier, ...extra };
}

function stock(
	path: string,
	area: string,
	en: string,
	ko: string,
	schema: PropSchema = bool,
	tier: SettingTier = "change",
): StockSetting {
	return { kind: "stock", id: path, path, area, en, ko, schema, tier };
}

const options = (...values: string[]): PropSchema => ({ type: "string", enum: values });

const DARK_THEMES = new Set<string>(["dark", "nord", "tokyo-night", "gruvbox-dark", "hc-dark"]);

export const SETTINGS: readonly Setting[] = [
	pref("replyLanguage", REPLY_LANGUAGE_PREF, "general", "Conversation language", "대화 언어", {
		type: "string",
		minLength: 1,
		maxLength: 60,
	}),
	pref("notifications", "notifications", "general", "Notifications", "알림"),
	pref("notificationSound", "notificationSound", "general", "Notification sound", "알림 소리"),
	pref("batchNotifications", BATCH_NOTIFICATIONS_PREF, "general", "Batch notifications", "알림 묶기"),
	pref("linkPreview", "linkPreview", "general", "Open links in the preview", "링크를 미리보기에서 열기"),
	pref(
		"panelDefault",
		"defaultPanelTab",
		"general",
		"Default side panel",
		"기본 사이드 패널",
		options(...AGENT_PANEL_TABS),
	),
	pref("panelSide", "panelSide", "general", "Side panel edge", "사이드 패널 위치", options("left", "right")),
	pref("closeToTray", CLOSE_TO_TRAY_PREF, "general", "Close to tray", "창 닫으면 트레이로"),
	pref("keepAwakeWorking", KEEP_AWAKE_WORKING_PREF, "general", "Keep awake while working", "작업 중 잠자기 방지"),
	pref("resumeInterrupted", RESUME_INTERRUPTED_PREF, "general", "Resume interrupted work", "중단된 작업 이어서 하기"),
	pref(
		"autoPreviewDevServer",
		AUTO_PREVIEW_DEV_SERVER_PREF,
		"agent",
		"Open dev servers in the preview",
		"개발 서버 미리보기 자동 열기",
	),
	pref("autoOpenChanges", AUTO_OPEN_CHANGES_PREF, "agent", "Open changes after a turn", "턴이 끝나면 변경 사항 열기"),
	pref("scheduledRetry", SCHEDULED_RETRY_PREF, "agent", "Retry transient errors later", "일시 오류 나중에 재시도"),
	pref("autoMode", AUTO_MODE_PREF, "agent", "Auto mode", "자동 모드"),
	pref("nextPromptSuggestions", NEXT_PROMPT_PREF, "agent", "Next prompt suggestions", "다음 메시지 제안"),
	pref("nextPromptInline", NEXT_PROMPT_INLINE_PREF, "agent", "Inline completion", "이어서 완성"),
	pref("autoTitle", AUTO_TITLE_PREF, "agent", "Automatic session titles", "세션 제목 자동 생성"),
	pref("autoTitleEvolve", AUTO_TITLE_EVOLVE_PREF, "agent", "Keep titles current", "제목 최신으로 유지"),
	pref(
		"worktreeAutoClean",
		WORKTREE_AUTO_CLEAN_PREF,
		"workspace",
		"Clean orphaned worktrees",
		"남은 워크트리 자동 정리",
	),
	pref("theme", "themeName", "appearance", "Theme", "테마", options("system", ...THEME_NAMES), "change", {
		mirror: { theme: value => (value === "system" ? "system" : DARK_THEMES.has(String(value)) ? "dark" : "light") },
	}),
	pref("followAgentTheme", "followAgentTheme", "appearance", "Follow the agent's theme", "에이전트 테마 따르기"),
	pref("fontSize", "fontSize", "appearance", "Font size", "글꼴 크기", { type: "integer", minimum: 12, maximum: 20 }),
	pref("compactDensity", "compactDensity", "appearance", "Compact density", "촘촘한 간격"),
	pref("colorBlindMode", "colorBlindMode", "appearance", "Color-blind mode", "색각 보정 모드"),
	pref(
		"transcriptDetail",
		"transcriptDetail",
		"appearance",
		"Transcript detail",
		"대화 상세도",
		options("compact", "full"),
	),
	pref("thinkingExpanded", "thinkingExpanded", "appearance", "Expand thinking", "생각 펼치기"),
	pref("workBoard", "workBoard", "appearance", "Work board", "작업 현황 보드"),
	pref("lineNumbers", "codeLineNumbers", "appearance", "Code line numbers", "코드 줄 번호"),
	pref(
		"hideThinkingBlock",
		"displayPreferences.hideThinkingBlock",
		"appearance",
		"Hide thinking blocks",
		"생각 블록 숨기기",
	),
	pref(
		"proseOnlyThinking",
		"displayPreferences.proseOnlyThinking",
		"appearance",
		"Prose-only thinking",
		"생각을 글로만 보기",
	),
	pref("showTokenUsage", "displayPreferences.showTokenUsage", "appearance", "Show token usage", "토큰 사용량 표시"),
	pref(
		"collapseCompacted",
		"displayPreferences.collapseCompacted",
		"appearance",
		"Collapse compacted history",
		"압축된 기록 접기",
	),
	pref("titleState", "displayPreferences.titleState", "general", "State in the window title", "창 제목에 상태 표시"),
	pref(
		"goalStatusInFooter",
		"displayPreferences.goalStatusInFooter",
		"appearance",
		"Goal status in the footer",
		"푸터에 목표 상태",
	),
	pref("showProgress", "displayPreferences.showProgress", "general", "Show progress", "진행률 표시"),
	pref(
		"emojiAutocomplete",
		"displayPreferences.emojiAutocomplete",
		"appearance",
		"Emoji autocomplete",
		"이모지 자동 완성",
	),
	pref(
		"mobileEnterSends",
		"displayPreferences.mobileEnterSends",
		"appearance",
		"Enter sends on a touch keyboard",
		"터치 키보드에서 Enter로 전송",
	),
	pref(
		"pasteMenuThreshold",
		"displayPreferences.pasteMenuThreshold",
		"appearance",
		"Large paste menu threshold",
		"큰 붙여넣기 메뉴 기준",
		{
			type: "integer",
			minimum: 0,
			maximum: 1_000_000,
		},
	),
	pref(
		"proxy",
		"proxyUrl",
		"general",
		"Network proxy",
		"네트워크 프록시",
		{ type: "string", maxLength: 300 },
		"sensitive",
		{
			redact: true,
			manage: { always: "the proxy sees all of this app's traffic and may carry credentials" },
		},
	),
	pref(
		"appAutoUpdate",
		APP_AUTO_UPDATE_PREF,
		"updates",
		"Update OMPdesk automatically",
		"OMPdesk 자동 업데이트",
		bool,
		"sensitive",
		{
			manage: { lifts: "only the person's own update schedule; installing one now (updates.apply) still asks" },
		},
	),
	pref(
		"ompAutoUpdate",
		OMP_AUTO_UPDATE_PREF,
		"updates",
		"Update omp automatically",
		"omp 자동 업데이트",
		bool,
		"sensitive",
		{
			manage: { lifts: "only the person's own update schedule; running turns keep the code they loaded" },
		},
	),
	pref(
		"cliAutoUpdate",
		CLI_AUTO_UPDATE_PREF,
		"updates",
		"Update tool CLIs automatically",
		"도구 CLI 자동 업데이트",
		bool,
		"sensitive",
		{
			manage: { lifts: "updates tools the person already signed in to; a switch they can flip back at once" },
		},
	),
	pref(
		"extensionAutoUpdate",
		EXTENSION_AUTO_UPDATE_PREF,
		"updates",
		"Update extensions automatically",
		"확장 자동 업데이트",
		bool,
		"sensitive",
		{
			manage: { lifts: "updates extensions the person already installed; installing a new one still asks" },
		},
	),
	pref("builtinRea", REA_PREF, "tools", "Built-in REA tools", "내장 REA 도구", bool, "sensitive", {
		manage: { lifts: "switches a bundled tool pack on or off; it adds no code the app does not ship" },
	}),
	pref(
		"rotation",
		ACCOUNT_ROTATION_PREF,
		"models",
		"Account rotation",
		"계정 순환",
		options("quota", "even"),
		"sensitive",
		{
			manage: { lifts: "picks which signed-in account a session uses next; no credential is read or changed" },
		},
	),
	stock("steeringMode", "agent", "Steering mode", "스티어링 방식", options("all", "one-at-a-time")),
	stock("followUpMode", "agent", "Follow-up mode", "후속 메시지 방식", options("all", "one-at-a-time")),
	stock("interruptMode", "agent", "Interrupt mode", "중단 방식", options("immediate", "wait")),
	stock("compaction.enabled", "agent", "Auto compaction", "자동 압축"),
	stock("tui.renderMermaid", "agent", "Render Mermaid", "Mermaid 렌더링"),
	stock(
		"defaultThinkingLevel",
		"models",
		"Thinking level",
		"사고 수준",
		options("auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"),
	),
	stock("retry.modelFallback", "agent", "Model fallback on retry", "재시도 시 모델 대체"),
	stock("retry.maxRetries", "agent", "Max retries", "최대 재시도", { type: "integer", minimum: 0, maximum: 20 }),
	stock("plan.enabled", "agent", "Plan mode", "계획 모드"),
	stock("goal.enabled", "agent", "Goal mode", "목표 모드"),
	stock("ttsr.enabled", "agent", "Rule injection (TTSR)", "규칙 주입(TTSR)"),
	stock("advisor.enabled", "agent", "Advisor", "어드바이저"),
];

export const SETTING_BY_ID: Readonly<Record<string, Setting>> = Object.fromEntries(
	SETTINGS.map(setting => [setting.id, setting]),
);

export const settingActionId = (id: string): string => `settings.${id}`;

/** Rows another action covers (`covered`) or an agent never writes (`never`), each with the reason. */
export type RowDecision = { covered: string } | { never: string };

const USER_ONLY = "the person decides this in Settings; an agent changing it would widen its own power or spend";

export const ROW_NOT_WRITTEN: Readonly<Record<string, RowDecision>> = {
	language: { never: "the window's own language switch applies it; ask the person" },
	autopilotShip: { never: "Autopilot's shipping default decides what unattended runs may push or release" },
	autopilotNotify: { never: "Autopilot's notification default; the person's own choice" },
	autopilotLimits: { never: "Autopilot's budget ceiling bounds spend; only the person raises it" },
	profileName: { never: "the person's own profile text" },
	profileExperience: { never: "the person's own profile" },
	railPins: { never: "the person's own sidebar layout" },
	githubAccount: { covered: "accounts.github_sign_in" },
	machineSetup: { never: "machine setup installs tools by itself; there is nothing to set" },
	pstack: { never: "the engineering-mode pack changes the prompt and skills every session runs with" },
	agentControl: { never: "this switch gates the agent's own power over the app" },
	ssh: { never: "SSH hosts and keys are credentials and network reach" },
	remote: { covered: "remote.pair" },
	mobileWeb: { covered: "mobile_web.set_enabled" },
	hostAppearance: { never: "a paired host's look; the person's own choice" },
	auth: { never: "the update token is a credential" },
	accounts: { covered: "accounts.provider_sign_in" },
	custom: { never: "custom providers set endpoints and credentials" },
	modelOverrides: { never: "model overrides change limits and wire behavior of providers" },
	roles: { covered: "models.set_role" },
	modelRoles: { covered: "models.set_role" },
	pools: { never: "account pools route work across the person's accounts" },
	"task.agentAccountPools": { never: "account pools route work across the person's accounts" },
	"reset-passes": { never: "redeeming a reset pass spends an account's allowance" },
	setup: { never: "model setup picks providers and accounts" },
	launch: { never: "launch profiles inject prompts, tools and config into every session" },
	agentWorktrees: { never: "clearing worktrees deletes work; ompdesk_merge and the review queue own that" },
	"tools.approvalMode": { never: USER_ONLY },
	"tools.approval": { never: USER_ONLY },
	"secrets.enabled": { never: USER_ONLY },
	"memory.backend": { never: USER_ONLY },
	"compaction.modelThresholds": { never: "a structured per-model table with its own editor" },
	disabledExtensions: { never: "extension switches change what code runs in every session" },
	...Object.fromEntries(
		[
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
		].map(field => [
			`launch-${field}`,
			{ never: "launch profiles inject prompts, tools and config into every session" },
		]),
	),
};
