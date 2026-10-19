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
 *           `agentControlManage` (default on) lifts the cards marked off above; `agentControlApprove` (default off)
 *           lets an agent approve another session's tool approval (without it the answer is "사용자 승인이 필요해요").
 *           A session the user hid from agents refuses all, whatever the switches.
 *   never   accounts, settings, permissions (those go through `ompdesk_app`).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
	AutopilotShipPreset,
	AutopilotStartOptions,
	AutopilotStatus,
} from "../../../resources/gui-bridge/modes/autopilot-contracts";
import {
	AGENT_CARD_PREFIX,
	AGENT_SCHEDULE_PREFIX,
	type AgentControlToolName,
	type AgentControlViewEvent,
	type AgentReviewItem,
	agentTaskTitle,
	type ClosedChild,
	parseAgentMessage,
	parseWorkerResult,
	AGENT_CONTROL_TOOLS as T,
	wrapAgentMessage,
} from "../../shared/agent-control";
import type { IpcTabRunOutcome, IpcTabWorktree, TabStatus } from "../../shared/ipc-types";
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
import { APPROVE_DENY, APPROVE_ONCE, isApprovalSelect } from "../../shared/tool-approval";
import { AppControl, type AppPorts, AppRefusal } from "./app-control";
import { type AutoCloseFacts, autoCloseDecision } from "./auto-close";
import {
	type BranchFacts,
	type LandingFacts,
	type MergeOutcome,
	mergeProblem,
	type WorktreeRef,
	type WorktreeRemoval,
} from "./branches";
import { deliveryFor, type Mail, Mailbox, type MailboxDeps, type MailDelivery, mailDetails, mailText } from "./mail";
import {
	type AnswerArgs,
	ARGS,
	type AutopilotArgs,
	type ListArgs,
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
	/** A turn runs (stock run state as the pool tracks it). */
	busy: boolean;
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
	/** When its current turn started (epoch ms). */
	busySince?: number;
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
	/** Who asked for the session (Autopilot passes "autopilot-child"); the host records the caller tab as parent. */
	tag?: string;
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
	/** The user's stored ship level (what a start without `ship` gets) and the default branch of the folder's repository. */
	plan(sourceTabId: string): Promise<{ defaultShip: ShipLevel; defaultBranch: string | null }>;
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
	/** Put one report into a session as a stock custom message (`ompdesk.mail`), delivered per `delivery`. */
	mail(tabId: string, content: string, details: Record<string, unknown>, delivery: MailDelivery): Promise<void>;
	/** A child's report changed what its opener's work board shows. */
	reviewChanged?(parentTabId: string): void;
	/** Every open tab of this app, the caller's window first (`here`); null when the calling tab is gone. */
	tabs(callerTabId: string): ControlTab[] | null;
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
	/** What an opened session works on (`agentTaskTitle` of its first message): its row shows it until it has a title. */
	setTask(tabId: string, task: string): void;
	view(callerTabId: string, event: AgentControlViewEvent): void;
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
	/** Merge the worktree's branch into its parent checkout on `device` (never pushed). */
	mergeBranch(worktree: WorktreeRef, label: string, device?: string): Promise<MergeOutcome>;
	/** What git on `device` says about a child's branch: its own commits, whether they landed, whether the worktree is clean. */
	landing(worktree: WorktreeRef, device?: string): Promise<LandingFacts>;
	/** Remove a clean worktree on `device` whose branch tip is in the parent's HEAD or upstream, and its branch (never forced). */
	removeSafeWorktree(worktree: WorktreeRef, device?: string): Promise<WorktreeRemoval>;
	/** Remember a session closed after its work landed, so its opener's family still lists it. */
	recordClosed(child: ClosedChild): void;
	/** The Schedules service of this computer (no `device`) or of the paired host `device`, or null where there is none. */
	schedules(device?: string): ScheduleSource | null;
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
/** A wait re-reads the session at least this often even when no tab event arrives. */
const POLL_MS = 3_000;
const STATE_TIMEOUT_MS = 5_000;
const SUMMARY_CHARS = 200;
const SESSION_PREFIX_MIN = 4;
const TOOL_RESULT_CHARS = 300;
const MESSAGE_CHARS = 1_500;
/** An automatic close waits this long for the window to drop the tab (it refuses a tab the person uses). */
const AUTO_CLOSE_WAIT_MS = 2_000;
const LIST_DEFAULT_ROWS = 30;
/** A sent message's receipt waits this long to see the target's turn start. */
const TURN_START_WAIT_MS = 1_500;

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

function responseData<T>(response: RpcResponse, what: string): T {
	if (!response.success) fail(`${what} failed: ${response.error ?? "unknown error"}`);
	return response.data as T;
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

/** The session waits on someone: an open ask or approval, or a plan proposal awaiting approval. */
function waits(tab: ControlTab): boolean {
	return tab.asks.length > 0 || tab.plan !== undefined;
}

/** A saved session's name: its title, else the task an agent opened it for, else its first message. */
function storedTitle(row: Pick<StoredSession, "title" | "firstMessage">): string {
	return row.title || agentTaskTitle(row.firstMessage) || row.firstMessage || "(untitled)";
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

/** `ompdesk_autopilot start` arguments as the start sheet's options; omitted fields keep the sheet's defaults. */
function startOptions(args: Extract<AutopilotArgs, { action: "start" }>, ship: ShipLevel): AutopilotStartOptions {
	const advanced = args.advanced ?? {};
	const shipPolicy: NonNullable<AutopilotStartOptions["ship"]> = {
		...(advanced.remote ? { remote: advanced.remote } : {}),
		...(advanced.cadence !== undefined
			? { autoRelease: { on: true, cadence: { kind: "every" as const, n: advanced.cadence } } }
			: {}),
	};
	return {
		...(args.ship ? { preset: SHIP_PRESET[ship] } : {}),
		...(Object.keys(shipPolicy).length > 0 ? { ship: shipPolicy } : {}),
		...(args.guide ? { guide: args.guide } : {}),
		...(args.branch ? { branch: args.branch } : {}),
		...(advanced.focus ? { focus: advanced.focus } : {}),
		...(advanced.parallel !== undefined ? { maxParallel: advanced.parallel } : {}),
		...(advanced.notify ? { notify: advanced.notify } : {}),
		...(advanced.backlog ? { backlog: advanced.backlog } : {}),
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
	if (status.state === "paused" || status.state === "waiting_quota")
		lines.push("It does not continue by itself: the user resumes it on the Autopilot screen.");
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

/** One compared session as the judge and the agent read it. */
interface Evidence {
	id: string;
	/** The block the agent reads. */
	text: string;
	/** State, checks and diff lines without the answer (the judge gets the answer whole, separately). */
	facts: string;
	answer: string | null;
}

/** Newest transcript messages a compare reads from an open session for the checks it ran. */
const EVIDENCE_MESSAGES = 200;
/** The judge request's evidence, all sessions together. */
const JUDGE_EVIDENCE_CHARS = 60_000;

const JUDGE_SYSTEM = `You judge the work of several coding sessions against acceptance criteria, for the agent that started them.
Use only the evidence given: each session's state, the checks it ran (command and outcome, read from its transcript), its git diff summary and its final answer.
A claim in a final answer that no check or diff supports counts as "unknown", not "yes". A failed check counts against the criterion it covers. A session that is still running cannot be the winner.
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

/** The checks a transcript ran, newest last: the command and whether it passed (exit 0 / no error). */
export function checksRun(messages: readonly AgentMessage[]): { command: string; passed: boolean }[] {
	const calls = new Map<string, string>();
	const checks: { command: string; passed: boolean }[] = [];
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
			checks.push({ command, passed: !message.isError && (exit ? exit[1] === "0" : true) });
		} else if (message.role === "bashExecution" && CHECK_COMMAND.test(message.command ?? "")) {
			checks.push({ command: message.command ?? "", passed: message.exitCode === 0 });
		}
	}
	return checks;
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
	/** Callers whose `autoClose` pass is in flight. */
	readonly #sweeping = new Set<string>();
	/** Saved sessions the last stored lists showed, by stock id: what read, reopen and compare resolve a stored id to. */
	readonly #stored = new Map<string, StoredSession>();
	/** Reports between sessions (`mail.ts`): dispatch ids, coalescing, the last report of each child. */
	readonly #mailbox: Mailbox;
	/** Receipts of `ompdesk_session_send` by `caller|target|request_id`: a repeat is never delivered twice. */
	readonly #receipts = new Map<string, string>();
	/** Sends with a request id still on their way: a same-id repeat joins one instead of sending twice. */
	readonly #inflight = new Map<string, Promise<string>>();

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
				const receiver = this.#host.tabs(mail.to)?.find(tab => tab.tabId === mail.to);
				await this.#host.mail(
					mail.to,
					mailText(mail),
					mailDetails(mail),
					deliveryFor(mail.kind, receiver?.busy === true),
				);
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
	}

	/** Programmatic open (Autopilot): the same path as the tool, with a tag the tool never sets. */
	async openSessions(callerTabId: string, sessions: readonly OpenOne[], tag?: string): Promise<string[]> {
		const tabs = this.#host.tabs(callerTabId);
		if (!tabs) fail("This session's tab is gone.");
		const caller = tabs.find(tab => tab.tabId === callerTabId);
		if (!caller) fail("This session's tab is gone.");
		return (await this.#openMany(caller, tabs, sessions, undefined, tag)).map(entry => entry.tabId);
	}

	async run(callerTabId: string, tool: AgentControlToolName, args: unknown): Promise<ToolOutcome> {
		try {
			if (!this.#host.enabled())
				fail("OMPdesk control tools are turned off (Settings › Tools & extensions). Ask the user to turn them on.");
			const tabs = this.#host.tabs(callerTabId);
			if (!tabs) fail("This session's tab is gone.");
			return { text: await this.#dispatch(callerTabId, tabs, tool, args), isError: false };
		} catch (error) {
			if (error instanceof ToolError) return { text: error.message, isError: true };
			return { text: `${tool} failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
		}
	}

	#stopping(callerTabId: string): boolean {
		return this.#closing.has(callerTabId) || this.#host.isStopping?.(callerTabId) === true;
	}

	async #dispatch(callerTabId: string, tabs: ControlTab[], tool: AgentControlToolName, raw: unknown): Promise<string> {
		const parsed = ARGS[tool].safeParse(raw ?? {});
		if (!parsed.success) fail(`Invalid arguments for ${tool}: ${parsed.error.issues.map(i => i.message).join("; ")}`);
		const caller = tabs.find(tab => tab.tabId === callerTabId);
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
				return this.#send(caller, this.#resolve(tabs, args.session, caller, "send to"), args);
			}
			case T.result: {
				const args = ARGS[T.result].parse(raw);
				const ids = args.sessions ?? (args.session ? [args.session] : []);
				const targets = ids.map(id => this.#resolve(tabs, id, caller, "read"));
				return this.#result(caller, targets, args, args.sessions !== undefined);
			}
			case T.read: {
				const args = ARGS[T.read].parse(raw);
				const target = await this.#resolveAny(tabs, args.session, caller, "read");
				return "tabId" in target && "busy" in target ? this.#read(target, args) : this.#readStored(target, args);
			}
			case T.answer: {
				const args = ARGS[T.answer].parse(raw);
				return this.#answer(caller, this.#resolve(tabs, args.session, caller, "answer"), args);
			}
			case T.focus: {
				const args = ARGS[T.focus].parse(raw);
				const target = this.#resolve(tabs, args.session, null, "show");
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
				return this.#merge(caller, this.#resolve(tabs, args.session, caller, "merge"));
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

	/** The app action's way into `ompdesk_autopilot`: same parse, same card. */
	async #appAutopilot(callerTabId: string, raw: unknown): Promise<string> {
		const tabs = this.#host.tabs(callerTabId);
		const caller = tabs?.find(tab => tab.tabId === callerTabId);
		if (!tabs || !caller) fail("This session's tab is gone.");
		const parsed = ARGS[T.autopilot].safeParse(raw);
		if (!parsed.success) fail(`Invalid arguments: ${parsed.error.issues.map(issue => issue.message).join("; ")}`);
		return this.#autopilot(caller, tabs, parsed.data);
	}

	#appControl(): AppControl {
		if (!this.#app) fail("App actions are not available here.");
		return this.#app;
	}

	/** An open session's id the list printed, or a unique prefix of one; never the caller itself where `self` is passed. */
	#resolve(tabs: ControlTab[], session: string, self: ControlTab | null, verb: string): ControlTab {
		const target = this.#lookup(tabs, session);
		if (!target)
			fail(
				`No session "${session}" open in this app. Call ompdesk_sessions (scope app for every window); a saved session must be opened again first (ompdesk_session_open reopen).`,
			);
		if (self && target.tabId === self.tabId) fail(`You cannot ${verb} your own session with this tool.`);
		return target;
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
			call({ type: "get_state" }, data => (data as RpcSessionState | undefined) ?? null),
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
			case "exited":
				return `stopped (${tab.status})`;
		}
		if (tab.busy || state?.isStreaming) return `running${step ? `, ${step}` : ""}`;
		if (state && state.isSettled === false) return "running (background work still going)";
		return "idle";
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

	#online(device: ControlDevice): void {
		if (device.state !== "online")
			fail(`${device.name} is ${device.state}: it has to be on and reachable first (Settings › Devices).`);
	}

	#devicesLine(): string {
		const devices = this.#host.devices();
		return devices.length
			? `Paired devices: ${devices.map(device => `${device.name} (id ${device.id}, ${device.state})`).join("; ")}; "local" is this computer.`
			: "No paired devices.";
	}

	async #list(caller: ControlTab, tabs: ControlTab[], args: ListArgs): Promise<string> {
		const device = args.device === undefined ? undefined : this.#device(args.device);
		const limit = args.limit ?? LIST_DEFAULT_ROWS;
		if (args.scope === "stored") return this.#listStored(caller, tabs, args, device, limit);
		const opened = this.#openedBy(caller.tabId, tabs);
		const query = args.query?.toLowerCase();
		const app = args.scope === "app" || device !== undefined;
		const candidates = tabs.filter(
			tab =>
				(app || tab.here) &&
				(device === undefined || (device === null ? !tab.device : tab.device === device.id)) &&
				(!args.folder || tab.cwd.includes(args.folder)) &&
				(!args.mine || opened.has(tab.tabId)) &&
				(!query || (!tab.hidden && tab.title.toLowerCase().includes(query))),
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
				const parts = [line, `folder ${tab.cwd}`];
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
		if (device) this.#online(device);
		if (args.status) fail("status filters open sessions; leave it out with scope stored.");
		const opened = this.#openedBy(caller.tabId, tabs);
		const mine = new Set(tabs.filter(tab => opened.has(tab.tabId)).flatMap(tab => tab.sessionPath ?? []));
		const rows = (await this.#host.stored(device?.id, args.query))
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
		if (args.device !== undefined) {
			const found = this.#device(args.device);
			if (found) this.#online(found);
			device = found ? found.id : null;
		}
		let sessionPath: string | undefined;
		if (args.reopen) {
			const row =
				(await this.#storedSession(args.reopen)) ??
				fail(
					`No saved session "${args.reopen}" here. List them with ompdesk_sessions {"scope":"stored"} (with device for a paired device's).`,
				);
			if (row.hidden) fail("The user hid that session from other agents.");
			const open = this.#liveTab(this.#host.tabs(caller.tabId) ?? [], row);
			if (open)
				fail(
					`That session is already open as ${open.tabId}: use it directly (ompdesk_session_send, ompdesk_session_read).`,
				);
			if (args.device !== undefined && (device ?? undefined) !== row.device)
				fail("A saved session opens on the device it is saved on; leave device out with reopen.");
			sessionPath = row.path;
			device = row.device ?? null;
		}
		let tabId: string;
		let worktree: IpcTabWorktree | undefined;
		let prepared: string | undefined;
		try {
			({ tabId, worktree, prepared } = await this.#host.spawn(caller.tabId, {
				folder: args.folder,
				worktree: worktreeArg,
				...(device !== undefined ? { device } : {}),
				...(sessionPath ? { sessionPath } : {}),
				...(tag ? { tag } : {}),
			}));
		} finally {
			opened.delete(reservation);
		}
		opened.add(tabId);
		// Its row reads as the work it was opened for at once, not "New session" until stock names it.
		const task = args.message && !sessionPath ? agentTaskTitle(wrapAgentMessage(args.message, caller.title)) : null;
		if (task) this.#host.setTask(tabId, task);
		try {
			await this.#whenReady(tabId, caller.tabId);
			const notes: string[] = [];
			// Journaled in the child, so its main agent gets the worker contract (gui-bridge agent-control.ts) from its
			// first turn on, across relaunches; a session the user opened (and reopened here) never carries it.
			if (sessionPath) notes.push("reopened");
			else
				responseData(
					await this.#host.command(tabId, {
						type: "agent_control_worker",
						from: caller.title || "another session",
					}),
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
			// A child that cannot be set up does not linger half-configured.
			opened.delete(tabId);
			this.#host.view(caller.tabId, { tabId, how: "close" });
			throw error;
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
		const running = target.busy || (await this.#state(target)).state?.isStreaming === true;
		const steer = args.delivery === "steer";
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
		const how = !running
			? "it was idle and starts on it"
			: steer
				? "delivered as steer (it reads it between steps)"
				: "queued as a follow-up (it runs when the current turn ends)";
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

	/** The work board's view of a child's mail: its last report, and whether its question waits. */
	#reportFields(tabId: string): Pick<AgentReviewItem, "report" | "waiting"> {
		const state = this.#mailbox.state(tabId);
		if (!state) return {};
		return {
			report: { kind: state.last.kind, text: oneLine(state.last.text, 240), at: state.last.at },
			...(state.waiting ? { waiting: true as const } : {}),
		};
	}

	/** `ompdesk_report`: an opened session tells its opener (or a sibling) about its work. */
	async #report(caller: ControlTab, tabs: ControlTab[], args: ReportArgs): Promise<string> {
		const parent = this.#host.parentOf(caller.tabId);
		if (!parent)
			fail(
				"ompdesk_report is for a session another session opened; nobody opened this one. Use ompdesk_session_send to write to a session.",
			);
		const to = args.to ? this.#resolve(tabs, args.to, caller, "report to").tabId : parent;
		if (to !== parent && this.#host.parentOf(to) !== parent)
			fail("You can report only to the session that opened you or to a sibling it opened.");
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
			kind: to === parent ? args.kind : "note",
			text: args.text,
			...(args.files ? { files: args.files } : {}),
			...(args.checks ? { checks: args.checks } : {}),
			...(args.dispatch ? { dispatch: args.dispatch } : {}),
			at: Date.now(),
		};
		if (!this.#mailbox.knows(caller.tabId))
			this.#mailbox.seed(caller.tabId, (await this.#journalMarks(caller.tabId)).dispatch);
		const outcome = await this.#mailbox.post(mail);
		this.#host.reviewChanged?.(parent);
		switch (outcome) {
			case "duplicate":
				return `Report ${mail.id} was already delivered; nothing sent again.`;
			case "stale":
				return `Ignored: dispatch ${args.dispatch} is no longer current (the session that opened you has since sent dispatch ${this.#mailbox.current(caller.tabId)}). Work on its latest message.`;
			case "queued":
				return "Progress noted; it reaches the session shortly (several progress reports arrive as the latest one).";
			default:
				return mail.kind === "question" || mail.kind === "blocked"
					? "Delivered. Wait for the answer: it comes as a message; do not guess the decision meanwhile."
					: "Delivered.";
		}
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
			text: `${label(tab)} [${tab.tabId}]: ${line}.${todos ? ` ${todos}.` : ""}${hint}\nLast answer:\n${body}`,
		};
	}

	async #result(
		caller: ControlTab,
		targets: ControlTab[],
		args: { wait?: boolean; until?: "all" | "any"; timeout_seconds?: number },
		table: boolean,
	): Promise<string> {
		const seconds = args.timeout_seconds ?? RESULT_WAIT_DEFAULT_SECONDS;
		const deadline = Date.now() + seconds * 1000;
		const ids = targets.map(tab => tab.tabId);
		for (;;) {
			const current = ids.map(id => this.#host.tabs(caller.tabId)?.find(tab => tab.tabId === id));
			const gone = current.findIndex(tab => !tab);
			if (gone >= 0) fail(`${label(targets[gone] as ControlTab)} was closed while you waited.`);
			const summaries = await Promise.all(
				(current as ControlTab[]).map(tab =>
					this.#sessionSummary(caller, tab, table ? RESULT_TABLE_ANSWER_CHARS : RESULT_MAX_CHARS),
				),
			);
			const done = summaries.filter(summary => summary.settled).length;
			const ready = args.until === "any" ? done > 0 : done === summaries.length;
			const timedOut = Date.now() >= deadline;
			if (!args.wait || ready || timedOut) {
				// The opener has the answer now: the session may close once its work landed.
				for (const [index, summary] of summaries.entries())
					if (summary.settled) this.#collected.add((current[index] as ControlTab).tabId);
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
		if (target.status !== "ready" && target.status !== "running")
			fail(`${label(target)} has not started; there is no transcript to read yet.`);
		const limit = args.limit ?? READ_DEFAULT_MESSAGES;
		const page =
			transcriptPage(
				responseData<unknown>(
					await this.#host.command(
						target.tabId,
						args.before
							? { type: "get_transcript_page", cursor: args.before, limit }
							: { type: "get_transcript_page", fromEnd: true, limit },
						30_000,
					),
					"Reading the transcript",
				),
			) ?? fail("The transcript page came back empty.");
		this.#collected.add(target.tabId);
		return renderPage(label(target), target.tabId, page.messages, page.totalMessages, page.prevCursor ?? null);
	}

	/** A saved session's transcript, paged from its end; the cursor is the index of the page's first message. */
	async #readStored(row: StoredSession, args: { limit?: number; before?: string }): Promise<string> {
		if (row.hidden) fail("The user hid this session from other agents.");
		const messages = await this.#host.storedMessages(row);
		const limit = args.limit ?? READ_DEFAULT_MESSAGES;
		const end = args.before === undefined ? messages.length : Number.parseInt(args.before, 10);
		if (!Number.isInteger(end) || end < 0 || end > messages.length)
			fail(`"${args.before}" is not a cursor of this session; use the one a previous page returned.`);
		const start = Math.max(0, end - limit);
		const title = `"${oneLine(storedTitle(row), 80)}" (saved${row.deviceName ? ` on ${row.deviceName}` : ""}${row.tabId ? `, open in tab ${row.tabId}` : ", not open"})`;
		return renderPage(title, row.id, messages.slice(start, end), messages.length, start > 0 ? String(start) : null);
	}

	/** An open tab by id or unique prefix, undefined when none (an ambiguous prefix fails). */
	#lookup(tabs: ControlTab[], session: string): ControlTab | undefined {
		const exact = tabs.find(tab => tab.tabId === session);
		if (exact) return exact;
		if (session.length < SESSION_PREFIX_MIN) return undefined;
		const matches = tabs.filter(tab => tab.tabId.startsWith(session));
		if (matches.length > 1) fail(`"${session}" matches several sessions; use the full id from ompdesk_sessions.`);
		return matches[0];
	}

	/**
	 * A saved session by stock id or unique prefix: the last stored lists first, then the index of `device` (this
	 * computer when undefined or null). A row read with `device` given is that device's only.
	 */
	async #storedSession(session: string, device?: ControlDevice | null): Promise<StoredSession | undefined> {
		const where = device === undefined ? undefined : (device?.id ?? undefined);
		const find = (): StoredSession | undefined => {
			const rows = [...this.#stored.values()].filter(row => device === undefined || row.device === where);
			const exact = rows.find(row => row.id === session);
			if (exact) return exact;
			if (session.length < SESSION_PREFIX_MIN) return undefined;
			const matches = rows.filter(row => row.id.startsWith(session));
			if (matches.length > 1) fail(`"${session}" matches several saved sessions; use the full id.`);
			return matches[0];
		};
		const known = find();
		if (known) return known;
		if (device) this.#online(device);
		for (const row of await this.#host.stored(where)) this.#stored.set(row.id, row);
		return find();
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
		const tab = this.#lookup(tabs, session);
		if (tab) {
			if (tab.tabId === self.tabId) fail(`You cannot ${verb} your own session with this tool.`);
			return tab;
		}
		const row = await this.#storedSession(session, device);
		if (!row)
			fail(
				`No session "${session}" open in this app or saved ${device ? `on ${device.name}` : "here"}. Call ompdesk_sessions (scope app, or scope stored with device for a paired device's).`,
			);
		const open = this.#liveTab(tabs, row);
		if (open?.tabId === self.tabId) fail(`You cannot ${verb} your own session with this tool.`);
		return open ?? row;
	}

	async #answer(caller: ControlTab, target: ControlTab, args: AnswerArgs): Promise<string> {
		this.#refuseHidden(target, caller);
		const asks = target.asks.filter(ask => !askTitle(ask.request).startsWith(AGENT_CARD_PREFIX));
		if (asks.length === 0 && target.plan) return this.#answerPlan(caller, target, target.plan, args);
		if (asks.length === 0)
			fail(
				target.asks.length > 0
					? "That is a confirmation card for the user (OMPdesk asks the person before an agent action); only the user answers it."
					: `${label(target)} is not waiting for an answer.`,
			);
		const ask = args.request ? asks.find(entry => entry.id === args.request) : asks[0];
		if (!ask) fail(`No pending request "${args.request}" there. Pending: ${asks.map(entry => entry.id).join(", ")}.`);
		const request = ask.request;
		let response: ExtensionUIResponse;
		let summary: string;
		if (request.method === "select") {
			const approval = isApprovalSelect(request);
			const choice = pickOption(
				request.options,
				args.choice ?? (args.approve === undefined ? undefined : args.approve ? APPROVE_ONCE : APPROVE_DENY),
			);
			// Approving for this session grants more than "Approve", so both need the user's leave; Deny never does.
			if (approval && choice !== APPROVE_DENY && !this.#host.approveEnabled())
				fail(
					"사용자 승인이 필요해요: this is a tool approval in another session and the user has not let agents approve for them (Settings › Tools & extensions). Tell the user, or show the session with ompdesk_tab_focus. Deny is allowed.",
				);
			response = { type: "extension_ui_response", id: ask.id, value: choice };
			summary = `"${choice}" to "${oneLine(request.title, 100)}"`;
		} else if (request.method === "confirm") {
			if (args.approve === undefined && args.choice === undefined)
				fail("Give approve: true or false for this confirmation.");
			const yes = args.approve ?? /^(y|yes|ok|true|confirm)/i.test(args.choice ?? "");
			response = { type: "extension_ui_response", id: ask.id, confirmed: yes };
			summary = `${yes ? "yes" : "no"} to "${oneLine(request.title, 100)}"`;
		} else if (request.method === "input" || request.method === "editor") {
			if (args.text === undefined) fail("Give text: the answer to type into this prompt.");
			response = { type: "extension_ui_response", id: ask.id, value: args.text };
			summary = `text to "${oneLine(request.title, 100)}"`;
		} else if (request.method === "ask") {
			const given = args.answers ?? [];
			const answers = request.questions.map(question => {
				const mine =
					given.find(entry => entry.id === question.id) ?? (request.questions.length === 1 ? given[0] : undefined);
				if (!mine) fail(`Answer question "${question.id}" (${oneLine(question.question, 80)}).`);
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
			return fail("That request is not a question an agent can answer.");
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
		try {
			if (target.busy && (target.status === "ready" || target.status === "running")) {
				responseData(await this.#host.command(target.tabId, { type: "abort" }), "Stopping the session");
			}
			if (args.close || args.delete) await this.#journalClose(caller, target, args.delete === true);
			if (args.delete) await this.#host.deleteSession(caller.tabId, target.tabId);
			else if (args.close) {
				// The card and the lines took time: the person may have opened it meanwhile.
				const now = this.#host.tabs(caller.tabId)?.find(tab => tab.tabId === target.tabId);
				if (now && (now.looked || now.userTouched))
					fail(`${label(target)} came into the user's view meanwhile; it stays open.`);
				this.#host.view(caller.tabId, { tabId: target.tabId, how: "close" });
			}
		} finally {
			this.#closing.delete(target.tabId);
		}
		if (args.delete) {
			const done = `Stopped, closed and deleted ${label(target)}.`;
			return own && target.worktree ? `${done} ${await this.#dropWorktree(target.worktree, target.device)}` : done;
		}
		if (args.close) return `Closed ${label(target)} (its session stays saved).`;
		return target.busy ? `Stopped ${label(target)}.` : `${label(target)} was not running; nothing to stop.`;
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
		const quiet: MailDelivery = { triggerTurn: false };
		const closed = `${deleted ? "Deleted" : "Closed"} ${label(target)}${deleted ? "" : " (its session stays saved)"}.`;
		await Promise.allSettled([
			this.#host.mail(
				caller.tabId,
				closed,
				line(caller, closed),
				caller.busy ? { triggerTurn: false, deliverAs: "nextTurn" } : quiet,
			),
			this.#host.mail(
				target.tabId,
				`${caller.title || "Another session"} closed this session's tab.`,
				line(caller, `closed this tab`),
				quiet,
			),
		]);
	}

	/** What a compare reads from one session: its final answer, the checks it ran and its worktree's diff. */
	async #evidence(caller: ControlTab, target: ControlTab | StoredSession): Promise<Evidence> {
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
		if (!worktree) lines.push("  no worktree: no branch to diff");
		else
			try {
				const facts = await this.#host.branchFacts(worktree, target.device);
				const added = facts.files.reduce((sum, file) => sum + file.added, 0);
				const removed = facts.files.reduce((sum, file) => sum + file.removed, 0);
				const shown = facts.files
					.slice(0, 12)
					.map(file => `${file.path} +${file.added} −${file.removed}`)
					.join(", ");
				const more = facts.files.length > 12 ? `, … ${facts.files.length - 12} more` : "";
				const problem = mergeProblem(worktree, facts);
				lines.push(
					`  branch ${facts.branch} → ${facts.baseBranch ?? "(detached)"}: ${facts.commitsAhead} commit(s) ahead, ${facts.files.length} file(s) changed (+${added} −${removed})${facts.merged ? ", already merged" : ""}`,
					`  uncommitted ${facts.uncommitted}, untracked ${facts.untracked}${shown ? `\n  files: ${shown}${more}` : ""}`,
					`  ${problem ? `cannot merge yet: ${problem}` : "ready to merge with ompdesk_merge"}`,
				);
			} catch (error) {
				lines.push(`  could not read its branch: ${error instanceof Error ? error.message : String(error)}`);
			}
		const facts = lines.slice(1).join("\n");
		lines.push(`  final answer: ${answer ? oneLine(answer, 700) : "(none yet)"}`);
		return { id, text: lines.join("\n"), facts, answer };
	}

	/**
	 * Each session's evidence (final answer, checks from its transcript, worktree diff); with criteria, one judge
	 * request on the caller's `slow` role grades them and names a winner. Runs no tests.
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
		const evidence = await Promise.all(targets.map(target => this.#evidence(caller, target)));
		for (const target of targets) if ("busy" in target) this.#collected.add(target.tabId);
		const blocks = evidence.map(entry => entry.text).join("\n");
		if (!criteria)
			return `${blocks}\nCompare runs no tests: ask each session to run them (ompdesk_session_send) and read its answer. Pass criteria to have them judged.`;
		const verdict = await this.#judge(caller, evidence, criteria);
		return `${verdict}\n\nEvidence:\n${blocks}`;
	}

	async #judge(caller: ControlTab, evidence: Evidence[], criteria: string[]): Promise<string> {
		const per = Math.floor(JUDGE_EVIDENCE_CHARS / evidence.length);
		const user = [
			"Acceptance criteria:",
			...criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
			"",
			...evidence.map(entry =>
				[
					`<session id="${entry.id}">`,
					entry.facts,
					"final answer:",
					cut(entry.answer ?? "(none)", Math.max(500, per - entry.facts.length)),
					"</session>",
				].join("\n"),
			),
		].join("\n");
		const reply = responseData<{ text?: string; model?: string; usd?: number }>(
			await this.#host.command(caller.tabId, { type: "agent_control_judge", system: JUDGE_SYSTEM, user }, 180_000),
			"Judging",
		);
		const parsed = parseVerdict(reply?.text ?? "");
		const cost = `${reply?.model ? ` by ${reply.model}` : ""}${typeof reply?.usd === "number" ? `, $${reply.usd.toFixed(4)}` : ""}`;
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
			fail(
				`Merge conflict in ${outcome.files.join(", ")}: the merge was aborted and ${worktree.baseCwd} is unchanged. Ask ${label(target)} to rebase or resolve against the parent's branch, then try again.`,
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
	async #reviewItem(tab: ControlTab): Promise<AgentReviewItem | null> {
		const session = await this.#state(tab);
		const running = tab.busy || waits(tab) || (tab.status !== "ready" && tab.status !== "running");
		const conflict = this.#conflicts.get(tab.tabId);
		const item: AgentReviewItem = {
			tabId: tab.tabId,
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
			...this.#reportFields(tab.tabId),
			// Its plan waits for approval: the opener (or the person) answers it, nothing is left to review.
			...(tab.plan ? { waiting: true as const } : {}),
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
		const tabs = this.#host.tabs(callerTabId);
		if (!tabs) return [];
		const own = this.#openedBy(callerTabId, tabs);
		const children = tabs.filter(tab => own.has(tab.tabId) && !this.#reviewed.has(tab.tabId) && !tab.hidden);
		const items = await Promise.all(children.map(tab => this.#reviewItem(tab)));
		return items.filter(item => item !== null);
	}

	/** Resolves once the tab is out of the caller's window, or after a few seconds. */
	async #whenGone(callerTabId: string, tabId: string, waitMs = 10_000): Promise<void> {
		const deadline = Date.now() + waitMs;
		while (this.#host.tabs(callerTabId)?.some(tab => tab.tabId === tabId) && Date.now() < deadline)
			await this.#nextChange(Math.min(500, deadline - Date.now()));
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
			const openerIdle = !caller.busy && !waits(caller);
			for (const tab of tabs) {
				if (!this.#openedBy(callerTabId, tabs).has(tab.tabId) || this.#closing.has(tab.tabId)) continue;
				if (tab.busy || waits(tab)) {
					this.#collected.delete(tab.tabId);
					continue;
				}
				if (!tab.autoClosable || tab.hidden || tab.status !== "ready" || !tab.lastRun) continue;
				const decision = autoCloseDecision(await this.#autoCloseFacts(tab, openerIdle));
				if (decision.action === "close") await this.#autoCloseTab(caller, tab, decision.removeWorktree);
			}
		} finally {
			this.#sweeping.delete(callerTabId);
		}
	}

	async #autoCloseFacts(tab: ControlTab, openerIdle: boolean): Promise<AutoCloseFacts> {
		const session = await this.#state(tab);
		const branch = tab.worktree
			? await this.#host
					.landing(tab.worktree, tab.device)
					.catch(() => ({ hasWork: false, landed: false, clean: false }))
			: null;
		return {
			openedByAgent: tab.autoClosable === true,
			stored: typeof tab.sessionPath === "string",
			idle: session.state !== null && session.state.isStreaming !== true,
			settled: session.state?.isSettled !== false,
			answered: (session.last ?? "").trim() !== "",
			ended: tab.lastRun?.stopReason === "error" || tab.lastRun?.stopReason === "aborted" ? "failed" : "ok",
			result: parseWorkerResult(session.last)?.kind ?? "missing",
			branch,
			looked: tab.looked === true,
			userTouched: tab.userTouched === true,
			collected: openerIdle || this.#collected.has(tab.tabId),
		};
	}

	async #autoCloseTab(caller: ControlTab, tab: ControlTab, removeWorktree: boolean): Promise<void> {
		this.#closing.add(tab.tabId);
		try {
			this.#host.view(caller.tabId, { tabId: tab.tabId, how: "close", auto: true });
			await this.#whenGone(caller.tabId, tab.tabId, AUTO_CLOSE_WAIT_MS);
			// The window kept it (the person came to it meanwhile): nothing else changes.
			if (this.#host.tabs(caller.tabId)?.some(entry => entry.tabId === tab.tabId)) return;
			const removed =
				removeWorktree && tab.worktree
					? (await this.#host.removeSafeWorktree(tab.worktree, tab.device).catch(() => null)) !== null
					: false;
			this.#host.recordClosed({
				path: tab.sessionPath as string,
				openedBySession: caller.sessionPath as string,
				title: tab.title || tab.task || "",
				cwd: removed && tab.worktree ? tab.worktree.baseCwd : tab.cwd,
				closedAt: Date.now(),
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
		if (device) this.#online(device);
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
		if (caller.deviceName) fail("Autopilot runs on this computer; a session on a paired host cannot start one.");
		if (args.action === "start") return this.#autopilotStart(caller, tabs, source, args);
		const target = this.#resolve(tabs, args.session, caller, args.action === "stop" ? "stop" : "read");
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
		const sourceTab = [caller, ...tabs]
			.filter(tab => !tab.deviceName && !tab.hidden && trimSeparators(tab.cwd) === folder)
			.sort((a, b) => Number(b.status === "ready") - Number(a.status === "ready"))[0];
		if (!sourceTab)
			fail(
				`${folder} is not open in a session of this window on this computer. Autopilot starts from a folder one of those sessions has open: open one there first (ompdesk_session_open with folder), or use your own folder.`,
			);
		const plan = await source.plan(sourceTab.tabId);
		const ship = args.ship ?? plan.defaultShip;
		const advanced = args.advanced ?? {};
		if (advanced.cadence !== undefined && ship !== "release")
			fail("advanced.cadence goes with ship release (it is the release rhythm).");
		const onDefaultBranch =
			args.branch?.kind === "existing" &&
			(args.branch.name === plan.defaultBranch || args.branch.name === "main" || args.branch.name === "master");
		const opened = this.#openedBy(caller.tabId, tabs);
		let started: AutopilotStatus & { tabId: string };
		try {
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
						folder,
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
			started = await source.start(caller.tabId, sourceTab.tabId, startOptions(args, ship));
		} catch (error) {
			if (error instanceof ToolError) throw error;
			fail(`Autopilot did not start: ${error instanceof Error ? error.message : String(error)}`);
		}
		opened.add(started.tabId);
		return [
			`Started Autopilot in session ${started.tabId}.`,
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

/** The option named `wanted` (case-insensitive, or a unique prefix), or a readable failure listing the options. */
function pickOption(options: readonly string[], wanted: string | undefined): string {
	if (wanted === undefined) fail(`Choose one of: ${options.join(" | ")}.`);
	const lowered = wanted.trim().toLowerCase();
	const exact = options.find(option => option.toLowerCase() === lowered);
	if (exact) return exact;
	const near = options.filter(option => option.toLowerCase().startsWith(lowered));
	if (near.length === 1 && near[0]) return near[0];
	return fail(`"${wanted}" is not one of: ${options.join(" | ")}.`);
}
