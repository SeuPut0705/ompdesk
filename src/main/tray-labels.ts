/**
 * The tray's words, and the aggregate of the windows' states that feed it. The menu itself, its signature and the hover
 * text moved into the shell (`chrome_core::tray`); the shell reads these words as `tray.<key>` through `i18n.labels`
 * until SX5 moves the table there (PROTOCOL.md §15.4 rule 2).
 */

import type { RunProgressState, TrayState } from "../shared/ipc-types";

export type TrayStatus = TrayState["status"];

/** Tray-label strings, translated in main (the shell shows them in the language Node pushes). */
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
