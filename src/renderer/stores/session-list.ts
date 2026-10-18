/**
 * Shared session list, one feed per scope. Every `useSessionList` consumer
 * (sidebar, split workspace, tab housekeeping, tray sync, title bar,
 * workspace dialog) reads the same feed, so a SESSIONS_CHANGED burst costs one
 * debounced `sessions.list` instead of one per mounted consumer.
 *
 * Layering that keeps the sidebar calm (the "twitch/ghosting" fix):
 * - The loading state shows ONLY on the initial load.
 * - SessionIndex watcher events fire per session-file append (constantly
 *   while agents stream), so event-driven refreshes are DEBOUNCED (trailing
 *   350ms) and update silently — NO animation on background churn.
 * - One read in flight per feed; a refresh asked for meanwhile runs once
 *   after it, so the last change is never missed.
 * - Rows whose path, modified time, size, title and kind are unchanged keep
 *   their object, and an unchanged list keeps the array: memoized rows and
 *   selectors skip work on the common "another session grew" refresh.
 * - User-initiated deletion/rename updates the row locally before the
 *   refresh reconciles authoritatively.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { SessionInfo } from "../../shared/ipc-types";
import { snapshotNs, snapshots } from "../lib/snapshot-cache";

export type SessionListScope = "local" | "global";

export interface SessionListState {
	sessions: SessionInfo[];
	isLoading: boolean;
	/** Set when the last read failed; an empty list must not claim "nothing here". */
	error: string | null;
}

export interface SessionListFeed {
	store: StoreApi<SessionListState>;
	/** Hold the feed open (subscription + initial load); returns the release. */
	retain: () => () => void;
	refresh: (showSpinner?: boolean) => void;
	deleteSession: (path: string) => Promise<void>;
	renameSession: (path: string, name: string) => Promise<void>;
}

const REFRESH_DEBOUNCE_MS = 350;

const INITIAL_STATE: SessionListState = { sessions: [], isLoading: true, error: null };
/** The index is the newest rows only: the sidebar groups and pages what it shows, and the live read brings the rest. */
const SNAPSHOT_ROWS = 150;
const SNAPSHOT_DELAY_MS = 1500;

/** The last list this device showed for the feed (the last known state: painted at once, replaced by the live read). */
function snapshotKey(scope: SessionListScope): string {
	return scope;
}

function reconcile(previous: SessionInfo[], fetched: SessionInfo[]): SessionInfo[] {
	const byPath = new Map(previous.map(session => [session.path, session]));
	let changed = previous.length !== fetched.length;
	const next = fetched.map((session, index) => {
		const prev = byPath.get(session.path);
		const kept =
			prev &&
			prev.modified === session.modified &&
			prev.size === session.size &&
			prev.title === session.title &&
			prev.kind === session.kind
				? prev
				: session;
		if (kept !== previous[index]) changed = true;
		return kept;
	});
	return changed ? next : previous;
}

/** Feeds someone shows right now (`retain`ed). */
const heldRefreshes = new Set<() => void>();

function createSessionListFeed(scope: SessionListScope, device: string | undefined): SessionListFeed {
	const ns = snapshotNs(device);
	const seeded = snapshots().read<SessionInfo[]>("sessions", ns, snapshotKey(scope))?.value;
	const store = createStore<SessionListState>()(() =>
		Array.isArray(seeded) && seeded.length > 0 ? { sessions: seeded, isLoading: false, error: null } : INITIAL_STATE,
	);
	let saveTimer: number | undefined;
	const remember = () => {
		window.clearTimeout(saveTimer);
		saveTimer = window.setTimeout(
			() => snapshots().write("sessions", ns, snapshotKey(scope), store.getState().sessions.slice(0, SNAPSHOT_ROWS)),
			SNAPSHOT_DELAY_MS,
		);
	};
	let holders = 0;
	/** Bumped when the last holder lets go: answers to older reads are dropped. */
	let generation = 0;
	let loaded = false;
	let inFlight = false;
	let queued = false;
	let debounceTimer: number | undefined;
	let unsubscribe: (() => void) | null = null;

	const refresh = (showSpinner = false): void => {
		if (showSpinner && !loaded && !store.getState().isLoading && store.getState().sessions.length === 0)
			store.setState({ isLoading: true });
		if (inFlight) {
			queued = true;
			return;
		}
		inFlight = true;
		const version = generation;
		(device === undefined ? window.omp.sessions.list(scope) : window.omp.sessions.list(scope, device))
			.then(
				list => {
					if (version !== generation) return;
					loaded = true;
					const state = store.getState();
					const sessions = reconcile(state.sessions, list);
					if (sessions !== state.sessions || state.isLoading || state.error !== null)
						store.setState({ sessions, isLoading: false, error: null });
					if (sessions !== state.sessions || !state.error) remember();
				},
				(cause: unknown) => {
					// A read that never answered is not a read that found nothing — the
					// sidebar would otherwise claim "no sessions yet" for a failure.
					if (version !== generation) return;
					store.setState({ error: cause instanceof Error ? cause.message : String(cause), isLoading: false });
				},
			)
			.finally(() => {
				if (version !== generation) return;
				inFlight = false;
				if (!queued) return;
				queued = false;
				refresh();
			});
	};

	const retain = (): (() => void) => {
		holders++;
		if (holders === 1) {
			unsubscribe = window.omp.events.onSessionsChanged(() => {
				window.clearTimeout(debounceTimer);
				debounceTimer = window.setTimeout(() => refresh(), REFRESH_DEBOUNCE_MS);
			});
			refresh(true);
			heldRefreshes.add(refresh);
		}
		return () => {
			holders--;
			if (holders > 0) return;
			window.clearTimeout(debounceTimer);
			unsubscribe?.();
			unsubscribe = null;
			heldRefreshes.delete(refresh);
			// Nobody shows the list: it keeps the last rows (the next holder paints them at once) and
			// reads again in place; answers to the read that was in flight are dropped.
			generation++;
			loaded = false;
			inFlight = false;
			queued = false;
			if (store.getState().isLoading || store.getState().error) store.setState({ isLoading: false, error: null });
		};
	};

	return {
		store,
		retain,
		refresh,
		deleteSession: async path => {
			await (device === undefined ? window.omp.sessions.delete(path) : window.omp.sessions.delete(path, device));
			store.setState({ sessions: store.getState().sessions.filter(session => session.path !== path) });
			refresh();
		},
		renameSession: async (path, name) => {
			await (device === undefined
				? window.omp.sessions.rename(path, name)
				: window.omp.sessions.rename(path, name, device));
			store.setState({
				sessions: store
					.getState()
					.sessions.map(session => (session.path === path ? { ...session, title: name } : session)),
			});
			refresh();
		},
	};
}

const feeds = new Map<string, SessionListFeed>();

/** One feed per scope and device (`device` = paired host deviceId; absent = this device). */
export function sessionListFeed(scope: SessionListScope, device?: string): SessionListFeed {
	const key = device === undefined ? scope : `${scope}:${device}`;
	const feed = feeds.get(key) ?? createSessionListFeed(scope, device);
	feeds.set(key, feed);
	return feed;
}

/** Read every shown list again: a web page whose link dropped missed the SESSIONS_CHANGED pushes (web/resync-page.ts). */
export function refreshHeldSessionLists(): void {
	for (const refresh of heldRefreshes) refresh();
}

/** Tests: forget every feed, so rows kept from an earlier mount cannot leak into the next. */
export function resetSessionListFeeds(): void {
	feeds.clear();
}
