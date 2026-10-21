/**
 * Updater store: the renderer's mirror of the main-process update status
 * machine (pushed via updater:status, replayed on boot via getStatus), plus the
 * banner dismissal. Dismissal is per-version: snoozing v0.4.1 doesn't hide
 * v0.4.2 when it lands. Both dismissals outlive the process — the version
 * because a release already declined shouldn't come back, and the error because
 * a broken update feed re-reports the same failure on every poll.
 */
import { create } from "zustand";
import type { UpdateStatus } from "../../shared/ipc-types";
import { translate } from "../lib/i18n";
import { toastError } from "./toast";

const DISMISSAL_KEY = "omp.update.dismissed";

export interface UpdateDismissal {
	version?: string;
	error?: boolean;
}

/** States that prove the updater is working, which re-arms a dismissed failure. */
const RECOVERED: readonly UpdateStatus["state"][] = ["available", "not-available", "downloaded"];

/**
 * Read the persisted banner dismissal. Exported so the store's write side and
 * the restart's read side can be proven to agree on the same key and shape.
 */
export function loadDismissal(): UpdateDismissal {
	try {
		const raw = localStorage.getItem(DISMISSAL_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return {};
		const { version, error } = parsed as Record<string, unknown>;
		return {
			version: typeof version === "string" ? version : undefined,
			error: error === true ? true : undefined,
		};
	} catch {
		return {};
	}
}

function persistDismissal(dismissal: UpdateDismissal): void {
	try {
		localStorage.setItem(DISMISSAL_KEY, JSON.stringify(dismissal));
	} catch {
		/* storage unavailable — dismissal becomes session-only */
	}
}

interface UpdaterStore {
	status: UpdateStatus;
	dismissed: UpdateDismissal;
	/**
	 * A check the user asked for (app menu › Check for Updates…) is in progress or
	 * its result is still on screen: the sidebar card reports every outcome
	 * (checking, up to date, failure) in place instead of opening Settings.
	 * Background polls never set it, so they stay silent.
	 */
	manualCheck: boolean;
	setStatus: (status: UpdateStatus) => void;
	dismiss: (version: string) => void;
	dismissError: () => void;
	endManualCheck: () => void;
}

export const useUpdaterStore = create<UpdaterStore>()((set, get) => ({
	status: { state: "idle" },
	dismissed: loadDismissal(),
	manualCheck: false,
	setStatus: status => {
		const { error } = get().dismissed;
		if (error && RECOVERED.includes(status.state)) {
			const next = { version: get().dismissed.version };
			persistDismissal(next);
			set({ status, dismissed: next });
			return;
		}
		set({ status });
	},
	dismiss: version => {
		const next = { version, error: get().dismissed.error };
		persistDismissal(next);
		set({ dismissed: next });
	},
	dismissError: () => {
		const next = { version: get().dismissed.version, error: true };
		persistDismissal(next);
		set({ dismissed: next });
	},
	endManualCheck: () => set({ manualCheck: false }),
}));

/** Wire the main-process push + boot replay once (App mount). Returns unsubscribe. */
export function subscribeUpdaterStatus(): () => void {
	const unsubscribe = window.omp.events.onUpdaterStatus(status => {
		useUpdaterStore.getState().setStatus(status);
	});
	// A failed read keeps the status it has; main pushes every change anyway.
	void window.omp.updater.getStatus().then(
		status => useUpdaterStore.getState().setStatus(status),
		() => undefined,
	);
	return unsubscribe;
}

/**
 * Run a user-requested check without leaving the session: the sidebar card
 * shows "Checking…" right away and then the outcome. Main broadcasts the same
 * transitions; the returned status covers a check that settles without one.
 */
export async function checkForUpdatesInPlace(): Promise<void> {
	useUpdaterStore.setState({ manualCheck: true, status: { state: "checking" } });
	try {
		useUpdaterStore.getState().setStatus(await window.omp.updater.check());
	} catch (error) {
		useUpdaterStore
			.getState()
			.setStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
	}
}

/**
 * A button's download, install or postpone. Main reports what goes wrong with the update itself in the status; this
 * says only that the click never reached it (a phone page whose link to the computer dropped).
 */
export function runUpdaterAction(action: "download" | "apply" | "postpone"): void {
	void window.omp.updater[action]().catch(error => toastError({ title: translate("updater.actionFailed"), error }));
}
