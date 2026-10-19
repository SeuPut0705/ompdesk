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
	"memory",
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
	{ id: "agent", items: ["models", "agent", "memory", "tools", "permissions", "workspace", "schedules"] },
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
	// Memory runs on this computer for every omp OMPdesk starts here: a paired host's tab never moves it.
	memory: "app",
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
	if (/^(retry|advisor|plan|goal|ttsr|compaction|prewalk|vision|prompt|task)\./.test(path)) return "agent";
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
	if (entry.path.startsWith("compaction.") || entry.tab === "context") return "context";
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
		id: "autoPreviewDevServer",
		section: "agent",
		labelKey: "settings.gui.autoPreviewDevServer",
		aliases:
			"dev server preview open automatically localhost vite next npm run dev smart automation 개발 서버 미리보기 자동 열기 스마트 자동화",
	},
	{
		id: "autoOpenChanges",
		section: "agent",
		labelKey: "settings.gui.autoOpenChanges",
		aliases:
			"changes diff open automatically edits turn end side panel smart automation 변경 사항 자동 열기 편집 패널 스마트 자동화",
	},
	{
		id: "batchNotifications",
		section: "agent",
		labelKey: "settings.gui.batchNotifications",
		aliases:
			"batch group combine bundle notification notifications summary finished tasks smart automation 알림 묶기 묶음 합치기 요약 완료 작업 스마트 자동화",
	},
	{
		id: "scheduledRetry",
		section: "agent",
		labelKey: "settings.gui.scheduledRetry",
		aliases:
			"retry again later temporary transient error server overloaded 503 timeout connection backoff automatic smart automation 재시도 다시 시도 일시 오류 서버 과부하 시간 초과 연결 자동 스마트 자동화",
	},
	{
		id: "autoMode",
		section: "agent",
		labelKey: "settings.gui.autoMode",
		aliases:
			"auto mode automatic plan goal choose mode small model smart automation 자동 모드 계획 목표 자동 선택 작은 모델 스마트 자동화",
	},
	{
		id: "autopilotShip",
		section: "agent",
		labelKey: "settings.gui.autopilotShip",
		aliases:
			"autopilot ship shipping commit push release local only default preset overnight unattended 오토파일럿 내보내기 커밋 배포 푸시 릴리스 로컬만 기본 프리셋 무인",
	},
	{
		id: "autopilotNotify",
		section: "agent",
		labelKey: "settings.gui.autopilotNotify",
		aliases: "autopilot notify notification stops cycles off overnight 오토파일럿 알림 정지 사이클 끄기 무인",
	},
	{
		id: "autopilotLimits",
		section: "agent",
		labelKey: "settings.gui.autopilotLimits",
		aliases:
			"autopilot ceiling limit budget tokens minutes cycles cost dollars off default 오토파일럿 상한 예산 토큰 분 사이클 비용 달러 기본 꺼짐",
	},
	{
		id: "nextPromptSuggestions",
		section: "agent",
		labelKey: "settings.gui.nextPromptSuggestions",
		aliases:
			"next prompt suggestion suggest predict placeholder chips autocomplete smol small model 다음 메시지 제안 추천 칩 자동 완성 작은 모델",
	},
	{
		id: "nextPromptInline",
		section: "agent",
		labelKey: "settings.gui.nextPromptInline",
		aliases: "inline completion ghost text complete as i type autocomplete 이어서 완성 입력 자동 완성 회색",
	},
	{
		id: "pstack",
		section: "agent",
		labelKey: "settings.gui.pstack",
		aliases:
			"pstack engineering mode playbooks principles skills rules poteto 엔지니어링 모드 플레이북 원칙 스킬 규칙",
	},
	{
		id: "autoTitle",
		section: "agent",
		labelKey: "settings.gui.autoTitle",
		aliases:
			"auto title session name rename generate automatic first message small model 제목 이름 자동 생성 세션 첫 메시지 작은 모델",
	},
	{
		id: "autoTitleEvolve",
		section: "agent",
		labelKey: "settings.gui.autoTitleEvolve",
		aliases: "title evolve update refresh keep current as work changes 제목 갱신 업데이트 작업 변경 최신",
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
		id: "resumeInterrupted",
		section: "general",
		labelKey: "settings.gui.resumeInterrupted",
		aliases:
			"continue resume interrupted relaunch restart crash update quit work 이어서 재개 중단 다시 열 때 업데이트 비정상 종료",
	},
	{
		id: "railPins",
		section: "general",
		labelKey: "settings.gui.railPins",
		aliases:
			"sidebar shortcuts pin pinned usage limits terminal changes preview files background tasks schedules rail 사이드바 바로가기 고정 사용 한도",
	},
	{
		id: "githubAccount",
		section: "general",
		rowId: "setting-github-account",
		labelKey: "githubAuth.settings.title",
		aliases: "github gh login sign in sign out account switch git identity user.name user.email 깃허브 로그인 계정",
	},
	{
		id: "machineSetup",
		section: "updates",
		rowId: "setting-machine-setup",
		labelKey: "machineSetup.settings.title",
		aliases: "this computer setup install doctor bun git node gh omp tools 이 컴퓨터 설치 점검 도구",
	},
	{
		id: "appAutoUpdate",
		section: "updates",
		labelKey: "updates.appAuto",
		aliases: "ompdesk app update upgrade install restart automatically auto 자동 업데이트 설치 재시작 앱",
	},
	{
		id: "ompAutoUpdate",
		section: "updates",
		labelKey: "ompUpdate.auto",
		aliases: "omp update upgrade automatically auto version cli npm 자동 업데이트 업그레이드 버전",
	},
	{
		id: "cliAutoUpdate",
		section: "updates",
		labelKey: "cliUpdate.auto",
		aliases:
			"cli tools update upgrade automatically auto claude code codex gemini cursor agent copilot gh github cli node 도구 자동 업데이트 업그레이드 클로드 코덱스 제미나이 커서",
	},
	{
		id: "extensionAutoUpdate",
		section: "updates",
		labelKey: "extensionUpdate.auto",
		aliases:
			"extensions plugins marketplaces skills mcp servers update upgrade automatically auto 확장 플러그인 마켓플레이스 스킬 서버 자동 업데이트 업그레이드",
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
		id: "workBoard",
		section: "appearance",
		labelKey: "settings.gui.workBoard",
		aliases: "workBoard work board status panel margin 작업 현황 보드",
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
		id: "mobileEnterSends",
		section: "appearance",
		labelKey: "settings.display.mobileEnterSends",
		aliases: "mobileEnterSends enter newline touch keyboard phone 모바일 엔터 줄바꿈 키보드",
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
		aliases:
			"modelRoles advisor slow fast default plan task commit memory tiny vision image web speech dictation judge custom role @role explore review debug docs test design conversation agent work input output 모델 역할 어드바이저 사용자 지정 역할 탐색 리뷰 디버깅 문서 테스트 디자인 대화 에이전트 작업 입력 출력",
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
		// Row id `setting-gui-agentControl` (AgentControlRow); `tools:mcp` opens its tab.
		id: "agentControl",
		section: "tools",
		sub: "mcp",
		labelKey: "settings.gui.agentControl",
		aliases:
			"ompdesk control tools agent sessions open message result notify tabs orchestrate 조작 도구 세션 에이전트 알림 탭",
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
		id: "mobileWeb",
		section: "connections",
		sub: "mobile-web",
		rowId: "settings-connections-mobile-web",
		labelKey: "settings.connections.mobileWeb",
		aliases:
			"mobile web phone tablet tailscale serve pairing qr code link devices https magicdns 모바일 웹 폰 휴대폰 태블릿 페어링 큐알 링크 기기",
	},
	{
		id: "hostAppearance",
		section: "connections",
		sub: "remote",
		rowId: "setting-remote-host-appearance",
		labelKey: "remote.hosts.useHostAppearance",
		aliases: "host theme language remote device appearance 호스트 테마 언어 원격",
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
	{
		id: "modelOverrides",
		section: "models",
		sub: "custom",
		rowId: "settings-models-overrides",
		labelKey: "modelOverrides.title",
		aliases:
			"modelOverrides context window max output tokens reasoning levels effort wire api replay 모델 재정의 컨텍스트 사고 수준",
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
