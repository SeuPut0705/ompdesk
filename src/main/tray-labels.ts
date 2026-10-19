/**
 * Pure tray vocabulary: every string the native menu shows, plus the signature
 * that decides whether the menu has to be rebuilt. Lives outside `tray.ts`
 * because that module needs electron — the label mapping and the churn guard
 * are the parts worth testing.
 */

import type { TrayState } from "../shared/ipc-types";
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
	statusApproval: { en: "Needs approval", ko: "승인 필요" },
	statusInput: { en: "Needs input", ko: "입력 필요" },
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

/** Which run state to show; the aggregate across windows, never per-window. */
export function statusLabel(lang: TrayLang, status: TrayStatus): string {
	if (status === "error") return t(lang, "statusError");
	if (status === "streaming") return t(lang, "statusStreaming");
	if (status === "approval") return t(lang, "statusApproval");
	if (status === "input") return t(lang, "statusInput");
	return t(lang, "statusIdle");
}

/**
 * Collapse per-window statuses to one: any error > streaming > waiting > idle.
 * Windows waiting on different things read as the neutral `input`.
 */
export function aggregateTrayStatus(states: Iterable<TrayState>): TrayStatus {
	// Precedence is app-global, so a single early return on the first window's
	// streaming would hide a later window's error.
	let streaming = false;
	let waiting: "approval" | "input" | null = null;
	for (const { status } of states) {
		if (status === "error") return "error";
		if (status === "streaming") streaming = true;
		if (status === "approval" || status === "input")
			waiting = waiting === null || waiting === status ? status : "input";
	}
	return streaming ? "streaming" : (waiting ?? "idle");
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
