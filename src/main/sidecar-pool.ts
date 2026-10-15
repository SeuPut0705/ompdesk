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
import type { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import {
	IPC_EVENTS,
	type IpcOpenExtensionRequest,
	type IpcSessionOwner,
	type IpcSetTabViewPayload,
	type IpcTabInfo,
	type IpcTabStatusPayload,
	type IpcTabWorktree,
} from "../shared/ipc-types";
import {
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
import { createMessageUpdateSlimmer } from "./message-update-slim";
import { ompRestartDecision } from "./omp-restart";
import type { WindowTabFact } from "./quit-guard";
import type { RpcClient } from "./rpc-client";
import type { SidecarSessionIdentity, SidecarStartGate } from "./sidecar";
import { idleRun, type RunState, type RunTracking, runBusy, settleRun, trackRunEvent } from "./sidecar-run-state";
import { nextSnowflake } from "./snowflake";
import { createSubagentFrameBatcher } from "./subagent-frames";
import { type PersistedTabDescriptor, type PersistedTabLayout, TAB_LAYOUT_VERSION } from "./tab-layout";
import type { ResumeFact } from "./turn-resume";
import type { TabSpawnFacts } from "./worktree-lifecycle";

/**
 * What the pool, ipc.ts and the host-tool executor need from a tab's sidecar:
 * the local SidecarManager, or a RemoteSidecar whose omp runs on a paired host.
 * Events are SidecarManager's (see FRAME_EVENTS in sidecar.ts), re-emitted verbatim by remote ones.
 */
export interface SidecarLike extends Pick<EventEmitter, "on" | "off" | "once" | "removeAllListeners"> {
	readonly status: SidecarStatus;
	readonly statusPayload: SidecarStatusPayload;
	readonly cwd: string;
	readonly kind: "agent" | "chat";
	readonly rpcClient: Pick<RpcClient, "command"> | null;
	readonly processAlive: boolean;
	/** Paired host deviceId the omp runs on; absent for a local sidecar. */
	readonly device?: string;
	/** True while a remote sidecar's link to its host is down (commands fail with `remote_offline`). */
	readonly offline?: boolean;
	/** True while a paired host's tab emits a status it derived from its link (down, reconnecting) rather
	 * than one the host's omp reported: that omp, and the asks it holds, may still be alive. */
	readonly statusFromLink?: boolean;
	start(): void;
	restart(cwd?: string, resumeSessionPath?: string): void;
	adoptCwd(cwd: string): boolean;
	/** A local omp takes the frame at once. A paired host's tab returns a promise for a user's answer, and
	 * throws or rejects `remote_offline` (or the host's refusal) when the host did not take it (see RemoteSidecar). */
	sendSideChannel(frame: object): Promise<void> | void;
	syncImageGeneration(): void;
	/** Push this machine's reply-language setting to the live session (the omp's own machine decides). */
	syncReplyLanguage(): void;
	/** Push this machine's profile setting to the live session (the omp's own machine decides). */
	syncUserProfile(): void;
	/** Push this machine's account-rotation setting to the live omp (the omp's own machine decides). */
	syncAccountRotation(): void;
	dispose(): void;
	/** Local sidecars: hold the first spawn at `starting` until `gate` settles (worktree.onStart). */
	setStartGate?(gate: SidecarStartGate): void;
	/** Local sidecars: resolves once the omp process has exited. Call before dispose(). */
	whenExited?(): Promise<void>;
	/**
	 * Remote sidecars: the user's Cancel on the waiting row. The host holds this tab's connection
	 * wait (it emits `awaitingConnection`); rejects `remote_offline` while the host is unreachable.
	 */
	cancelHostWait?(): Promise<void>;
}

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

function forwardToWindow(win: BrowserWindow, channel: string, data: unknown): void {
	if (!win.isDestroyed()) win.webContents.send(channel, data);
}

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

/** `run`, `lastRun`, `stopped` and `retry` follow the sidecar's events (`trackRunEvent`). */
interface PoolEntry extends RunTracking {
	sidecar: SidecarLike;
	tabId: string;
	win: BrowserWindow;
	/** Paired host deviceId the tab runs on; undefined = this machine. Immutable; set at acquire. */
	device?: string;
	/** win.webContents.id, cached at acquire — safe to read after the window is destroyed. */
	winId: number;
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
	/**
	 * Session file this tab is attached to (F-OWN). Set at acquire when
	 * spawned with --session and maintained from the RPC passthrough via
	 * noteSessionFile; the reverse key of #sessionOwners.
	 */
	sessionFile?: string;
	/** The turn waits for the internet connection and continues once it is back (turn-resume.ts). */
	awaitingConnection?: boolean;
	/** The window "closed" listener registered at acquire, removed on release. */
	onWindowClosed: () => void;
	/** `omp update` landed while this tab ran a turn: it restarts on the new omp when the turn ends. */
	ompRestartPending?: boolean;
	/** Provider sign-ins (`login` commands) dispatched to this tab that have not answered yet. */
	signIns?: number;
	/**
	 * Detaches the full-channel forwarders. Null while the tab is background
	 * (nothing wired); set exactly once per active stint so switches move
	 * listeners without duplicating them.
	 */
	detachFull: (() => void) | null;
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
	readonly #factory: SidecarFactory;
	/** Suppress partial snapshots while a saved layout is being reconstructed. */
	#restoringWindows = new Set<number>();
	/**
	 * GUI host tools run against Electron in ipc.ts, which the pool cannot
	 * import without a cycle. Set once at startup; it answers every
	 * hostToolCall (shown or hidden tab), unknown tools with an explicit error.
	 */
	hostToolExecutor:
		| ((sidecar: SidecarLike, request: HostToolCallRequest, tab: { tabId: string; win: BrowserWindow }) => void)
		| null = null;
	/** Main-process persistence hook. The primary window installs this at startup. */
	onWindowTabsChanged: ((win: BrowserWindow, layout: PersistedTabLayout | null) => void) | null = null;
	/** Some tab may have started or finished running a turn (keep-awake while working). */
	onRunningChange: (() => void) | null = null;
	/**
	 * `worktree.onStart` (worktree-lifecycle.ts): the gate for a new tab, or null
	 * when the tab is not a candidate. Installed at startup.
	 */
	worktreeStartGate: ((tabId: string, winId: number, facts: TabSpawnFacts) => SidecarStartGate | null) | null = null;
	/** A tab was released (closed, or its window closed); `exited` settles once its omp is gone. */
	onTabReleased: ((tabId: string, exited: Promise<void>) => void) | null = null;

	constructor(factory: SidecarFactory) {
		this.#factory = factory;
	}

	get size(): number {
		return this.#entries.size;
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
		win: BrowserWindow,
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
				detachFull: null,
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

	/** Per-tab light wiring, attached for the entry's whole life: TAB_STATUS pushes. */
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
				if (!sidecar.statusFromLink)
					for (const [id, owner] of this.#requestOwners) {
						if (owner === entry) this.#requestOwners.delete(id);
					}
			}
			forwardToWindow(win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
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
			forwardToWindow(win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
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
			forwardToWindow(win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
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
				this.#requestOwners.set(request.id, entry);
				for (const id of this.#requestBodies.keys())
					if (!this.#requestOwners.has(id)) {
						this.#requestBodies.delete(id);
						this.#signInRequests.delete(id);
					}
				this.#requestBodies.set(request.id, request);
				if (entry.signIns && isSignInRequest(request)) this.#signInRequests.add(request.id);
				this.onRunningChange?.();
			}
			// omp withdrew the request (timeout, abort): no response will follow.
			else if (request.method === "cancel" && this.#requestOwners.get(request.targetId) === entry) {
				this.#requestOwners.delete(request.targetId);
				this.onRunningChange?.();
			}
			forwardToWindow(win, IPC_EVENTS.EXTENSION_UI, { tabId: entry.tabId, request });
		});
		// A hidden tab's subagents still start and finish: lifecycle frames keep
		// its runtime roster (the sidebar row's count) current. Progress frames
		// stay on the full channel; the roster is re-read when the tab is shown.
		sidecar.on("subagentFrame", (frame: SubagentFrame) => {
			if (entry.detachFull || frame.type !== "subagent_lifecycle") return;
			forwardToWindow(win, IPC_EVENTS.SUBAGENT_FRAMES, { tabId: entry.tabId, payload: [frame] });
		});
		// A tool call blocks the turn until answered, so a hidden tab's calls are answered too.
		sidecar.on("hostToolCall", (request: HostToolCallRequest) => {
			this.hostToolExecutor?.(sidecar, request, { tabId: entry.tabId, win });
		});
		const settle = (settled: boolean): void => {
			const wasBusy = runBusy(entry.run);
			settleRun(entry.run, settled);
			if (runBusy(entry.run) === wasBusy) return;
			forwardToWindow(win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
			this.onRunningChange?.();
			this.#scheduleOmpRestart(entry);
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
			for (const event of events) {
				if (trackRunEvent(entry, event)) runEnded = true;
				if (event.type === "agent_start") entry.placeholder = false;
				else if (event.type === "auto_retry_start") retryStarted = true;
				else if (event.type === "plan_proposal" && !entry.detachFull) {
					hiddenProposals ??= [];
					hiddenProposals.push(event);
				}
			}
			const busy = runBusy(entry.run);
			const busyChanged = busy !== wasBusy;
			// The resume rules first: a failure they turn into a connection wait reaches the
			// window already waiting, so it never shows (or notifies) as a failure first.
			if (busyChanged || runEnded || retryStarted) this.onRunningChange?.();
			if (busyChanged || entry.placeholder !== wasPlaceholder) {
				forwardToWindow(win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
			}
			if (busyChanged) this.#scheduleOmpRestart(entry);
			if (entry.placeholder !== wasPlaceholder) this.#notifyWindowTabsChanged(win);
			if (hiddenProposals) {
				forwardToWindow(win, IPC_EVENTS.EVENTS_BATCH, { tabId: entry.tabId, payload: hiddenProposals });
			}
		});
	}

	/**
	 * Full-channel wiring, attached only while the tab is visible in its window
	 * tab. Idempotent: an already-wired entry is left untouched, so a repeated
	 * setActiveTab cannot stack duplicate listeners.
	 *
	 * Being wired IS being shown, so this is where a deferred tab's process
	 * gets spawned — the one moment the pool knows the user can see it.
	 */
	#wireFull(entry: PoolEntry): void {
		if (entry.detachFull) return;
		this.#ensureStarted(entry);
		const { sidecar, win } = entry;
		const removers: (() => void)[] = [];
		const forwardActive = <T>(channel: string, payload: T): void => {
			forwardToWindow(win, channel, { tabId: entry.tabId, payload });
		};
		const wire = <T>(event: string, listener: (payload: T) => void): void => {
			sidecar.on(event, listener);
			removers.push(() => {
				sidecar.off(event, listener);
			});
		};
		// A fresh slimmer per attachment: the first update of each message after
		// the tab becomes visible keeps its full snapshot (it missed message_start).
		const slimMessageUpdates = createMessageUpdateSlimmer();
		const subagentFrames = createSubagentFrameBatcher(frames => forwardActive(IPC_EVENTS.SUBAGENT_FRAMES, frames));
		wire("subagentFrame", (frame: SubagentFrame) => subagentFrames.push(frame));
		wire("events", (events: AgentSessionEvent[]) => {
			// Subagent frames that arrived first leave first, as when each was sent alone.
			subagentFrames.flush();
			forwardActive(IPC_EVENTS.EVENTS_BATCH, slimMessageUpdates(events));
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
		entry.detachFull = () => {
			entry.detachFull = null;
			for (const remove of removers) remove();
			// Already received while shown: deliver them, as when each was sent alone.
			subagentFrames.flush();
		};
	}

	#syncFullWiring(winId: number): void {
		const visible = this.#visibleByWindow.get(winId) ?? new Set<string>();
		for (const entry of this.#entries) {
			if (entry.winId !== winId) continue;
			if (visible.has(entry.tabId)) this.#wireFull(entry);
			else entry.detachFull?.();
		}
	}

	/**
	 * Release a tab: listeners first, then dispose (a stale forwarder surviving
	 * into a sidecar.restart() would push events at a destroyed window). When
	 * the active tab goes away, the oldest surviving tab of the window takes
	 * over (the renderer may override with SET_ACTIVE_TAB); releasing the last
	 * tab leaves the window tab-less, back to its initial no-sidecar state.
	 */
	#releaseEntry(entry: PoolEntry): Promise<void> {
		if (!this.#entries.delete(entry)) return Promise.resolve();
		this.#byTabId.delete(entry.tabId);
		this.onRunningChange?.();
		this.#unregisterSessionFile(entry);
		// Drop pending request-id routes pointing at the released entry — a
		// late renderer response must fall back, never write to a dead sidecar.
		for (const [id, owner] of this.#requestOwners) {
			if (owner === entry) this.#requestOwners.delete(id);
		}
		// A destroyed window already dropped its one-shot "closed" listener.
		if (!entry.win.isDestroyed()) entry.win.removeListener("closed", entry.onWindowClosed);
		entry.sidecar.removeAllListeners();
		// Taken before dispose(), which forgets the child it kills.
		const exited = entry.sidecar.whenExited?.() ?? Promise.resolve();
		entry.sidecar.dispose();
		this.onTabReleased?.(entry.tabId, exited);
		const visible = this.#visibleByWindow.get(entry.winId);
		visible?.delete(entry.tabId);
		const split = this.#splitByWindow.get(entry.winId);
		if (split && splitTabIds(split).includes(entry.tabId)) {
			const remaining = asSplitLayout(mapSplitLeaves(split, tabId => (tabId === entry.tabId ? null : { tabId })));
			if (remaining) this.#splitByWindow.set(entry.winId, remaining);
			else this.#splitByWindow.delete(entry.winId);
		}
		const remembered = this.#rememberedByWindow.get(entry.winId);
		if (remembered) {
			const kept = forgetSplitTab(remembered, entry.tabId);
			if (kept.length > 0) this.#rememberedByWindow.set(entry.winId, kept);
			else this.#rememberedByWindow.delete(entry.winId);
		}
		if (![...this.#entries].some(candidate => candidate.winId === entry.winId)) {
			this.#activeByWindow.delete(entry.winId);
			this.#visibleByWindow.delete(entry.winId);
			this.#splitByWindow.delete(entry.winId);
			this.#rememberedByWindow.delete(entry.winId);
			return exited;
		}
		if (this.#activeByWindow.get(entry.winId) !== entry.tabId) {
			this.#syncFullWiring(entry.winId);
			return exited;
		}
		this.#activeByWindow.delete(entry.winId);
		// During window teardown every entry self-releases; activating a sibling
		// whose window is already gone would wire forwarders for nothing.
		if (entry.win.isDestroyed()) return exited;
		const candidates = [...this.#entries].filter(candidate => candidate.winId === entry.winId);
		const candidate = candidates.find(item => visible?.has(item.tabId)) ?? candidates[0];
		if (!candidate) {
			this.#visibleByWindow.delete(entry.winId);
			return exited;
		}
		if (!visible || visible.size === 0) this.#visibleByWindow.set(entry.winId, new Set([candidate.tabId]));
		this.#activeByWindow.set(entry.winId, candidate.tabId);
		this.#syncFullWiring(entry.winId);
		return exited;
	}

	/** The window's active entry (first entry as a fallback, e.g. mid-teardown). */
	entryForWindow(win: BrowserWindow): PoolEntry | undefined {
		const active = this.#byTabId.get(this.#activeByWindow.get(win.webContents.id) ?? "");
		if (active && active.win === win) return active;
		for (const entry of this.#entries) {
			if (entry.win === win) return entry;
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

	/** Resolves via the ACTIVE tab, so every existing ipc.ts handler keeps working unchanged. */
	sidecarForWindow(win: BrowserWindow): SidecarLike | null {
		return this.entryForWindow(win)?.sidecar ?? null;
	}

	/** The sidecar of one specific tab, scoped to the window that owns it. */
	sidecarForTab(win: BrowserWindow, tabId: string): SidecarLike | null {
		const entry = this.#byTabId.get(tabId);
		return entry && entry.win === win ? entry.sidecar : null;
	}

	/**
	 * One tab of `win` — `tabId`, or the window's active tab when omitted — with
	 * the device it runs on, so a handler can route a remote tab to its host.
	 */
	tabTarget(
		win: BrowserWindow,
		tabId?: string,
	): { tabId: string; sidecar: SidecarLike; device: string | undefined } | null {
		const entry = tabId ? this.#byTabId.get(tabId) : this.entryForWindow(win);
		if (!entry || entry.win !== win) return null;
		return { tabId: entry.tabId, sidecar: entry.sidecar, device: entry.device };
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

	/** Send a command to the idle tab attached to `sessionPath`; null while a run or compaction is in flight. */
	async commandForIdleSession(sessionPath: string, command: RpcCommand, device?: string): Promise<RpcResponse | null> {
		const owner = this.#sessionOwners.get(ownerKey(device, sessionPath));
		const entry = owner ? this.#byTabId.get(owner.tabId) : undefined;
		if (!entry || runBusy(entry.run)) return null;
		return this.commandForSession(sessionPath, command, device);
	}

	/** Make `tabId` the window's active tab (moves full event forwarding). False when unknown/foreign. */
	setActiveTab(win: BrowserWindow, tabId: string): boolean {
		return this.setTabView(win, tabId, [tabId]);
	}

	/** Atomically focus one tab and wire full streams for up to four visible tabs. */
	setTabView(
		win: BrowserWindow,
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
		for (const tabId of ids) {
			const entry = this.#byTabId.get(tabId);
			if (!entry || entry.win !== win) return false;
		}
		const winId = win.webContents.id;
		this.#activeByWindow.set(winId, focusedTabId);
		this.#visibleByWindow.set(winId, new Set(ids));
		if (parsed) this.#splitByWindow.set(winId, parsed);
		else this.#splitByWindow.delete(winId);
		// Remembered splits never share a session with what is on screen; a plain
		// focus switch (no list sent) keeps the others as they were.
		const remembered = readRememberedSplits(
			rememberedSplits ?? this.#rememberedByWindow.get(winId),
			tabId => (this.#byTabId.get(tabId)?.win === win ? tabId : null),
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
		forwardToWindow(entry.win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
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
	 * no process at all, so the file on disk is the entire session: a delete or
	 * rename must go to the filesystem instead of a `drop_session` /
	 * `set_session_name` with nobody to answer it — which `commandForSession`
	 * would refuse as if the process were still starting. `starting` counts as live: that
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
			forwardToWindow(entry.win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
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
		forwardToWindow(entry.win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
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
	 */
	async routeSideChannel(id: string, frame: object, tabId?: string): Promise<boolean> {
		const entry = tabId ? this.#byTabId.get(tabId) : this.#requestOwners.get(id);
		if (!entry) return false;
		await entry.sidecar.sendSideChannel(frame);
		if (this.#requestOwners.get(id) === entry) {
			this.#requestOwners.delete(id);
			this.onRunningChange?.();
		}
		return true;
	}

	/** The asks and approvals this window's tabs still wait on, for a page that loaded after they were raised. */
	openRequests(win: BrowserWindow): IpcOpenExtensionRequest[] {
		const open: IpcOpenExtensionRequest[] = [];
		for (const [id, request] of this.#requestBodies) {
			const owner = this.#requestOwners.get(id);
			if (!owner) {
				this.#requestBodies.delete(id);
				this.#signInRequests.delete(id);
			} else if (owner.win === win)
				open.push({
					tabId: owner.tabId,
					request,
					...(this.#signInRequests.has(id) ? { signIn: true as const } : {}),
				});
		}
		return open;
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
	activeTabForWindow(win: BrowserWindow): string | null {
		return this.#activeByWindow.get(win.webContents.id) ?? null;
	}

	/** The window's tabs in acquisition order (GET_TABS boot reconciliation). */
	tabsForWindow(win: BrowserWindow): IpcTabInfo[] {
		const tabs: IpcTabInfo[] = [];
		const activeTabId = this.#activeByWindow.get(win.webContents.id);
		const visibleTabIds = this.#visibleByWindow.get(win.webContents.id);
		const split = this.#splitByWindow.get(win.webContents.id);
		const remembered = this.#rememberedByWindow.get(win.webContents.id) ?? [];
		for (const entry of this.#entries) {
			if (entry.win !== win) continue;
			const tab = tabStatusPayload(entry);
			if (entry.tabId === activeTabId) tab.active = true;
			if (visibleTabIds?.has(entry.tabId)) tab.visible = true;
			if (split && visibleTabIds?.has(entry.tabId)) tab.split = split;
			const home = rememberedSplitOf(remembered, entry.tabId);
			if (home && splitTabIds(home)[0] === entry.tabId) tab.rememberedSplit = home;
			tabs.push(tab);
		}
		return tabs;
	}

	/**
	 * Put one window's tabs in `order` (tab overview drag, ⌘1…⌘9 positions);
	 * other windows' tabs keep their slots. False unless `order` names exactly
	 * the window's tabs once each. The saved layout follows.
	 */
	reorderWindowTabs(win: BrowserWindow, order: readonly string[]): boolean {
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

	/** A provider sign-in (`login`) started on, or answered from, this tab. */
	noteSignIn(tabId: string, active: boolean): void {
		const entry = this.#byTabId.get(tabId);
		if (entry) entry.signIns = Math.max(0, (entry.signIns ?? 0) + (active ? 1 : -1));
	}

	/** Show or clear the tab's "waiting for the internet connection" state. */
	setAwaitingConnection(tabId: string, awaiting: boolean): void {
		const entry = this.#byTabId.get(tabId);
		if (!entry || (entry.awaitingConnection === true) === awaiting) return;
		entry.awaitingConnection = awaiting;
		forwardToWindow(entry.win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
	}

	/** Spawn a deferred tab's process now (a background tab a relaunch must resume); the sidecar, or null for an unknown tab. */
	startTab(tabId: string): SidecarLike | null {
		const entry = this.#byTabId.get(tabId);
		if (!entry) return null;
		this.#ensureStarted(entry);
		return entry.sidecar;
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

	/** Serializable layout for the window, excluding transient run/status data. */
	tabLayoutForWindow(win: BrowserWindow): PersistedTabLayout | null {
		const entries = [...this.#entries].filter(entry => entry.win === win);
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
	restoreLayout(win: BrowserWindow, layout: PersistedTabLayout): number {
		const winId = win.webContents.id;
		this.#restoringWindows.add(winId);
		let restoredCount = 0;
		let firstRestoredTabId: string | undefined;
		let activeRestoredTabId: string | undefined;
		const restoredTabIds: string[] = [];
		try {
			for (const [index, tab] of layout.tabs.entries()) {
				const tabId = nextSnowflake();
				const sidecar = this.acquire(
					tab.cwd,
					win,
					tabId,
					tab.sessionPath,
					tab.kind,
					tab.worktree,
					!tab.sessionPath,
					tab.placeholder === true,
					true,
					tab.title,
					tab.device,
				);
				if (!sidecar) continue;
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

	#notifyWindowTabsChanged(win: BrowserWindow): void {
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
		this.#restoringWindows.clear();
	}
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
	if (entry.worktree !== undefined) payload.worktree = entry.worktree;
	if (entry.lastRun !== undefined) payload.lastRun = entry.lastRun;
	if (entry.awaitingConnection) payload.awaitingConnection = true;
	if (entry.device !== undefined) payload.device = entry.device;
	return payload;
}
