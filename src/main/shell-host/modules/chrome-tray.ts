/**
 * The `chrome` module's tray area (PROTOCOL.md §15.5): the tray lives in the shell. Node tells it what only Node has:
 * the renderer's snapshot (`setTrayState`) and the updater's status (`watchTrayUpdates`), and runs the updater call
 * its update item asks for.
 */
import type { TrayState, UpdateStatus } from "../../../shared/ipc-types";
import { chrome } from "./chrome";
import { applyUpdate, checkForUpdate, downloadUpdate, onUpdateStatus, updateStatus } from "./updater";

export interface TraySpec {
	calls: Record<never, never>;
	posts: {
		/** `state` (`null`: none) when the renderer's snapshot changed, `update` when the updater's status did. */
		tray: { state?: TrayState | null; update?: UpdateStatus };
	};
	events: {
		/** The tray's update item was chosen. */
		updateAction: { action: "check" | "download" | "apply" };
	};
	asks: Record<never, never>;
}

/**
 * The renderer pushed a fresh snapshot (the status already aggregated over every window). Hover text tracks the
 * status; the shell replaces the menu only when a label a user can read changed.
 */
export function setTrayState(state: TrayState): void {
	void chrome().post("tray", { state });
}

/**
 * Keeps the tray's update item in step with the updater and runs what it asks for (check, download, install). Call
 * once at start; returns what stops it.
 */
export function watchTrayUpdates(): () => void {
	const stopStatus = onUpdateStatus(update => void chrome().post("tray", { update }));
	void chrome().post("tray", { update: updateStatus() });
	const stopActions = chrome().on("updateAction", ({ action }) => {
		if (action === "check") void checkForUpdate();
		else if (action === "download") void downloadUpdate();
		else void applyUpdate();
	});
	return () => {
		stopStatus();
		stopActions();
	};
}
