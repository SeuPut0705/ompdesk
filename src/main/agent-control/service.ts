/**
 * OMPdesk control tools (contract `src/shared/agent-control.ts`, definitions `tools.ts`): the TypeScript side of the
 * service. The rules, the tool bodies, the journals and the timers live in the Rust core
 * (`native/ompdesk/crates/core/src/agentctl/service`, and `runtime` for what the host did over the service's own
 * state); this file is what stays: `AgentControlHost`, main's seam to the app (the sidecar pool, the RPC dispatcher,
 * the tab spawn path, the windows' notifications and views, the cards), and `AgentControl`, the typed client that
 * opens one service in the core over a `CorePort`.
 *
 * The core asks main for what main alone holds (a command through the GUI's dispatcher, a spawn, a card, git on a
 * paired host, the schedules, the preferences), and reads what the TypeScript service read synchronously (the open
 * tabs and their windows, the switches, the summaries, who opened what, the tombstones) from the snapshot main hands
 * it: main pushes it when it observes a change and before every call, and every answer carries it.
 *
 * What a call may fail with crosses as the fault's code: `tool_error` is a `ToolError` (the message is the agent's
 * own). An ask main answers with a thrown error carries `ipcErrorCode(error)`, or `timeout` for an `RpcTimeoutError`,
 * which is how the core tells `session_running`, `remote_offline` and an unanswered command apart.
 *
 * Permission levels (Settings › Tools & extensions › OMPdesk control tools):
 *   always  list, read, send, wait, answer a question, show, notify, open sessions, stop/close/delete the sessions
 *           the caller opened.
 *   card    stopping or closing a session the caller did not open (only while "Let agents manage other sessions" is
 *           off), deleting a saved session it did not open (always: a delete cannot be undone), stopping a run it did
 *           not start (off), creating a schedule (off), starting an Autopilot run (off; always for ship release or the
 *           default branch): one card each.
 *   pref    `agentControlFull` ("Give agents full control of OMPdesk", default on; only a stored `false` is off)
 *           raises no card at all and lets an agent approve another session's tool approval. Off:
 *           `agentControlManage` (default on) lifts the cards marked off above; `agentControlApprove` (default on)
 *           lets an agent approve another session's tool approval (turned off, the answer is "사용자 승인이 필요해요").
 *           A session the user hid from agents refuses all, whatever the switches.
 *   never   accounts, settings, permissions (those go through `ompdesk_app`).
 */
import { z } from "zod";
import type { AutopilotStartOptions, AutopilotStatus } from "../../../resources/gui-bridge/modes/autopilot-contracts";
import type {
	AgentAppEvent,
	AgentControlToolName,
	AgentControlViewEvent,
	AgentReviewItem,
	AgentReviewResult,
	ClosedChild,
	PrivacyPane,
	SidebarView,
} from "../../shared/agent-control";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import type { IpcSavedFolder, IpcTabRunOutcome, IpcTabWorktree, TabStatus } from "../../shared/ipc-types";
import type {
	AgentMessage,
	ExtensionUIRequest,
	ExtensionUIResponse,
	ImageContent,
	RpcCommand,
	RpcResponse,
	TextContent,
} from "../../shared/rpc-types";
import type { ScheduleCreated, ScheduleDraft, SchedulesRequest, SchedulesState } from "../../shared/schedules";
import type { SessionSummary } from "../../shared/session-summary";
import type { SessionViewHandle } from "../../shared/session-view";
import type { FamilyEdits } from "../../shared/turn-edits";
import { CorePort } from "../core/ports";
import { CoreError, core } from "../core/process";
import { RpcTimeoutError } from "../rpc-client";
import type { Pace } from "../session-pace";
import type { FileEdits } from "../web/file-edit-reports";
import type { BranchEvidence, BranchFacts, LandingFacts, MergeOutcome, WorktreeRef, WorktreeRemoval } from "./branches";
import type { MailDelivery } from "./mail";
import { ARGS, looseArgs, type OpenOne } from "./tools";

export interface ControlAsk {
	id: string;
	request: ExtensionUIRequest;
}

/** One open tab of this app (any window), as the pool knows it. */
export interface ControlTab {
	tabId: string;
	/** "" while the session has no title. */
	title: string;
	cwd: string;
	/** The paired host's deviceId and name when the tab runs there. */
	device?: string;
	deviceName?: string;
	status: TabStatus;
	/** `error` because another live omp still holds its session; the tab opens it by itself once that omp lets go. */
	sessionHeld?: true;
	/** With `error` or `exited`: why, as the tab's omp or its paired host said it (`IpcTabInfo.message`). */
	failure?: string;
	/** `starting` that waits its turn in the start queue (`queued`) or for an omp slow to answer (`slow`). */
	startWait?: "queued" | "slow";
	/** A turn runs (stock run state as the pool tracks it). */
	busy: boolean;
	/**
	 * A relaunch is continuing its cut-off turn (TurnResume's "continuing" row): it runs again in a moment, so an
	 * opener in this state is not idle.
	 */
	resuming?: boolean;
	/** Open asks and approvals that wait for the person. */
	asks: ControlAsk[];
	/** A plan proposal that waits for approval (plan mode); answered like an ask with `ompdesk_session_answer`. */
	plan?: { title: string; planFilePath: string; generation?: number };
	/** The user hid this session from agents (Sidebar › Hide from other agents). */
	hidden: boolean;
	worktree?: IpcTabWorktree;
	/** The session file; absent until the session has one. */
	sessionPath?: string;
	/** What an agent opened the session for (`agentTaskTitle`) until it has a title. */
	task?: string;
	/** How its last finished turn ended; absent while one runs or before the first. */
	lastRun?: IpcTabRunOutcome;
	/** Opened by an agent's control tools, and not an Autopilot run or child (those close with their run). */
	autoClosable?: boolean;
	/** The person is looking at it: the focused tab, a visible pane, a viewer in another window or on a phone. */
	looked?: boolean;
	/** The person typed a draft into it or sent it a prompt of their own. */
	userTouched?: boolean;
	/** The person has a draft in its composer now (any window or device showing it). */
	drafting?: boolean;
	/**
	 * Opened by an agent before this launch (its opener is known only from the tab layout the relaunch restored): this
	 * launch saw neither its turns nor a person's prompt to it, so its transcript says how it ended.
	 */
	restored?: boolean;
	/** When its current turn started (epoch ms). */
	busySince?: number;
	/** The ids this session's tab had before relaunches, newest first (the saved tab layout): they still name it. */
	formerIds?: readonly string[];
	/**
	 * Only on a tab a paired web page owns: what that page's live connections say about unsaved Files edits in it
	 * (`tabCloseStep` decides what a close does with it).
	 */
	webEdits?: FileEdits;
}

/** Facts read by the authenticated view host, never supplied by a control-tool caller. */
export interface ViewCloseFacts {
	handle: SessionViewHandle;
	tab: ControlTab;
	enabled: boolean;
	manageEnabled: boolean;
	fullEnabled: boolean;
}

/** Actual views gathered from reachable hosts and the hosts whose roster could not be read. */
export interface ViewRoster {
	views: ViewCloseFacts[];
	unavailable: { viewHost: string; reason: string }[];
}

export interface ViewAuthorization {
	authorize(facts: ViewCloseFacts): Promise<void>;
	validate(): Promise<void>;
	release(): Promise<void>;
	current(): boolean;
}

const viewKey = z.string().min(1).max(200);
const viewText = z.string().max(65_536);
const viewAskBase = { type: z.literal("extension_ui_request"), id: viewKey, timeout: z.number().optional() };
const viewAsk = z.discriminatedUnion("method", [
	z.object({ ...viewAskBase, method: z.literal("select"), title: viewText, options: z.array(viewText).max(512) }),
	z.object({ ...viewAskBase, method: z.literal("confirm"), title: viewText, message: viewText }),
	z.object({
		...viewAskBase,
		method: z.literal("ask"),
		questions: z
			.array(
				z.object({
					id: viewKey,
					question: viewText,
					options: z.array(z.object({ label: viewText })).max(512),
					multi: z.boolean().optional(),
				}),
			)
			.max(128),
	}),
	z.object({ ...viewAskBase, method: z.literal("input"), title: viewText }),
	z.object({ ...viewAskBase, method: z.literal("editor"), title: viewText }),
]);
const viewCloseFactsSchema = z
	.object({
		handle: z
			.object({
				viewHost: viewKey,
				window: viewKey,
				tabId: viewKey,
				session: viewKey,
				incarnation: viewKey,
			})
			.strict(),
		tab: z.object({
			tabId: viewKey,
			title: viewText,
			cwd: z.string().max(4096),
			device: viewKey.optional(),
			deviceName: viewText.optional(),
			sessionPath: z.string().min(1).max(4096),
			status: z.enum(["asleep", "starting", "ready", "running", "exited", "error", "restarting", "waiting"]),
			busy: z.boolean(),
			resuming: z.boolean().optional(),
			asks: z.array(z.object({ id: viewKey, request: viewAsk })).max(128),
			plan: z
				.object({
					title: viewText,
					planFilePath: z.string().max(4096),
					generation: z.number().optional(),
				})
				.optional(),
			hidden: z.boolean(),
			looked: z.boolean().optional(),
			userTouched: z.boolean().optional(),
			drafting: z.boolean().optional(),
			webEdits: z.enum(["clean", "dirty", "unreported"]).optional(),
		}),
		enabled: z.boolean(),
		manageEnabled: z.boolean(),
		fullEnabled: z.boolean(),
	})
	.strict();

/** Validate receiver wire facts and project only the fields the view-close policy consumes. */
export function parseViewCloseFacts(value: unknown): ViewCloseFacts {
	return viewCloseFactsSchema.parse(value);
}

/** A saved session (stock's session index on this computer or a paired device), open in a tab or not. */
export interface StoredSession {
	/** Stock's session id. */
	id: string;
	path: string;
	title: string;
	firstMessage: string;
	cwd: string;
	/** ISO time of the last change. */
	modified: string;
	messages: number;
	status: string;
	/** This computer's user hid it from agents. */
	hidden: boolean;
	/** The paired host it is saved on; absent = this computer. */
	device?: string;
	deviceName?: string;
	/** The tab of this app that has it open. */
	tabId?: string;
	/**
	 * Open in a tab that is not this app's, on the computer it is saved on: that computer's own window, or a tab it runs
	 * for a paired device. Read from that computer's summaries (`AgentControlHost.stored`), the one answer the list, a
	 * read's header, a send and a reopen go by.
	 */
	elsewhere?: OpenElsewhere;
	/** Text around a search hit. */
	snippet?: string;
}

/** Where a saved session no tab of this app holds is open (`StoredSession.elsewhere`). */
export interface OpenElsewhere {
	/** The paired device whose tab there holds it (`SessionSummary.openFor`); absent: that computer's own window, or a host that does not say. */
	holder?: string;
	/** What that tab does now; absent while it is not known (a host that does not say, a link that is down, a tab not started). */
	work?: StoredWork;
}

/** What the tab holding a saved session elsewhere does with it: its turn, background work, an open ask, nothing. */
export type StoredWork = "turn" | "background" | "waiting" | "idle";

/** A paired host this computer can run sessions on (Settings › Devices). */
export interface ControlDevice {
	id: string;
	name: string;
	state: "connecting" | "online" | "offline";
}

/** What `host.spawn` is asked for. */
export interface SpawnRequest {
	folder?: string;
	/** A git worktree for the new session (`omp/agent/<slug>` branch off `base`, default the caller's HEAD). */
	worktree?: { branch?: string; base?: string };
	/** Where it runs: absent = the caller's machine, null = this computer, an id = that paired host. */
	device?: string | null;
	/** Open this saved session file instead of a new session. */
	sessionPath?: string;
	/** With `sessionPath`: its folder is gone and disk care saved it; restore that worktree, then open the session there. */
	restoreSaved?: true;
	/** Who asked for the session (Autopilot passes "autopilot-child"); the host records the caller tab as parent. */
	tag?: string;
	/**
	 * What the session was opened for (its brief's `Title:` line, else its first line): its row reads it until stock
	 * names the session. It rides the spawn, so no window ever hears of the tab without it.
	 */
	task?: string;
	/**
	 * With `sessionPath`: it is open in a tab elsewhere and the new tab views that one (`#join`). The host records no
	 * opener for it: it stays whoever's it was, never the caller's child.
	 */
	join?: true;
}

/** A session opened by `open`, handed to `beforeFirstPrompt` before its first message is sent. */
export interface OpenedChild {
	tabId: string;
	callerTabId: string;
	worktree?: { path: string; branch: string };
	tag?: string;
}

/** Autopilot's coordinator seen by `ompdesk_autopilot` (`host.ts` adapts `src/main/autopilot.ts`; absent where it is not). */
export interface AutopilotSource {
	/** The default branch of the folder's repository (a start on it, `main` or `master` asks the user). */
	plan(sourceTabId: string): Promise<{ defaultBranch: string | null }>;
	/** `Autopilot.handleCommand` start from the source tab; the new run tab is the caller's opened session. Rejects with a readable message. */
	start(
		callerTabId: string,
		sourceTabId: string,
		options: AutopilotStartOptions,
	): Promise<AutopilotStatus & { tabId: string }>;
	/** A run's whole status; `active: false` for a tab that is no run. */
	status(tabId: string): Promise<AutopilotStatus>;
	/** End (`now` false: after the cycle in flight) or Stop now (abort and pause). */
	stop(tabId: string, now: boolean): Promise<AutopilotStatus>;
}

/** An open tab and the window it is in (any stable key for the window: its id). */
export type HostTab = ControlTab & { window: string };

/** What the receiver's bridge says of message markers (`agent_control_sent`): its instance and the marks its journal holds. */
export interface SentAnswer {
	instance: string;
	journaled: string[];
}

/** What the receiver's bridge answers a report with: `{duplicate, journaled}` for an id it already holds or queued. */
export interface MailAnswer {
	duplicate?: boolean;
	journaled?: boolean;
}

/** The sessions deleted outside the control tools (`deleted-sessions.ts`), by file and computer and by saved id. */
export interface Tombstones {
	byPath: { path: string; device?: string; at: number }[];
	byId: Record<string, number>;
}

/** The Schedules service of one computer (`ScheduleService`'s `command` and `create`, or a paired host's over the link). */
export interface SchedulesHost {
	command(request: SchedulesRequest): Promise<SchedulesState>;
	create(draft: ScheduleDraft): Promise<ScheduleCreated>;
}

/**
 * What only an app that runs the core's own runtime hands over: how to reach a session the wake-up of a routine names,
 * and where what the runtime decided goes (the work board's list to the windows showing it, the opener's prompt
 * suggestions, the closed-children list main keeps, the end of a woken session's turn).
 */
export interface HostRuntime {
	/** The sweep of the opened sessions runs this often (ms); 0 turns the timer off. */
	sweepMs?: number;
	/**
	 * The tab holding `sessionPath` on this computer, started when it is asleep; the id of the tab that held it
	 * (null: none did, and the session was opened in a background tab of the front window). Rejects when there is no
	 * window to open it in or the open fails.
	 */
	reach(sessionPath: string): Promise<string | null>;
	reviewSent(tabId: string, review: AgentReviewResult): void;
	nextPromptChildren(tabId: string, children: { title: string; waiting?: true }[]): void;
	closedChildren(rows: ClosedChild[]): void;
	wakeDone(runId: string, result: { code: number | null; error?: string }): void;
}

/** What `ompdesk_app` needs from the app; `host.ts` builds it; the core's `agentctl/app` asks through it. */
export interface AppPorts {
	getPref(key: string): unknown;
	/** The paired host the calling session's tab runs on (its `device`); undefined = this computer. */
	device(callerTabId: string): string | undefined;
	/** Write a preference through `PREFS_SET` (its validation and side effects included). */
	setPref(callerTabId: string, key: string, value: unknown): Promise<void>;
	rpc(callerTabId: string, command: RpcCommand): Promise<RpcResponse>;
	/**
	 * Send an RPC command to an omp on the computer `device` names (a paired device by name or id as ompdesk_sessions
	 * lists it, or "local" = this computer): the caller's own session when it runs there, else another open session
	 * there, else a background session opened for the running action and closed and deleted after it. Rejects with a
	 * readable message when the device is unknown or unreachable.
	 */
	rpcOn(callerTabId: string, device: string, command: RpcCommand): Promise<RpcResponse>;
	invoke(callerTabId: string, channel: string, args: readonly unknown[]): Promise<unknown>;
	fire(callerTabId: string, channel: string, args: readonly unknown[]): void;
	send(callerTabId: string, event: AgentAppEvent): void;
	confirm(callerTabId: string, title: string, message: string): Promise<boolean>;
	manageEnabled(): boolean;
	/** `agentControlFull`: no card at all, and the agent-power switches become writable. */
	fullEnabled(): boolean;
	/** Journal a line in the caller's session. Best effort. */
	note(callerTabId: string, text: string): Promise<void>;
	text(key: "appTitle" | "appMessage" | "appChanged", params: Record<string, string>): string;
	/** The English or the Korean text, by the app's language. */
	localize(en: string, ko: string): string;
	/** What the person's sidebar holds of pins, aliases and project order (never the agent-hidden list). */
	sidebarView(): SidebarView;
	/** Open a macOS Privacy & Security pane (this computer's System Settings); rejects off macOS. */
	openPrivacyPane(pane: PrivacyPane): Promise<void>;
	callerTitle(callerTabId: string): string;
	/** `ompdesk_autopilot` itself (its card and folder rules); the app actions go through it, never around it. */
	autopilot(callerTabId: string, args: unknown): Promise<string>;
}

/** A file put on a computer: its path there, or why not (`code`: `file_too_large`, `upload_refused`, `unsupported`). */
export type Landing = { ok: true; path: string } | { ok: false; error: string; code?: string };

export interface AgentControlHost {
	/** Settings › Tools & extensions switch (this computer's). */
	enabled(): boolean;
	/** `agentControlFull` (default on): no card at all; implies `approveEnabled` and `manageEnabled`. */
	fullEnabled(): boolean;
	/** `agentControlApprove`, or full control: an agent may approve another session's tool approval. */
	approveEnabled(): boolean;
	/**
	 * What every row shows of the sessions a computer runs (this one when `device` is undefined, else that paired host's
	 * as this computer holds them): its windows' tabs and the ones it runs for paired devices. Empty while not known.
	 */
	summaries(device?: string): readonly SessionSummary[];
	/** `agentControlManage` (default on) or full control: an agent may stop or close sessions it did not open, merge, schedule and start Autopilot without a card; deleting a saved session it did not open asks unless full control is on. */
	manageEnabled(): boolean;
	/** The session that opened `tabId` (`ompdesk_session_open`), if any. */
	parentOf(tabId: string): string | undefined;
	/** The tag the open carried (Autopilot passes `autopilot-child`), if any. */
	parentTag?(tabId: string): string | undefined;
	/** The sessions working in `tabId`'s checkout or another worktree of its repository on this computer (`checkout-peers.ts`); `ompdesk_report` may go to them. */
	checkoutPeers?(tabId: string): readonly string[];
	/**
	 * Put one report into a session as a stock custom message (`ompdesk.mail`), delivered per `delivery`, and answer what
	 * the receiver's bridge said. A report to a caller outside OMPdesk goes to its event stream instead.
	 */
	mail(
		tabId: string,
		content: string | (TextContent | ImageContent)[],
		details: Record<string, unknown>,
		delivery: MailDelivery,
	): Promise<MailAnswer | undefined | void>;
	/**
	 * Put a file on the computer `tabId`'s session runs on, where its omp reads it by path (the upload folder a
	 * composer's attached file lands in; a paired host's through `host.files.upload`). A caller outside OMPdesk's id
	 * lands it on this computer.
	 */
	land?(tabId: string, name: string, bytes: Buffer): Promise<Landing>;
	/** A child's report changed what its opener's work board shows. */
	reviewChanged?(parentTabId: string): void;
	/** Every open tab of this app once, in the pool's order, with the window it is in (a tab of any window). */
	tabs(): HostTab[];
	/** Actual local and paired visible views, not execution or saved-session summaries. */
	listViews?(): Promise<ViewRoster>;
	/** Close only this exact view, after authorizing its host's current facts against the original caller. */
	closeView?(callerTabId: string, handle: SessionViewHandle): Promise<void>;
	/**
	 * Processes outside OMPdesk calling over the control socket (src/main/control-socket), by id: each has no tab, so it
	 * is this stand-in, never listed among `tabs`.
	 */
	outsideCallers?(): Record<string, ControlTab>;
	/** The window an outside caller acts through; undefined while the app has none open (its calls are refused). */
	outsideWindow?(): string | undefined;
	/** The paired hosts (Settings › Devices). */
	devices(): ControlDevice[];
	/** Saved sessions on this computer (device undefined) or a paired host; `query` searches titles and conversations. */
	stored(device: string | undefined, query?: string): Promise<StoredSession[]>;
	/** A saved session's transcript, read-only (this computer's stock helper, or the paired host). */
	storedMessages(session: StoredSession): Promise<AgentMessage[]>;
	/** How a saved or open session spent its time (session-pace.ts); undefined when unreadable. Never blocks a caller. */
	sessionPace?(session: { path: string; device?: string }): Promise<Pace | undefined>;
	/** A command through the GUI's RPC dispatcher for `tabId` (local handlers, host link, quota). */
	command(tabId: string, command: RpcCommand, timeoutMs?: number): Promise<RpcResponse>;
	/**
	 * Spawn a fresh tab in the caller's window on the caller's machine. Throws a readable error. `prepared`: what
	 * `.worktreeinclude` and `.ompdesk/worktree-setup` did in a new worktree (`describePreparation`).
	 */
	spawn(
		callerTabId: string,
		request: SpawnRequest,
	): Promise<{ tabId: string; attached?: boolean; worktree?: IpcTabWorktree; prepared?: string }>;
	/** Start a tab that has no process yet (a restored, not yet shown tab). */
	start(tabId: string): void;
	/** Name a tab that already exists (a relaunched one, from its saved session); a new one gets its task at the spawn. */
	setTask(tabId: string, task: string): void;
	view(callerTabId: string, event: AgentControlViewEvent): void;
	/**
	 * Release a tab a paired web page owns in main, as its own close would (worktree exit policy, terminals, the pool),
	 * and tell that page to drop it. False when nothing was released.
	 */
	release(callerTabId: string, tabId: string): Promise<boolean>;
	/** Resolves once the omp of a tab the window closed has exited (at once when none is exiting, and for a paired device's tab). */
	exited(tabId: string): Promise<void>;
	notify(callerTabId: string, title: string, body: string): void;
	/** A confirmation card on the calling tab; resolves false on refusal, dismissal or failure. */
	confirm(callerTabId: string, title: string, message: string): Promise<boolean>;
	/** Deliver the answer to the request the tab raised (the pool's side channel). */
	answer(tabId: string, requestId: string, response: ExtensionUIResponse): Promise<void>;
	/** Journal and show "answered by agent" in the session that was answered. Best effort. */
	markAnswered(tabId: string, byTitle: string): Promise<void>;
	/** Close a session's tab and delete its saved file (the sidebar's delete). */
	deleteSession(callerTabId: string, tabId: string): Promise<void>;
	/** Delete a saved session no tab of this app holds, on the device it is saved on (the sidebar's delete). */
	deleteStored(session: StoredSession): Promise<void>;
	/** Git facts of a session's worktree, read on `device` (absent = this computer). Rejects with a readable message. */
	branchFacts(worktree: WorktreeRef, device?: string): Promise<BranchFacts>;
	/**
	 * What a judge reads of a session's worktree on `device`: its diff against where it lands, cut to `diffChars`
	 * (0 = none), and a `git merge-tree` prediction of merging it into the parent's HEAD (nothing is touched).
	 */
	branchEvidence(worktree: WorktreeRef, diffChars: number, device?: string): Promise<BranchEvidence>;
	/** Merge the worktree's branch into its parent checkout on `device` (never pushed). */
	mergeBranch(worktree: WorktreeRef, label: string, device?: string): Promise<MergeOutcome>;
	/** What git on `device` says about a child's branch: its own commits, whether they landed, whether the worktree is clean. */
	landing(worktree: WorktreeRef, device?: string): Promise<LandingFacts>;
	/**
	 * Remove a clean worktree on `device` whose branch tip is in the parent's HEAD or upstream, and its branch at that very
	 * tip (never forced); `branch-kept` when the branch moved meanwhile.
	 */
	removeSafeWorktree(worktree: WorktreeRef, device?: string): Promise<WorktreeRemoval>;
	/** Take back on `device` a worktree and branch an open made and nobody used (a failed open; never forced). */
	discardWorktree(worktree: WorktreeRef, device?: string): Promise<WorktreeRemoval>;
	/** Remember a session closed after its work landed, so its opener's family still lists it. */
	recordClosed(child: ClosedChild): void;
	/** The sessions main closed after their work landed (`recordClosed`), newest last. */
	closedChildren?(): readonly ClosedChild[];
	/**
	 * Every tombstone (`deleted-sessions.ts`): when the session was deleted, from any path and any launch (the
	 * sidebar's Delete, `/delete`, a paired device), by its file and computer, or by its saved id alone.
	 */
	tombstones?(): Tombstones;
	/** Whether the Schedules service of this computer (no `device`) or of the paired host `device` exists. */
	hasSchedules?(device?: string): boolean;
	/** The Schedules service of this computer (no `device`) or of the paired host `device`, or null where there is none. */
	schedules(device?: string): SchedulesHost | null;
	/** The receiver's bridge about message markers (`agent_control_sent`); null when it cannot be asked. */
	sentMarks?(tabId: string, marks: string[]): Promise<SentAnswer | null>;
	/** Be called whenever any tab's run, ask or status changes; returns the unsubscribe. */
	observe(listener: () => void): () => void;
	/** Autopilot: a stop of the caller's work is in flight; nothing new may start. */
	isStopping?(callerTabId: string): boolean;
	/** Autopilot: awaited after the child is ready and before its first prompt; a throw closes the child and fails the open. */
	beforeFirstPrompt?(child: OpenedChild): Promise<void>;
	/** Autopilot's coordinator (`ompdesk_autopilot`); absent where there is none. */
	autopilot?: AutopilotSource;
	/** Card and label text in the person's language: `{name}` placeholders filled from `params` (left as written for none). */
	text(key: TextKey, params: Record<string, string>): string;
	/**
	 * What `ompdesk_app` needs from the app (settings, panels, IPC handlers); absent = the tools answer that they are not
	 * available.
	 */
	appPorts?: Omit<AppPorts, "autopilot" | "rpcOn" | "confirm" | "text" | "callerTitle" | "device">;
	/** The core's own runtime (sweeps, review pushes, redelivery); absent: the service alone, as a test of it runs. */
	runtime?: HostRuntime;
}

/** Every text key of `AgentControlHost.text`: their templates are what main's snapshot carries. */
export const TEXT_KEYS = [
	"stopTitle",
	"stopMessage",
	"closeMessage",
	"deleteMessage",
	"answeredBy",
	"mergeTitle",
	"mergeMessage",
	"scheduleTitle",
	"scheduleMessage",
	"autopilotTitle",
	"autopilotMessage",
	"autopilotShipCommit",
	"autopilotShipPush",
	"autopilotShipRelease",
	"autopilotBranchNew",
	"autopilotBranchDefault",
	"appTitle",
	"appMessage",
	"appChanged",
] as const;
export type TextKey = (typeof TEXT_KEYS)[number];

/** The saved session a released tab held (`TabActivity` `released`), with what only the host knows of it. */
export interface ReleasedSession {
	path: string;
	device?: string;
	title: string;
	cwd: string;
	formerIds: readonly string[];
	/** The person hid it from agents. */
	hidden?: boolean;
	/** The session file of the session whose agent opened it, when one did. */
	openedBySession?: string;
}

export interface ToolOutcome {
	text: string;
	isError: boolean;
}

/** What a tool call refused with: the agent's own message (`tool_error` from the core). */
export class ToolError extends Error {}

/** A stored session's recorded folder is gone (`folder-missing` from the tab spawn); `saved` = disk care kept it. */
export class SessionFolderMissing extends Error {
	constructor(
		readonly folder: string,
		readonly saved: IpcSavedFolder | null,
	) {
		super(
			`The folder this saved session belongs in no longer exists (${folder}); it is not opened in any other folder.`,
		);
	}
}

/** The session waits on someone: an open ask or approval, or a plan proposal awaiting approval (the control socket's `blocked`). */
export function waits(tab: ControlTab): boolean {
	return tab.asks.length > 0 || tab.plan !== undefined;
}

/** What the core waits for, in ms; every field defaults to the TypeScript service's own value (`tuning.rs`). */
export type Tuning = Partial<
	Record<
		| "openReadyRetryMs"
		| "openReadyPauseMs"
		| "pollMs"
		| "stateTimeoutMs"
		| "rpcOnTimeoutMs"
		| "nameLookupMs"
		| "autoCloseWaitMs"
		| "turnStartWaitMs"
		| "linkWaitMs"
		| "draftWaitMs"
		| "reattachWaitMs"
		| "linkPollMs"
		| "abortBeforeCloseMs"
		| "stopWaitMs"
		| "personTurnWaitMs"
		| "closeWaitMs"
		| "ompExitWaitMs"
		| "readyPollMs"
		| "resultPollMs"
		| "clearQueueMs"
		| "promptMs"
		| "judgeMs"
		| "whenGoneMs"
		| "mailCoalesceMs",
		number
	>
>;

/** What the core's runtime waits for, in ms (`RuntimeConfig`); the sweep period comes from `HostRuntime.sweepMs`. */
export interface RuntimeTuning {
	sweepSettleMs?: number;
	reviewSettleMs?: number;
	wakeTurnStartMs?: number;
}

/** Where the journals live (`<userData>/agent-*.json`): a path, or null for memory only; absent keeps none. */
export interface AgentControlFiles {
	/** What became of each session an id named (`session-fates`). */
	fates?: string | null;
	/** Cleanups refused while the person was in the session (`pending-cleanups`). */
	cleanups?: string | null;
	/** The control-tool calls that change something (`call-journal`). */
	calls?: string | null;
	/** Messages sent with `ompdesk_session_send` until the receiver's journal holds them (`send-outbox`). */
	sendOutbox?: string | null;
	/** Accepted reports until the receiver's journal holds them (`mail-outbox`); kept in memory when the runtime runs. */
	mailOutbox?: string | null;
	/** The bytes of the attachments an outbox entry still owes, by content (`<userData>/agent-attachments`). */
	attachments?: string | null;
}

export interface AgentControlOptions {
	files?: AgentControlFiles;
	tuning?: Tuning;
	runtime?: RuntimeTuning;
}

/** The longest a call may wait: a tool can wait on a card, a turn or a link for as long as it takes. */
const NO_TIMEOUT_MS = 2 ** 31 - 1;
/** A runtime's service is opened again this long after its core ended, until it opens. */
const REOPEN_MS = 1_000;
/** What an open's commands to its child are sent with: no deadline. */
const NO_DEADLINE = Number.POSITIVE_INFINITY;

/** What main's snapshot holds (`HostState` in the core), as JSON. */
interface HostSnapshot {
	enabled: boolean;
	fullEnabled: boolean;
	approveEnabled: boolean;
	manageEnabled: boolean;
	devices: ControlDevice[];
	closedChildren: ClosedChild[];
	tabs: ControlTab[];
	windowOf: Record<string, string>;
	outsideCallers: Record<string, ControlTab>;
	outsideWindow: string | null;
	parents: Record<string, { callerTabId: string; tag?: string }>;
	checkoutPeers: Record<string, string[]>;
	summaries: Record<string, readonly SessionSummary[]>;
	stopping: string[];
	deleted: Tombstones;
	scheduleDevices: string[];
	texts: Record<string, string>;
	app?: {
		manage: boolean;
		full: boolean;
		korean: boolean;
		sidebar: ReturnType<NonNullable<AppPortsLike["sidebarView"]>>;
	};
}

type AppPortsLike = NonNullable<AgentControlHost["appPorts"]>;

/** A handler's failure as the core reads it: `ipcErrorCode(error)`, or `timeout` for an RPC that never answered. */
async function coded<T>(run: () => T | Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		const code = ipcErrorCode(error) ?? (error instanceof RpcTimeoutError ? "timeout" : undefined);
		if (!code) throw error;
		throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code });
	}
}

/** A tell: nothing answers it, so a failure of main's handler stays main's. */
function told(run: () => void): void {
	try {
		run();
	} catch (error) {
		console.warn(`[agent-control] ${error instanceof Error ? error.message : String(error)}`);
	}
}

function issueText(issue: { path: PropertyKey[]; message: string }): string {
	return issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}

/** The core's `agentRuntime.*`: what the host did over the service's own state, by one service's port. */
export class RuntimeClient {
	readonly #control: AgentControl;

	constructor(control: AgentControl) {
		this.#control = control;
	}

	/** One tab activity the pool reported, with what only main knows at that moment (`activity.rs`). */
	activity(activity: Record<string, unknown>): Promise<void> {
		return this.#control.callRuntime("activity", { activity });
	}

	/** What `tabId`'s work board shows changed (a child's report reached it): its review is rebuilt after a short settle. */
	pushReview(tabId: string): Promise<void> {
		return this.#control.callRuntime("pushReview", { tabId });
	}

	/** A tool that may change what the work board shows ran for `tabId`: its review is rebuilt and the sweep looks again. */
	afterRun(tabId: string): Promise<void> {
		return this.#control.callRuntime("afterRun", { tabId });
	}

	/** A paired page's Files editor changed what it holds: a child it held back may close now. */
	sweepOpeners(): Promise<void> {
		return this.#control.callRuntime("sweepOpeners", {});
	}

	/** The work board's opened-session rows (empty while the control tools are off). */
	review(tabId: string): Promise<AgentReviewResult> {
		return this.#control.callRuntime("review", { tabId });
	}

	/** What the sessions `tabId` opened changed. */
	familyEdits(tabId: string, since?: number): Promise<FamilyEdits> {
		return this.#control.callRuntime("familyEdits", { tabId, ...(since === undefined ? {} : { since }) });
	}

	/** Reads a running child's step and cost again, and pushes the list when they moved. */
	liveReview(tabId: string): Promise<void> {
		return this.#control.callRuntime("liveReview", { tabId });
	}

	/** Drops the closed record of every deleted session. */
	forgetDeleted(): Promise<void> {
		return this.#control.callRuntime("forgetDeleted", {});
	}

	/** The host took the result of host call `callId`: its record may be forgotten in time. */
	acknowledge(callId: string): Promise<void> {
		return this.#control.callRuntime("acknowledge", { callId });
	}

	/** Delivers a routine's wake-up to a session and follows its turn; `wakeDone` tells how it ended. */
	wake(args: {
		runId: string;
		sessionPath: string;
		fromTitle: string;
		text: string;
		stoppedCode: number;
	}): Promise<void> {
		return this.#control.callRuntime("wake", args);
	}

	/** Stops a run waiting for its turn: who held the session, and whether its turn had started. */
	wakeStop(runId: string): Promise<{ holder: string | null; started: boolean }> {
		return this.#control.callRuntime("wakeStop", { runId });
	}
}

/**
 * One agent-control service in the core, over `host`. Every public method is one call to it; a core that started
 * again holds no instance of this port, so a call that finds none opens it again once.
 */
export class AgentControl {
	readonly #host: AgentControlHost;
	readonly #options: AgentControlOptions;
	readonly #port: CorePort<HostSnapshot>;
	readonly #unobserve: () => void;
	readonly runtime = new RuntimeClient(this);
	#opened: Promise<void> | null = null;
	#closed = false;
	#last: HostSnapshot | null = null;

	constructor(host: AgentControlHost, options: AgentControlOptions = {}) {
		this.#host = host;
		this.#options = options;
		this.#port = new CorePort<HostSnapshot>(this.#handlers(), () => this.#snapshot());
		this.#unobserve = host.observe(() => this.#port.push());
		// The core's runtime has timers of its own (the sweep of the opened sessions, redelivery): it runs from the
		// start, not from the first call.
		if (host.runtime) this.#keepOpen();
	}

	/** Opens the service now, and again after a core that ended, until it is closed. */
	#keepOpen(): void {
		this.#open().then(
			() => undefined,
			() => this.#retryOpen(),
		);
	}

	#retryOpen(): void {
		if (this.#closed) return;
		setTimeout(() => this.#keepOpen(), REOPEN_MS).unref();
	}

	/** Main observed a change in what the service reads of it: the core reads the new state from now on. */
	changed(): void {
		this.#port.push();
	}

	/** Closes the service in the core: what it still waits on fails. */
	close(): void {
		this.#closed = true;
		this.#unobserve();
		this.#port.close();
		core()
			.call("agentControl.close", { port: this.#port.id })
			.catch(() => undefined);
	}

	/** Live tabs `callerTabId` opened. */
	childrenOf(callerTabId: string): Promise<string[]> {
		return this.#call("childrenOf", { callerTabId });
	}

	/**
	 * A child showed a question card: its opener hears of it as one question in its session, so it can answer with
	 * ompdesk_session_answer or ask the user instead of finding the card by polling.
	 */
	childAsked(openerTabId: string, childTabId: string, requestId: string): Promise<void> {
		return this.#call("childAsked", { openerTabId, childTabId, requestId });
	}

	/** Drop a tab's queued steers and follow-ups; the turn that runs is left alone. */
	clearQueue(tabId: string): Promise<void> {
		return this.#call("clearQueue", { tabId });
	}

	/**
	 * A tab closed. `session`: the saved session it held, when nobody closed it through the control tools (those record
	 * who did): its ids keep naming that session.
	 */
	released(tabId: string, session?: ReleasedSession): Promise<void> {
		return this.#call("released", { tabId, ...(session ? { session } : {}) });
	}

	/** Programmatic open (Autopilot): the same path as the tool, with a tag the tool never sets. */
	openSessions(callerTabId: string, sessions: readonly OpenOne[], tag?: string): Promise<string[]> {
		return this.#call("openSessions", { callerTabId, sessions, ...(tag ? { tag } : {}) });
	}

	/**
	 * Run one control-tool call. `call` is the host tool call: its id (stock's, the same when a paired host re-sends the
	 * call after this computer relaunched) and whether the host says it re-sends one it had handed a connection before
	 * (`resent`). A call that changes something is recorded under the caller's session file and that id, so it runs at
	 * most once; a re-sent one this computer has no record of is reconciled like a pending one and never run blindly.
	 */
	run(
		callerTabId: string,
		tool: AgentControlToolName,
		args: unknown,
		call?: { id: string; resent?: boolean },
	): Promise<ToolOutcome> {
		return this.#call("run", {
			callerTabId,
			tool,
			args,
			...(call ? { call: { id: call.id, resent: call.resent === true } } : {}),
		});
	}

	/** Trusted main-only challenge callback. It authorizes, but never releases a view or changes a session. */
	authorizeView(callerTabId: string, view: ViewCloseFacts, localViewHost: string): Promise<string> {
		return this.#call("authorizeView", { callerTabId, view, localViewHost });
	}

	validateViewAuthorization(receipt: string, handle: SessionViewHandle): Promise<void> {
		return this.#call("validateViewAuthorization", { receipt, handle });
	}

	releaseViewAuthorization(receipt: string): Promise<void> {
		return this.#call("releaseViewAuthorization", { receipt });
	}

	/**
	 * The open session `session` names for `callerTabId`, by the tools' own name rules, refused when hidden from
	 * agents (the control socket's waits). Rejects with the tools' own message.
	 */
	openTarget(callerTabId: string, session: string): Promise<ControlTab> {
		return this.#call("openTarget", { callerTabId, session });
	}

	/** The person typed a prompt to `tabId`: what its omp keeps of cleanups refused while they were in the session is sent. */
	personTyped(tabId: string): Promise<void> {
		return this.#call("personTyped", { tabId });
	}

	/** Messages an omp held and lost go to the omp that holds the receiver's session now. */
	redeliverSends(): Promise<void> {
		return this.#call("redeliverSends", {});
	}

	reviewItems(callerTabId: string): Promise<AgentReviewItem[]> {
		return this.#call("reviewItems", { callerTabId });
	}

	review(callerTabId: string): Promise<AgentReviewResult> {
		return this.#call("review", { callerTabId });
	}

	familyEdits(callerTabId: string, since?: number): Promise<FamilyEdits> {
		return this.#call("familyEdits", { callerTabId, ...(since === undefined ? {} : { since }) });
	}

	liveReview(
		callerTabId: string,
		last: AgentReviewResult,
		only?: ReadonlySet<string> | readonly string[],
	): Promise<AgentReviewResult | null> {
		return this.#call("liveReview", { callerTabId, last, ...(only ? { only: [...only] } : {}) });
	}

	/** One pass over the sessions `callerTabId` opened whose work landed. */
	autoClose(callerTabId: string): Promise<void> {
		return this.#call("autoClose", { callerTabId });
	}

	/** Called by `RuntimeClient`. */
	callRuntime<T>(method: string, args: Record<string, unknown>): Promise<T> {
		return this.#invoke(`agentRuntime.${method}`, args, true);
	}

	#call<T>(method: string, args: Record<string, unknown>): Promise<T> {
		return this.#invoke("agentControl.call", { method, args }, true);
	}

	async #invoke<T>(wire: string, params: Record<string, unknown>, retry: boolean): Promise<T> {
		await this.#open();
		// What the call reads of main is main as it is now: the core applies a push in the order main wrote it, so the
		// call that follows starts on it.
		this.#port.push();
		try {
			return (await core().call<T>(wire, { port: this.#port.id, ...params }, { timeoutMs: NO_TIMEOUT_MS })).result;
		} catch (error) {
			if (!(error instanceof CoreError)) throw error;
			if ((error.code === "no_instance" || error.code === "no_runtime") && retry) {
				this.#opened = null;
				return this.#invoke(wire, params, false);
			}
			if (error.code === "tool_error") throw new ToolError(error.message);
			throw error;
		}
	}

	#open(): Promise<void> {
		this.#opened ??= this.#start().then(
			() => undefined,
			error => {
				this.#opened = null;
				throw error;
			},
		);
		return this.#opened;
	}

	async #start(): Promise<void> {
		const host = this.#host;
		const files = this.#options.files ?? {};
		const file = (path: string | null | undefined) => (path === undefined ? undefined : { file: path });
		const sweepMs = host.runtime?.sweepMs;
		await core().call("agentControl.open", {
			port: this.#port.id,
			...this.#port.first(),
			files: {
				...(files.fates ? { fates: files.fates } : {}),
				...(files.cleanups ? { cleanups: files.cleanups } : {}),
				...(files.calls !== undefined ? { calls: file(files.calls) } : {}),
				...(files.sendOutbox !== undefined ? { sendOutbox: file(files.sendOutbox) } : {}),
				...(files.mailOutbox !== undefined || host.runtime ? { mailOutbox: file(files.mailOutbox ?? null) } : {}),
				...(files.attachments ? { attachments: files.attachments } : {}),
			},
			caps: {
				reviewChanged: host.reviewChanged !== undefined,
				sessionPace: host.sessionPace !== undefined,
				sentMarks: host.sentMarks !== undefined,
				beforeFirstPrompt: host.beforeFirstPrompt !== undefined,
				autopilot: host.autopilot !== undefined,
				appPorts: host.appPorts !== undefined,
			},
			tuning: this.#options.tuning ?? {},
			...(host.runtime
				? { runtime: { ...(sweepMs === undefined ? {} : { sweepMs }), ...this.#options.runtime } }
				: {}),
		});
		// A core that ends takes the service with it: the next call opens it again.
		this.#port.held().catch(() => {
			this.#opened = null;
			if (this.#host.runtime) this.#retryOpen();
		});
	}

	/** Main's synchronous reads, at this moment (`HostState`). A read that throws leaves the last good snapshot. */
	#snapshot(): HostSnapshot {
		try {
			this.#last = this.#build();
		} catch (error) {
			if (!this.#last) throw error;
			console.warn(`[agent-control] snapshot: ${error instanceof Error ? error.message : String(error)}`);
		}
		return this.#last as HostSnapshot;
	}

	#build(): HostSnapshot {
		const host = this.#host;
		const hosted = host.tabs();
		const tabs: ControlTab[] = [];
		const windowOf: Record<string, string> = {};
		for (const { window, ...tab } of hosted) {
			tabs.push(tab);
			windowOf[tab.tabId] = window;
		}
		const devices = host.devices();
		const parents: HostSnapshot["parents"] = {};
		const checkoutPeers: HostSnapshot["checkoutPeers"] = {};
		const stopping: string[] = [];
		for (const tab of tabs) {
			const parent = host.parentOf(tab.tabId);
			if (parent !== undefined) {
				const tag = host.parentTag?.(tab.tabId);
				parents[tab.tabId] = { callerTabId: parent, ...(tag === undefined ? {} : { tag }) };
			}
			const peers = host.checkoutPeers?.(tab.tabId) ?? [];
			if (peers.length > 0) checkoutPeers[tab.tabId] = [...peers];
			if (host.isStopping?.(tab.tabId) === true) stopping.push(tab.tabId);
		}
		// This computer's rows, each paired host's, and a host a tab still runs on that is no longer paired.
		const computers = new Set<string>(devices.map(device => device.id));
		for (const tab of tabs) if (tab.device) computers.add(tab.device);
		const summaries: HostSnapshot["summaries"] = { "": host.summaries() };
		for (const device of computers) summaries[device] = host.summaries(device);
		const texts: Record<string, string> = {};
		for (const key of TEXT_KEYS) texts[key] = host.text(key, {});
		const app = host.appPorts;
		return {
			enabled: host.enabled(),
			fullEnabled: host.fullEnabled(),
			approveEnabled: host.approveEnabled(),
			manageEnabled: host.manageEnabled(),
			devices,
			closedChildren: [...(host.closedChildren?.() ?? [])],
			tabs,
			windowOf,
			outsideCallers: host.outsideCallers?.() ?? {},
			outsideWindow: host.outsideWindow?.() ?? null,
			parents,
			checkoutPeers,
			summaries,
			stopping,
			deleted: host.tombstones?.() ?? { byPath: [], byId: {} },
			scheduleDevices: ["", ...devices.map(device => device.id)].filter(
				device => host.hasSchedules?.(device === "" ? undefined : device) === true,
			),
			texts,
			...(app
				? {
						app: {
							manage: app.manageEnabled(),
							full: app.fullEnabled(),
							korean: app.localize("en", "ko") === "ko",
							sidebar: app.sidebarView(),
						},
					}
				: {}),
		};
	}

	/** What the core asks of main (`host.rs`), by the TypeScript host method's own name. */
	#handlers() {
		const host = this.#host;
		const apps = () => {
			const app = host.appPorts;
			if (!app) throw new Error("App actions are not available here.");
			return app;
		};
		const schedules = (device: string | null | undefined) => {
			const source = host.schedules(device ?? undefined);
			if (!source) throw new Error("Schedules are not available here.");
			return source;
		};
		const autopilot = () => {
			if (!host.autopilot) throw new Error("Autopilot is not available here.");
			return host.autopilot;
		};
		const device = (value: string | null | undefined) => value ?? undefined;
		// A tell's effect (a tab closed or started, a name set) changes what main holds: the core reads it from the
		// snapshot pushed right after, the one a step that waits for that effect looks at.
		const tell = (run: () => void) => {
			told(run);
			this.#port.push();
		};
		return {
			"args.parse": ({ tool, args, loose }: { tool: AgentControlToolName; args: unknown; loose: boolean }) =>
				coded(() => {
					// A model's JSON written as text is read as what it spells, for every tool and nesting; the
					// parser's output (trimmed, defaults applied) is what the tool body reads.
					const parsed = ARGS[tool].safeParse(loose ? (looseArgs(tool, args) ?? {}) : args);
					if (parsed.success) return { ok: true, args: parsed.data };
					return {
						ok: false,
						error: loose
							? `Invalid arguments for ${tool}: ${parsed.error.issues.map(issueText).join("; ")}`
							: `Invalid arguments: ${parsed.error.issues.map(issue => issue.message).join("; ")}`,
					};
				}),
			mail: ({
				tabId,
				content,
				details,
				delivery,
			}: {
				tabId: string;
				content: string | (TextContent | ImageContent)[];
				details: Record<string, unknown>;
				delivery: MailDelivery;
			}) => coded(async () => (await host.mail(tabId, content, details, delivery)) ?? null),
			land: ({ tabId, name, dataBase64 }: { tabId: string; name: string; dataBase64: string }) =>
				coded(async () => {
					if (!host.land)
						return { ok: false, error: "This OMPdesk cannot put files on a computer", code: "unsupported" };
					return host.land(tabId, name, Buffer.from(dataBase64, "base64"));
				}),
			command: ({
				tabId,
				command,
				timeoutMs,
				noDeadline,
			}: {
				tabId: string;
				command: RpcCommand;
				timeoutMs?: number;
				noDeadline?: boolean;
			}) => coded(() => host.command(tabId, command, noDeadline ? NO_DEADLINE : timeoutMs)),
			spawn: ({ callerTabId, request }: { callerTabId: string; request: SpawnRequest }) =>
				coded(async () => {
					try {
						return await host.spawn(callerTabId, request);
					} catch (error) {
						if (error instanceof SessionFolderMissing)
							return { folderMissing: { folder: error.folder, saved: error.saved } };
						throw error;
					}
				}),
			release: ({ callerTabId, tabId }: { callerTabId: string; tabId: string }) =>
				coded(() => host.release(callerTabId, tabId)),
			listViews: () => coded(async () => (await host.listViews?.()) ?? { views: [], unavailable: [] }),
			closeView: ({ callerTabId, handle }: { callerTabId: string; handle: SessionViewHandle }) =>
				coded(async () => {
					if (!host.closeView) throw new Error("Exact view closing is not available here.");
					await host.closeView(callerTabId, handle);
					return null;
				}),
			exited: ({ tabId }: { tabId: string }) => coded(async () => (await host.exited(tabId)) ?? null),
			markAnswered: ({ tabId, byTitle }: { tabId: string; byTitle: string }) =>
				coded(async () => (await host.markAnswered(tabId, byTitle)) ?? null),
			deleteSession: ({ callerTabId, tabId }: { callerTabId: string; tabId: string }) =>
				coded(async () => (await host.deleteSession(callerTabId, tabId)) ?? null),
			deleteStored: ({ session }: { session: StoredSession }) =>
				coded(async () => (await host.deleteStored(session)) ?? null),
			confirm: ({ callerTabId, title, message }: { callerTabId: string; title: string; message: string }) =>
				coded(() => host.confirm(callerTabId, title, message)),
			answer: ({
				tabId,
				requestId,
				response,
			}: {
				tabId: string;
				requestId: string;
				response: ExtensionUIResponse;
			}) => coded(async () => (await host.answer(tabId, requestId, response)) ?? null),
			stored: ({ device: where, query }: { device?: string | null; query?: string | null }) =>
				coded(() => host.stored(device(where), query ?? undefined)),
			storedMessages: ({ session }: { session: StoredSession }) => coded(() => host.storedMessages(session)),
			sessionPace: ({ path, device: where }: { path: string; device?: string | null }) =>
				coded(async () => (await host.sessionPace?.({ path, ...(where ? { device: where } : {}) })) ?? null),
			branchFacts: ({ worktree, device: where }: { worktree: WorktreeRef; device?: string | null }) =>
				coded(() => host.branchFacts(worktree, device(where))),
			landing: ({ worktree, device: where }: { worktree: WorktreeRef; device?: string | null }) =>
				coded(() => host.landing(worktree, device(where))),
			branchEvidence: ({
				worktree,
				diffChars,
				device: where,
			}: {
				worktree: WorktreeRef;
				diffChars: number;
				device?: string | null;
			}) => coded(() => host.branchEvidence(worktree, diffChars, device(where))),
			mergeBranch: ({
				worktree,
				label,
				device: where,
			}: {
				worktree: WorktreeRef;
				label: string;
				device?: string | null;
			}) => coded(() => host.mergeBranch(worktree, label, device(where))),
			removeSafeWorktree: ({ worktree, device: where }: { worktree: WorktreeRef; device?: string | null }) =>
				coded(async () => (await host.removeSafeWorktree(worktree, device(where))) ?? null),
			discardWorktree: ({ worktree, device: where }: { worktree: WorktreeRef; device?: string | null }) =>
				coded(async () => (await host.discardWorktree(worktree, device(where))) ?? null),
			sentMarks: ({ tabId, marks }: { tabId: string; marks: string[] }) =>
				coded(async () => (await host.sentMarks?.(tabId, marks)) ?? null),
			beforeFirstPrompt: ({ child }: { child: OpenedChild }) =>
				coded(async () => (await host.beforeFirstPrompt?.(child)) ?? null),
			"autopilot.plan": ({ sourceTabId }: { sourceTabId: string }) => coded(() => autopilot().plan(sourceTabId)),
			"autopilot.start": ({
				callerTabId,
				sourceTabId,
				options,
			}: {
				callerTabId: string;
				sourceTabId: string;
				options: AutopilotStartOptions;
			}) => coded(() => autopilot().start(callerTabId, sourceTabId, options)),
			"autopilot.status": ({ tabId }: { tabId: string }) => coded(() => autopilot().status(tabId)),
			"autopilot.stop": ({ tabId, now }: { tabId: string; now: boolean }) =>
				coded(() => autopilot().stop(tabId, now)),
			"schedules.command": ({ device: where, request }: { device?: string | null; request: SchedulesRequest }) =>
				coded(() => schedules(where).command(request)),
			"schedules.create": ({ device: where, draft }: { device?: string | null; draft: ScheduleDraft }) =>
				coded(() => schedules(where).create(draft)),
			"appPorts.getPref": ({ key }: { key: string }) =>
				coded(() => {
					const value = apps().getPref(key);
					return value === undefined ? null : value;
				}),
			"appPorts.setPref": ({ tabId, key, value }: { tabId: string; key: string; value: unknown }) =>
				coded(async () => (await apps().setPref(tabId, key, value)) ?? null),
			"appPorts.rpc": ({ tabId, command }: { tabId: string; command: RpcCommand }) =>
				coded(() => apps().rpc(tabId, command)),
			"appPorts.invoke": ({ tabId, channel, args }: { tabId: string; channel: string; args: unknown[] }) =>
				coded(async () => (await apps().invoke(tabId, channel, args)) ?? null),
			"appPorts.note": ({ tabId, text }: { tabId: string; text: string }) =>
				coded(async () => (await apps().note(tabId, text)) ?? null),
			"appPorts.openPrivacyPane": ({ pane }: { pane: Parameters<AppPortsLike["openPrivacyPane"]>[0] }) =>
				coded(async () => (await apps().openPrivacyPane(pane)) ?? null),
			reach: ({ sessionPath }: { sessionPath: string }) => {
				const runtime = host.runtime;
				if (!runtime) throw new Error("This app runs no core runtime.");
				return coded(() => runtime.reach(sessionPath));
			},
			// Tells: nothing answers them.
			start: ({ tabId }: { tabId: string }) => tell(() => host.start(tabId)),
			setTask: ({ tabId, task }: { tabId: string; task: string }) => tell(() => host.setTask(tabId, task)),
			view: ({ callerTabId, event }: { callerTabId: string; event: AgentControlViewEvent }) =>
				tell(() => host.view(callerTabId, event)),
			notify: ({ callerTabId, title, body }: { callerTabId: string; title: string; body: string }) =>
				told(() => host.notify(callerTabId, title, body)),
			reviewChanged: ({ parentTabId }: { parentTabId: string }) => told(() => host.reviewChanged?.(parentTabId)),
			recordClosed: ({ child }: { child: ClosedChild }) => tell(() => host.recordClosed(child)),
			"appPorts.fire": ({ tabId, channel, args }: { tabId: string; channel: string; args: unknown[] }) =>
				tell(() => apps().fire(tabId, channel, args)),
			"appPorts.send": ({ tabId, event }: { tabId: string; event: Parameters<AppPortsLike["send"]>[1] }) =>
				told(() => apps().send(tabId, event)),
			reviewSent: ({ tabId, review }: { tabId: string; review: AgentReviewResult }) =>
				told(() => host.runtime?.reviewSent(tabId, review)),
			nextPromptChildren: ({ tabId, children }: { tabId: string; children: { title: string; waiting?: true }[] }) =>
				told(() => host.runtime?.nextPromptChildren(tabId, children)),
			closedChildren: ({ rows }: { rows: ClosedChild[] }) => tell(() => host.runtime?.closedChildren(rows)),
			wakeDone: ({ runId, code, error }: { runId: string; code: number | null; error?: string }) =>
				told(() => host.runtime?.wakeDone(runId, { code, ...(error === undefined ? {} : { error }) })),
		};
	}
}
