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
	showHide: { zh: "显示 / 隐藏", en: "Show / Hide", ko: "보기/숨기기" },
	quit: { zh: "退出", en: "Quit", ko: "종료" },
	newSession: { zh: "新建会话", en: "New Session", ko: "새 세션" },
	openProject: { zh: "打开项目…", en: "Open Project…", ko: "프로젝트 열기…" },
	handoff: { zh: "交接", en: "Handoff", ko: "핸드오프" },
	usageStats: { zh: "用量与配额…", en: "Usage & Quotas…", ko: "사용량 및 할당량…" },
	workspaces: { zh: "切换项目", en: "Switch Project", ko: "프로젝트 전환" },
	addWorkspace: { zh: "打开项目…", en: "Open Project…", ko: "프로젝트 열기…" },
	quickStart: { zh: "快速开始", en: "Quick Start", ko: "빠른 시작" },
	quickConfig: { zh: "快速设置", en: "Quick Settings", ko: "빠른 설정" },
	fastMode: { zh: "快速模式", en: "Fast Mode", ko: "빠른 모드" },
	thinking: { zh: "思考强度", en: "Thinking Level", ko: "사고 수준" },
	approval: { zh: "工具审批", en: "Tool Approval", ko: "도구 승인" },
	language: { zh: "语言", en: "Language", ko: "언어" },
	approvalYolo: { zh: "完全访问", en: "Full access", ko: "전체 접근" },
	approvalWrite: { zh: "自动编辑", en: "Auto-edit", ko: "자동 편집" },
	approvalAsk: { zh: "每次询问", en: "Ask every time", ko: "매번 확인" },
	context: { zh: "上下文", en: "Context", ko: "컨텍스트" },
	tokens: { zh: "tokens", en: "tokens", ko: "토큰" },
	noModel: { zh: "未选模型", en: "No model", ko: "모델 없음" },
	statusIdle: { zh: "就绪", en: "Ready", ko: "준비됨" },
	statusStreaming: { zh: "工作中", en: "Working", ko: "작업 중" },
	statusWaiting: { zh: "需要输入", en: "Needs input", ko: "입력 필요" },
	statusError: { zh: "出错", en: "Error", ko: "오류" },
} as const;

export type TrayLabelKey = keyof typeof TRAY_LABELS;

export function t(lang: TrayLang, key: TrayLabelKey): string {
	return TRAY_LABELS[key][lang];
}

/** Which run state to show; the aggregate across windows, never per-window. */
export function statusLabel(lang: TrayLang, status: TrayStatus): string {
	if (status === "error") return t(lang, "statusError");
	if (status === "streaming") return t(lang, "statusStreaming");
	if (status === "waiting") return t(lang, "statusWaiting");
	return t(lang, "statusIdle");
}

/** Collapse per-window statuses to one: any error > streaming > waiting > idle. */
export function aggregateTrayStatus(states: Iterable<TrayState>): TrayStatus {
	// Precedence is app-global, so a single early return on the first window's
	// streaming would hide a later window's error.
	let streaming = false;
	let waiting = false;
	for (const { status } of states) {
		if (status === "error") return "error";
		if (status === "streaming") streaming = true;
		if (status === "waiting") waiting = true;
	}
	return streaming ? "streaming" : waiting ? "waiting" : "idle";
}

export function approvalLabel(lang: TrayLang, mode: TrayApprovalMode): string {
	if (mode === "yolo") return t(lang, "approvalYolo");
	if (mode === "write") return t(lang, "approvalWrite");
	return t(lang, "approvalAsk");
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/** Hover text: the icon itself stays a static template mark by design. */
export function trayTooltip(state: TrayState | null): string {
	if (!state) return "ompdesk";
	return `ompdesk — ${state.projectName} · ${statusLabel(state.language, state.status)}`;
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
