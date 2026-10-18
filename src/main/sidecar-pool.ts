/**
 * Pool of per-tab sidecar processes, with no limit on their number.
 *
 * Each TAB owns one sidecar (a local SidecarManager, or a RemoteSidecar for a
 * tab on a paired host); a window holds N tabs. The pool wires each sidecar's
 * events to its owning window, and releases the sidecar (listeners first,
 * then dispose) when its tab closes or its window closes.
 *
 * Event routing: the full event channels (events batch, status, subagent,
 * live, commands, config, prompt result, command output, session info,
 * extension error, host tool/uri) forward from at most four VISIBLE tabs.
 * One of them is focused for untargeted commands. Every tab (visible or
 * background) additionally pushes the light TAB_STATUS channel, so background
 * tabs report status flips, run outcomes, and session title/id changes, and
 * forwards its extension UI requests (a background ask still needs an answer).
 * A hidden tab also forwards the two frames its sidebar row reads from its own
 * runtime: plan proposals (the row asks for approval) and subagent lifecycle
 * (the row's live subagent count), so the row is current without a visit.
 *
 * Multi-viewer: besides its owner, a tab can be shown by viewer windows (a
 * paired web device's; `attachViewer`). Each window keeps its own view (active,
 * visible, split), the tab's sidecar listeners exist once and fan out to every
 * window that shows it, and everything the light channel carries goes to the
 * owner and every viewer. A viewer leaving never touches the sidecar; the owner
 * closing the tab releases it for all. The first window to answer an ask or
 * approval wins: the others' cards close through a synthetic `cancel`, and a
 * late answer from one of them is refused (`already_answered`). Electron
 * windows never view each other's tabs, so with no viewer everything above is
 * the single-window routing.
 *
 * F-OWN (double-attach guard): `#sessionOwners` maps a session file to the
 * tab/window attached to it, registered at acquire (spawn-with-sessionPath),
 * from the RPC passthrough (switch_session success) and from every get_state
 * the sidecar answers (its `session` event — the only main-observable
 * carriers of the file path), and dropped on release or when
 * session_info_update reports a sessionId change (the cached file is stale;
 * the renderer's hydrate re-registers the current one). The key is the
 * device plus the path: a paired host's `~/.omp` layout mirrors this one, so
 * the same path on two machines names two different files.
 *
 * F-UI-ORIGIN (response routing): extension_ui requests raised by a tab are
 * recorded by request id → owning entry, so a renderer response routes back
 * to the sidecar that RAISED the request even after the user switched to
 * another tab (sidecarForWindow would misroute it to the newly active
 * sidecar, which never saw the request).
 */

import { codedError } from "../shared/ipc-error-codes";
import {
	IPC_EVENTS,
	type IpcExtensionUiPayload,
	type IpcOpenExtensionRequest,
	type IpcScheduledRetry,
	type IpcSessionOwner,
	type IpcSetTabViewPayload,
	type IpcSignIn,
	type IpcSignInEndedPayload,
	type IpcTabInfo,
	type IpcTabListChangedPayload,
	type IpcTabRunOutcome,
	type IpcTabStatusPayload,
	type IpcTabWorktree,
} from "../shared/ipc-types";
import {
	type AgentMessage,
	type AgentSessionEvent,
	BLOCKING_UI_METHODS,
	type ExtensionUIRequest,
	type HostToolCallRequest,
	type HostUriRequest,
	isSignInRequest,
	type PromptResultFrame,
	type RpcCommand,
	type RpcResponse,
	type SessionInfoUpdateFrame,
	type SidecarStatus,
	type SidecarStatusPayload,
	type SubagentFrame,
	type SubagentSubscriptionLevel,
} from "../shared/rpc-types";
import {
	asSplitLayout,
	forgetSplitTab,
	mapSplitLeaves,
	readRememberedSplits,
	readSplitNode,
	rememberedSplitOf,
	type SplitLayout,
	splitTabIds,
} from "../shared/split-layout";
import { canonicalCwd } from "./canonical-cwd";
import { type ExtensionApplyPlan, extensionApplyDecision, mergeApplyPlans } from "./extension-reload";
import { createMessageUpdateSlimmer } from "./message-update-slim";
import { ompRestartDecision } from "./omp-restart";
import type { WindowTabFact } from "./quit-guard";
import type { SidecarSessionIdentity, SidecarStartGate } from "./sidecar";
import { idleRun, type RunState, type RunTracking, runBusy, settleRun, trackRunEvent } from "./sidecar-run-state";
import type { SidecarLike } from "./sidecar-types";
import { nextSnowflake } from "./snowflake";
import { createSubagentFrameBatcher } from "./subagent-frames";
import { type PersistedTabDescriptor, type PersistedTabLayout, TAB_LAYOUT_VERSION } from "./tab-layout";
import type { ResumeFact } from "./turn-resume";
import { type ClientWindow, isWebWindow } from "./web/client-window";
import type { TabSpawnFacts } from "./worktree-lifecycle";

/** `device` = paired host deviceId (absent = this machine); `tabId` names the tab on that host. */
export type SidecarFactory = (
	cwd: string,
	kind: "agent" | "chat",
	fresh: boolean,
	device: string | undefined,
	tabId: string,
) => SidecarLike;

/** F-OWN key: the same path on another device is another file. */
function ownerKey(device: string | undefined, sessionPath: string): string {
	return device ? `${device}\u0000${sessionPath}` : sessionPath;
}

function forwardToWindow(win: ClientWindow, channel: string, data: unknown): void {
	if (!win.isDestroyed()) win.webContents.send(channel, data);
}

/** The renderer's composer-draft reports (`noteDraft`): each window says whether its own draft is empty. */
export const DRAFT_COMMANDS = ["set_idle_compaction_draft", "set_next_prompt_draft"] as const;
export type DraftCommand = (typeof DRAFT_COMMANDS)[number];

const SUBAGENT_LEVEL_RANK: Record<SubagentSubscriptionLevel, number> = { off: 0, progress: 1, events: 2 };

/** The level that serves every window's request: the highest. */
function highestSubagentLevel(levels: Iterable<SubagentSubscriptionLevel>): SubagentSubscriptionLevel {
	let top: SubagentSubscriptionLevel = "off";
	for (const level of levels) if (SUBAGENT_LEVEL_RANK[level] > SUBAGENT_LEVEL_RANK[top]) top = level;
	return top;
}

/**
 * What a tab did, for observers that are not windows (Web Push, web/web-push-notifier.ts): its turn started
 * or settled (`idle` carries how the last run ended, after the resume rules ran), a blocking ask or approval
 * was raised or went away (answered by any window, withdrawn by omp, or its tab ended), the tab was released.
 * A provider sign-in's own requests are never asks.
 */
export type TabActivity =
	| { type: "busy"; tabId: string }
	| { type: "idle"; tabId: string; outcome: IpcTabRunOutcome | undefined }
	| { type: "ask"; tabId: string; requestId: string; text: string }
	| { type: "askClosed"; tabId: string; requestId: string }
	| { type: "released"; tabId: string };

/** A tab's facts an observer reads when its debounce ends. */
export interface TabFacts {
	title: string;
	busy: boolean;
	awaitingConnection: boolean;
	/** Stock's auto-retry is waiting for its next attempt: the failure is not final. */
	retrying: boolean;
	/** TurnResume armed a retry of the failed turn (`scheduledRetry` pref): the failure is not final either. */
	scheduledRetry?: boolean;
}

/** Answers kept to refuse a late second one (`already_answered`); the oldest go first. */
const ANSWERED_KEPT = 256;

/** Sidecar events a visible tab forwards to its window unchanged, as `{ tabId, payload }`. */
const FORWARDED_TAB_EVENTS: ReadonlyArray<readonly [event: string, channel: string]> = [
	["liveFrame", IPC_EVENTS.LIVE_FRAME],
	["btwFrame", IPC_EVENTS.BTW_FRAME],
	["modelCatalogUpdate", IPC_EVENTS.MODEL_CATALOG_UPDATE],
	["commandsUpdate", IPC_EVENTS.COMMANDS_UPDATE],
	["configUpdate", IPC_EVENTS.CONFIG_UPDATE],
	["promptResult", IPC_EVENTS.PROMPT_RESULT],
	["commandOutput", IPC_EVENTS.COMMAND_OUTPUT],
	["sessionInfoUpdate", IPC_EVENTS.SESSION_INFO_UPDATE],
	["extensionError", IPC_EVENTS.EXTENSION_ERROR],
];

/** A window other than the owner that shows a tab, with the "closed" listener that makes it leave. */
interface TabViewer {
	win: ClientWindow;
	onClosed: () => void;
}

/** A tab's full-channel forwarders: one set of sidecar listeners for every window that shows it. */
interface FullWiring {
	/** Window id → that window and its own message-update slimmer (its first update of a message stays whole). */
	windows: Map<number, { win: ClientWindow; slim: (events: AgentSessionEvent[]) => AgentSessionEvent[] }>;
	/** Delivers the subagent frames still batched. */
	flush: () => void;
	/** Takes the listeners off the sidecar. */
	remove: () => void;
}

/** `run`, `lastRun`, `stopped` and `retry` follow the sidecar's events (`trackRunEvent`). */
interface PoolEntry extends RunTracking {
	sidecar: SidecarLike;
	tabId: string;
	/** The owner window: it spawned the tab, persists it in its layout, and closing it releases the tab. */
	win: ClientWindow;
	/** Paired host deviceId the tab runs on; undefined = this machine. Immutable; set at acquire. */
	device?: string;
	/** win.webContents.id, cached at acquire — safe to read after the window is destroyed. */
	winId: number;
	/** Windows besides the owner that show the tab, by window id (multi-viewer). Never the owner. */
	viewers: Map<number, TabViewer>;
	/** Session kind: "agent" (default) or "chat" (no project, default workspace). Immutable; set at acquire. */
	kind: "agent" | "chat";
	/** Untargeted startup tab; disposed when the user opens an explicit tab. */
	placeholder: boolean;
	/**
	 * Git-worktree binding (plan/20). Set at acquire from the spawn payload, or
	 * once by `bindWorktree` while a `worktree.onStart` tab is still starting;
	 * surfaced via tabStatusPayload so the chip and close flow know this tab
	 * owns a ~/.omp/wt checkout.
	 */
	worktree?: IpcTabWorktree;
	/** Last status this tab's sidecar reported (TAB_STATUS / GET_TABS). */
	status: SidecarStatus;
	/** Turn state from the sidecar's own events; `running` is the synthesized "running" status. */
	run: RunState;
	/**
	 * Session id, cached from session_info_update and from every `get_state`
	 * the sidecar answers (an in-tab switch_session emits no session_info_update
	 * until much later, and a stale id here would make that later frame look like
	 * a session change).
	 */
	sessionId?: string;
	/**
	 * Session meta cached from session_info_update — or, for a tab restored from
	 * the layout that has not been spawned yet, seeded from the persisted title
	 * so its chip has something better than a folder name to show.
	 */
	title?: string | null;
	/** What another session's agent opened this tab for (`agentTaskTitle` of its first message), until it has a title. */
	task?: string;
	/**
	 * Session file this tab is attached to (F-OWN). Set at acquire when
	 * spawned with --session and maintained from the RPC passthrough via
	 * noteSessionFile; the reverse key of #sessionOwners.
	 */
	sessionFile?: string;
	/** The turn waits for the internet connection and continues once it is back (turn-resume.ts). */
	awaitingConnection?: boolean;
	/** A relaunch continues this tab's interrupted work and its turn has not started yet (turn-resume.ts). */
	resuming?: boolean;
	/** The run's prompt while stock has not written the new session's file yet (it does at the first assistant message). */
	unsavedPrompt?: string;
	/** main's scheduled retry of this tab's failed turn, shown on its error card (turn-resume.ts). */
	scheduledRetry?: IpcScheduledRetry;
	/** Times the user changed the tab's session or branch (`TOUCH_COMMANDS`); a scheduled retry armed at another count is called off. */
	touched?: number;
	/** The window "closed" listener registered at acquire, removed on release. */
	onWindowClosed: () => void;
	/** `omp update` landed while this tab ran a turn: it restarts on the new omp when the turn ends. */
	ompRestartPending?: boolean;
	/** An extension update landed while this tab ran a turn: applied one tick after the turn ends. */
	extensionPending?: ExtensionApplyPlan;
	/** Provider sign-ins (`login` commands) dispatched to this tab that have not answered yet. */
	signIns?: number;
	/** Providers of those sign-ins, oldest first. */
	signInProviders?: string[];
	/** The browser page the sign-in in flight opened (its `open_url` with a `launchUrl`): the panel acknowledges and drops the request itself. */
	signInLink?: Extract<ExtensionUIRequest, { method: "open_url" }>;
	/** Provider ids a paired host reports it is running a `login` for on this tab (`signIn` event). */
	hostSignIns?: string[];
	/**
	 * The full-channel forwarders, shared by every window the tab is visible in.
	 * Null while no window shows it (light wiring only); windows join and leave
	 * so switches move forwarding without duplicating listeners.
	 */
	full: FullWiring | null;
	/** Each window's last draft report per draft command (`noteDraft`), by window id. */
	drafts?: Map<DraftCommand, Map<number, boolean>>;
	/** Each window's last `set_subagent_subscription` level (`noteSubagentLevel`), by window id. */
	subagentLevels?: Map<number, SubagentSubscriptionLevel>;
}

type WindowSplitView = NonNullable<IpcSetTabViewPayload["split"]>;

export class SidecarPool {
	#entries = new Set<PoolEntry>();
	#byTabId = new Map<string, PoolEntry>();
	/** Window (webContents.id) → active tab. The first acquired tab defaults active. */
	#activeByWindow = new Map<number, string>();
	/** Window → up to four tabs whose full event streams are rendered. */
	#visibleByWindow = new Map<number, Set<string>>();
	/** Window → recursive split geometry for its optional multi-pane view. */
	#splitByWindow = new Map<number, WindowSplitView>();
	/** Window → splits remembered but not on screen; a session is in at most one (and never also visible). */
	#rememberedByWindow = new Map<number, SplitLayout[]>();
	/** Session file → owning tab/window (F-OWN double-attach guard). */
	#sessionOwners = new Map<string, IpcSessionOwner>();
	/**
	 * Session file (F-OWN key) → the exit of the omp a released tab ran it in: a delete waits
	 * for it, so a closing process can no longer write the file it removes.
	 */
	#exiting = new Map<string, Promise<void>>();
	/**
	 * Pending renderer-facing request id → entry that raised it (F-UI-ORIGIN).
	 * Registered when a tab forwards an extension_ui request to its window; a
	 * response routes back to that exact sidecar even after the window's active
	 * tab moved on. Entries drop on the response or when the owning entry is
	 * released.
	 */
	#requestOwners = new Map<string, PoolEntry>();
	/**
	 * The blocking requests behind `#requestOwners`, by id: the live event reaches the page that
	 * was open then, so a window that reloads (View › Reload, a renderer crash) asks for them again
	 * through `openRequests`. Pruned against the owners whenever one is added or read.
	 */
	#requestBodies = new Map<string, ExtensionUIRequest>();
	/** The open requests a provider sign-in raised (`isSignInRequest` while its `login` ran): the login panel's. */
	#signInRequests = new Set<string>();
	/** Requests whose answer is on its way to the omp (`routeSideChannel`): a re-sent open list may predate it. */
	#answering = new Set<string>();
	/**
	 * Requests of a shared tab already answered, by id → the tab and the answering window: a second
	 * window's late answer is refused (`already_answered`) instead of falling back to another sidecar.
	 */
	#answered = new Map<string, { entry: PoolEntry; winId: number }>();
	readonly #factory: SidecarFactory;
	/** Suppress partial snapshots while a saved layout is being reconstructed. */
	#restoringWindows = new Set<number>();
	/**
	 * GUI host tools run against Electron in ipc.ts, which the pool cannot
	 * import without a cycle. Set once at startup; it answers every
	 * hostToolCall (shown or hidden tab), unknown tools with an explicit error.
	 */
	hostToolExecutor:
		| ((sidecar: SidecarLike, request: HostToolCallRequest, tab: { tabId: string; win: ClientWindow }) => void)
		| null = null;
	/** Main-process persistence hook. The primary window installs this at startup. */
	onWindowTabsChanged: ((win: ClientWindow, layout: PersistedTabLayout | null) => void) | null = null;
	/** Some tab may have started or finished running a turn (keep-awake while working). */
	onRunningChange: (() => void) | null = null;
	/**
	 * `worktree.onStart` (worktree-lifecycle.ts): the gate for a new tab, or null
	 * when the tab is not a candidate. Installed at startup.
	 */
	worktreeStartGate: ((tabId: string, winId: number, facts: TabSpawnFacts) => SidecarStartGate | null) | null = null;
	/** A tab was released (closed, or its window closed); `exited` settles once its omp is gone. */
	onTabReleased: ((tabId: string, exited: Promise<void>) => void) | null = null;
	/** A tab's sidecar was created (Autopilot attaches its approval and readiness listeners). */
	onAcquire: ((tabId: string, sidecar: SidecarLike) => void) | null = null;
	readonly #activityObservers = new Set<(activity: TabActivity) => void>();

	constructor(factory: SidecarFactory) {
		this.#factory = factory;
	}

	get size(): number {
		return this.#entries.size;
	}

	/** Be told what tabs do (`TabActivity`); an observer that throws never breaks the pool. Returns the unsubscribe. */
	observeTabs(observer: (activity: TabActivity) => void): () => void {
		this.#activityObservers.add(observer);
		return () => this.#activityObservers.delete(observer);
	}

	/**
	 * App-wide state for every window (the desktop slot): one event, delivered as a batch of each window's active
	 * tab, which is the stream every window already reads. A window without a tab has no use for it.
	 */
	broadcastEvent(event: AgentSessionEvent): void {
		for (const [winId, tabId] of this.#activeByWindow) {
			const entry = this.#byTabId.get(tabId);
			const win = entry && windowOf(entry, winId);
			if (win) forwardToWindow(win, IPC_EVENTS.EVENTS_BATCH, { tabId, payload: [event] });
		}
	}

	/** The facts of a live tab; null for an unknown (released) one. */
	tabFacts(tabId: string): TabFacts | null {
		const entry = this.#byTabId.get(tabId);
		if (!entry) return null;
		return {
			title: entry.title ?? "",
			busy: runBusy(entry.run),
			awaitingConnection: entry.awaitingConnection === true,
			retrying: entry.retry !== undefined,
			scheduledRetry: entry.scheduledRetry !== undefined,
		};
	}

	#announce(activity: TabActivity): void {
		for (const observer of this.#activityObservers) {
			try {
				observer(activity);
			} catch {
				// An observer's failure is its own.
			}
		}
	}

	/** The tab's turn started or settled: told after the resume rules have judged it (`onRunningChange`). */
	#announceRun(entry: PoolEntry): void {
		this.#announce(
			runBusy(entry.run)
				? { type: "busy", tabId: entry.tabId }
				: { type: "idle", tabId: entry.tabId, outcome: entry.lastRun },
		);
	}

	/** A blocking request a person has to answer (not a provider sign-in's own traffic) came to the tab. */
	#announceAsk(entry: PoolEntry, request: ExtensionUIRequest): void {
		if (!BLOCKING_UI_METHODS[request.method] || this.#signInRequests.has(request.id)) return;
		const text = "title" in request && typeof request.title === "string" ? request.title : "";
		this.#announce({ type: "ask", tabId: entry.tabId, requestId: request.id, text });
	}

	/**
	 * Spawn + bind a sidecar for `cwd` to `win` as a tab. Returns null when
	 * creating or starting the sidecar throws. `tabId` defaults to a fresh
	 * snowflake (the window's initial sidecar is minted here too); `sessionPath`
	 * resumes that session on first start.
	 * `kind` defaults to "agent"; "chat" marks a session outside any project.
	 * The first tab of a window becomes its active tab; later tabs start in
	 * the background (light TAB_STATUS wiring only). Removes the entry when
	 * the window closes.
	 *
	 * `deferStart` creates the tab WITHOUT spawning its process and without
	 * claiming the window's active slot: a sidecar holds ~200 MB of private
	 * memory, so a restored layout must not pay for tabs nobody has looked at.
	 * The spawn happens in `#wireFull`, i.e. the first time the tab is
	 * rendered — `#syncFullWiring` is the single point that knows a tab became
	 * visible.
	 *
	 * `device` runs the tab on a paired host: the factory returns a
	 * RemoteSidecar and the cwd is the host's path, so it is not resolved here
	 * (the host canonicalizes it).
	 */
	acquire(
		cwd: string,
		win: ClientWindow,
		tabId: string = nextSnowflake(),
		sessionPath?: string,
		kind: "agent" | "chat" = "agent",
		worktree?: IpcTabWorktree,
		fresh = false,
		placeholder = false,
		deferStart = false,
		title?: string,
		device?: string,
	): SidecarLike | null {
		try {
			// One spelling per directory: the sidecar reports its realpath'd cwd.
			const sidecar = this.#factory(device ? cwd : canonicalCwd(cwd), kind, fresh, device, tabId);
			const entry: PoolEntry = {
				sidecar,
				tabId,
				win,
				winId: win.webContents.id,
				device,
				kind,
				placeholder,
				worktree,
				status: sidecar.status,
				run: idleRun(),
				onWindowClosed: () => {
					this.#releaseEntry(entry);
				},
				viewers: new Map(),
				full: null,
			};
			if (title) entry.title = title;
			// Before anything can start it: the gate must be in place for the first `ready`.
			const gate = this.worktreeStartGate?.(tabId, entry.winId, {
				kind,
				sessionPath,
				device,
				worktree,
				fresh,
				placeholder,
				deferStart,
			});
			if (gate) sidecar.setStartGate?.(gate);
			this.#wireLight(entry);
			this.#entries.add(entry);
			this.#byTabId.set(tabId, entry);
			this.onAcquire?.(tabId, sidecar);
			// F-OWN: a spawn-with-sessionPath attaches immediately — register the
			// owner before any duplicate attach can slip past the IPC guard. A
			// deferred tab registers too: it owns that file the moment it exists,
			// which is what makes "open this session elsewhere" refuse-or-focus.
			if (sessionPath) this.#registerSessionFile(entry, sessionPath);
			if (!deferStart && !this.#activeByWindow.has(entry.winId)) {
				this.#activeByWindow.set(entry.winId, entry.tabId);
				this.#visibleByWindow.set(entry.winId, new Set([entry.tabId]));
				this.#syncFullWiring(entry.winId);
			}

			win.once("closed", entry.onWindowClosed);

			if (!deferStart) this.#ensureStarted(entry);
			this.#notifyWindowTabsChanged(win);
			return sidecar;
		} catch {
			return null;
		}
	}

	/**
	 * Spawn a tab's sidecar unless one is already under way or it has already
	 * run. A fresh sidecar with a session to resume goes through restart():
	 * kill() is a no-op on a not-yet-spawned manager, so this is a plain
	 * start() carrying --session. Safe to call on every visibility change —
	 * `status` leaves "asleep" synchronously inside start(), so a second call
	 * can never double-spawn.
	 */
	#ensureStarted(entry: PoolEntry): void {
		if (entry.sidecar.status !== "asleep") return;
		const sessionPath = entry.sessionFile;
		if (sessionPath) entry.sidecar.restart(undefined, sessionPath);
		else entry.sidecar.start();
	}

	/** Per-tab light wiring, attached for the entry's whole life: TAB_STATUS pushes, to the owner and every viewer. */
	#wireLight(entry: PoolEntry): void {
		const { sidecar, win } = entry;
		sidecar.on("status", (payload: SidecarStatusPayload) => {
			entry.status = payload.status;
			// A restart/exit kills any in-flight run along with the process, and the asks and approvals
			// it had open: the next process never heard of them, so none may outlive it as "asking".
			// A paired host's link blip is no such exit: its omp still holds the ask, so the route (and a
			// reloaded window's card) stays until the host itself reports that omp gone.
			if (payload.status !== "ready") {
				entry.run = idleRun();
				if (!sidecar.statusFromLink) {
					for (const [id, owner] of this.#requestOwners) {
						if (owner !== entry) continue;
						this.#requestOwners.delete(id);
						this.#announce({ type: "askClosed", tabId: entry.tabId, requestId: id });
					}
					// The host's `login`s ran on that omp and died with it; their outcome went unseen.
					const hostSignIn = entry.hostSignIns?.at(-1);
					entry.hostSignIns = undefined;
					if (hostSignIn !== undefined) this.#signInEnded(entry, hostSignIn);
				}
			}
			this.#forwardToTab(entry, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
			this.onRunningChange?.();
		});
		sidecar.on("sessionInfoUpdate", (frame: SessionInfoUpdateFrame) => {
			if (frame.title !== undefined) entry.title = frame.title;
			if (typeof frame.sessionId === "string") {
				const previousId = entry.sessionId;
				entry.sessionId = frame.sessionId;
				// F-OWN: the session under this tab changed (switch / new session
				// / crash-restart) — the cached file→owner mapping is stale. The
				// first attach (previousId undefined) keeps the acquire-time
				// registration; the renderer's hydrate (get_state) re-registers
				// the current file after a real change.
				if (previousId !== undefined && previousId !== frame.sessionId) this.#unregisterSessionFile(entry);
			}
			// Session meta changes ride the light channel too, so a background
			// tab's title/id updates without waiting for a status flip.
			this.#forwardToTab(entry, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
		});
		// Every get_state the sidecar answers (hydrate, health check, heartbeat)
		// reports the live session. An in-tab switch_session emits no
		// session_info_update until much later, so this is what keeps the cached
		// id and file current — in ONE push, so the renderer sees one session
		// change, not an id change followed by a path change.
		sidecar.on("session", (identity: SidecarSessionIdentity) => {
			const previousId = entry.sessionId;
			const previousFile = entry.sessionFile;
			if (identity.sessionId) entry.sessionId = identity.sessionId;
			// Another session now runs under this tab (new session, switch, project
			// change): its name replaces the old one's, since stock sends
			// session_info_update only when a name changes. A first report keeps the
			// title seeded at acquire.
			if (previousId !== undefined && entry.sessionId !== previousId) entry.title = identity.sessionName;
			if (identity.sessionFile) this.#registerSessionFile(entry, identity.sessionFile);
			else this.#unregisterSessionFile(entry);
			if (entry.sessionId === previousId && entry.sessionFile === previousFile) return;
			this.#forwardToTab(entry, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
			if (entry.sessionFile !== previousFile) this.#notifyWindowTabsChanged(win);
		});
		// Extension UI rides the light channel: a background agent's ask/confirm
		// blocks until answered, so it must reach that tab's runtime (the renderer
		// parks it there until the tab is shown), and widgets/status/notify set
		// while hidden must be current when the tab comes back.
		sidecar.on("extensionUi", (request: ExtensionUIRequest) => {
			// Only response-bearing requests need an origin route. Fire-and-forget
			// UI updates never reply, so retaining them here leaks the owning tab.
			if (BLOCKING_UI_METHODS[request.method]) {
				this.#holdRequest(entry, request);
				this.onRunningChange?.();
				this.#announceAsk(entry, request);
			}
			// omp withdrew the request (timeout, abort): no response will follow.
			else if (request.method === "cancel" && this.#requestOwners.get(request.targetId) === entry) {
				this.#requestOwners.delete(request.targetId);
				this.#announce({ type: "askClosed", tabId: entry.tabId, requestId: request.targetId });
				this.onRunningChange?.();
			}
			this.#forwardToTab(entry, IPC_EVENTS.EXTENSION_UI, this.#uiFrame(entry, request));
		});
		// A paired host re-attached the tab (RemoteSidecar): the asks its omp holds now are the tab's whole
		// open set. Its omp may have restarted or withdrawn one while the link was down (that card closes like
		// a withdrawn ask) or raised one this window never saw; the reconnect's `starting` also cleared the
		// page's cards, so each open one is sent again (the page does not double one it still shows).
		sidecar.on("openAsks", (requests: ExtensionUIRequest[]) => {
			const open = new Set(requests.map(request => request.id));
			for (const [id, owner] of this.#requestOwners) {
				if (owner !== entry || open.has(id) || this.#answering.has(id)) continue;
				this.#requestOwners.delete(id);
				this.#announce({ type: "askClosed", tabId: entry.tabId, requestId: id });
				const cancel: ExtensionUIRequest = {
					type: "extension_ui_request",
					id: `withdrawn:${id}`,
					method: "cancel",
					targetId: id,
				};
				this.#forwardToTab(entry, IPC_EVENTS.EXTENSION_UI, { tabId: entry.tabId, request: cancel });
			}
			for (const request of requests) {
				// Answered meanwhile: the list was taken before the answer reached the host.
				if (this.#answering.has(request.id)) continue;
				// Already this tab's before the link dropped: the window notified for it then.
				const resent = this.#requestOwners.get(request.id) === entry;
				this.#holdRequest(entry, request);
				if (!resent) this.#announceAsk(entry, request);
				this.#forwardToTab(entry, IPC_EVENTS.EXTENSION_UI, {
					...this.#uiFrame(entry, request),
					...(resent ? { resent: true as const } : {}),
				});
			}
			this.onRunningChange?.();
		});
		// A paired host's tab runs `login` whether or not this window kept the link: what it still runs decides
		// whether a re-sent code paste is the login panel's (it comes before `openAsks` on a re-attach).
		sidecar.on("signIn", (arg: { active: string[]; ended?: { providerId: string; error: string | null } }) => {
			const before = entry.hostSignIns ?? [];
			entry.hostSignIns = arg.active;
			if (arg.ended) this.#signInEnded(entry, arg.ended.providerId, arg.ended.error);
			else if (before.length > 0 && arg.active.length === 0) this.#signInEnded(entry, before.at(-1) ?? null);
		});
		// A hidden tab's subagents still start and finish: lifecycle frames keep
		// its runtime roster (the sidebar row's count) current. Progress frames
		// stay on the full channel; the roster is re-read when the tab is shown.
		sidecar.on("subagentFrame", (frame: SubagentFrame) => {
			if (frame.type !== "subagent_lifecycle") return;
			this.#forwardToHidden(entry, IPC_EVENTS.SUBAGENT_FRAMES, { tabId: entry.tabId, payload: [frame] });
		});
		// A tool call blocks the turn until answered, so a hidden tab's calls are answered too.
		sidecar.on("hostToolCall", (request: HostToolCallRequest) => {
			this.hostToolExecutor?.(sidecar, request, { tabId: entry.tabId, win });
		});
		const settle = (settled: boolean): void => {
			const wasBusy = runBusy(entry.run);
			settleRun(entry.run, settled);
			if (runBusy(entry.run) === wasBusy) return;
			this.#forwardToTab(entry, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
			this.onRunningChange?.();
			this.#announceRun(entry);
			this.#scheduleOmpRestart(entry);
			this.#scheduleExtensionApply(entry);
		};
		sidecar.on("promptResult", (frame: PromptResultFrame) => {
			if (typeof frame.sessionSettled === "boolean") settle(frame.sessionSettled);
		});
		sidecar.on("sessionSettled", () => settle(true));
		// A paired host holds this tab's connection wait (its own connectivity decides, turn-resume.ts): mirror it.
		sidecar.on("awaitingConnection", (awaiting: boolean) => this.setAwaitingConnection(entry.tabId, awaiting));
		// Agent-end means one run yielded; upstream prompt/session-settled frames
		// keep background async work represented as running until it is quiet.
		sidecar.on("events", (events: AgentSessionEvent[]) => {
			const wasBusy = runBusy(entry.run);
			const wasPlaceholder = entry.placeholder;
			// A plan proposal blocks a hidden tab's session on the user: it goes to
			// that tab's runtime here (the full channel carries it for a shown tab).
			let hiddenProposals: AgentSessionEvent[] | undefined;
			// A fast turn can start and end inside one batch: busy never changes, yet its outcome is news.
			let runEnded = false;
			let retryStarted = false;
			const unsavedBefore = entry.unsavedPrompt;
			for (const event of events) {
				if (trackRunEvent(entry, event)) runEnded = true;
				if (event.type === "agent_start") entry.placeholder = false;
				else if (event.type === "auto_retry_start") retryStarted = true;
				else if (event.type === "plan_proposal") {
					hiddenProposals ??= [];
					hiddenProposals.push(event);
				} else if (event.type === "message_end") {
					// Stock writes a new session's file with its first assistant message: until then the
					// prompt lives nowhere else, and a relaunch sends it again (turn-resume.ts).
					if (event.message.role === "assistant") delete entry.unsavedPrompt;
					else if (event.message.role === "user" && entry.unsavedPrompt === undefined) {
						const text = messageText(event.message);
						if (text) entry.unsavedPrompt = text;
					}
				}
			}
			const busy = runBusy(entry.run);
			const busyChanged = busy !== wasBusy;
			// The resume rules first: a failure they turn into a connection wait reaches the
			// window already waiting, so it never shows (or notifies) as a failure first.
			if (busyChanged || runEnded || retryStarted || entry.unsavedPrompt !== unsavedBefore) this.onRunningChange?.();
			if (busyChanged || (runEnded && !busy)) this.#announceRun(entry);
			if (busyChanged || entry.placeholder !== wasPlaceholder) {
				this.#forwardToTab(entry, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
			}
			if (busyChanged) {
				this.#scheduleOmpRestart(entry);
				this.#scheduleExtensionApply(entry);
			}
			if (entry.placeholder !== wasPlaceholder) this.#notifyWindowTabsChanged(win);
			if (hiddenProposals) {
				this.#forwardToHidden(entry, IPC_EVENTS.EVENTS_BATCH, { tabId: entry.tabId, payload: hiddenProposals });
			}
		});
	}

	/**
	 * Full-channel wiring for `win`, attached only while the tab is visible in
	 * it. The sidecar listeners exist once per tab and fan out to every window
	 * the tab is visible in; a window already wired is left untouched, so a
	 * repeated setActiveTab cannot stack duplicate forwarding.
	 *
	 * Being wired IS being shown, so this is where a deferred tab's process
	 * gets spawned — the one moment the pool knows the user can see it.
	 */
	#wireFull(entry: PoolEntry, win: ClientWindow, winId: number): void {
		if (entry.full?.windows.has(winId)) return;
		this.#ensureStarted(entry);
		// A fresh slimmer per window: the first update of each message after
		// the tab becomes visible there keeps its full snapshot (it missed message_start).
		const shown = { win, slim: createMessageUpdateSlimmer() };
		if (entry.full) {
			entry.full.windows.set(winId, shown);
			return;
		}
		const { sidecar } = entry;
		const windows: FullWiring["windows"] = new Map([[winId, shown]]);
		const removers: (() => void)[] = [];
		const forwardActive = <T>(channel: string, payload: T): void => {
			for (const target of windows.values()) forwardToWindow(target.win, channel, { tabId: entry.tabId, payload });
		};
		const wire = <T>(event: string, listener: (payload: T) => void): void => {
			sidecar.on(event, listener);
			removers.push(() => {
				sidecar.off(event, listener);
			});
		};
		const subagentFrames = createSubagentFrameBatcher(frames => forwardActive(IPC_EVENTS.SUBAGENT_FRAMES, frames));
		wire("subagentFrame", (frame: SubagentFrame) => subagentFrames.push(frame));
		wire("events", (events: AgentSessionEvent[]) => {
			// Subagent frames that arrived first leave first, as when each was sent alone.
			subagentFrames.flush();
			for (const target of windows.values()) {
				forwardToWindow(target.win, IPC_EVENTS.EVENTS_BATCH, { tabId: entry.tabId, payload: target.slim(events) });
			}
		});
		// A response (a subagent's messages, a transcript) can hold frames still batched here.
		wire("beforeResponse", () => subagentFrames.flush());
		wire("status", (payload: SidecarStatusPayload) => {
			forwardActive(IPC_EVENTS.SIDECAR_STATUS, { ...payload, cwd: sidecar.cwd });
		});
		// OMPdesk registers no host URI schemes: fail the read/write instead of leaving omp waiting.
		wire("hostUriRequest", (request: HostUriRequest) => {
			sidecar.sendSideChannel({
				type: "host_uri_result",
				id: request.id,
				isError: true,
				error: `OMPdesk serves no host URI for ${request.url}`,
			});
		});
		for (const [event, channel] of FORWARDED_TAB_EVENTS) {
			wire(event, (payload: unknown) => forwardActive(channel, payload));
		}
		entry.full = {
			windows,
			flush: () => subagentFrames.flush(),
			remove: () => {
				for (const remove of removers) remove();
			},
		};
	}

	/** Stop forwarding the tab's full channel to window `winId`; the last window takes the listeners off. */
	#unwireFull(entry: PoolEntry, winId: number): void {
		const full = entry.full;
		if (!full?.windows.has(winId)) return;
		if (full.windows.size === 1) {
			entry.full = null;
			full.remove();
			// Already received while shown: deliver them, as when each was sent alone.
			full.flush();
			return;
		}
		full.flush();
		full.windows.delete(winId);
	}

	#syncFullWiring(winId: number): void {
		const visible = this.#visibleByWindow.get(winId) ?? new Set<string>();
		for (const entry of this.#entries) {
			const win = windowOf(entry, winId);
			if (!win) continue;
			if (visible.has(entry.tabId)) this.#wireFull(entry, win, winId);
			else this.#unwireFull(entry, winId);
		}
	}

	/** Light-channel frames go to the owner and every viewer. */
	#forwardToTab(entry: PoolEntry, channel: string, data: unknown): void {
		forwardToWindow(entry.win, channel, data);
		for (const viewer of entry.viewers.values()) forwardToWindow(viewer.win, channel, data);
	}

	/** Frames a hidden tab's sidebar row needs go to the windows that show the tab without its full channel. */
	#forwardToHidden(entry: PoolEntry, channel: string, data: unknown): void {
		if (!entry.full?.windows.has(entry.winId)) forwardToWindow(entry.win, channel, data);
		for (const [winId, viewer] of entry.viewers) {
			if (!entry.full?.windows.has(winId)) forwardToWindow(viewer.win, channel, data);
		}
	}

	/**
	 * Release a tab: listeners first, then dispose (a stale forwarder surviving
	 * into a sidecar.restart() would push events at a destroyed window). When
	 * the active tab goes away, the oldest surviving tab of the window takes
	 * over (the renderer may override with SET_ACTIVE_TAB); releasing the last
	 * tab leaves the window tab-less, back to its initial no-sidecar state.
	 * Viewer windows lose the tab the same way and hear their list changed.
	 */
	#releaseEntry(entry: PoolEntry): Promise<void> {
		if (!this.#entries.delete(entry)) return Promise.resolve();
		this.#byTabId.delete(entry.tabId);
		this.onRunningChange?.();
		const sessionFile = entry.sessionFile;
		this.#unregisterSessionFile(entry);
		// Drop pending request-id routes pointing at the released entry — a
		// late renderer response must fall back, never write to a dead sidecar.
		for (const [id, owner] of this.#requestOwners) {
			if (owner === entry) this.#requestOwners.delete(id);
		}
		for (const [id, answered] of this.#answered) {
			if (answered.entry === entry) this.#answered.delete(id);
		}
		this.#announce({ type: "released", tabId: entry.tabId });
		// A destroyed window already dropped its one-shot "closed" listener.
		if (!entry.win.isDestroyed()) entry.win.removeListener("closed", entry.onWindowClosed);
		entry.sidecar.removeAllListeners();
		// Taken before dispose(), which forgets the child it kills.
		const exited = entry.sidecar.whenExited?.() ?? Promise.resolve();
		entry.sidecar.dispose();
		if (sessionFile !== undefined) this.#noteExiting(ownerKey(entry.device, sessionFile), exited);
		this.onTabReleased?.(entry.tabId, exited);
		this.#leaveWindowView(entry.tabId, entry.winId, entry.win);
		const viewers = [...entry.viewers];
		entry.viewers.clear();
		for (const [winId, viewer] of viewers) {
			if (!viewer.win.isDestroyed()) viewer.win.removeListener("closed", viewer.onClosed);
			this.#leaveWindowView(entry.tabId, winId, viewer.win);
			this.#sendTabList(viewer.win);
			if (!viewer.win.isDestroyed()) this.#notifyWindowTabsChanged(viewer.win);
		}
		return exited;
	}

	/**
	 * `tabId` is gone from window `winId`'s view (released, or the window left it):
	 * its visible set, split and remembered splits forget it, and when it was the
	 * active tab the oldest other tab the window shows takes over.
	 */
	#leaveWindowView(tabId: string, winId: number, win: ClientWindow): void {
		const visible = this.#visibleByWindow.get(winId);
		visible?.delete(tabId);
		const split = this.#splitByWindow.get(winId);
		if (split && splitTabIds(split).includes(tabId)) {
			const remaining = asSplitLayout(mapSplitLeaves(split, id => (id === tabId ? null : { tabId: id })));
			if (remaining) this.#splitByWindow.set(winId, remaining);
			else this.#splitByWindow.delete(winId);
		}
		const remembered = this.#rememberedByWindow.get(winId);
		if (remembered) {
			const kept = forgetSplitTab(remembered, tabId);
			if (kept.length > 0) this.#rememberedByWindow.set(winId, kept);
			else this.#rememberedByWindow.delete(winId);
		}
		if (![...this.#entries].some(candidate => windowOf(candidate, winId))) {
			this.#activeByWindow.delete(winId);
			this.#visibleByWindow.delete(winId);
			this.#splitByWindow.delete(winId);
			this.#rememberedByWindow.delete(winId);
			return;
		}
		if (this.#activeByWindow.get(winId) !== tabId) {
			this.#syncFullWiring(winId);
			return;
		}
		this.#activeByWindow.delete(winId);
		// During window teardown every entry self-releases; activating a sibling
		// whose window is already gone would wire forwarders for nothing.
		if (win.isDestroyed()) return;
		const candidates = [...this.#entries].filter(candidate => windowOf(candidate, winId));
		const candidate = candidates.find(item => visible?.has(item.tabId)) ?? candidates[0];
		if (!candidate) {
			this.#visibleByWindow.delete(winId);
			return;
		}
		if (!visible || visible.size === 0) this.#visibleByWindow.set(winId, new Set([candidate.tabId]));
		this.#activeByWindow.set(winId, candidate.tabId);
		this.#syncFullWiring(winId);
	}

	/**
	 * Show another window's tab in `win` too (multi-viewer: a paired web device
	 * opening a session that is already open). The window gets the tab's light
	 * channel at once and its full channel while the tab is visible there; a
	 * window with no tab yet makes it its active one. True when `win` shows the
	 * tab now, false when the tab is unknown.
	 */
	attachViewer(win: ClientWindow, tabId: string): boolean {
		const entry = this.#byTabId.get(tabId);
		if (!entry) return false;
		const winId = win.webContents.id;
		if (windowOf(entry, winId) === win) return true;
		// Its id now: a destroyed window's webContents can no longer be read when it closes.
		const viewer: TabViewer = { win, onClosed: () => this.#leaveAsViewer(tabId, winId) };
		entry.viewers.set(winId, viewer);
		win.once("closed", viewer.onClosed);
		if (!this.#activeByWindow.has(winId)) {
			this.#activeByWindow.set(winId, tabId);
			this.#visibleByWindow.set(winId, new Set([tabId]));
			this.#syncFullWiring(winId);
		}
		this.#sendTabLists(entry);
		// A paired device's saved layout names the tabs it views too (`tabLayoutForWindow`).
		this.#notifyWindowTabsChanged(win);
		return true;
	}

	/**
	 * A viewer window leaves a tab (it closed it there). The sidecar and every
	 * other window are untouched; the draft the window reported stops counting.
	 * False when `win` is not a viewer of the tab (its owner closes it with
	 * `releaseTab`).
	 */
	detachViewer(win: ClientWindow, tabId: string): boolean {
		const winId = win.webContents.id;
		if (this.#byTabId.get(tabId)?.viewers.get(winId)?.win !== win) return false;
		this.#leaveAsViewer(tabId, winId);
		return true;
	}

	/** Window `winId` stops viewing the tab: it closed it there, or the window itself closed. */
	#leaveAsViewer(tabId: string, winId: number): void {
		const entry = this.#byTabId.get(tabId);
		const viewer = entry?.viewers.get(winId);
		if (!entry || !viewer) return;
		entry.viewers.delete(winId);
		const { win } = viewer;
		if (!win.isDestroyed()) win.removeListener("closed", viewer.onClosed);
		this.#unwireFull(entry, winId);
		this.#leaveWindowView(tabId, winId, win);
		this.#forgetDrafts(entry, winId);
		this.#forgetSubagentLevel(entry, winId);
		this.#sendTabLists(entry);
		this.#sendTabList(win);
		if (!win.isDestroyed()) this.#notifyWindowTabsChanged(win);
	}

	/** Whether another window views the tab (multi-viewer). */
	isShared(tabId: string): boolean {
		return (this.#byTabId.get(tabId)?.viewers.size ?? 0) > 0;
	}

	/** `TAB_LIST_CHANGED` to every window showing the tab: its viewer count (or the tab itself) changed. */
	#sendTabLists(entry: PoolEntry): void {
		this.#sendTabList(entry.win);
		for (const viewer of entry.viewers.values()) this.#sendTabList(viewer.win);
	}

	/**
	 * A destroyed window is skipped before its tabs are listed: its webContents can no longer be read.
	 * `closed`: tabs of this window main itself closed (`closeSessionTab`), which the window drops.
	 */
	#sendTabList(win: ClientWindow, closed?: string[]): void {
		if (win.isDestroyed()) return;
		forwardToWindow(win, IPC_EVENTS.TAB_LIST_CHANGED, {
			tabs: this.tabsForWindow(win),
			...(closed ? { closed } : {}),
		} satisfies IpcTabListChangedPayload);
	}

	/**
	 * A window reports whether its composer draft for the tab is empty (`DRAFT_COMMANDS`). Every window
	 * showing the tab has its own draft, so the tab's omp hears "empty" only once all of them are; the
	 * return value is what to send it. With one window that is its own report.
	 */
	noteDraft(tabId: string, winId: number, command: DraftCommand, empty: boolean): boolean {
		const entry = this.#byTabId.get(tabId);
		if (!entry) return empty;
		entry.drafts ??= new Map();
		const reports = entry.drafts.get(command) ?? new Map<number, boolean>();
		entry.drafts.set(command, reports);
		reports.set(winId, empty);
		for (const report of reports.values()) if (!report) return false;
		return true;
	}

	/**
	 * A window sets the tab's subagent stream level. The tab's omp holds one level, while every window that
	 * shows the tab (a work map open on the phone, none on the desktop) has its own: the omp is told the
	 * highest of them, so one window closing its map never drops another's event stream.
	 */
	noteSubagentLevel(tabId: string, winId: number, level: SubagentSubscriptionLevel): SubagentSubscriptionLevel {
		const entry = this.#byTabId.get(tabId);
		if (!entry) return level;
		entry.subagentLevels ??= new Map();
		entry.subagentLevels.set(winId, level);
		return highestSubagentLevel(entry.subagentLevels.values());
	}

	/**
	 * A window toggled a composer mode (plan, prewalk, agents pause, fast/slow): most have
	 * no stock event, so the other windows that show the tab are told with a `config_update {modes: true}`
	 * frame and re-read them (renderer `refreshSessionModes`).
	 */
	noteModeChanged(tabId: string, exceptWinId: number): void {
		const entry = this.#byTabId.get(tabId);
		if (!entry || entry.viewers.size === 0) return;
		for (const [winId, target] of entry.full?.windows ?? []) {
			if (winId === exceptWinId) continue;
			forwardToWindow(target.win, IPC_EVENTS.CONFIG_UPDATE, {
				tabId: entry.tabId,
				payload: { type: "config_update", modes: true },
			});
		}
	}

	/** A viewer left: the level it asked for no longer counts, and the omp drops to what the rest need. */
	#forgetSubagentLevel(entry: PoolEntry, winId: number): void {
		const levels = entry.subagentLevels;
		if (!levels?.delete(winId)) return;
		void entry.sidecar.rpcClient
			?.command({ type: "set_subagent_subscription", level: highestSubagentLevel(levels.values()) })
			.catch(() => {});
	}

	/** A viewer left: its draft no longer holds the tab's timers back, so an all-empty tab says so now. */
	#forgetDrafts(entry: PoolEntry, winId: number): void {
		for (const [command, reports] of entry.drafts ?? []) {
			if (reports.get(winId) !== false) {
				reports.delete(winId);
				continue;
			}
			reports.delete(winId);
			if ([...reports.values()].every(Boolean)) {
				void entry.sidecar.rpcClient?.command({ type: command, empty: true }).catch(() => {});
			}
		}
	}

	/** The window's active entry (first entry as a fallback, e.g. mid-teardown). */
	entryForWindow(win: ClientWindow): PoolEntry | undefined {
		const winId = win.webContents.id;
		const active = this.#byTabId.get(this.#activeByWindow.get(winId) ?? "");
		if (active && windowOf(active, winId) === win) return active;
		for (const entry of this.#entries) {
			if (windowOf(entry, winId) === win) return entry;
		}
		return undefined;
	}

	/** Every live sidecar, across windows (account changes reach all tabs). */
	allSidecars(): SidecarLike[] {
		return [...this.#entries].map(entry => entry.sidecar);
	}

	/**
	 * omp on this computer was updated: every local tab moves to it (omp-restart.ts).
	 * Idle tabs restart now on their session file; a tab in a turn restarts when it ends.
	 * Returns how many tabs still wait. Tabs on paired hosts are the host's.
	 */
	restartOnNewOmp(): number {
		let waiting = 0;
		for (const entry of this.#entries) {
			if (entry.device !== undefined) continue;
			const decision = ompRestartDecision({ status: entry.sidecar.status, busy: runBusy(entry.run) });
			if (decision === "skip") continue;
			if (decision === "wait") {
				entry.ompRestartPending = true;
				waiting++;
				continue;
			}
			entry.ompRestartPending = false;
			entry.sidecar.restart(undefined, entry.sessionFile);
		}
		return waiting;
	}

	/**
	 * A turn ended on a tab that waits for the new omp. One tick later, so every listener of the
	 * turn's last events (the window's forwarder included) has seen them before the process goes.
	 */
	#scheduleOmpRestart(entry: PoolEntry): void {
		if (!entry.ompRestartPending || runBusy(entry.run)) return;
		setImmediate(() => {
			if (!entry.ompRestartPending || !this.#entries.has(entry) || runBusy(entry.run)) return;
			if (entry.status !== "ready") return;
			entry.ompRestartPending = false;
			entry.sidecar.restart(undefined, entry.sessionFile);
		});
	}

	/** Every local tab's working directory, distinct, in order (asleep tabs included: they load plugins on wake). */
	workspaceDirs(): string[] {
		const dirs = new Set<string>();
		for (const entry of this.#entries) {
			if (entry.device === undefined) dirs.add(entry.sidecar.cwd);
		}
		return [...dirs];
	}

	/**
	 * An extension update landed on this computer (extension-reload.ts). Idle ready tabs apply it now,
	 * a tab in a turn when it ends. Returns how many tabs still wait. Tabs on paired hosts are the host's.
	 */
	applyExtensionUpdate(plan: ExtensionApplyPlan): number {
		let waiting = 0;
		for (const entry of this.#entries) {
			if (entry.device !== undefined) continue;
			const decision = extensionApplyDecision({ status: entry.sidecar.status, busy: runBusy(entry.run) });
			if (decision === "skip") continue;
			if (decision === "wait") {
				entry.extensionPending = entry.extensionPending ? mergeApplyPlans(entry.extensionPending, plan) : plan;
				waiting++;
				continue;
			}
			this.#applyExtensionPlan(entry, plan);
		}
		return waiting;
	}

	#applyExtensionPlan(entry: PoolEntry, plan: ExtensionApplyPlan): void {
		if (plan.restart) {
			entry.extensionPending = undefined;
			entry.sidecar.restart(undefined, entry.sessionFile);
			return;
		}
		void entry.sidecar.reloadExtensions?.(plan)?.catch(() => {});
	}

	#scheduleExtensionApply(entry: PoolEntry): void {
		if (!entry.extensionPending || runBusy(entry.run)) return;
		setImmediate(() => {
			const plan = entry.extensionPending;
			if (!plan || !this.#entries.has(entry) || runBusy(entry.run)) return;
			if (entry.status !== "ready") return;
			entry.extensionPending = undefined;
			// A pending omp restart already carries the new files.
			if (entry.ompRestartPending) return;
			this.#applyExtensionPlan(entry, plan);
		});
	}

	/** Resolves via the ACTIVE tab, so every existing ipc.ts handler keeps working unchanged. */
	sidecarForWindow(win: ClientWindow): SidecarLike | null {
		return this.entryForWindow(win)?.sidecar ?? null;
	}

	/** The sidecar of one specific tab, scoped to the window that owns it. */
	sidecarForTab(win: ClientWindow, tabId: string): SidecarLike | null {
		const entry = this.#byTabId.get(tabId);
		return entry && windowOf(entry, win.webContents.id) === win ? entry.sidecar : null;
	}

	/**
	 * One tab of `win` — `tabId`, or the window's active tab when omitted — with
	 * the device it runs on, so a handler can route a remote tab to its host,
	 * and its owner window's id (`winId`), which keys what the tab owns on this
	 * machine (its terminals) whichever window asks.
	 */
	tabTarget(
		win: ClientWindow,
		tabId?: string,
	): { tabId: string; sidecar: SidecarLike; device: string | undefined; winId: number } | null {
		const entry = tabId ? this.#byTabId.get(tabId) : this.entryForWindow(win);
		if (!entry || windowOf(entry, win.webContents.id) !== win) return null;
		return { tabId: entry.tabId, sidecar: entry.sidecar, device: entry.device, winId: entry.winId };
	}

	/**
	 * Send a command to the ready tab attached to `sessionPath`, mid-run or not —
	 * for mutations stock applies safely during a run (rename). Null until the
	 * owner's process is ready.
	 */
	async commandForSession(sessionPath: string, command: RpcCommand, device?: string): Promise<RpcResponse | null> {
		const owner = this.#sessionOwners.get(ownerKey(device, sessionPath));
		const entry = owner ? this.#byTabId.get(owner.tabId) : undefined;
		if (entry?.status !== "ready") return null;
		const client = entry.sidecar.rpcClient;
		return client ? await client.command(command) : null;
	}

	/**
	 * The session is being deleted: close the tab holding it, as a closed tab
	 * goes, and resolve once no omp of this computer has the file open (the
	 * owner's, or the one a tab the user just closed ran). The owner's window
	 * hears the tab is gone (`TAB_LIST_CHANGED` `closed`) and drops it like its
	 * own close. False, with nothing closed, while the owner's run or
	 * compaction is in flight.
	 */
	async closeSessionTab(sessionPath: string, device?: string): Promise<boolean> {
		const key = ownerKey(device, sessionPath);
		const owner = this.#sessionOwners.get(key);
		const entry = owner ? this.#byTabId.get(owner.tabId) : undefined;
		if (entry) {
			if (runBusy(entry.run)) return false;
			this.#releaseEntry(entry);
			this.#notifyWindowTabsChanged(entry.win);
			this.#sendTabList(entry.win, [entry.tabId]);
		}
		await this.#exiting.get(key);
		return true;
	}

	#noteExiting(key: string, exited: Promise<void>): void {
		this.#exiting.set(key, exited);
		void exited.finally(() => {
			if (this.#exiting.get(key) === exited) this.#exiting.delete(key);
		});
	}

	/** Make `tabId` the window's active tab (moves full event forwarding). False when unknown/foreign. */
	setActiveTab(win: ClientWindow, tabId: string): boolean {
		return this.setTabView(win, tabId, [tabId]);
	}

	/** Atomically focus one tab and wire full streams for up to four visible tabs. */
	setTabView(
		win: ClientWindow,
		focusedTabId: string,
		visibleTabIds: readonly string[],
		split?: IpcSetTabViewPayload["split"],
		rememberedSplits?: IpcSetTabViewPayload["rememberedSplits"],
	): boolean {
		const ids = [...new Set(visibleTabIds)];
		if (ids.length < 1 || ids.length > 4 || !ids.includes(focusedTabId)) return false;
		const parsed = split ? asSplitLayout(readSplitNode(split)) : null;
		if (
			split &&
			(!parsed || splitTabIds(parsed).length !== ids.length || !splitTabIds(parsed).every(id => ids.includes(id)))
		)
			return false;
		const winId = win.webContents.id;
		for (const tabId of ids) {
			const entry = this.#byTabId.get(tabId);
			if (!entry || windowOf(entry, winId) !== win) return false;
		}
		this.#activeByWindow.set(winId, focusedTabId);
		this.#visibleByWindow.set(winId, new Set(ids));
		if (parsed) this.#splitByWindow.set(winId, parsed);
		else this.#splitByWindow.delete(winId);
		// Remembered splits never share a session with what is on screen; a plain
		// focus switch (no list sent) keeps the others as they were.
		const remembered = readRememberedSplits(
			rememberedSplits ?? this.#rememberedByWindow.get(winId),
			tabId => {
				const entry = this.#byTabId.get(tabId);
				return entry && windowOf(entry, winId) === win ? tabId : null;
			},
			new Set(ids),
		);
		if (remembered.length > 0) this.#rememberedByWindow.set(winId, remembered);
		else this.#rememberedByWindow.delete(winId);
		this.#syncFullWiring(winId);
		this.#notifyWindowTabsChanged(win);
		return true;
	}

	/** Release one tab's sidecar. False when the tab is unknown. */
	releaseTab(tabId: string): boolean {
		const entry = this.#byTabId.get(tabId);
		if (!entry) return false;
		this.#releaseEntry(entry);
		this.#notifyWindowTabsChanged(entry.win);
		return true;
	}

	/** Release one tab like `releaseTab`; resolves once its omp process has exited. */
	releaseTabWhenExited(tabId: string): Promise<void> {
		const entry = this.#byTabId.get(tabId);
		if (!entry) return Promise.resolve();
		const exited = this.#releaseEntry(entry);
		this.#notifyWindowTabsChanged(entry.win);
		return exited;
	}

	/**
	 * Bind a worktree `worktree.onStart` created to a tab that is still starting
	 * (it restarts there next). Pushes TAB_STATUS so the chip shows it. False
	 * when the tab is gone.
	 */
	bindWorktree(tabId: string, worktree: IpcTabWorktree): boolean {
		const entry = this.#byTabId.get(tabId);
		if (!entry) return false;
		entry.worktree = worktree;
		this.#forwardToTab(entry, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
		this.#notifyWindowTabsChanged(entry.win);
		return true;
	}

	/** A tab's sidecar, any window (main-side flows that start from a tab id). */
	sidecarOf(tabId: string): SidecarLike | null {
		return this.#byTabId.get(tabId)?.sidecar ?? null;
	}

	/**
	 * The tab/window currently attached to `sessionPath`, null when free
	 * (F-OWN). SPAWN_TAB and SESSION_OPEN_NEW_WINDOW consult this before
	 * spawning a second sidecar for the same file.
	 */
	sessionOwner(sessionPath: string, device?: string): IpcSessionOwner | null {
		return this.#sessionOwners.get(ownerKey(device, sessionPath)) ?? null;
	}

	/**
	 * Whether the owner tab of `sessionPath` has a process holding that session
	 * in memory. `asleep` (restored but never shown), `exited` and `error` have
	 * no process at all, so the file on disk is the entire session: a rename
	 * must go to the filesystem instead of a `set_session_name` with nobody to
	 * answer it — which `commandForSession` would refuse as if the process were
	 * still starting. `starting` counts as live: that
	 * spawn is about to read the file. A child that is still running always
	 * counts, whatever the status says: a failed health check reports `error`
	 * over a live process that still holds the file.
	 */
	sessionOwnerIsLive(sessionPath: string, device?: string): boolean {
		const owner = this.#sessionOwners.get(ownerKey(device, sessionPath));
		const entry = owner ? this.#byTabId.get(owner.tabId) : undefined;
		if (!entry) return false;
		if (entry.sidecar.processAlive) return true;
		return entry.status !== "asleep" && entry.status !== "exited" && entry.status !== "error";
	}

	/**
	 * The owner BLOCKING `tabId`'s attach to `sessionPath` — the file's current
	 * owner when it is a different tab, else null (unowned, or owned by the
	 * issuer itself, which re-attaches freely). An untracked issuer (null
	 * tabId) is blocked by any owner: refusing is the safe direction there.
	 * F-OWN's refuse-or-focus decision point for the switch_session passthrough.
	 * The path is on the issuer's device.
	 */
	foreignSessionOwner(tabId: string | null, sessionPath: string): IpcSessionOwner | null {
		const device = tabId ? this.#byTabId.get(tabId)?.device : undefined;
		const owner = this.#sessionOwners.get(ownerKey(device, sessionPath));
		if (!owner || owner.tabId === tabId) return null;
		return owner;
	}

	/**
	 * Record the session file a tab's sidecar is attached to. ipc.ts reports
	 * this from the RPC passthrough (switch_session success, get_state — the
	 * only main-observable carriers of the file path; session_info_update
	 * itself carries just the id). Null unregisters (fresh unsaved session).
	 */
	noteSessionFile(tabId: string, sessionFile: string | null): void {
		const entry = this.#byTabId.get(tabId);
		if (!entry) return;
		const previous = entry.sessionFile;
		if (sessionFile) this.#registerSessionFile(entry, sessionFile);
		else this.#unregisterSessionFile(entry);
		if (entry.sessionFile !== previous) {
			this.#forwardToTab(entry, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
			this.#notifyWindowTabsChanged(entry.win);
		}
	}

	/**
	 * Re-root a tab to its live session's cwd. `switch_session` re-roots the
	 * agent with no main-observable event, so the chip and every `sidecar.cwd`
	 * consumer stay frozen at the spawn cwd until this is called — the RPC
	 * passthrough reports the post-switch cwd (get_state) here. Pushes
	 * TAB_STATUS when the cwd changed so the renderer's chip tracks the move.
	 * Returns true when the cwd changed (ipc.ts gates the window-record sync).
	 */
	adoptSessionCwd(tabId: string, cwd: string): boolean {
		const entry = this.#byTabId.get(tabId);
		if (!entry || !cwd) return false;
		if (!entry.sidecar.adoptCwd(cwd)) return false;
		this.#forwardToTab(entry, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
		this.#notifyWindowTabsChanged(entry.win);
		return true;
	}

	/**
	 * Route a renderer side-channel response to the sidecar that RAISED the
	 * request (F-UI-ORIGIN), tracked by request id at forward time — not the
	 * window's active tab, which may have changed while the dialog was open.
	 * The response consumes the route once the sidecar took it: a paired host's
	 * tab that could not deliver it (the link down, or dropped while the answer
	 * was on its way, or the host refused it) rejects, the route and the open
	 * request stay and the card can be answered again.
	 * False when the id is unknown — the caller falls back to the active tab's
	 * sidecar.
	 *
	 * A shared tab's ask (multi-viewer) takes the first answer: `responder`'s
	 * closes the other windows' cards through a synthetic `cancel`, and an
	 * answer from another window after it is refused (`already_answered`), even
	 * while the first is still on its way.
	 */
	async routeSideChannel(id: string, frame: object, tabId?: string, responder?: ClientWindow): Promise<boolean> {
		const entry = tabId ? this.#byTabId.get(tabId) : (this.#requestOwners.get(id) ?? this.#answered.get(id)?.entry);
		if (!entry) return false;
		const responderId = responder?.webContents.id;
		const answered = this.#answered.get(id);
		if (answered?.entry === entry && answered.winId !== responderId) {
			throw codedError("already_answered", "Another window already answered this request");
		}
		const shared = responderId !== undefined && entry.viewers.size > 0 && this.#requestOwners.get(id) === entry;
		if (shared) {
			this.#answered.set(id, { entry, winId: responderId });
			const oldest = this.#answered.keys().next().value;
			if (this.#answered.size > ANSWERED_KEPT && oldest !== undefined) this.#answered.delete(oldest);
		}
		this.#answering.add(id);
		try {
			await entry.sidecar.sendSideChannel(frame);
		} catch (error) {
			// Not delivered: the card stays open everywhere and any window may answer again.
			if (shared) this.#answered.delete(id);
			throw error;
		} finally {
			this.#answering.delete(id);
		}
		if (this.#requestOwners.get(id) === entry) {
			this.#requestOwners.delete(id);
			this.#announce({ type: "askClosed", tabId: entry.tabId, requestId: id });
			this.onRunningChange?.();
		}
		if (shared) {
			const cancel = {
				tabId: entry.tabId,
				request: { type: "extension_ui_request", id: `answered:${id}`, method: "cancel", targetId: id },
				answeredElsewhere: true,
			} satisfies IpcExtensionUiPayload;
			if (entry.winId !== responderId) forwardToWindow(entry.win, IPC_EVENTS.EXTENSION_UI, cancel);
			for (const [winId, viewer] of entry.viewers) {
				if (winId !== responderId) forwardToWindow(viewer.win, IPC_EVENTS.EXTENSION_UI, cancel);
			}
		}
		return true;
	}

	/** The asks and approvals this window's tabs still wait on, for a page that loaded after they were raised. */
	openRequests(win: ClientWindow): IpcOpenExtensionRequest[] {
		const open: IpcOpenExtensionRequest[] = [];
		for (const [id, request] of this.#requestBodies) {
			const owner = this.#requestOwners.get(id);
			if (!owner) {
				this.#requestBodies.delete(id);
				this.#signInRequests.delete(id);
			} else if (windowOf(owner, win.webContents.id) === win) {
				const signIn = this.#signInMark(owner, request);
				open.push({ tabId: owner.tabId, request, ...(signIn ? { signIn } : {}) });
			}
		}
		return open;
	}

	/** Route a blocking request back to the tab that raised it, keeping its body for a reloaded page. */
	#holdRequest(entry: PoolEntry, request: ExtensionUIRequest): void {
		this.#requestOwners.set(request.id, entry);
		for (const id of this.#requestBodies.keys())
			if (!this.#requestOwners.has(id)) {
				this.#requestBodies.delete(id);
				this.#signInRequests.delete(id);
			}
		this.#requestBodies.set(request.id, request);
		if (this.#signInActive(entry) && isSignInRequest(request)) this.#signInRequests.add(request.id);
	}

	/**
	 * What a page needs to give a request back to the login panel (`IpcSignIn`), or nothing when it is
	 * the chat's: a sign-in kind raised while a `login` ran on the tab, or one held from such a time.
	 */
	#signInMark(entry: PoolEntry, request: ExtensionUIRequest): IpcSignIn | undefined {
		const active = this.#signInActive(entry);
		if (!(active && isSignInRequest(request)) && !this.#signInRequests.has(request.id)) return undefined;
		if (active && request.method === "open_url" && request.launchUrl !== undefined) entry.signInLink = request;
		return {
			active,
			providerId: entry.signInProviders?.at(-1) ?? entry.hostSignIns?.at(-1) ?? null,
			...(active && entry.signInLink ? { link: entry.signInLink } : {}),
		};
	}

	/** The `EXTENSION_UI` event for a request: carries the sign-in mark (`#signInMark`). */
	#uiFrame(entry: PoolEntry, request: ExtensionUIRequest): IpcExtensionUiPayload {
		const signIn = this.#signInMark(entry, request);
		return { tabId: entry.tabId, request, ...(signIn ? { signIn } : {}) };
	}

	/** Register sessionFile → owner, moving the entry off any previous file. */
	#registerSessionFile(entry: PoolEntry, sessionFile: string): void {
		const changed = entry.sessionFile !== sessionFile;
		if (changed) this.#unregisterSessionFile(entry);
		entry.sessionFile = sessionFile;
		if (changed && entry.run.running) this.onRunningChange?.();
		this.#sessionOwners.set(ownerKey(entry.device, sessionFile), { tabId: entry.tabId, winId: entry.winId });
	}

	/** Drop the entry's file→owner mapping when it still points at this entry. */
	#unregisterSessionFile(entry: PoolEntry): void {
		if (entry.sessionFile === undefined) return;
		// Another tab may have re-registered the same file since — only the
		// current owner may clear the mapping.
		const key = ownerKey(entry.device, entry.sessionFile);
		if (this.#sessionOwners.get(key)?.tabId === entry.tabId) {
			this.#sessionOwners.delete(key);
		}
		entry.sessionFile = undefined;
	}

	/** The window's active tab id (null when the window has no tabs). */
	activeTabForWindow(win: ClientWindow): string | null {
		return this.#activeByWindow.get(win.webContents.id) ?? null;
	}

	/** The window's tabs in acquisition order (GET_TABS boot reconciliation). */
	tabsForWindow(win: ClientWindow): IpcTabInfo[] {
		const tabs: IpcTabInfo[] = [];
		const activeTabId = this.#activeByWindow.get(win.webContents.id);
		const visibleTabIds = this.#visibleByWindow.get(win.webContents.id);
		const split = this.#splitByWindow.get(win.webContents.id);
		const remembered = this.#rememberedByWindow.get(win.webContents.id) ?? [];
		for (const entry of this.#entries) {
			if (windowOf(entry, win.webContents.id) !== win) continue;
			const tab = tabStatusPayload(entry);
			if (entry.tabId === activeTabId) tab.active = true;
			if (visibleTabIds?.has(entry.tabId)) tab.visible = true;
			if (split && visibleTabIds?.has(entry.tabId)) tab.split = split;
			const home = rememberedSplitOf(remembered, entry.tabId);
			if (home && splitTabIds(home)[0] === entry.tabId) tab.rememberedSplit = home;
			if (entry.win !== win) tab.shared = true;
			if (entry.viewers.size > 0) tab.viewerCount = entry.viewers.size;
			tabs.push(tab);
		}
		return tabs;
	}

	/**
	 * Put one window's tabs in `order` (tab overview drag, ⌘1…⌘9 positions);
	 * other windows' tabs keep their slots. False unless `order` names exactly
	 * the window's tabs once each. The saved layout follows.
	 */
	reorderWindowTabs(win: ClientWindow, order: readonly string[]): boolean {
		const mine = [...this.#entries].filter(entry => entry.win === win);
		const byId = new Map(mine.map(entry => [entry.tabId, entry]));
		const sorted = order.flatMap(id => byId.get(id) ?? []);
		if (sorted.length !== mine.length || new Set(sorted).size !== mine.length) return false;
		const all = [...this.#entries];
		this.#entries.clear();
		let next = 0;
		for (const entry of all) this.#entries.add(entry.win === win ? (sorted[next++] ?? entry) : entry);
		this.#notifyWindowTabsChanged(win);
		return true;
	}

	/** The inputs of the resume rules (turn-resume.ts): what each tab is doing and why it may continue. */
	resumeFacts(): ResumeFact[] {
		const asking = new Set(this.#requestOwners.values());
		return [...this.#entries].map(entry => {
			const fact: ResumeFact = {
				tabId: entry.tabId,
				winId: entry.winId,
				cwd: entry.sidecar.cwd,
				kind: entry.kind,
				running: entry.run.running,
				stopped: entry.stopped === true,
				awaitingUi: asking.has(entry),
				awaitingConnection: entry.awaitingConnection === true,
			};
			if (entry.device) fact.device = entry.device;
			if (entry.sessionFile) fact.sessionFile = entry.sessionFile;
			if (entry.lastRun) fact.lastRun = entry.lastRun;
			if (entry.retry) fact.retry = entry.retry;
			if (entry.touched) fact.touched = entry.touched;
			if (entry.unsavedPrompt !== undefined) fact.unsavedPrompt = entry.unsavedPrompt;
			return fact;
		});
	}

	/** The user pressed Stop on this tab's run. */
	noteStopped(tabId: string): void {
		const entry = this.#byTabId.get(tabId);
		if (!entry) return;
		entry.stopped = true;
		this.onRunningChange?.();
	}

	/** The user is changing which session or branch this tab shows (`TOUCH_COMMANDS`): a scheduled retry no longer applies. */
	noteTouched(tabId: string): void {
		const entry = this.#byTabId.get(tabId);
		if (!entry) return;
		entry.touched = (entry.touched ?? 0) + 1;
		this.onRunningChange?.();
	}

	/**
	 * A provider sign-in (`login`) started on, or answered from, this tab. When the last one answers,
	 * a page that took the sign-in over after a reload (`IpcSignIn.active`) is told it is over.
	 */
	noteSignIn(tabId: string, active: boolean, login?: { providerId: string; error?: string | null }): void {
		const entry = this.#byTabId.get(tabId);
		if (!entry) return;
		entry.signIns = Math.max(0, (entry.signIns ?? 0) + (active ? 1 : -1));
		const providers = entry.signInProviders ?? [];
		if (login && active) providers.push(login.providerId);
		else if (login) {
			const at = providers.indexOf(login.providerId);
			if (at >= 0) providers.splice(at, 1);
		}
		entry.signInProviders = providers;
		if (!active) this.#signInEnded(entry, login?.providerId ?? null, login ? (login.error ?? null) : null);
	}

	/** Whether a `login` runs for the tab: one this window sent, or one a paired host reports (`signIn`). */
	#signInActive(entry: PoolEntry): boolean {
		return (entry.signIns ?? 0) > 0 || (entry.hostSignIns?.length ?? 0) > 0;
	}

	/**
	 * A `login` answered. Once none is left, a page that took the sign-in over is told (`error`: null =
	 * connected, a message = failed, absent = the outcome went unseen).
	 */
	#signInEnded(entry: PoolEntry, providerId: string | null, error?: string | null): void {
		if (this.#signInActive(entry)) return;
		entry.signInLink = undefined;
		this.#forwardToTab(entry, IPC_EVENTS.SIGN_IN_ENDED, {
			tabId: entry.tabId,
			providerId,
			...(error === undefined ? {} : { error }),
		} satisfies IpcSignInEndedPayload);
	}

	/** Show or clear the tab's "waiting for the internet connection" state. */
	setAwaitingConnection(tabId: string, awaiting: boolean): void {
		const entry = this.#byTabId.get(tabId);
		if (!entry || (entry.awaitingConnection === true) === awaiting) return;
		entry.awaitingConnection = awaiting;
		this.#forwardToTab(entry, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
	}

	/** Show or clear the tab's calm "continuing where it left off" row (a relaunch's resume). */
	setResuming(tabId: string, resuming: boolean): void {
		const entry = this.#byTabId.get(tabId);
		if (!entry || (entry.resuming === true) === resuming) return;
		entry.resuming = resuming;
		this.#forwardToTab(entry, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
	}

	/**
	 * Which tab a relaunch continues first: 0 the window's focused tab, 1 another pane of its split, 2 the rest, so the
	 * work the user is looking at starts before the background tabs compete for the same spawns.
	 */
	resumeRank(tabId: string): number {
		const entry = this.#byTabId.get(tabId);
		if (!entry) return 2;
		if (this.#activeByWindow.get(entry.winId) === tabId) return 0;
		return this.#visibleByWindow.get(entry.winId)?.has(tabId) ? 1 : 2;
	}

	/** Show (or with `undefined` clear) the tab's scheduled retry (turn-resume.ts). */
	setScheduledRetry(tabId: string, retry: IpcScheduledRetry | undefined): void {
		const entry = this.#byTabId.get(tabId);
		if (!entry) return;
		if (retry === undefined) {
			if (entry.scheduledRetry === undefined) return;
			delete entry.scheduledRetry;
		} else entry.scheduledRetry = retry;
		this.#forwardToTab(entry, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
	}

	/** Spawn a deferred tab's process now (a background tab a relaunch must resume); the sidecar, or null for an unknown tab. */
	startTab(tabId: string): SidecarLike | null {
		const entry = this.#byTabId.get(tabId);
		if (!entry) return null;
		this.#ensureStarted(entry);
		return entry.sidecar;
	}

	/** Name what another session's agent opened the tab for; its windows show it until the session has a title. */
	setTabTask(tabId: string, task: string): void {
		const entry = this.#byTabId.get(tabId);
		if (!entry || entry.task === task) return;
		entry.task = task;
		this.#forwardToTab(entry, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
	}

	/** The tab on this computer attached to `sessionPath`, if any. */
	tabForSession(sessionPath: string): string | null {
		return this.sessionOwner(sessionPath)?.tabId ?? null;
	}

	/** What every live tab is doing right now — the ⌘Q guard's inventory. */
	tabInventory(): WindowTabFact[] {
		return [...this.#entries].map(entry => ({
			windowId: entry.winId,
			tabId: entry.tabId,
			inFlight: runBusy(entry.run),
		}));
	}

	/**
	 * Serializable layout for the window, excluding transient run/status data. A paired device's window also names
	 * the stored sessions it views (another window owns them): after a relaunch it views them again (`restoreLayout`).
	 */
	tabLayoutForWindow(win: ClientWindow): PersistedTabLayout | null {
		const winId = win.webContents.id;
		const web = isWebWindow(winId);
		const entries = [...this.#entries].filter(
			entry => entry.win === win || (web && entry.sessionFile !== undefined && windowOf(entry, winId) === win),
		);
		if (entries.length === 0) return null;
		const activeTabId = this.#activeByWindow.get(win.webContents.id);
		const activeIndex = Math.max(
			0,
			entries.findIndex(entry => entry.tabId === activeTabId),
		);
		const split = this.#splitByWindow.get(win.webContents.id);
		const splits = readRememberedSplits(
			this.#rememberedByWindow.get(win.webContents.id),
			tabId => {
				const index = entries.findIndex(entry => entry.tabId === tabId);
				return index >= 0 ? String(index) : null;
			},
			new Set(),
		);
		return {
			version: TAB_LAYOUT_VERSION,
			activeIndex,
			tabs: entries.map(entry => {
				const descriptor: PersistedTabDescriptor = { cwd: entry.sidecar.cwd, kind: entry.kind };
				if (entry.sessionFile) descriptor.sessionPath = entry.sessionFile;
				if (entry.worktree) {
					// Ownership is this launch's only: a restored tab is an ordinary worktree tab.
					const { name, branch, baseCwd, path } = entry.worktree;
					descriptor.worktree = { name, branch, baseCwd, path };
				}
				if (entry.placeholder) descriptor.placeholder = true;
				if (entry.device) descriptor.device = entry.device;
				// Written even when the live title is null, so a cleared title
				// cannot survive as a stale one until the tab is spawned again.
				if (entry.title !== undefined) descriptor.title = entry.title ?? undefined;
				return descriptor;
			}),
			...(split
				? {
						split:
							asSplitLayout(
								mapSplitLeaves(split, tabId => {
									const index = entries.findIndex(entry => entry.tabId === tabId);
									return index >= 0 ? { tabId: String(index) } : null;
								}),
							) ?? undefined,
					}
				: {}),
			...(splits.length > 0 ? { splits } : {}),
		};
	}

	/**
	 * Recreate saved tabs with fresh runtime ids, then restore their active
	 * index. Every tab is acquired with `deferStart`: only the panes the view
	 * ends up showing get a process, so a restored ten-tab session costs one
	 * sidecar instead of ten.
	 */
	restoreLayout(win: ClientWindow, layout: PersistedTabLayout): number {
		const winId = win.webContents.id;
		this.#restoringWindows.add(winId);
		let restoredCount = 0;
		let firstRestoredTabId: string | undefined;
		let activeRestoredTabId: string | undefined;
		const restoredTabIds: string[] = [];
		try {
			for (const [index, tab] of layout.tabs.entries()) {
				// One session, one tab: a session another window already holds (the desktop's windows restore before a
				// paired device's) gets no second tab, which would put a second omp on its file. A paired device's
				// window views that tab again, as it did before (multi-viewer); a second desktop window leaves it there.
				const owner = tab.sessionPath ? this.sessionOwner(tab.sessionPath, tab.device) : null;
				let tabId: string | undefined;
				if (owner) {
					if (isWebWindow(winId) && this.attachViewer(win, owner.tabId)) tabId = owner.tabId;
				} else {
					const fresh = nextSnowflake();
					const sidecar = this.acquire(
						tab.cwd,
						win,
						fresh,
						tab.sessionPath,
						tab.kind,
						tab.worktree,
						!tab.sessionPath,
						tab.placeholder === true,
						true,
						tab.title,
						tab.device,
					);
					if (sidecar) tabId = fresh;
				}
				if (!tabId) continue;
				restoredCount++;
				restoredTabIds[index] = tabId;
				firstRestoredTabId ??= tabId;
				if (index === layout.activeIndex) activeRestoredTabId = tabId;
			}
			const activeTabId = activeRestoredTabId ?? firstRestoredTabId;
			if (activeTabId) {
				const restored = layout.split
					? mapSplitLeaves(layout.split, index => {
							const tabId = restoredTabIds[Number(index)];
							return tabId ? { tabId } : null;
						})
					: null;
				const split = asSplitLayout(restored);
				const ids = restored ? splitTabIds(restored) : [activeTabId];
				const focused = ids.includes(activeTabId) ? activeTabId : ids[0];
				const remembered = readRememberedSplits(
					layout.splits,
					index => restoredTabIds[Number(index)] ?? null,
					new Set(ids),
				);
				this.setTabView(win, focused, ids, split ?? undefined, remembered);
			}
		} finally {
			this.#restoringWindows.delete(winId);
		}
		this.#notifyWindowTabsChanged(win);
		return restoredCount;
	}

	#notifyWindowTabsChanged(win: ClientWindow): void {
		if (!this.onWindowTabsChanged || this.#restoringWindows.has(win.webContents.id)) return;
		this.onWindowTabsChanged(win, this.tabLayoutForWindow(win));
	}

	disposeAll(): void {
		for (const entry of this.#entries) {
			entry.sidecar.removeAllListeners();
			entry.sidecar.dispose();
		}
		this.#entries.clear();
		this.#byTabId.clear();
		this.#activeByWindow.clear();
		this.#visibleByWindow.clear();
		this.#splitByWindow.clear();
		this.#rememberedByWindow.clear();
		this.#sessionOwners.clear();
		this.#requestOwners.clear();
		this.#answered.clear();
		this.#restoringWindows.clear();
	}
}

/** The window `winId` as it shows `entry` (its owner or one of its viewers); undefined when it does not show it. */
function windowOf(entry: PoolEntry, winId: number): ClientWindow | undefined {
	return entry.winId === winId ? entry.win : entry.viewers.get(winId)?.win;
}

/** The text a user message carries (a string, or its text blocks; attachments are not text). */
function messageText(message: AgentMessage): string {
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(block => (block.type === "text" ? block.text : "")).join("");
}

/** TAB_STATUS push / GET_TABS item: full tab snapshot incl. cached session meta. */
function tabStatusPayload(entry: PoolEntry): IpcTabStatusPayload {
	const payload: IpcTabStatusPayload = {
		tabId: entry.tabId,
		cwd: entry.sidecar.cwd,
		kind: entry.kind,
		placeholder: entry.placeholder,
		sessionPath: entry.sessionFile ?? null,
		// "running" only makes sense on a live connection — a restarting sidecar
		// reports its connection state even with a dead in-flight run.
		status: entry.run.running && entry.status === "ready" ? "running" : entry.status,
	};
	if (entry.run.compacting !== undefined) payload.compacting = entry.run.compacting;
	if (entry.sessionId !== undefined) payload.sessionId = entry.sessionId;
	if (entry.title !== undefined) payload.title = entry.title;
	if (entry.task !== undefined) payload.task = entry.task;
	if (entry.worktree !== undefined) payload.worktree = entry.worktree;
	if (entry.lastRun !== undefined) payload.lastRun = entry.lastRun;
	if (entry.awaitingConnection) payload.awaitingConnection = true;
	if (entry.resuming) payload.resuming = true;
	if (entry.scheduledRetry) payload.scheduledRetry = entry.scheduledRetry;
	if (entry.device !== undefined) payload.device = entry.device;
	return payload;
}
