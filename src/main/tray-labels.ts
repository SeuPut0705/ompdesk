/**
 * Pure tray vocabulary: every string the native menu shows, the menu itself as a
 * template, and the signature that decides whether the menu has to be rebuilt.
 * Lives outside `tray.ts` because that module needs electron.
 */

import type { MenuItemConstructorOptions } from "electron";
import type { RunProgressState, TrayState, UpdateStatus } from "../shared/ipc-types";
import type { UiLanguage } from "../shared/ui-language";

export type TrayStatus = TrayState["status"];
export type TrayLang = UiLanguage;

/** Tray-label strings, translated in main (the renderer reports the language). */
export const TRAY_LABELS = {
	open: { en: "Open OMPdesk", ko: "OMPdesk 열기" },
	hide: { en: "Hide OMPdesk", ko: "OMPdesk 숨기기" },
	quit: { en: "Quit", ko: "종료" },
	updateCheck: { en: "Check for updates", ko: "업데이트 확인" },
	updateChecking: { en: "Checking for updates…", ko: "업데이트 확인 중…" },
	updateDownload: { en: "Download v{version}", ko: "v{version} 다운로드" },
	updateDownloading: { en: "Downloading v{version}…", ko: "v{version} 다운로드 중…" },
	updateDownloadingPercent: { en: "Downloading v{version}… {percent}%", ko: "v{version} 다운로드 중… {percent}%" },
	updateRestart: { en: "Restart to update to v{version}", ko: "다시 시작해서 v{version} 업데이트" },
	updateInstalling: { en: "Installing v{version}…", ko: "v{version} 설치 중…" },
	updateOpenInstaller: { en: "Open installer for v{version}", ko: "v{version} 설치 프로그램 열기" },
	updateUpToDate: { en: "OMPdesk is up to date", ko: "OMPdesk가 최신 버전이에요" },
	updateFailed: { en: "Update failed — try again", ko: "업데이트 실패 — 다시 시도" },
	statusIdle: { en: "Ready", ko: "준비됨" },
	statusStreaming: { en: "Working", ko: "작업 중" },
	// The renderer's attention words (`attention.*`), pinned by native-labels.test.ts.
	statusQuestion: { en: "Needs input", ko: "답변 필요" },
	statusApproval: { en: "Needs approval", ko: "승인 필요" },
	statusChildWaiting: { en: "Child waiting", ko: "하위 세션 대기" },
	statusError: { en: "Error", ko: "오류" },
} as const;

export type TrayLabelKey = keyof typeof TRAY_LABELS;

export function t(lang: TrayLang, key: TrayLabelKey, params?: Record<string, string | number>): string {
	const text: string = TRAY_LABELS[key][lang];
	return params ? text.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? "")) : text;
}

const STATUS_KEYS: Record<TrayStatus, TrayLabelKey> = {
	idle: "statusIdle",
	streaming: "statusStreaming",
	question: "statusQuestion",
	approval: "statusApproval",
	childWaiting: "statusChildWaiting",
	error: "statusError",
};

/** Which run state to show; the aggregate across windows, never per-window. */
export function statusLabel(lang: TrayLang, status: TrayStatus): string {
	return t(lang, STATUS_KEYS[status]);
}

/**
 * Loudest first: an error, what a window needs from the person (a question, an approval, a waiting child), work that
 * goes on, then idle.
 */
const STATUS_RANK: readonly TrayStatus[] = ["error", "question", "approval", "childWaiting", "streaming", "idle"];

/**
 * Collapse per-window statuses to the loudest. Precedence is app-global, so the first window's state never hides a
 * louder later one; a window waiting on the person outranks another one working, as inside one window (App.tsx). A
 * status this build does not know (a newer renderer's) counts as nothing, never as louder than an error.
 */
export function aggregateTrayStatus(states: Iterable<TrayState>): TrayStatus {
	let loudest = STATUS_RANK.length - 1;
	for (const { status } of states) {
		const rank = STATUS_RANK.indexOf(status);
		if (rank >= 0) loudest = Math.min(loudest, rank);
	}
	return STATUS_RANK[loudest] ?? "idle";
}

/** Hover text: the icon itself stays a static template mark by design. */
export function trayTooltip(state: TrayState | null): string {
	if (!state) return "OMPdesk";
	return `OMPdesk — ${state.projectName} · ${statusLabel(state.language, state.status)}`;
}

/** What the update item does when clicked; null when it only reports. */
export type TrayUpdateAction = "check" | "download" | "install";

export interface TrayUpdateItem {
	label: string;
	action: TrayUpdateAction | null;
}

/**
 * The update item for the updater's state. `upToDateShown` is whether a finished "no update" check is still
 * announced; after that the item offers a check again.
 */
export function trayUpdateItem(lang: TrayLang, status: UpdateStatus, upToDateShown: boolean): TrayUpdateItem {
	switch (status.state) {
		case "checking":
			return { label: t(lang, "updateChecking"), action: null };
		case "available":
			return status.mode === "manual"
				? { label: t(lang, "updateDownload", { version: status.version }), action: "download" }
				: { label: t(lang, "updateDownloading", { version: status.version }), action: null };
		case "downloading":
			return {
				label: t(lang, "updateDownloadingPercent", { version: status.version, percent: status.percent }),
				action: null,
			};
		case "downloaded":
			if (status.installing)
				return { label: t(lang, "updateInstalling", { version: status.version }), action: null };
			return status.mode === "manual"
				? { label: t(lang, "updateOpenInstaller", { version: status.version }), action: "install" }
				: { label: t(lang, "updateRestart", { version: status.version }), action: "install" };
		case "not-available":
			return upToDateShown
				? { label: t(lang, "updateUpToDate"), action: null }
				: { label: t(lang, "updateCheck"), action: "check" };
		case "error":
			return { label: t(lang, "updateFailed"), action: "check" };
		default:
			return { label: t(lang, "updateCheck"), action: "check" };
	}
}

export interface TrayMenuInput {
	lang: TrayLang;
	windowVisible: boolean;
	update: TrayUpdateItem;
}

export interface TrayMenuActions {
	toggleWindow(): void;
	update(action: TrayUpdateAction): void;
	quit(): void;
}

/** The whole tray menu: show/hide, the update item, Quit. */
export function trayMenuTemplate(input: TrayMenuInput, actions: TrayMenuActions): MenuItemConstructorOptions[] {
	const { lang, windowVisible, update } = input;
	const action = update.action;
	return [
		{ label: t(lang, windowVisible ? "hide" : "open"), click: () => actions.toggleWindow() },
		{
			label: update.label,
			enabled: action !== null,
			click: () => {
				if (action) actions.update(action);
			},
		},
		{ type: "separator" },
		{ label: t(lang, "quit"), click: () => actions.quit() },
	];
}

/** Everything a rebuilt menu can differ in, as one string: a push that changes none of it must not swap the menu. */
export function menuSignature(input: TrayMenuInput): string {
	return [input.lang, input.windowVisible, input.update.label, input.update.action ?? "—"].join("\u0002");
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
