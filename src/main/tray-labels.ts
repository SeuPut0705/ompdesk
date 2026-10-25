/**
 * Pure tray vocabulary: every string the native menu shows, plus the signature
 * that decides whether the menu has to be rebuilt. Lives outside `tray.ts`
 * because that module needs electron — the label mapping and the churn guard
 * are the parts worth testing.
 */

import type { RunProgressState, TrayState } from "../shared/ipc-types";
import type { UiLanguage } from "../shared/ui-language";

export type TrayStatus = TrayState["status"];
export type TrayLang = UiLanguage;
export type TrayApprovalMode = TrayState["approvalMode"];

/** Tray-label strings, translated in main (the renderer reports the language). */
export const TRAY_LABELS = {
	showHide: { en: "Show / Hide", ko: "보기/숨기기" },
	quit: { en: "Quit", ko: "종료" },
	newSession: { en: "New Session", ko: "새 세션" },
	openProject: { en: "Open Project…", ko: "프로젝트 열기…" },
	handoff: { en: "Handoff", ko: "핸드오프" },
	usageStats: { en: "Usage & Quotas…", ko: "사용량 및 할당량…" },
	workspaces: { en: "Switch Project", ko: "프로젝트 전환" },
	addWorkspace: { en: "Open Project…", ko: "프로젝트 열기…" },
	quickStart: { en: "Quick Start", ko: "빠른 시작" },
	quickConfig: { en: "Quick Settings", ko: "빠른 설정" },
	fastMode: { en: "Fast Mode", ko: "빠른 모드" },
	thinking: { en: "Thinking Level", ko: "사고 수준" },
	approval: { en: "Tool Approval", ko: "도구 승인" },
	language: { en: "Language", ko: "언어" },
	approvalYolo: { en: "Full access", ko: "전체 접근" },
	approvalWrite: { en: "Auto-edit", ko: "자동 편집" },
	approvalAsk: { en: "Ask every time", ko: "항상 묻기" },
	approvalRemember: { en: "Ask and remember", ko: "묻고 기억하기" },
	context: { en: "Context", ko: "컨텍스트" },
	tokens: { en: "tokens", ko: "토큰" },
	noModel: { en: "No model", ko: "모델 없음" },
	statusIdle: { en: "Ready", ko: "준비됨" },
	statusStreaming: { en: "Working", ko: "작업 중" },
	// The renderer's attention words (`attention.*`), pinned by native-labels.test.ts.
	statusQuestion: { en: "Needs input", ko: "답변 필요" },
	statusApproval: { en: "Needs approval", ko: "승인 필요" },
	statusChildWaiting: { en: "Child waiting", ko: "하위 세션 대기" },
	statusCheckFailed: { en: "Check failed", ko: "검사 실패" },
	statusError: { en: "Error", ko: "오류" },
	// Thinking levels by the names the composer's thinking control uses.
	thinkingOff: { en: "Off", ko: "끔" },
	thinkingAuto: { en: "Auto", ko: "자동" },
	thinkingMinimal: { en: "Minimal", ko: "최소" },
	thinkingLow: { en: "Low", ko: "낮음" },
	thinkingMedium: { en: "Medium", ko: "보통" },
	thinkingHigh: { en: "High", ko: "높음" },
	thinkingXhigh: { en: "Ultra", ko: "매우 높음" },
	thinkingMax: { en: "Max", ko: "최대" },
} as const;

export type TrayLabelKey = keyof typeof TRAY_LABELS;

export function t(lang: TrayLang, key: TrayLabelKey): string {
	return TRAY_LABELS[key][lang];
}

const STATUS_KEYS: Record<TrayStatus, TrayLabelKey> = {
	idle: "statusIdle",
	streaming: "statusStreaming",
	question: "statusQuestion",
	approval: "statusApproval",
	childWaiting: "statusChildWaiting",
	checkFailed: "statusCheckFailed",
	error: "statusError",
};

/** Which run state to show; the aggregate across windows, never per-window. */
export function statusLabel(lang: TrayLang, status: TrayStatus): string {
	return t(lang, STATUS_KEYS[status]);
}

/** Loudest first: an error, what a window needs from the person (in `sessionAttention`'s order), streaming, idle. */
const STATUS_RANK: readonly TrayStatus[] = [
	"error",
	"question",
	"approval",
	"childWaiting",
	"checkFailed",
	"streaming",
	"idle",
];

/**
 * Collapse per-window statuses to the loudest. Precedence is app-global, so the first window's state never hides a
 * louder later one; a window waiting on the person outranks another one working, as inside one window (App.tsx).
 */
export function aggregateTrayStatus(states: Iterable<TrayState>): TrayStatus {
	let loudest = STATUS_RANK.length - 1;
	for (const { status } of states) loudest = Math.min(loudest, STATUS_RANK.indexOf(status));
	return STATUS_RANK[loudest] ?? "idle";
}

const APPROVAL_KEYS: Record<TrayApprovalMode, TrayLabelKey> = {
	yolo: "approvalYolo",
	write: "approvalWrite",
	"always-ask-cached": "approvalRemember",
	"always-ask": "approvalAsk",
};

export function approvalLabel(lang: TrayLang, mode: TrayApprovalMode): string {
	return t(lang, APPROVAL_KEYS[mode]);
}

const THINKING_KEYS: Record<string, TrayLabelKey> = {
	off: "thinkingOff",
	auto: "thinkingAuto",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

/** A thinking level by its composer name; a level this build does not know shows as omp spells it. */
export function thinkingLabel(lang: TrayLang, level: string): string {
	const key = THINKING_KEYS[level];
	return key ? t(lang, key) : level;
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/** Hover text: the icon itself stays a static template mark by design. */
export function trayTooltip(state: TrayState | null): string {
	if (!state) return "OMPdesk";
	return `OMPdesk — ${state.projectName} · ${statusLabel(state.language, state.status)}`;
}

/**
 * Everything a rebuilt menu can differ in, as one string. Session lists refresh
 * every few hundred milliseconds while agents stream; a push whose visible
 * labels are unchanged must not swap the native menu out. Context share is
 * bucketed to what the menu actually prints (whole percent, rendered token
 * string) so token-level streaming stays out.
 */
export function menuSignature(state: TrayState): string {
	const percent = state.contextPercent === null ? "—" : String(Math.round(state.contextPercent));
	const tokens = state.contextTokens === null ? "—" : formatTokens(state.contextTokens);
	const workspaces = state.workspaces.map(ws => `${ws.cwd}\u0000${ws.name}\u0000${ws.current}`).join("\u0001");
	return [
		state.language,
		state.status,
		state.projectName,
		state.modelId ?? "—",
		state.thinkingLevel,
		state.fastMode,
		state.approvalMode,
		percent,
		tokens,
		workspaces,
	].join("\u0002");
}

/**
 * The app icon's progress over every window (dock badge, taskbar bar): one waiting on the person outranks one working,
 * as `aggregateTrayStatus` and each window's own state do.
 */
export function aggregateProgress(states: Iterable<RunProgressState>): RunProgressState {
	let working = false;
	for (const state of states) {
		if (state === "waiting") return "waiting";
		if (state === "working") working = true;
	}
	return working ? "working" : "idle";
}
