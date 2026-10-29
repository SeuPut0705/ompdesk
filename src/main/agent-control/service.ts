/**
 * OMPdesk control tools (contract `src/shared/agent-control.ts`, definitions `tools.ts`): what a call does, against
 * an `AgentControlHost` (`host.ts`) implemented over the sidecar pool, so the rules are testable without Electron.
 *
 * Every action goes through what the GUI already does for a person: the RPC dispatcher for prompts, steers,
 * follow-ups, aborts and mode commands (a paired host's tab: over the link, where the host's per-device model
 * limit and refusals apply), the tab spawn path for a new session, the renderer's own pick/split/close for the
 * view, the window's notifications, and a stock extension-UI confirmation card for what needs the person.
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
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SessionSpend } from "../../../resources/gui-bridge/model-setup-contracts";
import type {
	AutopilotShipPreset,
	AutopilotStartOptions,
	AutopilotStatus,
} from "../../../resources/gui-bridge/modes/autopilot-contracts";
import {
	AGENT_CARD_PREFIX,
	AGENT_SCHEDULE_PREFIX,
	type AgentChildUsage,
	type AgentControlToolName,
	type AgentControlViewEvent,
	type AgentReviewItem,
	type AgentReviewResult,
	agentTaskTitle,
	type ClosedChild,
	type CostSplit,
	costSplitOf,
	parseAgentMessage,
	parseWorkerResult,
	AGENT_CONTROL_TOOLS as T,
	wrapAgentMessage,
} from "../../shared/agent-control";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import type { IpcSavedFolder, IpcTabRunOutcome, IpcTabWorktree, TabStatus } from "../../shared/ipc-types";
import type {
	AgentMessage,
	ExtensionUIRequest,
	ExtensionUIResponse,
	MessageContent,
	MessagesPage,
	ModelInfo,
	RpcCommand,
	RpcResponse,
	RpcSessionState,
	SubagentSnapshot,
	TodoPhase,
} from "../../shared/rpc-types";
import type { ScheduleDraft, ScheduleFrequency } from "../../shared/schedules";
import { APPROVE_DENY, approvalChoices } from "../../shared/tool-approval";
import {
	type FamilyEdits,
	type FamilyMemberEdits,
	isGitUnlanded,
	isTurnEdits,
	type RpcTurnEdits,
	turnEdits,
} from "../../shared/turn-edits";
import type { FileEdits } from "../web/file-edit-reports";
import { AppControl, type AppPorts, AppRefusal } from "./app-control";
import { type AutoCloseFacts, autoCloseDecision } from "./auto-close";
import {
	type BranchEvidence,
	type BranchFacts,
	boundDiff,
	type LandingFacts,
	type MergeOutcome,
	type MergePrediction,
	mergeProblem,
	type WorktreeRef,
	type WorktreeRemoval,
} from "./branches";
import type { CallIntent, CallJournal, CallRecord } from "./call-journal";
import { custodyOf } from "./custody";
import { deliveryFor, type Mail, Mailbox, type MailboxDeps, type MailDelivery, mailDetails, mailText } from "./mail";
import { pickupOf } from "./pickup";
import { tabCloseStep } from "./tab-close";
import {
	type AnswerArgs,
	ARGS,
	type AutopilotArgs,
	type ListArgs,
	MESSAGE_MAX_CHARS,
	type OpenOne,
	READ_DEFAULT_MESSAGES,
	READ_MAX_CHARS,
	RESULT_MAX_CHARS,
	RESULT_TABLE_ANSWER_CHARS,
	RESULT_WAIT_DEFAULT_SECONDS,
	type ReportArgs,
	type ScheduleArgs,
} from "./tools";

/** A blocking request a session waits on, as the pool holds it. */
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
	plan?: { title: string; planFilePath: string };
	/** The user hid this session from agents (Sidebar › Hide from other agents). */
	hidden: boolean;
	/** In the calling session's window (the default list); other windows' tabs are listed with scope app. */
	here: boolean;
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
	/** Text around a search hit. */
	snippet?: string;
}

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
}

/** A session opened by `open`, handed to `beforeFirstPrompt` before its first message is sent. */
export interface OpenedChild {
	tabId: string;
	callerTabId: string;
	worktree?: { path: string; branch: string };
	tag?: string;
}

/** A scheduled run as the control tools see it. */
export interface ScheduleRow {
	id: string;
	name: string;
	frequency: ScheduleFrequency;
	cwd: string;
	enabled: boolean;
	/** Next start (ISO), null when it will not run. */
	nextRun: string | null;
	/** How the last run ended; null before the first. */
	lastStatus: string | null;
}

/** The Schedules service seen by `ompdesk_schedule` (`host.ts` adapts `src/main/schedules.ts`, or a paired host's over the link). */
export interface ScheduleSource {
	list(): Promise<ScheduleRow[]>;
	save(draft: ScheduleDraft): Promise<ScheduleRow>;
	remove(id: string): Promise<void>;
}

export type ShipLevel = "commit" | "push" | "release";

/** `ompdesk_autopilot`'s ship levels as the start sheet's presets. */
const SHIP_PRESET: Record<ShipLevel, AutopilotShipPreset> = { commit: "local", push: "push", release: "release" };

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

export interface AgentControlHost {
	/** Settings › Tools & extensions switch (this computer's). */
	enabled(): boolean;
	/** `agentControlFull` (default on): no card at all; implies `approveEnabled` and `manageEnabled`. */
	fullEnabled(): boolean;
	/** `agentControlApprove`, or full control: an agent may approve another session's tool approval. */
	approveEnabled(): boolean;
	/** `agentControlManage` (default on) or full control: an agent may stop or close sessions it did not open, merge, schedule and start Autopilot without a card; deleting a saved session it did not open asks unless full control is on. */
	manageEnabled(): boolean;
	/** The session that opened `tabId` (`ompdesk_session_open`), if any. */
	parentOf(tabId: string): string | undefined;
	/** The sessions working in `tabId`'s checkout or another worktree of its repository on this computer (`checkout-peers.ts`); `ompdesk_report` may go to them. */
	checkoutPeers?(tabId: string): readonly string[];
	/** Put one report into a session as a stock custom message (`ompdesk.mail`), delivered per `delivery`. */
	mail(tabId: string, content: string, details: Record<string, unknown>, delivery: MailDelivery): Promise<void>;
	/** A child's report changed what its opener's work board shows. */
	reviewChanged?(parentTabId: string): void;
	/** Every open tab of this app, the caller's window first (`here`); null when the calling tab is gone. */
	tabs(callerTabId: string): ControlTab[] | null;
	/**
	 * A process outside OMPdesk calling over the control socket (src/main/control-socket): it has no tab, so it is
	 * this stand-in, never listed among `tabs`. Undefined for any id that is no outside caller.
	 */
	outsideCaller?(callerTabId: string): ControlTab | undefined;
	/** The paired hosts (Settings › Devices). */
	devices(): ControlDevice[];
	/** Saved sessions on this computer (device undefined) or a paired host; `query` searches titles and conversations. */
	stored(device: string | undefined, query?: string): Promise<StoredSession[]>;
	/** A saved session's transcript, read-only (this computer's stock helper, or the paired host). */
	storedMessages(session: StoredSession): Promise<AgentMessage[]>;
	/** A command through the GUI's RPC dispatcher for `tabId` (local handlers, host link, quota). */
	command(tabId: string, command: RpcCommand, timeoutMs?: number): Promise<RpcResponse>;
	/**
	 * Spawn a fresh tab in the caller's window on the caller's machine. Throws a readable error. `prepared`: what
	 * `.worktreeinclude` and `.ompdesk/worktree-setup` did in a new worktree (`describePreparation`).
	 */
	spawn(
		callerTabId: string,
		request: SpawnRequest,
	): Promise<{ tabId: string; worktree?: IpcTabWorktree; prepared?: string }>;
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
	/** Remove a clean worktree on `device` whose branch tip is in the parent's HEAD or upstream, and its branch (never forced). */
	removeSafeWorktree(worktree: WorktreeRef, device?: string): Promise<WorktreeRemoval>;
	/** Take back on `device` a worktree and branch an open made and nobody used (a failed open; never forced). */
	discardWorktree(worktree: WorktreeRef, device?: string): Promise<WorktreeRemoval>;
	/** Remember a session closed after its work landed, so its opener's family still lists it. */
	recordClosed(child: ClosedChild): void;
	/** The sessions main closed after their work landed (`recordClosed`), newest last. */
	closedChildren?(): readonly ClosedChild[];
	/** The Schedules service of this computer (no `device`) or of the paired host `device`, or null where there is none. */
	schedules(device?: string): ScheduleSource | null;
	/**
	 * The control-tool calls that change something, by their identity (`call-journal.ts`): a call a paired host re-sends
	 * after this computer relaunched runs at most once. Absent: calls are not recorded.
	 */
	calls?: Pick<CallJournal, "get" | "begin" | "note" | "finish">;
	/** Be called whenever any tab's run, ask or status changes; returns the unsubscribe. */
	observe(listener: () => void): () => void;
	/** Autopilot: a stop of the caller's work is in flight; nothing new may start. */
	isStopping?(callerTabId: string): boolean;
	/** Autopilot: awaited after the child is ready and before its first prompt; a throw closes the child and fails the open. */
	beforeFirstPrompt?(child: OpenedChild): Promise<void>;
	/** Autopilot's coordinator (`ompdesk_autopilot`); absent where there is none. */
	autopilot?: AutopilotSource;
	/** Card and label text in the person's language. */
	text(
		key:
			| "stopTitle"
			| "stopMessage"
			| "closeMessage"
			| "deleteMessage"
			| "answeredBy"
			| "mergeTitle"
			| "mergeMessage"
			| "scheduleTitle"
			| "scheduleMessage"
			| "autopilotTitle"
			| "autopilotMessage"
			| "autopilotShipCommit"
			| "autopilotShipPush"
			| "autopilotShipRelease"
			| "autopilotBranchNew"
			| "autopilotBranchDefault"
			| "appTitle"
			| "appMessage"
			| "appChanged",
		params: Record<string, string>,
	): string;
	/** What `ompdesk_app` needs from the app (settings, panels, IPC handlers); absent = the tools answer that they are not available. */
	appPorts?: Omit<AppPorts, "autopilot">;
}

export interface ToolOutcome {
	text: string;
	isError: boolean;
}

/** A started tab is ready within this; a paired host's first spawn takes longer than a local one. */
const READY_TIMEOUT_MS = 90_000;
/**
 * The first command a just-started child answers: before it, the local handler learns the session from stock
 * `get_state`, connects to the bridge and waits for the bridge's modules to load, all queued behind omp's own startup.
 * With several sessions working that took past the default 8 s and failed an open whose omp was fine (v0.46.0).
 */
const FIRST_COMMAND_TIMEOUT_MS = 60_000;
/** A wait re-reads the session at least this often even when no tab event arrives. */
const POLL_MS = 3_000;
const STATE_TIMEOUT_MS = 5_000;
const SUMMARY_CHARS = 200;
const SESSION_PREFIX_MIN = 4;
/** Reports after which a session waits for, or no longer expects, its receiver's next message in the same turn. */
const WAITS_AFTER_REPORT: ReadonlySet<string> = new Set(["done", "review", "question", "blocked"]);
/** How long a tool call waits for an untitled tab's saved name (`#nameUntitled`). */
const NAME_LOOKUP_MS = 2_000;
const TOOL_RESULT_CHARS = 300;
const MESSAGE_CHARS = 1_500;
/** An automatic close waits this long for the window to drop the tab (it refuses a tab the person uses). */
const AUTO_CLOSE_WAIT_MS = 2_000;
const LIST_DEFAULT_ROWS = 30;
/** A sent message's receipt waits this long to see the target's turn start. */
const TURN_START_WAIT_MS = 1_500;
/**
 * A paired device's link is waited for this long while it is not online: a blip is a reconnect (1 s back-off, then up
 * to 5 s per address to dial, `RemoteClient`), so a call made during one goes through instead of failing.
 */
const LINK_WAIT_MS = 15_000;
/** How long a send waits for the person to send or clear a draft they are typing into its target (`#untilDraftSent`). */
export const DRAFT_WAIT_MS = 60_000;
/** Back on the link, a device's tab re-attaches (`error` → `starting` → its status) within this. */
const REATTACH_WAIT_MS = 10_000;
/** A device or tab that is not there yet is looked at again this often. */
const LINK_POLL_MS = 250;
/**
 * Stock's abort answers only once the turn unwound (tools, subagents, compaction), which can take longer than any
 * fixed RPC timeout. A close or delete gives it this long and goes on: closing the tab ends its omp anyway.
 */
const ABORT_BEFORE_CLOSE_MS = 3_000;
/** A plain stop waits this long for stock's abort to confirm; a delete, which needs the turn over, as long. */
const STOP_WAIT_MS = 30_000;
/** A close is confirmed by the window dropping the tab within this. */
const CLOSE_WAIT_MS = 5_000;
/** After the tab is gone, its omp gets this long to exit before the close is reported anyway. */
const OMP_EXIT_WAIT_MS = 5_000;
/** A title names a session by a prefix this long or longer. */
const TITLE_PREFIX_MIN = 3;

const DEFAULT_TIMERS: Pick<MailboxDeps, "setTimer" | "clearTimer"> = {
	setTimer: (fn, ms) => setTimeout(fn, ms),
	clearTimer: timer => clearTimeout(timer as NodeJS.Timeout),
};

/** The task text with the dispatch id its report names (a report for an older dispatch is ignored). */
function withDispatch(message: string, dispatch: string | undefined, requestId?: string): string {
	const marks = [
		dispatch ? `[ompdesk dispatch ${dispatch}: report with ompdesk_report, dispatch "${dispatch}"]` : null,
		requestId ? `[ompdesk request ${requestId}]` : null,
	].filter(Boolean);
	return marks.length ? `${message}\n\n${marks.join("\n")}` : message;
}

const DISPATCH_MARK = /\[ompdesk dispatch d(\d+):/g;
const REQUEST_MARK = /\[ompdesk request ([^\]]+)\]/g;

/** The dispatch number and request ids a session's journal holds (the markers its opener's messages carried). */
export function journalMarks(messages: readonly AgentMessage[]): { dispatch: number; requests: Set<string> } {
	let dispatch = 0;
	const requests = new Set<string>();
	for (const message of messages) {
		if (message.role !== "user") continue;
		const text = contentText(message.content);
		for (const match of text.matchAll(DISPATCH_MARK)) dispatch = Math.max(dispatch, Number(match[1]));
		for (const match of text.matchAll(REQUEST_MARK)) if (match[1]) requests.add(match[1]);
	}
	return { dispatch, requests };
}

class ToolError extends Error {}

function fail(message: string): never {
	throw new ToolError(message);
}

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

function responseData<T>(response: RpcResponse, what: string): T {
	if (!response.success) fail(`${what} failed: ${response.error ?? "unknown error"}`);
	return response.data as T;
}

/** How long a turn has run, for a session's state line (`running, <step>, for 12 min`). */
export function elapsedText(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	const rest = minutes % 60;
	return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function cut(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n… (cut at ${max} characters)` : text;
}

function todoProgress(phases: readonly TodoPhase[] | undefined): string | null {
	const tasks = (phases ?? []).flatMap(phase => phase.tasks);
	if (tasks.length === 0) return null;
	const done = tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;
	const current = tasks.find(task => task.status === "in_progress");
	return `todos ${done}/${tasks.length} done${current ? ` (now: ${oneLine(current.content, 80)})` : ""}`;
}

/** The session waits on someone: an open ask or approval, or a plan proposal awaiting approval (the control socket's `blocked`). */
export function waits(tab: ControlTab): boolean {
	return tab.asks.length > 0 || tab.plan !== undefined;
}

/** A saved session's name: its title, else the task an agent opened it for, else its first message. */
function storedTitle(row: Pick<StoredSession, "title" | "firstMessage">): string {
	return row.title || agentTaskTitle(row.firstMessage) || row.firstMessage || "(untitled)";
}

/** A thrown error as a tool result: a `ToolError` is the agent's own message, anything else names the tool. */
function outcomeOf(tool: AgentControlToolName, error: unknown): ToolOutcome {
	if (error instanceof ToolError) return { text: error.message, isError: true };
	return { text: `${tool} failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
}

/** Calls whose effect a second run would repeat: recorded (`call-journal.ts`). Reads and a notification are not. */
function mutates(tool: AgentControlToolName, args: unknown): boolean {
	const action = typeof args === "object" && args !== null && "action" in args ? args.action : undefined;
	switch (tool) {
		case T.open:
		case T.send:
		case T.answer:
		case T.stop:
		case T.merge:
		case T.app:
			return true;
		case T.schedule:
			return action !== "list";
		case T.autopilot:
			return action !== "status";
		default:
			return false;
	}
}

/** What a recorded call sets out to do, so its effect can be found after a relaunch (`#reconcile`). */
function callIntent(tool: AgentControlToolName, args: unknown, caller: ControlTab): CallIntent | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const fields = args as Record<string, unknown>;
	if (tool === T.open) {
		const items = Array.isArray(fields.sessions) ? fields.sessions : [fields];
		const open = items.flatMap(item => {
			if (typeof item !== "object" || item === null) return [];
			const { message, reopen } = item as Record<string, unknown>;
			// One entry per new session (its count is what a relaunch expects); "" when the brief names no task.
			return typeof message === "string" && message && !reopen
				? [agentTaskTitle(wrapAgentMessage(message, caller.title)) ?? ""]
				: [];
		});
		return { open };
	}
	if (tool === T.schedule && fields.action === "create")
		return {
			schedule: {
				name: `${AGENT_SCHEDULE_PREFIX}${typeof fields.name === "string" ? fields.name : ""}`,
				...(typeof fields.device === "string" ? { device: fields.device } : {}),
			},
		};
	return undefined;
}

function label(tab: ControlTab): string {
	if (tab.hidden) return `${tab.tabId} (hidden from agents)`;
	const folder = tab.cwd.split(/[\\/]/).filter(Boolean).pop() ?? tab.cwd;
	return tab.title ? `"${oneLine(tab.title, 80)}"` : `(untitled, in ${folder})`;
}

/** "every 30 min", "daily at 09:00", "Mon, Wed at 09:00". */
function describeFrequency(frequency: ScheduleFrequency): string {
	if (frequency.kind === "interval") return `every ${frequency.minutes} min`;
	const days = frequency.days.map(day => WEEKDAYS[day] ?? String(day));
	return `${days.length > 0 ? days.join(", ") : "daily"} at ${frequency.time}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** A path without trailing separators (a root stays as it is). */
function trimSeparators(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	return trimmed === "" || /^[A-Za-z]:$/.test(trimmed) ? path : trimmed;
}

/** `ompdesk_autopilot start` arguments as the start sheet's options, with the level always named (never Automatic). */
function startOptions(args: Extract<AutopilotArgs, { action: "start" }>, ship: ShipLevel): AutopilotStartOptions {
	const advanced = args.advanced ?? {};
	const shipPolicy: NonNullable<AutopilotStartOptions["ship"]> = {
		...(advanced.remote ? { remote: advanced.remote } : {}),
		...(advanced.cadence !== undefined
			? { autoRelease: { on: true, cadence: { kind: "every" as const, n: advanced.cadence } } }
			: {}),
	};
	return {
		preset: SHIP_PRESET[ship],
		...(Object.keys(shipPolicy).length > 0 ? { ship: shipPolicy } : {}),
		...(args.guide ? { guide: args.guide } : {}),
		...(args.branch ? { branch: args.branch } : {}),
		...(advanced.focus ? { focus: advanced.focus } : {}),
		...(advanced.parallel !== undefined ? { maxParallel: advanced.parallel } : {}),
		...(advanced.limits ? { limits: advanced.limits } : {}),
	};
}

/** A run's state as a short report for the agent. */
export function describeRun(tab: Pick<ControlTab, "tabId" | "title">, status: AutopilotStatus): string {
	const reason = status.reason ? ` (${status.reason}${status.detail ? `: ${oneLine(status.detail, 160)}` : ""})` : "";
	const lines = [
		`Autopilot run ${tab.tabId}${tab.title ? ` "${oneLine(tab.title, 80)}"` : ""}: ${status.state ?? "unknown"}${reason}; cycle ${status.cycle ?? 0}.`,
	];
	if (status.branch)
		lines.push(
			`branch ${status.branch}, base ${status.baseBranch ?? "?"}${status.target ? `, pushes to ${status.target}` : ""}, worktree ${status.root ?? "?"}`,
		);
	const policy = status.ship?.policy ?? status.settings?.ship;
	if (policy)
		lines.push(
			`ship level ${policy.autoRelease.on ? "release" : policy.autoPush ? "push" : "commit"}, remote ${policy.remote}`,
		);
	const now = status.now;
	lines.push(
		now
			? `now: cycle ${now.n}${now.area ? ` [${now.area}]` : ""}${now.title ? ` "${oneLine(now.title, 100)}"` : ""}`
			: "now: between cycles",
	);
	lines.push(`red streak ${status.redStreak ?? 0}`);
	const commit = [...(status.cycles ?? [])].reverse().find(cycle => cycle.commit && !cycle.reverted);
	lines.push(
		commit
			? `last commit ${commit.commit?.slice(0, 9)} (cycle ${commit.n}, "${oneLine(commit.title, 80)}", verify ${commit.verify})`
			: "last commit: none yet",
	);
	const push = [...(status.ship?.queue ?? [])].reverse().find(item => item.kind === "push");
	lines.push(
		push
			? `last push ${push.state}${push.sha ? ` ${push.sha.slice(0, 9)}` : ""}${push.detail ? ` (${oneLine(push.detail, 100)})` : ""}`
			: "last push: none yet",
	);
	const release = status.ship?.release;
	lines.push(
		release
			? `last release ${release.version} ${release.state}${release.runUrl ? ` ${release.runUrl}` : ""}`
			: "last release: none yet",
	);
	const children = (status.children ?? []).filter(child => child.status === "running").length;
	if (children > 0) lines.push(`${children} child session(s) running`);
	if (status.state === "paused")
		lines.push("It does not continue by itself: the user resumes it on the Autopilot screen.");
	if (status.state === "waiting_quota")
		lines.push(
			`It waits for the account's usage limit and goes on by itself${status.quotaResetAt ? ` at ${new Date(status.quotaResetAt).toISOString()}` : ""}.`,
		);
	return lines.join("\n");
}

function contentText(content: AgentMessage["content"]): string {
	if (typeof content === "string") return content;
	return (content ?? [])
		.map((block: MessageContent) => (block.type === "text" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

/** One transcript message as a line for another agent; null for the rows an agent has no use for. */
export function renderMessage(message: AgentMessage): string | null {
	switch (message.role) {
		case "user": {
			const text = contentText(message.content).trim();
			if (!text) return null;
			const wrapped = parseAgentMessage(text);
			const head = wrapped
				? `[user, sent by an agent${wrapped.from ? ` (${oneLine(wrapped.from, 60)})` : ""}]`
				: "[user]";
			return `${head} ${cut(wrapped?.body ?? text, MESSAGE_CHARS)}`;
		}
		case "assistant": {
			const parts: string[] = [];
			const text = contentText(message.content).trim();
			if (text) parts.push(`[assistant] ${cut(text, MESSAGE_CHARS)}`);
			if (Array.isArray(message.content))
				for (const block of message.content)
					if (block.type === "toolCall")
						parts.push(`[tool call] ${block.name}${block.intent ? `: ${oneLine(block.intent, 120)}` : ""}`);
			return parts.length ? parts.join("\n") : null;
		}
		case "toolResult": {
			const text = oneLine(contentText(message.content), TOOL_RESULT_CHARS);
			return `[tool result${message.isError ? " (error)" : ""}] ${message.toolName ?? ""} ${text}`.trimEnd();
		}
		case "bashExecution":
			return `[bash] ${oneLine(message.command ?? "", 160)} → exit ${message.exitCode ?? "?"}`;
		default:
			return null;
	}
}

/** A check a session ran: the command, whether it passed, and the end of its output. */
export interface CheckRun {
	command: string;
	passed: boolean;
	/** The last `CHECK_TAIL_CHARS` of its output (where runners print their summary and first failures). */
	tail: string;
}

/** One compared session as the judge and the agent read it. */
interface Evidence {
	id: string;
	/** The block the agent reads. */
	text: string;
	/** State, checks, diff summary and merge prediction lines, without the answer, the diff and the check output. */
	facts: string;
	answer: string | null;
	checks: CheckRun[];
	/** The worktree's diff against where it lands, already cut by its git; "" without a worktree. */
	diff: string;
	diffOmitted: number;
}

/** Newest transcript messages a compare reads from an open session for the checks it ran. */
const EVIDENCE_MESSAGES = 200;
/** The judge request's evidence, all sessions together; each session gets an equal share. */
const JUDGE_EVIDENCE_CHARS = 60_000;
/** Output a check keeps for the judge: its end, where runners print the summary and the failures. */
const CHECK_TAIL_CHARS = 1_200;
/** Newest checks per session whose output the judge reads. */
const JUDGE_CHECKS = 4;

const JUDGE_SYSTEM = `You judge the work of several coding sessions against acceptance criteria, for the agent that started them.
Use only the evidence given: each session's state, the checks it ran (command, outcome and the end of its output, read from its transcript), its git diff against where it would land, a prediction of merging it, and its final answer.
Read the diff yourself. A criterion no hunk implements is "no" even when the final answer claims it. A change that removes or alters behaviour no criterion asked for is a regression: name it in reasons and lower the score. A predicted merge conflict counts against the session.
A claim that no check or diff supports counts as "unknown", not "yes". A failed check counts against the criterion it covers. A session that is still running cannot be the winner.
Answer with JSON only, no prose around it:
{"ranking":[{"session":"<id>","score":<0-100>,"criteria":[{"criterion":"<text>","met":"yes|partly|no|unknown","why":"<short evidence>"}],"reasons":"<one or two sentences>"}],"winner":"<id or null>","why":"<why it wins, or why none does>"}
Rank every session, best first. Pick a winner only if it meets every criterion at least partly and beats the others on the evidence.`;

const verdictSchema = z.object({
	ranking: z.array(
		z.object({
			session: z.string(),
			score: z.number().min(0).max(100),
			criteria: z
				.array(
					z.object({
						criterion: z.string(),
						met: z.enum(["yes", "partly", "no", "unknown"]),
						why: z.string().optional().default(""),
					}),
				)
				.default([]),
			reasons: z.string().default(""),
		}),
	),
	winner: z.string().nullable().default(null),
	why: z.string().default(""),
});

export type Verdict = z.infer<typeof verdictSchema>;

/** The judge's JSON, also when a model wraps it in a fence or a sentence; null when there is none. */
export function parseVerdict(text: string): Verdict | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const parsed = verdictSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** One transcript page for the agent: the newest messages that fit `READ_MAX_CHARS`, and the cursor to page back. */
function renderPage(
	title: string,
	session: string,
	messages: readonly AgentMessage[],
	totalMessages: number,
	prevCursor: string | null,
): string {
	const lines = messages.map(renderMessage).filter((line): line is string => line !== null);
	let total = 0;
	const kept: string[] = [];
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i] as string;
		if (total + line.length > READ_MAX_CHARS && kept.length > 0) break;
		total += line.length;
		kept.unshift(line);
	}
	const omitted = lines.length - kept.length;
	const head = `${title}: ${messages.length} message(s) of ${totalMessages}${omitted ? ` (${omitted} older ones of this page left out; use a smaller limit)` : ""}.`;
	const more = prevCursor
		? `\nEarlier messages: ompdesk_session_read {"session":"${session}","before":"${prevCursor}"}.`
		: "";
	return `${head}\n${kept.join("\n") || "(nothing to show)"}${more}`;
}

/** A command line that checks the work (tests, types, lint, build), as a compare reports it. */
const CHECK_COMMAND =
	/\b(test|tests|vitest|jest|pytest|mocha|playwright|tsc|typecheck|check|lint|biome|eslint|ruff|mypy|clippy|build|cargo (test|check|build)|go (test|vet|build)|gradle|mvn|make)\b/i;

/** The end of a check's output, where runners print their summary and the failures. */
function outputTail(text: string): string {
	const trimmed = text.trimEnd();
	return trimmed.length > CHECK_TAIL_CHARS ? `…${trimmed.slice(-CHECK_TAIL_CHARS)}` : trimmed;
}

/** The checks a transcript ran, newest last: the command, whether it passed (exit 0 / no error), its output's end. */
export function checksRun(messages: readonly AgentMessage[]): CheckRun[] {
	const calls = new Map<string, string>();
	const checks: CheckRun[] = [];
	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content)
				if (block.type === "toolCall" && block.name === "bash") {
					const command = (block.arguments as { command?: unknown } | undefined)?.command;
					if (typeof command === "string" && CHECK_COMMAND.test(command)) calls.set(block.id, command);
				}
		} else if (message.role === "toolResult") {
			const command = message.toolCallId ? calls.get(message.toolCallId) : undefined;
			if (command === undefined) continue;
			const text = contentText(message.content);
			const exit = /exit(?:ed with)? (?:code )?(\d+)/i.exec(text);
			checks.push({ command, passed: !message.isError && (exit ? exit[1] === "0" : true), tail: outputTail(text) });
		} else if (message.role === "bashExecution" && CHECK_COMMAND.test(message.command ?? "")) {
			checks.push({
				command: message.command ?? "",
				passed: message.exitCode === 0,
				tail: outputTail(message.output ?? ""),
			});
		}
	}
	return checks;
}

/** How a child's transcript ends: what `autoClose` reads where this launch saw nothing of its turns. */
export interface TranscriptEnding {
	/** The final answer: the text of the last assistant message; null when that message has none (a cut-off turn). */
	last: string | null;
	/** How the last assistant message ended (stock's `stopReason`). */
	stopReason?: string;
	/** An `ompdesk_report` of kind `done` to its opener since the last prompt it was given, not refused. */
	reportedDone: boolean;
	/** A prompt the person typed (neither an agent's wrapped message nor stock's synthetic one). */
	personPrompted: boolean;
}

/** `ompdesk_report {kind: "done"}` to the opener: as the tool itself, or written to its device (`xd://ompdesk_report`). */
function isDoneReport(name: string, args: Record<string, unknown>): boolean {
	let report: unknown = args;
	if (name === "write" && args.path === "xd://ompdesk_report" && typeof args.content === "string") {
		try {
			report = JSON.parse(args.content);
		} catch {
			return false;
		}
	} else if (name !== T.report) return false;
	// A report to a sibling (`to`) is a note, not the end of the work it was given.
	return (
		typeof report === "object" && report !== null && "kind" in report && report.kind === "done" && !("to" in report)
	);
}

export function transcriptEnding(messages: readonly AgentMessage[]): TranscriptEnding {
	let last: string | null = null;
	let stopReason: string | undefined;
	let personPrompted = false;
	let reports = new Set<string>();
	const refused = new Set<string>();
	for (const message of messages) {
		if (message.role === "user") {
			if (message.synthetic === true || message.attribution === "agent") continue;
			const text = contentText(message.content).trim();
			if (!text) continue;
			// New work: a done report before it no longer speaks for what the session does now.
			reports = new Set();
			if (!parseAgentMessage(text)) personPrompted = true;
		} else if (message.role === "assistant") {
			last = contentText(message.content).trim() || null;
			stopReason = message.stopReason;
			if (Array.isArray(message.content))
				for (const block of message.content)
					if (block.type === "toolCall" && isDoneReport(block.name, block.arguments)) reports.add(block.id);
		} else if (message.role === "toolResult" && message.isError && message.toolCallId)
			refused.add(message.toolCallId);
	}
	return {
		last,
		...(stopReason ? { stopReason } : {}),
		reportedDone: [...reports].some(id => !refused.has(id)),
		personPrompted,
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What `git merge-tree` predicts merging a child's branch into the parent's HEAD would do. */
function predictionLine(prediction: MergePrediction, base: string | null): string {
	switch (prediction.kind) {
		case "clean":
			return `merge: no conflict with ${base ?? "the parent's HEAD"}`;
		case "conflict":
			return `merge: would conflict in ${prediction.files.join(", ")} (predicted by git merge-tree; nothing was touched)`;
		case "unknown":
			return `merge: not predicted (${oneLine(prediction.reason, 200)})`;
	}
}

/** What the bridge's `agent_control.judge` answers (agent-control.ts); an older bridge sends only text, model, usd. */
interface JudgeReply {
	text?: string;
	model?: string;
	/** The role whose chain served it (`advisor`, else `slow`). */
	role?: string;
	family?: string | null;
	mainFamily?: string | null;
	/** Whether the judge's family differs from the caller's model; null when either is unknown. */
	crossFamily?: boolean | null;
	usd?: number;
}

/** " by <model> (<role> role, <family> family; …)": which model judged and whether it is another family than the caller's. */
function judgeLabel(reply: JudgeReply | undefined): string {
	if (!reply?.model) return "";
	if (!reply.role) return ` by ${reply.model}`;
	const family = reply.family ? `, ${reply.family} family` : "";
	const relation =
		reply.crossFamily === true
			? `; your model is ${reply.mainFamily}`
			: reply.crossFamily === false
				? "; same family as your model: no model of another family had credentials"
				: "";
	return ` by ${reply.model} (${reply.role} role${family}${relation})`;
}

/** What a session is doing right now, from the tail of its transcript: a tool call without a result yet. */
export function currentStep(messages: readonly AgentMessage[]): string | null {
	const answered = new Set(messages.filter(m => m.role === "toolResult").map(m => m.toolCallId));
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const pending = message.content.filter(
			(block): block is Extract<MessageContent, { type: "toolCall" }> =>
				block.type === "toolCall" && !answered.has(block.id),
		);
		const last = pending.at(-1);
		return last ? `running ${last.name}${last.intent ? ` (${oneLine(last.intent, 80)})` : ""}` : null;
	}
	return null;
}

interface SessionState {
	state: RpcSessionState | null;
	last: string | null;
	step: string | null;
	subagents: SubagentSnapshot[];
}

type OpenArgs = OpenOne & { show?: "background" | AgentControlViewEvent["how"] };

/** What closing a tab came to: gone, still open, or (a paired web page's tab) held back by what its page says. */
type TabClose = "closed" | "kept" | "dirty";

export class AgentControl {
	readonly #host: AgentControlHost;
	/** Tabs each calling tab opened, for the "opened by you" marks. */
	readonly #opened = new Map<string, Set<string>>();
	/** Tabs whose stop or close is in flight. */
	readonly #closing = new Set<string>();
	/** Children whose review item the person settled (approved, discarded, dismissed). */
	readonly #reviewed = new Set<string>();
	/** Files a child's last merge conflicted in, until it merges. */
	readonly #conflicts = new Map<string, string[]>();
	/** Opened sessions whose answer the opener read (a result, a read, a compare, a merge) since they last ran. */
	readonly #collected = new Set<string>();
	/**
	 * Children asked once to report after a turn that ended with neither a verdict line nor a done report, per tab: the
	 * dispatch it was asked on, the answer it had then, and whether its opener has been told it still did not.
	 */
	readonly #nudged = new Map<
		string,
		{ dispatch: string | undefined; answer: string; ran: boolean; toldOpener: boolean }
	>();
	/** Callers whose `autoClose` pass is in flight. */
	readonly #sweeping = new Set<string>();
	/** Per child tab, the dispatch whose `done` report main sent for it (`#autoDone`). */
	readonly #autoDoneFor = new Map<string, string>();
	/** Saved sessions the last stored lists showed, by stock id: what read, reopen and compare resolve a stored id to. */
	readonly #stored = new Map<string, StoredSession>();
	/** Reports between sessions (`mail.ts`): dispatch ids, coalescing, the last report of each child. */
	readonly #mailbox: Mailbox;
	/** Receipts of `ompdesk_session_send` by `caller|target|request_id`: a repeat is never delivered twice. */
	readonly #receipts = new Map<string, string>();
	/** Recorded calls still running in this process, by key: the same call made again joins it. */
	readonly #calling = new Map<string, Promise<ToolOutcome>>();
	/** The recorded call a piece of work belongs to, so an open notes each tab it makes (`CallJournal.note`). */
	readonly #callScope = new AsyncLocalStorage<{ key: string }>();
	/** Sessions (`device\npath`) whose saved name `#nameUntitled` already looked up. */
	readonly #namesSought = new Set<string>();
	/** When each session last reported done, review, a question or a blocker to the one that opened it. */
	readonly #reportedAt = new Map<string, number>();
	/** The newest dispatch queued as a follow-up behind each busy child's turn, until its transcript shows it. */
	readonly #queuedFollowUp = new Map<string, { n: number; id: string; from: string }>();
	/** Sends with a request id still on their way: a same-id repeat joins one instead of sending twice. */
	readonly #inflight = new Map<string, Promise<string>>();
	/** The question cards of each child its opener was already told of (request ids), so a re-announced card stays one message. */
	readonly #cardsTold = new Map<string, Set<string>>();
	/** Each session's last read cost and split, which stand while its omp cannot answer (`#cost`, `#split`). */
	readonly #lastSpend = new Map<string, { cost: number; split?: CostSplit }>();
	/** Closed children's last turns (`familyEdits`), by device, session file and close: a closed file no longer changes. */
	readonly #closedTurns = new Map<string, Promise<RpcTurnEdits>>();

	readonly #app: AppControl | null;

	constructor(host: AgentControlHost, timers: Pick<MailboxDeps, "setTimer" | "clearTimer"> = DEFAULT_TIMERS) {
		this.#host = host;
		this.#app = host.appPorts
			? new AppControl({ ...host.appPorts, autopilot: (tabId, args) => this.#appAutopilot(tabId, args) })
			: null;
		this.#mailbox = new Mailbox({
			now: Date.now,
			...timers,
			deliver: async mail => {
				await this.#host.mail(mail.to, mailText(mail), mailDetails(mail), deliveryFor(mail.kind));
				this.#host.reviewChanged?.(mail.to);
			},
		});
	}

	/** Live tabs `callerTabId` opened. */
	childrenOf(callerTabId: string): string[] {
		const tabs = this.#host.tabs(callerTabId);
		if (!tabs) return [];
		return [...this.#openedBy(callerTabId, tabs)].filter(id => !id.startsWith("pending:"));
	}

	/**
	 * A child showed a question card (stock `ask`, a select, confirm or text prompt): its opener hears of it as one
	 * question in its session, as a report the child wrote would arrive, so it can answer with ompdesk_session_answer or
	 * ask the user instead of finding the card by polling. Never OMPdesk's own confirmation cards, a session hidden from
	 * agents, or a session `openerTabId` did not open. Local and paired-device children alike: both reach here from the
	 * pool's ask activity.
	 */
	async childAsked(openerTabId: string, childTabId: string, requestId: string): Promise<void> {
		if (!this.#host.enabled()) return;
		const tabs = this.#host.tabs(openerTabId);
		if (!tabs) return;
		const child = tabs.find(tab => tab.tabId === childTabId);
		if (!child || child.hidden) return;
		if (this.#host.parentOf(childTabId) !== openerTabId && !this.#openedBy(openerTabId, tabs).has(childTabId)) return;
		const ask = child.asks.find(entry => entry.id === requestId);
		if (!ask || askTitle(ask.request).startsWith(AGENT_CARD_PREFIX)) return;
		const told = this.#cardsTold.get(childTabId) ?? new Set<string>();
		if (told.has(requestId)) return;
		told.add(requestId);
		this.#cardsTold.set(childTabId, told);
		const mail: Mail = {
			id: `ask-${childTabId}-${requestId}`,
			from: childTabId,
			fromTitle: child.title || child.task || "",
			to: openerTabId,
			kind: "question",
			text: cardText(ask.request),
			card: requestId,
			at: Date.now(),
		};
		try {
			await this.#host.mail(openerTabId, mailText(mail), mailDetails(mail), deliveryFor(mail.kind));
		} catch (error) {
			// Not delivered (the opener's omp restarting): a later announcement of the same card may try again.
			told.delete(requestId);
			throw error;
		}
		this.#host.reviewChanged?.(openerTabId);
	}

	/** Drop a tab's queued steers and follow-ups; the turn that runs is left alone. */
	async clearQueue(tabId: string): Promise<void> {
		responseData(await this.#host.command(tabId, { type: "queue_clear" }, 15_000), "Clearing the queue");
	}

	/** A tab closed. */
	released(tabId: string): void {
		this.#app?.released(tabId);
		this.#opened.delete(tabId);
		this.#collected.delete(tabId);
		this.#sweeping.delete(tabId);
		this.#closing.delete(tabId);
		this.#reviewed.delete(tabId);
		this.#conflicts.delete(tabId);
		this.#mailbox.forget(tabId);
		this.#cardsTold.delete(tabId);
		this.#lastSpend.delete(tabId);
		this.#queuedFollowUp.delete(tabId);
		for (const key of this.#reportedAt.keys()) if (key.split("\n").includes(tabId)) this.#reportedAt.delete(key);
	}

	/** Programmatic open (Autopilot): the same path as the tool, with a tag the tool never sets. */
	async openSessions(callerTabId: string, sessions: readonly OpenOne[], tag?: string): Promise<string[]> {
		const tabs = this.#host.tabs(callerTabId);
		if (!tabs) fail("This session's tab is gone.");
		const caller = tabs.find(tab => tab.tabId === callerTabId);
		if (!caller) fail("This session's tab is gone.");
		return (await this.#openMany(caller, tabs, sessions, undefined, tag)).map(entry => entry.tabId);
	}

	/**
	 * Run one control-tool call. `call` is the host tool call: its id (stock's, the same when a paired host re-sends the
	 * call after this computer relaunched) and whether the host says it re-sends one it had handed a connection before
	 * (`resent`). A call that changes something is recorded under the caller's session file and that id
	 * (`call-journal.ts`), so it runs at most once; a re-sent one this computer has no record of (forgotten, or a new
	 * profile) is reconciled like a pending one and never run blindly.
	 */
	async run(
		callerTabId: string,
		tool: AgentControlToolName,
		args: unknown,
		call?: { id: string; resent?: boolean },
	): Promise<ToolOutcome> {
		let tabs: ControlTab[];
		try {
			if (!this.#host.enabled())
				fail("OMPdesk control tools are turned off (Settings › Tools & extensions). Ask the user to turn them on.");
			tabs = this.#host.tabs(callerTabId) ?? fail("This session's tab is gone.");
			await this.#nameUntitled(tabs);
		} catch (error) {
			return outcomeOf(tool, error);
		}
		const caller = tabs.find(tab => tab.tabId === callerTabId);
		const journal = this.#host.calls;
		if (!journal || !call || !caller?.sessionPath || !mutates(tool, args))
			return this.#outcome(callerTabId, tabs, tool, args);
		const key = `${caller.device ?? ""}\n${caller.sessionPath}\n${call.id}`;
		const joined = this.#calling.get(key);
		if (joined) return joined;
		const known = journal.get(key);
		if (known?.result) return known.result;
		let record = known;
		if (!record && call.resent) {
			journal.begin({ key, tool, callerTabId, intent: callIntent(tool, args, caller) });
			record = journal.get(key);
		}
		const work = record
			? this.#reconcile(record, caller, tabs)
			: (() => {
					journal.begin({ key, tool, callerTabId, intent: callIntent(tool, args, caller) });
					return this.#callScope.run({ key }, () => this.#outcome(callerTabId, tabs, tool, args));
				})();
		this.#calling.set(key, work);
		try {
			const outcome = await work;
			journal.finish(key, outcome);
			return outcome;
		} finally {
			this.#calling.delete(key);
		}
	}

	async #outcome(callerTabId: string, tabs: ControlTab[], tool: AgentControlToolName, args: unknown) {
		try {
			return { text: await this.#dispatch(callerTabId, tabs, tool, args), isError: false };
		} catch (error) {
			return outcomeOf(tool, error);
		}
	}

	/**
	 * A call recorded as begun before this computer restarted, with no result: its effect may have happened. What the
	 * app holds now decides (the sessions it opened, the schedule it saved); it is never run a second time, and a call
	 * whose effect cannot be found answers that its outcome is unknown.
	 */
	async #reconcile(record: CallRecord, caller: ControlTab, tabs: ControlTab[]): Promise<ToolOutcome> {
		const already = "This call had already run before OMPdesk restarted; it was not run again.";
		const unknown = (hint: string): ToolOutcome => ({
			text: `This ${record.tool} call was started before OMPdesk restarted, and its outcome is unknown after OMPdesk restarted: it was not run again. ${hint}`,
			isError: true,
		});
		if (record.intent?.open) {
			const ids = new Set(record.opened ?? []);
			const titles = [...record.intent.open];
			const found = tabs.filter(tab => {
				if (tab.tabId === caller.tabId) return false;
				if (ids.has(tab.tabId) || tab.formerIds?.some(id => ids.has(id))) return true;
				// Opened but not noted yet (the app died in between): the caller's child opened for one of its tasks.
				const title = tab.task ? titles.indexOf(tab.task) : -1;
				if (title < 0 || this.#host.parentOf(tab.tabId) !== caller.tabId) return false;
				titles.splice(title, 1);
				return true;
			});
			const check = 'Check ompdesk_sessions {"mine":true} before opening it again with a new call.';
			if (found.length === 0) return unknown(check);
			const lines = found.map(
				tab =>
					`Opened session ${tab.tabId} in ${tab.cwd}${tab.deviceName ? ` on ${tab.deviceName}` : ""}. ${already}`,
			);
			if (found.length < record.intent.open.length)
				lines.push(
					`Whether the other ${record.intent.open.length - found.length} opened is unknown after OMPdesk restarted. ${check}`,
				);
			return { text: lines.join("\n"), isError: false };
		}
		if (record.intent?.schedule) {
			const { device: deviceName, name } = record.intent.schedule;
			const check = 'Check ompdesk_schedule {"action":"list"} before creating it again.';
			try {
				const device = deviceName === undefined ? null : this.#device(deviceName);
				const rows = (await this.#host.schedules(device?.id ?? undefined)?.list()) ?? [];
				const row = rows.findLast(entry => entry.name === name);
				if (!row) return unknown(check);
				return {
					text: `Scheduled “${row.name}” ${describeFrequency(row.frequency)} in ${row.cwd}; id ${row.id}. ${already}`,
					isError: false,
				};
			} catch {
				return unknown(check);
			}
		}
		return unknown("Check what it was meant to change before trying again with a new call.");
	}

	#stopping(callerTabId: string): boolean {
		return this.#closing.has(callerTabId) || this.#host.isStopping?.(callerTabId) === true;
	}

	/**
	 * A tab with neither a title nor a task (restored by a relaunch, or reopened) reads as its saved session's name, else
	 * the task of its first message, from the session index of the computer it runs on. Looked up once per session and
	 * handed to the pool, so the sidebar, the board and every later call have it too. A tool call waits for the lookup
	 * at most `NAME_LOOKUP_MS` (a paired device's index is a network read); a later answer still reaches the pool.
	 */
	async #nameUntitled(tabs: ControlTab[]): Promise<void> {
		const key = (tab: ControlTab) => `${tab.device ?? ""}\n${tab.sessionPath}`;
		const nameless = tabs.filter(
			tab => !tab.title && !tab.task && !tab.hidden && tab.sessionPath && !this.#namesSought.has(key(tab)),
		);
		if (nameless.length === 0) return;
		for (const tab of nameless) this.#namesSought.add(key(tab));
		const names = new Map<string, string>();
		const lookups = [...new Set(nameless.map(tab => tab.device))].map(async device => {
			const rows = await this.#host.stored(device).catch((): StoredSession[] => []);
			for (const tab of nameless) {
				const row = rows.find(entry => entry.path === tab.sessionPath && entry.device === tab.device);
				const name = row ? row.title || agentTaskTitle(row.firstMessage) : "";
				if (!row || !name) continue;
				names.set(key(tab), name);
				this.#host.setTask(tab.tabId, name);
			}
		});
		const { promise: waited, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, NAME_LOOKUP_MS);
		timer.unref?.();
		await Promise.race([Promise.all(lookups), waited]);
		clearTimeout(timer);
		for (const tab of nameless) {
			const name = names.get(key(tab));
			if (!name) continue;
			tab.title = name;
			tab.task = name;
		}
	}

	async #dispatch(callerTabId: string, tabs: ControlTab[], tool: AgentControlToolName, raw: unknown): Promise<string> {
		const parsed = ARGS[tool].safeParse(raw ?? {});
		if (!parsed.success) fail(`Invalid arguments for ${tool}: ${parsed.error.issues.map(i => i.message).join("; ")}`);
		const caller = this.#callerOf(callerTabId, tabs);
		if (!caller) fail("This session's tab is gone.");
		switch (tool) {
			case T.list:
				return this.#list(caller, tabs, ARGS[T.list].parse(raw ?? {}));
			case T.open: {
				const args = ARGS[T.open].parse(raw ?? {});
				const { sessions, show, ...single } = args;
				const items = sessions ?? [single as OpenOne];
				const results = await this.#openMany(caller, tabs, items, show);
				const text = this.#openText(results);
				if (!results.some(result => result.tabId)) fail(text);
				return text;
			}
			case T.send: {
				const args = ARGS[T.send].parse(raw);
				return this.#send(caller, await this.#open(tabs, args.session, caller, "send to"), args);
			}
			case T.result: {
				const args = ARGS[T.result].parse(raw);
				const ids = args.sessions ?? (args.session ? [args.session] : []);
				const targets = await Promise.all(ids.map(id => this.#resolveAny(tabs, id, caller, "read")));
				return this.#result(caller, targets, args, args.sessions !== undefined);
			}
			case T.read: {
				const args = ARGS[T.read].parse(raw);
				const target = await this.#resolveAny(tabs, args.session, caller, "read");
				return "tabId" in target && "busy" in target ? this.#read(target, args) : this.#readStored(target, args);
			}
			case T.answer: {
				const args = ARGS[T.answer].parse(raw);
				return this.#answer(caller, await this.#open(tabs, args.session, caller, "answer"), args);
			}
			case T.focus: {
				const args = ARGS[T.focus].parse(raw);
				const target = await this.#open(tabs, args.session, null, "show", false);
				this.#refuseHidden(target, caller);
				this.#host.view(caller.tabId, { tabId: target.tabId, how: args.how ?? "focus" });
				return `Showing ${label(target)} (${args.how ?? "focus"}).`;
			}
			case T.notify: {
				const args = ARGS[T.notify].parse(raw);
				this.#host.notify(caller.tabId, args.title, args.body ?? "");
				return "Notification shown.";
			}
			case T.stop: {
				const args = ARGS[T.stop].parse(raw);
				const device = args.device === undefined ? undefined : this.#device(args.device);
				const target = await this.#resolveAny(tabs, args.session, caller, "stop", device);
				return "busy" in target ? this.#stop(caller, tabs, target, args) : this.#stopStored(caller, target, args);
			}
			case T.compare: {
				const args = ARGS[T.compare].parse(raw ?? {});
				return this.#compare(caller, tabs, args.sessions, args.criteria);
			}
			case T.report:
				return this.#report(caller, tabs, ARGS[T.report].parse(raw));
			case T.merge: {
				const args = ARGS[T.merge].parse(raw);
				return this.#merge(caller, await this.#open(tabs, args.session, caller, "merge"));
			}
			case T.schedule:
				return this.#schedule(caller, ARGS[T.schedule].parse(raw));
			case T.autopilot:
				return this.#autopilot(caller, tabs, ARGS[T.autopilot].parse(raw));
			case T.appList:
				return this.#appControl().list(ARGS[T.appList].parse(raw ?? {}));
			case T.app: {
				const args = ARGS[T.app].parse(raw);
				try {
					return await this.#appControl().run(caller.tabId, args.action, args.args);
				} catch (error) {
					if (error instanceof AppRefusal) fail(error.message);
					throw error;
				}
			}
		}
	}

	/** The calling tab, or the process outside OMPdesk that calls over the control socket (`host.outsideCaller`). */
	#callerOf(callerTabId: string, tabs: readonly ControlTab[]): ControlTab | undefined {
		return tabs.find(tab => tab.tabId === callerTabId) ?? this.#host.outsideCaller?.(callerTabId);
	}

	/**
	 * The open session `session` names for `callerTabId`, by the tools' own name rules, refused when hidden from
	 * agents (the control socket's waits). Rejects with the tools' own message.
	 */
	async openTarget(callerTabId: string, session: string): Promise<ControlTab> {
		if (!this.#host.enabled())
			fail("OMPdesk control tools are turned off (Settings › Tools & extensions). Ask the user to turn them on.");
		const tabs = this.#host.tabs(callerTabId) ?? fail("This session's tab is gone.");
		const caller = this.#callerOf(callerTabId, tabs) ?? fail("This session's tab is gone.");
		const target = await this.#open(tabs, session, caller, "wait for");
		this.#refuseHidden(target, caller);
		return target;
	}

	/** The app action's way into `ompdesk_autopilot`: same parse, same card. */
	async #appAutopilot(callerTabId: string, raw: unknown): Promise<string> {
		const tabs = this.#host.tabs(callerTabId);
		const caller = tabs && this.#callerOf(callerTabId, tabs);
		if (!tabs || !caller) fail("This session's tab is gone.");
		const parsed = ARGS[T.autopilot].safeParse(raw);
		if (!parsed.success) fail(`Invalid arguments: ${parsed.error.issues.map(issue => issue.message).join("; ")}`);
		return this.#autopilot(caller, tabs, parsed.data);
	}

	#appControl(): AppControl {
		if (!this.#app) fail("App actions are not available here.");
		return this.#app;
	}

	/**
	 * A session that has to be open in a tab, named any way `#find` reads (never the caller itself where `self` is
	 * passed). One saved but not open fails with the call that opens it. `reach`: a paired device's tab is waited
	 * for while its link comes back (`#reachTab`).
	 */
	async #open(
		tabs: ControlTab[],
		session: string,
		self: ControlTab | null,
		verb: string,
		reach = true,
	): Promise<ControlTab> {
		const found = await this.#find(tabs, session);
		if (!found.target)
			fail(
				`No session "${session}" open in this app or saved${unreachedText(found.unreached)}. Call ompdesk_sessions (scope app for every window, scope stored for saved ones) and use an id it lists.`,
			);
		const target = found.target;
		if (!("busy" in target))
			fail(
				`"${oneLine(storedTitle(target), 80)}" (${target.id}) is saved${target.deviceName ? ` on ${target.deviceName}` : ""} but not open in any tab. Open it again with ompdesk_session_open {"reopen":"${target.id}"}, then ${verb} it by the id that returns (ompdesk_session_read reads it without opening).`,
			);
		if (self && target.tabId === self.tabId) fail(`You cannot ${verb} your own session with this tool.`);
		return reach ? this.#reachTab(target, self?.tabId ?? target.tabId) : target;
	}

	#refuseHidden(target: ControlTab, caller: ControlTab): void {
		if (target.hidden && target.tabId !== caller.tabId)
			fail(
				"The user hid this session from other agents. Ask them to show it or to tell you what they need from it.",
			);
	}

	/**
	 * Tabs `callerTabId` opened: those this launch saw it open, and those whose opener the pool kept across a relaunch
	 * (`host.parentOf`: the opener's tab, or the tab now holding the opener's session file), so ownership survives one.
	 */
	#openedBy(callerTabId: string, tabs: ControlTab[]): Set<string> {
		const set = this.#opened.get(callerTabId) ?? new Set<string>();
		const live = new Set(tabs.map(tab => tab.tabId));
		for (const id of set) if (!id.startsWith("pending:") && !live.has(id)) set.delete(id);
		for (const tab of tabs)
			if (tab.tabId !== callerTabId && this.#host.parentOf(tab.tabId) === callerTabId) set.add(tab.tabId);
		this.#opened.set(callerTabId, set);
		return set;
	}

	async #state(tab: ControlTab): Promise<SessionState> {
		const empty: SessionState = { state: null, last: null, step: null, subagents: [] };
		if (tab.hidden || (tab.status !== "ready" && tab.status !== "running")) return empty;
		const call = <T>(command: RpcCommand, pick: (data: unknown) => T | null): Promise<T | null> =>
			this.#host
				.command(tab.tabId, command, STATE_TIMEOUT_MS)
				.then(response => (response.success ? pick(response.data) : null))
				.catch(() => null);
		const [state, last, subagents, page] = await Promise.all([
			call({ type: "get_state", brief: true }, data => (data as RpcSessionState | undefined) ?? null),
			call({ type: "get_last_assistant_text" }, data =>
				data && typeof data === "object" && "text" in data && typeof data.text === "string" ? data.text : null,
			),
			tab.busy ? call({ type: "get_subagents" }, subagentRows) : null,
			tab.busy ? call({ type: "get_transcript_page", fromEnd: true, limit: 8 }, transcriptPage) : null,
		]);
		return {
			state,
			last,
			step: page ? currentStep(page.messages) : null,
			subagents: (subagents ?? []).filter(row => row.status === "running" && row.live !== false),
		};
	}

	#stateLine(tab: ControlTab, session: SessionState): string {
		const { state, step } = session;
		const ask = tab.asks[0];
		if (ask) return `waiting for the user's answer: "${oneLine(askTitle(ask.request), 120)}"`;
		if (tab.plan)
			return `waiting for plan approval: "${oneLine(tab.plan.title || "plan", 120)}" (${tab.plan.planFilePath})`;
		switch (tab.status) {
			case "asleep":
				return "not started (it starts when shown or messaged)";
			case "starting":
			case "restarting":
			case "waiting":
				return "starting";
			case "error":
			case "exited": {
				if (tab.sessionHeld)
					return "waiting for another omp process to let go of this session (it opens here by itself then; nothing to do)";
				const link = tab.device ? this.#host.devices().find(entry => entry.id === tab.device) : undefined;
				if (link && link.state !== "online")
					return `${link.name} is ${link.state} (its link is down; tools wait a moment for it, then this session answers again)`;
				return `stopped (${tab.status})`;
			}
		}
		if (tab.busy || state?.isStreaming)
			return `running${step ? `, ${step}` : ""}${tab.busySince ? `, for ${elapsedText(Date.now() - tab.busySince)}` : ""}`;
		if (state && state.isSettled === false) return "running (background work still going)";
		return "idle";
	}

	/** An idle session the caller opened says where it left the work (pickup.ts); every other line is as it is. */
	#withPickup(caller: ControlTab, tab: ControlTab, session: SessionState, line: string): string {
		if (line !== "idle" || this.#host.parentOf(tab.tabId) !== caller.tabId) return line;
		const report = this.#mailbox.state(tab.tabId, caller.tabId)?.last;
		const dispatch = this.#mailbox.current(tab.tabId);
		const pickup = pickupOf({
			answer: session.last,
			...(report
				? { report: { kind: report.kind, ...(report.dispatch ? { dispatch: report.dispatch } : {}) } }
				: {}),
			...(dispatch ? { dispatch } : {}),
		});
		return pickup ? `idle, ${pickup}` : line;
	}

	/** `"local"` is this computer (null); a paired host by id or name, else a readable failure naming them. */
	#device(wanted: string): ControlDevice | null {
		const lowered = wanted.toLowerCase();
		if (lowered === "local" || lowered === "this computer") return null;
		const devices = this.#host.devices();
		const partial = devices.filter(device => device.name.toLowerCase().includes(lowered));
		const found =
			devices.find(device => device.id === wanted) ??
			devices.find(device => device.name.toLowerCase() === lowered) ??
			(partial.length === 1 ? partial[0] : undefined);
		if (!found)
			fail(
				devices.length
					? `No paired device "${wanted}". Paired: ${devices.map(device => `${device.name} (${device.id})`).join(", ")}; "local" is this computer.`
					: `No paired device "${wanted}": this computer has none (Settings › Devices pairs one).`,
			);
		return found;
	}

	/**
	 * A paired device once its link is up: waited for `LINK_WAIT_MS` while it connects or reconnects, so a blip never
	 * fails a call. A device that stays away fails with what to do.
	 */
	async #reach(device: ControlDevice): Promise<ControlDevice> {
		const deadline = Date.now() + LINK_WAIT_MS;
		let current = device;
		while (current.state !== "online") {
			const left = deadline - Date.now();
			if (left <= 0)
				fail(
					`${current.name} is ${current.state} (waited ${LINK_WAIT_MS / 1000} s for its link). It has to be on, awake and on the tailnet (Settings › Devices); call again once ompdesk_sessions lists it online, or tell the user.`,
				);
			await this.#nextChange(Math.min(LINK_POLL_MS, left));
			current =
				this.#host.devices().find(entry => entry.id === device.id) ??
				fail(`${device.name} is no longer paired with this computer (Settings › Devices).`);
		}
		return current;
	}

	/**
	 * A paired device's tab, once it can answer: while the device's link is down the tab reports `error` and refuses
	 * every command (`remote_offline`); back online it re-attaches (`starting`, then its status). A local tab, and one
	 * whose device is online and settled, is returned as it is.
	 */
	async #reachTab(tab: ControlTab, callerTabId: string): Promise<ControlTab> {
		if (!tab.device) return tab;
		const device = this.#host.devices().find(entry => entry.id === tab.device);
		if (!device) return tab;
		const away = device.state !== "online";
		if (away) await this.#reach(device);
		else if (tab.status !== "error") return tab;
		// An `error` right after the link came back is the link's; one that stays is the host's own.
		const deadline = Date.now() + REATTACH_WAIT_MS;
		for (;;) {
			const now = this.#host.tabs(callerTabId)?.find(entry => entry.tabId === tab.tabId);
			if (!now) fail(`${label(tab)} was closed while ${device.name} reconnected.`);
			const settling =
				now.status === "error" ||
				(away && (now.status === "starting" || now.status === "restarting" || now.status === "waiting"));
			const left = deadline - Date.now();
			if (!settling || left <= 0) return now;
			await this.#nextChange(Math.min(LINK_POLL_MS, left));
		}
	}

	/**
	 * A read from a paired device that a link drop cut short is made once more when the link is back (reads only:
	 * a prompt or an answer may have arrived before the drop, so those are never repeated).
	 */
	async #overLink<T>(deviceId: string | undefined, read: () => Promise<T>): Promise<T> {
		try {
			return await read();
		} catch (error) {
			const device = deviceId ? this.#host.devices().find(entry => entry.id === deviceId) : undefined;
			if (!device || ipcErrorCode(error) !== "remote_offline") throw error;
			// The link's state turns a moment after the request failed.
			await this.#nextChange(LINK_POLL_MS);
			await this.#reach(this.#host.devices().find(entry => entry.id === deviceId) ?? device);
			return read();
		}
	}

	#devicesLine(): string {
		const devices = this.#host.devices();
		return devices.length
			? `Paired devices: ${devices.map(device => `${device.name} (id ${device.id}, ${device.state})`).join("; ")}; "local" is this computer.`
			: "No paired devices.";
	}

	async #list(caller: ControlTab, listed: ControlTab[], args: ListArgs): Promise<string> {
		const named = args.device === undefined ? undefined : this.#device(args.device);
		// A device asked for by name is waited for while its link comes back; its tabs re-attach meanwhile.
		const device = named ? await this.#reach(named) : named;
		const tabs = device && named?.state !== "online" ? (this.#host.tabs(caller.tabId) ?? listed) : listed;
		const limit = args.limit ?? LIST_DEFAULT_ROWS;
		if (args.scope === "stored") return this.#listStored(caller, tabs, args, device, limit);
		const opened = this.#openedBy(caller.tabId, tabs);
		const query = args.query?.toLowerCase();
		const app = args.scope === "app" || device !== undefined;
		const candidates = await Promise.all(
			tabs
				.filter(
					tab =>
						(app || tab.here) &&
						(device === undefined || (device === null ? !tab.device : tab.device === device.id)) &&
						(!args.folder || tab.cwd.includes(args.folder)) &&
						(!args.mine || opened.has(tab.tabId)) &&
						(!query || (!tab.hidden && tab.title.toLowerCase().includes(query))),
				)
				.map(tab => (device ? this.#reachTab(tab, caller.tabId).catch(() => tab) : tab)),
		);
		const rows = await Promise.all(
			candidates.map(async tab => {
				const marks = [
					tab.tabId === caller.tabId ? "this session" : null,
					opened.has(tab.tabId) ? "opened by you" : null,
					tab.here ? null : "another window",
				].filter(Boolean);
				if (tab.hidden && tab.tabId !== caller.tabId)
					return {
						kind: "idle",
						text: `- ${tab.tabId} (hidden from agents by the user)${marks.length ? ` [${marks.join(", ")}]` : ""}`,
					};
				const session = await this.#state(tab);
				const line = this.#stateLine(tab, session);
				const parts = [this.#withPickup(caller, tab, session, line), `folder ${tab.cwd}`];
				if (tab.worktree) parts.push(`worktree ${tab.worktree.branch}`);
				if (tab.deviceName) parts.push(`on ${tab.deviceName}`);
				const model = session.state?.model;
				if (model) parts.push(`model ${model.provider}/${model.id}`);
				if (session.state?.planModeEnabled) parts.push("plan mode");
				if (session.subagents.length) parts.push(`${session.subagents.length} subagent(s) running`);
				const todos = todoProgress(session.state?.todoPhases);
				if (todos) parts.push(todos);
				const head = `- ${tab.tabId} ${label(tab)}${marks.length ? ` [${marks.join(", ")}]` : ""}`;
				const answer = session.last ? `\n  last answer: ${oneLine(session.last, SUMMARY_CHARS)}` : "";
				const kind = waits(tab)
					? "waiting"
					: line.startsWith("running") || line === "starting"
						? "running"
						: "idle";
				return { kind, text: `${head}\n  ${parts.join("; ")}${answer}` };
			}),
		);
		const kept = rows.filter(row => !args.status || row.kind === args.status);
		const where = device
			? `on ${device.name}`
			: device === null
				? "on this computer"
				: app
					? "in this app (every window)"
					: "in this window";
		const more =
			kept.length > limit ? `\n… ${kept.length - limit} more; narrow with folder, status, query or limit.` : "";
		const elsewhere = tabs.filter(tab => !tab.here).length;
		const others = app
			? ""
			: `\n${elsewhere ? `${elsewhere} more open in other windows (scope app). ` : ""}Saved sessions, closed ones too: scope stored.`;
		const shown = kept
			.slice(0, limit)
			.map(row => row.text)
			.join("\n");
		return `${kept.length} session${kept.length === 1 ? "" : "s"} ${where}:\n${shown}${more}${others}\n${this.#devicesLine()}`;
	}

	async #listStored(
		caller: ControlTab,
		tabs: ControlTab[],
		args: ListArgs,
		device: ControlDevice | null | undefined,
		limit: number,
	): Promise<string> {
		if (args.status) fail("status filters open sessions; leave it out with scope stored.");
		const opened = this.#openedBy(caller.tabId, tabs);
		const mine = new Set(tabs.filter(tab => opened.has(tab.tabId)).flatMap(tab => tab.sessionPath ?? []));
		const rows = (await this.#overLink(device?.id, () => this.#host.stored(device?.id, args.query)))
			.filter(row => (!args.folder || row.cwd.includes(args.folder)) && (!args.mine || mine.has(row.path)))
			.sort((a, b) => b.modified.localeCompare(a.modified));
		for (const row of rows) this.#stored.set(row.id, row);
		const lines = rows.slice(0, limit).map(row => {
			if (row.hidden) return `- ${row.id} (hidden from agents by the user)`;
			const title = storedTitle(row);
			const open = row.tabId ? `; open in tab ${row.tabId}` : "";
			const hit = row.snippet ? `\n  match: ${oneLine(row.snippet, SUMMARY_CHARS)}` : "";
			return `- ${row.id} "${oneLine(title, 80)}"\n  folder ${row.cwd}; ${row.messages} message(s); ${row.status}; changed ${row.modified}${open}${hit}`;
		});
		const where = device ? `saved on ${device.name}` : "saved on this computer";
		const more = rows.length > limit ? `\n… ${rows.length - limit} more; narrow with folder, query or limit.` : "";
		return `${rows.length} session${rows.length === 1 ? "" : "s"} ${where}${args.query ? ` matching "${args.query}"` : ""}:\n${lines.join("\n")}${more}\nRead one with ompdesk_session_read; open it again with ompdesk_session_open {"reopen":"<id>"}.\n${this.#devicesLine()}`;
	}

	async #whenReady(tabId: string, callerTabId: string): Promise<void> {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		for (;;) {
			const tab = this.#host.tabs(callerTabId)?.find(entry => entry.tabId === tabId);
			if (!tab) fail("The new session's tab closed before it was ready.");
			if (tab.status === "ready" || tab.status === "running") return;
			if (tab.status === "error" || tab.status === "exited") fail(`The session could not start (${tab.status}).`);
			if (Date.now() >= deadline) fail("The session did not become ready in time.");
			await this.#nextChange(Math.min(500, deadline - Date.now()));
		}
	}

	/** Resolves on the next tab event or after `ms`, whichever comes first. */
	#nextChange(ms: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const done = (): void => {
			clearTimeout(timer);
			off();
			resolve();
		};
		const timer = setTimeout(done, Math.max(0, ms));
		const off = this.#host.observe(done);
		return promise;
	}

	async #resolveModel(tabId: string, wanted: string): Promise<ModelInfo> {
		const data = responseData<{ models?: ModelInfo[] }>(
			await this.#host.command(tabId, { type: "get_available_models" }, 15_000),
			"Reading the model list",
		);
		const models = data?.models ?? [];
		const lowered = wanted.toLowerCase();
		const exact = models.find(model => `${model.provider}/${model.id}`.toLowerCase() === lowered);
		if (exact) return exact;
		const byId = models.filter(model => model.id.toLowerCase() === lowered);
		if (byId.length === 1 && byId[0]) return byId[0];
		const near = models
			.filter(model => `${model.provider}/${model.id}`.toLowerCase().includes(lowered))
			.slice(0, 8)
			.map(model => `${model.provider}/${model.id}`);
		fail(
			byId.length > 1
				? `Model "${wanted}" is offered by several providers: ${byId.map(m => `${m.provider}/${m.id}`).join(", ")}. Give provider/id.`
				: `No model "${wanted}".${near.length ? ` Close matches: ${near.join(", ")}.` : " Use provider/id as the model picker lists it."}`,
		);
	}

	async #openMany(
		caller: ControlTab,
		tabs: ControlTab[],
		items: readonly OpenOne[],
		show?: OpenArgs["show"],
		tag?: string,
	): Promise<OpenResult[]> {
		if (this.#stopping(caller.tabId)) fail("Autopilot is ending: start nothing new.");
		const opened = this.#openedBy(caller.tabId, tabs);
		// Marked before the first await, so "opened by you" covers sessions still starting.
		const reservations = items.map(() => `pending:${Math.random()}`);
		for (const key of reservations) opened.add(key);
		const outcomes = await Promise.allSettled(
			items.map((item, index) => this.#openOne(caller, item, reservations[index] as string, opened, tag)),
		);
		const results: OpenResult[] = outcomes.map(outcome =>
			outcome.status === "fulfilled"
				? outcome.value
				: {
						tabId: "",
						error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
					},
		);
		const first = results.find(result => result.tabId);
		if (show && show !== "background" && first) this.#host.view(caller.tabId, { tabId: first.tabId, how: show });
		return results.map(result => {
			const tab = result.tabId
				? this.#host.tabs(caller.tabId)?.find(entry => entry.tabId === result.tabId)
				: undefined;
			return { ...result, where: tab ? `${tab.cwd}${tab.deviceName ? ` on ${tab.deviceName}` : ""}` : undefined };
		});
	}

	async #openOne(
		caller: ControlTab,
		args: OpenOne,
		reservation: string,
		opened: Set<string>,
		tag: string | undefined,
	): Promise<OpenResult> {
		const worktreeArg = args.worktree === true ? {} : args.worktree === false ? undefined : args.worktree;
		let device: string | null | undefined;
		let target: ControlDevice | null | undefined;
		if (args.device !== undefined) {
			target = this.#device(args.device);
			if (target) target = await this.#reach(target);
			device = target ? target.id : null;
		}
		let sessionPath: string | undefined;
		if (args.reopen) {
			const found = await this.#storedSession(args.reopen, target);
			const row =
				found.row ??
				fail(
					`No saved session "${args.reopen}" ${target ? `on ${target.name}` : target === null ? "on this computer" : "on this computer or a paired device"}${unreachedText(found.unreached)}. List them with ompdesk_sessions {"scope":"stored"} (with device for a paired device's).`,
				);
			if (row.hidden) fail("The user hid that session from other agents.");
			const open = this.#liveTab(this.#host.tabs(caller.tabId) ?? [], row);
			if (open)
				fail(
					`That session is already open as ${open.tabId}: use it directly (ompdesk_session_send, ompdesk_session_read).`,
				);
			if (args.device !== undefined && (device ?? undefined) !== row.device)
				fail("A saved session opens on the device it is saved on; leave device out with reopen.");
			const home = row.device ? this.#host.devices().find(entry => entry.id === row.device) : undefined;
			if (home) await this.#reach(home);
			sessionPath = row.path;
			device = row.device ?? null;
		}
		let tabId: string;
		let worktree: IpcTabWorktree | undefined;
		let prepared: string | undefined;
		// Its row reads as the work it was opened for from its first frame, not "New session" until stock names it.
		const task = args.message && !sessionPath ? agentTaskTitle(wrapAgentMessage(args.message, caller.title)) : null;
		try {
			({ tabId, worktree, prepared } = await this.#host.spawn(caller.tabId, {
				folder: args.folder,
				worktree: worktreeArg,
				...(device !== undefined ? { device } : {}),
				...(sessionPath ? { sessionPath } : {}),
				...(sessionPath && args.restore ? { restoreSaved: true as const } : {}),
				...(tag ? { tag } : {}),
				...(task ? { task } : {}),
			}));
		} catch (error) {
			if (!(error instanceof SessionFolderMissing) || !args.reopen) throw error;
			const { folder, saved } = error;
			if (!saved)
				fail(
					`The folder this saved session worked in no longer exists (${folder}) and nothing of it was saved, so it is not opened in any other folder. Its transcript stays readable with ompdesk_session_read {"session":"${args.reopen}"}.`,
				);
			fail(
				`The folder this saved session worked in (${folder}) was removed by OMPdesk's disk care, which saved it first (saved worktree ${saved.id}${saved.branch ? `, branch ${saved.branch}` : ""}, removed ${new Date(saved.removedAt).toISOString()}). Put it back and open the session there with ompdesk_session_open ${JSON.stringify({ reopen: args.reopen, restore: true })}; the person can also restore it from Work tree › Saved worktrees on the computer that holds it.`,
			);
		} finally {
			opened.delete(reservation);
		}
		opened.add(tabId);
		const call = this.#callScope.getStore();
		if (call) this.#host.calls?.note(call.key, tabId);
		try {
			await this.#whenReady(tabId, caller.tabId);
			const notes: string[] = [];
			// Journaled in the child, so its main agent gets the worker contract (gui-bridge agent-control.ts) from its
			// first turn on, across relaunches; a session the user opened (and reopened here) never carries it.
			if (sessionPath) notes.push("reopened");
			else
				responseData(
					await this.#host.command(
						tabId,
						{ type: "agent_control_worker", from: caller.title || "another session" },
						FIRST_COMMAND_TIMEOUT_MS,
					),
					"Marking the session as a worker",
				);
			if (args.model) {
				const model = await this.#resolveModel(tabId, args.model);
				responseData(
					await this.#host.command(tabId, { type: "set_model", provider: model.provider, modelId: model.id }),
					"Setting the model",
				);
				notes.push(`model ${model.provider}/${model.id}`);
			}
			if (args.mode === "plan") {
				responseData(
					await this.#host.command(tabId, { type: "set_plan_mode", enabled: true }),
					"Turning on plan mode",
				);
				notes.push("plan mode");
			}
			if (worktree) notes.push(`worktree ${worktree.branch}`);
			if (prepared) notes.push(prepared);
			await this.#host.beforeFirstPrompt?.({
				tabId,
				callerTabId: caller.tabId,
				...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch } } : {}),
				...(tag ? { tag } : {}),
			});
			if (args.message) {
				if (args.mode === "goal") {
					// The goal command starts the objective turn itself.
					responseData(
						await this.#host.command(tabId, { type: "set_goal", objective: args.message }, 30_000),
						"Setting the goal",
					);
					notes.push("goal set");
				} else {
					responseData(
						await this.#host.command(
							tabId,
							{
								type: "prompt",
								message: wrapAgentMessage(
									withDispatch(args.message, this.#mailbox.dispatch(tabId)),
									caller.title,
								),
								streamingBehavior: "followUp",
							},
							30_000,
						),
						"Sending the first message",
					);
				}
			}
			return { tabId, notes, worktree: worktree?.branch, started: args.message !== undefined };
		} catch (error) {
			// A child that cannot be set up does not linger half-configured, nor does the worktree made for it.
			opened.delete(tabId);
			const tabDevice = this.#host.tabs(caller.tabId)?.find(tab => tab.tabId === tabId)?.device;
			const closing = this.#closeTab(caller.tabId, tabId, { waitMs: CLOSE_WAIT_MS });
			if (!worktree) {
				void closing.catch(() => undefined);
				throw error;
			}
			const made = worktree;
			const message = error instanceof Error ? error.message : String(error);
			// Its worktree goes only once the tab is gone and its omp has exited (it works there until then): a tab
			// still open (the window kept it, or it is slow to close) works there, so the worktree stays and is named.
			if ((await closing.catch((): TabClose => "kept")) !== "closed")
				throw new Error(
					`${message} (its tab is still open, so its worktree ${made.path} and branch ${made.branch} were kept)`,
				);
			const removal = await this.#host.discardWorktree(made, tabDevice).catch(() => null);
			if (removal === "removed") throw error;
			throw new Error(
				removal === "branch-kept"
					? `${message} (its worktree ${made.path} was removed; git kept the branch ${made.branch})`
					: `${message} (git kept its worktree ${made.path} and branch ${made.branch}: something changed there or it is in use)`,
			);
		}
	}

	#openText(results: OpenResult[]): string {
		const lines = results.map(result =>
			result.tabId
				? `Opened session ${result.tabId}${result.where ? ` in ${result.where}` : ""}${result.notes?.length ? ` (${result.notes.join(", ")})` : ""}. ${
						result.started
							? "It is working on your message."
							: `It is idle; give it work with ompdesk_session_send {"session":"${result.tabId}","message":"…"}.`
					}`
				: `Could not open a session: ${result.error}`,
		);
		const ids = results.filter(result => result.tabId).map(result => result.tabId);
		if (ids.length > 0 && results.some(result => result.started))
			lines.push(
				`They report back to you with ompdesk_report (done, question): end your turn and you are woken. To block now instead: ompdesk_session_result {"sessions":${JSON.stringify(ids)},"wait":true}.`,
			);
		return lines.join("\n");
	}

	async #ensureStarted(target: ControlTab, callerTabId: string): Promise<void> {
		if (target.status === "ready" || target.status === "running") return;
		if (target.status === "error" || target.status === "exited")
			fail(`${label(target)} is stopped (${target.status}); the user has to restart it.`);
		if (target.status === "asleep") this.#host.start(target.tabId);
		await this.#whenReady(target.tabId, callerTabId);
	}

	async #send(
		caller: ControlTab,
		target: ControlTab,
		args: { message: string; delivery?: "follow_up" | "steer"; request_id?: string },
	): Promise<string> {
		if (this.#stopping(caller.tabId)) fail("Autopilot is ending: start nothing new.");
		this.#refuseHidden(target, caller);
		if (caller.tabId === target.tabId) fail("A session cannot message itself.");
		// Idempotent: a retried call (a flaky link, a paired device) gets the first receipt, never a second delivery.
		const receiptKey = args.request_id
			? `${caller.sessionPath ?? caller.tabId}|${target.sessionPath ?? target.tabId}|${args.request_id}`
			: undefined;
		const known = receiptKey ? this.#receipts.get(receiptKey) : undefined;
		if (known) return `${known} (request ${args.request_id} was already delivered; nothing sent again)`;
		// A same-id call arriving while the first is still on its way joins it instead of sending again.
		const pending = receiptKey ? this.#inflight.get(receiptKey) : undefined;
		if (pending) return `${await pending} (request ${args.request_id} was already delivered; nothing sent again)`;
		if (!receiptKey) return this.#deliverSend(caller, target, args, undefined);
		const delivery = this.#deliverSend(caller, target, args, receiptKey);
		this.#inflight.set(receiptKey, delivery);
		try {
			return await delivery;
		} finally {
			this.#inflight.delete(receiptKey);
		}
	}

	/**
	 * A message never starts a turn under the person's hands: while they have a draft in the target's composer, a send
	 * waits for it to be sent or cleared (`DRAFT_WAIT_MS`), then fails saying so. Idea after OpenRig's draft-aware
	 * delivery (mvschwarz/openrig ROADMAP, Apache-2.0).
	 */
	async #untilDraftSent(caller: ControlTab, target: ControlTab): Promise<void> {
		const deadline = Date.now() + DRAFT_WAIT_MS;
		// The live tab, never the listing `target` came from: the person may have started typing since.
		const draftingNow = (): boolean =>
			(this.#host.tabs(caller.tabId)?.find(tab => tab.tabId === target.tabId) ?? target).drafting === true;
		let drafting = draftingNow();
		while (drafting) {
			const left = deadline - Date.now();
			if (left <= 0)
				fail(
					`The person is typing in ${label(target)} (a draft sits in its composer): nothing was sent, so their message and yours do not collide. Try again once they have sent it, or report with ompdesk_report.`,
				);
			await this.#nextChange(Math.min(1000, left));
			drafting = draftingNow();
		}
	}

	async #deliverSend(
		caller: ControlTab,
		target: ControlTab,
		args: { message: string; delivery?: "follow_up" | "steer"; request_id?: string },
		receiptKey: string | undefined,
	): Promise<string> {
		await this.#ensureStarted(target, caller.tabId);
		// The target's journal is the durable record: a relaunch (or a retry whose first receipt was lost) finds the
		// request already there, and the last dispatch it was given.
		const marks = await this.#journalMarks(target.tabId);
		if (args.request_id && marks.requests.has(args.request_id))
			return `Sent to ${label(target)}: request ${args.request_id} was already delivered; nothing sent again.`;
		// Only a send that will deliver waits on the person's draft: a repeat of a delivered request answers at once.
		await this.#untilDraftSent(caller, target);
		const running = target.busy || (await this.#state(target)).state?.isStreaming === true;
		// One that already reported back to the caller in this turn waits in it (an answer) or wraps up: a follow-up
		// would sit unseen behind that turn, so it reaches it between steps instead.
		const reported = this.#reportedAt.get(`${target.tabId}\n${caller.tabId}`);
		const promoted =
			running && args.delivery !== "steer" && reported !== undefined && reported >= (target.busySince ?? 0);
		const steer = args.delivery === "steer" || promoted;
		// The opener gives its child new work: a new dispatch (its older reports turn stale) and its question is answered.
		const ownChild =
			this.#host.parentOf(target.tabId) === caller.tabId ||
			this.#openedBy(caller.tabId, this.#host.tabs(caller.tabId) ?? []).has(target.tabId);
		if (ownChild) this.#mailbox.seed(target.tabId, marks.dispatch);
		const dispatch = ownChild ? this.#mailbox.dispatch(target.tabId) : undefined;
		responseData(
			await this.#host.command(
				target.tabId,
				{
					type: "prompt",
					message: wrapAgentMessage(withDispatch(args.message, dispatch, args.request_id), caller.title),
					streamingBehavior: steer ? "steer" : "followUp",
				},
				30_000,
			),
			"Sending the message",
		);
		if (running && !steer && dispatch)
			this.#queuedFollowUp.set(target.tabId, { n: Number(dispatch.slice(1)), id: dispatch, from: caller.tabId });
		const how = !running
			? "it was idle and starts on it"
			: promoted
				? "delivered as steer (it already reported to you in this turn, so it reads it between steps)"
				: steer
					? "delivered as steer (it reads it between steps)"
					: "queued as a follow-up (it runs when the current turn ends; it is told so if it reports first)";
		const started = !running && (await this.#turnStarts(caller.tabId, target.tabId));
		const receipt = `Sent to ${label(target)}: accepted${started ? ", turn started" : ""}; ${how}.${dispatch ? ` Dispatch ${dispatch}: it reports back with ompdesk_report.` : ""}`;
		if (receiptKey) this.#receipts.set(receiptKey, receipt);
		return receipt;
	}

	/** `journalMarks` of a session's recent transcript; nothing when it cannot be read (not started, gone). */
	async #journalMarks(tabId: string): Promise<{ dispatch: number; requests: Set<string> }> {
		const page = await this.#host
			.command(tabId, { type: "get_transcript_page", fromEnd: true, limit: EVIDENCE_MESSAGES }, STATE_TIMEOUT_MS)
			.then(response => (response.success ? transcriptPage(response.data) : null))
			.catch(() => null);
		return journalMarks(page?.messages ?? []);
	}

	/** Receipt stage "turn started": the target is seen running within a few seconds of an accepted message. */
	async #turnStarts(callerTabId: string, tabId: string): Promise<boolean> {
		const deadline = Date.now() + TURN_START_WAIT_MS;
		for (;;) {
			const tab = this.#host.tabs(callerTabId)?.find(entry => entry.tabId === tabId);
			if (tab?.busy) return true;
			if (!tab || Date.now() >= deadline) return false;
			await this.#nextChange(Math.min(250, deadline - Date.now()));
		}
	}

	/**
	 * The work board's view of a child's mail to its opener: its last report, and whether its question waits. A
	 * question to a sibling or a checkout peer waits on that session, not here; one the child carried on from (a turn
	 * that started after it, e.g. the person answered in its own tab) waits no longer.
	 */
	#reportFields(tab: ControlTab): Pick<AgentReviewItem, "report" | "waiting"> {
		const opener = this.#host.parentOf(tab.tabId);
		const state = opener ? this.#mailbox.state(tab.tabId, opener) : undefined;
		if (!state) return {};
		const carriedOn = tab.busy && (tab.busySince ?? 0) > state.last.at;
		return {
			report: { kind: state.last.kind, text: oneLine(state.last.text, 240), at: state.last.at },
			...(state.waiting && !carriedOn ? { waiting: true as const } : {}),
		};
	}

	/**
	 * `ompdesk_report`: an opened session tells its opener (or a sibling) about its work; any session tells another one
	 * working in the same checkout or repository (`host.checkoutPeers`) what it is about to do, or asks it to hold or commit.
	 */
	async #report(caller: ControlTab, tabs: ControlTab[], args: ReportArgs): Promise<string> {
		const parent = this.#host.parentOf(caller.tabId);
		const target = args.to ? await this.#open(tabs, args.to, caller, "report to") : undefined;
		const peer =
			target !== undefined &&
			target.tabId !== parent &&
			(this.#host.checkoutPeers?.(caller.tabId) ?? []).includes(target.tabId);
		if (peer) this.#refuseHidden(target, caller);
		else if (!parent)
			fail(
				"ompdesk_report goes to the session that opened you, a sibling it opened, or a session working in the same checkout (the <shared-checkout> section names those); nobody opened this one, and it shares no checkout with that session. Use ompdesk_session_send to write to a session.",
			);
		else if (target && target.tabId !== parent && this.#host.parentOf(target.tabId) !== parent)
			fail(
				"You can report only to the session that opened you, to a sibling it opened, or to a session working in the same checkout.",
			);
		const to = target?.tabId ?? (parent as string);
		// A peer is woken only by a question or a blocker (and only when idle: a busy one gets it as an aside); every
		// other report reaches it as a note with no turn.
		const kind = peer
			? args.kind === "question" || args.kind === "blocked"
				? args.kind
				: "note"
			: to === parent
				? args.kind
				: "note";
		// A worktree child that says it is done reports what its git holds with it (custody.ts).
		const custody =
			to === parent && (kind === "done" || kind === "review") && caller.worktree
				? await this.#host
						.branchFacts(caller.worktree, caller.device)
						.then(facts => custodyOf(facts, args.files))
						.catch(() => null)
				: null;
		const mail: Mail = {
			// The same report from the same session file is the same id, so a call stock re-runs after a relaunch
			// (its result lost in the crash) is recognized by the receiver's journal instead of arriving twice.
			id:
				args.id ??
				createHash("sha256")
					.update(
						[
							caller.sessionPath ?? caller.tabId,
							// The receiver by its session file too: tab ids are new after a relaunch.
							tabs.find(tab => tab.tabId === to)?.sessionPath ?? to,
							args.kind,
							args.dispatch ?? "",
							args.text,
						].join("\u0000"),
					)
					.digest("hex")
					.slice(0, 24),
			from: caller.tabId,
			fromTitle: caller.title,
			to,
			kind,
			text: custody ? `${args.text}\n\n${custody.line}` : args.text,
			...(args.files ? { files: args.files } : {}),
			...(args.checks ? { checks: args.checks } : {}),
			...(args.dispatch ? { dispatch: args.dispatch } : {}),
			at: Date.now(),
		};
		if (!this.#mailbox.knows(caller.tabId))
			this.#mailbox.seed(caller.tabId, (await this.#journalMarks(caller.tabId)).dispatch);
		const outcome = await this.#mailbox.post(mail);
		if (parent) this.#host.reviewChanged?.(parent);
		if (outcome !== "duplicate" && outcome !== "stale" && WAITS_AFTER_REPORT.has(args.kind))
			this.#reportedAt.set(`${caller.tabId}\n${to}`, Date.now());
		const waiting =
			(await this.#queuedNote(caller, tabs)) +
			(custody?.gap && outcome !== "duplicate" && outcome !== "stale"
				? ` It carries what your git holds, and that disagrees with the report: ${custody.gap} Then report again.`
				: "");
		switch (outcome) {
			case "duplicate":
				return `Report ${mail.id} was already delivered; nothing sent again.${waiting}`;
			case "stale":
				return `Ignored: dispatch ${args.dispatch} is no longer current (the session that opened you has since sent dispatch ${this.#mailbox.current(caller.tabId)}). Work on its latest message.${waiting}`;
			case "queued":
				return `Progress noted; it reaches the session shortly (several progress reports arrive as the latest one).${waiting}`;
			default:
				return mail.kind === "question" || mail.kind === "blocked"
					? `Delivered. Wait for the answer: it comes as a message (between your steps while this turn runs); do not guess the decision meanwhile.${waiting}`
					: `Delivered.${waiting}`;
		}
	}

	/**
	 * Stock shows a queued follow-up to nobody until the turn ends, so a session that reports and then waits in the same
	 * turn never sees the message it waits for. When one is queued for `caller` and its transcript does not hold it yet,
	 * the report's answer says so.
	 */
	async #queuedNote(caller: ControlTab, tabs: ControlTab[]): Promise<string> {
		const queued = this.#queuedFollowUp.get(caller.tabId);
		if (!queued) return "";
		if ((await this.#journalMarks(caller.tabId)).dispatch >= queued.n) {
			this.#queuedFollowUp.delete(caller.tabId);
			return "";
		}
		const sender = tabs.find(tab => tab.tabId === queued.from);
		return ` A message from ${sender ? label(sender) : queued.from} (dispatch ${queued.id}) waits for you, queued until this turn ends: end your turn now to read it, rather than waiting for it in this turn.`;
	}

	async #sessionSummary(
		caller: ControlTab,
		tab: ControlTab,
		perAnswer: number,
	): Promise<{ settled: boolean; text: string }> {
		this.#refuseHidden(tab, caller);
		const session = await this.#state(tab);
		const line = this.#stateLine(tab, session);
		const settled = line === "idle" || line.startsWith("stopped") || line.startsWith("not started");
		const todos = todoProgress(session.state?.todoPhases);
		const hint = waits(tab) ? " It needs an answer: ompdesk_session_answer, or tell the user." : "";
		const body = session.last ? cut(session.last, perAnswer) : "(no answer yet)";
		return {
			settled: settled || waits(tab),
			text: `${label(tab)} [${tab.tabId}]: ${this.#withPickup(caller, tab, session, line)}.${todos ? ` ${todos}.` : ""}${hint}\nLast answer:\n${body}`,
		};
	}

	async #result(
		caller: ControlTab,
		targets: (ControlTab | StoredSession)[],
		args: { wait?: boolean; until?: "all" | "any"; timeout_seconds?: number },
		table: boolean,
	): Promise<string> {
		const seconds = args.timeout_seconds ?? RESULT_WAIT_DEFAULT_SECONDS;
		const deadline = Date.now() + seconds * 1000;
		const perAnswer = table ? RESULT_TABLE_ANSWER_CHARS : RESULT_MAX_CHARS;
		// A saved session no tab holds is finished as its file says; it is read once.
		const saved = new Map(
			await Promise.all(
				targets.flatMap(target => {
					if ("busy" in target) return [];
					if (target.hidden) fail("The user hid a session you asked about from other agents.");
					return [
						this.#overLink(target.device, () => this.#host.storedMessages(target)).then(messages => {
							const last = transcriptEnding(messages).last;
							const where = `saved${target.deviceName ? ` on ${target.deviceName}` : ""}, not open in any tab`;
							return [
								target.id,
								{
									settled: true,
									text: `"${oneLine(storedTitle(target), 80)}" [${target.id}]: ${where}.\nLast answer:\n${last ? cut(last, perAnswer) : "(no answer)"}`,
								},
							] as const;
						}),
					];
				}),
			),
		);
		const ids = targets.map(target => ("busy" in target ? target.tabId : target.id));
		for (;;) {
			const tabs = this.#host.tabs(caller.tabId);
			const current = targets.map(target =>
				"busy" in target ? tabs?.find(tab => tab.tabId === target.tabId) : target,
			);
			const gone = current.findIndex(tab => !tab);
			if (gone >= 0) fail(`${label(targets[gone] as ControlTab)} was closed while you waited.`);
			const summaries = await Promise.all(
				current.map((target, index) =>
					target && "busy" in target
						? this.#sessionSummary(caller, target, perAnswer)
						: (saved.get(ids[index] as string) as { settled: boolean; text: string }),
				),
			);
			const done = summaries.filter(summary => summary.settled).length;
			const ready = args.until === "any" ? done > 0 : done === summaries.length;
			const timedOut = Date.now() >= deadline;
			if (!args.wait || ready || timedOut) {
				// The opener has the answer now: the session may close once its work landed.
				for (const [index, summary] of summaries.entries()) {
					const target = current[index];
					if (summary.settled && target && "busy" in target) this.#collected.add(target.tabId);
				}
				const note =
					args.wait && timedOut && !ready
						? `Still running after waiting ${seconds} s (${done}/${summaries.length} finished).\n`
						: "";
				return `${note}${summaries.map(summary => summary.text).join("\n\n")}`;
			}
			await this.#nextChange(Math.min(POLL_MS, deadline - Date.now()));
		}
	}

	async #read(target: ControlTab, args: { limit?: number; before?: string }): Promise<string> {
		const caller = { tabId: "" } as ControlTab;
		this.#refuseHidden(target, caller);
		if (target.status !== "ready" && target.status !== "running") {
			// A tab with no omp (deferred after a relaunch, asleep): its saved file on the computer it runs on answers,
			// and nothing starts it.
			if (target.sessionPath) return this.#readStored(this.#tabRow(target, target.sessionPath), args);
			fail(`${label(target)} has not started; there is no transcript to read yet.`);
		}
		const limit = args.limit ?? READ_DEFAULT_MESSAGES;
		const page =
			transcriptPage(
				responseData<unknown>(
					await this.#overLink(target.device, async () => {
						const response = await this.#host.command(
							target.tabId,
							args.before
								? { type: "get_transcript_page", cursor: args.before, limit }
								: { type: "get_transcript_page", fromEnd: true, limit },
							30_000,
						);
						if (!response.success && response.code === "remote_offline")
							throw new Error(`[remote_offline] ${response.error}`);
						return response;
					}),
					"Reading the transcript",
				),
			) ?? fail("The transcript page came back empty.");
		this.#collected.add(target.tabId);
		return renderPage(label(target), target.tabId, page.messages, page.totalMessages, page.prevCursor ?? null);
	}

	/** A saved session's transcript, paged from its end; the cursor is the index of the page's first message. */
	async #readStored(row: StoredSession, args: { limit?: number; before?: string }): Promise<string> {
		if (row.hidden) fail("The user hid this session from other agents.");
		const messages = await this.#overLink(row.device, () => this.#host.storedMessages(row));
		const limit = args.limit ?? READ_DEFAULT_MESSAGES;
		const end = args.before === undefined ? messages.length : Number.parseInt(args.before, 10);
		if (!Number.isInteger(end) || end < 0 || end > messages.length)
			fail(`"${args.before}" is not a cursor of this session; use the one a previous page returned.`);
		const start = Math.max(0, end - limit);
		const title = `"${oneLine(storedTitle(row), 80)}" (saved${row.deviceName ? ` on ${row.deviceName}` : ""}${row.tabId ? `, open in tab ${row.tabId}` : ", not open"})`;
		return renderPage(title, row.id, messages.slice(start, end), messages.length, start > 0 ? String(start) : null);
	}

	/**
	 * Every way an agent names a session, the first match wins: a tab id; an id the tab had before a relaunch (whole
	 * only: tab ids are random, so it names that session alone); the saved (stock) id of the session a tab holds; a
	 * unique prefix of a tab id or of that saved id; the title, exactly or by a unique prefix in any case (a hidden
	 * session's title is private and never matched); then a saved session no tab holds (`#storedSession`, on `device`
	 * when given). An ambiguous name fails, naming the candidates.
	 */
	async #find(
		tabs: ControlTab[],
		session: string,
		device?: ControlDevice | null,
	): Promise<{ target?: ControlTab | StoredSession; unreached: string[] }> {
		const name = session.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
		const only = (matches: ControlTab[]): ControlTab | undefined => {
			if (matches.length > 1)
				fail(
					`"${name}" matches several sessions: ${matches
						.slice(0, 6)
						.map(tab => `${tab.tabId} ${label(tab)}`)
						.join("; ")}. Use the full id from ompdesk_sessions.`,
				);
			return matches[0];
		};
		// Stock names a session file `<time>_<session id>.jsonl`.
		const savedId = (tab: ControlTab): string | undefined =>
			tab.sessionPath ? /_([^_/\\]+)\.jsonl$/.exec(tab.sessionPath)?.[1] : undefined;
		const listed = this.#stored.get(name);
		const tab =
			tabs.find(entry => entry.tabId === name) ??
			tabs.find(entry => entry.formerIds?.includes(name)) ??
			tabs.find(entry => savedId(entry) === name) ??
			(listed ? this.#liveTab(tabs, listed) : undefined) ??
			(name.length >= SESSION_PREFIX_MIN
				? (only(tabs.filter(entry => entry.tabId.startsWith(name))) ??
					only(tabs.filter(entry => savedId(entry)?.startsWith(name))))
				: undefined);
		if (tab) return { target: tab, unreached: [] };
		const wanted = name.toLowerCase();
		const titled = tabs.filter(entry => !entry.hidden);
		const titleOf = (entry: ControlTab): string => (entry.title || entry.task || "").trim().toLowerCase();
		const byTitle =
			only(titled.filter(entry => titleOf(entry) === wanted)) ??
			(wanted.length >= TITLE_PREFIX_MIN
				? only(titled.filter(entry => titleOf(entry).startsWith(wanted)))
				: undefined);
		if (byTitle) return { target: byTitle, unreached: [] };
		const { row, unreached } = await this.#storedSession(name, device);
		return { target: row ? (this.#liveTab(tabs, row) ?? row) : undefined, unreached };
	}

	/**
	 * A saved session by stock id, unique id prefix or exact title: the rows the last stored lists printed first, then
	 * a fresh read of the index of `device` (this computer when null). With `device` undefined, a name not saved here
	 * is looked up on every paired device too: a saved id names its session wherever it is saved, also after a relaunch
	 * forgot the lists. `unreached` names the devices whose index could not be read.
	 */
	async #storedSession(
		session: string,
		device?: ControlDevice | null,
	): Promise<{ row?: StoredSession; unreached: string[] }> {
		const where = device === undefined ? undefined : (device?.id ?? undefined);
		const find = (): StoredSession | undefined => {
			const rows = [...this.#stored.values()].filter(row => device === undefined || row.device === where);
			const exact = rows.find(row => row.id === session);
			if (exact) return exact;
			const several = (matches: StoredSession[]): StoredSession | undefined => {
				if (matches.length > 1)
					fail(
						`"${session}" matches several saved sessions: ${matches
							.slice(0, 6)
							.map(row => `${row.id} "${oneLine(storedTitle(row), 60)}"`)
							.join("; ")}. Use the full id.`,
					);
				return matches[0];
			};
			const wanted = session.toLowerCase();
			return (
				(session.length >= SESSION_PREFIX_MIN
					? several(rows.filter(row => row.id.startsWith(session)))
					: undefined) ??
				several(rows.filter(row => !row.hidden && storedTitle(row).trim().toLowerCase() === wanted))
			);
		};
		const known = find();
		if (known) return { row: known, unreached: [] };
		const load = async (deviceId: string | undefined): Promise<void> => {
			for (const row of await this.#overLink(deviceId, () => this.#host.stored(deviceId)))
				this.#stored.set(row.id, row);
		};
		if (device !== undefined) {
			if (device) await this.#reach(device);
			await load(device?.id);
			return { row: find(), unreached: [] };
		}
		await load(undefined);
		const local = find();
		if (local) return { row: local, unreached: [] };
		const unreached: string[] = [];
		await Promise.all(
			this.#host.devices().map(async paired => {
				try {
					await load((await this.#reach(paired)).id);
				} catch {
					unreached.push(paired.name);
				}
			}),
		);
		return { row: find(), unreached };
	}

	/**
	 * The tab that has a saved session open now. A listed row's `tabId` is only what was true when it was listed: that
	 * tab may have closed since (the device closed it), or another tab opened the session after the list.
	 */
	#liveTab(tabs: ControlTab[], row: StoredSession): ControlTab | undefined {
		return (
			(row.tabId ? tabs.find(tab => tab.tabId === row.tabId) : undefined) ??
			tabs.find(tab => tab.sessionPath === row.path && tab.device === row.device)
		);
	}

	/** An open session, or a saved one (open in a tab: that tab). `device`: where a saved id is looked up. */
	async #resolveAny(
		tabs: ControlTab[],
		session: string,
		self: ControlTab,
		verb: string,
		device?: ControlDevice | null,
	): Promise<ControlTab | StoredSession> {
		const found = await this.#find(tabs, session, device);
		const target =
			found.target ??
			fail(
				`No session "${session}" open in this app or saved ${device ? `on ${device.name}` : device === null ? "on this computer" : "on this computer or a paired device"}${unreachedText(found.unreached)}. Call ompdesk_sessions (scope app for open ones, scope stored for saved ones, with device for a paired device's) and use an id it lists.`,
			);
		if (!("busy" in target)) return target;
		if (target.tabId === self.tabId) fail(`You cannot ${verb} your own session with this tool.`);
		return this.#reachTab(target, self.tabId);
	}

	async #answer(caller: ControlTab, target: ControlTab, args: AnswerArgs): Promise<string> {
		this.#refuseHidden(target, caller);
		const asks = target.asks.filter(ask => !askTitle(ask.request).startsWith(AGENT_CARD_PREFIX));
		if (asks.length === 0 && target.plan) return this.#answerPlan(caller, target, target.plan, args);
		if (asks.length === 0)
			fail(
				target.asks.length > 0
					? "That is a confirmation card for the user (OMPdesk asks the person before an agent action); only the user answers it."
					: `${label(target)} is not waiting for an answer (${this.#stateLine(target, { state: null, last: null, step: null, subagents: [] })}). See where it is with ompdesk_session_result; only a session ompdesk_sessions lists as waiting can be answered.`,
			);
		const ask = args.request ? asks.find(entry => entry.id === args.request) : asks[0];
		if (!ask) fail(`No pending request "${args.request}" there. Pending: ${asks.map(entry => entry.id).join(", ")}.`);
		const request = ask.request;
		let response: ExtensionUIResponse;
		let summary: string;
		if (request.method === "select") {
			const approval = approvalChoices(request);
			// `approve` answers a tool approval; on a plain choice card it names no option.
			const wanted =
				args.choice ??
				(args.approve === undefined || !approval ? undefined : args.approve ? approval.once : APPROVE_DENY);
			if (wanted === undefined)
				fail(
					[
						`No choice given: pass \`choice\` with one of: ${request.options.map(option => `"${option}"`).join(" | ")}.`,
						...(args.text !== undefined ? ["`text` answers a text prompt, not this choice card."] : []),
						...(args.approve !== undefined
							? ["`approve` answers a tool approval or a yes/no card, not this choice."]
							: []),
						...(request.options.includes(OTHER_OPTION)
							? [
									`To give an answer of your own, choose "${OTHER_OPTION}": the session then asks for the text, which you answer with \`text\`.`,
								]
							: []),
					].join(" "),
				);
			const choice = pickOption(request.options, wanted);
			// Every approving answer (this call, for the session, a remembered folder or file) needs the user's leave;
			// Deny never does.
			if (approval && choice !== APPROVE_DENY && !this.#host.approveEnabled())
				fail(
					"사용자 승인이 필요해요: this is a tool approval in another session and the user has not let agents approve for them (Settings › Tools & extensions). Tell the user, or show the session with ompdesk_tab_focus. Deny is allowed.",
				);
			response = { type: "extension_ui_response", id: ask.id, value: choice };
			summary = `"${choice}" to "${oneLine(request.title, 100)}"`;
		} else if (request.method === "confirm") {
			// A yes or no, however it was given.
			const said = args.choice ?? args.text;
			if (args.approve === undefined && said === undefined)
				fail(`This is a yes/no card ("${oneLine(request.title, 100)}"): pass \`approve\` true or false.`);
			const yes = args.approve ?? /^\s*(y|yes|ok|true|confirm|approve|allow)/i.test(said ?? "");
			response = { type: "extension_ui_response", id: ask.id, confirmed: yes };
			summary = `${yes ? "yes" : "no"} to "${oneLine(request.title, 100)}"`;
		} else if (request.method === "input" || request.method === "editor") {
			// The words to type, whichever field carried them.
			const text = args.text ?? args.choice;
			if (text === undefined)
				fail(`This is a text prompt ("${oneLine(request.title, 100)}"): pass \`text\` with the answer to type.`);
			response = { type: "extension_ui_response", id: ask.id, value: text };
			summary = `text to "${oneLine(request.title, 100)}"`;
		} else if (request.method === "ask") {
			const one = request.questions.length === 1;
			// One question takes `choice` or `text` as its answer too; several need `answers`, one entry each.
			const given =
				args.answers ??
				(one && (args.choice !== undefined || args.text !== undefined)
					? [
							{
								...(args.choice !== undefined ? { selected: [args.choice] } : {}),
								...(args.text ? { text: args.text } : {}),
							},
						]
					: []);
			if (!one && given.length === 0)
				fail(
					`This card asks ${request.questions.length} questions: pass \`answers\` with one entry each: [${request.questions
						.map(
							question =>
								`{"id": "${question.id}", "selected": [<one of ${question.options.map(option => `"${option.label}"`).join(" | ")}>]}`,
						)
						.join(", ")}] (or "text" instead of "selected" for an answer of your own).`,
				);
			const answers = request.questions.map(question => {
				const mine = given.find(entry => entry.id === question.id) ?? (one ? given[0] : undefined);
				if (!mine)
					fail(
						`No answer for question "${question.id}" (${oneLine(question.question, 80)}): pass \`answers\` ([{"id": "${question.id}", "selected": [<one of ${question.options.map(option => `"${option.label}"`).join(" | ")}>]}], or "text" instead of "selected" for an answer of your own).`,
					);
				const labels = question.options.map(option => option.label);
				const selected = (mine.selected ?? []).map(name => pickOption(labels, name));
				if (selected.length === 0 && !mine.text)
					fail(`Question "${question.id}": choose an option (${labels.join(" | ")}) or give text.`);
				if (selected.length > 1 && !question.multi) fail(`Question "${question.id}" takes one option.`);
				return { id: question.id, selectedOptions: selected, ...(mine.text ? { customInput: mine.text } : {}) };
			});
			response = { type: "extension_ui_response", id: ask.id, answers };
			summary = `${answers.length} answer(s)`;
		} else {
			return fail(
				`That request (${request.method}) is not a question an agent can answer: show it to the user with ompdesk_tab_focus.`,
			);
		}
		await this.#host.answer(target.tabId, ask.id, response);
		await this.#host.markAnswered(target.tabId, caller.title || caller.tabId).catch(() => undefined);
		return `Answered ${label(target)}: ${summary}. It continues now.`;
	}

	/**
	 * A plan proposal, through the same `plan_approval` command the plan card sends: approve with an option, or
	 * reject (with `text`, stock's feedback turn). Approving follows the tool-approval rule; rejecting always works.
	 */
	async #answerPlan(
		caller: ControlTab,
		target: ControlTab,
		plan: { title: string; planFilePath: string },
		args: AnswerArgs,
	): Promise<string> {
		const approve = args.approve ?? (args.choice === undefined ? undefined : !/^(reject|deny|no)/i.test(args.choice));
		if (approve === undefined)
			fail("Give approve: true (choice execute, compact or keep_context) or approve: false (text = feedback).");
		const name = `"${oneLine(plan.title || "plan", 100)}"`;
		let command: RpcCommand;
		let summary: string;
		if (approve) {
			const option = args.choice === undefined || args.choice === "Approve" ? "execute" : args.choice;
			if (option !== "execute" && option !== "compact" && option !== "keep_context")
				fail(`Plan option "${option}": use execute, compact or keep_context.`);
			if (!this.#host.approveEnabled())
				fail(
					"사용자 승인이 필요해요: approving another session's plan needs the user's permission for agents to approve (Settings › Tools & extensions). Tell the user, or show the session with ompdesk_tab_focus. Rejecting with feedback is allowed.",
				);
			command = { type: "plan_approval", approved: true, option };
			summary = `approved plan ${name} (${option})`;
		} else {
			const feedback = args.text?.trim();
			command = { type: "plan_approval", approved: false, ...(feedback ? { feedback } : {}) };
			summary = feedback ? `rejected plan ${name} with feedback` : `rejected plan ${name}`;
		}
		responseData(await this.#host.command(target.tabId, command), "Answering the plan");
		await this.#host.markAnswered(target.tabId, caller.title || caller.tabId).catch(() => undefined);
		return `Answered ${label(target)}: ${summary}.${approve || args.text?.trim() ? " It continues now." : ""}`;
	}

	/**
	 * Own children: free. Others: one confirmation card unless the user let agents manage other sessions (default
	 * on). Deleting a saved session another session opened always asks: a delete cannot be undone.
	 */
	async #stop(
		caller: ControlTab,
		tabs: ControlTab[],
		target: ControlTab,
		args: { close?: boolean; delete?: boolean },
	): Promise<string> {
		this.#refuseHidden(target, caller);
		const own = this.#openedBy(caller.tabId, tabs).has(target.tabId);
		const params = { caller: caller.title || "—", target: target.title || target.tabId };
		// Closing the tab of a session that rests (no turn, no question, the person neither looks at it nor typed into
		// it since) loses nothing: its session stays saved and reopens as it was. That needs no card, whoever opened it.
		const resting = !target.busy && !waits(target) && !target.looked && !target.userTouched;
		const harmless = args.close === true && !args.delete && resting;
		if (args.close && !args.delete && (target.looked || target.userTouched))
			fail(`${label(target)} is in the user's view or they typed into it; leave it open, or ask the user.`);
		if (!own && !harmless && !this.#host.fullEnabled() && (args.delete === true || !this.#host.manageEnabled())) {
			const approved = await this.#host.confirm(
				caller.tabId,
				this.#host.text("stopTitle", params),
				this.#host.text(args.delete ? "deleteMessage" : args.close ? "closeMessage" : "stopMessage", params),
			);
			if (!approved)
				return `The user declined: ${label(target)} keeps running. Do not ask again unless they tell you to.`;
		}
		this.#closing.add(target.tabId);
		const running = target.busy && (target.status === "ready" || target.status === "running");
		let confirmed = !running;
		try {
			// Stock answers an abort once the turn unwound; a close never waits on that (closing ends the omp), a stop
			// and a delete (which needs the turn over) wait a bounded while and say what they saw.
			if (running)
				confirmed = await this.#abort(
					caller,
					target,
					args.close && !args.delete ? ABORT_BEFORE_CLOSE_MS : STOP_WAIT_MS,
				);
			if (args.delete) await this.#deleteWhenIdle(caller, target);
			else if (args.close) {
				// The card and the lines took time: the person may have opened it meanwhile.
				const now = this.#host.tabs(caller.tabId)?.find(tab => tab.tabId === target.tabId);
				if (now && (now.looked || now.userTouched))
					fail(`${label(target)} came into the user's view meanwhile; it stays open.`);
				const outcome = await this.#closeTab(caller.tabId, target.tabId, { waitMs: CLOSE_WAIT_MS });
				if (outcome === "kept")
					fail(
						`${label(target)} is still open: its window kept the tab (it is that window's last tab, or it holds unsaved Files edits). Ask the user to close it; its session is saved either way.`,
					);
				if (outcome === "dirty")
					fail(
						`${label(target)} is still open: its page holds unsaved edits in the Files editor of this tab, and closing it would lose them. Ask the user to save or discard them, then close it again; its session is saved either way.`,
					);
			}
			// Told only once the tab is gone: a close that did not happen sends no note.
			if (args.close || args.delete)
				await this.#within(this.#journalClose(caller, target, args.delete === true), ABORT_BEFORE_CLOSE_MS);
		} finally {
			this.#closing.delete(target.tabId);
		}
		if (args.delete) {
			const done = `Stopped, closed and deleted ${label(target)}.`;
			return own && target.worktree ? `${done} ${await this.#dropWorktree(target.worktree, target.device)}` : done;
		}
		if (args.close) return `Closed ${label(target)} (its session stays saved).`;
		if (!running) return `${label(target)} was not running; nothing to stop.`;
		if (confirmed || !this.#host.tabs(caller.tabId)?.find(tab => tab.tabId === target.tabId)?.busy)
			return `Stopped ${label(target)}.`;
		return `Asked ${label(target)} to stop; it has not confirmed after ${STOP_WAIT_MS / 1000} s (a tool or subagent is still unwinding) and stops once that ends. Check it with ompdesk_session_result {"session":"${target.tabId}"}, or end it now with ompdesk_session_stop {"session":"${target.tabId}","close": true} (closing ends its omp; the session stays saved).`;
	}

	/** Stock's abort, answered within `waitMs` (true) or not yet (false); it is sent either way and never fails. */
	async #abort(caller: ControlTab, target: ControlTab, waitMs: number): Promise<boolean> {
		const answered = this.#host
			.command(target.tabId, { type: "abort", origin: { agentControl: caller.tabId } }, waitMs)
			.then(response => response.success)
			.catch(() => false);
		return (await this.#within(answered, waitMs)) === true;
	}

	/** `promise`'s value, or undefined once `ms` passed (the promise runs on). */
	async #within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
		const late = Promise.withResolvers<undefined>();
		const timer = setTimeout(() => late.resolve(undefined), ms);
		try {
			return await Promise.race([promise, late.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Main deletes a session only while no turn runs in it (`session_running`); an abort's turn ends a moment after it
	 * was sent, so the delete is tried again until `STOP_WAIT_MS` passed.
	 */
	async #deleteWhenIdle(caller: ControlTab, target: ControlTab): Promise<void> {
		const deadline = Date.now() + STOP_WAIT_MS;
		for (;;) {
			try {
				await this.#host.deleteSession(caller.tabId, target.tabId);
				return;
			} catch (error) {
				const left = deadline - Date.now();
				if (ipcErrorCode(error) !== "session_running") throw error;
				if (left <= 0)
					fail(
						`${label(target)} is still finishing its turn after ${STOP_WAIT_MS / 1000} s, so it was not deleted. Close it first (ompdesk_session_stop {"session":"${target.tabId}","close": true}), then delete its saved session by its saved id from ompdesk_sessions {"scope":"stored"}.`,
					);
				await this.#nextChange(Math.min(LINK_POLL_MS * 4, left));
			}
		}
	}

	/**
	 * A saved session no tab holds: nothing runs to stop or close; a delete removes its file on the device it is saved
	 * on (the sidebar's delete). The caller cannot have it open, so a delete asks unless full control is on.
	 */
	async #stopStored(
		caller: ControlTab,
		row: StoredSession,
		args: { close?: boolean; delete?: boolean },
	): Promise<string> {
		if (row.hidden) fail("The user hid that session from other agents.");
		const name = `"${oneLine(storedTitle(row), 80)}" (saved${row.deviceName ? ` on ${row.deviceName}` : ""})`;
		if (!args.delete) return `${name} is not open in any tab: nothing to stop or close.`;
		if (!this.#host.fullEnabled()) {
			const params = { caller: caller.title || "—", target: storedTitle(row) || row.id };
			const approved = await this.#host.confirm(
				caller.tabId,
				this.#host.text("stopTitle", params),
				this.#host.text("deleteMessage", params),
			);
			if (!approved) return `The user declined: ${name} stays saved. Do not ask again unless they tell you to.`;
		}
		await this.#host.deleteStored(row);
		this.#stored.delete(row.id);
		return `Deleted ${name}.`;
	}

	/**
	 * A deleted child's worktree and branch go only when nothing would be lost (clean tree, untracked files included,
	 * branch tip in the parent's HEAD or upstream); otherwise both stay and the answer says what is unlanded.
	 */
	async #dropWorktree(worktree: WorktreeRef, device: string | undefined): Promise<string> {
		const removal = await this.#host.removeSafeWorktree(worktree, device).catch(() => null);
		if (removal === "removed") return `Removed its worktree ${worktree.path} and branch ${worktree.branch}.`;
		if (removal === "branch-kept")
			return `Removed its worktree ${worktree.path}; git kept branch ${worktree.branch} (not merged into the parent checkout's HEAD).`;
		const facts = await this.#host.branchFacts(worktree, device).catch(() => null);
		const unlanded = facts
			? [
					facts.merged ? null : `${facts.commitsAhead} commit(s) not in the base or its upstream`,
					facts.uncommitted ? `${facts.uncommitted} uncommitted file(s)` : null,
					facts.untracked ? `${facts.untracked} untracked file(s)` : null,
				].filter(Boolean)
			: [];
		return `Kept its worktree ${worktree.path} and branch ${worktree.branch}${unlanded.length ? `: ${unlanded.join(", ")}` : ""}. Land it with git there, or remove it yourself if the work is not wanted.`;
	}

	/** A close is journaled as one quiet line in both sessions (best effort: a line never blocks the close). */
	async #journalClose(caller: ControlTab, target: ControlTab, deleted: boolean): Promise<void> {
		const at = Date.now();
		const line = (from: ControlTab, text: string) => ({
			id: `close:${target.sessionPath ?? target.tabId}:${at}:${from.tabId}`,
			from: from.tabId,
			fromTitle: from.title,
			kind: "note",
			label: "note",
			text,
		});
		const quiet = deliveryFor("note");
		const closed = `${deleted ? "Deleted" : "Closed"} ${label(target)}${deleted ? "" : " (its session stays saved)"}.`;
		await Promise.allSettled([
			this.#host.mail(caller.tabId, closed, line(caller, closed), quiet),
			this.#host.mail(
				target.tabId,
				`${caller.title || "Another session"} closed this session's tab.`,
				line(caller, `closed this tab`),
				quiet,
			),
		]);
	}

	/** What a compare reads from one session: its final answer, the checks it ran and its worktree's diff. */
	async #evidence(caller: ControlTab, target: ControlTab | StoredSession, diffChars: number): Promise<Evidence> {
		const open = "busy" in target;
		if (open) this.#refuseHidden(target, caller);
		else if (target.hidden) fail("The user hid a session you asked to compare from other agents.");
		const id = open ? target.tabId : target.id;
		const name = open ? label(target) : `"${oneLine(storedTitle(target), 80)}" (saved)`;
		let messages: readonly AgentMessage[] = [];
		let state = "saved, not open";
		let answer: string | null = null;
		if (open) {
			const session = await this.#state(target);
			state = this.#stateLine(target, session);
			answer = session.last;
			if (target.status === "ready" || target.status === "running")
				messages =
					transcriptPage(
						await this.#host
							.command(
								target.tabId,
								{ type: "get_transcript_page", fromEnd: true, limit: EVIDENCE_MESSAGES },
								30_000,
							)
							.then(response => (response.success ? response.data : null))
							.catch(() => null),
					)?.messages ?? [];
		} else {
			messages = await this.#host.storedMessages(target);
			const last = [...messages].reverse().find(message => message.role === "assistant");
			answer = last ? contentText(last.content).trim() || null : null;
		}
		const checks = checksRun(messages);
		const checkLine = checks.length
			? `checks run: ${checks
					.slice(-8)
					.map(check => `\`${oneLine(check.command, 100)}\` ${check.passed ? "passed" : "FAILED"}`)
					.join("; ")}`
			: "checks run: none seen in its transcript";
		const lines = [`- ${id} ${name}: ${state}`, `  ${checkLine}`];
		const worktree = open ? target.worktree : undefined;
		let diff = "";
		let diffOmitted = 0;
		if (!worktree) lines.push("  no worktree: no branch to diff");
		else {
			const [facts, read] = await Promise.all([
				this.#host.branchFacts(worktree, target.device).catch((error: unknown) => errorText(error)),
				this.#host.branchEvidence(worktree, diffChars, target.device).catch((error: unknown) => errorText(error)),
			]);
			if (typeof facts === "string") lines.push(`  could not read its branch: ${facts}`);
			else {
				const added = facts.files.reduce((sum, file) => sum + file.added, 0);
				const removed = facts.files.reduce((sum, file) => sum + file.removed, 0);
				const shown = facts.files
					.slice(0, 12)
					.map(file => `${file.path} +${file.added} −${file.removed}`)
					.join(", ");
				const more = facts.files.length > 12 ? `, … ${facts.files.length - 12} more` : "";
				const toMerge = !facts.merged && facts.commitsAhead > 0;
				const prediction: MergePrediction =
					typeof read === "string" ? { kind: "unknown", reason: read } : read.merge;
				if (open && toMerge && prediction.kind === "conflict") this.#conflicts.set(target.tabId, prediction.files);
				else if (open && prediction.kind === "clean") this.#conflicts.delete(target.tabId);
				const problem =
					mergeProblem(worktree, facts) ??
					(toMerge && prediction.kind === "conflict"
						? `merging would conflict; ask that session to merge ${facts.baseBranch} into its branch and resolve the conflicts, then compare again.`
						: null);
				lines.push(
					`  branch ${facts.branch} → ${facts.baseBranch ?? "(detached)"}: ${facts.commitsAhead} commit(s) ahead, ${facts.files.length} file(s) changed (+${added} −${removed})${facts.merged ? ", already merged" : ""}`,
					`  uncommitted ${facts.uncommitted}, untracked ${facts.untracked}${shown ? `\n  files: ${shown}${more}` : ""}`,
					...(toMerge ? [`  ${predictionLine(prediction, facts.baseBranch)}`] : []),
					`  ${problem ? `cannot merge yet: ${problem}` : "ready to merge with ompdesk_merge"}`,
				);
			}
			if (typeof read !== "string") {
				diff = read.diff;
				diffOmitted = read.diffOmitted;
			}
		}
		const facts = lines.slice(1).join("\n");
		lines.push(`  final answer: ${answer ? oneLine(answer, 700) : "(none yet)"}`);
		return { id, text: lines.join("\n"), facts, answer, checks, diff, diffOmitted };
	}

	/**
	 * Each session's evidence (final answer, checks from its transcript, worktree diff and merge prediction); with
	 * criteria, one judge request on the caller's omp (stock's advisor chain, then slow, a model of another family than
	 * the caller's when one has credentials) grades them and names a winner. A failed judge leaves the evidence with
	 * `Verdict: unavailable`. Runs no tests.
	 */
	async #compare(
		caller: ControlTab,
		tabs: ControlTab[],
		ids: string[] | undefined,
		criteria: string[] | undefined,
	): Promise<string> {
		const own = this.#openedBy(caller.tabId, tabs);
		const targets = ids
			? await Promise.all(ids.map(id => this.#resolveAny(tabs, id, caller, "compare")))
			: tabs.filter(tab => own.has(tab.tabId) && tab.worktree);
		if (targets.length === 0)
			fail("No worktree sessions to compare. Open sessions with worktree: true, or pass sessions.");
		const diffChars = criteria ? Math.floor(JUDGE_EVIDENCE_CHARS / targets.length) : 0;
		const evidence = await Promise.all(targets.map(target => this.#evidence(caller, target, diffChars)));
		for (const target of targets) if ("busy" in target) this.#collected.add(target.tabId);
		const blocks = evidence.map(entry => entry.text).join("\n");
		if (!criteria)
			return `${blocks}\nCompare runs no tests: ask each session to run them (ompdesk_session_send) and read its answer. Pass criteria to have them judged.`;
		const verdict = await this.#judge(caller, evidence, criteria).catch(
			(error: unknown) =>
				`Verdict: unavailable (${oneLine(errorText(error), 400)}). Judge the evidence below yourself or compare again.`,
		);
		return `${verdict}\n\nEvidence:\n${blocks}`;
	}

	async #judge(caller: ControlTab, evidence: Evidence[], criteria: string[]): Promise<string> {
		const per = Math.floor(JUDGE_EVIDENCE_CHARS / evidence.length);
		const session = (entry: Evidence): string => {
			const answer = cut(entry.answer ?? "(none)", Math.max(500, Math.floor(per * 0.2)));
			let checksLeft = Math.floor(per * 0.15);
			const checks: string[] = [];
			for (const check of entry.checks.slice(-JUDGE_CHECKS).reverse()) {
				const block = `$ ${oneLine(check.command, 200)} → ${check.passed ? "passed" : "FAILED"}\n${check.tail}`;
				if (block.length > checksLeft) break;
				checksLeft -= block.length;
				checks.unshift(block);
			}
			const room = Math.max(0, per - entry.facts.length - answer.length - checks.join("\n").length - 200);
			const bounded = entry.diff.length > room ? boundDiff(entry.diff, room) : { text: entry.diff, omitted: 0 };
			const omitted = entry.diffOmitted + bounded.omitted;
			return [
				`<session id="${entry.id}">`,
				entry.facts,
				...(checks.length ? ["check output (newest last):", ...checks] : []),
				"final answer:",
				answer,
				...(bounded.text
					? [`diff${omitted ? ` (${omitted} characters left out)` : ""}:`, bounded.text]
					: entry.diff || omitted
						? [`diff: ${omitted} characters, none fit`]
						: []),
				"</session>",
			].join("\n");
		};
		const user = [
			"Acceptance criteria:",
			...criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
			"",
			...evidence.map(session),
		].join("\n");
		const reply = responseData<JudgeReply>(
			await this.#host.command(caller.tabId, { type: "agent_control_judge", system: JUDGE_SYSTEM, user }, 180_000),
			"Judging",
		);
		const parsed = parseVerdict(reply?.text ?? "");
		const cost = `${judgeLabel(reply)}${typeof reply?.usd === "number" ? `, $${reply.usd.toFixed(4)}` : ""}`;
		if (!parsed) return `Judge${cost} (its answer was not the expected JSON):\n${cut(reply?.text ?? "", 4000)}`;
		const known = new Set(evidence.map(entry => entry.id));
		const ranking = parsed.ranking.filter(row => known.has(row.session)).sort((a, b) => b.score - a.score);
		const lines = [`Verdict${cost}:`];
		ranking.forEach((row, index) => {
			lines.push(`${index + 1}. ${row.session}: ${row.score}/100. ${oneLine(row.reasons, 400)}`);
			for (const item of row.criteria)
				lines.push(
					`   - ${item.met}: ${oneLine(item.criterion, 120)}${item.why ? ` (${oneLine(item.why, 200)})` : ""}`,
				);
		});
		lines.push(
			parsed.winner && known.has(parsed.winner)
				? `Winner: ${parsed.winner}. ${oneLine(parsed.why, 500)}`
				: `No winner: ${oneLine(parsed.why || "none meets the criteria", 500)}`,
		);
		return lines.join("\n");
	}

	/** Merge a worktree session's branch into the parent checkout: one card unless the user turned it off. */
	async #merge(caller: ControlTab, target: ControlTab): Promise<string> {
		const worktree = this.#mergeable(caller, target);
		const facts = await this.#host.branchFacts(worktree, target.device);
		const problem = mergeProblem(worktree, facts);
		if (problem) fail(problem);
		if (!this.#host.manageEnabled()) {
			const approved = await this.#host.confirm(
				caller.tabId,
				this.#host.text("mergeTitle", {}),
				this.#host.text("mergeMessage", {
					caller: caller.title || "—",
					target: target.title || target.tabId,
					branch: worktree.branch,
					base: facts.baseBranch ?? "",
					cwd: worktree.baseCwd,
				}),
			);
			if (!approved)
				return `The user declined the merge of ${worktree.branch}. Do not ask again unless they tell you to.`;
		}
		return this.#runMerge(target, worktree);
	}

	#mergeable(caller: ControlTab, target: ControlTab): WorktreeRef {
		this.#refuseHidden(target, caller);
		if (!target.worktree)
			fail(`${label(target)} has no worktree branch to merge (open sessions with worktree: true).`);
		if (target.busy || waits(target)) fail(`${label(target)} is still working or waiting; collect its result first.`);
		return target.worktree;
	}

	async #runMerge(target: ControlTab, worktree: WorktreeRef): Promise<string> {
		const outcome = await this.#host.mergeBranch(worktree, target.title, target.device);
		if (!outcome.merged) {
			this.#conflicts.set(target.tabId, outcome.files);
			const ask = `Ask ${label(target)} to merge the parent's branch into its own and resolve, then try again.`;
			fail(
				outcome.predicted
					? `Merging ${worktree.branch} would conflict in ${outcome.files.join(", ")} (predicted by git merge-tree): no merge was attempted and ${worktree.baseCwd} is unchanged. ${ask}`
					: `Merge conflict in ${outcome.files.join(", ")}: the merge was aborted and ${worktree.baseCwd} is unchanged. ${ask}`,
			);
		}
		this.#conflicts.delete(target.tabId);
		this.#reviewed.add(target.tabId);
		this.#collected.add(target.tabId);
		return `Merged ${worktree.branch} into ${worktree.baseCwd} (${outcome.sha}${outcome.summary ? `: ${outcome.summary}` : ""}). Nothing was pushed.`;
	}

	/**
	 * A child's review item, or null when nothing is left to review: an idle child whose branch landed (its tip is in the
	 * parent's branch or the upstream it tracks) with no uncommitted or untracked file, which ended well and waits on
	 * no answer. A landed child with files left over lists only those files.
	 */
	async #reviewItem(tab: ControlTab, session: SessionState): Promise<AgentReviewItem | null> {
		// A tab restored but not started (asleep) runs nothing; one starting or restarting may still be working.
		const running =
			tab.busy || waits(tab) || (tab.status !== "ready" && tab.status !== "running" && tab.status !== "asleep");
		const conflict = this.#conflicts.get(tab.tabId);
		const item: AgentReviewItem = {
			tabId: tab.tabId,
			...(tab.sessionPath ? { sessionPath: tab.sessionPath } : {}),
			...(tab.device ? { device: tab.device } : {}),
			title: tab.title || tab.task || "",
			state: running ? "running" : conflict ? "conflict" : "needs-review",
			commitsAhead: 0,
			files: 0,
			added: 0,
			removed: 0,
			uncommitted: 0,
			answer: session.last ? oneLine(session.last, 240) : "",
			...(running && session.step ? { step: session.step } : {}),
			...(running && tab.busySince ? { runningSince: tab.busySince } : {}),
			...(!running &&
			(tab.lastRun?.stopReason === "error" ||
				tab.lastRun?.stopReason === "aborted" ||
				parseWorkerResult(session.last)?.kind === "problem")
				? { failed: true as const }
				: {}),
			...(conflict ? { note: conflict.join(", ") } : {}),
			...this.#reportFields(tab),
			// Its plan waits for approval, or a question card of its own waits for an answer: the opener (or the person)
			// answers it, nothing is left to review. The card's own question goes along, for the line under its row.
			...(() => {
				const card = tab.asks.find(entry => !askTitle(entry.request).startsWith(AGENT_CARD_PREFIX));
				const question = card ? askTitle(card.request).trim() : tab.plan ? tab.plan.title?.trim() : "";
				return tab.plan || card
					? { waiting: true as const, ...(question ? { question: oneLine(question, 240) } : {}) }
					: {};
			})(),
		};
		if (!tab.worktree) return item;
		try {
			const facts = await this.#host.branchFacts(tab.worktree, tab.device);
			const clean = facts.uncommitted === 0 && facts.untracked === 0;
			if (facts.merged && clean && !running && !item.failed && !item.waiting) {
				this.#conflicts.delete(tab.tabId);
				return null;
			}
			return {
				...item,
				branch: facts.branch,
				baseBranch: facts.baseBranch,
				commitsAhead: facts.commitsAhead,
				files: facts.files.length,
				added: facts.files.reduce((sum, file) => sum + file.added, 0),
				removed: facts.files.reduce((sum, file) => sum + file.removed, 0),
				// Untracked files are work the branch does not hold yet either.
				uncommitted: facts.uncommitted + facts.untracked,
			};
		} catch {
			return { ...item, branch: tab.worktree.branch };
		}
	}

	/** The sessions `callerTabId` opened that wait for the person (or still run), for the work board. */
	async reviewItems(callerTabId: string): Promise<AgentReviewItem[]> {
		return (await this.review(callerTabId)).items;
	}

	/**
	 * The work board's list (`reviewItems`) plus what every session `callerTabId` opened runs on and has cost, the
	 * landed ones without an item included: the family's cost counts them all.
	 */
	async review(callerTabId: string): Promise<AgentReviewResult> {
		const tabs = this.#host.tabs(callerTabId);
		if (!tabs) return { items: [], usage: {} };
		await this.#nameUntitled(tabs);
		const own = this.#openedBy(callerTabId, tabs);
		const children = tabs.filter(tab => own.has(tab.tabId) && !tab.hidden);
		// The session's own journal too: the family's cost (Work tree head) is it plus all it opened.
		const caller = tabs.find(tab => tab.tabId === callerTabId);
		const usageOf = async (tab: ControlTab, session?: SessionState): Promise<AgentChildUsage> => {
			const [state, cost, split] = await Promise.all([
				session ?? this.#state(tab),
				this.#cost(tab),
				this.#split(tab),
			]);
			const model = state.state?.model;
			return { ...(model ? { model: `${model.provider}/${model.id}` } : {}), cost, ...(split ? { split } : {}) };
		};
		const [rows, callerUsage] = await Promise.all([
			Promise.all(
				children.map(async tab => {
					const session = await this.#state(tab);
					const [item, usage] = await Promise.all([
						this.#reviewed.has(tab.tabId) ? null : this.#reviewItem(tab, session),
						usageOf(tab, session),
					]);
					return { item, usage, key: tab.sessionPath ?? tab.tabId };
				}),
			),
			caller ? usageOf({ ...caller, hidden: false }) : undefined,
		]);
		const usage: Record<string, AgentChildUsage> = Object.fromEntries(rows.map(row => [row.key, row.usage]));
		if (caller && callerUsage) usage[caller.sessionPath ?? callerTabId] = callerUsage;
		return { items: rows.flatMap(row => (row.item ? [row.item] : [])), usage };
	}

	/**
	 * What each session `callerTabId` opened changed, for its work board's "Changed" row: its newest turn's edit calls
	 * (`get_turn_edits` of its own omp, or its saved file while it is not started) and, in a worktree, what its branch
	 * has not landed (`get_git_unlanded`); with `since`, also each one closed after its work landed since then (its
	 * saved file, read once). Asked through main, so a window viewing the opener (a phone) counts children it holds no
	 * tab of. A session hidden from agents is left out.
	 */
	async familyEdits(callerTabId: string, since?: number): Promise<FamilyEdits> {
		const tabs = this.#host.tabs(callerTabId);
		if (!tabs) return { members: [] };
		const own = this.#openedBy(callerTabId, tabs);
		const ask = <T>(
			tab: ControlTab,
			type: "get_turn_edits" | "get_git_unlanded",
			valid: (data: unknown) => data is T,
		) =>
			this.#host
				.command(tab.tabId, { type }, STATE_TIMEOUT_MS)
				.then(response => (response.success && valid(response.data) ? response.data : null))
				.catch(() => null);
		const open = await Promise.all(
			tabs
				.filter(tab => own.has(tab.tabId) && !tab.hidden)
				.map(async (tab): Promise<FamilyMemberEdits> => {
					const ready = tab.status === "ready" || tab.status === "running";
					const saved = tab.sessionPath ? this.#tabRow(tab, tab.sessionPath) : undefined;
					const [edits, unlanded] = await Promise.all([
						ready
							? ask(tab, "get_turn_edits", isTurnEdits)
							: saved
								? this.#host
										.storedMessages(saved)
										.then(messages => turnEdits(messages, tab.cwd))
										.catch(() => null)
								: null,
						tab.worktree && ready ? ask(tab, "get_git_unlanded", isGitUnlanded) : null,
					]);
					return {
						key: tab.sessionPath ?? tab.tabId,
						title: tab.title || tab.task || "",
						live: tab.busy || waits(tab),
						...(tab.device ? { device: tab.device } : {}),
						edits,
						unlanded,
					};
				}),
		);
		const caller = tabs.find(tab => tab.tabId === callerTabId);
		const shown = new Set(tabs.map(tab => `${tab.device ?? ""}\0${tab.sessionPath ?? ""}`));
		const closed =
			since !== undefined && caller?.sessionPath
				? (this.#host.closedChildren?.() ?? []).filter(
						child =>
							child.openedBySession === caller.sessionPath &&
							child.closedAt >= since &&
							!shown.has(`${child.device ?? ""}\0${child.path}`),
					)
				: [];
		return { members: [...open, ...(await Promise.all(closed.map(child => this.#closedEdits(child))))] };
	}

	/**
	 * A closed child's last turn never changes: its saved file is read once, on the computer it ran on (a paired
	 * device's through its stock helper); a failed read is tried again on the next ask.
	 */
	#closedEdits(child: ClosedChild): Promise<FamilyMemberEdits> {
		// Reopened and closed again, the same file holds a newer last turn: each close is its own version.
		const where = `${child.device ?? ""}\0${child.path}\0${child.closedAt}`;
		let turn = this.#closedTurns.get(where);
		if (!turn) {
			const row: StoredSession = {
				id: child.path,
				path: child.path,
				title: child.title,
				firstMessage: "",
				cwd: child.cwd,
				modified: "",
				messages: 0,
				status: "",
				hidden: false,
				...(child.device ? { device: child.device } : {}),
			};
			turn = this.#host.storedMessages(row).then(messages => turnEdits(messages, child.cwd));
			this.#closedTurns.set(where, turn);
			turn.catch(() => this.#closedTurns.delete(where));
		}
		return turn
			.catch(() => null)
			.then(edits => ({
				key: child.path,
				title: child.title,
				live: false,
				...(child.device ? { device: child.device } : {}),
				edits,
				unlanded: null,
			}));
	}

	/**
	 * `last` (the review list last sent) with what moves inside a running child's turn read again: its step and what
	 * it has cost so far. Only the running children (of `only`, when given: those that moved on since) are read, with
	 * no git. Null when none of `callerTabId`'s children it would read runs.
	 */
	async liveReview(
		callerTabId: string,
		last: AgentReviewResult,
		only?: ReadonlySet<string>,
	): Promise<AgentReviewResult | null> {
		const tabs = this.#host.tabs(callerTabId);
		if (!tabs) return null;
		const own = this.#openedBy(callerTabId, tabs);
		const running = tabs.filter(
			tab => own.has(tab.tabId) && !tab.hidden && tab.busy && (only === undefined || only.has(tab.tabId)),
		);
		if (running.length === 0) return null;
		const usage = { ...last.usage };
		const items = [...last.items];
		await Promise.all(
			running.map(async tab => {
				const [page, cost, split] = await Promise.all([
					this.#host
						.command(tab.tabId, { type: "get_transcript_page", fromEnd: true, limit: 8 }, STATE_TIMEOUT_MS)
						.then(response => (response.success ? transcriptPage(response.data) : null))
						.catch(() => null),
					this.#cost(tab),
					this.#split(tab),
				]);
				const key = tab.sessionPath ?? tab.tabId;
				const { split: _split, ...kept } = usage[key] ?? { cost: 0 };
				usage[key] = { ...kept, cost, ...(split ? { split } : {}) };
				const index = items.findIndex(item => item.tabId === tab.tabId);
				const item = items[index];
				if (item?.state !== "running" || !page) return;
				const { step: _step, ...rest } = item;
				const step = currentStep(page.messages);
				items[index] = { ...rest, ...(step ? { step } : {}) };
			}),
		);
		return { items, usage };
	}

	/**
	 * What a session has cost over its whole journal (the title bar's figure). While its omp cannot say (restarting, a
	 * paired device's link down, a read past its timeout) the last figure read stands: a cost never drops to nothing.
	 */
	async #cost(tab: ControlTab): Promise<number> {
		if (tab.hidden) return 0;
		const response =
			tab.status === "ready" || tab.status === "running"
				? await this.#host.command(tab.tabId, { type: "get_session_stats" }, STATE_TIMEOUT_MS).catch(() => null)
				: null;
		if (!response?.success) return this.#lastSpend.get(tab.tabId)?.cost ?? 0;
		const stats = response.data as { cost?: unknown; history?: { cost?: unknown } } | undefined;
		const read = typeof stats?.history?.cost === "number" ? stats.history.cost : stats?.cost;
		const cost = typeof read === "number" && Number.isFinite(read) && read > 0 ? read : 0;
		this.#lastSpend.set(tab.tabId, { ...this.#lastSpend.get(tab.tabId), cost });
		return cost;
	}

	/**
	 * The session's spend split into a metered charge and a subscription's estimate, classed by its own host
	 * (`get_session_spend`: its journal per provider, that computer's auth data); the last split read while its omp
	 * cannot say.
	 */
	async #split(tab: ControlTab): Promise<CostSplit | undefined> {
		if (tab.hidden) return undefined;
		const response =
			tab.status === "ready" || tab.status === "running"
				? await this.#host.command(tab.tabId, { type: "get_session_spend" }, STATE_TIMEOUT_MS).catch(() => null)
				: null;
		const spend = response?.success ? (response.data as SessionSpend | undefined) : undefined;
		if (!spend?.providers) return this.#lastSpend.get(tab.tabId)?.split;
		const split = costSplitOf(spend.providers);
		this.#lastSpend.set(tab.tabId, { cost: this.#lastSpend.get(tab.tabId)?.cost ?? 0, split });
		return split;
	}

	/**
	 * Resolves once the tab is out of the caller's window and its omp has exited, or after a few seconds. The omp
	 * outlives its tab by a moment, and where it works is no folder to remove or hand on while it does (Windows).
	 */
	async #whenGone(callerTabId: string, tabId: string, waitMs = 10_000): Promise<void> {
		const deadline = Date.now() + waitMs;
		while (this.#host.tabs(callerTabId)?.some(tab => tab.tabId === tabId) && Date.now() < deadline)
			await this.#nextChange(Math.min(500, deadline - Date.now()));
		// The window kept the tab: its omp runs on.
		if (this.#host.tabs(callerTabId)?.some(tab => tab.tabId === tabId)) return;
		await this.#within(this.#host.exited(tabId), OMP_EXIT_WAIT_MS);
	}

	/**
	 * Close one open tab and wait for it to be gone, as `tabCloseStep` decides from the tab now. `kept`: the tab is
	 * still open; `dirty`: not touched, its paired page's unsaved Files edits in it are the person's.
	 */
	async #closeTab(callerTabId: string, tabId: string, how: { auto?: boolean; waitMs: number }): Promise<TabClose> {
		const tabs = this.#host.tabs(callerTabId);
		if (!tabs) return "kept";
		const tab = tabs.find(entry => entry.tabId === tabId);
		if (!tab) return "closed";
		const step = tabCloseStep(tab);
		if (step.action === "keep") return step.reason === "dirty" ? "dirty" : "kept";
		if (step.action === "ask-window")
			this.#host.view(callerTabId, { tabId, how: "close", ...(how.auto ? { auto: true } : {}) });
		else if (!(await this.#host.release(callerTabId, tabId))) return "kept";
		await this.#whenGone(callerTabId, tabId, how.waitMs);
		return this.#host.tabs(callerTabId)?.some(entry => entry.tabId === tabId) ? "kept" : "closed";
	}

	/**
	 * Close the sessions `callerTabId` opened whose work has landed and that nobody is using (`autoCloseDecision`):
	 * the tab closes the way the person's close does (the window refuses it for a tab in use), the session file stays
	 * and the opener's family keeps a row for it; the worktree goes only when its branch is merged and it is clean.
	 * Called on tab activity and on a timer by `AgentControlRuntime`; one pass per caller at a time.
	 */
	async autoClose(callerTabId: string): Promise<void> {
		if (!this.#host.enabled() || this.#sweeping.has(callerTabId)) return;
		const tabs = this.#host.tabs(callerTabId);
		const caller = tabs?.find(tab => tab.tabId === callerTabId);
		if (!tabs || !caller?.sessionPath) return;
		this.#sweeping.add(callerTabId);
		try {
			const openerIdle = !caller.busy && caller.resuming !== true && !waits(caller);
			for (const tab of tabs) {
				if (!this.#openedBy(callerTabId, tabs).has(tab.tabId) || this.#closing.has(tab.tabId)) continue;
				if (tab.busy || waits(tab)) {
					this.#collected.delete(tab.tabId);
					const asked = this.#nudged.get(tab.tabId);
					if (asked && tab.busy) asked.ran = true;
					continue;
				}
				if (!tab.autoClosable || tab.hidden) continue;
				// A child restored after a relaunch is judged by its transcript: not started (asleep), or started and
				// not run yet this launch (no lastRun). One this launch opened waits for its first turn to end.
				if (tab.status !== "ready" && !(tab.restored && tab.status === "asleep")) continue;
				if (!tab.lastRun && !tab.restored) continue;
				const facts = await this.#autoCloseFacts(tab, openerIdle);
				const reported = await this.#autoDone(caller, tabs, tab, facts);
				// A problem child's tab holds the only live trace of its failure: the report just sent is read in the
				// opener's next turn, so the tab closes in a later pass (the opener idle again, or a read of it).
				if (reported && facts.result === "problem") continue;
				// A question or blocker the opener has not answered is the child waiting: it stays open for the answer.
				if (facts.result === "problem" && this.#mailbox.state(tab.tabId, caller.tabId)?.waiting) continue;
				const decision = autoCloseDecision(facts);
				if (decision.action === "close") await this.#autoCloseTab(caller, tab, decision.removeWorktree);
				else await this.#nudgeSilent(caller, tab, facts);
			}
		} finally {
			this.#sweeping.delete(callerTabId);
		}
	}

	/**
	 * A child whose turn ended well with a verdict line (`Result: ok` / `Result: problem — <reason>`) and sent its
	 * opener nothing on the current dispatch gets its `done` report sent for it: the final answer, through `#report`
	 * (custody line, outbox, dedupe id, delivery). Measured: the child's own `ompdesk_report` done cost every worker
	 * dispatch two extra model requests. Never a failed or stopped turn, one the person typed into, one a relaunch
	 * restored, or a dispatch that already has a report. Resolves true when it sent the report.
	 */
	async #autoDone(caller: ControlTab, tabs: ControlTab[], tab: ControlTab, facts: AutoCloseFacts): Promise<boolean> {
		if (
			!facts.openedByAgent ||
			!facts.idle ||
			!facts.settled ||
			!facts.answered ||
			facts.ended !== "ok" ||
			(facts.result !== "ok" && facts.result !== "problem") ||
			facts.userTouched ||
			tab.restored ||
			this.#host.parentOf(tab.tabId) !== caller.tabId
		)
			return false;
		const dispatch = this.#mailbox.current(tab.tabId);
		const state = this.#mailbox.state(tab.tabId, caller.tabId);
		// A question or blocker the opener has not answered stays the child's standing word: a done would read as settled.
		if (state?.waiting) return false;
		// Only a finishing report of this dispatch stands for the answer: a milestone's progress or a note leaves the finish
		// to tell.
		const report = state?.last;
		if (report && report.dispatch === dispatch && (report.kind === "done" || report.kind === "review")) return false;
		if (this.#autoDoneFor.get(tab.tabId) === (dispatch ?? "")) return false;
		const answer = ((await this.#state(tab)).last ?? "").trim();
		if (!parseWorkerResult(answer)) return false;
		this.#autoDoneFor.set(tab.tabId, dispatch ?? "");
		const sent = await this.#report(tab, tabs, {
			kind: "done",
			text: cut(answer, MESSAGE_MAX_CHARS),
			...(dispatch ? { dispatch } : {}),
		}).then(
			() => true,
			() => false,
		);
		return sent;
	}

	/**
	 * A child whose turn ended well but said nothing about its work (no verdict line, no report on its current dispatch)
	 * is asked once to report; if its next turn still says nothing, its opener is told once. Never a child the person
	 * typed into, one restored by a relaunch, a failed or stopped turn, or one still working. Idea after OpenRig's stuck
	 * sweep and its custody rule that a closed item names how it ended (mvschwarz/openrig,
	 * docs/as-built/architecture/coordination-primitive.md, Apache-2.0).
	 */
	async #nudgeSilent(caller: ControlTab, tab: ControlTab, facts: AutoCloseFacts): Promise<void> {
		if (
			!facts.openedByAgent ||
			!facts.idle ||
			!facts.settled ||
			!facts.answered ||
			facts.ended !== "ok" ||
			facts.result !== "missing" ||
			facts.userTouched ||
			tab.restored
		)
			return;
		const dispatch = this.#mailbox.current(tab.tabId);
		const report = this.#mailbox.state(tab.tabId, caller.tabId)?.last;
		if (report && report.dispatch === dispatch) return;
		const answer = (await this.#state(tab)).last ?? "";
		const asked = this.#nudged.get(tab.tabId);
		const quiet = (text: string) => ({
			id: `nudge:${tab.sessionPath ?? tab.tabId}:${dispatch ?? ""}:${text.length}`,
			from: caller.tabId,
			fromTitle: caller.title,
			kind: "note",
			label: "note",
			text,
		});
		if (!asked || asked.dispatch !== dispatch) {
			this.#nudged.set(tab.tabId, { dispatch, answer, ran: false, toldOpener: false });
			const text = `OMPdesk: your turn ended with no \`Result: ok\` / \`Result: problem — <reason>\` line and no ompdesk_report about this work. Report where it stands now with ompdesk_report (kind done, blocked or question${dispatch ? `, dispatch "${dispatch}"` : ""}), and end your final answer with the Result line.`;
			await this.#host
				.mail(tab.tabId, text, quiet(text), { triggerTurn: true, deliverAs: "aside" })
				.catch(() => undefined);
			return;
		}
		// Still nothing after the turn it was asked in (seen running since, or a new answer is in): its opener hears of
		// it, once.
		if (asked.toldOpener || (!asked.ran && answer === asked.answer)) return;
		asked.toldOpener = true;
		const text = `${label(tab)} ended its turn again without a verdict line or a report, after OMPdesk asked it to report. Read its answer (ompdesk_session_result) or ask it where the work stands.`;
		await this.#host.mail(caller.tabId, text, quiet(text), deliveryFor("note")).catch(() => undefined);
	}

	async #autoCloseFacts(tab: ControlTab, openerIdle: boolean): Promise<AutoCloseFacts> {
		const asleep = tab.status === "asleep";
		const session = asleep ? null : await this.#state(tab);
		// The transcript speaks where this launch saw nothing (restored, asleep) and for an answer without a verdict
		// line, whose final `done` report may stand for it.
		const ending =
			asleep || tab.restored || !parseWorkerResult(session?.last ?? null)
				? transcriptEnding(await this.#transcript(tab, asleep))
				: null;
		const last = session?.last ?? ending?.last ?? null;
		const branch = tab.worktree
			? await this.#host
					.landing(tab.worktree, tab.device)
					.catch(() => ({ hasWork: false, landed: false, clean: false }))
			: null;
		const stopReason = tab.lastRun?.stopReason ?? ending?.stopReason;
		return {
			openedByAgent: tab.autoClosable === true,
			stored: typeof tab.sessionPath === "string",
			idle: asleep || (session?.state != null && session.state.isStreaming !== true),
			settled: asleep || session?.state?.isSettled !== false,
			answered: (last ?? "").trim() !== "",
			ended: stopReason === "error" || stopReason === "aborted" ? "failed" : "ok",
			result: parseWorkerResult(last)?.kind ?? (ending?.reportedDone ? "ok" : "missing"),
			branch,
			looked: tab.looked === true,
			userTouched: tab.userTouched === true || (tab.restored === true && ending?.personPrompted === true),
			collected: openerIdle || this.#collected.has(tab.tabId),
		};
	}

	/** A tab's saved session as a stored row, read on the computer the tab runs on. */
	#tabRow(tab: ControlTab, path: string): StoredSession {
		return {
			id: tab.tabId,
			path,
			title: tab.title,
			firstMessage: "",
			cwd: tab.cwd,
			modified: "",
			messages: 0,
			status: "",
			hidden: tab.hidden,
			tabId: tab.tabId,
			...(tab.device ? { device: tab.device } : {}),
			...(tab.deviceName ? { deviceName: tab.deviceName } : {}),
		};
	}

	/** A child's newest messages: the saved file of one not started (on the computer it runs on), else its live omp. */
	async #transcript(tab: ControlTab, asleep: boolean): Promise<AgentMessage[]> {
		if (asleep) {
			if (!tab.sessionPath) return [];
			return this.#host.storedMessages(this.#tabRow(tab, tab.sessionPath)).catch(() => []);
		}
		const response = await this.#host
			.command(tab.tabId, { type: "get_transcript_page", fromEnd: true, limit: EVIDENCE_MESSAGES }, STATE_TIMEOUT_MS)
			.catch(() => null);
		return (response?.success ? transcriptPage(response.data)?.messages : null) ?? [];
	}

	async #autoCloseTab(caller: ControlTab, tab: ControlTab, removeWorktree: boolean): Promise<void> {
		// A tab the close would keep (its paired page's unsaved Files edits): not worth reading the child.
		if (tabCloseStep(tab).action === "keep") return;
		this.#closing.add(tab.tabId);
		try {
			// Read before the close: the closed record keeps them for the opener's family cost.
			const [model, cost, split] = await Promise.all([
				this.#host
					.command(tab.tabId, { type: "get_state", brief: true }, STATE_TIMEOUT_MS)
					.then(response => (response.success ? (response.data as RpcSessionState | undefined)?.model : null))
					.catch(() => null),
				this.#cost(tab),
				this.#split(tab),
			]);
			// Not closed (the window kept it, the person came to it meanwhile, or its paired page holds unsaved Files
			// edits in it): nothing else changes, and a later pass tries again.
			const outcome = await this.#closeTab(caller.tabId, tab.tabId, { auto: true, waitMs: AUTO_CLOSE_WAIT_MS });
			if (outcome !== "closed") return;
			const removed =
				removeWorktree && tab.worktree
					? (await this.#host.removeSafeWorktree(tab.worktree, tab.device).catch(() => null)) !== null
					: false;
			this.#host.recordClosed({
				path: tab.sessionPath as string,
				openedBySession: caller.sessionPath as string,
				title: tab.title || tab.task || "",
				cwd: removed && tab.worktree ? tab.worktree.baseCwd : tab.cwd,
				...(tab.device ? { device: tab.device } : {}),
				closedAt: Date.now(),
				...(model ? { model: `${model.provider}/${model.id}` } : {}),
				...(cost > 0 ? { cost } : {}),
				...(split ? { split } : {}),
			});
		} finally {
			this.#closing.delete(tab.tabId);
		}
	}

	/** `ompdesk_schedule`: create, list or cancel the runs an agent put on the Schedules service of a device. */
	async #schedule(caller: ControlTab, args: ScheduleArgs): Promise<string> {
		// Default: the device the caller's own session runs on, so its folder is a path there.
		let device: ControlDevice | null;
		if (args.device !== undefined) device = this.#device(args.device);
		else if (caller.device) {
			const own = this.#host.devices().find(entry => entry.id === caller.device);
			if (!own) fail(`${caller.deviceName ?? caller.device} is no longer a paired device.`);
			device = own;
		} else device = null;
		if (device) device = await this.#reach(device);
		const where = device ? `on ${device.name}` : "on this computer";
		const source = this.#host.schedules(device?.id);
		if (!source) fail(`Scheduled runs are not available ${where}.`);
		const rows = await source.list();
		if (args.action === "list") {
			if (rows.length === 0) return `No scheduled runs ${where}.`;
			return [
				`Scheduled runs ${where}:`,
				...rows.map(
					row =>
						`- ${row.id} “${row.name}” ${describeFrequency(row.frequency)} in ${row.cwd}; ${row.enabled ? `next ${row.nextRun ?? "—"}` : "off"}${row.lastStatus ? `; last run ${row.lastStatus}` : ""}${row.name.startsWith(AGENT_SCHEDULE_PREFIX) ? " [made by an agent: you can cancel it]" : " [the user's own: leave it]"}`,
				),
			].join("\n");
		}
		const deviceArg = device ? `,"device":${JSON.stringify(device.name)}` : "";
		if (args.action === "cancel") {
			const id = args.id ?? "";
			const row =
				rows.find(entry => entry.id === id) ??
				rows.find(entry => id.length >= SESSION_PREFIX_MIN && entry.id.startsWith(id));
			if (!row)
				fail(`No scheduled run "${id}" ${where}. ompdesk_schedule {"action":"list"${deviceArg}} shows them.`);
			if (!row.name.startsWith(AGENT_SCHEDULE_PREFIX))
				fail(`“${row.name}” is the user's own schedule; only the user changes it (Settings › Schedules).`);
			await source.remove(row.id);
			return `Cancelled “${row.name}” ${where}.`;
		}
		const frequency: ScheduleFrequency =
			args.every_minutes !== undefined
				? { kind: "interval", minutes: args.every_minutes }
				: { kind: "daily", time: args.daily_at ?? "09:00", days: [...new Set(args.days ?? [])].sort() };
		// The caller's folder is a path on its own device; another device needs its folder named.
		if (!args.folder && device?.id !== caller.device) fail(`folder is required: name an absolute folder ${where}.`);
		const cwd = args.folder ?? caller.cwd;
		if (!(cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cwd))) fail("folder must be an absolute path.");
		const name = `${AGENT_SCHEDULE_PREFIX}${args.name ?? ""}`;
		if (!this.#host.manageEnabled()) {
			const approved = await this.#host.confirm(
				caller.tabId,
				this.#host.text("scheduleTitle", {}),
				this.#host.text("scheduleMessage", {
					caller: caller.title || "—",
					name: args.name ?? "",
					when: describeFrequency(frequency),
					folder: device ? `${cwd} (${device.name})` : cwd,
				}),
			);
			if (!approved) return "The user declined the schedule. Do not ask again unless they tell you to.";
		}
		const row = await source.save({
			name,
			prompt: args.prompt ?? "",
			cwd,
			frequency,
			model: args.model ?? null,
			autoApprove: false,
			enabled: true,
		});
		return `Scheduled “${row.name}” ${describeFrequency(frequency)} in ${cwd} ${where}; id ${row.id}; next run ${row.nextRun ?? "—"}. It runs only while OMPdesk is open ${where}, never with auto-approve; cancel it with ompdesk_schedule {"action":"cancel","id":"${row.id}"${deviceArg}}.`;
	}

	/** `ompdesk_autopilot`: start, read or stop an Autopilot run through the coordinator the Autopilot screen uses. */
	async #autopilot(caller: ControlTab, tabs: ControlTab[], args: AutopilotArgs): Promise<string> {
		const source = this.#host.autopilot;
		if (!source) fail("Autopilot is not available here.");
		if (args.action === "start") return this.#autopilotStart(caller, tabs, source, args);
		const target = await this.#open(tabs, args.session, caller, args.action === "stop" ? "stop" : "read");
		this.#refuseHidden(target, caller);
		const own = this.#openedBy(caller.tabId, tabs).has(target.tabId);
		if (args.action === "status") {
			if (!own && !this.#host.manageEnabled())
				fail(
					`${label(target)} is not an Autopilot run you started. Reading other runs needs the user's "Let agents manage other sessions" setting.`,
				);
			return describeRun(target, await this.#runStatus(source, target));
		}
		const before = await this.#runStatus(source, target);
		if (before.state === "ended") return `${describeRun(target, before)}\nIt has ended already.`;
		if (!own && !this.#host.manageEnabled()) {
			const params = { caller: caller.title || "—", target: target.title || target.tabId };
			const approved = await this.#host.confirm(
				caller.tabId,
				this.#host.text("stopTitle", params),
				this.#host.text("stopMessage", params),
			);
			if (!approved)
				return `The user declined: ${label(target)} keeps running. Do not ask again unless they tell you to.`;
		}
		const now = args.now === true;
		if (before.state === "stopping" && !now) return `${describeRun(target, before)}\nIt is ending already.`;
		this.#closing.add(target.tabId);
		try {
			const after = await source.stop(target.tabId, now);
			return `${describeRun(target, after)}\n${
				now
					? "Stopped now: the turn in flight was aborted and the run is paused (the user can resume it on the Autopilot screen)."
					: "Ending: it finishes the cycle in flight, then closes its children and stops. It will not continue by itself."
			}`;
		} finally {
			this.#closing.delete(target.tabId);
		}
	}

	async #runStatus(source: AutopilotSource, target: ControlTab): Promise<AutopilotStatus> {
		const status = await source.status(target.tabId);
		if (!status.active || status.role === "child") fail(`${label(target)} is not an Autopilot run.`);
		return status;
	}

	async #autopilotStart(
		caller: ControlTab,
		tabs: ControlTab[],
		source: AutopilotSource,
		args: Extract<AutopilotArgs, { action: "start" }>,
	): Promise<string> {
		if (this.#stopping(caller.tabId)) fail("Autopilot is ending: start nothing new.");
		const folder = args.folder === undefined ? trimSeparators(caller.cwd) : trimSeparators(args.folder);
		if (!(folder.startsWith("/") || /^[A-Za-z]:[\\/]/.test(folder))) fail("folder must be an absolute path.");
		let device = caller.device;
		let deviceName = caller.deviceName;
		if (args.device !== undefined) {
			const found = this.#device(args.device);
			if (found) await this.#reach(found);
			device = found?.id;
			deviceName = found?.name;
		}
		let sourceTab = [caller, ...tabs]
			.filter(tab => tab.device === device && !tab.hidden && trimSeparators(tab.cwd) === folder)
			.sort((a, b) => Number(b.status === "ready") - Number(a.status === "ready"))[0];
		if (!sourceTab && device === undefined)
			fail(
				`${folder} is not open in a session of this window on this computer. Autopilot starts from a folder one of those sessions has open: open one there first (ompdesk_session_open with folder), or use your own folder.`,
			);
		// On a paired host nothing has the folder open: a session there to start from, closed again once the run started.
		let sourceOpened: string | undefined;
		try {
			if (!sourceTab) {
				sourceOpened = (await this.#host.spawn(caller.tabId, { folder, device })).tabId;
				await this.#whenReady(sourceOpened, caller.tabId);
				sourceTab =
					this.#host.tabs(caller.tabId)?.find(tab => tab.tabId === sourceOpened) ??
					fail(`The session opened on ${deviceName ?? device} to start from is gone.`);
			}
			return await this.#autopilotFrom(caller, tabs, source, args, sourceTab, folder, deviceName);
		} catch (error) {
			if (error instanceof ToolError) throw error;
			return fail(`Autopilot did not start: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			// Best effort, no note: a web page's tab is released in main, a desktop window closes its own.
			if (sourceOpened)
				void this.#closeTab(caller.tabId, sourceOpened, { waitMs: CLOSE_WAIT_MS }).catch(() => undefined);
		}
	}

	/** The card, then the coordinator's start from `sourceTab` (on whichever computer runs it). */
	async #autopilotFrom(
		caller: ControlTab,
		tabs: ControlTab[],
		source: AutopilotSource,
		args: Extract<AutopilotArgs, { action: "start" }>,
		sourceTab: ControlTab,
		folder: string,
		deviceName: string | undefined,
	): Promise<string> {
		const where = deviceName ? `${folder} on ${deviceName}` : folder;
		const plan = await source.plan(sourceTab.tabId);
		// A start always names its level: the card says what it will do, and an omitted one commits only.
		const ship = args.ship ?? "commit";
		const advanced = args.advanced ?? {};
		if (advanced.cadence !== undefined && ship !== "release")
			fail("advanced.cadence goes with ship release (it is the release rhythm).");
		const onDefaultBranch =
			args.branch?.kind === "existing" &&
			(args.branch.name === plan.defaultBranch || args.branch.name === "main" || args.branch.name === "master");
		const opened = this.#openedBy(caller.tabId, tabs);
		if (!this.#host.fullEnabled() && (!this.#host.manageEnabled() || ship === "release" || onDefaultBranch)) {
			const branch =
				args.branch?.kind === "existing"
					? onDefaultBranch
						? this.#host.text("autopilotBranchDefault", { name: args.branch.name })
						: args.branch.name
					: (args.branch?.name ?? this.#host.text("autopilotBranchNew", {}));
			const approved = await this.#host.confirm(
				caller.tabId,
				this.#host.text("autopilotTitle", {}),
				this.#host.text("autopilotMessage", {
					caller: caller.title || "—",
					folder: where,
					ship: this.#host.text(
						ship === "release"
							? "autopilotShipRelease"
							: ship === "push"
								? "autopilotShipPush"
								: "autopilotShipCommit",
						{},
					),
					branch,
				}),
			);
			if (!approved) return "The user declined Autopilot. Do not ask again unless they tell you to.";
		}
		const started = await source.start(caller.tabId, sourceTab.tabId, startOptions(args, ship));
		opened.add(started.tabId);
		return [
			`Started Autopilot in session ${started.tabId}${deviceName ? ` (it runs on ${deviceName}, in ${folder})` : ""}.`,
			describeRun({ tabId: started.tabId, title: "" }, started),
			`It works by itself: read it with ompdesk_autopilot {"action":"status","session":"${started.tabId}"}, end it with {"action":"stop","session":"${started.tabId}"}. Do not send it messages.`,
		].join("\n");
	}
}

interface OpenResult {
	tabId: string;
	notes?: string[];
	worktree?: string;
	started?: boolean;
	where?: string;
	error?: string;
}

/** A `get_transcript_page` payload with its messages, or null for anything else. */
function transcriptPage(data: unknown): MessagesPage | null {
	return data && typeof data === "object" && "messages" in data && Array.isArray(data.messages)
		? (data as MessagesPage)
		: null;
}

/** `get_subagents` rows from its `{ subagents }` payload. */
function subagentRows(data: unknown): SubagentSnapshot[] {
	return data && typeof data === "object" && "subagents" in data && Array.isArray(data.subagents)
		? (data.subagents as SubagentSnapshot[])
		: [];
}

function askTitle(request: ExtensionUIRequest): string {
	if (request.method === "ask") return request.questions[0]?.question ?? "";
	return "title" in request && typeof request.title === "string" ? request.title : "";
}

/** Stock's label for the custom-answer row of a choice card (`OTHER_OPTION` in the stock ask tool). */
const OTHER_OPTION = "Other (type your own)";

/** What a question card asks and which `ompdesk_session_answer` field answers it, for its opener's mail. */
function cardText(request: ExtensionUIRequest): string {
	switch (request.method) {
		case "select":
			return `${request.title}\noptions: ${request.options.map(option => `"${option}"`).join(" | ")}\nanswer with: choice (one option exactly as written)`;
		case "confirm":
			return `${request.title}${request.message ? `\n${request.message}` : ""}\nanswer with: approve (true or false)`;
		case "input":
		case "editor":
			return `${request.title}\nanswer with: text`;
		case "ask":
			return [
				...request.questions.map(
					question =>
						`[${question.id}] ${question.question}\noptions: ${question.options.map(option => `"${option.label}"`).join(" | ")}${question.multi ? " (several allowed)" : ""}`,
				),
				'answer with: answers ([{"id": <question id>, "selected": [<option>]}], or "text" for an answer of your own)',
			].join("\n");
		default:
			return askTitle(request);
	}
}

/** The option named `wanted` (case-insensitive, or a unique prefix), or a readable failure listing the options. */
function pickOption(options: readonly string[], wanted: string): string {
	const lowered = wanted.trim().toLowerCase();
	const exact = options.find(option => option.toLowerCase() === lowered);
	if (exact) return exact;
	const near = options.filter(option => option.toLowerCase().startsWith(lowered));
	if (near.length === 1 && near[0]) return near[0];
	return fail(`"${wanted}" is not one of: ${options.join(" | ")}.`);
}

/** The tail of a "no such session" failure naming the devices whose saved sessions could not be searched. */
function unreachedText(devices: readonly string[]): string {
	return devices.length
		? ` (${devices.join(", ")} could not be searched: not online; call again once it is, or name the device)`
		: "";
}
