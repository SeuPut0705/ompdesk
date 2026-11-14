/** Aggregates window run states for the native tray and app progress surface. */

import type { RunProgressState, TrayState } from "../shared/ipc-types";

export type TrayStatus = TrayState["status"];

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
