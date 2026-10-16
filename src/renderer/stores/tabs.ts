/**
 * Session tabs: in-window multi-session parallelism. Each tab owns a sidecar
 * in the main-process pool; every tab keeps running in the background while
 * exactly one is attached to this window's stores.
 *
 * Renderer-side pieces:
 * - The tab list (title/cwd/status/unreadDone) fed by GET_TABS boot
 *   reconciliation plus the light TAB_STATUS channel (fires for EVERY tab,
 *   unlike the full event channels which only forward the active tab's).
 * - Each tab owns a persistent renderer runtime. Up to four visible panes read
 *   those runtimes directly; focus only chooses the target for window-global
 *   actions and never moves session state between tabs.
 *
 * Wire shapes (IpcTabInfo / IpcTabStatusPayload / IpcSpawnTabPayload) and the
 * main-process pool live in the main slice — this store only consumes
 * window.omp.tabs.* and window.omp.events.onTabStatus.
 */
import {
	asSplitLayout,
	forgetSplitTab,
	mapSplitLeaves,
	readRememberedSplits,
	type SplitLayout,
	type SplitPlacement,
	type SplitView,
	splitForPlacement,
	splitTabIds,
	updateSplitRatio,
	viewAfterPick,
} from "../../shared/split-layout";

export type { SplitAxis, SplitLayout, SplitPlacement } from "../../shared/split-layout";

import { useEffect } from "react";
import { create, type StoreApi } from "zustand";
import type { AgentControlViewEvent } from "../../shared/agent-control";
import type {
	IpcOpenExtensionRequest,
	IpcScheduledRetry,
	IpcSignIn,
	IpcSpawnTabResult,
	IpcTabInfo,
	IpcTabStatusPayload,
	IpcTabWorktree,
	SessionInfo,
	SessionKind,
	TabStatus,
} from "../../shared/ipc-types";
import type { ExtensionUIRequest, RpcSessionState } from "../../shared/rpc-types";
import {
	attachTabSession,
	hydrateTabSession,
	notifyRunEnd,
	resetRetryPending,
	supersedeTabHydration,
} from "../hooks/use-rpc-events";
import { maxSplitPanes } from "../hooks/use-shell-mode";
import { basename } from "../lib/format";
import { translate } from "../lib/i18n";
import { sessionDisplayTitle } from "../lib/session-title";
import { beginTabRoute, reconcileTabRoute, resetTabRoute, settleTabRoute } from "../lib/tab-routing";
import { readUnreadMarks, restoredUnread, writeUnreadMarks } from "../lib/unread-marks";
import { webRuntime } from "../web/runtime";
import { type ComposerImage, type ComposerStore, useComposerStore } from "./composer";
import { type AwaitedInput, awaitedInput, type ExtensionUiStore } from "./extension-ui";
import { useForkHandoffStore } from "./fork-handoff";
import type { MessagesStore } from "./messages";
import { useNextPromptStore } from "./next-prompt";
import {
	type PendingPlanProposal,
	type PlanApprovalStore,
	type PlanApprovalSubmitState,
	usePlanApprovalStore,
} from "./plan-approval";
import { type SessionStore, useSessionStore } from "./session";
import {
	deleteSessionRuntime,
	type SessionRuntime,
	sessionRuntime,
	sessionRuntimeStore,
	setFocusedSessionRuntime,
	useRuntimeTabId,
} from "./session-runtime-context";
import { ensureTabRuntime, replaceTabRuntime } from "./tab-runtime";
import { toast, toastError } from "./toast";
import { useUiStore } from "./ui";

export interface SessionTab {
	id: string;
	cwd: string;
	status: TabStatus;
	/** Automatic transcript compaction is in flight in this tab's sidecar. */
	compacting?: boolean;
	/** Immutable session kind, fixed when this tab's sidecar was spawned. */
	kind: SessionKind;
	/** Untargeted startup tab that may be replaced while still truly empty. */
	placeholder?: boolean;
	/**
	 * Git-worktree binding (plan/20), immutable from spawn. Drives the chip's
	 * GitBranch marker, the untitled label (worktree name over the hash-suffixed
	 * basename), and the close-time cleanup prompt.
	 */
	worktree?: IpcTabWorktree;
	/** Paired host deviceId the tab's omp runs on (immutable from spawn); absent = this device. */
	device?: string;
	/** Session title when known (session_info_update via TAB_STATUS). */
	title?: string;
	/** Main-owned transcript identity, available even before session_info_update. */
	sessionPath?: string;
	sessionId?: string;
	/** A run completed while this tab was in the background. */
	unreadDone: boolean;
	/** Session to open once this tab's sidecar first reports ready (the
	 * open-session-in-new-tab flow — the sidecar starts on a fresh session and
	 * must be switched over before its transcript hydrates). */
	pendingSessionPath?: string;
	/** What the tab's session blocks on: a tool or plan approval, or any other answer (ask, confirm, …). */
	awaitingInput?: AwaitedInput;
	/** The tab's turn waits for the internet connection and continues by itself once it is back (main's turn-resume). */
	awaitingConnection?: boolean;
	/** The tab's failed turn retries by itself at `at` (main's turn-resume schedule); the error card counts it down. */
	scheduledRetry?: IpcScheduledRetry;
	/** Another window owns this tab and this one views it (multi-viewer); closing it here only leaves it. */
	shared?: true;
	/** How many windows besides the owner show this tab; absent when none does. Main's list is the authority. */
	viewerCount?: number;
}

// Focus routing is window-global. Serialize changes so rapid tab clicks cannot
// resolve out of order and leave main targeting the wrong sidecar.
let switchVersion = 0;
let routingChain: Promise<void> = Promise.resolve();
let ratioFlushTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by every `switchTab`: a switch still waiting on its tab's session yields to a newer one. */
let switchRequest = 0;
/** How long a switch to a tab that ran out of view waits for its present before painting anyway. */
const RETURN_HYDRATION_WAIT_MS = 100;

/**
 * Tabs the user closed in this window. Late IPC frames for these ids must be
 * dropped outright — withSessionRuntime would otherwise fall back to the
 * FOCUSED runtime and pollute a live session, and ensureTabRuntime would
 * resurrect a ghost runtime with no store cleanup path. Ids are never reused
 * (ULIDs), so tombstones live for the window's lifetime.
 */
const closedTabIds = new Set<string>();

export function isTabClosed(tabId: string): boolean {
	return closedTabIds.has(tabId);
}

/** Whether main holds remembered splits (it only learns the list through `setView`). */
let mainRemembersSplits = false;

function routeTabView(focusedTabId: string, visibleTabIds: string[], split?: SplitLayout | null): Promise<boolean> {
	const request = routingChain.then(async () => {
		// Read when the call runs: a ratio flush or a queued switch carries the latest list.
		const remembered = useTabsStore.getState().rememberedSplits;
		if (visibleTabIds.length === 1 && !split && remembered.length === 0 && !mainRemembersSplits) {
			return window.omp.tabs.setActive(focusedTabId);
		}
		const routed = await window.omp.tabs.setView(focusedTabId, visibleTabIds, split ?? undefined, remembered);
		if (routed) mainRemembersSplits = remembered.length > 0;
		return routed;
	});
	routingChain = request.then(
		() => undefined,
		() => undefined,
	);
	return request;
}

export function visibleTabIds(state: Pick<TabsStore, "activeTabId" | "split">): string[] {
	if (state.split) return splitTabIds(state.split);
	return state.activeTabId ? [state.activeTabId] : [];
}

/** A session field only proves a session change once both sides know it. */
function tabSessionChanged(previous: SessionTab | undefined, info: IpcTabStatusPayload): boolean {
	return (
		(previous?.sessionId !== undefined && info.sessionId !== undefined && previous.sessionId !== info.sessionId) ||
		(previous?.sessionPath !== undefined &&
			info.sessionPath !== undefined &&
			previous.sessionPath !== info.sessionPath)
	);
}

/** What a tab list (GET_TABS, TAB_LIST_CHANGED) says about who else shows a tab; absent = nobody. */
function viewerFields(info: IpcTabInfo): Pick<SessionTab, "shared" | "viewerCount"> {
	return { shared: info.shared, viewerCount: info.viewerCount };
}

/**
 * Project a main-process tab snapshot (GET_TABS entry or TAB_STATUS push) over
 * the renderer's previous entry, keeping local flags (unreadDone,
 * pendingSessionPath). A session change drops what belonged to the old session.
 */
function projectSessionTab(
	info: IpcTabStatusPayload,
	previous: SessionTab | undefined,
	sessionChanged: boolean,
	completedInBackground: boolean,
): SessionTab {
	return {
		id: info.tabId,
		cwd: info.cwd || previous?.cwd || "",
		status: info.status,
		compacting: info.compacting ?? previous?.compacting ?? false,
		kind: info.kind ?? previous?.kind ?? "agent",
		placeholder: info.placeholder ?? previous?.placeholder,
		worktree: info.worktree ?? previous?.worktree,
		device: info.device ?? previous?.device,
		title: info.title === undefined ? (sessionChanged ? undefined : previous?.title) : (info.title ?? undefined),
		sessionPath: info.sessionPath === undefined ? previous?.sessionPath : (info.sessionPath ?? undefined),
		sessionId: info.sessionId ?? (sessionChanged ? undefined : previous?.sessionId),
		unreadDone: sessionChanged ? false : completedInBackground || (previous?.unreadDone ?? false),
		pendingSessionPath: previous?.pendingSessionPath,
		awaitingInput: sessionChanged ? undefined : previous?.awaitingInput,
		...(info.awaitingConnection === true ? { awaitingConnection: true } : {}),
		...(info.scheduledRetry ? { scheduledRetry: info.scheduledRetry } : {}),
		// A status push carries no viewer fields: only a tab list (GET_TABS, TAB_LIST_CHANGED) states them.
		...(previous?.shared ? { shared: true as const } : {}),
		...(previous?.viewerCount === undefined ? {} : { viewerCount: previous.viewerCount }),
	};
}

/**
 * Hand window focus to `id` with `view` (`view.split` null = single view,
 * `view.remembered` = the splits kept off screen) and route main's
 * views to match. The previously focused pane leaves the foreground role, so
 * its overlays and live voice must not linger (voice control RPCs route to the
 * newly focused pane's sidecar).
 */
async function focusTab(previousTabId: string | null, id: string, view: SplitView, tabs: SessionTab[]): Promise<void> {
	const { split } = view;
	const version = ++switchVersion;
	beginTabRoute(previousTabId, id);
	const ui = useUiStore.getState();
	const stopLive = ui.liveOpen ? window.omp.rpc.liveStop() : null;
	ui.closeSessionOverlays();
	useForkHandoffStore.getState().closeHandoffDialog();
	useTabsStore.setState({ activeTabId: id, split, rememberedSplits: view.remembered, tabs });
	setFocusedSessionRuntime(id);
	try {
		if (stopLive) {
			const stopped = await stopLive;
			if (!stopped.success) {
				toastError({ title: translate("tabs.switchFailed"), error: stopped });
			}
		}
		const routed = await routeTabView(id, split ? splitTabIds(split) : [id], split);
		if (!routed) throw new Error(`Tab ${id} is no longer available`);
	} catch (error) {
		if (version !== switchVersion) return;
		// Routing never re-pointed: main still forwards the PREVIOUS tab's
		// events, so hydrating here would pull that sidecar's session into
		// this tab's restored stores. Surface the failure and re-converge
		// from GET_TABS — reconcile also retries SET_ACTIVE_TAB for the
		// renderer's pick, re-pointing routing when the failure was
		// transient — instead of silently diverging.
		toastError({ title: translate("tabs.switchFailed"), error });
		const converged = await useTabsStore.getState().reconcileTabs();
		if (version !== switchVersion) return;
		if (converged && useTabsStore.getState().activeTabId === id) await attachTabSession(id);
		return;
	}
	if (version !== switchVersion) return;
	settleTabRoute(id);
	// A freshly spawned sidecar can become ready on the light TAB_STATUS
	// channel before SET_ACTIVE_TAB wires its full status channel. In that
	// case no ready event will replay after routing, so hydrate from the
	// tab's latest status here. A still-starting sidecar will deliver its
	// normal full ready event after the route is attached.
	const routedTab = useTabsStore.getState().tabs.find(tab => tab.id === id);
	if (routedTab?.status === "ready" || routedTab?.status === "running") {
		sessionRuntimeStore<SessionStore>(id, "session")?.getState().setStatus("ready", routedTab.cwd);
		await attachTabSession(id);
	}
}

/**
 * Chip label for the tab strip (F-HYDRATE): session title when known, else
 * the cwd basename (both empty → the localized "New session"). Identical
 * UNTITLED labels disambiguate with a short index suffix ("gui #2") — the
 * common same-cwd parallel-tabs case. Titled tabs are never suffixed: an
 * explicit title is itself the disambiguator, and the suffix disappears as
 * soon as a title arrives.
 */
export function tabChipLabel(tab: SessionTab, tabs: readonly SessionTab[]): string {
	// `||` everywhere: empty-string titles (never-generated auto-title slot)
	// fall through like null. Worktree tabs label by their worktree NAME — the
	// cwd basename is the hash-suffixed dir (gui-<name>-<hash7>), unreadable.
	// Untitled chats are global: their internal process cwd must never masquerade
	// as a selected workspace in the tab strip.
	const untitledBase = (entry: SessionTab) =>
		entry.kind === "chat"
			? translate("sidebar.newSession")
			: entry.worktree?.name || basename(entry.cwd) || translate("sidebar.newSession");
	const base = tab.title || untitledBase(tab);
	if (tab.title) return base;
	let occurrence = 0;
	for (const entry of tabs) {
		if (entry.title) continue;
		if (untitledBase(entry) !== base) continue;
		occurrence += 1;
		if (entry.id === tab.id) break;
	}
	return occurrence > 1 ? `${base} #${occurrence}` : base;
}

/** One title contract for every surface representing a session tab. */
export function tabDisplayTitle(
	tab: SessionTab,
	tabs: readonly SessionTab[],
	indexedSession: Pick<SessionInfo, "title" | "firstMessage"> | undefined,
	untitled: string,
): string {
	return indexedSession ? sessionDisplayTitle(indexedSession, untitled) : tabChipLabel(tab, tabs);
}

/**
 * Kind of the window's active tab ("agent" default). The single read point
 * for the chat tab's no-project chrome (title, placeholder, empty state) —
 * components never re-derive kind from session state, argv, or the file.
 */
export function useActiveTabKind(): SessionKind {
	const tabId = useRuntimeTabId();
	return useTabsStore(state => state.tabs.find(tab => tab.id === (tabId ?? state.activeTabId))?.kind ?? "agent");
}

/** The calling pane's tab id while its turn waits for the internet connection (main continues it once it is back); null otherwise. */
export function useAwaitingConnection(): string | null {
	const tabId = useRuntimeTabId();
	return useTabsStore(state => {
		const tab = state.tabs.find(candidate => candidate.id === (tabId ?? state.activeTabId));
		return tab?.awaitingConnection === true ? tab.id : null;
	});
}

/** The calling pane's tab id and its scheduled retry (main re-sends the failed turn at `at`); null when none is armed. */
export function useScheduledRetry(): (IpcScheduledRetry & { tabId: string }) | null {
	const tabId = useRuntimeTabId();
	const tab = useTabsStore(state => state.tabs.find(candidate => candidate.id === (tabId ?? state.activeTabId)));
	return tab?.scheduledRetry ? { tabId: tab.id, ...tab.scheduledRetry } : null;
}

/** A closed tab whose saved session can be opened again (⌥⌘T). */
export interface ClosedTab {
	sessionPath: string;
	cwd: string;
	kind: SessionKind;
	device?: string;
	title?: string;
}

/** Closed tabs remembered for reopening, oldest dropped first. */
const CLOSED_TAB_LIMIT = 20;

export interface TabsStore {
	tabs: SessionTab[];
	activeTabId: string | null;
	/** Deprecated compatibility field for older test/setup call sites. Runtime state is no longer bundled. */
	bundles: Map<unknown, unknown>;
	split: SplitLayout | null;
	/**
	 * Splits remembered but off screen: their sessions are shown alone or in
	 * another split right now. A session is in at most one. Picking one of
	 * their sessions (sidebar, ⌘-number, overview, ⌃⇥, picker) brings the split
	 * back as it was; closing a tab drops it from its split.
	 */
	rememberedSplits: SplitLayout[];
	/** Boot reconciliation with the main-process pool: the window's initial
	 * sidecar arrives as tab 0 and must never be duplicated — entries merge by
	 * id, preserving local flags (unreadDone, pendingSessionPath). */
	reconcileTabs: () => Promise<boolean>;
	/** Spawn a new background tab (same cwd unless given) and switch to it.
	 * Returns the tabId, or null when the tab cannot be opened. `kind` is immutable once
	 * the tab's sidecar is spawned ("agent" default; "chat" = a conversation
	 * outside any project, run in the GUI's default workspace).
	 * `worktree` binds the tab to a git worktree created by a prior
	 * worktree_create RPC (cwd must be the worktree path). */
	openTab: (args?: {
		cwd?: string;
		sessionPath?: string;
		kind?: SessionKind;
		/** Full agent in the GUI-owned default Work workspace. */
		work?: boolean;
		worktree?: IpcTabWorktree;
		/** Paired host deviceId to run on; absent = this device. Without `cwd`,
		 * only a tab on the same device lends its folder. */
		device?: string;
		/** The empty start tab (`SessionTab.placeholder`): no session until its first message. */
		placeholder?: boolean;
	}) => Promise<string | null>;
	/**
	 * Focus this tab (the pick rules live in `viewAfterPick`): a pane of the
	 * visible split just takes focus; a member of a remembered split restores
	 * that split; any other session leaves the split and shows alone.
	 */
	switchTab: (id: string) => Promise<void>;
	splitTab: (id: string, placement: SplitPlacement, targetTabId?: string) => Promise<void>;
	unsplit: (keepTabId?: string) => Promise<void>;
	removePane: (tabId: string) => Promise<void>;
	setSplitRatio: (ratio: number, path?: readonly ("first" | "second")[]) => void;
	/** Close a tab (keeps ≥1). Closing the active tab activates its neighbor first. */
	closeTab: (id: string) => Promise<void>;
	/**
	 * `sessionPath` is being deleted: `tabId`, the tab showing it, closes as `closeTab` closes it (the
	 * window's last tab gives way to the empty start tab first), and the closed-tab history forgets the
	 * session. False when the tab stayed (its unsaved Files edits ask first), so nothing may be deleted.
	 */
	closeDeletedSession: (sessionPath: string, tabId: string | undefined) => Promise<boolean>;
	/** Merge a TAB_STATUS push: upsert the entry, stamp unreadDone when a
	 * background run settles (running → ready while not active). */
	applyTabStatus: (payload: IpcTabStatusPayload) => void;
	/**
	 * Apply main's tab list for this window (GET_TABS, TAB_LIST_CHANGED): a tab another window now shows
	 * (or stopped showing) changes `viewerCount`, a tab a viewer window was attached to appears, and one its
	 * owner closed leaves. `closed`: this window's own tabs main closed because their session was deleted
	 * from elsewhere (another window, a paired device); each goes as `closeDeletedSession` closes it.
	 * Otherwise it never touches this window's own tabs' order or the view.
	 */
	applyTabList: (list: readonly IpcTabInfo[], closed?: readonly string[]) => Promise<void>;
	/**
	 * An agent's view request (`AGENT_CONTROL_VIEW`): focus the tab like a sidebar pick, split it beside the
	 * focused pane like the row menu, or close it (main already got the person's approval). Waits for the
	 * tab when main has only just spawned it; a tab that never shows up is ignored.
	 */
	applyAgentView: (event: AgentControlViewEvent) => Promise<void>;
	/** Saved sessions of closed tabs, most recent last (unsaved sessions have nothing to reopen). */
	closedTabs: ClosedTab[];
	/** Reopen the most recently closed tab's session where it ran. The entry stays when the
	 * reopen fails, so the user can retry. Returns the tab id, or null. */
	reopenClosedTab: () => Promise<string | null>;
	/** Focus the tab at a 1-based strip position (⌘1…⌘8) or the last one (⌘9). */
	switchTabAt: (position: number | "last") => Promise<void>;
	/** Move a tab to a 0-based strip position (tab overview drag); main keeps the order for ⌘1…⌘9 and the saved layout. */
	moveTab: (id: string, toIndex: number) => Promise<void>;
	reset: () => void;
}

export const useTabsStore = create<TabsStore>()((set, get) => ({
	tabs: [],
	activeTabId: null,
	bundles: new Map(),
	split: null,
	rememberedSplits: [],

	reconcileTabs: async () => {
		const listed = await window.omp.tabs.list().catch(() => null);
		if (!listed) {
			// Bridge down — the tab strip simply stays as it is and TAB_STATUS
			// pushes rebuild it.
			return false;
		}
		// A tab this window is closing is gone for it even while main still lists
		// it (its release is in flight): reviving it would recreate its runtime.
		const list = listed.filter(info => !isTabClosed(info.tabId));
		// A web page keeps its own done marks across reloads (lib/unread-marks.ts); the desktop's live in memory.
		const savedMarks = webRuntime() ? readUnreadMarks() : null;
		set(state => {
			const leftovers = new Map(state.tabs.map(tab => [tab.id, tab]));
			const merged: SessionTab[] = list.map(info => {
				const existing = leftovers.get(info.tabId);
				leftovers.delete(info.tabId);
				const sessionChanged = tabSessionChanged(existing, info);
				if (sessionChanged) {
					replaceTabRuntime(info.tabId);
				}
				ensureTabRuntime(info.tabId);
				const tab: SessionTab = {
					...projectSessionTab(info, existing, sessionChanged, false),
					...viewerFields(info),
				};
				const restored =
					savedMarks !== null &&
					existing === undefined &&
					!info.active &&
					!info.visible &&
					restoredUnread(savedMarks, info.tabId, info.status === "running");
				return restored ? { ...tab, unreadDone: true } : tab;
			});
			// Entries the reply doesn't know (a spawn reply raced this reconcile)
			// survive appended at the end.
			const tabs = [...merged, ...leftovers.values()];
			const mainActiveTabId = list.find(info => info.active)?.tabId;
			const activeTabId =
				state.activeTabId && tabs.some(tab => tab.id === state.activeTabId)
					? state.activeTabId
					: mainActiveTabId && tabs.some(tab => tab.id === mainActiveTabId)
						? mainActiveTabId
						: (tabs[0]?.id ?? null);
			const mainVisible = list.filter(info => info.visible).map(info => info.tabId);
			// Main's split can still name a tab it is closing; only one whose panes are all known holds.
			const restoredSplit =
				list.find(info => info.split && splitTabIds(info.split).every(id => tabs.some(tab => tab.id === id)))
					?.split ?? null;
			const split =
				restoredSplit ??
				(state.split && splitTabIds(state.split).every(id => mainVisible.includes(id)) ? state.split : null);
			// Main's remembered splits win; without any, what this window already
			// remembers stays (a failed route converges here), minus closed tabs.
			const claimed = new Set(visibleTabIds({ activeTabId, split }));
			const fromMain = list.flatMap(info => (info.rememberedSplit ? [info.rememberedSplit] : []));
			const rememberedSplits = readRememberedSplits(
				fromMain.length > 0 ? fromMain : state.rememberedSplits,
				id => (tabs.some(tab => tab.id === id) ? id : null),
				claimed,
			);
			mainRemembersSplits = fromMain.length > 0;
			return { tabs, activeTabId, split, rememberedSplits };
		});
		for (const tab of get().tabs) watchTabAwaitingInput(tab.id);
		const activeTabId = get().activeTabId;
		setFocusedSessionRuntime(activeTabId);
		if (activeTabId) {
			try {
				const routed = await routeTabView(activeTabId, visibleTabIds(get()), get().split);
				reconcileTabRoute(activeTabId, routed);
				return routed;
			} catch {
				reconcileTabRoute(activeTabId, false);
				return false;
			}
		}
		return true;
	},

	openTab: async args => {
		const activeTab = get().tabs.find(tab => tab.id === get().activeTabId);
		const device = args?.device;
		// The focused tab's folder only means something on its own device.
		const inheritCwd = activeTab?.device === device;
		const runtimeCwd = sessionRuntimeStore<SessionStore>(get().activeTabId, "session")?.getState().cwd;
		// A `worktree.onStart` worktree belongs to its tab's session: a new tab
		// starts from the checkout it was forked from (and gets its own worktree).
		const lifecycleSource = activeTab?.worktree?.lifecycle ? activeTab.worktree.baseCwd : undefined;
		const cwd =
			args?.cwd ??
			(inheritCwd ? lifecycleSource || runtimeCwd || activeTab?.cwd || useSessionStore.getState().cwd : "");
		const kind = args?.kind ?? "agent";
		let result: IpcSpawnTabResult | null;
		try {
			result = await window.omp.tabs.spawn({
				// Work and chat tabs run in the default workspace main picks.
				cwd: args?.work || kind === "chat" ? undefined : cwd || undefined,
				sessionPath: args?.sessionPath,
				kind,
				...(args?.work ? { defaultWorkspace: true } : {}),
				...(args?.placeholder ? { placeholder: true } : {}),
				worktree: args?.worktree,
				...(device === undefined ? {} : { device }),
			});
		} catch (error) {
			toastError({ title: translate("tabs.newFailed"), error });
			return null;
		}
		if (!result) {
			toast({ variant: "error", message: translate("tabs.newFailed") });
			return null;
		}
		// Cross-kind refusal: the target session file carries a different kind —
		// no conversion path exists (I2), so surface it and stay put.
		if (result.tabId === null && result.refusal === "kind-mismatch") {
			toast({ variant: "error", title: translate("tabs.newFailed"), message: translate("tabs.kindMismatch") });
			return null;
		}
		// F-OWN belt guard: the session file is already attached to a tab, so
		// main refused the double-attach. Owner lives in THIS window → switch
		// to it; a foreign window's tab → focus that window (main focuses the
		// owner window for an owned sessionPath instead of spawning).
		if (result.tabId === null) {
			const ownerTabId = result.ownerTabId ?? null;
			if (ownerTabId && get().tabs.some(tab => tab.id === ownerTabId)) {
				await get().switchTab(ownerTabId);
				return ownerTabId;
			}
			if (args?.sessionPath) {
				try {
					await window.omp.sessions.openInNewWindow({
						sessionPath: args.sessionPath,
						...(device === undefined ? {} : { device }),
					});
				} catch {
					// Best-effort focus — the owner window may be mid-teardown.
				}
			}
			return ownerTabId;
		}
		const { tabId } = result;
		ensureTabRuntime(tabId);
		const resolvedCwd = result.cwd ?? cwd;
		// Attached as a viewer of a session another window holds: the tab is already running there, so its
		// status, title and viewers come from the list rather than from a first ready push that never comes.
		if (result.attached) await get().reconcileTabs();
		set(state => {
			const existing = state.tabs.find(tab => tab.id === tabId);
			if (existing) {
				if (!args?.sessionPath || existing.pendingSessionPath === args.sessionPath) return state;
				return {
					tabs: state.tabs.map(tab =>
						tab.id === tabId
							? { ...tab, sessionPath: args.sessionPath, pendingSessionPath: args.sessionPath }
							: tab,
					),
				};
			}
			const tab: SessionTab = {
				id: tabId,
				cwd: resolvedCwd,
				status: "starting",
				kind,
				placeholder: args?.placeholder === true,
				worktree: args?.worktree,
				device,
				unreadDone: false,
				sessionPath: args?.sessionPath,
				pendingSessionPath: args?.sessionPath,
			};
			return { tabs: [...state.tabs, tab] };
		});
		await get().switchTab(tabId);
		return tabId;
	},

	switchTab: async id => {
		const before = get();
		if (id === before.activeTabId) return;
		const target = before.tabs.find(tab => tab.id === id);
		if (!target) return;
		ensureTabRuntime(id);
		const request = ++switchRequest;
		// Main forwards session events only for visible tabs, so a tab that ran out of view
		// still holds the moment it was left. Fetch its present before it paints (one short
		// wait at most): the run shows where it is, not its old step and then a jump.
		let early: Promise<void> | undefined;
		if (
			!visibleTabIds(before).includes(id) &&
			(target.status === "running" || sessionRuntimeStore<SessionStore>(id, "session")?.getState().isStreaming)
		) {
			let landed = false;
			const { promise: waited, resolve: stopWaiting } = Promise.withResolvers<void>();
			const cap = setTimeout(stopWaiting, RETURN_HYDRATION_WAIT_MS);
			const hydration = hydrateTabSession(id).then(
				() => {
					landed = true;
				},
				() => undefined,
			);
			void hydration.then(stopWaiting);
			await waited;
			clearTimeout(cap);
			const now = get();
			// A geometry change (a divider drag, a ratio step) rebuilds `split` without changing what it shows:
			// only a newer pick or a change of the panes on screen supersedes this one.
			const panes = (state: TabsStore) => (state.split ? splitTabIds(state.split).join("\n") : "");
			if (request !== switchRequest || now.activeTabId !== before.activeTabId || panes(now) !== panes(before))
				return;
			if (!landed) early = hydration;
		}
		const state = get();
		const outgoingStreaming = useSessionStore.getState().isStreaming;
		await focusTab(
			state.activeTabId,
			id,
			viewAfterPick({ split: state.split, remembered: state.rememberedSplits }, id),
			state.tabs.map(tab => {
				if (tab.id === id) return { ...tab, unreadDone: false };
				return tab.id === state.activeTabId && outgoingStreaming ? { ...tab, status: "running" } : tab;
			}),
		);
		// A fetch still in flight when the route attached began before it: events in between
		// never reached this tab, and the route's attach joined that fetch instead of starting one.
		if (early && get().activeTabId === id) await hydrateTabSession(id);
	},

	splitTab: async (id, placement, targetTabId) => {
		const state = get();
		const activeTabId = state.activeTabId;
		const target = targetTabId ?? activeTabId;
		if (!activeTabId || !target || id === target || !state.tabs.some(tab => tab.id === id)) return;
		if (state.split && splitTabIds(state.split).includes(id)) return;
		if (!visibleTabIds(state).includes(target)) return;
		ensureTabRuntime(id);
		const split = state.split
			? asSplitLayout(
					mapSplitLeaves(state.split, tabId =>
						tabId !== target
							? { tabId }
							: splitTabIds(state.split!).length >= maxSplitPanes()
								? { tabId: id }
								: splitForPlacement(tabId, id, placement),
					),
				)!
			: splitForPlacement(target, id, placement);
		// The dropped session joins this split, so it leaves the one it was remembered in.
		await focusTab(
			activeTabId,
			id,
			{ split, remembered: forgetSplitTab(state.rememberedSplits, id) },
			state.tabs.map(tab => (tab.id === id ? { ...tab, unreadDone: false } : tab)),
		);
	},

	removePane: async tabId => {
		const state = get();
		if (!state.split || !splitTabIds(state.split).includes(tabId)) return;
		const remaining = mapSplitLeaves(state.split, id => (id === tabId ? null : { tabId: id }));
		if (!remaining) return;
		const ids = splitTabIds(remaining);
		const focused = state.activeTabId && ids.includes(state.activeTabId) ? state.activeTabId : ids[0];
		const split = asSplitLayout(remaining);
		set({ split });
		if (focused !== state.activeTabId) {
			await get().switchTab(focused);
			return;
		}
		try {
			const routed = await routeTabView(focused, ids, split);
			if (!routed) throw new Error(`Tab ${focused} is no longer available`);
		} catch (error) {
			// The window already shows the smaller split; take main's view back so
			// the pane's tab is not left in no pane.
			toastError({ title: translate("tabs.switchFailed"), error });
			await get().reconcileTabs();
		}
	},

	unsplit: async keepTabId => {
		const state = get();
		const tabId = keepTabId && state.tabs.some(tab => tab.id === keepTabId) ? keepTabId : state.activeTabId;
		if (!tabId) return;
		const version = ++switchVersion;
		if (state.activeTabId !== tabId) beginTabRoute(state.activeTabId, tabId);
		set({ split: null, activeTabId: tabId });
		setFocusedSessionRuntime(tabId);
		try {
			const routed = await routeTabView(tabId, [tabId]);
			if (!routed) throw new Error(`Tab ${tabId} is no longer available`);
			if (version !== switchVersion) return;
			if (state.activeTabId !== tabId) settleTabRoute(tabId);
		} catch (error) {
			if (version !== switchVersion) return;
			toastError({ title: translate("tabs.switchFailed"), error });
			await get().reconcileTabs();
		}
	},

	setSplitRatio: (ratio, path = []) => {
		const state = get();
		if (!state.split || !state.activeTabId) return;
		const split = updateSplitRatio(state.split, path, ratio);
		set({ split });
		// Debounce: keyboard stepping fires per keystroke and each routed view
		// change lands in main's layout persistence. Main only needs the settled
		// geometry, so flush the latest ratio after a short quiet window.
		if (ratioFlushTimer) clearTimeout(ratioFlushTimer);
		ratioFlushTimer = setTimeout(() => {
			ratioFlushTimer = null;
			const current = get();
			if (!current.split || !current.activeTabId) return;
			void routeTabView(current.activeTabId, splitTabIds(current.split), current.split).catch(() => {
				// Stale ratio flush (window closing, tab gone) — the next
				// reconcile re-converges the real view state.
			});
		}, 250);
	},

	closeTab: async id => {
		const state = get();
		if (state.tabs.length <= 1) return;
		const index = state.tabs.findIndex(tab => tab.id === id);
		if (index === -1) return;
		// Unsaved Files edits belong to this tab: closing it would drop them, so the editor's discard confirm asks first
		// and the side panel closes the tab once the user agrees.
		const ui = useUiStore.getState();
		if (ui.fileEditDirty && ui.fileEditTabId === id) {
			ui.holdTabClose(id);
			return;
		}
		if (state.split && splitTabIds(state.split).includes(id)) {
			await get().removePane(id);
		} else if (id === state.activeTabId) {
			// Activate a neighbor BEFORE releasing — main's routing needs a live
			// target and the window keeps painting a real session. Prefer the
			// right neighbor (it shifts into the closed slot), else the left.
			const neighbor = state.tabs[index + 1] ?? state.tabs[index - 1];
			if (neighbor) await get().switchTab(neighbor.id);
		}
		const closed = state.tabs[index];
		set(current => {
			const closedTabs = closed?.sessionPath
				? [
						...current.closedTabs.filter(entry => entry.sessionPath !== closed.sessionPath),
						{
							sessionPath: closed.sessionPath,
							cwd: closed.cwd,
							kind: closed.kind,
							...(closed.device === undefined ? {} : { device: closed.device }),
							...(closed.title ? { title: closed.title } : {}),
						},
					].slice(-CLOSED_TAB_LIMIT)
				: current.closedTabs;
			return {
				tabs: current.tabs.filter(tab => tab.id !== id),
				rememberedSplits: forgetSplitTab(current.rememberedSplits, id),
				closedTabs,
			};
		});
		closedTabIds.add(id);
		let failure: unknown = null;
		let refused = false;
		try {
			refused = !(await window.omp.tabs.close(id));
			if (refused) failure = new Error(`Tab ${id} was not released`);
		} catch (error) {
			failure = error;
		}
		if (failure !== null) {
			// Main may still hold the tab and its sidecar: let the next list show it again instead of leaving a
			// live session nobody can see. Its runtime stayed, so it comes back with its asks, draft and
			// transcript. A tab main answers `false` for and no longer lists was already gone.
			closedTabIds.delete(id);
			await get().reconcileTabs();
			if (refused && !get().tabs.some(tab => tab.id === id)) {
				closedTabIds.add(id);
				deleteSessionRuntime(id);
				return;
			}
			if (closed?.sessionPath)
				set(current => ({
					closedTabs: current.closedTabs.filter(entry => entry.sessionPath !== closed.sessionPath),
				}));
			toastError({ title: translate("tabs.closeFailed"), error: failure });
			return;
		}
		deleteSessionRuntime(id);
		// A failed removePane left main's split in view; its next list no longer names this tab.
		const { split } = get();
		if (split && splitTabIds(split).includes(id)) await get().reconcileTabs();
	},

	closeDeletedSession: async (sessionPath, tabId) => {
		const tab = tabId ? get().tabs.find(entry => entry.id === tabId) : undefined;
		if (tab) {
			// Leaving already: the start tab opened next must not read it as company and give way at once.
			closedTabIds.add(tab.id);
			// The window keeps a tab: its last one gives way to the empty start tab, which is no session
			// until its first message.
			if (get().tabs.length === 1 && (await get().openTab({ work: true, placeholder: true })) === null) {
				closedTabIds.delete(tab.id);
				return false;
			}
			await get().closeTab(tab.id);
			if (get().tabs.some(entry => entry.id === tab.id)) {
				closedTabIds.delete(tab.id);
				return false;
			}
		}
		set(current => ({ closedTabs: current.closedTabs.filter(entry => entry.sessionPath !== sessionPath) }));
		return true;
	},

	closedTabs: [],

	reopenClosedTab: async () => {
		const entry = get().closedTabs.at(-1);
		if (!entry) {
			toast({ variant: "info", message: translate("tabs.reopenNone") });
			return null;
		}
		const tabId = await get().openTab({
			cwd: entry.cwd || undefined,
			sessionPath: entry.sessionPath,
			kind: entry.kind,
			...(entry.device === undefined ? {} : { device: entry.device }),
		});
		if (tabId !== null)
			set(current => ({ closedTabs: current.closedTabs.filter(item => item.sessionPath !== entry.sessionPath) }));
		return tabId;
	},

	moveTab: async (id, toIndex) => {
		const previous = get().tabs;
		const from = previous.findIndex(tab => tab.id === id);
		const to = Math.max(0, Math.min(previous.length - 1, toIndex));
		if (from < 0 || from === to) return;
		const tabs = [...previous];
		const [moved] = tabs.splice(from, 1);
		if (!moved) return;
		tabs.splice(to, 0, moved);
		set({ tabs });
		// Main refuses an order that no longer names exactly this window's tabs
		// (one opened or closed meanwhile); the next list reconciles either way.
		const saved = await window.omp.tabs.reorder(tabs.map(tab => tab.id)).catch(() => false);
		if (!saved) toastError({ title: translate("tabs.reorderFailed"), error: new Error("tab order refused") });
	},

	switchTabAt: async position => {
		const { tabs } = get();
		const target = position === "last" ? tabs.at(-1) : tabs[position - 1];
		if (target) await get().switchTab(target.id);
	},

	applyTabStatus: payload => {
		if (isTabClosed(payload.tabId)) return;
		const state = get();
		const active = state.activeTabId === payload.tabId;
		const previous = state.tabs.find(tab => tab.id === payload.tabId);
		if (payload.status === "starting" || payload.status === "restarting") {
			ensureTabRuntime(payload.tabId).recovering = true;
			supersedeTabHydration(payload.tabId);
		}
		const sessionChanged = tabSessionChanged(previous, payload);
		// Rebuild the runtime OUTSIDE the set() updater (deleteSessionRuntime
		// synchronously fires focus listeners), and immediately re-point focus at
		// the fresh runtime — otherwise static store access falls through to the
		// module-level default stores until the next switch/reconcile.
		if (sessionChanged) {
			replaceTabRuntime(payload.tabId);
			if (active) setFocusedSessionRuntime(payload.tabId);
		}
		// A background tab's run settled → done badge until the user visits, and
		// the run-end notification its unforwarded agent_end would have raised.
		const completedInBackground =
			!visibleTabIds(state).includes(payload.tabId) && previous?.status === "running" && payload.status === "ready";
		set(current => {
			const index = current.tabs.findIndex(tab => tab.id === payload.tabId);
			const next = projectSessionTab(payload, previous, sessionChanged, completedInBackground);
			if (index === -1) return { tabs: [...current.tabs, next] };
			const tabs = [...current.tabs];
			tabs[index] = next;
			return { tabs };
		});
		watchTabAwaitingInput(payload.tabId);
		const session = sessionRuntimeStore<SessionStore>(payload.tabId, "session");
		if (sessionChanged && (payload.status === "ready" || payload.status === "running")) {
			void attachTabSession(payload.tabId);
		}
		// The end events that clear the retry/compaction rows and the retry gate
		// only reach a visible tab; main's view of the run is authoritative.
		const running = payload.status === "running";
		const compacting = payload.compacting === true;
		if (!running) resetRetryPending(payload.tabId);
		const settled = {
			...(running ? {} : { retryInfo: null }),
			...(compacting ? {} : { compactionInfo: null }),
		};
		if (session) {
			session.getState().setStatus(payload.status === "running" ? "ready" : payload.status, payload.cwd);
			session.setState({
				isStreaming: running,
				isCompacting: payload.compacting ?? session.getState().isCompacting,
				...settled,
			});
		} else if (active) {
			useSessionStore.getState().setStatus(payload.status === "running" ? "ready" : payload.status, payload.cwd);
			useSessionStore.setState({ isStreaming: running, ...settled });
		}
		if (completedInBackground && payload.lastRun) notifyRunEnd(payload.tabId, payload.lastRun);
	},

	applyTabList: async (list, closed) => {
		for (const id of closed ?? []) {
			const tab = get().tabs.find(entry => entry.id === id);
			if (tab && !tab.shared) await get().closeDeletedSession(tab.sessionPath ?? "", id);
		}
		const known = new Map(get().tabs.map(tab => [tab.id, tab]));
		const unseen = list.some(info => !known.has(info.tabId) && !isTabClosed(info.tabId));
		if (unseen) {
			await get().reconcileTabs();
		} else {
			const byId = new Map(list.map(info => [info.tabId, info]));
			set(state => {
				let changed = false;
				const tabs = state.tabs.map(tab => {
					const info = byId.get(tab.id);
					if (!info) return tab;
					const next = { ...tab, ...viewerFields(info) };
					if (!info.shared) delete next.shared;
					if (info.viewerCount === undefined) delete next.viewerCount;
					if (next.shared === tab.shared && next.viewerCount === tab.viewerCount) return tab;
					changed = true;
					return next;
				});
				return changed ? { tabs } : state;
			});
		}
		// A tab another window owned and closed is gone for this viewer too.
		const listed = new Set(list.map(info => info.tabId));
		for (const tab of get().tabs) {
			if (tab.shared && !listed.has(tab.id)) await get().closeTab(tab.id);
		}
	},

	applyAgentView: async ({ tabId, how }) => {
		// Main announces a tab it just spawned (TAB_LIST_CHANGED) and then asks to show it; the list may not
		// have been applied yet, so an unknown tab is reconciled first. Still unknown afterwards: nothing to show.
		if (!get().tabs.some(tab => tab.id === tabId)) await get().reconcileTabs();
		const known = get().tabs.some(tab => tab.id === tabId);
		if (!known || isTabClosed(tabId)) return;
		if (how === "close") {
			await get().closeTab(tabId);
			return;
		}
		useUiStore.getState().closeDestination();
		if (how === "focus" || visibleTabIds(get()).includes(tabId)) {
			await get().switchTab(tabId);
			return;
		}
		await get().splitTab(tabId, how === "split-right" ? "right" : "bottom");
	},

	reset: () => {
		switchVersion += 1;
		if (ratioFlushTimer) {
			clearTimeout(ratioFlushTimer);
			ratioFlushTimer = null;
		}
		for (const tab of get().tabs) deleteSessionRuntime(tab.id);
		closedTabIds.clear();
		setFocusedSessionRuntime(null);
		resetTabRoute();
		mainRemembersSplits = false;
		set({
			tabs: [],
			activeTabId: null,
			bundles: new Map(),
			split: null,
			rememberedSplits: [],
			closedTabs: [],
		});
	},
}));

// A run starting in any tab — background ones included, whose agent_start never
// reaches the renderer — makes that session's remembered suggestion stale. It lives
// here, not in stores/next-prompt.ts, which use-rpc-events (imported by this file) loads.
useTabsStore.subscribe((next, previous) => {
	if (next.tabs === previous.tabs) return;
	for (const tab of next.tabs) {
		if (tab.status !== "running") continue;
		if (previous.tabs.find(prior => prior.id === tab.id)?.status === "running") continue;
		useNextPromptStore.getState().clear(tab.sessionPath, tab.sessionId);
	}
});

// A web page's own done marks and running tabs, kept for the next load (lib/unread-marks.ts).
useTabsStore.subscribe((next, previous) => {
	if (next.tabs === previous.tabs || !webRuntime()) return;
	writeUnreadMarks({
		unread: next.tabs.filter(tab => tab.unreadDone).map(tab => tab.id),
		running: next.tabs.filter(tab => tab.status === "running").map(tab => tab.id),
	});
});

// A tab other windows show too: its messages store claims a local echo only by its own text, because
// another viewer's prompt can be delivered first (stores/messages.ts). A replaced runtime starts unshared,
// so every change of the list re-states the flag for every tab.
useTabsStore.subscribe((next, previous) => {
	if (next.tabs === previous.tabs) return;
	for (const tab of next.tabs) {
		sessionRuntimeStore<MessagesStore>(tab.id, "messages")
			?.getState()
			.setSharedTab(tab.shared === true || (tab.viewerCount ?? 0) > 0);
	}
});

/** Route an extension UI frame into the tab that raised it. Blocking dialogs,
 * status text, and widgets disappear while that tab is parked and return with
 * it; a late IPC delivery can never leak into the newly selected tab. A request
 * sent again (a paired host's re-attach re-sends every open ask) while its card
 * is still up is not doubled.
 *
 * One door for live frames and for what a reloaded page or a re-attach hands
 * back: a request main marks as a provider sign-in's own (`signIn`) never becomes
 * a chat card. While its `login` still runs it goes to the login store and the
 * panel takes the sign-in over; once `login` has answered it is a leftover, answered
 * `cancelled` (stock never closes its code paste) like the panel does. */
export function pushTabExtensionUiRequest(
	tabId: string,
	request: ExtensionUIRequest,
	signIn?: IpcSignIn,
	answeredElsewhere?: boolean,
): void {
	// A request arriving after the tab closed must not resurrect a ghost runtime.
	if (isTabClosed(tabId)) return;
	ensureTabRuntime(tabId);
	const store = sessionRuntimeStore<ExtensionUiStore>(tabId, "extensionUi");
	const state = store?.getState();
	// The synthetic cancel of a card another window answered first: the card closes, and the reader is told why
	// (only when this window still showed it: its own answer closes it first).
	if (answeredElsewhere && request.method === "cancel") {
		if (state?.pendingRequests.some(pending => pending.id === request.targetId)) {
			toast({ variant: "info", message: translate("extDialog.answeredElsewhere") });
		}
		state?.removeRequest(request.targetId);
		watchTabAwaitingInput(tabId);
		return;
	}
	if (!state || state.pendingRequests.some(pending => pending.id === request.id)) return;
	if (!signIn) state.pushRequest(request);
	else if (signIn.active) {
		state.adoptLogin(signIn);
		state.restoreLoginRequest(request);
	} else {
		answerLeftoverSignIn(tabId, request);
		return;
	}
	watchTabAwaitingInput(tabId);
}

/** The panel's answers to what a finished sign-in left open: the code paste is cancelled, the page acknowledged. */
function answerLeftoverSignIn(tabId: string, request: ExtensionUIRequest): void {
	const answer =
		request.method === "input"
			? { cancelled: true as const }
			: request.method === "open_url"
				? { value: "done" }
				: null;
	if (!answer) return;
	// A refused answer leaves the route in main, which asks again at the next restore.
	const response = { type: "extension_ui_response" as const, id: request.id, ...answer };
	void Promise.resolve(window.omp.ui.respondExtensionUi(response, tabId)).catch(() => {});
}

/** Main answered a tab's last `login` while this page showed it as adopted (`adoptLogin`): it is over, and its leftovers are answered. */
export function endTabSignIn(tabId: string, error?: string | null): void {
	const state = sessionRuntimeStore<ExtensionUiStore>(tabId, "extensionUi")?.getState();
	for (const request of state?.settleAdoptedLogin(error) ?? []) answerLeftoverSignIn(tabId, request);
}

/** Show again the asks and approvals a reloaded page missed: main still holds them, and answering reaches the omp that raised them. A live frame that got here first is not doubled. */
export function restoreTabExtensionUiRequests(open: readonly IpcOpenExtensionRequest[]): void {
	for (const { tabId, request, signIn } of open) pushTabExtensionUiRequest(tabId, request, signIn);
}

/** Runtimes whose extension-UI and plan stores already feed their tab's `awaitingInput`. */
const watchedRuntimes = new WeakSet<SessionRuntime>();

/**
 * Mirror "this tab's session blocks on the user" (a response-bearing extension
 * request or a plan proposal) onto its tab entry, so the sidebar and tab
 * signals flag background tabs too, whose dialogs are parked in their own
 * runtime until shown. Subscribes once per runtime (a replaced runtime is
 * watched afresh) and re-syncs on every call, since the tab entry can appear
 * after its runtime did.
 */
function watchTabAwaitingInput(tabId: string): void {
	const runtime = sessionRuntime(tabId);
	const extensionUi = sessionRuntimeStore<ExtensionUiStore>(tabId, "extensionUi");
	const plan = sessionRuntimeStore<PlanApprovalStore>(tabId, "planApproval");
	if (!runtime || !extensionUi || !plan) return;
	const sync = () => {
		if (sessionRuntime(tabId) !== runtime) return;
		const awaiting =
			awaitedInput(extensionUi.getState()) ?? (plan.getState().pending !== null ? "approval" : undefined);
		useTabsStore.setState(state => {
			const tab = state.tabs.find(entry => entry.id === tabId);
			if (!tab || tab.awaitingInput === awaiting) return state;
			return { tabs: state.tabs.map(entry => (entry.id === tabId ? { ...entry, awaitingInput: awaiting } : entry)) };
		});
	};
	if (!watchedRuntimes.has(runtime)) {
		watchedRuntimes.add(runtime);
		extensionUi.subscribe(sync);
		plan.subscribe(sync);
	}
	sync();
}

/** Restore a failed submit to the tab that issued it, even when that tab is now
 * parked in the background. A response from one sidecar must never inject its
 * draft or attachments into whichever tab happens to be visible later. */
export function restoreTabComposer(
	tabId: string | null,
	sessionId: string,
	draft: string,
	images: ComposerImage[],
	originComposer?: StoreApi<ComposerStore>,
): void {
	if (!tabId) return;
	const prependDraft = (current: string): string => (current ? `${draft}\n${current}` : draft);
	const session = sessionRuntimeStore<SessionStore>(tabId, "session");
	const composer = sessionRuntimeStore<ComposerStore>(tabId, "composer");
	if (!session || !composer) {
		if (useTabsStore.getState().activeTabId !== tabId || useSessionStore.getState().sessionId !== sessionId) return;
		useComposerStore.setState(current => ({
			draft: prependDraft(current.draft),
			images: [...images, ...current.images],
		}));
		return;
	}
	if (originComposer ? composer !== originComposer : session.getState().sessionId !== sessionId) return;
	composer.setState(current => ({
		draft: prependDraft(current.draft),
		images: [...images, ...current.images],
	}));
}

/** Finish a plan-approval request in the tab that issued it. The response may
 * arrive after the user switched elsewhere, so both the proposal UI and the
 * plan-mode flag are updated in that tab's parked bundle instead of whichever
 * session happens to be visible. */
export function settleTabPlanApproval(
	tabId: string | null,
	sessionId: string,
	target: PendingPlanProposal,
	result: {
		clear?: boolean;
		notice?: string | null;
		submitting?: PlanApprovalSubmitState | null;
		exitPlanMode?: boolean;
	},
): void {
	const resolvedTabId = tabId ?? useTabsStore.getState().activeTabId;
	const session = sessionRuntimeStore<SessionStore>(resolvedTabId, "session");
	const planStore = sessionRuntimeStore<PlanApprovalStore>(resolvedTabId, "planApproval");
	if (!session || !planStore) {
		if (
			useTabsStore.getState().activeTabId !== resolvedTabId ||
			useSessionStore.getState().sessionId !== sessionId ||
			usePlanApprovalStore.getState().pending !== target
		)
			return;
		usePlanApprovalStore.setState(state => ({
			pending: result.clear ? null : target,
			feedback: result.clear ? "" : state.feedback,
			notice: result.clear ? null : result.notice === undefined ? state.notice : result.notice,
			submitting: result.clear ? null : result.submitting === undefined ? state.submitting : result.submitting,
		}));
		if (result.exitPlanMode) useSessionStore.setState({ planModeEnabled: false });
		return;
	}
	if (session.getState().sessionId !== sessionId) return;
	const plan = planStore.getState();
	if (plan.pending !== target) return;
	planStore.setState({
		pending: result.clear ? null : target,
		feedback: result.clear ? "" : plan.feedback,
		notice: result.clear ? null : result.notice === undefined ? plan.notice : result.notice,
		submitting: result.clear ? null : result.submitting === undefined ? plan.submitting : result.submitting,
	});
	if (result.exitPlanMode) session.setState({ planModeEnabled: false });
}

/**
 * Boot wiring for session tabs: GET_TABS reconciliation (the window's initial
 * sidecar arrives as tab 0) plus the TAB_STATUS subscription. Also completes
 * the open-in-new-tab flow: when a tab spawned with a sessionPath first
 * reports ready while active, switch its sidecar to that session and hydrate.
 * Call once in App.tsx alongside useRpcEvents().
 */
export function useSessionTabs(): void {
	useEffect(() => {
		void useTabsStore
			.getState()
			.reconcileTabs()
			.then(converged => {
				if (!converged) return;
				// A restored sidecar can already be ready before either renderer
				// subscription attaches. GET_TABS is the durable boot snapshot, so
				// use it as the final hydration fallback after the active route has
				// converged. Session metadata can arrive before the transcript, so
				// an existing session id cannot prove that history was restored.
				setTimeout(() => {
					const state = useTabsStore.getState();
					for (const tabId of visibleTabIds(state)) {
						const tab = state.tabs.find(entry => entry.id === tabId);
						const session = sessionRuntimeStore<SessionStore>(tabId, "session");
						if (!tab || !session) continue;
						// A tab waiting for omp (machine setup installs it) can report that before any subscription
						// exists too; the setup screen keys on it, and nothing reads it as a failure.
						if (tab.status === "waiting") {
							session.getState().setStatus("waiting", tab.cwd);
							continue;
						}
						if (tab.status === "error" || tab.status === "exited") {
							// A launch failure (e.g. omp missing or too old) can fire before any
							// subscription exists; the status snapshot still carries its reason.
							session.getState().setStatus(tab.status, tab.cwd);
							if (tabId !== state.activeTabId) continue;
							void window.omp.sidecar.getStatus().then(status => {
								if (status.status !== "error" && status.status !== "exited") return;
								useSessionStore
									.getState()
									.setSidecarError(
										status.message ?? translate("events.sidecarProcessFailed"),
										status.restart ?? null,
									);
							});
							continue;
						}
						if (tab.status !== "ready" && tab.status !== "running") continue;
						session.getState().setStatus("ready", tab.cwd);
						void attachTabSession(tabId);
					}
				}, 0);
			});
		const subscribe = window.omp.events.onTabStatus;
		if (typeof subscribe !== "function") return;
		const offList =
			typeof window.omp.events.onTabListChanged === "function"
				? window.omp.events.onTabListChanged(
						payload => void useTabsStore.getState().applyTabList(payload.tabs, payload.closed),
					)
				: undefined;
		const offView =
			typeof window.omp.events.onAgentControlView === "function"
				? window.omp.events.onAgentControlView(event => void useTabsStore.getState().applyAgentView(event))
				: undefined;
		const offStatus = subscribe.call(window.omp.events, payload => {
			const previousStatus = useTabsStore.getState().tabs.find(entry => entry.id === payload.tabId)?.status;
			useTabsStore.getState().applyTabStatus(payload);
			if (payload.status !== "ready") return;
			const state = useTabsStore.getState();
			const tab = state.tabs.find(entry => entry.id === payload.tabId);
			if (visibleTabIds(state).includes(payload.tabId)) {
				const runtime = ensureTabRuntime(payload.tabId);
				void runtime.command({ type: "set_subagent_subscription", level: "progress" });
				if (!tab?.pendingSessionPath && previousStatus !== "ready" && previousStatus !== "running") {
					// Light TAB_STATUS is registered before the full active-tab channel.
					// If ready raced SET_ACTIVE_TAB, the full ready event was already
					// missed. Restore history on the connection transition, including
					// when metadata arrived first; idle metadata and run-end updates
					// do not need another transcript fetch.
					setTimeout(() => {
						if (!visibleTabIds(useTabsStore.getState()).includes(payload.tabId)) return;
						void attachTabSession(payload.tabId);
					}, 0);
				}
			}
			if (!tab?.pendingSessionPath || !visibleTabIds(state).includes(tab.id)) return;
			// Clear before the RPC so a duplicate ready push can't re-enter.
			const sessionPath = tab.pendingSessionPath;
			useTabsStore.setState(current => ({
				tabs: current.tabs.map(entry =>
					entry.id === tab.id ? { ...entry, pendingSessionPath: undefined } : entry,
				),
			}));
			void (async () => {
				// A sidecar spawned WITH --session is already on the pending
				// session by the time it reports ready: switching again would
				// abort the in-flight resume. Gate on get_state and only switch
				// when the sidecar's sessionFile differs (a failed read keeps
				// the old behavior — switch unconditionally).
				const runtime = ensureTabRuntime(tab.id);
				const currentState = await runtime.command({ type: "get_state" });
				const currentFile =
					currentState.success && currentState.data != null
						? (currentState.data as RpcSessionState).sessionFile
						: undefined;
				if (currentFile !== sessionPath) {
					const response = await runtime.command({ type: "switch_session", sessionPath });
					if (!response.success) {
						toastError({ title: translate("sidebar.openFailed"), error: response });
						return;
					}
				}
				// The sidecar may just have switched sessions: never join a fetch started before it.
				await hydrateTabSession(tab.id);
			})();
		});
		return () => {
			offStatus();
			offList?.();
			offView?.();
		};
	}, []);
}
