/**
 * Sidebar presentation prefs: pinned workspaces/sessions, workspace display
 * aliases (rename), the dragged project order, archived sessions (by id; stock
 * has no archive flag, so archiving only hides a session from the lists), the
 * shortcuts pinned to the sidebar footer, and the workspace MRU clock the workspace
 * picker sorts by. The stored "sidebar" prefs blob belongs to main (src/main/sidebar-prefs.ts, rules in
 * src/shared/sidebar-prefs.ts): this store reads it at App mount and whenever another window or page changed it
 * (PREFS_CHANGED), and every action sends ONE change for main to apply to what is stored now, never a whole blob
 * from this copy. The pins, aliases, order and archive the user can SEE are optimistic: they show at once and roll
 * back when main rejects the change, so a row never stays pinned across a restart. Recency bookkeeping is
 * fire-and-forget.
 */
import { create } from "zustand";
import {
	type RailPin,
	readSidebarPrefs,
	SIDEBAR_PREFS_KEY,
	type SidebarChange,
	type SidebarPrefs,
	sidebarPatch,
} from "../../shared/sidebar-prefs";
import { translate } from "../lib/i18n";
import { optimisticWrite } from "../lib/optimistic";
import { PREFS_BOOT_RETRY_MS, readPref } from "../lib/prefs-read";
import { toastError } from "./toast";

/** Each pin's name, shared by its sidebar row and its Settings switch. */
export const RAIL_PIN_LABEL_KEYS: Record<RailPin, string> = {
	usage: "sidebar.pin.usage",
	agents: "destination.agents",
	stats: "destination.insights",
	terminal: "panel.tabs.terminal",
	diff: "panel.tabs.diff",
	preview: "panel.tabs.preview",
	files: "panel.tabs.files",
	jobs: "viewSheet.jobs",
	schedules: "settings.section.schedules",
};

interface SidebarPrefsStore extends SidebarPrefs {
	hydrated: boolean;
	hydrate: () => Promise<void>;
	toggleGroupPin: (cwd: string) => Promise<void>;
	toggleSessionPin: (path: string) => Promise<void>;
	toggleAgentHidden: (path: string) => Promise<void>;
	setGroupAlias: (cwd: string, alias: string | null) => Promise<void>;
	setGroupOrder: (order: string[]) => Promise<void>;
	setSessionOrder: (list: string, order: string[]) => Promise<void>;
	setSessionsArchived: (ids: readonly string[], archived: boolean) => Promise<void>;
	toggleRailPin: (pin: RailPin) => Promise<void>;
	touchWorkspace: (cwd: string) => void;
	reset: () => void;
}

export const useSidebarPrefs = create<SidebarPrefsStore>()((set, get) => {
	/** Changes of ours sent to main and not yet answered, and how many were ever sent. */
	let inFlight = 0;
	let sent = 0;
	/** Another window or page changed the blob: this copy is out of date until it reads again. */
	let changedElsewhere = false;
	let rereading = false;
	let following = false;

	/**
	 * Reads the stored blob again after another window or page changed it, so every view shows the same order. A read
	 * that a change of ours overlapped may have missed it, so it is dropped and read again once ours has landed.
	 */
	const reread = async (): Promise<void> => {
		changedElsewhere = true;
		if (rereading) return;
		rereading = true;
		try {
			while (changedElsewhere) {
				// Ours settles first, then comes back here.
				if (inFlight > 0) return;
				changedElsewhere = false;
				const startedAt = sent;
				const read = await readPref(SIDEBAR_PREFS_KEY, PREFS_BOOT_RETRY_MS);
				if (!read.ok) return;
				if (inFlight > 0 || sent !== startedAt || changedElsewhere) {
					changedElsewhere = true;
					continue;
				}
				set({ ...readSidebarPrefs(read.value), hydrated: true });
			}
		} finally {
			rereading = false;
		}
	};

	/** Follows main's PREFS_CHANGED for the blob; a missing bridge (a test) is skipped. */
	const follow = (): void => {
		if (following || typeof window === "undefined" || typeof window.omp?.prefs?.onChanged !== "function") return;
		following = true;
		window.omp.prefs.onChanged(event => {
			if (event.key === SIDEBAR_PREFS_KEY) void reread();
		});
	};

	/** Sends one change to main, which applies it to the blob it stores now. */
	const send = async (change: SidebarChange): Promise<{ success: boolean; error?: string }> => {
		inFlight += 1;
		sent += 1;
		try {
			await window.omp.prefs.updateSidebar(change);
			return { success: true };
		} catch (cause) {
			return { success: false, error: cause instanceof Error ? cause.message : String(cause) };
		} finally {
			inFlight -= 1;
			if (inFlight === 0 && changedElsewhere) void reread();
		}
	};

	/**
	 * Reads the stored blob into the store. A failed read leaves the store un-hydrated: a toggle is decided from
	 * the stored state (pinned or not), which is unknown until a read succeeds.
	 */
	const load = async (retryDelaysMs: readonly number[]): Promise<void> => {
		if (get().hydrated) return;
		follow();
		const read = await readPref(SIDEBAR_PREFS_KEY, retryDelaysMs);
		// The write path's own read, or a change main announced, may have landed while a boot read slept.
		if (!read.ok || get().hydrated) return;
		set({ ...readSidebarPrefs(read.value), hydrated: true });
	};

	/**
	 * A change the user can see: read the stored blob first (once, no backoff)
	 * when boot has not, so the change is decided from it, and refuse the change
	 * with a toast while the blob stays unreadable.
	 */
	const write = async (
		failureTitleKey: string,
		changeOf: (state: SidebarPrefsStore) => SidebarChange,
	): Promise<void> => {
		if (!get().hydrated) await load([]);
		if (!get().hydrated) {
			toastError({ title: translate(failureTitleKey), error: translate("prefs.unreadable") });
			return;
		}
		const change = changeOf(get());
		await optimisticWrite({
			store: { getState: get, setState: set },
			mutate: state => sidebarPatch(state, change),
			persist: () => send(change),
			onFailure: failure => toastError({ title: translate(failureTitleKey), error: failure }),
		});
	};

	return {
		...readSidebarPrefs(undefined),
		hydrated: false,

		hydrate: () => load(PREFS_BOOT_RETRY_MS),

		toggleGroupPin: cwd =>
			write("sidebar.pinFailed", state => ({
				op: "set-group-pinned",
				cwd,
				pinned: !state.pinnedGroups.includes(cwd),
			})),

		toggleSessionPin: path =>
			write("sidebar.pinFailed", state => ({
				op: "set-session-pinned",
				path,
				pinned: !state.pinnedSessions.includes(path),
			})),

		toggleAgentHidden: path =>
			write("sidebar.agentHiddenFailed", state => ({
				op: "set-agent-hidden",
				path,
				hidden: !state.agentHidden.includes(path),
			})),

		setGroupAlias: (cwd, alias) => write("sidebar.renameFailed", () => ({ op: "set-group-alias", cwd, alias })),

		setGroupOrder: order => write("sidebar.reorderFailed", () => ({ op: "set-group-order", order: [...order] })),

		setSessionOrder: (list, order) =>
			write("sidebar.reorderFailed", () => ({ op: "set-session-order", list, order: [...order] })),

		setSessionsArchived: (ids, archived) =>
			write("sidebar.archiveFailed", () => ({ op: "set-sessions-archived", ids: [...ids], archived })),

		toggleRailPin: pin =>
			write("sidebar.pinFailed", state => ({
				op: "set-rail-pin",
				pin,
				pinned: !state.railPins.includes(pin),
			})),

		touchWorkspace: cwd => {
			// A lost write costs an ordering hint, nothing the user set out to do. Before the stored blob is known
			// the clock would be stamped on defaults.
			if (!cwd || !get().hydrated) return;
			const change: SidebarChange = { op: "touch-workspace", cwd };
			set(sidebarPatch(get(), change));
			void send(change);
		},

		reset: () => set({ ...readSidebarPrefs(undefined), hydrated: false }),
	};
});
