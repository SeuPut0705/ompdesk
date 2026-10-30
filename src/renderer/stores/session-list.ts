/**
 * Shared session list, one feed per scope. Every `useSessionList` consumer
 * (sidebar, split workspace, tab housekeeping, tray sync, title bar,
 * workspace dialog) reads the same feed, so a SESSIONS_CHANGED burst costs one
 * debounced `sessions.list` instead of one per mounted consumer.
 *
 * The global list is numbered (`shared/session-list-delta.ts`): main keeps one
 * copy per computer and pushes what changed with each SESSIONS_CHANGED. A feed
 * holding the version a change starts from applies it and asks nothing; any
 * other (no copy yet, a change missed while released or behind a dropped link)
 * reads the whole list once.
 *
 * Layering that keeps the sidebar calm (the "twitch/ghosting" fix):
 * - The loading state shows ONLY on the initial load.
 * - SessionIndex watcher events fire per session-file append (constantly
 *   while agents stream), so event-driven reads are DEBOUNCED (trailing
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
import {
	applySessionListDelta,
	olderSessionListVersion,
	type VersionedSessionList,
} from "../../shared/session-list-delta";
import { snapshotNs, snapshots } from "../lib/snapshot-cache";

export type SessionListScope = "local" | "global";

export interface SessionListState {
	sessions: SessionInfo[];
	isLoading: boolean;
	/** A live read of the index has answered since this app started: the rows are what exists, not a last-known snapshot. */
	live: boolean;
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

const INITIAL_STATE: SessionListState = { sessions: [], isLoading: true, live: false, error: null };
/** The index is the newest rows only: the sidebar groups and pages what it shows, and the live read brings the rest. */
const SNAPSHOT_ROWS = 150;
const SNAPSHOT_DELAY_MS = 1500;

/** The last list this device showed for the feed (the last known state: painted at once, replaced by the live read). */
function snapshotKey(scope: SessionListScope): string {
	return scope;
}

/**
 * The same row as before: its journal (modified, size, title, kind) and what a paired host says of it beside the
 * journal (who opened it, whether a tab there holds it, its children's verdict), which change with no journal write.
 */
function sameRow(prev: SessionInfo, next: SessionInfo): boolean {
	return (
		prev.modified === next.modified &&
		prev.size === next.size &&
		prev.title === next.title &&
		prev.kind === next.kind &&
		prev.openedBySession === next.openedBySession &&
		prev.heldOnHost === next.heldOnHost &&
		prev.childProblem === next.childProblem
	);
}

function reconcile(previous: SessionInfo[], fetched: SessionInfo[]): SessionInfo[] {
	const byPath = new Map(previous.map(session => [session.path, session]));
	let changed = previous.length !== fetched.length;
	const next = fetched.map((session, index) => {
		const prev = byPath.get(session.path);
		const kept = prev && sameRow(prev, session) ? prev : session;
		if (kept !== previous[index]) changed = true;
		return kept;
	});
	return changed ? next : previous;
}

/** A held list whose read failed reads again after this, doubling up to {@link READ_RETRY_MAX_MS}. */
export const READ_RETRY_MS = 2_000;
export const READ_RETRY_MAX_MS = 30_000;

/** Feeds someone shows right now (`retain`ed). */
const heldRefreshes = new Set<() => void>();

function createSessionListFeed(scope: SessionListScope, device: string | undefined): SessionListFeed {
	const ns = snapshotNs(device);
	const seeded = snapshots().read<SessionInfo[]>("sessions", ns, snapshotKey(scope))?.value;
	const store = createStore<SessionListState>()(() =>
		Array.isArray(seeded) && seeded.length > 0
			? { sessions: seeded, isLoading: false, live: false, error: null }
			: INITIAL_STATE,
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
	let retryTimer: number | undefined;
	/** Failed reads in a row while held: each retry waits longer (`READ_RETRY_MS`, doubled, at most `READ_RETRY_MAX_MS`). */
	let failures = 0;
	let unsubscribe: (() => void) | null = null;
	/** The global list at the version main numbered it (`listShared`): a pushed change of that version applies here. */
	let copy: VersionedSessionList | null = null;
	/** The newest version a change named while a read was under way: the read's answer must be at least that one. */
	let announced: string | null = null;

	const accept = (list: SessionInfo[]): void => {
		loaded = true;
		failures = 0;
		const state = store.getState();
		const sessions = reconcile(state.sessions, list);
		if (sessions !== state.sessions || state.isLoading || !state.live || state.error !== null)
			store.setState({ sessions, isLoading: false, live: true, error: null });
		if (sessions !== state.sessions || !state.error) remember();
		// The global list holds every session, so a row of the local list's last-known copy it lacks was deleted,
		// possibly on another device: dropped now, before that list next paints it (a phone reload, a mount).
		if (scope === "global") {
			const live = new Set(list.map(session => session.path));
			const cached = snapshots().read<SessionInfo[]>("sessions", ns, snapshotKey("local"))?.value;
			if (Array.isArray(cached) && cached.some(session => !live.has(session.path)))
				snapshots().write(
					"sessions",
					ns,
					snapshotKey("local"),
					cached.filter(session => live.has(session.path)),
				);
		}
	};

	/** The global feed reads the numbered list; a folder's list is read as it is. */
	const read = (): Promise<SessionInfo[] | VersionedSessionList> => {
		if (scope === "global")
			return device === undefined ? window.omp.sessions.listShared() : window.omp.sessions.listShared(device);
		return device === undefined ? window.omp.sessions.list(scope) : window.omp.sessions.list(scope, device);
	};

	const refresh = (showSpinner = false): void => {
		if (showSpinner && !loaded && !store.getState().isLoading && store.getState().sessions.length === 0)
			store.setState({ isLoading: true });
		if (inFlight) {
			queued = true;
			return;
		}
		inFlight = true;
		const version = generation;
		read()
			.then(
				answer => {
					if (version !== generation) return;
					if (Array.isArray(answer)) return accept(answer);
					copy = answer;
					accept(answer.sessions);
					// A change main published in the moment between taking this answer and sending it.
					if (announced !== null && olderSessionListVersion(answer.version, announced)) queued = true;
				},
				(cause: unknown) => {
					// A read that never answered is not a read that found nothing — the
					// sidebar would otherwise claim "no sessions yet" for a failure.
					if (version !== generation) return;
					store.setState({ error: cause instanceof Error ? cause.message : String(cause), isLoading: false });
					// The rows on screen may be a last-known copy (a paired host's from before sessions were deleted there):
					// a list someone shows reads again until one answers, instead of waiting for the next change push.
					if (holders > 0) {
						window.clearTimeout(retryTimer);
						const wait = Math.min(READ_RETRY_MS * 2 ** failures, READ_RETRY_MAX_MS);
						failures++;
						retryTimer = window.setTimeout(() => refresh(), wait);
					}
				},
			)
			.finally(() => {
				if (version !== generation) return;
				inFlight = false;
				announced = null;
				if (!queued) return;
				queued = false;
				refresh();
			});
	};

	const retain = (): (() => void) => {
		holders++;
		if (holders === 1) {
			unsubscribe = window.omp.events.onSessionsChanged(change => {
				// Another machine's list changed: this one's rows are as they were.
				if (change.device !== device) return;
				const delta = scope === "global" ? change.list : undefined;
				if (delta && inFlight) {
					// The read under way answers it (main answers after every change it pushed before).
					announced = delta.version;
					return;
				}
				if (delta && copy?.version === delta.base) {
					copy = { version: delta.version, sessions: applySessionListDelta(copy.sessions, delta) };
					accept(copy.sessions);
					return;
				}
				if (delta && copy?.version === delta.version) return;
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
			window.clearTimeout(retryTimer);
			failures = 0;
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
			// Every list of this device drops it now, held or not, and so does each one's last-known copy: a list nobody
			// shows would otherwise paint the deleted row again on its next mount (or the next launch) until its read.
			for (const each of ["local", "global"] as const) {
				const target = feeds.get(device === undefined ? each : `${each}:${device}`)?.store;
				if (target)
					target.setState({ sessions: target.getState().sessions.filter(session => session.path !== path) });
				const cached = snapshots().read<SessionInfo[]>("sessions", ns, snapshotKey(each))?.value;
				if (Array.isArray(cached) && cached.some(session => session.path === path))
					snapshots().write(
						"sessions",
						ns,
						snapshotKey(each),
						cached.filter(session => session.path !== path),
					);
			}
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
