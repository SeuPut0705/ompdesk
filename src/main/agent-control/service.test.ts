import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AutopilotStartOptions, AutopilotStatus } from "../../../resources/gui-bridge/modes/autopilot-contracts";
import {
	AGENT_CONTROL_VIEW,
	type ClosedChild,
	AGENT_CONTROL_TOOLS as T,
	wrapAgentMessage,
} from "../../shared/agent-control";
import type {
	AgentMessage,
	ExtensionUIRequest,
	ExtensionUIResponse,
	RpcCommand,
	RpcGitUnlanded,
	RpcResponse,
} from "../../shared/rpc-types";
import type {
	Schedule,
	ScheduleDraft,
	ScheduleFrequency,
	ScheduleRun,
	SchedulesRequest,
	SchedulesState,
} from "../../shared/schedules";
import type { SessionSummary } from "../../shared/session-summary";
import type { SessionViewHandle } from "../../shared/session-view";
import type { RpcTurnEdits } from "../../shared/turn-edits";
import type { HostConnection } from "../remote/host-server";
import { type ViewChannel, ViewControl } from "../remote/view-control";
import { RpcTimeoutError } from "../rpc-client";
import type { Pace } from "../session-pace";
import type { ClientWindow } from "../web/client-window";
import type { FileEdits } from "../web/file-edit-reports";
import type { BranchEvidence, BranchFacts, LandingFacts, MergeOutcome, WorktreeRef, WorktreeRemoval } from "./branches";
import type { MailDelivery } from "./mail";
import {
	AgentControl,
	type AgentControlFiles,
	type AgentControlHost,
	type AutopilotSource,
	type ControlAsk,
	type ControlDevice,
	type ControlTab,
	type HostTab,
	type OpenedChild,
	parseViewCloseFacts,
	type SchedulesHost,
	type SentAnswer,
	SessionFolderMissing,
	type SpawnRequest,
	type StoredSession,
	type Tombstones,
	type Tuning,
	type ViewCloseFacts,
} from "./service";
import { LocalViewHost, type LocalViewSurface } from "./view-host";

const ok = (data: unknown = {}): RpcResponse => ({ type: "response", success: true, data }) as RpcResponse;
const bad = (error: string): RpcResponse => ({ type: "response", success: false, error }) as RpcResponse;

/** A schedule as the control tools list it (`ompdesk_schedule`). */
interface ScheduleRow {
	id: string;
	name: string;
	frequency: ScheduleFrequency;
	cwd: string;
	enabled: boolean;
	nextRun: string | null;
	lastStatus: string | null;
	wakes?: boolean;
}

interface FakeTab extends ControlTab {
	/** In the calling session's window (the default list); a tab with this false sits in another window. */
	here: boolean;
	last?: string;
	messages?: AgentMessage[];
	/** What `get_turn_edits` answers (its newest turn's edit calls); absent = an older host refusing it. */
	turn?: RpcTurnEdits;
	/** What `get_git_unlanded` answers. */
	unlanded?: RpcGitUnlanded | null;
	todos?: { name: string; tasks: { content: string; status: string }[] }[];
	/** What the fake omp answers `get_state.model` and `get_session_stats.history.cost` with. */
	model?: { provider: string; id: string };
	cost?: number;
	/** What the fake omp answers `get_session_spend.providers` with (its own host's billing); absent = an older omp. */
	spend?: Record<string, { billing: string; name?: string; cost: number; today: number }>;
	/** What its omp's bridge answers `agent_control_turn` with: its current run was started by the person's own message. */
	personTurn?: boolean;
}

class FakeHost implements AgentControlHost {
	tabsById = new Map<string, FakeTab>();
	sent: { tabId: string; command: RpcCommand }[] = [];
	views: { tabId: string; how: string }[] = [];
	cards: { title: string; message: string }[] = [];
	cardAnswer = true;
	approve = false;
	manage = false;
	full = false;
	stopping = new Set<string>();
	spawned: SpawnRequest[] = [];
	first: OpenedChild[] = [];
	answers: { tabId: string; id: string; response: ExtensionUIResponse }[] = [];
	marked: string[] = [];
	deleted: string[] = [];
	listeners = new Set<() => void>();
	beforeFirstPromptError: Error | null = null;
	seq = 0;
	/** The journal files the service keeps (calls, fates, cleanups, the send outbox): absent = none, as a bare host. */
	files: AgentControlFiles = {};
	/** The waits the service shortens, in ms: what the TypeScript tests moved fake timers for. */
	tuning: Tuning = {};
	sentMarks?: (tabId: string, marks: string[]) => Promise<SentAnswer | null>;
	/** The app's side of `ompdesk_app`; absent unless a test gives it. */
	appPorts?: AgentControlHost["appPorts"];

	constructor(...tabs: Partial<FakeTab>[]) {
		for (const tab of tabs) this.add(tab);
	}

	add(tab: Partial<FakeTab>): FakeTab {
		const full: FakeTab = {
			tabId: tab.tabId ?? `tab${++this.seq}00`,
			title: "",
			cwd: "/repo",
			status: "ready",
			busy: false,
			asks: [],
			hidden: false,
			here: true,
			...tab,
		};
		this.tabsById.set(full.tabId, full);
		return full;
	}

	emit(): void {
		for (const listener of [...this.listeners]) listener();
	}

	enabled = () => true;
	approveEnabled = () => this.approve;
	manageEnabled = () => this.manage || this.full;
	fullEnabled = () => this.full;
	/** What every row shows of the sessions this computer runs (`SessionSummaries`), by session file. */
	localRows: SessionSummary[] = [];
	summaries = (device?: string) => (device ? [] : this.localRows);
	/** Every open tab once, with its window: the service's own fields, none of what the fake omp answers with. */
	tabs = (): HostTab[] =>
		[...this.tabsById.values()].map(tab => {
			const {
				here,
				last: _last,
				messages: _messages,
				turn: _turn,
				unlanded: _unlanded,
				todos: _todos,
				model: _model,
				cost: _cost,
				spend: _spend,
				personTurn: _personTurn,
				...own
			} = tab;
			return { ...own, window: here ? "main" : "other" };
		});
	isStopping = (callerTabId: string) => this.stopping.has(callerTabId);
	beforeFirstPrompt = async (child: OpenedChild) => {
		this.first.push(child);
		if (this.beforeFirstPromptError) throw this.beforeFirstPromptError;
	};
	start = (tabId: string) => {
		const tab = this.tabsById.get(tabId);
		if (tab) tab.status = "ready";
	};
	/** What each tab was spawned for (`SpawnRequest.task`) or named afterwards (`setTask`). */
	tasks = new Map<string, string>();
	setTask = (tabId: string, task: string) => {
		this.tasks.set(tabId, task);
		// The pool names the tab: its next snapshot reads the task as the title of a session stock has not named.
		const tab = this.tabsById.get(tabId);
		if (tab && !tab.title) {
			tab.task = task;
			tab.title = task;
		}
	};
	view = (_caller: string, event: { tabId: string; how: string }) => {
		this.views.push(event);
		this.order.push(`view:${event.how}:${event.tabId}`);
		if (event.how === "close" && !this.refuseClose.has(event.tabId)) this.tabsById.delete(event.tabId);
	};
	/** Tabs whose window keeps them when asked to close (a draft, the window's last tab, unsaved edits). */
	refuseClose = new Set<string>();
	/** Everything that happened to a closing tab, in order (a view event, a release, a mail). */
	order: string[] = [];
	/** Tabs main released itself (`release`): a paired web page's, never asked of its window. */
	releases: string[] = [];
	release = async (_caller: string, tabId: string): Promise<boolean> => {
		this.order.push(`release:${tabId}`);
		this.releases.push(tabId);
		return this.tabsById.delete(tabId);
	};
	/** Settles once the omp of a closed tab has exited; a test holds it to see what waits for it. */
	exited = async (_tabId: string): Promise<void> => {};
	notify = vi.fn();
	confirm = async (_caller: string, title: string, message: string) => {
		this.cards.push({ title, message });
		return this.cardAnswer;
	};
	answer = async (tabId: string, id: string, response: ExtensionUIResponse) => {
		this.answers.push({ tabId, id, response });
		const tab = this.tabsById.get(tabId);
		if (tab) tab.asks = tab.asks.filter(ask => ask.id !== id);
	};
	markAnswered = async (_tabId: string, by: string) => {
		this.marked.push(by);
	};
	deleteSession = async (_caller: string, tabId: string) => {
		this.deleted.push(tabId);
		this.tabsById.delete(tabId);
	};
	deletedStored: { path: string; device: string | undefined }[] = [];
	deleteStored = async (row: StoredSession) => {
		this.deletedStored.push({ path: row.path, device: row.device });
	};
	facts = new Map<string, BranchFacts>();
	mergeResult: MergeOutcome = { merged: true, sha: "abc1234", summary: "2 files changed" };
	merges: string[] = [];
	/** Every git seam call with the device it was sent to (undefined = this computer). */
	gitCalls: {
		op: "facts" | "evidence" | "merge" | "landing" | "remove";
		branch: string;
		device: string | undefined;
	}[] = [];
	branchFacts = async (worktree: WorktreeRef, device?: string): Promise<BranchFacts> => {
		this.gitCalls.push({ op: "facts", branch: worktree.branch, device });
		const facts = this.facts.get(worktree.branch);
		if (!facts) throw new Error("no such branch");
		return facts;
	};
	evidence = new Map<string, BranchEvidence>();
	/** The diff budget each `branchEvidence` call asked for. */
	diffChars: number[] = [];
	branchEvidence = async (worktree: WorktreeRef, diffChars: number, device?: string): Promise<BranchEvidence> => {
		this.gitCalls.push({ op: "evidence", branch: worktree.branch, device });
		this.diffChars.push(diffChars);
		return this.evidence.get(worktree.branch) ?? { diff: "", diffOmitted: 0, merge: { kind: "clean" } };
	};
	mergeBranch = async (worktree: WorktreeRef, _label: string, device?: string) => {
		this.gitCalls.push({ op: "merge", branch: worktree.branch, device });
		this.merges.push(worktree.branch);
		return this.mergeResult;
	};
	landings = new Map<string, LandingFacts>();
	removed: string[] = [];
	/** What `removeSafeWorktree` does: by default the work landed and the tree is clean. */
	removal: WorktreeRemoval = "removed";
	closedRecords: ClosedChild[] = [];
	landing = async (worktree: WorktreeRef, device?: string): Promise<LandingFacts> => {
		this.gitCalls.push({ op: "landing", branch: worktree.branch, device });
		return this.landings.get(worktree.branch) ?? { hasWork: false, landed: false, clean: true };
	};
	removeSafeWorktree = async (worktree: WorktreeRef, device?: string): Promise<WorktreeRemoval> => {
		this.gitCalls.push({ op: "remove", branch: worktree.branch, device });
		if (this.removal) this.removed.push(worktree.branch);
		return this.removal;
	};
	/** Worktrees a failed open took back (`discardWorktree`), and what that returns. */
	discarded: { branch: string; device: string | undefined }[] = [];
	discardResult: WorktreeRemoval = "removed";
	discardWorktree = async (worktree: WorktreeRef, device?: string): Promise<WorktreeRemoval> => {
		this.discarded.push({ branch: worktree.branch, device });
		return this.discardResult;
	};
	recordClosed = (child: ClosedChild) => {
		this.closedRecords.push(child);
	};
	closed: ClosedChild[] = [];
	closedChildren = () => this.closed;
	/** Tombstones (`deleted-sessions.ts`): when a session file (a path), or a saved id, was deleted outside the control tools. */
	tombstoneAt = new Map<string, number>();
	tombstones = (): Tombstones => {
		const tombstones: Tombstones = { byPath: [], byId: {} };
		// The store keeps this computer's file as node's `path.resolve` spells it (`deleted-sessions.ts`).
		for (const [key, at] of this.tombstoneAt)
			if (key.startsWith("/")) tombstones.byPath.push({ path: resolve(key), at });
			else tombstones.byId[key] = at;
		return tombstones;
	};
	/** What opening a saved session fails with (the folder it worked in is gone). */
	reopenError: Error | null = null;
	/** Transcript cursors the session has outgrown (it wrote more since that page). */
	staleCursors = new Set<string>();
	/** The schedules this computer holds, as the service's `ompdesk_schedule` lists them. */
	scheduleRows: ScheduleRow[] = [];
	/** The Schedules service (`command`, `create`) over `scheduleRows`; null = none on this computer. */
	scheduleService: SchedulesHost | null = {
		command: async request => this.#schedulesCommand(request),
		create: async draft => {
			const row: ScheduleRow = {
				id: `sched${this.scheduleRows.length + 1}000`,
				name: draft.name,
				frequency: draft.frequency,
				cwd: draft.cwd,
				enabled: draft.enabled,
				nextRun: "2026-10-18T09:00:00.000Z",
				lastStatus: null,
				...(draft.wakeSession === undefined ? {} : { wakes: true as const }),
			};
			this.scheduleRows.push(row);
			this.savedDrafts.push(draft);
			return { id: row.id, state: this.#schedulesState() };
		},
	};
	#schedulesState(): SchedulesState {
		const schedule = (row: ScheduleRow): Schedule => ({
			id: row.id,
			createdAt: "2026-10-01T00:00:00.000Z",
			name: row.name,
			prompt: "before",
			cwd: row.cwd,
			frequency: row.frequency,
			model: null,
			autoApprove: false,
			enabled: row.enabled,
			...(row.wakes ? { wakeSession: "/s/woken.jsonl" } : {}),
		});
		const finished: ScheduleRun[] = this.scheduleRows.flatMap(row =>
			row.lastStatus
				? [
						{
							id: `run-${row.id}`,
							scheduleId: row.id,
							trigger: "schedule" as const,
							startedAt: "2026-10-17T09:00:00.000Z",
							endedAt: "2026-10-17T09:01:00.000Z",
							status: row.lastStatus as ScheduleRun["status"],
							exitCode: 0,
							error: null,
						},
					]
				: [],
		);
		return {
			paused: false,
			schedules: this.scheduleRows.map(schedule),
			runs: [...this.scheduleRuns, ...finished],
			nextRuns: Object.fromEntries(this.scheduleRows.map(row => [row.id, row.nextRun])),
		};
	}
	#schedulesCommand(request: SchedulesRequest): SchedulesState {
		switch (request.action) {
			case "delete":
				this.scheduleRows = this.scheduleRows.filter(row => row.id !== request.id);
				break;
			case "save": {
				const index = this.scheduleRows.findIndex(row => row.id === request.id);
				const before = this.scheduleRows[index] as ScheduleRow;
				this.updatedDrafts.push(request.draft);
				this.scheduleRows[index] = {
					...before,
					name: request.draft.name,
					frequency: request.draft.frequency,
					enabled: request.draft.enabled,
				};
				break;
			}
			case "setEnabled": {
				const index = this.scheduleRows.findIndex(row => row.id === request.id);
				this.scheduleRows[index] = {
					...(this.scheduleRows[index] as ScheduleRow),
					enabled: request.enabled,
					nextRun: request.enabled ? "2026-10-18T09:00:00.000Z" : null,
				};
				break;
			}
			case "runNow":
				this.ranNow.push(request.id);
				break;
			default:
		}
		return this.#schedulesState();
	}
	updatedDrafts: ScheduleDraft[] = [];
	ranNow: string[] = [];
	scheduleRuns: ScheduleRun[] = [];
	savedDrafts: ScheduleDraft[] = [];
	/** The device each Schedules request was sent to (undefined = this computer). */
	scheduleDevices: (string | undefined)[] = [];
	hasSchedules = () => this.scheduleService !== null;
	schedules = (device?: string) => {
		this.scheduleDevices.push(device);
		return this.scheduleService;
	};
	autopilot: AutopilotSource | undefined;
	observe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	/** The template of each text (`{caller}` and `{target}` are filled by the service): the core reads the language's template. */
	text = (key: string, params: Record<string, string>) =>
		`${key}:${params.caller ?? "{caller}"}:${params.target ?? "{target}"}`;
	deviceList: ControlDevice[] = [];
	devices = () => this.deviceList;
	storedRows: StoredSession[] = [];
	storedQueries: { device: string | undefined; query: string | undefined }[] = [];
	stored = async (device: string | undefined, query?: string) => {
		this.storedQueries.push({ device, query });
		return this.storedRows.filter(
			row => row.device === device && (!query || `${row.title} ${row.snippet ?? ""}`.includes(query)),
		);
	};
	storedTranscripts = new Map<string, AgentMessage[]>();
	storedMessages = async (row: StoredSession) => this.storedTranscripts.get(row.path) ?? [];
	paces = new Map<string, Pace>();
	sessionPace = async (row: { path: string; device?: string }): Promise<Pace | undefined> => this.paces.get(row.path);
	judged: string[] = [];
	judgeReply = "";
	/** What the bridge answers besides the text: the judge model, its role and families. */
	judgeMeta: Record<string, unknown> = { model: "anthropic/claude-slow", usd: 0.0123 };
	/** An error the judge request fails with instead of answering. */
	judgeError: string | null = null;

	parents = new Map<string, string>();
	parentOf = (tabId: string) => this.parents.get(tabId);
	/** Sessions sharing each tab's checkout (main's checkout-peers coordinator). */
	peers = new Map<string, string[]>();
	checkoutPeers = (tabId: string) => this.peers.get(tabId) ?? [];
	mails: { to: string; content: string; details: Record<string, unknown>; delivery: MailDelivery }[] = [];
	mail = async (to: string, content: string, details: Record<string, unknown>, delivery: MailDelivery) => {
		this.order.push(`mail:${to}`);
		this.mails.push({ to, content, details, delivery });
	};
	reviewChanged = vi.fn();

	/** Extra fields of every tab `spawn` opens (a paired web page's tab carries `webEdits`). */
	spawnPatch: Partial<FakeTab> = {};
	spawn = async (caller: string, request: SpawnRequest) => {
		if (request.sessionPath && this.reopenError) throw this.reopenError;
		this.spawned.push(request);
		const tab = this.add({
			...this.spawnPatch,
			title: "",
			cwd: request.folder ?? "/repo",
			...(typeof request.device === "string" ? { device: request.device, deviceName: "DESKTOP-PC" } : {}),
			...(request.task ? { task: request.task } : {}),
			// A reopened session's tab holds its file from the start.
			...(request.sessionPath ? { sessionPath: request.sessionPath } : {}),
			status: "ready",
			...(request.worktree
				? { worktree: { name: "w", branch: "omp/agent/w", baseCwd: "/repo", path: "/wt/w" } }
				: {}),
		});
		this.parents.set(tab.tabId, caller);
		if (request.task) this.tasks.set(tab.tabId, request.task);
		return { tabId: tab.tabId, ...(tab.worktree ? { worktree: tab.worktree } : {}) };
	};
	/** An omp that answers `agent_control_worker` only this long after it was asked (a just-started omp under load). */
	workerAnswersAfterMs = 0;
	/** Command types the omp never answers (it hangs, or died with the command in its queue). */
	unanswered = new Set<string>();

	command = async (tabId: string, command: RpcCommand, timeoutMs?: number): Promise<RpcResponse> => {
		this.sent.push({ tabId, command });
		const tab = this.tabsById.get(tabId);
		if (!tab) return bad("gone");
		if (this.unanswered.has(command.type)) return new Promise<RpcResponse>(() => {});
		// rpc-client.ts: a command not answered within its budget (8 s unless the caller names one) rejects.
		if (command.type === "agent_control_worker" && this.workerAnswersAfterMs > (timeoutMs ?? 8_000))
			throw new Error(`RPC timeout (${timeoutMs ?? 8_000}ms): agent_control_worker`);
		switch (command.type) {
			case "get_state":
				return ok({
					isStreaming: tab.busy,
					todoPhases: tab.todos ?? [],
					planModeEnabled: false,
					...(tab.model ? { model: tab.model } : {}),
				});
			case "get_session_stats":
				return ok({ cost: 0.001, history: { cost: tab.cost ?? 0 } });
			case "get_session_spend":
				return tab.spend ? ok({ providers: tab.spend, billing: {} }) : bad("unsupported_omp");
			case "get_last_assistant_text":
				return ok({ text: tab.last ?? null });
			case "get_transcript_page":
				if (command.cursor && this.staleCursors.has(command.cursor))
					return { ...bad("RPC message cursor is stale"), code: "stale_cursor" } as RpcResponse;
				return ok({
					messages: tab.messages ?? [],
					totalMessages: (tab.messages ?? []).length,
					prevCursor: command.cursor ? undefined : "cur1",
				});
			case "get_available_models":
				return ok({
					models: [
						{ provider: "anthropic", id: "claude-x" },
						{ provider: "fake", id: "m1" },
						{ provider: "fake", id: "m2" },
					],
				});
			case "get_model_roles":
				return ok({
					roles: [
						{ id: "task", model: "fake/m1", effective: { model: "fake/m1", source: "configured" } },
						{ id: "smol", effective: { model: "fake/m2", source: "fallback", via: "default" } },
						{ id: "plan" },
					],
				});
			case "get_turn_edits":
				return tab.turn ? ok(tab.turn) : bad("unknown command: get_turn_edits");
			case "get_git_unlanded":
				return ok(tab.unlanded ?? null);
			case "agent_control_turn":
				return ok({ person: tab.personTurn === true });
			case "prompt":
				tab.busy = true;
				return ok();
			case "agent_control_judge":
				this.judged.push(command.user);
				return this.judgeError ? bad(this.judgeError) : ok({ text: this.judgeReply, ...this.judgeMeta });
			default:
				return ok();
		}
	};
}

/** Every service a test opened: closed after it, so the core holds none. */
const opened: AgentControl[] = [];
afterEach(() => {
	for (const service of opened.splice(0)) service.close();
});

/**
 * The waits the service makes, shortened: the TypeScript tests moved fake timers over them (link waits of 15 s, a
 * close's 5 s, an open's 30 s), and the service now runs in the core on its own clock. A test that checks what a wait
 * means sets its own in `host.tuning`.
 */
const SHORT_WAITS: Tuning = {
	openReadyRetryMs: 600,
	openReadyPauseMs: 10,
	linkWaitMs: 300,
	linkPollMs: 10,
	reattachWaitMs: 300,
	closeWaitMs: 1_000,
	ompExitWaitMs: 1_500,
	autoCloseWaitMs: 1_000,
	draftWaitMs: 400,
	whenGoneMs: 1_000,
	stopWaitMs: 800,
	abortBeforeCloseMs: 100,
	turnStartWaitMs: 100,
	personTurnWaitMs: 300,
	readyPollMs: 20,
};

function control(host: FakeHost, tuning: Tuning = {}) {
	const service = new AgentControl(host, { files: host.files, tuning: { ...SHORT_WAITS, ...host.tuning, ...tuning } });
	opened.push(service);
	return service;
}

const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

/** `call` with the waits shortened (see `SHORT_WAITS`): a bounded wait for a device's link passes in no real time to speak of. */
async function shortWaits<T>(call: () => Promise<T>): Promise<T> {
	return call();
}

/**
 * Runs `call` while the omp of the tab it closes has not exited (`host.exited` waits on it): `pendingWhileRunning` says
 * whether `call` was still going a moment later, and `result` is what it returned once the omp exited.
 */
async function whileOmpRuns<T>(
	host: FakeHost,
	call: () => Promise<T>,
): Promise<{ pendingWhileRunning: boolean; result: T }> {
	const exit = Promise.withResolvers<void>();
	host.exited = () => exit.promise;
	let settled = false;
	const pending = call().finally(() => {
		settled = true;
	});
	await sleep(250);
	const pendingWhileRunning = !settled;
	exit.resolve();
	return { pendingWhileRunning, result: await pending };
}

const select = (title: string, options: string[]): ControlAsk => ({
	id: "req1",
	request: { type: "extension_ui_request", id: "req1", method: "select", title, options } as ExtensionUIRequest,
});

function prompts(host: FakeHost, tabId: string): string[] {
	return host.sent
		.filter(entry => entry.tabId === tabId && entry.command.type === "prompt")
		.map(entry => (entry.command as { message: string }).message);
}

const agent = (id: string, status: string): SessionSummary["agents"][number] => ({
	id,
	index: 0,
	agent: "task",
	status,
	startedAt: 1,
});

const summary = (over: Partial<SessionSummary> & { sessionPath: string }): SessionSummary => ({
	tabId: "tab",
	cwd: "/repo",
	kind: "agent",
	status: "ready",
	agents: [],
	...over,
});

describe("ompdesk_sessions", () => {
	it("lists every open session with its step, subagents, todo progress, ask and last answer; hidden ones stay private", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "Orchestrator" },
			{
				tabId: "work0002",
				title: "Worker",
				busy: true,
				busySince: Date.now() - 12 * 60_000 - 5_000,
				last: "I fixed the parser and ran the tests.",
				sessionPath: "/s/work.jsonl",
				todos: [
					{
						name: "p",
						tasks: [
							{ content: "write", status: "completed" },
							{ content: "test it", status: "in_progress" },
						],
					},
				],
				messages: [
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {}, intent: "run vitest" }],
					},
				],
			},
			{ tabId: "ask00003", title: "Asker", asks: [select("Allow tool: bash", ["Approve", "Deny"])] },
			{ tabId: "priv0004", title: "Secret plans", hidden: true, last: "classified" },
		);
		host.localRows = [
			summary({
				sessionPath: "/s/work.jsonl",
				status: "running",
				agents: [agent("s1", "running"), agent("s2", "failed")],
			}),
		];
		const result = await control(host).run("main0001", T.list, {});
		expect(result.isError).toBe(false);
		expect(result.text).toContain("4 sessions");
		expect(result.text).toMatch(/work0002 "Worker".*\n\s+running, running bash \(run vitest\), for 12 min;/);
		expect(result.text).toContain("1 subagent(s) running");
		expect(result.text).toContain("todos 1/2 done (now: test it)");
		expect(result.text).toContain("last answer: I fixed the parser");
		expect(result.text).toContain(`waiting for the user's answer: "Allow tool: bash"`);
		expect(result.text).toContain("priv0004 (hidden from agents by the user)");
		expect(result.text).not.toContain("Secret plans");
		expect(result.text).not.toContain("classified");
		expect(result.text).toContain("this session");
		// A listing reads each session's state brief: a paired device's tab answers over the link, and the whole state
		// carries the system prompt and every tool schema (~750 KB in a large session) the listing never reads.
		const reads = host.sent.filter(entry => entry.command.type === "get_state");
		expect(reads.length).toBeGreaterThan(0);
		expect(reads.every(entry => (entry.command as { brief?: boolean }).brief === true)).toBe(true);
	});

	it("reads a session's subagent count from its summary: only the running ones, and none without one", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "Boss", sessionPath: "/s/boss.jsonl" },
			{ tabId: "work0002", title: "Worker", busy: true, sessionPath: "/s/work.jsonl" },
			{ tabId: "bare0003", title: "Bare", busy: true, sessionPath: "/s/bare.jsonl" },
		);
		host.localRows = [
			summary({
				sessionPath: "/s/work.jsonl",
				status: "running",
				agents: [agent("a", "running"), agent("b", "pending"), agent("c", "waiting"), agent("d", "failed")],
			}),
		];
		const text = (await control(host).run("main0001", T.list, {})).text;
		expect(text).toMatch(/work0002 "Worker"[^\n]*\n[^\n]*2 subagent\(s\) running/);
		expect(text).not.toMatch(/bare0003 "Bare"[^\n]*\n[^\n]*subagent/);
		// A listing no longer asks the omp for them.
		expect(host.sent.some(entry => entry.command.type === "get_subagents")).toBe(false);
	});

	it("lists with scope app a session this computer runs for a paired device, with its subagent count", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss", sessionPath: "/s/boss.jsonl" });
		host.localRows = [
			summary({ sessionPath: "/s/boss.jsonl", tabId: "main0001" }),
			summary({
				sessionPath: "/s/2026-01-01T00-00-00-000Z_abc123.jsonl",
				tabId: "phone001",
				status: "running",
				title: "Phone work",
				sessionId: "abc123",
				cwd: "/work",
				openFor: "SeuPut",
				agents: [agent("a", "running"), agent("b", "running")],
			}),
		];
		const app = (await control(host).run("main0001", T.list, { scope: "app" })).text;
		expect(app).toContain('- "Phone work" (saved id abc123) [open in a tab this computer runs for SeuPut]');
		expect(app).toContain("running; folder /work; 2 subagent(s) running");
		// The default list is this window's tabs: a device's tab here is not one of them.
		const here = (await control(host).run("main0001", T.list, {})).text;
		expect(here).not.toContain("Phone work");
		expect(here).toContain("1 more open in tabs this app does not hold");
	});

	it("says a session waiting for another omp to let go of it is waiting, not stopped", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "Boss" },
			{ tabId: "held0002", title: "Held", status: "error", sessionHeld: true },
			{ tabId: "dead0003", title: "Dead", status: "error" },
		);
		const result = await control(host).run("main0001", T.list, {});
		expect(result.text).toMatch(/held0002 "Held".*\n\s+waiting for another omp process to let go of this session/);
		expect(result.text).toMatch(/dead0003 "Dead".*\n\s+stopped \(error\)/);
	});

	it("refuses when the switch is off or the caller's tab is gone", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		host.enabled = () => false;
		expect((await control(host).run("main0001", T.list, {})).text).toMatch(/turned off/);
		const other = new FakeHost({ tabId: "main0001" });
		expect((await control(other).run("zzzz9999", T.list, {})).isError).toBe(true);
	});
});

/**
 * `host` refuses its `type` command as a tab that cannot take it yet: the tab reads `status` meanwhile. With `recoverMs`
 * only the first is refused and the tab reads `ready` again that long after (an omp busy at its start whose health
 * check timed out until its probe was answered); without it every one is refused and the tab stays.
 */
function refuseCommand(
	host: FakeHost,
	type: string,
	refusal: { code: string; error: string; status: FakeTab["status"]; recoverMs?: number },
): void {
	const original = host.command;
	let refused = false;
	host.command = async (tabId, command, timeoutMs) => {
		const tab = host.tabsById.get(tabId);
		if (!tab || command.type !== type || (refused && refusal.recoverMs !== undefined))
			return original(tabId, command, timeoutMs);
		refused = true;
		host.sent.push({ tabId, command });
		tab.status = refusal.status;
		host.emit();
		if (refusal.recoverMs !== undefined)
			setTimeout(() => {
				tab.status = "ready";
				host.emit();
			}, refusal.recoverMs);
		return {
			type: "response",
			command: type,
			success: false,
			error: refusal.error,
			code: refusal.code,
		} as RpcResponse;
	};
}

describe("ompdesk_session_open", () => {
	it("fans out several sessions in one call and returns the ids", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" });
		const result = await control(host).run("main0001", T.open, {
			sessions: [
				{ message: "part one", worktree: true },
				{ message: "part two", folder: "/other", model: "claude-x", mode: "plan" },
			],
		});
		expect(result.isError).toBe(false);
		expect(host.spawned).toHaveLength(2);
		expect(host.spawned[0]?.worktree).toEqual({});
		const [one, two] = [...host.tabsById.keys()].filter(id => id !== "main0001");
		expect(result.text).toContain(`Opened session ${one}`);
		expect(result.text).toContain(`"sessions":["${one}","${two}"]`);
		expect(prompts(host, one as string)[0]).toBe(
			wrapAgentMessage('part one\n\n[ompdesk dispatch d1: report with ompdesk_report, dispatch "d1"]', "Boss"),
		);
		expect(host.sent.some(entry => entry.tabId === two && entry.command.type === "set_plan_mode")).toBe(true);
		expect(host.sent.some(entry => entry.tabId === two && entry.command.type === "set_model")).toBe(true);
		// Each child, never the caller, is marked a worker before its first prompt (its bridge adds the contract).
		const workers = host.sent.filter(entry => entry.command.type === "agent_control_worker");
		expect(workers.map(entry => entry.tabId).sort()).toEqual([one, two].sort());
		expect(workers.every(({ command }) => command.type === "agent_control_worker" && command.from === "Boss")).toBe(
			true,
		);
		const firstPrompt = host.sent.findIndex(entry => entry.tabId === one && entry.command.type === "prompt");
		const mark = host.sent.findIndex(entry => entry.tabId === one && entry.command.type === "agent_control_worker");
		expect(mark).toBeLessThan(firstPrompt);
	});

	it("opens on the model a role runs on now (task, smol, …) and refuses an empty role by name", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" });
		const service = control(host);
		const setModel = (tabId: string) =>
			host.sent.find(entry => entry.tabId === tabId && entry.command.type === "set_model")?.command as
				| { provider?: string; modelId?: string }
				| undefined;
		const task = await service.run("main0001", T.open, { message: "mechanical edit", model: "task" });
		expect(task.isError, task.text).toBe(false);
		const [child] = [...host.tabsById.keys()].filter(id => id !== "main0001");
		expect(setModel(child as string)).toMatchObject({ provider: "fake", modelId: "m1" });
		// A role resolved through stock's fallback chain still names a model.
		const smol = await service.run("main0001", T.open, { message: "lookup", model: "Smol" });
		expect(smol.isError, smol.text).toBe(false);
		const [, second] = [...host.tabsById.keys()].filter(id => id !== "main0001");
		expect(setModel(second as string)).toMatchObject({ provider: "fake", modelId: "m2" });
		const plan = await service.run("main0001", T.open, { message: "plan it", model: "plan" });
		expect(plan.isError).toBe(true);
		expect(plan.text).toContain("The plan role names no model");
		expect(host.tabsById.size).toBe(3);
	});

	it("runs beforeFirstPrompt before the first prompt and closes the child when it throws", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		const order: string[] = [];
		host.beforeFirstPrompt = async child => {
			order.push(`hook:${child.callerTabId}:${child.tag}`);
		};
		const originalCommand = host.command;
		host.command = async (tabId, command) => {
			if (command.type === "prompt") order.push("prompt");
			return originalCommand(tabId, command);
		};
		const ids = await control(host).openSessions("main0001", [{ message: "go" }], "autopilot-child");
		expect(ids).toHaveLength(1);
		expect(order).toEqual(["hook:main0001:autopilot-child", "prompt"]);
		expect(host.spawned[0]?.tag).toBe("autopilot-child");

		const failing = new FakeHost({ tabId: "main0001" });
		failing.beforeFirstPromptError = new Error("guard failed");
		const result = await control(failing).run("main0001", T.open, { message: "go" });
		expect(result.text).toContain("guard failed");
		expect(failing.views.some(view => view.how === "close")).toBe(true);
		expect(prompts(failing, [...failing.tabsById.keys()].find(id => id !== "main0001") ?? "")).toEqual([]);
	});

	it("marks a just-started session a worker however long its omp takes to answer: no time limit fails a live start", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" });
		// Past every bound this command once had (8 s, then 60 s): three opens failed on the last one.
		host.workerAnswersAfterMs = 10 * 60_000;
		const result = await control(host).run("main0001", T.open, { message: "go", worktree: { base: "default" } });
		expect(result.isError, result.text).toBe(false);
		expect(result.text).toContain("Opened session");
		const child = [...host.tabsById.keys()].find(id => id !== "main0001") ?? "";
		expect(prompts(host, child)).toHaveLength(1);
		expect(host.discarded).toEqual([]);
	});

	it("fails an open whose omp dies with a command unanswered, and says why its omp ended", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" });
		host.unanswered.add("agent_control_worker");
		let settled = false;
		const opening = control(host)
			.run("main0001", T.open, { message: "go" })
			.finally(() => {
				settled = true;
			});
		// Past every wait of the open (`SHORT_WAITS`): a command with no deadline is waited for while the child lives.
		await sleep(1_500);
		expect(settled).toBe(false);
		const child = [...host.tabsById.values()].find(tab => tab.tabId !== "main0001") as FakeTab;
		Object.assign(child, { status: "exited", failure: "omp exited with code 1: Cannot find module 'left-pad'" });
		host.emit();
		const result = await opening;
		expect(result.isError).toBe(true);
		expect(result.text).toContain("Marking the session as a worker failed");
		expect(result.text).toContain("its omp process exited (omp exited with code 1: Cannot find module 'left-pad')");
	});

	it("says why a session that could not start failed, as its omp said it", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" });
		const spawn = host.spawn;
		host.spawn = async (caller, request) => {
			const opened = await spawn(caller, request);
			Object.assign(host.tabsById.get(opened.tabId) as FakeTab, {
				status: "error",
				failure: "omp was not found: install it or set its path",
			});
			return opened;
		};
		const result = await control(host).run("main0001", T.open, { message: "go" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain(
			"The session could not start: its omp failed to start (omp was not found: install it or set its path)",
		);
	});

	it("takes a boolean or an object argument written as JSON text", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" });
		const service = control(host);
		const flagged = await service.run("main0001", T.open, { message: "go", worktree: "true", throwaway: "true" });
		expect(flagged.isError, flagged.text).toBe(false);
		expect(flagged.text).toContain("throwaway");
		const based = await service.run("main0001", T.open, { message: "go", worktree: '{"base":"main"}' });
		expect(based.isError, based.text).toBe(false);
		expect(host.spawned.map(request => request.worktree)).toEqual([{}, { base: "main" }]);
	});

	it.each([
		["agent_control_worker", "sidecar_not_connected", "Sidecar not connected", { message: "go" }],
		["set_model", "sidecar_not_ready", "Sidecar not ready (error)", { message: "go", model: "claude-x" }],
		["set_plan_mode", "sidecar_not_ready", "Sidecar not ready (error)", { message: "go", mode: "plan" }],
		["prompt", "sidecar_not_ready", "Sidecar not ready (error)", { message: "go" }],
		["set_goal", "sidecar_not_ready", "Sidecar not ready (error)", { message: "go", mode: "goal" }],
	] as const)(
		"waits for a child that refuses %s as not ready and sends it again once it is ready",
		async (type, code, error, args) => {
			const host = new FakeHost({ tabId: "main0001", title: "Boss" });
			refuseCommand(host, type, { code, error, status: "error", recoverMs: 20 });
			const result = await shortWaits(() => control(host).run("main0001", T.open, { ...args, worktree: true }));
			expect(result.isError, result.text).toBe(false);
			expect(result.text).toContain("Opened session");
			const child = [...host.tabsById.keys()].find(id => id !== "main0001") ?? "";
			expect(host.sent.filter(entry => entry.tabId === child && entry.command.type === type)).toHaveLength(2);
			expect(host.tabsById.get(child)?.status).toBe("ready");
			expect(host.discarded).toEqual([]);
			expect(host.views.some(view => view.how === "close")).toBe(false);
		},
	);

	it("sends the first message once more after a refusal", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" });
		refuseCommand(host, "prompt", {
			code: "sidecar_not_ready",
			error: "Sidecar not ready (error)",
			status: "error",
			recoverMs: 20,
		});
		const result = await shortWaits(() => control(host).run("main0001", T.open, { message: "go" }));
		expect(result.isError).toBe(false);
		expect(result.text).toContain("It is working on your message.");
	});

	it("fails an open whose child stays not ready past the bound, naming the refusal, and takes back its worktree", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		refuseCommand(host, "prompt", { code: "sidecar_not_ready", error: "Sidecar not ready (error)", status: "error" });
		const { result, waitedMs } = await shortWaits(async () => {
			const started = Date.now();
			const result = await control(host).run("main0001", T.open, { message: "go", worktree: true });
			return { result, waitedMs: Date.now() - started };
		});
		expect(result.isError).toBe(true);
		expect(result.text).toContain("Sending the first message failed: Sidecar not ready (error)");
		expect(waitedMs).toBeGreaterThanOrEqual(600);
		expect(host.sent.filter(entry => entry.command.type === "prompt")).toHaveLength(1);
		expect(host.views.some(view => view.how === "close")).toBe(true);
		expect(host.discarded).toEqual([{ branch: "omp/agent/w", device: undefined }]);
	});

	it("does not wait for a child that exited, or send again after any other refusal", async () => {
		const exited = new FakeHost({ tabId: "main0001" });
		refuseCommand(exited, "prompt", {
			code: "sidecar_not_ready",
			error: "Sidecar not ready (exited)",
			status: "exited",
		});
		const gone = await control(exited).run("main0001", T.open, { message: "go", worktree: true });
		expect(gone.text).toContain("Sending the first message failed: Sidecar not ready (exited)");
		expect(exited.sent.filter(entry => entry.command.type === "prompt")).toHaveLength(1);
		expect(exited.discarded).toEqual([{ branch: "omp/agent/w", device: undefined }]);

		const busy = new FakeHost({ tabId: "main0001" });
		refuseCommand(busy, "prompt", { code: "busy", error: "Session is busy", status: "ready" });
		const refused = await control(busy).run("main0001", T.open, { message: "go" });
		expect(refused.text).toContain("Sending the first message failed: Session is busy");
		expect(busy.sent.filter(entry => entry.command.type === "prompt")).toHaveLength(1);
	});

	it("takes back the worktree and branch a failed open made, and says when git kept them", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		host.beforeFirstPromptError = new Error("guard failed");
		const result = await control(host).run("main0001", T.open, { message: "go", worktree: true });
		expect(result.text).toContain("guard failed");
		expect(host.views.some(view => view.how === "close")).toBe(true);
		expect(host.discarded).toEqual([{ branch: "omp/agent/w", device: undefined }]);

		const kept = new FakeHost({ tabId: "main0001" });
		kept.beforeFirstPromptError = new Error("guard failed");
		kept.discardResult = null;
		const told = await control(kept).run("main0001", T.open, { message: "go", worktree: true });
		expect(told.text).toContain("/wt/w");
		expect(told.text).toContain("omp/agent/w");

		// An open without a worktree has nothing to take back.
		const plain = new FakeHost({ tabId: "main0001" });
		plain.beforeFirstPromptError = new Error("guard failed");
		await control(plain).run("main0001", T.open, { message: "go" });
		expect(plain.discarded).toEqual([]);
	});

	it("keeps a failed open's worktree while its tab is still open, and names it", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		host.beforeFirstPromptError = new Error("guard failed");
		// The window keeps the tab (a draft, unsaved files): the close never lands.
		host.view = (_caller, event) => {
			host.views.push(event);
		};
		const result = await shortWaits(() => control(host).run("main0001", T.open, { message: "go", worktree: true }));
		expect(result.text).toContain("its tab is still open, so its worktree /wt/w and branch omp/agent/w were kept");
		expect(host.discarded).toEqual([]);
	});

	it("takes back a failed open's worktree only once the omp that started in it has exited", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		host.beforeFirstPromptError = new Error("guard failed");
		const { pendingWhileRunning, result } = await whileOmpRuns(host, () =>
			control(host).run("main0001", T.open, { message: "go", worktree: true }),
		);
		expect(pendingWhileRunning).toBe(true);
		expect(result.text).toContain("guard failed");
		expect(host.discarded).toEqual([{ branch: "omp/agent/w", device: undefined }]);
	});

	it("names each opened session's task (its Title: line, else its first line) for the sidebar until it has a title", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		await control(host).run("main0001", T.open, {
			sessions: [
				{ message: "Title: Fix the flaky upload test\nupload.test.ts times out." },
				{ message: "Docs pass\nmore" },
			],
		});
		const [one, two] = [...host.tabsById.keys()].filter(id => id !== "main0001");
		expect(host.tasks).toEqual(
			new Map([
				[one, "Fix the flaky upload test"],
				[two, "Docs pass"],
			]),
		);
		// An idle open (no message) has no task.
		const idle = new FakeHost({ tabId: "main0001" });
		await control(idle).run("main0001", T.open, {});
		expect(idle.tasks.size).toBe(0);
	});

	it("starts a goal session with set_goal alone", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		await control(host).run("main0001", T.open, { message: "ship it", mode: "goal" });
		const child = [...host.tabsById.keys()].find(id => id !== "main0001") as string;
		expect(host.sent.filter(entry => entry.tabId === child).map(entry => entry.command.type)).toContain("set_goal");
		expect(prompts(host, child)).toEqual([]);
	});

	it("opens as many sessions as asked, in one call and across calls", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		const service = control(host);
		// One call of ten is past the old 4-a-turn and 6-at-once caps; three more calls are past the old 12-an-hour.
		const many = Array.from({ length: 10 }, (_, index) => ({ message: `part ${index}` }));
		expect((await service.run("main0001", T.open, { sessions: many })).isError).toBe(false);
		for (const index of [10, 11, 12])
			expect((await service.run("main0001", T.open, { message: `part ${index}` })).isError).toBe(false);
		expect(host.tabsById.size - 1).toBe(13);
	});

	it("refuses to open or send while the caller is stopping", async () => {
		const host = new FakeHost({ tabId: "main0001" }, { tabId: "work0002" });
		host.stopping.add("main0001");
		const service = control(host);
		expect((await service.run("main0001", T.open, { message: "x" })).text).toMatch(/Autopilot is ending/);
		expect((await service.run("main0001", T.send, { session: "work0002", message: "x" })).text).toMatch(
			/Autopilot is ending/,
		);
		expect(host.spawned).toHaveLength(0);
	});

	it("rejects invalid arguments and mixing single fields with sessions", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		const service = control(host);
		expect((await service.run("main0001", T.open, { mode: "goal" })).text).toMatch(/needs a message/);
		expect((await service.run("main0001", T.open, { message: "a", sessions: [{ message: "b" }] })).text).toMatch(
			/not both/,
		);
		expect((await service.run("main0001", T.open, { delete: true })).text).toMatch(/Invalid arguments/);
	});
});

describe("ompdesk_session_send", () => {
	it("marks the message as sent by an agent with the sender's title and starts an idle session", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" }, { tabId: "work0002", title: "Worker" });
		const result = await control(host).run("main0001", T.send, { session: "work0002", message: "please review" });
		expect(result.text).toContain("it was idle and starts on it");
		expect(prompts(host, "work0002")).toEqual([wrapAgentMessage("please review", "Boss")]);
	});

	it("says nothing was delivered when the target's omp refuses the message", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" }, { tabId: "work0002", title: "Worker" });
		const command = host.command;
		host.command = async (tabId, request, timeoutMs) => {
			if (tabId === "work0002" && request.type === "prompt") {
				host.sent.push({ tabId, command: request });
				return {
					...bad("Sidecar not ready"),
					code: "sidecar_not_ready",
				} as RpcResponse;
			}
			return command.call(host, tabId, request, timeoutMs);
		};
		const result = await control(host).run("main0001", T.send, { session: "work0002", message: "please review" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("Not delivered");
		expect(result.text).toContain("Sidecar not ready");
		expect(result.text).not.toContain("accepted");
		expect((host.tabsById.get("work0002") as FakeTab).busy).toBeFalsy();
	});

	it("never promises a turn it did not see start", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" }, { tabId: "work0002", title: "Worker" });
		const command = host.command;
		// The omp takes the prompt but no turn follows (its busy flag never rises).
		host.command = async (tabId, request, timeoutMs) => {
			if (tabId === "work0002" && request.type === "prompt") {
				host.sent.push({ tabId, command: request });
				return ok();
			}
			return command.call(host, tabId, request, timeoutMs);
		};
		const result = await control(host).run("main0001", T.send, { session: "work0002", message: "please review" });
		expect(result.text).not.toContain("starts on it");
		expect(result.text).toContain("no turn started");
	});

	it("waits while the person types into the target, then sends; gives up after a minute with nothing sent", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" }, { tabId: "work0002", drafting: true });
		const service = control(host);
		const sending = service.run("main0001", T.send, { session: "work0002", message: "please review" });
		await sleep(150);
		expect(prompts(host, "work0002")).toEqual([]);
		(host.tabsById.get("work0002") as FakeTab).drafting = false;
		for (const listener of host.listeners) listener();
		expect((await sending).text).toContain("it was idle and starts on it");
		expect(prompts(host, "work0002")).toHaveLength(1);

		// The minute (`draftWaitMs`, 400 ms here) passes with the draft still there.
		(host.tabsById.get("work0002") as FakeTab).drafting = true;
		const result = await service.run("main0001", T.send, { session: "work0002", message: "and this" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("The person is typing in");
		expect(prompts(host, "work0002")).toHaveLength(1);
	});

	it("sees a draft the person starts while the send reads the target's journal", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" }, { tabId: "work0002" });
		let release = (): void => {};
		const held = new Promise<void>(resolve => {
			release = resolve;
		});
		const command = host.command;
		host.command = async (tabId, request, timeoutMs) => {
			if (request.type === "get_transcript_page") await held;
			return command(tabId, request, timeoutMs);
		};
		const service = control(host);
		const sending = service.run("main0001", T.send, { session: "work0002", message: "please review" });
		await sleep(50);
		(host.tabsById.get("work0002") as FakeTab).drafting = true;
		release();
		await sleep(150);
		expect(prompts(host, "work0002")).toEqual([]);
		(host.tabsById.get("work0002") as FakeTab).drafting = false;
		for (const listener of host.listeners) listener();
		expect((await sending).isError).toBeFalsy();
		expect(prompts(host, "work0002")).toHaveLength(1);
	});

	it("answers a repeat of a delivered request at once, never waiting on the person's draft", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" }, { tabId: "work0002" });
		const service = control(host);
		const args = { session: "work0002", message: "please review", request_id: "r1" };
		expect((await service.run("main0001", T.send, args)).isError).toBeFalsy();
		(host.tabsById.get("work0002") as FakeTab).drafting = true;
		let answered: { text: string; isError?: boolean } | undefined;
		void service.run("main0001", T.send, args).then(result => {
			answered = result;
		});
		// Well inside the draft wait (`draftWaitMs`, 400 ms here).
		await sleep(250);
		expect(answered?.isError).toBeFalsy();
		expect(answered?.text).toMatch(/already delivered; nothing sent again/);
		expect(prompts(host, "work0002")).toHaveLength(1);
	});

	it("refuses a self-send, a hidden session, an unknown id and an ambiguous prefix", async () => {
		const host = new FakeHost(
			{ tabId: "main0001" },
			{ tabId: "work0002", hidden: true },
			{ tabId: "work0003" },
			{ tabId: "work0004" },
		);
		const service = control(host);
		expect((await service.run("main0001", T.send, { session: "main0001", message: "me" })).text).toMatch(
			/own session/,
		);
		expect((await service.run("main0001", T.send, { session: "work0002", message: "x" })).text).toMatch(
			/hid this session/,
		);
		expect((await service.run("main0001", T.send, { session: "nope0000", message: "x" })).text).toMatch(/No session/);
		expect((await service.run("main0001", T.send, { session: "work", message: "x" })).text).toMatch(
			/matches several/,
		);
		expect(prompts(host, "work0002")).toEqual([]);
	});

	it("passes messages along a chain of sessions with no cap", async () => {
		const host = new FakeHost(
			{ tabId: "aaaa0001" },
			{ tabId: "bbbb0002" },
			{ tabId: "cccc0003" },
			{ tabId: "dddd0004" },
			{ tabId: "eeee0005" },
		);
		const service = control(host);
		expect((await service.run("aaaa0001", T.send, { session: "bbbb0002", message: "1" })).isError).toBe(false);
		expect((await service.run("bbbb0002", T.send, { session: "cccc0003", message: "2" })).isError).toBe(false);
		expect((await service.run("cccc0003", T.send, { session: "dddd0004", message: "3" })).isError).toBe(false);
		expect((await service.run("dddd0004", T.send, { session: "eeee0005", message: "4" })).isError).toBe(false);
		expect(prompts(host, "eeee0005")).toHaveLength(1);
	});
});

describe("ompdesk_session_result", () => {
	it("returns the last answer of one session, cut to the limit", async () => {
		const host = new FakeHost({ tabId: "main0001" }, { tabId: "work0002", title: "W", last: "x".repeat(30_000) });
		const result = await control(host).run("main0001", T.result, { session: "work0002" });
		expect(result.text).toContain("idle");
		expect(result.text).toContain("cut at 20000 characters");
	});

	it("waits for all sessions to finish, then returns a table", async () => {
		const host = new FakeHost(
			{ tabId: "main0001" },
			{ tabId: "work0002", title: "A", busy: true, last: "A done" },
			{ tabId: "work0003", title: "B", busy: true, last: "B done" },
		);
		const pending = control(host).run("main0001", T.result, {
			sessions: ["work0002", "work0003"],
			wait: true,
			timeout_seconds: 30,
		});
		await vi.waitFor(() => expect(host.listeners.size).toBeGreaterThan(0), { timeout: 5_000 });
		const a = host.tabsById.get("work0002") as FakeTab;
		a.busy = false;
		const polls = () => host.sent.filter(entry => entry.command.type === "get_last_assistant_text").length;
		const before = polls();
		host.emit();
		await vi.waitFor(() => expect(polls()).toBeGreaterThan(before), { timeout: 5_000 });
		const b = host.tabsById.get("work0003") as FakeTab;
		b.busy = false;
		host.emit();
		const result = await pending;
		expect(result.text).toContain("A done");
		expect(result.text).toContain("B done");
		expect(result.text).not.toMatch(/Still running/);
	});

	it("returns as soon as any session finishes with until: any, and reports a timeout", async () => {
		const host = new FakeHost(
			{ tabId: "main0001" },
			{ tabId: "work0002", busy: true },
			{ tabId: "work0003", busy: false, last: "quick" },
		);
		const any = await control(host).run("main0001", T.result, {
			sessions: ["work0002", "work0003"],
			wait: true,
			until: "any",
			timeout_seconds: 30,
		});
		expect(any.text).toContain("quick");
		const slow = new FakeHost({ tabId: "main0001" }, { tabId: "work0002", busy: true });
		const waiting = control(slow).run("main0001", T.result, {
			session: "work0002",
			wait: true,
			timeout_seconds: 1,
		});
		expect((await waiting).text).toMatch(/Still running after waiting 1 s/);
	});

	it("returns at once for a session that waits for the user's answer", async () => {
		const host = new FakeHost(
			{ tabId: "main0001" },
			{ tabId: "work0002", busy: true, asks: [select("Pick one", ["a", "b"])] },
		);
		const result = await control(host).run("main0001", T.result, {
			session: "work0002",
			wait: true,
			timeout_seconds: 30,
		});
		expect(result.text).toContain("It needs an answer");
	});

	it("needs exactly one of session and sessions, and refuses a hidden session", async () => {
		const host = new FakeHost({ tabId: "main0001" }, { tabId: "work0002", hidden: true });
		const service = control(host);
		expect((await service.run("main0001", T.result, {})).text).toMatch(/session or sessions/);
		expect((await service.run("main0001", T.result, { session: "work0002" })).text).toMatch(/hid this session/);
	});
});

describe("ompdesk_session_read", () => {
	const messages: AgentMessage[] = [
		{ role: "user", content: [{ type: "text", text: wrapAgentMessage("do it", "Boss") }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "On it." },
				{ type: "toolCall", id: "c1", name: "read", arguments: {}, intent: "look at a.ts" },
			],
		},
		{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "line1\nline2" }] },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "secret thoughts" },
				{ type: "text", text: "Done." },
			],
		},
	];

	it("renders the recent transcript for an agent and offers an earlier page", async () => {
		const host = new FakeHost({ tabId: "main0001" }, { tabId: "work0002", title: "W", messages });
		const result = await control(host).run("main0001", T.read, { session: "work0002", limit: 4 });
		expect(result.text).toContain("[user, sent by an agent (Boss)] do it");
		expect(result.text).toContain("[assistant] On it.");
		expect(result.text).toContain("[tool call] read: look at a.ts");
		expect(result.text).toContain("[tool result] read line1 line2");
		expect(result.text).toContain("[assistant] Done.");
		expect(result.text).not.toContain("secret thoughts");
		expect(result.text).toContain(`"before":"cur1"`);
		const paged = host.sent.find(entry => entry.command.type === "get_transcript_page");
		expect(paged?.command).toMatchObject({ fromEnd: true, limit: 4 });
		await control(host).run("main0001", T.read, { session: "work0002", before: "cur1" });
		expect(host.sent.at(-1)?.command).toMatchObject({ type: "get_transcript_page", cursor: "cur1" });
	});

	it("refuses a hidden session and a not-started one with no saved file", async () => {
		const host = new FakeHost(
			{ tabId: "main0001" },
			{ tabId: "work0002", hidden: true },
			{ tabId: "work0003", status: "asleep" },
		);
		const service = control(host);
		expect((await service.run("main0001", T.read, { session: "work0002" })).text).toMatch(/hid this session/);
		expect((await service.run("main0001", T.read, { session: "work0003" })).text).toMatch(/has not started/);
	});

	it("reads a deferred tab's saved transcript on the computer it runs on, starting nothing", async () => {
		for (const device of [undefined, "dev-win-1"]) {
			const host = new FakeHost(
				{ tabId: "main0001" },
				{
					tabId: "work0003",
					title: "Kid",
					status: "asleep",
					sessionPath: "/s/kid.jsonl",
					...(device ? { device, deviceName: "DESKTOP-PC" } : {}),
				},
			);
			const reads: { path: string; device: string | undefined }[] = [];
			host.storedMessages = async row => {
				reads.push({ path: row.path, device: row.device });
				return messages;
			};
			const result = await control(host).run("main0001", T.read, { session: "work0003", limit: 2 });
			expect(result.text, String(device)).toContain("[assistant] Done.");
			expect(result.text).toContain(`"before":"2"`);
			expect(reads).toEqual([{ path: "/s/kid.jsonl", device }]);
			// No omp started, no command reached the tab.
			expect(host.sent.filter(entry => entry.tabId === "work0003")).toEqual([]);
		}
	});
});

describe("ompdesk_session_answer", () => {
	it("answers a question and marks the answered session", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "Boss" },
			{ tabId: "work0002", asks: [select("Which db?", ["postgres", "sqlite"])] },
		);
		const result = await control(host).run("main0001", T.answer, { session: "work0002", choice: "Postgres" });
		expect(result.isError).toBe(false);
		expect(host.answers).toEqual([
			{ tabId: "work0002", id: "req1", response: { type: "extension_ui_response", id: "req1", value: "postgres" } },
		]);
		expect(host.marked).toEqual(["Boss"]);
	});

	it("says which field to use when a choice card gets no choice, instead of calling the answer wrong", async () => {
		const host = new FakeHost(
			{ tabId: "main0001" },
			{ tabId: "work0002", asks: [select("Where?", ["top bar", "dialog", "Other (type your own)"])] },
		);
		const service = control(host);
		const bare = await service.run("main0001", T.answer, { session: "work0002" });
		expect(bare.isError).toBe(true);
		expect(bare.text).toContain("No choice given: pass `choice` with one of");
		expect(bare.text).not.toMatch(/is not one of/);
		const typed = await service.run("main0001", T.answer, { session: "work0002", text: "the window title" });
		expect(typed.text).toContain("No choice given");
		expect(typed.text).toContain("`text` answers a text prompt");
		expect(typed.text).toContain('choose "Other (type your own)"');
		expect(host.answers).toHaveLength(0);
		const asked = new FakeHost(
			{ tabId: "main0001" },
			{
				tabId: "work0002",
				asks: [
					{
						id: "q1",
						request: {
							type: "extension_ui_request",
							id: "q1",
							method: "ask",
							questions: [{ id: "a", question: "Lang?", options: [{ label: "ts" }, { label: "py" }] }],
						} as ExtensionUIRequest,
					},
				],
			},
		);
		// One question takes `choice` as its answer.
		const picked = await control(asked).run("main0001", T.answer, { session: "work0002", choice: "ts" });
		expect(picked.isError, picked.text).toBe(false);
		expect(asked.answers[0]?.response).toMatchObject({ answers: [{ id: "a", selectedOptions: ["ts"] }] });
	});

	it("never approves another session's tool approval unless the user allowed it; deny always works", async () => {
		const host = new FakeHost(
			{ tabId: "main0001" },
			{ tabId: "work0002", asks: [select("Allow tool: bash\nrm -rf x", ["Approve", "Deny"])] },
		);
		const service = control(host);
		const refused = await service.run("main0001", T.answer, { session: "work0002", approve: true });
		expect(refused.isError).toBe(true);
		expect(refused.text).toContain("사용자 승인이 필요해요");
		expect(host.answers).toHaveLength(0);
		expect((await service.run("main0001", T.answer, { session: "work0002", choice: "approve" })).isError).toBe(true);
		const deny = await service.run("main0001", T.answer, { session: "work0002", approve: false });
		expect(deny.isError).toBe(false);
		expect(host.answers[0]?.response).toMatchObject({ value: "Deny" });

		const allowed = new FakeHost(
			{ tabId: "main0001" },
			{ tabId: "work0002", asks: [select("Allow tool: bash\nls", ["Approve", "Deny"])] },
		);
		allowed.approve = true;
		expect((await control(allowed).run("main0001", T.answer, { session: "work0002", approve: true })).isError).toBe(
			false,
		);
		expect(allowed.answers[0]?.response).toMatchObject({ value: "Approve" });
	});

	it("treats stock's approval with the session option the same way, and approving for the session needs leave too", async () => {
		const options = ["Approve", "Approve bash for this session", "Deny"];
		const host = new FakeHost(
			{ tabId: "main0001" },
			{ tabId: "work0002", asks: [select("Allow tool: bash\nrm -rf x", options)] },
		);
		const service = control(host);
		for (const args of [{ approve: true }, { choice: "Approve bash for this session" }]) {
			const refused = await service.run("main0001", T.answer, { session: "work0002", ...args });
			expect(refused.text).toContain("사용자 승인이 필요해요");
		}
		expect(host.answers).toHaveLength(0);
		expect((await service.run("main0001", T.answer, { session: "work0002", approve: false })).isError).toBe(false);
		expect(host.answers[0]?.response).toMatchObject({ value: "Deny" });

		const allowed = new FakeHost(
			{ tabId: "main0001" },
			{ tabId: "work0002", asks: [select("Allow tool: bash\nls", options)] },
		);
		allowed.approve = true;
		const session = await control(allowed).run("main0001", T.answer, {
			session: "work0002",
			choice: "Approve bash for this session",
		});
		expect(session.isError).toBe(false);
		expect(allowed.answers[0]?.response).toMatchObject({ value: "Approve bash for this session" });
	});

	it("never answers an OMPdesk confirmation card, a hidden session or itself", async () => {
		const card: ControlAsk = {
			id: "c1",
			request: {
				type: "extension_ui_request",
				id: "c1",
				method: "confirm",
				title: "[OMPdesk] An agent wants to stop a session",
				message: "m",
			},
		};
		const host = new FakeHost(
			{ tabId: "main0001", asks: [select("x", ["a"])] },
			{ tabId: "work0002", asks: [card] },
			{ tabId: "work0003", hidden: true, asks: [select("x", ["a"])] },
		);
		const service = control(host);
		expect((await service.run("main0001", T.answer, { session: "work0002", approve: true })).text).toMatch(
			/only the user answers/,
		);
		expect((await service.run("main0001", T.answer, { session: "work0003", choice: "a" })).text).toMatch(
			/hid this session/,
		);
		expect((await service.run("main0001", T.answer, { session: "main0001", choice: "a" })).text).toMatch(
			/own session/,
		);
		expect(host.answers).toHaveLength(0);
	});

	it("answers confirm, input and multi-question asks and validates the options", async () => {
		const confirm: ControlAsk = {
			id: "c1",
			request: { type: "extension_ui_request", id: "c1", method: "confirm", title: "Overwrite?", message: "m" },
		};
		const input: ControlAsk = {
			id: "i1",
			request: { type: "extension_ui_request", id: "i1", method: "input", title: "Name?" },
		};
		const multi: ControlAsk = {
			id: "q1",
			request: {
				type: "extension_ui_request",
				id: "q1",
				method: "ask",
				questions: [
					{ id: "a", question: "Lang?", options: [{ label: "ts" }, { label: "py" }] },
					{ id: "b", question: "Tests?", options: [{ label: "yes" }, { label: "no" }], multi: true },
				],
			} as ExtensionUIRequest,
		};
		const host = new FakeHost(
			{ tabId: "main0001" },
			{ tabId: "w1000001", asks: [confirm] },
			{ tabId: "w2000002", asks: [input] },
			{ tabId: "w3000003", asks: [multi] },
		);
		const service = control(host);
		await service.run("main0001", T.answer, { session: "w1000001", approve: true });
		await service.run("main0001", T.answer, { session: "w2000002", text: "alpha" });
		expect(
			(await service.run("main0001", T.answer, { session: "w3000003", answers: [{ id: "a", selected: ["rust"] }] }))
				.text,
		).toMatch(/not one of/);
		await service.run("main0001", T.answer, {
			session: "w3000003",
			answers: [
				{ id: "a", selected: ["ts"] },
				{ id: "b", selected: ["yes", "no"] },
			],
		});
		expect(host.answers.map(entry => entry.response)).toEqual([
			{ type: "extension_ui_response", id: "c1", confirmed: true },
			{ type: "extension_ui_response", id: "i1", value: "alpha" },
			{
				type: "extension_ui_response",
				id: "q1",
				answers: [
					{ id: "a", selectedOptions: ["ts"] },
					{ id: "b", selectedOptions: ["yes", "no"] },
				],
			},
		]);
	});

	it("says so when nothing waits", async () => {
		const host = new FakeHost({ tabId: "main0001" }, { tabId: "work0002" });
		expect((await control(host).run("main0001", T.answer, { session: "work0002", choice: "x" })).text).toMatch(
			/not waiting/,
		);
	});

	const planned = { title: "Share over Tailscale", planFilePath: "local://PLAN.md" };

	it("approves a pending plan through plan_approval when agents may approve, and marks the answer", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" }, { tabId: "work0002", plan: planned });
		const service = control(host);
		const refused = await service.run("main0001", T.answer, { session: "work0002", approve: true });
		expect(refused.text).toContain("사용자 승인이 필요해요");
		expect(host.sent.some(entry => entry.command.type === "plan_approval")).toBe(false);
		host.approve = true;
		const done = await service.run("main0001", T.answer, {
			session: "work0002",
			approve: true,
			choice: "keep_context",
		});
		expect(done.isError).toBe(false);
		expect(host.sent.find(entry => entry.command.type === "plan_approval")).toEqual({
			tabId: "work0002",
			command: { type: "plan_approval", approved: true, option: "keep_context" },
		});
		expect(host.marked).toContain("Boss");
	});

	it("rejects a pending plan with feedback whatever the approve setting, and refuses an unknown option", async () => {
		const host = new FakeHost({ tabId: "main0001" }, { tabId: "work0002", plan: planned });
		const service = control(host);
		expect(
			(await service.run("main0001", T.answer, { session: "work0002", approve: true, choice: "save" })).isError,
		).toBe(true);
		const rejected = await service.run("main0001", T.answer, {
			session: "work0002",
			approve: false,
			text: "Split it in two",
		});
		expect(rejected.isError).toBe(false);
		expect(host.sent.find(entry => entry.command.type === "plan_approval")?.command).toEqual({
			type: "plan_approval",
			approved: false,
			feedback: "Split it in two",
		});
	});
});

describe("ompdesk_session_stop", () => {
	it("stops, closes and deletes a session it opened without a card", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		const service = control(host);
		await service.run("main0001", T.open, { message: "work" });
		const child = [...host.tabsById.keys()].find(id => id !== "main0001") as string;
		expect(host.sent.some(entry => entry.tabId === child && entry.command.type === "prompt")).toBe(true);
		const result = await service.run("main0001", T.stop, { session: child, delete: true });
		expect(result.isError).toBe(false);
		expect(host.cards).toHaveLength(0);
		expect(host.deleted).toEqual([child]);
		expect(host.sent.some(entry => entry.tabId === child && entry.command.type === "abort")).toBe(true);
	});

	it("refuses its own session and an unknown id, and stops-and-closes one it opened with no card", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		const service = control(host);
		const own = await service.run("main0001", T.stop, { session: "main0001" });
		expect(own.isError).toBe(true);
		expect(own.text).toMatch(/own session/);
		expect((await service.run("main0001", T.stop, { session: "nope9999" })).text).toMatch(/No session/);
		await service.run("main0001", T.open, { message: "work" });
		const child = [...host.tabsById.keys()].find(id => id !== "main0001") as string;
		const stopped = await service.run("main0001", T.stop, { session: child, close: true });
		expect(stopped.isError).toBe(false);
		expect(stopped.text).toContain("Closed");
		expect(host.cards).toHaveLength(0);
	});

	it("answers a repeated delete of a session it deleted as already deleted, and still fails an id it never knew", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		const service = control(host);
		await service.run("main0001", T.open, { message: "work" });
		const child = [...host.tabsById.keys()].find(id => id !== "main0001") as string;
		expect((await service.run("main0001", T.stop, { session: child, delete: true })).isError).toBe(false);
		const again = await service.run("main0001", T.stop, { session: `"${child}"`, delete: true });
		expect(again.isError).toBe(false);
		expect(again.text).toContain("already deleted");
		expect(host.deleted).toEqual([child]);
		const unknown = await service.run("main0001", T.stop, { session: "nope9999", delete: true });
		expect(unknown.isError).toBe(true);
		expect(unknown.text).toMatch(/No session/);
		// Only a delete is a success: closing a session that is gone is still an unknown id.
		expect((await service.run("main0001", T.stop, { session: child, close: true })).isError).toBe(true);
	});

	it("asks the user before touching a session it did not open, and a refusal stops nothing", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "Boss" },
			{ tabId: "work0002", title: "Theirs", busy: true },
		);
		host.cardAnswer = false;
		const service = control(host);
		const declined = await service.run("main0001", T.stop, { session: "work0002", close: true });
		expect(declined.text).toMatch(/declined/);
		expect(host.cards).toEqual([{ title: "stopTitle:Boss:Theirs", message: "closeMessage:Boss:Theirs" }]);
		expect(host.sent.some(entry => entry.command.type === "abort")).toBe(false);
		host.cardAnswer = true;
		expect((await service.run("main0001", T.stop, { session: "work0002", delete: true })).text).toMatch(/deleted/);
		expect(host.cards.at(-1)?.message).toBe("deleteMessage:Boss:Theirs");
	});

	it("skips the card for a stop and a close of a session it did not open while agents may manage", async () => {
		const host = new FakeHost({ tabId: "main0001" }, { tabId: "work0002", busy: true });
		host.manage = true;
		const service = control(host);
		expect((await service.run("main0001", T.stop, { session: "work0002" })).text).toMatch(/Stopped/);
		expect((await service.run("main0001", T.stop, { session: "work0002", close: true })).text).toMatch(/Closed/);
		expect(host.cards).toHaveLength(0);
	});

	it("still asks to delete a saved session it did not open while agents may manage, and a refusal deletes nothing", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "Boss" },
			{ tabId: "work0002", title: "Theirs", busy: true },
		);
		host.manage = true;
		host.cardAnswer = false;
		const service = control(host);
		const declined = await service.run("main0001", T.stop, { session: "work0002", delete: true });
		expect(declined.text).toMatch(/declined/);
		expect(host.cards).toEqual([{ title: "stopTitle:Boss:Theirs", message: "deleteMessage:Boss:Theirs" }]);
		expect(host.deleted).toEqual([]);
		expect(host.sent.some(entry => entry.command.type === "abort")).toBe(false);
		host.cardAnswer = true;
		expect((await service.run("main0001", T.stop, { session: "work0002", delete: true })).text).toMatch(/deleted/);
		expect(host.cards).toHaveLength(2);
		expect(host.deleted).toEqual(["work0002"]);
	});

	it("deletes a saved session it did not open without a card while agents have full control", async () => {
		const host = new FakeHost({ tabId: "main0001" }, { tabId: "work0002", busy: true });
		host.full = true;
		host.cardAnswer = false;
		expect((await control(host).run("main0001", T.stop, { session: "work0002", delete: true })).text).toMatch(
			/deleted/,
		);
		expect(host.cards).toEqual([]);
		expect(host.deleted).toEqual(["work0002"]);
	});

	it("deletes a session it opened without a card, whatever the manage switch says", async () => {
		for (const manage of [true, false]) {
			const host = new FakeHost({ tabId: "main0001" });
			host.manage = manage;
			const service = control(host);
			await service.run("main0001", T.open, { message: "work" });
			const child = [...host.tabsById.keys()].find(id => id !== "main0001") as string;
			expect((await service.run("main0001", T.stop, { session: child, delete: true })).isError).toBe(false);
			expect(host.cards, `manage ${manage}`).toHaveLength(0);
			expect(host.deleted).toEqual([child]);
		}
	});
});

describe("ompdesk_tab_focus and ompdesk_notify", () => {
	it("shows a session the way the user does, never a hidden one", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "Boss" },
			{ tabId: "work0002" },
			{ tabId: "work0003", hidden: true },
		);
		const service = control(host);
		await service.run("main0001", T.focus, { session: "work0002", how: "split-right" });
		expect(host.views).toEqual([{ tabId: "work0002", how: "split-right" }]);
		expect((await service.run("main0001", T.focus, { session: "work0003" })).isError).toBe(true);
		await service.run("main0001", T.notify, { title: "Done", body: "all three" });
		expect(host.notify).toHaveBeenCalledWith("main0001", "Done", "all three");
	});
});

describe("hooks for Autopilot", () => {
	it("childrenOf lists live children and clearQueue drops the queue without aborting", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		const service = control(host);
		const ids = await service.openSessions("main0001", [{ message: "a" }, { message: "b" }]);
		expect((await service.childrenOf("main0001")).sort()).toEqual([...ids].sort());
		host.tabsById.delete(ids[0] as string);
		expect(await service.childrenOf("main0001")).toEqual([ids[1]]);
		await service.clearQueue(ids[1] as string);
		const types = host.sent.filter(entry => entry.tabId === ids[1]).map(entry => entry.command.type);
		expect(types).toContain("queue_clear");
		expect(types).not.toContain("abort");
	});
});

const clean: BranchFacts = {
	branch: "omp/agent/a",
	baseBranch: "main",
	commitsAhead: 2,
	files: [
		{ path: "src/a.ts", added: 10, removed: 2 },
		{ path: "src/b.ts", added: 5, removed: 0 },
	],
	filesTruncated: false,
	uncommitted: 0,
	untracked: 1,
	baseUncommitted: 0,
	merged: false,
};

/** A parent and two worktree children it opened, each on its own branch. */
async function withWorktreeChildren() {
	const host = new FakeHost({ tabId: "main0001", title: "Boss" });
	const service = control(host);
	const ids = await service.openSessions("main0001", [
		{ message: "part one", worktree: true },
		{ message: "part two", worktree: true },
	]);
	for (const [index, id] of ids.entries()) {
		const tab = host.tabsById.get(id) as FakeTab;
		const branch = `omp/agent/${index === 0 ? "a" : "b"}`;
		tab.title = index === 0 ? "Alpha" : "Beta";
		tab.last = `${tab.title} is done: tests pass`;
		tab.busy = false;
		tab.worktree = { name: "w", branch, baseCwd: "/repo", path: `/wt/${branch}` };
		host.facts.set(branch, { ...clean, branch });
	}
	return { host, service, ids: ids as [string, string] };
}

describe("ompdesk_session_stop delete on a worktree child it opened", () => {
	it("removes the worktree and branch when nothing would be lost", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		const result = await service.run("main0001", T.stop, { session: ids[0], delete: true });
		expect(result.text).toContain("Removed its worktree /wt/omp/agent/a and branch omp/agent/a.");
		expect(host.removed).toEqual(["omp/agent/a"]);
	});

	it("keeps unlanded or dirty work and says what is there", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		host.removal = null;
		const result = await service.run("main0001", T.stop, { session: ids[0], delete: true });
		expect(host.deleted).toEqual([ids[0]]);
		expect(host.removed).toEqual([]);
		expect(result.text).toContain(
			"Kept its worktree /wt/omp/agent/a and branch omp/agent/a: 2 commit(s) not in the base or its upstream, 1 untracked file(s).",
		);
	});
});

describe("a worktree child's done report", () => {
	it("carries what its git holds, and tells the child what disagrees with the report", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		host.facts.set("omp/agent/a", { ...clean, uncommitted: 2, untracked: 0 });
		const result = await service.run(ids[0], T.report, {
			kind: "done",
			text: "Finished",
			files: ["src/a.ts", "src/c.ts"],
		});
		const mail = host.mails.at(-1);
		expect(mail?.to).toBe("main0001");
		expect(mail?.content).toContain(
			"Git (omp/agent/a): 2 commit(s) not in main yet; 2 uncommitted file(s); reported but unchanged: src/c.ts.",
		);
		expect(result.text).toContain("your worktree still has 2 uncommitted file(s)");
		expect(result.text).toContain("the files you named src/c.ts are not in your branch's change");

		host.facts.set("omp/agent/b", { ...clean, branch: "omp/agent/b", untracked: 0, merged: true });
		const landed = await service.run(ids[1], T.report, { kind: "done", text: "Landed", files: ["./src/b.ts"] });
		expect(host.mails.at(-1)?.content).toContain("Git (omp/agent/b): landed.");
		expect(landed.text).toBe("Delivered.");
	});

	it("reports as before when its git cannot be read", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		host.facts.clear();
		const result = await service.run(ids[0], T.report, { kind: "done", text: "Finished" });
		expect(result.text).toBe("Delivered.");
		expect(host.mails.at(-1)?.content).not.toContain("Git (");
	});
});

describe("ompdesk_compare", () => {
	it("gives each worktree child's branch, diff stat, uncommitted work and final answer, and runs no tests", async () => {
		const { service, ids, host } = await withWorktreeChildren();
		host.facts.set("omp/agent/b", { ...clean, branch: "omp/agent/b", uncommitted: 3 });
		const result = await service.run("main0001", T.compare, {});
		expect(result.isError).toBe(false);
		expect(result.text).toContain(`- ${ids[0]} "Alpha"`);
		expect(result.text).toContain("branch omp/agent/a → main: 2 commit(s) ahead, 2 file(s) changed (+15 −2)");
		expect(result.text).toContain("files: src/a.ts +10 −2, src/b.ts +5 −0");
		expect(result.text).toContain("final answer: Alpha is done: tests pass");
		expect(result.text).toContain("ready to merge with ompdesk_merge");
		expect(result.text).toContain("cannot merge yet: omp/agent/b has 3 uncommitted file(s)");
		expect(result.text).toContain("Compare runs no tests");
	});

	it("explains a session without a worktree, a branch its host cannot read, and an empty default", async () => {
		const host = new FakeHost(
			{ tabId: "main0001" },
			{ tabId: "plain002", title: "Plain", last: "done" },
			{
				tabId: "remot003",
				title: "Far",
				device: "dev-studio",
				deviceName: "Studio",
				last: "done",
				worktree: { name: "w", branch: "b", baseCwd: "/r", path: "/p" },
			},
		);
		const service = control(host);
		expect((await service.run("main0001", T.compare, {})).text).toMatch(/No worktree sessions/);
		const both = await service.run("main0001", T.compare, { sessions: ["plain002", "remot003"] });
		expect(both.text).toContain("no worktree");
		expect(both.text).toContain("could not read its branch: no such branch");
		expect(host.gitCalls).toEqual([
			{ op: "facts", branch: "b", device: "dev-studio" },
			{ op: "evidence", branch: "b", device: "dev-studio" },
		]);
	});
});

describe("ompdesk_merge", () => {
	it("asks the user first and merges nothing when they decline", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		host.cardAnswer = false;
		const result = await service.run("main0001", T.merge, { session: ids[0] });
		expect(result.text).toContain("The user declined the merge");
		expect(host.cards).toEqual([{ title: "mergeTitle:{caller}:{target}", message: "mergeMessage:Boss:Alpha" }]);
		expect(host.merges).toEqual([]);
	});

	it("merges after the card, or without one when the user turned confirmations off, and never pushes", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		const first = await service.run("main0001", T.merge, { session: ids[0] });
		expect(first.text).toContain("Merged omp/agent/a into /repo (abc1234: 2 files changed). Nothing was pushed.");
		expect(host.cards).toHaveLength(1);
		host.manage = true;
		await service.run("main0001", T.merge, { session: ids[1] });
		expect(host.cards).toHaveLength(1);
		expect(host.merges).toEqual(["omp/agent/a", "omp/agent/b"]);
	});

	it("reports a conflict as the merge's result, aborted, and refuses what would lose work", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		host.manage = true;
		host.mergeResult = { merged: false, reason: "conflict", files: ["src/a.ts"], predicted: false };
		const conflict = await service.run("main0001", T.merge, { session: ids[0] });
		expect(conflict.isError).toBe(true);
		expect(conflict.text).toContain("Merge conflict in src/a.ts: the merge was aborted");
		host.facts.set("omp/agent/b", { ...clean, branch: "omp/agent/b", uncommitted: 2 });
		expect((await service.run("main0001", T.merge, { session: ids[1] })).text).toMatch(/uncommitted file/);
		expect(host.merges).toEqual(["omp/agent/a"]);
		(host.tabsById.get(ids[1]) as FakeTab).busy = true;
		expect((await service.run("main0001", T.merge, { session: ids[1] })).text).toMatch(/still working/);
	});

	it("refuses a merge git merge-tree predicts will conflict, naming the files, with the parent untouched", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		host.manage = true;
		host.mergeResult = { merged: false, reason: "conflict", files: ["README.md", "src/a.ts"], predicted: true };
		const result = await service.run("main0001", T.merge, { session: ids[0] });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("Merging omp/agent/a would conflict in README.md, src/a.ts");
		expect(result.text).toContain("no merge was attempted and /repo is unchanged");
		expect(result.text).not.toContain("aborted");
	});

	it("names a failed pre-merge hook with its output tail, and a failed post-merge hook beside the success", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		host.manage = true;
		const report = {
			script: ".ompdesk/worktree-pre-merge",
			ok: false,
			exitCode: 3,
			timedOut: false,
			durationMs: 900,
			logPath: "/repo/.git/worktrees/a/ompdesk-worktree-pre-merge.log",
			outputTail: "lint failed: src/a.ts",
		};
		host.mergeResult = { merged: false, reason: "hook", hook: report };
		const pre = await service.run("main0001", T.merge, { session: ids[0] });
		expect(pre.isError).toBe(true);
		expect(pre.text).toContain("Pre-merge hook .ompdesk/worktree-pre-merge failed (exit 3)");
		expect(pre.text).toContain("the merge was not started");
		expect(pre.text).toContain("lint failed: src/a.ts");

		host.mergeResult = {
			merged: true,
			sha: "abc1234",
			summary: "",
			postMerge: {
				...report,
				script: ".ompdesk/worktree-post-merge",
				timedOut: true,
				exitCode: null,
				durationMs: 120_000,
			},
		};
		const post = await service.run("main0001", T.merge, { session: ids[1] });
		expect(post.isError).toBeFalsy();
		expect(post.text).toContain("Merged omp/agent/b into /repo (abc1234). Nothing was pushed.");
		expect(post.text).toContain(
			"Post-merge hook .ompdesk/worktree-post-merge failed (timed out after 120s); the merge stays.",
		);
	});

	it("refuses a session without a branch, a hidden one, and itself", async () => {
		const host = new FakeHost({ tabId: "main0001" }, { tabId: "plain002" }, { tabId: "priv0003", hidden: true });
		const service = control(host);
		expect((await service.run("main0001", T.merge, { session: "plain002" })).text).toMatch(/no worktree branch/);
		expect((await service.run("main0001", T.merge, { session: "priv0003" })).text).toMatch(/hid this session/);
		expect((await service.run("main0001", T.merge, { session: "main0001" })).text).toMatch(/own session/);
	});
});

describe("a worktree child on a paired host", () => {
	/** Both children run on the paired Windows desktop; every git question goes to that computer. */
	async function remoteChildren() {
		const made = await withWorktreeChildren();
		for (const id of made.ids)
			Object.assign(made.host.tabsById.get(id) as FakeTab, { device: desktop.id, deviceName: desktop.name });
		return made;
	}

	it("compares and merges it on that host with no refusal", async () => {
		const { host, service, ids } = await remoteChildren();
		host.manage = true;
		const compared = await service.run("main0001", T.compare, { sessions: [ids[0]] });
		expect(compared.text).toContain("branch omp/agent/a → main: 2 commit(s) ahead");
		expect(compared.text).not.toContain("sessions only");
		const merged = await service.run("main0001", T.merge, { session: ids[0] });
		expect(merged.isError).toBe(false);
		expect(merged.text).toContain("Merged omp/agent/a into /repo");
		expect(host.gitCalls).toEqual([
			{ op: "facts", branch: "omp/agent/a", device: desktop.id },
			{ op: "evidence", branch: "omp/agent/a", device: desktop.id },
			{ op: "facts", branch: "omp/agent/a", device: desktop.id },
			{ op: "merge", branch: "omp/agent/a", device: desktop.id },
		]);
	});

	it("lists its branch in the review queue and removes its worktree on delete, both on that host", async () => {
		const { host, service, ids } = await remoteChildren();
		const items = await service.reviewItems("main0001");
		// It names the computer the child runs on, so a device viewing this session opens it there, not here.
		expect(items.find(item => item.tabId === ids[0])).toMatchObject({ commitsAhead: 2, device: desktop.id });
		const deleted = await service.run("main0001", T.stop, { session: ids[1], delete: true });
		expect(deleted.text).toContain("Removed its worktree /wt/omp/agent/b and branch omp/agent/b.");
		expect(host.gitCalls.length).toBeGreaterThan(0);
		expect(host.gitCalls.every(call => call.device === desktop.id)).toBe(true);
		expect(host.gitCalls).toContainEqual({ op: "remove", branch: "omp/agent/b", device: desktop.id });
	});
});

describe("familyEdits: what the sessions one opened changed", () => {
	const edit = (id: string, path: string, timestamp: number): AgentMessage[] => [
		{ role: "assistant", content: [{ type: "toolCall", id, name: "edit", arguments: { path } }], timestamp },
		{ role: "toolResult", toolCallId: id, toolName: "edit", content: [], details: { diff: "+1 x" }, timestamp },
	];
	const turn = (cwd: string, path: string, at: number): RpcTurnEdits => ({
		cwd,
		startedAt: at - 10,
		endedAt: at,
		messages: edit(`${path}-call`, path, at),
	});
	const unlanded: RpcGitUnlanded = {
		branch: "omp/agent/w",
		target: "main",
		truncated: false,
		files: [{ path: "w.ts", status: "M", added: 2, removed: 1 }],
	};

	function family() {
		const host = new FakeHost(
			{ tabId: "main0001", title: "Boss", sessionPath: "/s/boss.jsonl" },
			{ tabId: "kid10000", title: "Same checkout", busy: true, turn: turn("/repo", "a.ts", 3000) },
			{
				tabId: "kid20000",
				title: "In a worktree",
				cwd: "/wt/w",
				worktree: { name: "w", branch: "omp/agent/w", baseCwd: "/repo", path: "/wt/w" },
				turn: turn("/wt/w", "w.ts", 4000),
				unlanded,
			},
			{ tabId: "kid30000", title: "Not started", status: "asleep", sessionPath: "/s/asleep.jsonl" },
			{ tabId: "kid40000", title: "Hidden", hidden: true, turn: turn("/repo", "h.ts", 3000) },
			// Works in the same checkout, opened by nobody here: never one of the family.
			{ tabId: "peer0001", title: "Someone else", busy: true, turn: turn("/repo", "p.ts", 3000) },
		);
		for (const id of ["kid10000", "kid20000", "kid30000", "kid40000"]) host.parents.set(id, "main0001");
		host.storedTranscripts.set("/s/asleep.jsonl", [
			{ role: "user", content: "go", timestamp: 1000 },
			...edit("s1", "asleep.ts", 2500),
		]);
		host.closed = [
			{ path: "/s/landed.jsonl", openedBySession: "/s/boss.jsonl", title: "Landed", cwd: "/repo", closedAt: 5000 },
			{ path: "/s/before.jsonl", openedBySession: "/s/boss.jsonl", title: "Before", cwd: "/repo", closedAt: 500 },
			{
				path: "/s/other.jsonl",
				openedBySession: "/s/other-boss.jsonl",
				title: "Other",
				cwd: "/repo",
				closedAt: 5000,
			},
		];
		host.storedTranscripts.set("/s/landed.jsonl", [
			{ role: "user", content: "fix", timestamp: 4000 },
			...edit("l1", "landed.ts", 4500),
			{ role: "assistant", content: [{ type: "text", text: "Done.\nResult: ok" }], timestamp: 4600 },
		]);
		return { host, service: control(host) };
	}

	it("asks each session it opened, a worktree's branch too, and leaves out sessions it never opened", async () => {
		const { host, service } = family();
		const { members } = await service.familyEdits("main0001", 2000);
		expect(members.map(member => member.title)).toEqual(["Same checkout", "In a worktree", "Not started", "Landed"]);
		const [same, worktree, asleep, landed] = members;
		expect(same).toMatchObject({ live: true, unlanded: null, edits: { cwd: "/repo", endedAt: 3000 } });
		expect(worktree).toMatchObject({ live: false, unlanded });
		// Not started: its saved file says what its last turn changed.
		expect(asleep?.edits?.messages.map(message => message.role)).toEqual(["assistant", "toolResult"]);
		// Closed after its work landed during this turn: its saved file, cut to its edit calls.
		expect(landed).toMatchObject({ key: "/s/landed.jsonl", live: false, edits: { startedAt: 4000, endedAt: 4600 } });
		expect(landed?.edits?.messages).toHaveLength(2);
		// The unrelated session in the same checkout and the hidden one are never even asked.
		expect(host.sent.some(entry => entry.tabId === "peer0001" || entry.tabId === "kid40000")).toBe(false);
	});

	it("brings closed children only for a turn, and reads a closed one's file once", async () => {
		const { host, service } = family();
		const read = vi.spyOn(host, "storedMessages");
		expect((await service.familyEdits("main0001")).members.map(member => member.title)).not.toContain("Landed");
		await service.familyEdits("main0001", 2000);
		await service.familyEdits("main0001", 2000);
		expect(read.mock.calls.filter(([row]) => row.path === "/s/landed.jsonl")).toHaveLength(1);
	});

	it("reads a child's file again when it was reopened and closed again", async () => {
		const { host, service } = family();
		const first = (await service.familyEdits("main0001", 2000)).members.find(member => member.title === "Landed");
		expect(first?.edits?.endedAt).toBe(4600);
		// Reopened for more work, then closed again by main: the record is replaced, the file has a newer turn.
		host.storedTranscripts.set("/s/landed.jsonl", [
			{ role: "user", content: "one more", timestamp: 8000 },
			...edit("l2", "again.ts", 8500),
		]);
		host.closed = [{ ...(host.closed[0] as ClosedChild), closedAt: 9000 }];
		const again = (await service.familyEdits("main0001", 7000)).members.find(member => member.title === "Landed");
		expect(again?.edits).toMatchObject({ startedAt: 8000, endedAt: 8500 });
	});

	it("reads a child closed on a paired device from that device, never from this computer", async () => {
		const { host, service } = family();
		host.closed = [
			{
				path: "/s/landed.jsonl",
				openedBySession: "/s/boss.jsonl",
				title: "On the desktop",
				cwd: "C:/repo",
				device: "dev-win-1",
				closedAt: 5000,
			},
		];
		const reads: { path: string; device: string | undefined }[] = [];
		const stored = host.storedMessages;
		host.storedMessages = async row => {
			reads.push({ path: row.path, device: row.device });
			return stored(row);
		};
		const { members } = await service.familyEdits("main0001", 2000);
		const desktop = members.find(member => member.title === "On the desktop");
		expect(reads).toContainEqual({ path: "/s/landed.jsonl", device: "dev-win-1" });
		expect(desktop).toMatchObject({ device: "dev-win-1", edits: { cwd: "C:/repo", endedAt: 4600 } });
	});

	it("says nothing of a session whose host cannot answer, and keeps the rest", async () => {
		const { host, service } = family();
		delete (host.tabsById.get("kid10000") as FakeTab).turn;
		const { members } = await service.familyEdits("main0001", 2000);
		expect(members.find(member => member.title === "Same checkout")?.edits).toBeNull();
		expect(members.find(member => member.title === "In a worktree")?.unlanded).toEqual(unlanded);
	});
});
describe("the review queue", () => {
	it("lists the sessions the caller opened with their diff stat, running ones as running", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		(host.tabsById.get(ids[1]) as FakeTab).busy = true;
		const items = await service.reviewItems("main0001");
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({
			tabId: ids[0],
			title: "Alpha",
			state: "needs-review",
			branch: "omp/agent/a",
			baseBranch: "main",
			commitsAhead: 2,
			files: 2,
			added: 15,
			removed: 2,
			answer: "Alpha is done: tests pass",
		});
		expect(items[1]?.state).toBe("running");
		host.tabsById.set("other004", { ...(host.tabsById.get(ids[0]) as FakeTab), tabId: "other004" });
		expect((await service.reviewItems("main0001")).map(item => item.tabId)).not.toContain("other004");
	});

	it("carries the question of a child's open card with no report, never OMPdesk's own card", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		const ask = (id: string, title: string): ControlAsk => ({
			id,
			request: {
				type: "extension_ui_request",
				id,
				method: "select",
				title,
				options: ["a", "b"],
			} as ExtensionUIRequest,
		});
		(host.tabsById.get(ids[0]) as FakeTab).asks = [ask("q1", "Which breakpoint should the tablet board use?")];
		(host.tabsById.get(ids[1]) as FakeTab).asks = [ask("q2", "[OMPdesk] Delete a session?")];
		const items = await service.reviewItems("main0001");
		expect(items.find(item => item.tabId === ids[0])).toMatchObject({
			waiting: true,
			question: "Which breakpoint should the tablet board use?",
		});
		expect(items.find(item => item.tabId === ids[1])?.question).toBeUndefined();
	});

	it("leaves out a landed, clean, idle child and lists a landed one only for the files it left over", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		const landed: BranchFacts = { ...clean, commitsAhead: 0, files: [], untracked: 0, merged: true };
		host.facts.set("omp/agent/a", { ...landed, branch: "omp/agent/a" });
		host.facts.set("omp/agent/b", {
			...landed,
			branch: "omp/agent/b",
			files: [{ path: "src/x.ts", added: 1, removed: 0 }],
			uncommitted: 1,
		});
		const items = await service.reviewItems("main0001");
		expect(items.map(item => item.tabId)).toEqual([ids[1]]);
		expect(items[0]).toMatchObject({ commitsAhead: 0, files: 1, added: 1, removed: 0, uncommitted: 1 });

		host.facts.set("omp/agent/b", { ...landed, branch: "omp/agent/b", untracked: 2 });
		expect(await service.reviewItems("main0001")).toMatchObject([
			{ tabId: ids[1], commitsAhead: 0, files: 0, uncommitted: 2 },
		]);

		// Still working: listed as running, whatever its branch says.
		host.facts.set("omp/agent/b", { ...landed, branch: "omp/agent/b" });
		(host.tabsById.get(ids[1]) as FakeTab).busy = true;
		expect(await service.reviewItems("main0001")).toMatchObject([{ tabId: ids[1], state: "running" }]);
		(host.tabsById.get(ids[1]) as FakeTab).busy = false;
		expect(await service.reviewItems("main0001")).toEqual([]);
	});

	it("tells what every opened session runs on and cost, a landed one included, and the caller's own cost", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		Object.assign(host.tabsById.get(ids[0]) as FakeTab, {
			model: { provider: "anthropic", id: "claude-x" },
			cost: 0.3,
			// Its journal holds the judge's metered calls beside the subscription's replies: its host splits them.
			spend: {
				anthropic: { billing: "subscription", cost: 0.29, today: 0.29 },
				openrouter: { billing: "metered", cost: 0.01, today: 0.01 },
			},
		});
		Object.assign(host.tabsById.get(ids[1]) as FakeTab, { cost: 0.12 });
		Object.assign(host.tabsById.get("main0001") as FakeTab, { cost: 1.5 });
		for (const [index, id] of ids.entries())
			Object.assign(host.tabsById.get(id) as FakeTab, { sessionPath: `/s/kid${index}.jsonl` });
		host.facts.set("omp/agent/a", {
			...clean,
			branch: "omp/agent/a",
			commitsAhead: 0,
			files: [],
			untracked: 0,
			merged: true,
		});
		const review = await service.review("main0001");
		expect(review.items.map(item => item.tabId)).toEqual([ids[1]]);
		// The caller's own journal too (no session file in this fixture: by its tab id), the base of the family's cost.
		expect(review.usage).toEqual({
			"/s/kid0.jsonl": { model: "anthropic/claude-x", cost: 0.3, split: { charged: 0.01, estimate: 0.29 } },
			"/s/kid1.jsonl": { cost: 0.12 },
			main0001: { cost: 1.5 },
		});
	});

	it("keeps a child's last read cost and split while its omp cannot answer (restarting, its link down)", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		const child = host.tabsById.get(ids[1]) as FakeTab;
		Object.assign(child, {
			sessionPath: "/s/kid1.jsonl",
			cost: 0.4,
			spend: { anthropic: { billing: "subscription", cost: 0.4, today: 0.4 } },
		});
		const first = await service.review("main0001");
		expect(first.usage?.["/s/kid1.jsonl"]).toMatchObject({ cost: 0.4, split: { charged: 0, estimate: 0.4 } });
		child.status = "starting";
		const again = await service.review("main0001");
		expect(again.usage?.["/s/kid1.jsonl"]).toMatchObject({ cost: 0.4, split: { charged: 0, estimate: 0.4 } });
	});

	it("reads a running child's step and cost again between full reviews, and leaves the rest as sent", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		const child = host.tabsById.get(ids[1]) as FakeTab;
		const call = (id: string, intent: string) => ({
			role: "assistant",
			content: [{ type: "toolCall", id, name: "bash", arguments: {}, intent }],
		});
		Object.assign(child, { sessionPath: "/s/kid1.jsonl", busy: true, cost: 0.1, messages: [call("c1", "build")] });
		const last = await service.review("main0001");
		expect(last.items.find(item => item.tabId === ids[1])).toMatchObject({
			state: "running",
			step: "running bash (build)",
		});
		Object.assign(child, { cost: 0.7, messages: [call("c2", "run the tests")] });
		host.sent.length = 0;
		const live = await service.liveReview("main0001", last);
		expect(live?.items.find(item => item.tabId === ids[1])?.step).toBe("running bash (run the tests)");
		expect(live?.usage?.["/s/kid1.jsonl"]?.cost).toBe(0.7);
		// No git and no other child is read for it.
		expect(host.sent.every(entry => entry.tabId === ids[1])).toBe(true);
		child.busy = false;
		expect(await service.liveReview("main0001", last)).toBeNull();
	});
});

describe("ompdesk_schedule", () => {
	it("creates a run on the Schedules service after a card, marked as the agent's, never with auto-approve", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss", cwd: "/repo" });
		const service = control(host);
		const result = await service.run("main0001", T.schedule, {
			action: "create",
			name: "nightly audit",
			prompt: "Audit the repo and report",
			every_minutes: 60,
		});
		expect(result.isError).toBe(false);
		expect(result.text).toContain("Scheduled “[agent] nightly audit” every 60 min in /repo");
		expect(host.cards).toEqual([
			{ title: "scheduleTitle:{caller}:{target}", message: "scheduleMessage:Boss:{target}" },
		]);
		expect(host.savedDrafts[0]).toMatchObject({
			name: "[agent] nightly audit",
			cwd: "/repo",
			frequency: { kind: "interval", minutes: 60 },
			autoApprove: false,
			enabled: true,
			model: null,
		});
	});

	it("supports a daily time with weekdays, skips the card when confirmations are off, and a refusal schedules nothing", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		const service = control(host);
		host.cardAnswer = false;
		const declined = await service.run("main0001", T.schedule, {
			action: "create",
			name: "a",
			prompt: "p",
			daily_at: "09:30",
			days: [3, 1, 1],
		});
		expect(declined.text).toContain("The user declined the schedule");
		expect(host.savedDrafts).toEqual([]);
		host.manage = true;
		const made = await service.run("main0001", T.schedule, {
			action: "create",
			name: "a",
			prompt: "p",
			daily_at: "09:30",
			days: [3, 1, 1],
			folder: "/other",
			model: "anthropic/claude-x",
		});
		expect(made.text).toContain("Mon, Wed at 09:30 in /other");
		expect(host.savedDrafts[0]).toMatchObject({
			frequency: { kind: "daily", time: "09:30", days: [1, 3] },
			model: "anthropic/claude-x",
		});
	});

	it("checks the folder and bad arguments, and caps nothing", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		host.manage = true;
		const service = control(host);
		const base = { action: "create", name: "n", prompt: "p" };
		// No count or interval cap of its own: the Schedules service's rules apply.
		expect(
			(await service.run("main0001", T.schedule, { ...base, every_minutes: 60, folder: "relative/dir" })).text,
		).toMatch(/absolute/);
		expect((await service.run("main0001", T.schedule, { ...base })).text).toMatch(
			/exactly one of every_minutes, daily_at, at, in_minutes or on/,
		);
		expect((await service.run("main0001", T.schedule, { ...base, every_minutes: 60, in_minutes: 5 })).text).toMatch(
			/exactly one of/,
		);
		expect(
			(await service.run("main0001", T.schedule, { ...base, on: { source: "files", path: "rel/dir" } })).text,
		).toMatch(/on.path must be an absolute path/);
		expect(
			(
				await service.run("main0001", T.schedule, {
					...base,
					on: { source: "github", repo: "nope", events: ["issue"] },
				})
			).text,
		).toMatch(/owner\/name/);
		expect((await service.run("main0001", T.schedule, { action: "pause" })).text).toMatch(/pause needs id/);
		expect(
			(await service.run("main0001", T.schedule, { action: "create", name: "n", every_minutes: 60 })).text,
		).toMatch(/needs prompt/);
		for (let i = 0; i < 8; i++)
			expect((await service.run("main0001", T.schedule, { ...base, name: `n${i}`, every_minutes: 5 })).isError).toBe(
				false,
			);
	});

	it("lists every schedule but cancels only the agent's own; the user's stay", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		host.manage = true;
		host.scheduleRows.push({
			id: "user0001",
			name: "Weekly report",
			frequency: { kind: "daily", time: "08:00", days: [] },
			cwd: "/work",
			enabled: true,
			nextRun: null,
			lastStatus: "succeeded",
		});
		const service = control(host);
		await service.run("main0001", T.schedule, { action: "create", name: "mine", prompt: "p", every_minutes: 45 });
		const listed = await service.run("main0001", T.schedule, { action: "list" });
		expect(listed.text).toContain(
			"user0001 “Weekly report” daily at 08:00 in /work; next —; last run succeeded [the user's own: leave it]",
		);
		expect(listed.text).toContain("[made by an agent: you can change it]");
		expect((await service.run("main0001", T.schedule, { action: "cancel", id: "user0001" })).text).toMatch(
			/the user's own schedule/,
		);
		expect(host.scheduleRows.map(row => row.id)).toContain("user0001");
		const own = host.scheduleRows.find(row => row.name.startsWith("[agent] ")) as ScheduleRow;
		expect((await service.run("main0001", T.schedule, { action: "cancel", id: own.id })).text).toContain("Cancelled");
		expect(host.scheduleRows.map(row => row.id)).toEqual(["user0001"]);
		expect((await service.run("main0001", T.schedule, { action: "cancel", id: "nope0000" })).text).toMatch(
			/No scheduled run/,
		);
	});

	it("creates once and event starts: a follow-up in N minutes, a webhook with its key, a git trigger in the caller's repo", async () => {
		const host = new FakeHost({ tabId: "main0001", cwd: "/repo" });
		host.manage = true;
		const service = control(host);
		const before = Date.now();
		await service.run("main0001", T.schedule, { action: "create", name: "f", prompt: "p", in_minutes: 30 });
		const once = host.savedDrafts[0]?.frequency;
		expect(once?.kind).toBe("once");
		const at = once?.kind === "once" ? Date.parse(once.at) : 0;
		expect(at).toBeGreaterThanOrEqual(before + 30 * 60_000);
		// The core reads its own clock: on Windows it may run a tick (about 16 ms) ahead of this process's.
		expect(at).toBeLessThan(Date.now() + 30 * 60_000 + 50);
		await service.run("main0001", T.schedule, {
			action: "create",
			name: "h",
			prompt: "p",
			on: { source: "webhook" },
		});
		// The service makes the key: the tool asks for one with an empty key.
		expect(host.savedDrafts[1]?.frequency).toEqual({ kind: "event", event: { source: "webhook", key: "" } });
		await service.run("main0001", T.schedule, {
			action: "create",
			name: "g",
			prompt: "p",
			on: { source: "git", branch: "main" },
		});
		expect(host.savedDrafts[2]?.frequency).toEqual({
			kind: "event",
			event: { source: "git", repo: "/repo", branch: "main" },
		});
		host.scheduleRows[1] = {
			...(host.scheduleRows[1] as ScheduleRow),
			frequency: { kind: "event", event: { source: "webhook", key: "k".repeat(32) } },
		};
		const listed = await service.run("main0001", T.schedule, { action: "list" });
		expect(listed.text).toContain("on a webhook call in /repo; waits for its event");
	});

	it("pauses, resumes, tests, updates and reads the runs of the agent's own; the user's own only its runs", async () => {
		const host = new FakeHost({ tabId: "main0001", cwd: "/repo" });
		host.manage = true;
		host.scheduleRows.push({
			id: "user0001",
			name: "Weekly report",
			frequency: { kind: "daily", time: "08:00", days: [] },
			cwd: "/work",
			enabled: true,
			nextRun: null,
			lastStatus: null,
		});
		const service = control(host);
		await service.run("main0001", T.schedule, { action: "create", name: "mine", prompt: "p", every_minutes: 45 });
		const own = host.scheduleRows[1] as ScheduleRow;
		expect((await service.run("main0001", T.schedule, { action: "pause", id: own.id })).text).toBe(
			`Paused “[agent] mine” on this computer; off.`,
		);
		expect((await service.run("main0001", T.schedule, { action: "resume", id: own.id })).text).toContain("Resumed");
		expect((await service.run("main0001", T.schedule, { action: "run", id: own.id })).text).toContain(
			"Started a test run",
		);
		expect(host.ranNow).toEqual([own.id]);
		const updated = await service.run("main0001", T.schedule, {
			action: "update",
			id: own.id,
			prompt: "new prompt",
			on: { source: "session", events: ["failed"], folder: "repo" },
		});
		expect(updated.text).toContain("when a session fails a turn in a folder containing repo; waits for its event");
		expect(host.updatedDrafts[0]).toMatchObject({
			name: "[agent] mine",
			prompt: "new prompt",
			frequency: { kind: "event", event: { source: "session", events: ["failed"], folder: "repo" } },
		});
		host.scheduleRuns.push(
			{
				id: "r2",
				scheduleId: own.id,
				trigger: "event",
				startedAt: "2026-10-31T10:00:00.000Z",
				endedAt: "2026-10-31T10:01:00.000Z",
				status: "failed",
				exitCode: null,
				error: "The turn ended with an error",
				detail: 'Session "x" failed its turn',
			},
			{
				id: "r1",
				scheduleId: own.id,
				trigger: "manual",
				startedAt: "2026-10-31T09:00:00.000Z",
				endedAt: "2026-10-31T09:01:00.000Z",
				status: "succeeded",
				exitCode: 0,
				error: null,
			},
		);
		const runs = (await service.run("main0001", T.schedule, { action: "runs", id: own.id })).text;
		expect(runs).toContain(
			'- 2026-10-31T10:00:00.000Z failed (event) ended 2026-10-31T10:01:00.000Z — reason: The turn ended with an error — fired by: Session "x" failed its turn',
		);
		expect(runs).toContain("- 2026-10-31T09:00:00.000Z succeeded (test)");
		// The user's own: its runs can be read, nothing else.
		expect((await service.run("main0001", T.schedule, { action: "runs", id: "user0001" })).text).toContain(
			"has not run yet",
		);
		for (const action of ["pause", "resume", "run", "update"])
			expect((await service.run("main0001", T.schedule, { action, id: "user0001" })).text).toMatch(
				/the user's own schedule/,
			);
	});

	it("says so when there is no Schedules service", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		host.scheduleService = null;
		expect((await control(host).run("main0001", T.schedule, { action: "list" })).text).toMatch(/not available/);
	});

	it("works on the device the caller runs on by default, and on any paired device it names", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", cwd: "/repo" },
			{ tabId: "remo0002", device: "studio-id", deviceName: "Studio", cwd: "C:\\Users\\kim\\app" },
		);
		host.deviceList = [
			{ id: "studio-id", name: "Studio", state: "online" },
			{ id: "pc-id", name: "PC", state: "offline" },
		];
		host.manage = true;
		const service = control(host);
		const base = { action: "create", name: "n", prompt: "p", every_minutes: 60 };

		// A session on a paired host schedules on that host, in its own folder: no "this computer only" refusal.
		const remote = await service.run("remo0002", T.schedule, base);
		expect(remote.isError).toBe(false);
		expect(remote.text).toContain("in C:\\Users\\kim\\app on Studio");
		// Every request of the create went to that device (the service asks the Schedules service more than once).
		expect(new Set(host.scheduleDevices)).toEqual(new Set(["studio-id"]));
		expect(host.savedDrafts[0]).toMatchObject({ cwd: "C:\\Users\\kim\\app", autoApprove: false, name: "[agent] n" });

		// A local caller names the host; its own folder is not a path there.
		expect((await service.run("main0001", T.schedule, { ...base, device: "Studio" })).text).toMatch(
			/folder is required/,
		);
		const named = await service.run("main0001", T.schedule, { ...base, device: "studio", folder: "/srv/app" });
		expect(named.text).toContain("in /srv/app on Studio");
		expect(host.scheduleDevices.at(-1)).toBe("studio-id");

		const listed = await service.run("main0001", T.schedule, { action: "list", device: "Studio" });
		expect(listed.text.split("\n")[0]).toBe("Scheduled runs on Studio:");
		expect(host.scheduleDevices.at(-1)).toBe("studio-id");

		const own = host.scheduleRows[0] as ScheduleRow;
		const cancelled = await service.run("main0001", T.schedule, { action: "cancel", id: own.id, device: "Studio" });
		expect(cancelled.text).toBe(`Cancelled “${own.name}” on Studio.`);
		expect(host.scheduleDevices.at(-1)).toBe("studio-id");

		// "local" from the paired session: this computer, whose folder it has to name.
		expect((await service.run("remo0002", T.schedule, { ...base, device: "local" })).text).toMatch(
			/folder is required: name an absolute folder on this computer/,
		);
		expect(host.scheduleDevices.at(-1)).toBeUndefined();
		const offline = await shortWaits(() => service.run("main0001", T.schedule, { action: "list", device: "PC" }));
		expect(offline.isError).toBe(true);
		expect(offline.text).toMatch(/PC is offline/);
	});

	it("with target self wakes the caller's own session: its file is the draft's wakeSession, in its own folder, after the card", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss", cwd: "/work", sessionPath: "/s/self.jsonl" });
		const service = control(host);
		const made = await service.run("main0001", T.schedule, {
			action: "create",
			target: "self",
			name: "check the build",
			prompt: "Look at the build and tell the owner if it failed",
			every_minutes: 30,
		});
		expect(made.isError).toBe(false);
		expect(made.text).toContain("it wakes this session with the prompt");
		expect(made.text).toContain('ompdesk_schedule {"action":"cancel","id":"sched1000"}');
		expect(host.cards).toHaveLength(1);
		expect(host.savedDrafts[0]).toMatchObject({
			name: "[agent] check the build",
			prompt: "Look at the build and tell the owner if it failed",
			cwd: "/work",
			frequency: { kind: "interval", minutes: 30 },
			model: null,
			autoApprove: false,
			enabled: true,
			wakeSession: "/s/self.jsonl",
		});
		// A plain create has no wake target.
		await service.run("main0001", T.schedule, { action: "create", name: "n", prompt: "p", every_minutes: 60 });
		expect(host.savedDrafts[1]).not.toHaveProperty("wakeSession");
		expect(host.scheduleDevices.every(device => device === undefined)).toBe(true);
		// The agent that made it can cancel it like any agent-made schedule, and the list says it wakes a session.
		host.scheduleRows[0] = { ...(host.scheduleRows[0] as ScheduleRow), wakes: true };
		expect((await service.run("main0001", T.schedule, { action: "list" })).text).toContain("; wakes a session");
		expect((await service.run("main0001", T.schedule, { action: "cancel", id: "sched1000" })).text).toContain(
			"Cancelled “[agent] check the build”",
		);
	});

	it("with target self refuses a folder, a model or a device, a session with no file, and a session on a paired device", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", cwd: "/work", sessionPath: "/s/self.jsonl" },
			{ tabId: "bare0002", cwd: "/work" },
			{ tabId: "remo0003", device: "studio-id", deviceName: "Studio", cwd: "/srv", sessionPath: "/s/remote.jsonl" },
		);
		host.deviceList = [{ id: "studio-id", name: "Studio", state: "online" }];
		host.manage = true;
		const service = control(host);
		const base = { action: "create", target: "self", name: "n", prompt: "p", every_minutes: 30 };
		for (const extra of [{ folder: "/x" }, { model: "a/b" }, { device: "Studio" }]) {
			const refused = await service.run("main0001", T.schedule, { ...base, ...extra });
			expect(refused.isError).toBe(true);
			expect(refused.text).toContain("target self wakes this session");
		}
		expect((await service.run("bare0002", T.schedule, base)).text).toContain("no saved file yet");
		expect((await service.run("remo0003", T.schedule, base)).text).toContain(
			"a session wakes itself only on the computer it runs on",
		);
		expect(host.savedDrafts).toEqual([]);
		expect((await service.run("main0001", T.schedule, { ...base, target: "other" })).isError).toBe(true);
	});
});

describe("a table of several finished sessions", () => {
	it("is only the table: ai-memory's own tools keep lessons, not an OMPdesk tool", async () => {
		const host = new FakeHost(
			{ tabId: "main0001" },
			{ tabId: "work0002", last: "a" },
			{ tabId: "work0003", last: "b" },
		);
		const result = await control(host).run("main0001", T.result, { sessions: ["work0002", "work0003"] });
		expect(result.text).not.toContain("save one lesson");
	});
});

describe("ompdesk_autopilot", () => {
	const runStatus = (over: Partial<AutopilotStatus> = {}): AutopilotStatus => ({
		active: true,
		role: "parent",
		state: "running",
		cycle: 3,
		branch: "autopilot/2026-10-18",
		baseBranch: "main",
		root: "/wt/ap",
		now: { n: 3, area: "tests", title: "Cover the parser", startedAt: 1 },
		redStreak: 1,
		cycles: [
			{ n: 1, area: "bugs", title: "Fix crash", verify: "green", commit: "abcdef1234567" },
		] as AutopilotStatus["cycles"],
		ship: {
			policy: { autoPush: true, autoRelease: { on: false, cadence: { kind: "agent" } }, remote: "origin" },
			queue: [{ id: "s1", kind: "push", state: "done", sha: "1234567890abc", at: 1 }],
			release: { version: "1.2.3", state: "success", runUrl: "https://example.test/run/1" },
		},
		...over,
	});

	class Pilot implements AutopilotSource {
		starts: { caller: string; source: string; options: AutopilotStartOptions }[] = [];
		stops: { tab: string; now: boolean }[] = [];
		statuses = new Map<string, AutopilotStatus>();
		defaultBranch: string | null = "main";
		failStart: string | null = null;
		n = 0;
		constructor(readonly host: FakeHost) {}
		plan = async () => ({ defaultBranch: this.defaultBranch });
		start = async (caller: string, source: string, options: AutopilotStartOptions) => {
			if (this.failStart) throw new Error(this.failStart);
			this.starts.push({ caller, source, options });
			const tab = this.host.add({ tabId: `apr${++this.n}0000`, cwd: "/wt/ap", title: "Autopilot" });
			this.statuses.set(tab.tabId, runStatus());
			return { ...runStatus(), tabId: tab.tabId };
		};
		status = async (tabId: string) => this.statuses.get(tabId) ?? { active: false };
		stop = async (tab: string, now: boolean) => {
			this.stops.push({ tab, now });
			const next = runStatus({ state: now ? "paused" : "stopping" });
			this.statuses.set(tab, next);
			return next;
		};
	}

	function setup(...extra: Partial<FakeTab>[]) {
		const host = new FakeHost({ tabId: "main0001", title: "Boss", cwd: "/repo" }, ...extra);
		const pilot = new Pilot(host);
		host.autopilot = pilot;
		return { host, pilot, service: control(host) };
	}

	it("raises one card when manage is off and starts through the coordinator from the caller's own tab", async () => {
		const { host, pilot, service } = setup();
		const result = await service.run("main0001", T.autopilot, { action: "start" });
		expect(result.isError).toBe(false);
		expect(host.cards).toHaveLength(1);
		// An omitted level is named: commits only.
		expect(pilot.starts).toEqual([{ caller: "main0001", source: "main0001", options: { preset: "local" } }]);
		expect(result.text).toContain("Started Autopilot in session apr10000");
		expect(result.text).toContain("cycle 3");
	});

	it("asks nothing with manage on, but always for release and for the default branch", async () => {
		const { host, pilot, service } = setup();
		host.manage = true;
		expect((await service.run("main0001", T.autopilot, { action: "start", ship: "push" })).isError).toBe(false);
		expect(host.cards).toHaveLength(0);
		await service.run("main0001", T.autopilot, { action: "start", ship: "release" });
		expect(host.cards).toHaveLength(1);
		await service.run("main0001", T.autopilot, { action: "start", branch: { kind: "existing", name: "trunk" } });
		expect(host.cards).toHaveLength(1);
		pilot.defaultBranch = "trunk";
		await service.run("main0001", T.autopilot, { action: "start", branch: { kind: "existing", name: "trunk" } });
		expect(host.cards).toHaveLength(2);
		await service.run("main0001", T.autopilot, { action: "start", branch: { kind: "existing", name: "main" } });
		expect(host.cards).toHaveLength(3);
	});

	it("asks nothing for release or the default branch while agents have full control", async () => {
		const { host, pilot, service } = setup();
		host.full = true;
		await service.run("main0001", T.autopilot, { action: "start", ship: "release" });
		await service.run("main0001", T.autopilot, { action: "start", branch: { kind: "existing", name: "main" } });
		expect(host.cards).toHaveLength(0);
		expect(pilot.starts).toHaveLength(2);
	});

	it("does nothing when the user declines the card", async () => {
		const { host, pilot, service } = setup();
		host.cardAnswer = false;
		const result = await service.run("main0001", T.autopilot, { action: "start" });
		expect(result.text).toMatch(/declined/);
		expect(pilot.starts).toHaveLength(0);
		host.cardAnswer = true;
		for (let i = 0; i < 2; i++)
			expect((await service.run("main0001", T.autopilot, { action: "start" })).isError).toBe(false);
	});

	it("maps the parameters onto the start options and leaves omitted ones out", async () => {
		const { host, pilot, service } = setup();
		host.manage = true;
		const result = await service.run("main0001", T.autopilot, {
			action: "start",
			guide: "# Guide",
			ship: "release",
			branch: { kind: "new", name: "autopilot/night" },
			advanced: {
				focus: ["tests", "docs"],
				cadence: 4,
				remote: "upstream",
				limits: { cycles: 10, usd: 5 },
			},
		});
		expect(result.isError).toBe(false);
		expect(pilot.starts[0]?.options).toEqual({
			preset: "release",
			ship: { remote: "upstream", autoRelease: { on: true, cadence: { kind: "every", n: 4 } } },
			guide: "# Guide",
			branch: { kind: "new", name: "autopilot/night" },
			focus: ["tests", "docs"],
			limits: { cycles: 10, usd: 5 },
		});
		const bad = await service.run("main0001", T.autopilot, { action: "start", advanced: { cadence: 4 } });
		expect(bad.text).toMatch(/cadence goes with ship release/);
	});

	it("starts from another tab of the folder's own computer, and refuses a folder nothing there has open", async () => {
		const { host, pilot, service } = setup(
			{ tabId: "other002", cwd: "/other" },
			{ tabId: "remote03", cwd: "/far", device: "dev1", deviceName: "Mac" },
		);
		host.manage = true;
		await service.run("main0001", T.autopilot, { action: "start", folder: "/other/" });
		expect(pilot.starts[0]?.source).toBe("other002");
		const none = await service.run("main0001", T.autopilot, { action: "start", folder: "/nowhere" });
		expect(none.isError).toBe(true);
		expect(none.text).toMatch(/not open in a session/);
		// A paired host's folder is that computer's: without `device` it is not this computer's.
		expect((await service.run("main0001", T.autopilot, { action: "start", folder: "/far" })).isError).toBe(true);
		expect((await service.run("main0001", T.autopilot, { action: "start", folder: "relative" })).text).toMatch(
			/absolute/,
		);
		expect(pilot.starts).toHaveLength(1);
	});

	it("starts on a paired device's folder from a tab there, or from a tab it opens there and closes again", async () => {
		const { host, pilot, service } = setup({ tabId: "remote03", cwd: "/far", device: "dev1", deviceName: "Mac" });
		host.manage = true;
		host.deviceList = [{ id: "dev1", name: "Mac", state: "online" }];
		const there = await service.run("main0001", T.autopilot, { action: "start", device: "Mac", folder: "/far" });
		expect(there.isError, there.text).toBe(false);
		expect(pilot.starts[0]?.source).toBe("remote03");
		expect(host.spawned).toHaveLength(0);

		const fresh = await service.run("main0001", T.autopilot, {
			action: "start",
			device: "dev1",
			folder: "C:\\work\\app",
		});
		expect(fresh.isError, fresh.text).toBe(false);
		expect(host.spawned).toEqual([{ folder: "C:\\work\\app", device: "dev1" }]);
		const opened = pilot.starts[1]?.source as string;
		expect(opened).not.toBe("remote03");
		// The tab it opened only to start from closes; the run stays the caller's.
		expect(host.views).toContainEqual({ tabId: opened, how: "close" });
		expect(await service.childrenOf("main0001")).toEqual(["apr10000", "apr20000"]);

		host.deviceList = [{ id: "dev1", name: "Mac", state: "offline" }];
		const away = await shortWaits(() =>
			service.run("main0001", T.autopilot, { action: "start", device: "Mac", folder: "/far" }),
		);
		expect(away.text).toMatch(/offline/);
		expect(pilot.starts).toHaveLength(2);
	});

	it("releases the tab it opened to start from in main when that tab belongs to a paired web page", async () => {
		const { host, pilot, service } = setup();
		host.manage = true;
		host.deviceList = [{ id: "dev1", name: "Mac", state: "online" }];
		host.spawnPatch = { webEdits: "unreported" };
		const fresh = await service.run("main0001", T.autopilot, { action: "start", device: "dev1", folder: "/far" });
		expect(fresh.isError, fresh.text).toBe(false);
		const opened = pilot.starts[0]?.source as string;
		await vi.waitFor(() => expect(host.releases).toEqual([opened]), { timeout: 5_000 });
		expect(host.views).not.toContainEqual({ tabId: opened, how: "close" });
	});

	it("starts as many agent runs as asked", async () => {
		const { host, pilot, service } = setup();
		host.manage = true;
		for (let i = 0; i < 4; i++)
			expect((await service.run("main0001", T.autopilot, { action: "start" })).isError).toBe(false);
		expect(pilot.starts).toHaveLength(4);
	});

	it("reports a failed start's readable reason, and a later start still goes", async () => {
		const { host, pilot, service } = setup();
		host.manage = true;
		pilot.failStart = "This folder is not a git repository.";
		for (let i = 0; i < 3; i++) {
			const failed = await service.run("main0001", T.autopilot, { action: "start" });
			expect(failed.isError).toBe(true);
			expect(failed.text).toContain("not a git repository");
		}
		pilot.failStart = null;
		expect((await service.run("main0001", T.autopilot, { action: "start" })).isError).toBe(false);
	});

	it("starts from a caller on a paired host in its own folder there, and refuses a run that is stopping", async () => {
		const { host, pilot, service } = setup({ tabId: "paired04", device: "dev1", deviceName: "Mac", cwd: "/repo" });
		host.manage = true;
		const result = await service.run("paired04", T.autopilot, { action: "start" });
		expect(result.isError, result.text).toBe(false);
		expect(pilot.starts[0]?.source).toBe("paired04");
		host.stopping.add("main0001");
		expect((await service.run("main0001", T.autopilot, { action: "start" })).text).toMatch(/ending/);
	});

	it("shapes the status: state, cycle, current item, red streak, last commit, push and release", async () => {
		const { host, service } = setup();
		host.manage = true;
		await service.run("main0001", T.autopilot, { action: "start" });
		const status = await service.run("main0001", T.autopilot, { action: "status", session: "apr10000" });
		expect(status.isError).toBe(false);
		for (const part of [
			"running; cycle 3",
			'now: cycle 3 [tests] "Cover the parser"',
			"red streak 1",
			"last commit abcdef123 (cycle 1",
			"last push done 123456789",
			"last release 1.2.3 success https://example.test/run/1",
			"ship level push",
		])
			expect(status.text).toContain(part);
	});

	it("reads a paused run's reason and refuses a session that is no run", async () => {
		const { host, pilot, service } = setup({ tabId: "plain005", cwd: "/x" });
		host.manage = true;
		await service.run("main0001", T.autopilot, { action: "start" });
		pilot.statuses.set(
			"apr10000",
			runStatus({ state: "paused", reason: "cycles", detail: "10 cycles done", now: undefined }),
		);
		const paused = await service.run("main0001", T.autopilot, { action: "status", session: "apr10000" });
		expect(paused.text).toContain("paused (cycles: 10 cycles done)");
		expect(paused.text).toContain("now: between cycles");
		expect(paused.text).toContain("resumes it");
		const plain = await service.run("main0001", T.autopilot, { action: "status", session: "plain005" });
		expect(plain.isError).toBe(true);
		expect(plain.text).toMatch(/not an Autopilot run/);
	});

	it("stops the end way by default and aborts with now, without a card for a run the caller started", async () => {
		const { host, pilot, service } = setup();
		host.manage = true;
		await service.run("main0001", T.autopilot, { action: "start" });
		host.manage = false;
		const ended = await service.run("main0001", T.autopilot, { action: "stop", session: "apr10000" });
		expect(ended.text).toContain("Ending: it finishes the cycle in flight");
		pilot.statuses.set("apr10000", runStatus());
		const now = await service.run("main0001", T.autopilot, { action: "stop", session: "apr10000", now: true });
		expect(now.text).toContain("Stopped now");
		expect(pilot.stops).toEqual([
			{ tab: "apr10000", now: false },
			{ tab: "apr10000", now: true },
		]);
		expect(host.cards).toHaveLength(0);
	});

	it("needs the manage setting to read another run and a card to stop it", async () => {
		const { host, pilot, service } = setup({ tabId: "user0006", cwd: "/u", title: "User run" });
		pilot.statuses.set("user0006", runStatus());
		const read = await service.run("main0001", T.autopilot, { action: "status", session: "user0006" });
		expect(read.isError).toBe(true);
		expect(read.text).toMatch(/manage other sessions/);
		host.cardAnswer = false;
		const declined = await service.run("main0001", T.autopilot, { action: "stop", session: "user0006" });
		expect(declined.text).toMatch(/declined/);
		expect(pilot.stops).toHaveLength(0);
		host.cardAnswer = true;
		await service.run("main0001", T.autopilot, { action: "stop", session: "user0006" });
		expect(host.cards).toHaveLength(2);
		expect(pilot.stops).toEqual([{ tab: "user0006", now: false }]);
		host.manage = true;
		pilot.statuses.set("user0006", runStatus());
		expect((await service.run("main0001", T.autopilot, { action: "status", session: "user0006" })).isError).toBe(
			false,
		);
	});

	it("counts the run among the sessions the caller opened (result, stop and compare see it)", async () => {
		const { host, service } = setup();
		host.manage = true;
		await service.run("main0001", T.autopilot, { action: "start" });
		expect(await service.childrenOf("main0001")).toEqual(["apr10000"]);
	});
});

describe("autoClose: opened sessions whose work landed", () => {
	/** The caller opens one session; its tab then reads as a finished, agent-opened child with a stored file. */
	async function finishedChild(options: { worktree?: boolean; throwaway?: boolean; patch?: Partial<FakeTab> } = {}) {
		const host = new FakeHost({ tabId: "main0001", title: "Boss", sessionPath: "/s/boss.jsonl" });
		const service = control(host);
		await service.run("main0001", T.open, {
			message: "do it",
			...(options.worktree ? { worktree: true } : {}),
			...(options.throwaway ? { throwaway: true } : {}),
		});
		const child = [...host.tabsById.values()].find(tab => tab.tabId !== "main0001") as FakeTab;
		Object.assign(child, {
			busy: false,
			title: "Fix the parser",
			sessionPath: "/s/kid.jsonl",
			autoClosable: true,
			lastRun: { stopReason: "stop" },
			last: "Done: parser fixed.\nResult: ok",
			model: { provider: "openai", id: "gpt-z" },
			cost: 0.42,
			...options.patch,
		});
		return { host, service, child };
	}

	const closes = (host: FakeHost) => host.views.filter(view => view.how === "close");

	it("closes a finished session without a branch, records it under its opener and keeps the file", async () => {
		const { host, service, child } = await finishedChild();
		await service.autoClose("main0001");
		expect(host.views).toContainEqual({ tabId: child.tabId, how: "close", auto: true });
		expect(host.closedRecords).toEqual([
			{
				path: "/s/kid.jsonl",
				openedBySession: "/s/boss.jsonl",
				title: "Fix the parser",
				cwd: "/repo",
				tabIds: [child.tabId],
				closedAt: expect.any(Number),
				model: "openai/gpt-z",
				cost: 0.42,
			},
		]);
		expect(host.deleted).toEqual([]);
		expect(host.removed).toEqual([]);
	});

	describe("a throwaway child", () => {
		it("closes and deletes its saved session once its done report reached the opener, and tells the opener", async () => {
			const { host, service, child } = await finishedChild({ throwaway: true });
			// The pass that sends its done report leaves it: the opener reads the report in its next turn.
			await service.autoClose("main0001");
			expect(host.mails.filter(mail => mail.to === "main0001")).toHaveLength(1);
			expect(closes(host)).toHaveLength(0);
			expect(host.deletedStored).toEqual([]);
			await service.autoClose("main0001");
			expect(closes(host)).toEqual([{ tabId: child.tabId, how: "close", auto: true }]);
			expect(host.deletedStored).toEqual([{ path: "/s/kid.jsonl", device: undefined }]);
			expect(host.closedRecords).toEqual([]);
			const note = host.mails.filter(mail => mail.to === "main0001").at(-1);
			expect(note?.content).toContain("Deleted");
			expect(note?.delivery).toEqual({ triggerTurn: false });
		});

		it("deletes one on a paired device on that device, worktree and all once it landed", async () => {
			const { host, service } = await finishedChild({
				throwaway: true,
				worktree: true,
				patch: { device: desktop.id, deviceName: desktop.name },
			});
			host.landings.set("omp/agent/w", { hasWork: true, landed: true, clean: true });
			await service.autoClose("main0001");
			await service.autoClose("main0001");
			expect(host.removed).toEqual(["omp/agent/w"]);
			expect(host.deletedStored).toEqual([{ path: "/s/kid.jsonl", device: desktop.id }]);
		});

		it("keeps a problem, one the person reopened, and one whose worktree git kept", async () => {
			const problem = await finishedChild({
				throwaway: true,
				patch: { last: "Two tests fail.\nResult: problem — two tests fail" },
			});
			await problem.service.autoClose("main0001");
			await problem.service.autoClose("main0001");
			expect(closes(problem.host)).toHaveLength(1);
			expect(problem.host.deletedStored).toEqual([]);
			expect(problem.host.closedRecords).toHaveLength(1);

			const reopened = await finishedChild({ throwaway: true });
			await reopened.service.autoClose("main0001");
			reopened.host.view = (_caller, event) => {
				reopened.host.views.push(event);
				reopened.host.tabsById.delete(event.tabId);
				reopened.host.add({ tabId: "back0003", sessionPath: "/s/kid.jsonl" });
			};
			await reopened.service.autoClose("main0001");
			expect(closes(reopened.host)).toHaveLength(1);
			expect(reopened.host.deletedStored).toEqual([]);
			expect(reopened.host.closedRecords).toHaveLength(1);

			const kept = await finishedChild({ throwaway: true, worktree: true });
			kept.host.landings.set("omp/agent/w", { hasWork: true, landed: true, clean: true });
			kept.host.removeSafeWorktree = async () => {
				throw new Error("in use");
			};
			await kept.service.autoClose("main0001");
			await kept.service.autoClose("main0001");
			expect(closes(kept.host)).toHaveLength(1);
			expect(kept.host.deletedStored).toEqual([]);
		});

		it("is refused with reopen", async () => {
			const host = new FakeHost({ tabId: "main0001", title: "Boss" });
			const result = await control(host).run("main0001", T.open, { reopen: "11111111-aaaa", throwaway: true });
			expect(result.isError).toBe(true);
			expect(result.text).toContain("throwaway");
			expect(host.spawned).toEqual([]);
		});
	});

	it("lets the opener read and delete a closed child by the id it was given, with no card", async () => {
		const { host, service, child } = await finishedChild();
		host.storedTranscripts.set("/s/kid.jsonl", [{ role: "assistant", content: "the whole table" } as AgentMessage]);
		await service.autoClose("main0001");
		expect(host.tabsById.has(child.tabId)).toBe(false);
		const read = await service.run("main0001", T.read, { session: child.tabId });
		expect(read.isError).toBe(false);
		expect(read.text).toContain("the whole table");
		const deleted = await service.run("main0001", T.stop, { session: child.tabId, delete: true });
		expect(deleted.isError).toBe(false);
		expect(host.cards).toEqual([]);
		expect(host.deletedStored).toEqual([{ path: "/s/kid.jsonl", device: undefined }]);
		// Gone for good: the id names nothing any more.
		expect((await service.run("main0001", T.read, { session: child.tabId })).isError).toBe(true);
	});

	it("treats a plan awaiting approval as waiting: listed, a wait returns, no auto-close, no review", async () => {
		const plan = { title: "Share over Tailscale", planFilePath: "local://PLAN.md" };
		const { host, service, child } = await finishedChild({
			worktree: true,
			patch: { plan, lastRun: { stopReason: "aborted" }, last: "Plan written." },
		});
		const listed = await service.run("main0001", T.list, { status: "waiting" });
		expect(listed.text).toContain(child.tabId);
		expect(listed.text).toContain('waiting for plan approval: "Share over Tailscale" (local://PLAN.md)');
		const waited = await service.run("main0001", T.result, { session: child.tabId, wait: true });
		expect(waited.text).toMatch(/needs an answer/);
		await service.autoClose("main0001");
		expect(closes(host)).toHaveLength(0);
		const [item] = await service.reviewItems("main0001");
		expect(item).toMatchObject({ state: "running", waiting: true });
		expect(item?.failed).toBeUndefined();
	});

	it("asks a child that ended its turn without a verdict or report to report once, then tells its opener once", async () => {
		const { host, service, child } = await finishedChild({ patch: { last: "Looked at the parser." } });
		await service.autoClose("main0001");
		const toChild = host.mails.filter(mail => mail.to === child.tabId);
		expect(toChild).toHaveLength(1);
		expect(toChild[0]?.content).toContain("Report where it stands now with ompdesk_report");
		expect(toChild[0]?.delivery).toEqual({ triggerTurn: true, deliverAs: "aside" });
		// The sweep again before its next turn changes nothing.
		await service.autoClose("main0001");
		expect(host.mails.filter(mail => mail.to === child.tabId)).toHaveLength(1);
		expect(host.mails.filter(mail => mail.to === "main0001")).toHaveLength(0);

		// Its next turn still says nothing, word for word the same: the opener hears of it, once, without a turn.
		child.busy = true;
		await service.autoClose("main0001");
		child.busy = false;
		await service.autoClose("main0001");
		await service.autoClose("main0001");
		const toOpener = host.mails.filter(mail => mail.to === "main0001");
		expect(toOpener).toHaveLength(1);
		expect(toOpener[0]?.content).toContain("ended its turn again without a verdict line or a report");
		expect(toOpener[0]?.delivery).toEqual({ triggerTurn: false });
		expect(closes(host)).toHaveLength(0);
	});

	it("never asks a child that reported done, failed, or that the person typed into", async () => {
		for (const patch of [
			{ last: "Done.", lastRun: { stopReason: "aborted" } },
			{ last: "Done.", userTouched: true },
		] as Partial<FakeTab>[]) {
			const { host, service, child } = await finishedChild({ patch });
			await service.autoClose("main0001");
			expect(host.mails.filter(mail => mail.to === child.tabId)).toHaveLength(0);
		}
		const { host, service, child } = await finishedChild({ patch: { last: "Done." } });
		await service.run(child.tabId, T.report, { kind: "done", text: "finished" });
		const before = host.mails.length;
		await service.autoClose("main0001");
		expect(host.mails.slice(before).filter(mail => mail.to === child.tabId)).toHaveLength(0);
	});

	describe("the pace of a session", () => {
		const slow = {
			wallS: 1320,
			toolS: 120,
			modelS: 1200,
			idleS: 0,
			modelCalls: 156,
			outputTokens: 0,
			tools: { bash: { seconds: 120, calls: 60, errors: 6 } },
			thinkGaps: [4, 4, 4],
			polls: 0,
		} satisfies Pace;
		const LINE = "Pace: wall 22 min";
		const SHORT = "pace 22 min, 156 calls, median 4.0 s";

		it("ends the auto done report the opener receives with the Pace line", async () => {
			const { host, service } = await finishedChild({ patch: { last: "Parser fixed in a.ts.\nResult: ok" } });
			host.paces.set("/s/kid.jsonl", slow);
			await service.autoClose("main0001");
			const [mail] = host.mails.filter(entry => entry.to === "main0001");
			expect(mail?.content).toContain(LINE);
			expect(mail?.details).toMatchObject({ text: expect.stringMatching(/\n\nPace: wall 22 min[^\n]*$/) });
		});

		it("ends a child's own done report with it and keeps the mail id when only the pace differs", async () => {
			const { host, service, child } = await finishedChild();
			host.paces.set("/s/kid.jsonl", slow);
			const first = await service.run(child.tabId, T.report, { kind: "done", text: "finished" });
			expect(first.text).toBe("Delivered.");
			expect(host.mails.at(-1)?.content).toContain(LINE);
			host.paces.set("/s/kid.jsonl", { ...slow, wallS: 3000, modelS: 2800, modelCalls: 300 });
			const again = await service.run(child.tabId, T.report, { kind: "done", text: "finished" });
			expect(again.text).toContain("was already delivered");
		});

		it("shows a short pace on the open row and in the session result, before the last answer", async () => {
			const { host, service, child } = await finishedChild();
			host.paces.set("/s/kid.jsonl", slow);
			expect((await service.run("main0001", T.list, { mine: true })).text).toContain(SHORT);
			const result = (await service.run("main0001", T.result, { session: child.tabId })).text;
			expect(result).toMatch(/pace 22 min, 156 calls, median 4\.0 s[^\n]*\nLast answer:/);
		});

		it("asks for a stored row's pace with its device and shows it, in the list and the result", async () => {
			const host = new FakeHost({ tabId: "main0001", title: "Boss" });
			host.deviceList = [desktop];
			host.storedRows = [
				storedRow({ id: "33333333-cccc", path: "C:/s/three.jsonl", title: "PC refactor", device: desktop.id }),
			];
			host.paces.set("C:/s/three.jsonl", slow);
			const asked: { path: string; device?: string }[] = [];
			const read = host.sessionPace;
			host.sessionPace = async row => {
				asked.push(row);
				return read(row);
			};
			const service = control(host);
			const listed = (await service.run("main0001", T.list, { scope: "stored", device: desktop.id })).text;
			expect(listed).toMatch(new RegExp(`folder [^\\n]*; ${SHORT}`));
			expect(asked[0]).toEqual({ path: "C:/s/three.jsonl", device: desktop.id });
			const result = (await service.run("main0001", T.result, { session: "33333333-cccc" })).text;
			expect(result).toMatch(/pace 22 min, 156 calls, median 4\.0 s[^\n]*\nLast answer:/);
		});

		it("leaves the report and the rows without a line when the pace cannot be read", async () => {
			const { host, service, child } = await finishedChild();
			host.sessionPace = async () => {
				throw new Error("link down");
			};
			const sent = await service.run(child.tabId, T.report, { kind: "done", text: "finished" });
			expect(sent.text).toBe("Delivered.");
			expect(host.mails.at(-1)?.content).not.toContain("Pace:");
			expect((await service.run("main0001", T.list, { mine: true })).text).not.toContain("pace ");
			expect((await service.run("main0001", T.result, { session: child.tabId })).text).not.toContain("pace ");
		});
	});

	describe("the done report main sends for a child", () => {
		it("sends the opener one done mail with the final answer when the child ended with a verdict and reported nothing", async () => {
			const { host, service } = await finishedChild({ patch: { last: "Parser fixed in a.ts.\nResult: ok" } });
			await service.autoClose("main0001");
			await service.autoClose("main0001");
			const toOpener = host.mails.filter(mail => mail.to === "main0001");
			expect(toOpener).toHaveLength(1);
			expect(toOpener[0]?.content).toContain("Parser fixed in a.ts.");
			expect(toOpener[0]?.content).toContain("done");
			expect(toOpener[0]?.delivery).toEqual({ triggerTurn: true, deliverAs: "aside" });
		});

		it("sends exactly one when the child reported done itself", async () => {
			const { host, service, child } = await finishedChild();
			await service.run(child.tabId, T.report, { kind: "done", text: "finished", dispatch: "d1" });
			await service.autoClose("main0001");
			expect(host.mails.filter(mail => mail.to === "main0001")).toHaveLength(1);
		});

		it("still sends the done mail after a progress report or a note on the same dispatch", async () => {
			for (const kind of ["progress", "note"] as const) {
				const { host, service, child } = await finishedChild({
					patch: { last: "Parser fixed in a.ts.\nResult: ok" },
				});
				await service.run(child.tabId, T.report, { kind, text: "half way", dispatch: "d1" });
				await service.autoClose("main0001");
				const done = host.mails.filter(
					mail => mail.to === "main0001" && mail.content.includes("Parser fixed in a.ts."),
				);
				expect(done, kind).toHaveLength(1);
				expect(done[0]?.delivery, kind).toEqual({ triggerTurn: true, deliverAs: "aside" });
			}
		});

		it("keeps an unanswered question or blocker waiting, and sends the done once the opener answered and it finished", async () => {
			for (const kind of ["question", "blocked"] as const) {
				const { host, service, child } = await finishedChild({
					patch: { last: "Needs the opener's call on the schema.\nResult: problem — needs a decision" },
				});
				await service.run(child.tabId, T.report, { kind, text: "which schema?", dispatch: "d1" });
				await service.autoClose("main0001");
				expect(
					host.mails.filter(mail => mail.to === "main0001" && mail.content.includes("Result:")),
					kind,
				).toHaveLength(0);
				expect(closes(host), kind).toHaveLength(0);
				await service.run("main0001", T.send, { session: child.tabId, message: "use v2" });
				child.busy = true;
				await service.autoClose("main0001");
				child.busy = false;
				child.last = "Moved to schema v2.\nResult: ok";
				await service.autoClose("main0001");
				const done = host.mails.filter(
					mail => mail.to === "main0001" && mail.content.includes("Moved to schema v2."),
				);
				expect(done, kind).toHaveLength(1);
			}
		});

		it("sends none for a failed or stopped turn, or one the person typed into", async () => {
			for (const patch of [
				{ lastRun: { stopReason: "error" } },
				{ lastRun: { stopReason: "aborted" } },
				{ userTouched: true },
			] as Partial<FakeTab>[]) {
				const { host, service } = await finishedChild({ patch });
				await service.autoClose("main0001");
				expect(host.mails.filter(mail => mail.to === "main0001")).toHaveLength(0);
			}
		});

		it("gives the next dispatch its own report", async () => {
			const { host, service, child } = await finishedChild({ patch: { looked: true } });
			await service.autoClose("main0001");
			expect(host.mails.filter(mail => mail.to === "main0001")).toHaveLength(1);
			await service.run("main0001", T.send, { session: child.tabId, message: "and again" });
			child.busy = true;
			await service.autoClose("main0001");
			child.busy = false;
			child.last = "Second round.\nResult: ok";
			await service.autoClose("main0001");
			const toOpener = host.mails.filter(mail => mail.to === "main0001");
			expect(toOpener).toHaveLength(2);
			expect(toOpener[1]?.content).toContain("Second round.");
		});

		it("sends one for a child a relaunch restored once a turn of this launch ended, unless it reported that work itself", async () => {
			// Its cut-off turn went on after the relaunch (or it took a message): the opener's new tab hears it.
			const resumed = await finishedChild({
				patch: { restored: true, lastRun: { stopReason: "stop" }, last: "Titles combined.\nResult: ok" },
			});
			await resumed.service.autoClose("main0001");
			const done = resumed.host.mails.filter(
				mail => mail.to === "main0001" && mail.content.includes("Titles combined."),
			);
			expect(done).toHaveLength(1);
			expect(done[0]?.details.dispatch).toBe("d1");

			// Restored and not run this launch: its ending is from before, when main already told its opener.
			const asleep = await finishedChild({
				patch: { restored: true, status: "asleep", lastRun: undefined, last: undefined },
			});
			await asleep.service.autoClose("main0001");
			expect(asleep.host.mails.filter(mail => mail.to === "main0001")).toHaveLength(0);

			// Its own done report since its last prompt is in its journal: nothing more is sent.
			const reported = await finishedChild({
				patch: {
					restored: true,
					lastRun: { stopReason: "stop" },
					messages: [
						{ role: "user", content: [{ type: "text", text: wrapAgentMessage("fix it", "Boss") }] },
						{
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: "r1",
									name: "write",
									arguments: {
										path: "xd://ompdesk_report",
										content: JSON.stringify({ kind: "done", text: "Fixed." }),
									},
								},
							],
							stopReason: "toolUse",
						},
						{
							role: "toolResult",
							toolCallId: "r1",
							toolName: "write",
							content: [{ type: "text", text: "Delivered." }],
						},
						{ role: "assistant", content: "Fixed.\nResult: ok", stopReason: "stop" },
					] as AgentMessage[],
				},
			});
			await reported.service.autoClose("main0001");
			expect(reported.host.mails.filter(mail => mail.to === "main0001")).toHaveLength(0);
		});
	});

	describe("a message to a child whose tab was closed", () => {
		it("opens the child it opened again and delivers, by the id it was given", async () => {
			const { host, service, child } = await finishedChild();
			await service.autoClose("main0001");
			expect(closes(host)).toHaveLength(1);
			expect(host.closedRecords[0]?.tabIds).toEqual([child.tabId]);
			const sent = await service.run("main0001", T.send, { session: child.tabId, message: "one more thing" });
			expect(sent.isError, sent.text).toBe(false);
			expect(host.spawned.at(-1)).toMatchObject({ sessionPath: "/s/kid.jsonl" });
			const again = [...host.tabsById.values()].find(tab => tab.sessionPath === "/s/kid.jsonl");
			expect(again?.tabId).toBeDefined();
			expect(prompts(host, again?.tabId ?? "")).toEqual([expect.stringContaining("one more thing")]);
			expect(sent.text).toContain("Dispatch d");
		});

		it("finds it after a relaunch by any id its record keeps; another session's closed child stays closed", async () => {
			const host = new FakeHost({ tabId: "boss0009", title: "Boss", sessionPath: "/s/boss.jsonl" });
			host.closed = [
				{
					path: "/s/kid.jsonl",
					openedBySession: "/s/boss.jsonl",
					title: "Fix the parser",
					cwd: "/repo",
					closedAt: 1,
					tabIds: ["kid00002", "kidold01"],
				},
				{
					path: "/s/theirs.jsonl",
					openedBySession: "/s/someone.jsonl",
					title: "Not yours",
					cwd: "/repo",
					closedAt: 2,
					tabIds: ["their0003"],
				},
			];
			const service = control(host);
			const sent = await service.run("boss0009", T.send, { session: "kidold01", message: "carry on" });
			expect(sent.isError, sent.text).toBe(false);
			expect(host.spawned).toEqual([expect.objectContaining({ sessionPath: "/s/kid.jsonl" })]);
			const refused = await service.run("boss0009", T.send, { session: "their0003", message: "x" });
			expect(refused.text).toContain("not open in any tab");
			expect(host.spawned).toHaveLength(1);
		});
	});

	it("waits while the opener runs until it has read the answer", async () => {
		const { host, service, child } = await finishedChild();
		const opener = host.tabsById.get("main0001") as FakeTab;
		opener.busy = true;
		await service.autoClose("main0001");
		expect(closes(host)).toHaveLength(0);
		await service.run("main0001", T.result, { sessions: [child.tabId] });
		await service.autoClose("main0001");
		expect(closes(host)).toHaveLength(1);
	});

	it("waits while a relaunch continues the opener's cut-off turn, until it has read the answer", async () => {
		// TurnResume shows the opener's "continuing" row from launch until its turn runs again: the opener is about
		// to read its children, so the seconds before the continuation starts are no idle opener.
		const { host, service, child } = await finishedChild();
		const opener = host.tabsById.get("main0001") as FakeTab;
		opener.resuming = true;
		await service.autoClose("main0001");
		expect(closes(host)).toHaveLength(0);
		await service.run("main0001", T.result, { sessions: [child.tabId] });
		await service.autoClose("main0001");
		expect(closes(host)).toHaveLength(1);
	});

	it("removes the worktree of a landed, clean branch and keeps a landed one with files left over open", async () => {
		const merged = await finishedChild({ worktree: true });
		merged.host.landings.set("omp/agent/w", { hasWork: true, landed: true, clean: true });
		await merged.service.autoClose("main0001");
		expect(merged.host.removed).toEqual(["omp/agent/w"]);
		expect(merged.host.closedRecords[0]?.cwd).toBe("/repo");

		const dirty = await finishedChild({ worktree: true });
		dirty.host.landings.set("omp/agent/w", { hasWork: true, landed: true, clean: false });
		await dirty.service.autoClose("main0001");
		expect(closes(dirty.host)).toHaveLength(0);
		expect(dirty.host.removed).toEqual([]);
	});

	it("removes the worktree of a closed child only once its omp has exited", async () => {
		const { host, service } = await finishedChild({ worktree: true });
		host.landings.set("omp/agent/w", { hasWork: true, landed: true, clean: true });
		const { pendingWhileRunning } = await whileOmpRuns(host, () => service.autoClose("main0001"));
		expect(pendingWhileRunning).toBe(true);
		expect(host.removed).toEqual(["omp/agent/w"]);
	});

	it("closes a landed child on a paired host and removes its worktree there", async () => {
		const { host, service } = await finishedChild({
			worktree: true,
			patch: { device: "dev-win-1", deviceName: "DESKTOP-91ID999" },
		});
		host.landings.set("omp/agent/w", { hasWork: true, landed: true, clean: true });
		await service.autoClose("main0001");
		expect(closes(host)).toHaveLength(1);
		expect(host.removed).toEqual(["omp/agent/w"]);
		expect(host.gitCalls.filter(call => call.op === "landing" || call.op === "remove")).toEqual([
			{ op: "landing", branch: "omp/agent/w", device: "dev-win-1" },
			{ op: "remove", branch: "omp/agent/w", device: "dev-win-1" },
		]);
	});

	it("never closes a landed, clean child that still runs a turn or waits on an ask", async () => {
		for (const patch of [
			{ busy: true },
			{ asks: [select("Allow tool: bash", ["Approve", "Deny"])] },
		] satisfies Partial<FakeTab>[]) {
			const { host, service } = await finishedChild({ worktree: true, patch });
			host.landings.set("omp/agent/w", { hasWork: true, landed: true, clean: true });
			await service.autoClose("main0001");
			expect(closes(host), JSON.stringify(Object.keys(patch))).toHaveLength(0);
			expect(host.removed).toEqual([]);
		}
	});

	it("closes on a Result line, ok at once and problem once the opener has the report; prose without a verdict line stays", async () => {
		for (const [last, closed] of [
			["All tests failed, nothing works.\nResult: problem — tests failed", true],
			["Everything is done and checked.", false],
			["Done.\nResult: ok", true],
		] as const) {
			const { host, service } = await finishedChild({ patch: { last } });
			await service.autoClose("main0001");
			await service.autoClose("main0001");
			expect(closes(host), last).toHaveLength(closed ? 1 : 0);
		}
	});

	describe("a child that ended with Result: problem", () => {
		const problem = "Two tests still fail.\nResult: problem — two tests fail";

		it("is not closed before its opener read it: the report waits for the opener's turn, a result read counts too", async () => {
			const { host, service } = await finishedChild({ patch: { last: problem } });
			const opener = host.tabsById.get("main0001") as FakeTab;
			opener.busy = true;
			await service.autoClose("main0001");
			expect(
				host.mails.filter(mail => mail.to === "main0001" && mail.content.includes("two tests fail")),
			).toHaveLength(1);
			await service.autoClose("main0001");
			expect(closes(host)).toHaveLength(0);
			opener.busy = false;
			await service.autoClose("main0001");
			expect(closes(host)).toHaveLength(1);
			expect(host.closedRecords).toHaveLength(1);

			const read = await finishedChild({ patch: { last: problem } });
			(read.host.tabsById.get("main0001") as FakeTab).busy = true;
			await read.service.autoClose("main0001");
			expect(closes(read.host)).toHaveLength(0);
			await read.service.run("main0001", T.result, { sessions: [read.child.tabId] });
			await read.service.autoClose("main0001");
			expect(closes(read.host)).toHaveLength(1);
		});

		it("is not closed in the pass that sent its done report to an idle opener, but in the next", async () => {
			const { host, service } = await finishedChild({ patch: { last: problem } });
			await service.autoClose("main0001");
			expect(host.mails.filter(mail => mail.to === "main0001")).toHaveLength(1);
			expect(closes(host)).toHaveLength(0);
			await service.autoClose("main0001");
			expect(closes(host)).toHaveLength(1);
		});

		it("keeps an unlanded worktree and its branch when its tab closes", async () => {
			const { host, service } = await finishedChild({ worktree: true, patch: { last: problem } });
			host.landings.set("omp/agent/w", { hasWork: true, landed: false, clean: true });
			await service.autoClose("main0001");
			await service.autoClose("main0001");
			expect(closes(host)).toHaveLength(1);
			expect(host.removed).toEqual([]);
			expect(host.deleted).toEqual([]);
			expect(host.closedRecords).toHaveLength(1);
		});

		it("still stays for the person looking, typing, a failed turn, a running turn or a waiting question", async () => {
			for (const patch of [
				{ looked: true },
				{ userTouched: true },
				{ lastRun: { stopReason: "error" } },
				{ busy: true },
				{ asks: [select("Allow tool: bash", ["Approve", "Deny"])] },
			] satisfies Partial<FakeTab>[]) {
				const { host, service } = await finishedChild({ patch: { last: problem, ...patch } });
				await service.autoClose("main0001");
				await service.autoClose("main0001");
				expect(closes(host), JSON.stringify(Object.keys(patch))).toHaveLength(0);
			}
		});
	});

	it("keeps a session with unmerged commits or an error ending open", async () => {
		const unmerged = await finishedChild({ worktree: true });
		unmerged.host.landings.set("omp/agent/w", { hasWork: true, landed: false, clean: true });
		await unmerged.service.autoClose("main0001");
		expect(closes(unmerged.host)).toHaveLength(0);

		for (const stopReason of ["error", "aborted"]) {
			const failed = await finishedChild({ patch: { lastRun: { stopReason } } });
			await failed.service.autoClose("main0001");
			expect(closes(failed.host)).toHaveLength(0);
		}
	});

	it("never closes a tab the person looks at or typed into, one still working, or one the person opened", async () => {
		for (const patch of [
			{ looked: true },
			{ userTouched: true },
			{ busy: true },
			{ asks: [select("Allow tool: bash", ["Approve", "Deny"])] },
			{ autoClosable: false },
			{ hidden: true },
			{ last: "" },
		] satisfies Partial<FakeTab>[]) {
			const { host, service } = await finishedChild({ patch });
			await service.autoClose("main0001");
			expect(closes(host), JSON.stringify(Object.keys(patch))).toHaveLength(0);
		}
		// A tab the caller never opened is no child, whatever its facts say.
		const host = new FakeHost(
			{ tabId: "main0001", title: "Boss", sessionPath: "/s/boss.jsonl" },
			{
				tabId: "user0002",
				sessionPath: "/s/u.jsonl",
				autoClosable: true,
				lastRun: { stopReason: "stop" },
				last: "x",
			},
		);
		await control(host).autoClose("main0001");
		expect(closes(host)).toHaveLength(0);
	});

	it("leaves everything as it was when the window keeps the tab open", async () => {
		const { host, service } = await finishedChild({ worktree: true });
		host.landings.set("omp/agent/w", { hasWork: true, landed: true, clean: true });
		host.view = (_caller, event) => {
			host.views.push(event);
		};
		await service.autoClose("main0001");
		expect(host.closedRecords).toEqual([]);
		expect(host.removed).toEqual([]);
	});

	/** A child's final turn as stock journals it: the opener's brief, a `done` report through the device, the answer. */
	const finalTurn = (answer: string, extra: AgentMessage[] = []): AgentMessage[] => [
		{ role: "user", content: [{ type: "text", text: wrapAgentMessage("fix the parser", "Boss") }] },
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-report",
					name: "write",
					arguments: { path: "xd://ompdesk_report", content: JSON.stringify({ kind: "done", text: "Pushed." }) },
				},
			],
			stopReason: "toolUse",
		},
		{ role: "toolResult", toolCallId: "call-report", toolName: "write", content: [{ type: "text", text: "ok" }] },
		{ role: "assistant", content: [{ type: "text", text: answer }], stopReason: "stop" },
		...extra,
	];

	it("closes a child whose answer has no verdict line but whose last report for its current work is done", async () => {
		const { host, service } = await finishedChild({
			patch: { last: "Pushed to main.", messages: finalTurn("Pushed to main.") },
		});
		await service.autoClose("main0001");
		expect(closes(host)).toHaveLength(1);

		// New work after that report: the done no longer speaks for it.
		const again = await finishedChild({
			patch: {
				last: "Looked again.",
				messages: finalTurn("Pushed to main.", [
					{ role: "user", content: [{ type: "text", text: wrapAgentMessage("one more thing", "Boss") }] },
					{ role: "assistant", content: [{ type: "text", text: "Looked again." }], stopReason: "stop" },
				]),
			},
		});
		await again.service.autoClose("main0001");
		expect(closes(again.host)).toHaveLength(0);
	});

	it("closes a child restored after a relaunch from its transcript: started, not started, or on a paired host", async () => {
		// Started again but no turn of this launch: no lastRun, the transcript says how it ended.
		const started = await finishedChild({
			patch: { restored: true, lastRun: undefined, messages: finalTurn("Done.\nResult: ok") },
		});
		await started.service.autoClose("main0001");
		expect(closes(started.host)).toHaveLength(1);

		// Its transcript ends Result: problem: closed too, the opener reads the same report.
		const problem = await finishedChild({
			patch: { restored: true, lastRun: undefined, messages: finalTurn("Done.\nResult: problem — tests failed") },
		});
		await problem.service.autoClose("main0001");
		expect(closes(problem.host)).toHaveLength(1);

		// Not started at all (a deferred tab): no omp to ask, the saved transcript answers, on its own computer.
		for (const device of [undefined, "dev-win-1"]) {
			const asleep = await finishedChild({
				worktree: true,
				patch: {
					restored: true,
					status: "asleep",
					lastRun: undefined,
					last: undefined,
					...(device ? { device, deviceName: "DESKTOP-91ID999" } : {}),
				},
			});
			asleep.host.landings.set("omp/agent/w", { hasWork: true, landed: true, clean: true });
			const reads: { path: string; device: string | undefined }[] = [];
			asleep.host.storedMessages = async row => {
				reads.push({ path: row.path, device: row.device });
				return finalTurn("Done.\nResult: ok");
			};
			await asleep.service.autoClose("main0001");
			expect(closes(asleep.host), String(device)).toHaveLength(1);
			expect(asleep.host.removed).toEqual(["omp/agent/w"]);
			expect(reads).toEqual([{ path: "/s/kid.jsonl", device }]);
			expect(asleep.host.closedRecords[0]).toMatchObject({ path: "/s/kid.jsonl", openedBySession: "/s/boss.jsonl" });
			// The record keeps the computer its saved file is on, where the opener's board reads it later.
			expect(asleep.host.closedRecords[0]?.device).toBe(device);
		}
	});

	it("keeps a restored child its transcript shows typed into, failed or unfinished, and never calls it running", async () => {
		const person: AgentMessage = { role: "user", content: [{ type: "text", text: "also check the README" }] };
		const endings: AgentMessage[][] = [
			finalTurn("Done.\nResult: ok", [
				person,
				{ role: "assistant", content: "Checked.\nResult: ok", stopReason: "stop" },
			]),
			[...finalTurn("Done."), { role: "assistant", content: "Result: ok", stopReason: "error" }],
			// Cut off mid-turn: its last message is a tool call, not an answer.
			[
				...finalTurn("Done.\nResult: ok"),
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "c9", name: "bash", arguments: { command: "ls" } }],
					stopReason: "toolUse",
				},
			],
		];
		for (const messages of endings) {
			const { host, service } = await finishedChild({
				patch: { restored: true, status: "asleep", lastRun: undefined, last: undefined },
			});
			host.storedTranscripts.set("/s/kid.jsonl", messages);
			await service.autoClose("main0001");
			expect(closes(host), JSON.stringify(messages.at(-1))).toHaveLength(0);
			const [item] = await service.reviewItems("main0001");
			expect(item?.state).not.toBe("running");
		}
	});
});

const desktop: ControlDevice = { id: "dev-win-1", name: "DESKTOP-91ID999", state: "online" };

function storedRow(row: Partial<StoredSession>): StoredSession {
	return {
		id: "11111111-aaaa",
		path: "/s/proj/one.jsonl",
		title: "Old parser work",
		firstMessage: "fix the parser",
		cwd: "/repo",
		modified: "2026-10-18T10:00:00.000Z",
		messages: 4,
		status: "complete",
		hidden: false,
		...row,
	};
}

describe("ompdesk_sessions scopes", () => {
	it("lists this window by default, every window with scope app, and one device's sessions with device", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "Boss" },
			{ tabId: "else0002", title: "Other window work", here: false },
			{ tabId: "remo0003", title: "On the PC", here: false, device: desktop.id, deviceName: desktop.name },
		);
		host.deviceList = [desktop];
		const service = control(host);
		const window = (await service.run("main0001", T.list, {})).text;
		expect(window).toContain("1 session in this window");
		expect(window).not.toContain("else0002");
		expect(window).toContain("2 more open in other windows (scope app)");
		expect(window).toContain(`Paired devices: DESKTOP-91ID999 (id ${desktop.id}, online)`);
		const app = (await service.run("main0001", T.list, { scope: "app" })).text;
		expect(app).toContain("3 sessions in this app");
		expect(app).toMatch(/else0002 "Other window work" \[another window\]/);
		const onPc = (await service.run("main0001", T.list, { device: "desktop-91" })).text;
		expect(onPc).toContain("1 session on DESKTOP-91ID999");
		expect(onPc).toContain("remo0003");
		expect(onPc).not.toContain("else0002");
		const local = (await service.run("main0001", T.list, { device: "local", scope: "app" })).text;
		expect(local).not.toContain("remo0003");
		expect((await service.run("main0001", T.list, { device: "laptop" })).text).toMatch(/No paired device "laptop"/);
	});

	it("filters by status, folder, query and the sessions the caller opened", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "Boss" },
			{ tabId: "busy0002", title: "Runner", busy: true, cwd: "/repo/api" },
			{ tabId: "ask00003", title: "Asker", asks: [select("Pick", ["A", "B"])] },
		);
		const service = control(host);
		expect((await service.run("main0001", T.list, { status: "running" })).text).toMatch(/^1 session .*\n- busy0002/);
		expect((await service.run("main0001", T.list, { status: "waiting" })).text).toContain("ask00003");
		expect((await service.run("main0001", T.list, { folder: "/api" })).text).not.toContain("ask00003");
		expect((await service.run("main0001", T.list, { query: "ask" })).text).toMatch(/^1 session/);
		await service.run("main0001", T.open, { message: "child work" });
		const mine = (await service.run("main0001", T.list, { mine: true })).text;
		expect(mine).toMatch(/^1 session/);
		expect(mine).toContain("opened by you");
	});

	it("lists saved sessions of this computer or an online device, with a search, and caches them for read", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" });
		host.deviceList = [desktop, { id: "dev-off", name: "Laptop", state: "offline" }];
		host.storedRows = [
			storedRow({}),
			storedRow({ id: "22222222-bbbb", path: "/s/p/two.jsonl", title: "Secret", hidden: true }),
			storedRow({ id: "33333333-cccc", path: "C:/s/three.jsonl", title: "PC refactor", device: desktop.id }),
			storedRow({
				id: "55555555-eeee",
				path: "/s/p/five.jsonl",
				title: "",
				firstMessage: wrapAgentMessage("Title: Fix the importer\nTarget: src/import", "Boss"),
			}),
		];
		const service = control(host);
		const local = (await service.run("main0001", T.list, { scope: "stored" })).text;
		expect(local).toContain("3 sessions saved on this computer");
		// An untitled session an agent opened reads as its task, never as the raw agent-message wrapper.
		expect(local).toContain('55555555-eeee "Fix the importer"');
		expect(local).not.toContain("ompdesk-agent-message");
		expect(local).toContain('11111111-aaaa "Old parser work"');
		expect(local).toContain("22222222-bbbb (hidden from agents by the user)");
		expect(local).not.toContain("Secret");
		const pc = (await service.run("main0001", T.list, { scope: "stored", device: "DESKTOP-91ID999", query: "PC" }))
			.text;
		expect(pc).toContain('1 session saved on DESKTOP-91ID999 matching "PC"');
		expect(host.storedQueries.at(-1)).toEqual({ device: desktop.id, query: "PC" });
		const off = await shortWaits(() => service.run("main0001", T.list, { scope: "stored", device: "Laptop" }));
		expect(off.isError).toBe(true);
		expect(off.text).toContain("Laptop is offline");
	});
});

describe("ompdesk_session_read of a saved session", () => {
	const transcript: AgentMessage[] = Array.from({ length: 5 }, (_, index) => ({
		role: index % 2 === 0 ? "user" : "assistant",
		content: `message ${index}`,
	})) as AgentMessage[];

	it("pages a saved transcript from its end with an index cursor", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		host.storedRows = [storedRow({})];
		host.storedTranscripts.set("/s/proj/one.jsonl", transcript);
		const service = control(host);
		const last = (await service.run("main0001", T.read, { session: "11111111", limit: 2 })).text;
		expect(last).toContain('"Old parser work" (saved, not open): 2 message(s) of 5');
		expect(last).toContain("message 4");
		expect(last).not.toContain("message 2");
		expect(last).toContain('{"session":"11111111-aaaa","before":"3"}');
		const earlier = (await service.run("main0001", T.read, { session: "11111111-aaaa", before: "3", limit: 2 })).text;
		expect(earlier).toContain("message 1");
		expect(earlier).toContain("message 2");
	});

	it("answers a cursor the session has outgrown with its newest page, saying so, for a saved and an open session", async () => {
		const host = new FakeHost(
			{ tabId: "main0001" },
			{ tabId: "live0002", title: "Live", messages: [{ role: "user", content: "live text" } as AgentMessage] },
		);
		host.storedRows = [storedRow({})];
		host.storedTranscripts.set("/s/proj/one.jsonl", transcript);
		const service = control(host);
		// An index past the end, and the cursor a read of its open tab returned: neither is a page of the saved copy.
		for (const before of ["99", "cur1"]) {
			const saved = await service.run("main0001", T.read, { session: "11111111-aaaa", before, limit: 2 });
			expect(saved.isError, saved.text).toBe(false);
			expect(saved.text).toContain(`The cursor "${before}" names no page of this session as it is now`);
			expect(saved.text).toContain("message 4");
			expect(saved.text).toContain('{"session":"11111111-aaaa","before":"3"}');
		}
		// The open session wrote a message since the page the cursor came from.
		host.staleCursors.add("cur0");
		const live = await service.run("main0001", T.read, { session: "live0002", before: "cur0" });
		expect(live.isError, live.text).toBe(false);
		expect(live.text).toContain('The cursor "cur0" names no page of this session as it is now');
		expect(live.text).toContain("live text");
		expect(live.text).toContain('"before":"cur1"');
	});

	it("refuses a hidden saved session and an unknown id", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		host.storedRows = [storedRow({ hidden: true })];
		const service = control(host);
		expect((await service.run("main0001", T.read, { session: "11111111-aaaa" })).text).toContain("hid this session");
		expect((await service.run("main0001", T.read, { session: "nope9999" })).text).toContain("No session");
	});

	it("reads an open session's tab when the saved session is open", async () => {
		const host = new FakeHost(
			{ tabId: "main0001" },
			{
				tabId: "open0002",
				title: "Live",
				// main lists a row as open in the tab that holds its file (host.ts `sessionOwner(row.path)`).
				sessionPath: "/s/proj/one.jsonl",
				messages: [{ role: "user", content: "live text" } as AgentMessage],
			},
		);
		host.storedRows = [storedRow({ tabId: "open0002" })];
		const text = (await control(host).run("main0001", T.read, { session: "11111111-aaaa" })).text;
		expect(text).toContain('"Live"');
		expect(text).toContain("live text");
	});
});

describe("ompdesk_session_open on a device and reopen", () => {
	it("waits for a session still starting, however long (queued or slow on its computer), and opens it once it is up", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" });
		const spawn = host.spawn;
		let child = "";
		host.spawn = async (caller, request) => {
			const opened = await spawn(caller, request);
			child = opened.tabId;
			(host.tabsById.get(child) as FakeTab).status = "starting";
			return opened;
		};
		let settled = false;
		const opening = control(host)
			.run("main0001", T.open, { message: "build it" })
			.finally(() => {
				settled = true;
			});
		// Far past every wait of the open (`SHORT_WAITS`): a live start is never a failed open.
		await sleep(1_500);
		expect(settled).toBe(false);
		(host.tabsById.get(child) as FakeTab).status = "ready";
		host.emit();
		const result = await opening;
		expect(result.isError, result.text).toBe(false);
		expect(prompts(host, child)).toEqual([expect.stringContaining("build it")]);
	});

	it("opens a session on a paired device by name; an offline one is refused", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" });
		host.deviceList = [desktop, { id: "dev-off", name: "Laptop", state: "offline" }];
		const service = control(host);
		const opened = await service.run("main0001", T.open, {
			message: "run the Windows build",
			device: "DESKTOP-91ID999",
			folder: "C:\\work\\app",
		});
		expect(opened.isError).toBe(false);
		expect(host.spawned[0]).toMatchObject({ device: desktop.id, folder: "C:\\work\\app" });
		expect(opened.text).toContain("on DESKTOP-PC");
		const local = await service.run("main0001", T.open, { device: "local" });
		expect(local.isError).toBe(false);
		expect(host.spawned[1]?.device).toBeNull();
		const off = await shortWaits(() => service.run("main0001", T.open, { device: "Laptop" }));
		expect(off.isError).toBe(true);
		expect(off.text).toContain("Laptop is offline");
		expect(host.spawned).toHaveLength(2);
	});

	it("reopens a saved session on the device it is saved on, without marking it a worker", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" });
		host.deviceList = [desktop];
		host.storedRows = [storedRow({ device: desktop.id, path: "C:/s/one.jsonl" })];
		const service = control(host);
		await service.run("main0001", T.list, { scope: "stored", device: desktop.id });
		const result = await service.run("main0001", T.open, { reopen: "11111111-aaaa", message: "continue please" });
		expect(result.isError).toBe(false);
		expect(result.text).toContain("reopened");
		expect(host.spawned[0]).toMatchObject({ sessionPath: "C:/s/one.jsonl", device: desktop.id });
		expect(host.sent.some(entry => entry.command.type === "agent_control_worker")).toBe(false);
		const child = [...host.tabsById.keys()].find(id => id !== "main0001") as string;
		expect(prompts(host, child)).toEqual([
			wrapAgentMessage(
				'continue please\n\n[ompdesk dispatch d1: report with ompdesk_report, dispatch "d1"]',
				"Boss",
			),
		]);
		expect(host.tasks.size).toBe(0);
	});

	it("refuses to reopen a session that is open, hidden, or with folder or worktree", async () => {
		const host = new FakeHost({ tabId: "main0001" }, { tabId: "open0002", sessionPath: "/s/proj/one.jsonl" });
		host.storedRows = [
			storedRow({ tabId: "open0002" }),
			storedRow({ id: "44444444-dddd", path: "/s/proj/four.jsonl", hidden: true }),
		];
		const service = control(host);
		expect((await service.run("main0001", T.open, { reopen: "11111111-aaaa" })).text).toContain(
			"already open as open0002",
		);
		expect((await service.run("main0001", T.open, { reopen: "44444444-dddd" })).text).toContain("hid that session");
		expect((await service.run("main0001", T.open, { reopen: "11111111-aaaa", worktree: true })).text).toContain(
			"reopen opens a stored session as it was",
		);
		expect(host.spawned).toHaveLength(0);
	});

	it("reopens a paired device's saved session whose tab was closed after it was listed", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "Boss" },
			{ tabId: "remo0002", device: desktop.id, deviceName: desktop.name, sessionPath: "C:/s/one.jsonl" },
		);
		host.deviceList = [desktop];
		host.storedRows = [storedRow({ device: desktop.id, path: "C:/s/one.jsonl", tabId: "remo0002" })];
		const service = control(host);
		await service.run("main0001", T.list, { scope: "stored", device: desktop.id });
		// The device's explicit close released the tab; the row listed before still names it.
		host.tabsById.delete("remo0002");
		const result = await service.run("main0001", T.open, { reopen: "11111111-aaaa" });
		expect(result.text).not.toContain("already open");
		expect(result.isError).toBe(false);
		expect(host.spawned[0]).toMatchObject({ sessionPath: "C:/s/one.jsonl", device: desktop.id });
	});

	it("names the live tab of a saved session listed before it was opened", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" });
		host.deviceList = [desktop];
		host.storedRows = [storedRow({ device: desktop.id, path: "C:/s/one.jsonl" })];
		const service = control(host);
		await service.run("main0001", T.list, { scope: "stored", device: desktop.id });
		host.add({ tabId: "remo0003", device: desktop.id, deviceName: desktop.name, sessionPath: "C:/s/one.jsonl" });
		expect((await service.run("main0001", T.open, { reopen: "11111111-aaaa" })).text).toContain(
			"already open as remo0003",
		);
	});

	it("names an opened session by its task, and an untitled one by its folder", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" }, { tabId: "bare0002", cwd: "/repo/tools" });
		const text = (await control(host).run("main0001", T.result, { session: "bare0002" })).text;
		expect(text).toContain("(untitled, in tools)");
	});
});

describe("ompdesk_session_stop of a saved session", () => {
	it("deletes a paired device's saved session by its stored id and device after its tab closed", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "Boss" },
			{ tabId: "remo0002", device: desktop.id, deviceName: desktop.name, sessionPath: "C:/s/one.jsonl" },
		);
		host.full = true;
		host.deviceList = [desktop];
		host.storedRows = [storedRow({ device: desktop.id, path: "C:/s/one.jsonl", tabId: "remo0002" })];
		const service = control(host);
		await service.run("main0001", T.list, { scope: "stored", device: desktop.id });
		host.tabsById.delete("remo0002");
		const result = await service.run("main0001", T.stop, { session: "11111111-aaaa", delete: true });
		expect(result.isError).toBe(false);
		expect(result.text).toContain("Deleted");
		expect(host.deletedStored).toEqual([{ path: "C:/s/one.jsonl", device: desktop.id }]);
	});

	it("finds a device's saved session by id with device when it was never listed, and asks before deleting it", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" });
		host.deviceList = [desktop];
		host.storedRows = [storedRow({ device: desktop.id, path: "C:/s/one.jsonl" })];
		const service = control(host);
		const result = await service.run("main0001", T.stop, {
			session: "11111111-aaaa",
			device: desktop.name,
			delete: true,
		});
		expect(result.isError).toBe(false);
		expect(host.cards).toHaveLength(1);
		expect(host.storedQueries).toContainEqual({ device: desktop.id, query: undefined });
		expect(host.deletedStored).toEqual([{ path: "C:/s/one.jsonl", device: desktop.id }]);
		host.cardAnswer = false;
		host.storedRows = [storedRow({ id: "66666666-ffff", device: desktop.id, path: "C:/s/six.jsonl" })];
		const declined = await service.run("main0001", T.stop, {
			session: "66666666-ffff",
			device: desktop.id,
			delete: true,
		});
		expect(declined.text).toContain("declined");
		expect(host.deletedStored).toHaveLength(1);
	});

	it("has nothing to stop or close for a saved session no tab holds", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" });
		host.storedRows = [storedRow({})];
		const service = control(host);
		await service.run("main0001", T.list, { scope: "stored" });
		const result = await service.run("main0001", T.stop, { session: "11111111-aaaa", close: true });
		expect(result.isError).toBe(false);
		expect(result.text).toContain("not open");
		expect(host.deletedStored).toEqual([]);
	});

	it("deletes a saved session main recorded closing under the caller without a card, a sibling's with one", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss", sessionPath: "/s/boss.jsonl" });
		host.deviceList = [desktop];
		host.storedRows = [
			storedRow({ device: desktop.id, path: "C:/s/one.jsonl" }),
			storedRow({ id: "66666666-ffff", device: desktop.id, path: "C:/s/six.jsonl" }),
		];
		const closed = { title: "Lookup", cwd: "C:/repo", device: desktop.id, closedAt: 1 };
		host.closed = [
			{ ...closed, path: "C:/s/one.jsonl", openedBySession: "/s/boss.jsonl" },
			{ ...closed, path: "C:/s/six.jsonl", openedBySession: "/s/other.jsonl" },
		];
		const service = control(host);
		await service.run("main0001", T.stop, { session: "11111111-aaaa", device: desktop.id, delete: true });
		expect(host.cards).toEqual([]);
		await service.run("main0001", T.stop, { session: "66666666-ffff", device: desktop.id, delete: true });
		expect(host.cards).toHaveLength(1);
		expect(host.deletedStored.map(row => row.path)).toEqual(["C:/s/one.jsonl", "C:/s/six.jsonl"]);
	});
});

describe("ompdesk_compare with criteria", () => {
	const bashCheck = (id: string, command: string, output: string, isError = false): AgentMessage[] =>
		[
			{ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] },
			{ role: "toolResult", toolCallId: id, toolName: "bash", content: output, isError },
		] as AgentMessage[];

	it("reads each session's checks, diff and answer, asks the judge on the caller, and ranks with a winner", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "Boss" },
			{
				tabId: "aaaa0002",
				title: "Approach A",
				last: "Done; tests pass.",
				worktree: { name: "a", branch: "omp/agent/a", baseCwd: "/repo", path: "/wt/a" },
				messages: bashCheck("c1", "bun run vitest", "12 passed\nexit code 0"),
			},
			{
				tabId: "bbbb0003",
				title: "Approach B",
				last: "Done.",
				messages: bashCheck("c2", "bunx tsc --noEmit", "error TS2322", true),
			},
		);
		host.facts.set("omp/agent/a", {
			branch: "omp/agent/a",
			baseBranch: "main",
			commitsAhead: 2,
			files: [{ path: "src/x.ts", added: 10, removed: 2 }],
			uncommitted: 0,
			untracked: 0,
			merged: false,
		} as never);
		host.judgeReply = `Here you go:\n\`\`\`json\n${JSON.stringify({
			ranking: [
				{
					session: "bbbb0003",
					score: 30,
					criteria: [{ criterion: "types pass", met: "no", why: "tsc failed" }],
					reasons: "type errors",
				},
				{
					session: "aaaa0002",
					score: 90,
					criteria: [{ criterion: "types pass", met: "unknown", why: "not run" }],
					reasons: "tests pass",
				},
			],
			winner: "aaaa0002",
			why: "only A has a passing check",
		})}\n\`\`\``;
		const result = await control(host).run("main0001", T.compare, {
			sessions: ["aaaa0002", "bbbb0003"],
			criteria: ["types pass", "tests pass"],
		});
		expect(result.isError).toBe(false);
		expect(host.sent.find(entry => entry.command.type === "agent_control_judge")?.tabId).toBe("main0001");
		const prompt = host.judged[0] ?? "";
		expect(prompt).toContain("1. types pass");
		expect(prompt).toContain("`bun run vitest` passed");
		expect(prompt).toContain("`bunx tsc --noEmit` FAILED");
		expect(prompt).toContain("1 file(s) changed (+10 −2)");
		expect(result.text).toMatch(/Verdict by anthropic\/claude-slow, \$0\.0123:\n1\. aaaa0002: 90\/100/);
		expect(result.text).toContain("2. bbbb0003: 30/100");
		expect(result.text).toContain("   - no: types pass (tsc failed)");
		expect(result.text).toContain("Winner: aaaa0002. only A has a passing check");
		expect(result.text).toContain("Evidence:");
	});

	it("compares without a judge when no criteria are given, and shows a judge answer that is not JSON as is", async () => {
		const host = new FakeHost({ tabId: "main0001" }, { tabId: "aaaa0002", last: "ok" });
		host.storedRows = [storedRow({})];
		host.storedTranscripts.set("/s/proj/one.jsonl", [
			{ role: "assistant", content: "saved final answer" },
		] as AgentMessage[]);
		const service = control(host);
		const plain = await service.run("main0001", T.compare, { sessions: ["aaaa0002", "11111111-aaaa"] });
		expect(plain.text).toContain("final answer: saved final answer");
		expect(plain.text).toContain("Pass criteria to have them judged");
		expect(host.judged).toHaveLength(0);
		host.judgeReply = "I cannot decide.";
		const odd = await service.run("main0001", T.compare, { sessions: ["aaaa0002"], criteria: ["works"] });
		expect(odd.text).toContain("its answer was not the expected JSON");
		expect(odd.text).toContain("I cannot decide.");
	});

	/** Two worktree children: A's diff, B's diff and failing check, each read through the git seam. */
	function judgedPair() {
		const host = new FakeHost(
			{ tabId: "main0001", title: "Boss" },
			{
				tabId: "aaaa0002",
				title: "Approach A",
				last: "Done; tests pass.",
				worktree: { name: "a", branch: "omp/agent/a", baseCwd: "/repo", path: "/wt/a" },
				messages: bashCheck(
					"c1",
					"bun run vitest",
					`${"noise line\n".repeat(400)}Tests  12 passed (12)\nexit code 0`,
				),
			},
			{
				tabId: "bbbb0003",
				title: "Approach B",
				last: "Done.",
				worktree: { name: "b", branch: "omp/agent/b", baseCwd: "/repo", path: "/wt/b" },
				messages: bashCheck("c2", "bunx tsc --noEmit", "src/y.ts(3,1): error TS2322: Type 'string'", true),
			},
		);
		host.facts.set("omp/agent/a", { ...clean, branch: "omp/agent/a" });
		host.facts.set("omp/agent/b", { ...clean, branch: "omp/agent/b" });
		host.evidence.set("omp/agent/a", {
			diff: "diff --git a/src/x.ts b/src/x.ts\n+export const answer = 42;\n",
			diffOmitted: 0,
			merge: { kind: "clean" },
		});
		host.evidence.set("omp/agent/b", {
			diff: `diff --git a/src/y.ts b/src/y.ts\n-export function parse(input) {\n${"+x\n".repeat(30_000)}`,
			diffOmitted: 1234,
			merge: { kind: "conflict", files: ["README.md", "src/y.ts"] },
		});
		host.judgeReply = JSON.stringify({
			ranking: [{ session: "aaaa0002", score: 80, criteria: [], reasons: "ok" }],
			winner: "aaaa0002",
			why: "A",
		});
		return host;
	}

	it("gives the judge each child's diff and the tail of its checks' output, within the evidence budget", async () => {
		const host = judgedPair();
		await control(host).run("main0001", T.compare, {
			sessions: ["aaaa0002", "bbbb0003"],
			criteria: ["parser keeps working"],
		});
		expect(host.diffChars).toEqual([30_000, 30_000]);
		const prompt = host.judged[0] ?? "";
		expect(prompt).toContain("+export const answer = 42;");
		expect(prompt).toContain("-export function parse(input) {");
		expect(prompt).toContain("Tests  12 passed (12)");
		expect(prompt).toContain("error TS2322: Type 'string'");
		expect(prompt).toContain("merge: would conflict in README.md, src/y.ts");
		expect(prompt.length).toBeLessThan(62_000);
	});

	it("names the judge model, the role it came from and its family against the caller's", async () => {
		const host = judgedPair();
		host.judgeMeta = {
			model: "openai-codex/gpt-6.1-sol",
			role: "advisor",
			family: "openai",
			mainModel: "anthropic/claude-opus-5-5",
			mainFamily: "anthropic",
			crossFamily: true,
			usd: 0.05,
		};
		const service = control(host);
		const args = { sessions: ["aaaa0002", "bbbb0003"], criteria: ["works"] };
		expect((await service.run("main0001", T.compare, args)).text).toContain(
			"Verdict by openai-codex/gpt-6.1-sol (advisor role, openai family; your model is anthropic), $0.0500:",
		);
		host.judgeMeta = {
			...host.judgeMeta,
			model: "anthropic/claude-opus-5-5",
			family: "anthropic",
			crossFamily: false,
		};
		expect((await service.run("main0001", T.compare, args)).text).toContain(
			"same family as your model: no model of another family had credentials",
		);
	});

	it("returns the evidence with verdict unavailable when the judge fails", async () => {
		const host = judgedPair();
		host.judgeError = "No credentials for openai-codex/gpt-6.1-sol";
		const result = await control(host).run("main0001", T.compare, {
			sessions: ["aaaa0002", "bbbb0003"],
			criteria: ["works"],
		});
		expect(result.isError).toBe(false);
		expect(result.text).toMatch(/^Verdict: unavailable \(.*No credentials for openai-codex\/gpt-6\.1-sol\)/);
		expect(result.text).toContain("Evidence:");
		expect(result.text).toContain('- aaaa0002 "Approach A"');
	});

	it("predicts each child's merge with git merge-tree and says which files would conflict", async () => {
		const host = judgedPair();
		const result = await control(host).run("main0001", T.compare, { sessions: ["aaaa0002", "bbbb0003"] });
		expect(host.diffChars).toEqual([0, 0]);
		expect(result.text).toContain("merge: no conflict with main");
		expect(result.text).toContain("merge: would conflict in README.md, src/y.ts (predicted by git merge-tree");
		expect(result.text).not.toContain("ready to merge with ompdesk_merge\n  final answer: Done.");
	});
});

describe("ompdesk_report: sessions tell their opener", () => {
	async function family() {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss" });
		// Progress from one sender is coalesced for the mailbox window (`mailCoalesceMs`, 2 s by default).
		const service = control(host, { mailCoalesceMs: 150 });
		const opened = await service.run("boss0001", T.open, {
			sessions: [{ message: "Title: part A\nDo A" }, { message: "Title: part B\nDo B" }],
		});
		const [a, b] = [...opened.text.matchAll(/Opened session (\w+)/g)].map(match => match[1] as string);
		/** The coalescing window passes. */
		const fire = () => sleep(400);
		return { host, service, a: a as string, b: b as string, fire };
	}

	it("says where an idle session it opened left the work: its verdict, its report, or neither", async () => {
		const { host, service, a, b } = await family();
		for (const id of [a, b]) {
			const tab = host.tabsById.get(id) as FakeTab;
			tab.busy = false;
		}
		(host.tabsById.get(a) as FakeTab).last = "Fixed the parser.\nResult: ok";
		(host.tabsById.get(b) as FakeTab).last = "Looked around a bit.";
		const listed = (await service.run("boss0001", T.list, {})).text;
		expect(listed).toContain("idle, finished: Result ok");
		expect(listed).toContain("idle, ended its turn with no verdict line and no done report");

		await service.run(b, T.report, { kind: "done", text: "B is finished" });
		const result = (await service.run("boss0001", T.result, { session: b })).text;
		expect(result).toContain("idle, finished: reported done");

		// New work (dispatch d2): the done report for d1 no longer says where it stands.
		await service.run("boss0001", T.send, { session: b, message: "now do C" });
		(host.tabsById.get(b) as FakeTab).busy = false;
		const after = (await service.run("boss0001", T.result, { session: b })).text;
		expect(after).toContain("idle, ended its turn with no verdict line and no done report");
	});

	it("names the dispatch in the child's task, and a done report reaches the opener between its steps", async () => {
		const { host, service, a } = await family();
		expect(prompts(host, a)[0]).toContain('[ompdesk dispatch d1: report with ompdesk_report, dispatch "d1"]');
		const result = await service.run(a, T.report, {
			kind: "done",
			text: "A is finished",
			files: ["src/a.ts"],
			checks: [{ command: "bun test", passed: true }],
			dispatch: "d1",
		});
		expect(result.text).toBe("Delivered.");
		expect(host.mails).toHaveLength(1);
		const mail = host.mails[0];
		expect(mail?.to).toBe("boss0001");
		expect(mail?.delivery).toEqual({ triggerTurn: true, deliverAs: "aside" });
		expect(mail?.content).toContain(`<ompdesk-mail from="${a}"`);
		expect(mail?.content).toContain("changed files: src/a.ts");
		expect(mail?.content).toContain("checks: bun test passed");
		expect(mail?.details).toMatchObject({ kind: "done", text: "A is finished", dispatch: "d1" });
		expect(host.reviewChanged).toHaveBeenCalledWith("boss0001");
		const items = await service.reviewItems("boss0001");
		expect(items.find(item => item.tabId === a)?.report).toMatchObject({ kind: "done", text: "A is finished" });
	});

	it("routes a question between the opener's steps and keeps it waiting until the opener answers", async () => {
		const { host, service, a } = await family();
		expect((await service.run(a, T.report, { kind: "question", text: "Keep the old API?" })).text).toMatch(
			/Wait for the answer/,
		);
		expect(host.mails[0]?.delivery).toEqual({ triggerTurn: true, deliverAs: "aside" });
		expect(host.mails[0]?.content).toMatch(/waits on you/);
		expect((await service.reviewItems("boss0001")).find(item => item.tabId === a)?.waiting).toBe(true);
		// Nothing answers it but the opener (or the user through it): a send to the child does.
		await service.run("boss0001", T.send, { session: a, message: "Keep it." });
		expect((await service.reviewItems("boss0001")).find(item => item.tabId === a)?.waiting).toBeUndefined();
		expect(prompts(host, a).at(-1)).toContain("dispatch d2");
	});

	it("lists a child as waiting only on a question it asked its opener, never one it asked a sibling", async () => {
		const { service, a, b } = await family();
		await service.run(a, T.report, { kind: "progress", text: "half of A done" });
		await service.run(a, T.report, { kind: "question", to: b, text: "Did you change the shared type?" });
		const item = (await service.reviewItems("boss0001")).find(entry => entry.tabId === a);
		// The sibling's question waits on the sibling: the opener's board neither waits nor shows it as the last report.
		expect(item?.waiting).toBeUndefined();
		expect(item?.report).toMatchObject({ kind: "progress", text: "half of A done" });
	});

	it("stops listing a child as waiting once it carries on with a new turn", async () => {
		const { host, service, a } = await family();
		const child = host.tabsById.get(a);
		if (!child) throw new Error("no child");
		// It asks from within a turn main stamped.
		child.busy = true;
		child.busySince = Date.now() - 60_000;
		const question = { kind: "question", text: "Keep the old API?", dispatch: "d1", id: "q1" };
		await service.run(a, T.report, question);
		const waiting = (await service.reviewItems("boss0001")).find(entry => entry.tabId === a);
		expect(waiting?.waiting).toBe(true);
		// The person answered in the child's own tab: its next turn started after the question. Main stamps it with
		// its own clock, which may read a few ms behind the core's (two processes; a tick on Windows): it still counts
		// as a new turn.
		child.busySince = Date.now() - 10;
		const item = (await service.reviewItems("boss0001")).find(entry => entry.tabId === a);
		expect(item?.waiting).toBeUndefined();
		expect(item?.state).toBe("running");
		// A replay of the question in the new turn is refused, and leaves the question answered.
		expect((await service.run(a, T.report, question)).text).toMatch(/already delivered/);
		const replayed = (await service.reviewItems("boss0001")).find(entry => entry.tabId === a);
		expect(replayed?.waiting).toBeUndefined();
	});

	it("tells the opener when a child shows a question card, once, and lists the child as waiting until it is answered", async () => {
		const { host, service, a, b } = await family();
		const child = host.tabsById.get(a);
		if (!child) throw new Error("no child");
		child.asks = [
			{
				id: "q1",
				request: {
					type: "extension_ui_request",
					id: "q1",
					method: "select",
					title: "어떤 문구가 어디에 떴나요?",
					options: ['"omp를 사용할 수 없어요" (상단 띠)', "다른 문구", "Other (type your own)"],
				} as ExtensionUIRequest,
			},
		];
		await service.childAsked("boss0001", a, "q1");
		expect(host.mails).toHaveLength(1);
		const mail = host.mails[0];
		expect(mail?.to).toBe("boss0001");
		expect(mail?.delivery).toEqual({ triggerTurn: true, deliverAs: "aside" });
		expect(mail?.details).toMatchObject({ kind: "question", from: a, id: `ask-${a}-q1` });
		expect(mail?.content).toContain("어떤 문구가 어디에 떴나요?");
		expect(mail?.content).toContain('"omp를 사용할 수 없어요" (상단 띠)');
		expect(mail?.content).toContain("ompdesk_session_answer");
		expect(host.reviewChanged).toHaveBeenCalledWith("boss0001");
		expect((await service.reviewItems("boss0001")).find(item => item.tabId === a)?.waiting).toBe(true);
		// The same card announced again (a re-attached link) is not a second message.
		await service.childAsked("boss0001", a, "q1");
		expect(host.mails).toHaveLength(1);
		// Answered: no longer waiting.
		await service.run("boss0001", T.answer, { session: a, choice: "다른 문구" });
		expect((await service.reviewItems("boss0001")).find(item => item.tabId === a)?.waiting).toBeUndefined();
		// A session it did not open, or a card that is gone, tells nobody.
		await service.childAsked(b, a, "q1");
		await service.childAsked("boss0001", a, "gone");
		expect(host.mails).toHaveLength(1);
	});

	it("never mails the opener about OMPdesk's own confirmation card or a session hidden from agents", async () => {
		const { host, service, a, b } = await family();
		const first = host.tabsById.get(a);
		const second = host.tabsById.get(b);
		if (!first || !second) throw new Error("no children");
		first.asks = [select("[OMPdesk] Delete a session?", ["Yes", "No"])];
		second.asks = [select("Pick one", ["x", "y"])];
		second.hidden = true;
		await service.childAsked("boss0001", a, "req1");
		await service.childAsked("boss0001", b, "req1");
		expect(host.mails).toHaveLength(0);
	});

	it("ignores a report for a superseded dispatch and delivers a repeated report id once", async () => {
		const { host, service, a } = await family();
		await service.run("boss0001", T.send, { session: a, message: "New plan" });
		const stale = await service.run(a, T.report, { kind: "done", text: "old work", dispatch: "d1" });
		expect(stale.text).toMatch(/Ignored: dispatch d1 is no longer current .* dispatch d2/);
		expect(host.mails).toHaveLength(0);
		await service.run(a, T.report, { kind: "done", text: "new work", dispatch: "d2", id: "r1" });
		const again = await service.run(a, T.report, { kind: "done", text: "new work", dispatch: "d2", id: "r1" });
		expect(again.text).toMatch(/already delivered/);
		expect(host.mails).toHaveLength(1);
	});

	it("coalesces progress into its latest report, without a turn, and a done supersedes the pending progress", async () => {
		const { host, service, a, fire } = await family();
		await service.run(a, T.report, { kind: "progress", text: "step 1" });
		await service.run(a, T.report, { kind: "progress", text: "step 2" });
		expect(host.mails).toHaveLength(0);
		await fire();
		await Promise.resolve();
		expect(host.mails).toHaveLength(1);
		expect(host.mails[0]?.details).toMatchObject({ text: "step 2", merged: 1 });
		expect(host.mails[0]?.delivery).toEqual({ triggerTurn: false });
		await service.run(a, T.report, { kind: "progress", text: "step 3" });
		await service.run(a, T.report, { kind: "done", text: "finished" });
		await fire();
		await Promise.resolve();
		expect(host.mails.map(mail => mail.details.text)).toEqual(["step 2", "finished"]);
	});

	it("sends progress to a busy opener as a no-turn report, never stock's hidden next-turn queue", async () => {
		const { host, service, a, fire } = await family();
		const boss = host.tabsById.get("boss0001");
		if (boss) boss.busy = true;
		await service.run(a, T.report, { kind: "progress", text: "halfway" });
		await fire();
		await Promise.resolve();
		// The opener's bridge sends it as an aside while its turn runs; stock's hidden `nextTurn` is never used.
		expect(host.mails[0]?.delivery).toEqual({ triggerTurn: false });
	});

	it("lets a child write to a sibling as a note, never to an outsider, and refuses a session nobody opened", async () => {
		const { host, service, a, b } = await family();
		host.add({ tabId: "else0009", title: "Other" });
		await service.run(a, T.report, { kind: "done", to: b, text: "I changed X, rebase" });
		expect(host.mails[0]).toMatchObject({ to: b, details: { kind: "note" } });
		expect((await service.run(a, T.report, { kind: "note", to: "else0009", text: "hi" })).text).toMatch(
			/only to the session that opened you, to a sibling it opened, or to a session working in the same checkout/,
		);
		expect((await service.run("boss0001", T.report, { kind: "done", text: "x" })).text).toMatch(/nobody opened/);
	});

	it("lets any session reach one working in the same checkout: a question wakes it only when idle, a note never", async () => {
		const host = new FakeHost(
			{ tabId: "mine0001", title: "Validation" },
			{ tabId: "peer0002", title: "Rename helper" },
			{ tabId: "priv0003", hidden: true },
			{ tabId: "else0004" },
		);
		host.peers.set("mine0001", ["peer0002", "priv0003"]);
		const service = control(host);
		await service.run("mine0001", T.report, {
			kind: "question",
			to: "peer0002",
			text: "May I commit src/a.ts first?",
		});
		await service.run("mine0001", T.report, { kind: "done", to: "peer0002", text: "Committing src/a.ts now" });
		expect(host.mails.map(mail => [mail.to, mail.details.kind, mail.delivery])).toEqual([
			["peer0002", "question", { triggerTurn: true, deliverAs: "aside" }],
			["peer0002", "note", { triggerTurn: false }],
		]);
		expect((await service.run("mine0001", T.report, { kind: "note", to: "priv0003", text: "x" })).text).toMatch(
			/hid this session/,
		);
		expect((await service.run("mine0001", T.report, { kind: "note", to: "else0004", text: "x" })).text).toMatch(
			/shares no checkout/,
		);
	});

	it("sends with a request id once and returns the first receipt on a repeat", async () => {
		const { host, service, a } = await family();
		const first = await service.run("boss0001", T.send, { session: a, message: "go", request_id: "q1" });
		const again = await service.run("boss0001", T.send, { session: a, message: "go", request_id: "q1" });
		expect(first.text).toMatch(/accepted/);
		expect(again.text).toMatch(/already delivered; nothing sent again/);
		expect(prompts(host, a).filter(prompt => prompt.includes("go"))).toHaveLength(1);
	});
});

describe("mail across failures and relaunches", () => {
	it("keeps a report whose delivery failed undelivered, so the sender's retry with the same id goes through", async () => {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss" });
		const service = control(host);
		const opened = await service.run("boss0001", T.open, { message: "Do A" });
		const child = /Opened session (\w+)/.exec(opened.text)?.[1] as string;
		const original = host.mail;
		host.mail = async () => {
			throw new Error("link down");
		};
		const failed = await service.run(child, T.report, { kind: "done", text: "A finished", id: "r1" });
		expect(failed.isError).toBe(true);
		host.mail = original;
		expect((await service.run(child, T.report, { kind: "done", text: "A finished", id: "r1" })).text).toBe(
			"Delivered.",
		);
		expect(host.mails).toHaveLength(1);
	});

	it("gives the same report the same id without one, so a re-run call is recognized", async () => {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss" });
		const service = control(host);
		const opened = await service.run("boss0001", T.open, { message: "Do A" });
		const child = /Opened session (\w+)/.exec(opened.text)?.[1] as string;
		await service.run(child, T.report, { kind: "done", text: "A finished" });
		await service.run(child, T.report, { kind: "done", text: "A finished" });
		expect(host.mails).toHaveLength(1);
		const rerun = control(host);
		await rerun.run(child, T.report, { kind: "done", text: "A finished" });
		// A relaunched main delivers again; the receiver's bridge drops it by the same id (bridge-agent-mail.test.ts).
		expect(host.mails.map(mail => mail.details.id)).toEqual([host.mails[0]?.details.id, host.mails[0]?.details.id]);
	});

	it("after a relaunch reads the child's dispatch and the request ids back from its journal", async () => {
		const host = new FakeHost(
			{ tabId: "boss0001", title: "Boss" },
			{
				tabId: "kid00002",
				messages: [
					{
						role: "user",
						content: wrapAgentMessage(
							'Do A\n\n[ompdesk dispatch d2: report with ompdesk_report, dispatch "d2"]\n[ompdesk request q7]',
							"Boss",
						),
					} as AgentMessage,
				],
			},
		);
		host.parents.set("kid00002", "boss0001");
		const relaunched = control(host);
		const stale = await relaunched.run("kid00002", T.report, { kind: "done", text: "old", dispatch: "d1" });
		expect(stale.text).toMatch(/Ignored: dispatch d1/);
		const again = await relaunched.run("boss0001", T.send, { session: "kid00002", message: "x", request_id: "q7" });
		expect(again.text).toMatch(/request q7 was already delivered/);
		expect(prompts(host, "kid00002")).toEqual([]);
		await relaunched.run("boss0001", T.send, { session: "kid00002", message: "next" });
		expect(prompts(host, "kid00002")[0]).toContain("dispatch d3");
	});
});

describe("closing and stopping: ownership after a relaunch, cards by risk", () => {
	it("a relaunch keeps ownership: the caller closes and stops its own child with no card", async () => {
		const host = new FakeHost(
			{ tabId: "boss0001", title: "Boss" },
			{ tabId: "kid00002", title: "Phone input", busy: true },
		);
		// What the pool kept across the relaunch: the child's opener (main's memory of the open is gone).
		host.parents.set("kid00002", "boss0001");
		const relaunched = control(host);
		const stopped = await relaunched.run("boss0001", T.stop, { session: "kid00002", close: true });
		expect(stopped.isError, stopped.text).toBe(false);
		expect(host.cards).toHaveLength(0);
		expect(host.views).toContainEqual({ tabId: "kid00002", how: "close" });
	});

	it("closes an idle session it did not open with no card, and says so in both sessions", async () => {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss" }, { tabId: "else0002", title: "Done work" });
		const result = await control(host).run("boss0001", T.stop, { session: "else0002", close: true });
		expect(result.text).toContain("Closed");
		expect(host.cards).toHaveLength(0);
		expect(host.sent.some(entry => entry.command.type === "abort")).toBe(false);
		expect(host.mails.map(mail => mail.to).sort()).toEqual(["boss0001", "else0002"]);
		expect(host.mails.every(mail => mail.delivery.triggerTurn === false)).toBe(true);
	});

	it("replies to a close once the closed session's omp has exited: until then its folder cannot be removed", async () => {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss" }, { tabId: "else0002", title: "Done work" });
		const { pendingWhileRunning, result } = await whileOmpRuns(host, () =>
			control(host).run("boss0001", T.stop, { session: "else0002", close: true }),
		);
		expect(pendingWhileRunning).toBe(true);
		expect(result.text).toContain("Closed");
	});

	it("still asks before stopping a running session it did not open, and before deleting one", async () => {
		const host = new FakeHost(
			{ tabId: "boss0001", title: "Boss" },
			{ tabId: "busy0002", title: "Busy", busy: true },
			{ tabId: "idle0003", title: "Idle", sessionPath: "/s/i.jsonl" },
		);
		host.cardAnswer = false;
		const service = control(host);
		expect((await service.run("boss0001", T.stop, { session: "busy0002", close: true })).text).toMatch(/declined/);
		expect((await service.run("boss0001", T.stop, { session: "idle0003", delete: true })).text).toMatch(/declined/);
		expect(host.cards).toHaveLength(2);
		expect(host.views).toEqual([]);
	});

	describe("in a turn the user's own message did not start", () => {
		const actions = [{}, { close: true }, { delete: true }];
		const pendingNotes = (host: FakeHost, boss: FakeTab) => {
			boss.busy = false;
			return async (service: AgentControl) => {
				await service.personTyped("boss0001");
				return host.mails.filter(mail => mail.to === "boss0001" && mail.content.includes("pending cleanups"));
			};
		};

		it("stops, closes and deletes a session it opened that the user looks at, and keeps no pending cleanup", async () => {
			for (const args of actions) {
				const host = new FakeHost(
					{ tabId: "boss0001", title: "Boss", busy: true, personTurn: false, sessionPath: "/s/boss.jsonl" },
					{
						tabId: "seen0002",
						title: "Seen",
						looked: true,
						busy: true,
						status: "running",
						sessionPath: "/s/a.jsonl",
					},
				);
				host.parents.set("seen0002", "boss0001");
				const service = control(host);
				const result = await service.run("boss0001", T.stop, { session: "seen0002", ...args });
				const label = JSON.stringify(args);
				expect(result.isError, `${label} ${result.text}`).toBe(false);
				expect(
					host.sent.filter(entry => entry.command.type === "abort").map(entry => entry.tabId),
					label,
				).toEqual(["seen0002"]);
				if ("close" in args) expect(host.views, label).toContainEqual({ tabId: "seen0002", how: "close" });
				if ("delete" in args) expect(host.deleted, label).toEqual(["seen0002"]);
				expect(host.cards, label).toEqual([]);
				expect(await pendingNotes(host, host.tabsById.get("boss0001") as FakeTab)(service), label).toEqual([]);
			}
		});

		it("refuses a session it opened that the user typed into, and keeps the call as a pending cleanup", async () => {
			for (const args of actions) {
				const host = new FakeHost(
					{ tabId: "boss0001", title: "Boss", busy: true, personTurn: false, sessionPath: "/s/boss.jsonl" },
					{ tabId: "typed003", title: "Typed", looked: true, userTouched: true, sessionPath: "/s/b.jsonl" },
				);
				host.parents.set("typed003", "boss0001");
				const service = control(host);
				const refused = await service.run("boss0001", T.stop, { session: "typed003", ...args });
				expect(refused.isError).toBe(true);
				expect(refused.text).toMatch(/typed into it/);
				expect(refused.text).toContain("pending cleanup");
				expect(host.views).toEqual([]);
				expect(host.deleted).toEqual([]);
				expect(await pendingNotes(host, host.tabsById.get("boss0001") as FakeTab)(service)).toHaveLength(1);
			}
		});

		it("refuses a session it did not open that the user looks at", async () => {
			for (const args of actions) {
				const host = new FakeHost(
					{ tabId: "boss0001", title: "Boss", busy: true, personTurn: false, sessionPath: "/s/boss.jsonl" },
					{ tabId: "seen0002", title: "Seen", looked: true, sessionPath: "/s/a.jsonl" },
				);
				const service = control(host);
				const refused = await service.run("boss0001", T.stop, { session: "seen0002", ...args });
				expect(refused.isError).toBe(true);
				expect(refused.text).toMatch(/in the user's view and you did not open it/);
				expect(host.views).toEqual([]);
				expect(host.deleted).toEqual([]);
				expect(host.cards).toEqual([]);
			}
		});
	});

	it("stops, closes or deletes a session the user looks at or typed into when the user's own message started the turn", async () => {
		for (const args of [{}, { close: true }, { delete: true }]) {
			const host = new FakeHost(
				{ tabId: "boss0001", title: "Boss", busy: true, personTurn: true },
				{
					tabId: "seen0002",
					title: "Seen",
					looked: true,
					busy: true,
					status: "running",
					sessionPath: "/s/a.jsonl",
				},
				{ tabId: "typed003", title: "Typed", userTouched: true, sessionPath: "/s/b.jsonl" },
			);
			host.parents.set("seen0002", "boss0001");
			const service = control(host);
			for (const session of ["seen0002", "typed003"]) {
				const result = await service.run("boss0001", T.stop, { session, ...args });
				expect(result.isError, result.text).toBe(false);
			}
			if ("close" in args) expect(host.views.map(view => view.tabId).sort()).toEqual(["seen0002", "typed003"]);
		}
	});

	it("refuses to stop, close or delete a session the user typed into, or one it did not open that they look at, in a turn an agent's message started", async () => {
		for (const args of [{}, { close: true }, { delete: true }]) {
			const host = new FakeHost(
				{ tabId: "boss0001", title: "Boss", busy: true, personTurn: false },
				{
					tabId: "seen0002",
					title: "Seen",
					looked: true,
					busy: true,
					status: "running",
					sessionPath: "/s/a.jsonl",
				},
				{ tabId: "typed003", title: "Typed", userTouched: true, sessionPath: "/s/b.jsonl" },
			);
			host.parents.set("typed003", "boss0001");
			const service = control(host);
			for (const session of ["seen0002", "typed003"]) {
				const refused = await service.run("boss0001", T.stop, { session, ...args });
				expect(refused.isError).toBe(true);
				expect(refused.text).toMatch(/not started by the user's own message/);
			}
			expect(host.views).toEqual([]);
			expect(host.sent.filter(entry => entry.command.type === "abort")).toEqual([]);
		}
	});

	it("joins two same-request sends arriving together into one delivery", async () => {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss" }, { tabId: "kid00002" });
		const service = control(host);
		const args = { session: "kid00002", message: "go", request_id: "q1" };
		const [one, two] = await Promise.all([
			service.run("boss0001", T.send, args),
			service.run("boss0001", T.send, args),
		]);
		expect([one.isError, two.isError]).toEqual([false, false]);
		expect(prompts(host, "kid00002")).toHaveLength(1);
		expect([one.text, two.text].some(text => text.includes("nothing sent again"))).toBe(true);
	});
});

describe("a close is told only once the tab is gone", () => {
	const closeArgs = { session: "kid00002", close: true };

	it("sends no close note when the window kept the tab, and says it is still open", async () => {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss" }, { tabId: "kid00002", title: "Kid" });
		host.parents.set("kid00002", "boss0001");
		host.refuseClose.add("kid00002");
		const result = await shortWaits(() => control(host).run("boss0001", T.stop, closeArgs));
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/still open/);
		expect(host.mails).toEqual([]);
	});

	it("mails the note after the window dropped the tab, and keeps asking a desktop window to close it", async () => {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss" }, { tabId: "kid00002", title: "Kid" });
		host.parents.set("kid00002", "boss0001");
		const result = await control(host).run("boss0001", T.stop, closeArgs);
		expect(result.text).toContain("Closed");
		expect(host.releases).toEqual([]);
		expect(host.order).toEqual(["view:close:kid00002", "mail:boss0001", "mail:kid00002"]);
	});
});

describe("closing a tab a paired web page owns", () => {
	const closeArgs = { session: "web00002", close: true };
	const phoneChild = (webEdits: "clean" | "dirty" | "unreported", patch: Partial<FakeTab> = {}) => {
		const host = new FakeHost(
			{ tabId: "boss0001", title: "Boss" },
			{ tabId: "web00002", title: "Phone child", webEdits, ...patch },
		);
		host.parents.set("web00002", "boss0001");
		return { host, service: control(host) };
	};

	it("releases it in main when its page reported no unsaved edits, then mails the close note", async () => {
		const { host, service } = phoneChild("clean");
		const result = await service.run("boss0001", T.stop, closeArgs);
		expect(result.isError, result.text).toBe(false);
		expect(result.text).toContain("Closed");
		expect(host.views).toEqual([]);
		expect(host.releases).toEqual(["web00002"]);
		expect(host.order).toEqual(["release:web00002", "mail:boss0001", "mail:web00002"]);
	});

	it("keeps it, mails nothing and names the unsaved edits when the page reported them in that tab", async () => {
		const { host, service } = phoneChild("dirty");
		const result = await service.run("boss0001", T.stop, closeArgs);
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/unsaved edits in the Files editor/);
		expect(host.releases).toEqual([]);
		expect(host.views).toEqual([]);
		expect(host.mails).toEqual([]);
		expect(host.tabsById.has("web00002")).toBe(true);
	});

	it("releases it at once, with one close note, when its page has not reported (offline, or not seen since launch)", async () => {
		const { host, service } = phoneChild("unreported");
		const result = await service.run("boss0001", T.stop, closeArgs);
		expect(result.isError, result.text).toBe(false);
		expect(result.text).toMatch(/^Closed/);
		expect(host.releases).toEqual(["web00002"]);
		expect(host.views).toEqual([]);
		expect(host.order).toEqual(["release:web00002", "mail:boss0001", "mail:web00002"]);
		expect(host.tabsById.has("web00002")).toBe(false);
	});

	it("releases a tab it opened that the person looks at, never one they typed into, when its page reported it clean", async () => {
		const seen = phoneChild("clean", { looked: true });
		const closed = await seen.service.run("boss0001", T.stop, closeArgs);
		expect(closed.isError, closed.text).toBe(false);
		expect(seen.host.releases).toEqual(["web00002"]);

		const typed = phoneChild("clean", { looked: true, userTouched: true });
		const refused = await typed.service.run("boss0001", T.stop, closeArgs);
		expect(refused.isError).toBe(true);
		expect(refused.text).toMatch(/typed into it/);
		expect(typed.host.releases).toEqual([]);
	});

	it("auto-closes a finished web child in main unless its page reported unsaved edits in that tab", async () => {
		const kept = await finishedWebChild("dirty");
		await kept.service.autoClose("main0001");
		expect(kept.host.releases).toEqual([]);
		expect(kept.host.views).toEqual([]);
		expect(kept.host.closedRecords).toEqual([]);
		expect(kept.host.tabsById.has(kept.child.tabId)).toBe(true);
		for (const webEdits of ["clean", "unreported"] as const) {
			const { host, service, child } = await finishedWebChild(webEdits);
			await service.autoClose("main0001");
			expect(host.releases, webEdits).toEqual([child.tabId]);
			expect(host.views, webEdits).toEqual([]);
			expect(host.closedRecords, webEdits).toHaveLength(1);
		}
	});

	it("auto-closes a finished Result: problem web child in main once its opener read it", async () => {
		const { host, service, child } = await finishedWebChild("unreported", "Broke it.\nResult: problem — broke it");
		await service.autoClose("main0001");
		await service.autoClose("main0001");
		expect(host.releases).toEqual([child.tabId]);
		expect(host.closedRecords).toHaveLength(1);
	});

	async function finishedWebChild(
		webEdits: "clean" | "dirty" | "unreported",
		last = "Done: parser fixed.\nResult: ok",
	) {
		const host = new FakeHost({ tabId: "main0001", title: "Boss", sessionPath: "/s/boss.jsonl" });
		const service = control(host);
		await service.run("main0001", T.open, { message: "do it" });
		const child = [...host.tabsById.values()].find(tab => tab.tabId !== "main0001") as FakeTab;
		Object.assign(child, {
			busy: false,
			title: "Fix the parser",
			sessionPath: "/s/kid.jsonl",
			autoClosable: true,
			lastRun: { stopReason: "stop" },
			last,
			webEdits,
		});
		return { host, service, child };
	}
});

/**
 * Every path that closes a tab for an agent applies the one rule (`tabCloseStep`), with nothing of its own on top: an
 * explicit `ompdesk_session_stop {close}`, the auto-close pass and a failed open's cleanup (Autopilot's source tab:
 * "releases the tab it opened to start from…" under `ompdesk_autopilot`). A path may stop earlier (stop refuses a tab
 * the person is at, auto-close keeps it), never release or ask the window against the rule.
 */
/**
 * The rule as the close paths must apply it (`rules/tab_close.rs` in the core): a desktop tab is asked of its window, a
 * paired web page's tab is kept when its page holds unsaved Files edits or, unless the close was cleared, when the
 * person is at it, and released otherwise.
 */
function expectedStep(tab: Partial<FakeTab>, cleared: boolean): { action: "ask-window" | "release" | "keep" } {
	if (tab.webEdits === undefined) return { action: "ask-window" };
	if (tab.webEdits === "dirty") return { action: "keep" };
	if (!cleared && (tab.userTouched === true || tab.looked === true)) return { action: "keep" };
	return { action: "release" };
}

describe("every close path follows tabCloseStep", () => {
	const EDITS: (FileEdits | undefined)[] = [undefined, "clean", "unreported", "dirty"];
	const PEOPLE: Partial<FakeTab>[] = [{}, { looked: true }, { userTouched: true }];

	const paths: Record<string, (patch: Partial<FakeTab>) => Promise<{ host: FakeHost; child: string }>> = {
		stop: async patch => {
			const host = new FakeHost({ tabId: "boss0001", title: "Boss" }, { tabId: "kid00002", title: "Kid", ...patch });
			host.parents.set("kid00002", "boss0001");
			await control(host).run("boss0001", T.stop, { session: "kid00002", close: true });
			return { host, child: "kid00002" };
		},
		autoClose: async patch => {
			const host = new FakeHost({ tabId: "main0001", title: "Boss", sessionPath: "/s/boss.jsonl" });
			const service = control(host);
			await service.run("main0001", T.open, { message: "do it" });
			const child = [...host.tabsById.values()].find(tab => tab.tabId !== "main0001") as FakeTab;
			Object.assign(child, {
				busy: false,
				title: "Fix the parser",
				sessionPath: "/s/kid.jsonl",
				autoClosable: true,
				lastRun: { stopReason: "stop" },
				last: "Done: parser fixed.\nResult: ok",
				...patch,
			});
			await service.autoClose("main0001");
			return { host, child: child.tabId };
		},
		failedOpen: async patch => {
			const host = new FakeHost({ tabId: "main0001" });
			host.beforeFirstPromptError = new Error("guard failed");
			host.spawnPatch = patch;
			await shortWaits(() => control(host).run("main0001", T.open, { message: "go" }));
			return { host, child: host.first[0]?.tabId ?? "" };
		},
	};

	for (const [name, path] of Object.entries(paths)) {
		it(`${name}: releases only what the rule releases, asks the window only what it asks`, async () => {
			for (const webEdits of EDITS)
				for (const person of PEOPLE) {
					const patch: Partial<FakeTab> = { ...(webEdits ? { webEdits } : {}), ...person };
					const step = expectedStep(patch, name === "stop" && patch.userTouched !== true);
					const { host, child } = await path(patch);
					const label = JSON.stringify(patch);
					expect(child, label).not.toBe("");
					const released = host.releases.includes(child);
					const asked = host.views.some(view => view.tabId === child && view.how === "close");
					if (released) expect(step.action, label).toBe("release");
					if (asked) expect(step.action, label).toBe("ask-window");
					// Nobody at the tab: nothing upstream stops the close, so the rule alone decides.
					if (Object.keys(person).length === 0) {
						expect(released, label).toBe(step.action === "release");
						expect(asked, label).toBe(step.action === "ask-window");
					}
				}
		});
	}
});

describe("after a relaunch: ids, titles, and messages a busy child waits for", () => {
	it("resolves an id the agent was given before a relaunch to the same session, never another", async () => {
		const host = new FakeHost(
			{ tabId: "boss0001", title: "Boss" },
			// The relaunch gave the child a new id; its tab remembers the ones it had (the saved tab layout).
			{ tabId: "kidnew02", title: "Fix the parser", sessionPath: "/s/kid.jsonl", formerIds: ["kidold02"] },
			{ tabId: "else0003", title: "Other", sessionPath: "/s/else.jsonl" },
		);
		host.parents.set("kidnew02", "boss0001");
		const service = control(host);
		const sent = await service.run("boss0001", T.send, { session: "kidold02", message: "carry on" });
		expect(sent.isError).toBe(false);
		expect(prompts(host, "kidnew02")).toHaveLength(1);
		expect(prompts(host, "else0003")).toHaveLength(0);
		expect((await service.run("boss0001", T.result, { session: "kidold02" })).text).toContain("[kidnew02]");
		expect((await service.run("boss0001", T.send, { session: "kidold99", message: "x" })).text).toMatch(/No session/);
	});

	it("names a restored or reopened child by its saved title, else the task of its first message", async () => {
		const host = new FakeHost(
			{ tabId: "boss0001", title: "Boss" },
			{ tabId: "kid00002", sessionPath: "/s/kid.jsonl", cwd: "/wt/gui-agent-abc" },
			{ tabId: "named003", sessionPath: "/s/named.jsonl", cwd: "/wt/gui-agent-def" },
		);
		host.storedRows = [
			storedRow({
				id: "aaaa",
				path: "/s/kid.jsonl",
				title: "",
				firstMessage: wrapAgentMessage("Title: Fix the parser\nparse.ts drops a field.", "Boss"),
			}),
			storedRow({ id: "bbbb", path: "/s/named.jsonl", title: "Ship the release" }),
		];
		const service = control(host);
		const listed = await service.run("boss0001", T.list, {});
		expect(listed.text).toContain('"Fix the parser"');
		expect(listed.text).toContain('"Ship the release"');
		expect(listed.text).not.toContain("untitled");
		// The pool learns it too, so the sidebar, the board and the next call read it.
		expect(host.tasks.get("kid00002")).toBe("Fix the parser");
		expect((await service.run("boss0001", T.send, { session: "kid00002", message: "x" })).text).toContain(
			'"Fix the parser"',
		);
	});

	it("steers a running session by default, and queues a follow-up only when asked", async () => {
		// The owner's call (6 Nov 2026): an agent's instruction to a running session waited for that session's whole turn.
		const host = new FakeHost({ tabId: "boss0001", title: "Boss" });
		const service = control(host);
		const opened = await service.run("boss0001", T.open, { message: "Title: part A\nDo A" });
		const kid = /Opened session (\w+)/.exec(opened.text)?.[1] as string;
		const behavior = () => {
			const last = host.sent.filter(entry => entry.tabId === kid && entry.command.type === "prompt").at(-1)?.command;
			return last?.type === "prompt" ? last.streamingBehavior : undefined;
		};
		const now = await service.run("boss0001", T.send, { session: kid, message: "Stop at B" });
		expect(now.text).toContain("delivered as steer (it reads it between steps)");
		expect(behavior()).toBe("steer");
		const later = await service.run("boss0001", T.send, { session: kid, message: "Then C", delivery: "follow_up" });
		expect(later.text).toContain("queued as a follow-up");
		expect(behavior()).toBe("followUp");
	});

	it("tells a busy child that reports of a follow-up queued for it, and steers the next one", async () => {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss" });
		const service = control(host);
		const opened = await service.run("boss0001", T.open, { message: "Title: part A\nDo A" });
		const kid = /Opened session (\w+)/.exec(opened.text)?.[1] as string;
		// The child works (its first prompt made it busy); the opener queues more work behind its turn.
		const queued = await service.run("boss0001", T.send, {
			session: kid,
			message: "Also do C",
			delivery: "follow_up",
		});
		expect(queued.text).toContain("queued as a follow-up");
		// It reports done and would keep waiting in the same turn: the report must say a message waits for it.
		const report = await service.run(kid, T.report, { kind: "done", text: "A done", dispatch: "d2" });
		expect(report.text).toMatch(/d2/);
		expect(report.text).toMatch(/waiting for you|waits for you/);
		expect(report.text).toMatch(/end (this|your) turn/i);
		// A message sent after it reported in this turn reaches it between its steps.
		const next = await service.run("boss0001", T.send, { session: kid, message: "And D" });
		expect(next.text).toContain("steer");
		const last = host.sent.filter(entry => entry.tabId === kid && entry.command.type === "prompt").at(-1)?.command;
		expect(last?.type === "prompt" ? last.streamingBehavior : undefined).toBe("steer");
	});

	it("says nothing about a follow-up the child already read", async () => {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss" });
		const service = control(host);
		const opened = await service.run("boss0001", T.open, { message: "Do A" });
		const kid = /Opened session (\w+)/.exec(opened.text)?.[1] as string;
		await service.run("boss0001", T.send, { session: kid, message: "Also do C", delivery: "follow_up" });
		const tab = host.tabsById.get(kid);
		if (tab)
			tab.messages = [
				{
					role: "user",
					content: [{ type: "text", text: prompts(host, kid).at(-1) as string }],
					timestamp: 1,
				} as AgentMessage,
			];
		const report = await service.run(kid, T.report, { kind: "done", text: "C done", dispatch: "d2" });
		expect(report.text).toBe("Delivered.");
	});
});

/**
 * Every control tool in every situation an agent meets: a local tab, a paired device's tab, a deferred (not started)
 * tab, a saved session no tab holds, a busy session, a device whose link is (re)connecting, a session hidden from
 * agents; named by tab id, an id it had before a relaunch, its saved (stock) id, a unique id prefix and its title.
 * An error that remains says what to do next.
 */
describe("situation matrix", () => {
	const LOCAL_STOCK = "aaaaaaaa-1111-7000-8000-000000000001";
	const file = (id: string) => `/s/p/2026-10-20T00-00-00-000Z_${id}.jsonl`;
	const said = (text: string): AgentMessage[] => [
		{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 1 } as AgentMessage,
	];
	const offline = (): RpcResponse =>
		({
			type: "response",
			success: false,
			error: "The device running this tab is offline",
			code: "remote_offline",
		}) as RpcResponse;

	/** The fake as main behaves: a paired device's tab refuses while its link is down; stock's abort unwinds slowly. */
	class MatrixHost extends FakeHost {
		/** When stock's abort answers (ms after it is sent); null: never. The turn ends at the same moment. */
		abortAfter: number | null = 200;
		constructor(...tabs: Partial<FakeTab>[]) {
			super(...tabs);
			const base = this.command;
			this.command = async (tabId, command, timeoutMs?: number) => {
				const tab = this.tabsById.get(tabId);
				const device = tab?.device ? this.deviceList.find(entry => entry.id === tab.device) : undefined;
				if (device && device.state !== "online") {
					this.sent.push({ tabId, command });
					return offline();
				}
				if (command.type !== "abort") return base(tabId, command);
				this.sent.push({ tabId, command });
				const limit = timeoutMs ?? 8_000;
				const answer = Promise.withResolvers<RpcResponse>();
				// The turn unwinds `abortAfter` ms in; stock answers then, unless the RPC call timed out first.
				if (this.abortAfter !== null)
					setTimeout(() => {
						if (tab) tab.busy = false;
						this.emit();
						answer.resolve(ok());
					}, this.abortAfter);
				setTimeout(() => answer.reject(new Error(`RPC timeout (${limit}ms): abort`)), limit);
				return answer.promise;
			};
			const stored = this.storedMessages;
			this.storedMessages = async row => {
				const device = row.device ? this.deviceList.find(entry => entry.id === row.device) : undefined;
				if (device && device.state !== "online") throw new Error(`[remote_offline] ${device.name} is offline`);
				return stored(row);
			};
			this.deleteSession = async (_caller, tabId) => {
				if (this.tabsById.get(tabId)?.busy) throw new Error("[session_running] That session is running a turn");
				this.deleted.push(tabId);
				this.tabsById.delete(tabId);
			};
		}
	}

	function world(options: { linkBlips?: boolean } = {}): MatrixHost {
		const host = new MatrixHost(
			{ tabId: "boss0001", title: "Boss" },
			{
				tabId: "loca1111",
				title: "Local worker",
				sessionPath: file(LOCAL_STOCK),
				last: "local answer",
				messages: said("local answer"),
			},
			{
				tabId: "remo2222",
				title: "Remote worker",
				device: "pc",
				deviceName: "PC",
				sessionPath: "C:/s/2026-10-20T00-00-00-000Z_bbbbbbbb-2222.jsonl",
				last: "remote answer",
				messages: said("remote answer"),
			},
			{ tabId: "slep3333", title: "Sleeper", status: "asleep", sessionPath: file("eeeeeeee-3333") },
			{ tabId: "busy4444", title: "Busy builder", busy: true, busySince: 1, sessionPath: file("ffffffff-4444") },
			{
				tabId: "blip5555",
				title: "Blip worker",
				device: "lap",
				deviceName: "Laptop",
				status: "error",
				last: "blip answer",
				messages: said("blip answer"),
			},
			{ tabId: "hide6666", title: "Hidden", hidden: true },
			{ tabId: "relc7777", title: "Relaunched child", formerIds: ["gone8888"], messages: said("relaunched answer") },
		);
		host.full = true;
		host.deviceList = [
			{ id: "pc", name: "PC", state: "online" },
			{ id: "lap", name: "Laptop", state: "connecting" },
		];
		host.storedRows = [
			storedRow({ id: "cccccccc-3333", path: file("cccccccc-3333"), title: "Old notes" }),
			storedRow({
				id: "dddddddd-4444",
				path: "L:/s/2026-10-20T00-00-00-000Z_dddddddd-4444.jsonl",
				title: "Laptop notes",
				device: "lap",
				deviceName: "Laptop",
			}),
		];
		host.storedTranscripts.set(file("cccccccc-3333"), said("stored answer"));
		host.storedTranscripts.set(file("eeeeeeee-3333"), said("sleeper answer"));
		host.storedTranscripts.set("L:/s/2026-10-20T00-00-00-000Z_dddddddd-4444.jsonl", said("laptop answer"));
		// The Laptop's link was blipping: it comes back 100 ms in (2 s on the clock the waits had; the link wait is
		// 300 ms here, `SHORT_WAITS`), and its tab re-attaches.
		if (options.linkBlips !== false)
			setTimeout(() => {
				const lap = host.deviceList.find(device => device.id === "lap");
				if (lap) lap.state = "online";
				const blip = host.tabsById.get("blip5555");
				if (blip) blip.status = "ready";
				host.emit();
			}, 100);
		return host;
	}

	type Cell = {
		tool: (typeof T)[keyof typeof T];
		args: Record<string, unknown>;
		/** What the answer says; `error` cells must also say what to do next. */
		ok?: RegExp;
		error?: RegExp;
		setup?: (host: MatrixHost) => void;
	};

	const cells: Record<string, Cell> = {
		"read · local tab id": { tool: T.read, args: { session: "loca1111" }, ok: /local answer/ },
		"read · id prefix": { tool: T.read, args: { session: "loca" }, ok: /local answer/ },
		"read · id from before a relaunch": { tool: T.read, args: { session: "gone8888" }, ok: /relaunched answer/ },
		"read · saved id of an open tab": { tool: T.read, args: { session: LOCAL_STOCK }, ok: /local answer/ },
		"read · saved id prefix of an open tab": { tool: T.read, args: { session: "aaaaaaaa" }, ok: /local answer/ },
		"read · title": { tool: T.read, args: { session: "Local worker" }, ok: /local answer/ },
		"read · title prefix, any case": { tool: T.read, args: { session: "local wor" }, ok: /local answer/ },
		"read · paired device's tab": { tool: T.read, args: { session: "remo2222" }, ok: /remote answer/ },
		"read · device reconnecting": { tool: T.read, args: { session: "blip5555" }, ok: /blip answer/ },
		"read · saved only": { tool: T.read, args: { session: "cccccccc-3333" }, ok: /stored answer/ },
		"read · deferred tab, by title": { tool: T.read, args: { session: "Sleeper" }, ok: /sleeper answer/ },
		"read · saved on a reconnecting device, never listed": {
			tool: T.read,
			args: { session: "dddddddd-4444" },
			ok: /laptop answer/,
		},
		"read · hidden": { tool: T.read, args: { session: "hide6666" }, error: /hid this session.*Ask them/ },
		"read · unknown": { tool: T.read, args: { session: "nothing-like-it" }, error: /ompdesk_sessions/ },

		"send · local": { tool: T.send, args: { session: "loca1111", message: "go" }, ok: /Sent to/ },
		"send · title": { tool: T.send, args: { session: "Busy builder", message: "go" }, ok: /delivered as steer/ },
		"send · saved id of an open tab": { tool: T.send, args: { session: LOCAL_STOCK, message: "go" }, ok: /Sent to/ },
		"send · paired device": { tool: T.send, args: { session: "remo2222", message: "go" }, ok: /Sent to/ },
		"send · device reconnecting": { tool: T.send, args: { session: "blip5555", message: "go" }, ok: /Sent to/ },
		"send · deferred tab": { tool: T.send, args: { session: "slep3333", message: "go" }, ok: /Sent to/ },
		"send · saved only": {
			tool: T.send,
			args: { session: "cccccccc-3333", message: "go" },
			error: /not open.*"reopen":"cccccccc-3333"/,
		},
		"send · hidden": { tool: T.send, args: { session: "hide6666", message: "go" }, error: /hid this session/ },

		"result · local": { tool: T.result, args: { session: "loca1111" }, ok: /idle[\s\S]*local answer/ },
		"result · title": { tool: T.result, args: { session: "Remote worker" }, ok: /remote answer/ },
		"result · device reconnecting": { tool: T.result, args: { session: "blip5555" }, ok: /idle[\s\S]*blip answer/ },
		"result · deferred tab": { tool: T.result, args: { session: "slep3333" }, ok: /not started/ },
		"result · saved only": {
			tool: T.result,
			args: { session: "cccccccc-3333" },
			ok: /Old notes[\s\S]*stored answer/,
		},

		"answer · nothing asked": {
			tool: T.answer,
			args: { session: "loca1111", choice: "Yes" },
			error: /not waiting for an answer.*ompdesk_session_result/,
		},
		"answer · device reconnecting": {
			tool: T.answer,
			args: { session: "blip5555", approve: true },
			error: /not waiting for an answer/,
		},
		"answer · saved only": {
			tool: T.answer,
			args: { session: "cccccccc-3333", approve: true },
			error: /not open.*"reopen":"cccccccc-3333"/,
		},

		"focus · title": { tool: T.focus, args: { session: "Sleeper" }, ok: /Showing/ },
		"focus · saved only": {
			tool: T.focus,
			args: { session: "cccccccc-3333" },
			error: /not open.*"reopen":"cccccccc-3333"/,
		},

		"stop · busy, abort slower than 8 s": { tool: T.stop, args: { session: "busy4444" }, ok: /^Stopped/ },
		"stop · busy, abort never answers": {
			tool: T.stop,
			args: { session: "busy4444" },
			ok: /has not confirmed.*"close": true/,
			setup: host => {
				host.abortAfter = null;
			},
		},
		"stop · close busy, abort slower than 8 s": {
			tool: T.stop,
			args: { session: "busy4444", close: true },
			ok: /^Closed/,
		},
		"stop · close busy, abort never answers": {
			tool: T.stop,
			args: { session: "busy4444", close: true },
			ok: /^Closed/,
			setup: host => {
				host.abortAfter = null;
			},
		},
		"stop · delete busy, abort slower than 8 s": {
			tool: T.stop,
			args: { session: "busy4444", delete: true },
			ok: /deleted/,
		},
		"stop · close on a reconnecting device": {
			tool: T.stop,
			args: { session: "blip5555", close: true },
			ok: /^Closed/,
		},
		"stop · saved only": { tool: T.stop, args: { session: "cccccccc-3333" }, ok: /not open in any tab/ },
		"stop · hidden": { tool: T.stop, args: { session: "hide6666", close: true }, error: /hid this session/ },

		"merge · saved only": { tool: T.merge, args: { session: "cccccccc-3333" }, error: /not open.*"reopen"/ },
		"report · to a title": {
			tool: T.report,
			args: { to: "Local worker", kind: "note", text: "fyi" },
			ok: /Delivered/,
			setup: host => {
				host.peers.set("boss0001", ["loca1111"]);
			},
		},

		"sessions · stored on a reconnecting device": {
			tool: T.list,
			args: { scope: "stored", device: "Laptop" },
			ok: /Laptop notes/,
		},
		"sessions · a reconnecting device's open tabs": {
			tool: T.list,
			args: { device: "Laptop" },
			ok: /Blip worker[\s\S]*idle/,
		},
		"open · reopen a saved session of a reconnecting device, never listed": {
			tool: T.open,
			args: { reopen: "dddddddd-4444", device: "Laptop" },
			ok: /Opened session/,
		},
		"open · on a reconnecting device": {
			tool: T.open,
			args: { message: "build it", device: "Laptop", folder: "L:/repo" },
			ok: /Opened session/,
		},
		"schedule · list on a reconnecting device": {
			tool: T.schedule,
			args: { action: "list", device: "Laptop" },
			ok: /schedule|No scheduled/i,
		},
	};

	it.each(Object.entries(cells))("%s", async (_name, cell) => {
		const outcome = await shortWaits(() => {
			const host = world();
			cell.setup?.(host);
			return control(host).run("boss0001", cell.tool, cell.args);
		});
		if (cell.error) {
			expect(outcome.isError, outcome.text).toBe(true);
			expect(outcome.text).toMatch(cell.error);
		} else {
			expect(outcome.isError, outcome.text).toBe(false);
			expect(outcome.text).toMatch(cell.ok as RegExp);
		}
	});

	it("waits a bounded moment only: a device that stays away fails within 20 s and says what to do", async () => {
		const { outcome, waited } = await shortWaits(async () => {
			// The Laptop never comes back this time.
			const host = world({ linkBlips: false });
			const lap = host.deviceList.find(device => device.id === "lap");
			if (lap) lap.state = "offline";
			const started = Date.now();
			const result = await control(host).run("boss0001", T.list, { scope: "stored", device: "Laptop" });
			return { outcome: result, waited: Date.now() - started };
		});
		expect(outcome.isError).toBe(true);
		expect(waited).toBeLessThanOrEqual(20_000);
		expect(outcome.text).toMatch(/Laptop is offline.*waited/);
		expect(outcome.text).toMatch(/Settings › Devices/);
	});
});

/** Every kind of card a session can wait on: what was given wrong is named with the field that answers it. */
describe("answer matrix", () => {
	const card = (request: Record<string, unknown>): ControlAsk => ({
		id: "req1",
		request: { type: "extension_ui_request", id: "req1", ...request } as ExtensionUIRequest,
	});
	const rows: [string, ControlAsk | null, Record<string, unknown>, { ok?: RegExp; error?: RegExp }][] = [
		[
			"select · no choice",
			card({ method: "select", title: "Pick", options: ["Red", "Blue"] }),
			{},
			{ error: /`choice`.*"Red" \| "Blue"/ },
		],
		[
			"select · approve on a plain choice",
			card({ method: "select", title: "Pick", options: ["Red", "Blue"] }),
			{ approve: true },
			{ error: /`choice`.*"Red" \| "Blue"/ },
		],
		[
			"select · prefix",
			card({ method: "select", title: "Pick", options: ["Red", "Blue"] }),
			{ choice: "bl" },
			{ ok: /"Blue"/ },
		],
		[
			"confirm · nothing",
			card({ method: "confirm", title: "Go on?", message: "" }),
			{},
			{ error: /`approve`.*true or false/ },
		],
		[
			"confirm · text only",
			card({ method: "confirm", title: "Go on?", message: "" }),
			{ text: "yes" },
			{ ok: /yes to "Go on\?"/ },
		],
		[
			"confirm · choice no",
			card({ method: "confirm", title: "Go on?", message: "" }),
			{ choice: "no" },
			{ ok: /no to "Go on\?"/ },
		],
		["input · nothing", card({ method: "input", title: "Name?" }), {}, { error: /`text`/ }],
		[
			"input · choice instead of text",
			card({ method: "input", title: "Name?" }),
			{ choice: "Ada" },
			{ ok: /text to "Name\?"/ },
		],
		["editor · nothing", card({ method: "editor", title: "Edit" }), { approve: true }, { error: /`text`/ }],
		[
			"ask · one question, choice",
			card({
				method: "ask",
				questions: [{ id: "q1", question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
			}),
			{ choice: "B" },
			{ ok: /1 answer/ },
		],
		[
			"ask · one question, text",
			card({ method: "ask", questions: [{ id: "q1", question: "Which?", options: [{ label: "A" }] }] }),
			{ text: "neither" },
			{ ok: /1 answer/ },
		],
		[
			"ask · two questions, choice",
			card({
				method: "ask",
				questions: [
					{ id: "q1", question: "Which?", options: [{ label: "A" }] },
					{ id: "q2", question: "When?", options: [{ label: "Now" }] },
				],
			}),
			{ choice: "A" },
			{ error: /`answers`.*"q1".*"q2"/ },
		],
		["plan · nothing", null, {}, { error: /approve: true.*approve: false/ }],
		["plan · execute", null, { choice: "execute", approve: true }, { error: /사용자 승인이 필요해요/ }],
	];

	it.each(rows)("%s", async (_name, ask, args, want) => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "Boss" },
			ask
				? { tabId: "wait0002", title: "Asker", asks: [ask] }
				: { tabId: "wait0002", title: "Planner", plan: { title: "Plan", planFilePath: "/p.md" } },
		);
		const outcome = await control(host).run("main0001", T.answer, { session: "wait0002", ...args });
		if (want.error) {
			expect(outcome.isError, outcome.text).toBe(true);
			expect(outcome.text).toMatch(want.error);
		} else {
			expect(outcome.isError, outcome.text).toBe(false);
			expect(outcome.text).toMatch(want.ok as RegExp);
		}
	});
});

describe("a control call a paired host re-sends after this computer relaunched runs once", () => {
	// 21 Oct 2026: a host re-sends every host tool call its omp still waits on to a relaunched device (host-services.ts
	// `hostCalls`), and the device may have carried the call out before it died, between the effect and the result.
	// The journal lives in the core now (`agentctl/journal/call_journal.rs`, its clock and retention pinned by its Rust
	// tests); these tests keep the file it writes: the app's death is the file without a result, the days that pass are
	// older `at`s, the calls the host took are `acked` records.
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-control-calls-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	const file = () => join(dir, "agent-control-calls.json");
	type Record_ = { key: string; at: number; acked?: boolean; result?: unknown } & Record<string, unknown>;
	const readJournal = (): Record_[] => JSON.parse(readFileSync(file(), "utf8")) as Record_[];
	const writeJournal = (records: Record_[]): void => writeFileSync(file(), JSON.stringify(records));
	/** The first delivery of host call `call-1`, and the host's re-send of it to a relaunched device. */
	const first1 = { id: "call-1" };
	const resent1 = { id: "call-1", resent: true };
	const DAY = 24 * 60 * 60_000;

	/** This computer as it relaunched: a new caller tab id on the same session file, the journal read back from disk. */
	function relaunch(host: FakeHost, from: string, to: string): void {
		const caller = host.tabsById.get(from);
		host.tabsById.delete(from);
		if (caller) host.add({ ...caller, tabId: to });
		for (const [child, parent] of host.parents) if (parent === from) host.parents.set(child, to);
	}

	/** The app dies right after the calls' effects: no result was written. */
	function diesAfterTheEffect(): void {
		writeJournal(readJournal().map(({ result: _result, ...record }) => record));
	}

	/** The host took the result of call `callId`. */
	function acknowledge(callId: string): void {
		writeJournal(
			readJournal().map(record => (record.key.endsWith(`\n${callId}`) ? { ...record, acked: true } : record)),
		);
	}

	/** Days pass and `count` other calls run, each answered and taken by its host. */
	function laterCalls(count: number): void {
		const records: Record_[] = readJournal().map(record => ({ ...record, at: record.at - 4 * DAY }));
		for (let index = 0; index < count; index++)
			records.push({
				key: `\n/s/other.jsonl\nlater-${index}`,
				tool: T.send,
				callerTabId: "other003",
				at: Date.now(),
				result: { text: "ok", isError: false },
				acked: true,
			});
		writeJournal(records);
	}

	it("opens one session when the app died after opening it and before recording the result", async () => {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss", sessionPath: "/s/boss.jsonl" });
		host.files.calls = file();
		const first = await control(host).run("boss0001", T.open, { message: "Title: Part A\nDo A" }, first1);
		diesAfterTheEffect();
		const child = /Opened session (\w+)/.exec(first.text)?.[1] as string;
		expect(child).toBeTruthy();

		relaunch(host, "boss0001", "boss0002");
		const again = await control(host).run("boss0002", T.open, { message: "Title: Part A\nDo A" }, resent1);
		expect(host.spawned).toHaveLength(1);
		expect(again.isError, again.text).toBe(false);
		expect(again.text).toContain(`Opened session ${child}`);
		expect(again.text).toMatch(/before OMPdesk restarted/);
		// The reconciled result is the call's result from now on.
		const third = await control(host).run("boss0002", T.open, { message: "Title: Part A\nDo A" }, resent1);
		expect(third.text).toBe(again.text);
		expect(host.spawned).toHaveLength(1);
	});

	it("answers a finished call's result again instead of running it twice", async () => {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss", sessionPath: "/s/boss.jsonl" });
		host.files.calls = file();
		const first = await control(host).run("boss0001", T.open, { message: "Do A" }, first1);
		relaunch(host, "boss0001", "boss0002");
		const again = await control(host).run("boss0002", T.open, { message: "Do A" }, resent1);
		expect(again).toEqual(first);
		expect(host.spawned).toHaveLength(1);
		// Another call id, or another session's call with the same id, is a call of its own.
		host.add({ tabId: "other003", title: "Other", sessionPath: "/s/other.jsonl" });
		await control(host).run("other003", T.open, { message: "Do A" }, first1);
		await control(host).run("boss0002", T.open, { message: "Do A" }, { id: "call-2" });
		expect(host.spawned).toHaveLength(3);
	});

	it("never runs again a call whose effect cannot be found: its outcome is unknown", async () => {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss", sessionPath: "/s/boss.jsonl" });
		host.files.calls = file();
		// The app dies before the session opened (the spawn never came back).
		const spawn = host.spawn;
		host.spawn = async () => {
			throw new Error("the app quit");
		};
		await control(host).run("boss0001", T.open, { message: "Do A" }, first1);
		diesAfterTheEffect();
		host.spawn = spawn;

		relaunch(host, "boss0001", "boss0002");
		const again = await control(host).run("boss0002", T.open, { message: "Do A" }, resent1);
		expect(again.isError).toBe(true);
		expect(again.text).toMatch(/outcome is unknown after OMPdesk restarted/);
		expect(host.spawned).toHaveLength(0);
		expect(host.tabsById.size).toBe(1);
	});

	it("finds the schedule a call saved before the app died, and saves no second one", async () => {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss", sessionPath: "/s/boss.jsonl" });
		host.files.calls = file();
		const args = { action: "create", name: "Nightly", prompt: "run checks", every_minutes: 60 };
		await control(host).run("boss0001", T.schedule, args, first1);
		diesAfterTheEffect();
		relaunch(host, "boss0001", "boss0002");
		const again = await control(host).run("boss0002", T.schedule, args, resent1);
		expect(again.isError, again.text).toBe(false);
		expect(again.text).toMatch(/Nightly.*before OMPdesk restarted/);
		expect(host.scheduleRows).toHaveLength(1);
		// Reading needs no record: a list call made again just runs.
		expect((await control(host).run("boss0002", T.schedule, { action: "list" }, { id: "call-2" })).text).toMatch(
			/Nightly/,
		);
	});

	it("keeps a call the host has not acknowledged past 3 days and 500 newer calls: replayed then, it still runs once", async () => {
		// A host waits on a call with no time limit, so it may re-send one days and many calls later.
		const host = new FakeHost({ tabId: "boss0001", title: "Boss", sessionPath: "/s/boss.jsonl" });
		host.files.calls = file();
		await control(host).run("boss0001", T.open, { message: "Do A" }, first1);
		diesAfterTheEffect();
		// A finished call whose result never reached the host stays too.
		const answered = await control(host).run("boss0001", T.open, { message: "Do B" }, { id: "call-2" });
		laterCalls(600);

		relaunch(host, "boss0001", "boss0002");
		expect((await control(host).run("boss0002", T.open, { message: "Do A" }, resent1)).text).toMatch(
			/before OMPdesk restarted/,
		);
		expect(await control(host).run("boss0002", T.open, { message: "Do B" }, { id: "call-2", resent: true })).toEqual(
			answered,
		);
		expect(host.spawned).toHaveLength(2);
	});

	it("forgets an acknowledged call in time, and a re-sent call it has no record of is reconciled, never run", async () => {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss", sessionPath: "/s/boss.jsonl" });
		host.files.calls = file();
		await control(host).run("boss0001", T.open, { message: "Title: Part A\nDo A" }, first1);
		acknowledge("call-1");
		laterCalls(600);
		// Any call that is recorded writes the journal, which forgets what is acknowledged and old.
		host.add({ tabId: "other003", title: "Other", sessionPath: "/s/other.jsonl" });
		await control(host).run("other003", T.open, { message: "Do Z" }, { id: "later-x" });
		expect(readJournal().some(record => record.key === "\n/s/boss.jsonl\ncall-1")).toBe(false);

		// Forgotten (or a new profile): the host's re-send finds the session it opened instead of opening another.
		relaunch(host, "boss0001", "boss0002");
		const again = await control(host).run("boss0002", T.open, { message: "Title: Part A\nDo A" }, resent1);
		expect(again.text).toMatch(/before OMPdesk restarted/);
		// Nothing to find: its outcome is unknown, and still nothing runs.
		const nothing = await control(host).run("boss0002", T.open, { message: "Do C" }, { id: "call-9", resent: true });
		expect(nothing.isError).toBe(true);
		expect(nothing.text).toMatch(/outcome is unknown after OMPdesk restarted/);
		expect(host.spawned).toHaveLength(2);
	});
});

describe("messages that outlive the omp they were handed to", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-send-outbox-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	/** What launches share: the file the send outbox keeps (`send-outbox.json`). */
	const outboxFile = () => join(dir, "send-outbox.json");
	const owed = (): unknown[] => {
		try {
			return JSON.parse(readFileSync(outboxFile(), "utf8")) as unknown[];
		} catch {
			return [];
		}
	};
	/** What the child's journal holds of the markers asked about (its user messages, as the bridge reads them). */
	const journaled = (host: FakeHost, tabId: string, marks: string[]): string[] =>
		marks.filter(mark =>
			(host.tabsById.get(tabId)?.messages ?? []).some(
				message => message.role === "user" && JSON.stringify(message.content).includes(mark),
			),
		);

	it("says a send whose command never answered is queued, and a resend of the same message runs it once", async () => {
		// Stock `login` holds the omp's command queue while a provider sign-in waits: the prompt waits there and runs
		// when the sign-in ends, after main gave up waiting for its answer.
		const host = new FakeHost(
			{ tabId: "boss0001", title: "Boss", sessionPath: "/s/boss.jsonl" },
			{ tabId: "kid00002", title: "Kid", sessionPath: "/s/kid.jsonl" },
		);
		host.parents.set("kid00002", "boss0001");
		host.files.sendOutbox = outboxFile();
		host.sentMarks = async (tabId, marks) => ({ instance: "omp-a", journaled: journaled(host, tabId, marks) });
		const inner = host.command;
		host.command = async (tabId, command, timeoutMs) => {
			if (command.type !== "prompt") return inner(tabId, command, timeoutMs);
			host.sent.push({ tabId, command });
			throw new RpcTimeoutError(30_000, "prompt");
		};
		const service = control(host);
		const first = await service.run("boss0001", T.send, { session: "kid00002", message: "Also do C" });
		expect(first.isError, first.text).toBe(false);
		expect(first.text).toContain("runs once that ends, so do not send it again");
		const again = await service.run("boss0001", T.send, { session: "kid00002", message: "Also do C" });
		expect(again.isError, again.text).toBe(false);
		expect(again.text).toContain("already on its way");
		expect(prompts(host, "kid00002")).toHaveLength(1);
	});

	it("hands a follow-up the child's old omp queued to its omp after a relaunch, once, ahead of the next message", async () => {
		const before = new FakeHost(
			{ tabId: "boss0001", title: "Boss", sessionPath: "/s/boss.jsonl" },
			{ tabId: "kid00002", title: "Kid", sessionPath: "/s/kid.jsonl", busy: true },
		);
		before.parents.set("kid00002", "boss0001");
		before.files.sendOutbox = outboxFile();
		before.sentMarks = async () => ({ instance: "omp-a", journaled: [] });
		const queued = await control(before).run("boss0001", T.send, {
			session: "kid00002",
			message: "Also do C",
			delivery: "follow_up",
		});
		expect(queued.text).toContain("queued as a follow-up");
		expect(queued.text).toContain("Dispatch d1");

		// OMPdesk relaunches: the old omp is gone with its queue; the child's session is back under a new id.
		const after = new FakeHost(
			{ tabId: "boss0009", title: "Boss", sessionPath: "/s/boss.jsonl" },
			{ tabId: "kid00009", title: "Kid", sessionPath: "/s/kid.jsonl", formerIds: ["kid00002"] },
		);
		after.parents.set("kid00009", "boss0009");
		after.files.sendOutbox = outboxFile();
		after.sentMarks = async (tabId, marks) => ({ instance: "omp-b", journaled: journaled(after, tabId, marks) });
		const service = control(after);
		await service.redeliverSends();
		await service.redeliverSends();
		expect(prompts(after, "kid00009")).toEqual([expect.stringContaining("Also do C")]);
		expect(prompts(after, "kid00009")[0]).toContain("[ompdesk dispatch d1:");

		// The opener's next message, by the id it had: numbered past the one still on its way, and after it.
		const next = await service.run("boss0009", T.send, { session: "kid00002", message: "And D" });
		expect(next.isError, next.text).toBe(false);
		expect(next.text).toContain("Dispatch d2");
		expect(prompts(after, "kid00009")).toHaveLength(2);

		// Its turn took both: the journal holds them, and nothing is owed any more.
		const child = after.tabsById.get("kid00009") as FakeTab;
		child.messages = prompts(after, "kid00009").map(
			text => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 }) as AgentMessage,
		);
		await service.redeliverSends();
		expect(owed()).toEqual([]);
		expect(prompts(after, "kid00009")).toHaveLength(2);
	});
});

describe("an id keeps naming its session after its tab is gone, and says when the session was deleted", () => {
	// 3 to 10 Nov 2026, one session's journals: `No session "<id>"` 14 times on ids ompdesk_session_open had returned.
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-session-fates-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	const kid: Partial<FakeTab> = { tabId: "kid00002", title: "Fix the parser", sessionPath: "/s/kid.jsonl" };
	const said = [{ role: "assistant", content: "the whole table" } as AgentMessage];
	/** One launch of the app over the fates file the launches share. */
	const launch = (...tabs: Partial<FakeTab>[]) => {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss", sessionPath: "/s/boss.jsonl" }, ...tabs);
		host.files.fates = join(dir, "agent-session-fates.json");
		host.storedTranscripts.set("/s/kid.jsonl", said);
		return { host, service: control(host) };
	};

	it("reads a session whose tab the person closed by the id it was opened with, in this launch and the next", async () => {
		const first = launch(kid);
		// The person closes the tab in its window: the pool releases it, with the session it held.
		first.host.tabsById.delete("kid00002");
		await first.service.released("kid00002", {
			path: "/s/kid.jsonl",
			title: "Fix the parser",
			cwd: "/repo",
			formerIds: [],
		});
		const read = await first.service.run("boss0001", T.read, { session: "kid00002" });
		expect(read.isError, read.text).toBe(false);
		expect(read.text).toContain("the whole table");
		// A relaunch (an update): the tab is gone for good, its id still names the saved session.
		const second = launch();
		const again = await second.service.run("boss0001", T.read, { session: "kid00002" });
		expect(again.isError, again.text).toBe(false);
		expect(again.text).toContain("the whole table");
		// Reopened since, the old id names the tab that holds it now.
		second.host.add({ tabId: "kid00009", sessionPath: "/s/kid.jsonl", last: "newer answer" });
		expect((await second.service.run("boss0001", T.result, { session: "kid00002" })).text).toContain("newer answer");
	});

	it("keeps a child it closed itself readable and its own to delete after a relaunch", async () => {
		const first = launch(kid);
		first.host.parents.set("kid00002", "boss0001");
		expect((await first.service.run("boss0001", T.stop, { session: "kid00002", close: true })).isError).toBe(false);
		const second = launch();
		expect((await second.service.run("boss0001", T.read, { session: "kid00002" })).text).toContain("the whole table");
		const deleted = await second.service.run("boss0001", T.stop, { session: "kid00002", delete: true });
		expect(deleted.isError, deleted.text).toBe(false);
		expect(second.host.cards).toEqual([]);
		expect(second.host.deletedStored).toEqual([{ path: "/s/kid.jsonl", device: undefined }]);
	});

	it("says a deleted session was deleted, by whom and when, whatever is asked of its id", async () => {
		const { host, service } = launch();
		await service.run("boss0001", T.open, { message: "look it up", throwaway: true });
		const child = [...host.tabsById.values()].find(tab => tab.tabId !== "boss0001") as FakeTab;
		Object.assign(child, {
			busy: false,
			title: "Lookup",
			sessionPath: "/s/lookup.jsonl",
			autoClosable: true,
			lastRun: { stopReason: "stop" },
			last: "Found it.\nResult: ok",
		});
		await service.autoClose("boss0001");
		await service.autoClose("boss0001");
		expect(host.deletedStored).toEqual([{ path: "/s/lookup.jsonl", device: undefined }]);
		for (const [tool, args] of [
			[T.read, { session: child.tabId }],
			[T.result, { session: child.tabId }],
			[T.stop, { session: child.tabId, close: true }],
			[T.send, { session: child.tabId, message: "one more thing" }],
			[T.compare, { sessions: [child.tabId] }],
		] as const) {
			const gone = await service.run("boss0001", tool, args);
			expect(gone.isError, tool).toBe(true);
			expect(gone.text, tool).toMatch(
				/"Lookup"\) was deleted on \d{4}-\d\d-\d\d \d\d:\d\d UTC by OMPdesk \(it was opened as throwaway/,
			);
			expect(gone.text, tool).not.toContain("No session");
		}
		// A delete of it again is no error, and says the same.
		const again = await service.run("boss0001", T.stop, { session: child.tabId, delete: true });
		expect(again.isError).toBe(false);
		expect(again.text).toMatch(/already deleted on \d{4}-.* by OMPdesk/);
	});

	it("says so for a session deleted outside the control tools, by its tab id and by its saved id", async () => {
		const { host, service } = launch({ ...kid, sessionPath: "/s/2026-11-04T10-00-00-000Z_01abc-kid.jsonl" });
		// The sidebar's Delete: the tab closes as any tab does, then the file goes and a tombstone says when.
		host.tabsById.delete("kid00002");
		await service.released("kid00002", {
			path: "/s/2026-11-04T10-00-00-000Z_01abc-kid.jsonl",
			title: "Fix the parser",
			cwd: "/repo",
			formerIds: [],
		});
		host.tombstoneAt.set("/s/2026-11-04T10-00-00-000Z_01abc-kid.jsonl", Date.UTC(2026, 10, 9, 4, 12));
		host.tombstoneAt.set("01abc-other", Date.UTC(2026, 10, 9, 4, 12));
		for (const session of ["kid00002", "01abc-kid", "01abc-other"]) {
			const gone = await service.run("boss0001", T.read, { session });
			expect(gone.isError, session).toBe(true);
			expect(gone.text, session).toContain("was deleted on 2026-11-09 04:12 UTC by someone in OMPdesk");
		}
		// An id nothing ever named is still unknown.
		expect((await service.run("boss0001", T.read, { session: "nope9999" })).text).toContain('No session "nope9999"');
	});

	it("never shows a hidden session's title or transcript through the id its tab had", async () => {
		const { host, service } = launch({ ...kid, hidden: true });
		host.tabsById.delete("kid00002");
		await service.released("kid00002", {
			path: "/s/kid.jsonl",
			title: "Private notes",
			cwd: "/repo",
			formerIds: [],
			hidden: true,
		});
		const read = await service.run("boss0001", T.read, { session: "kid00002" });
		expect(read.isError).toBe(true);
		expect(read.text).toContain("hid this session");
		expect(read.text).not.toContain("Private notes");
	});
});

describe("a message to a closed child whose folder is gone", () => {
	// 3 to 10 Nov 2026: three sends failed on "The folder this saved session belongs in no longer exists" alone.
	async function closedChild(worktree: boolean) {
		const host = new FakeHost({ tabId: "main0001", title: "Boss", sessionPath: "/s/boss.jsonl" });
		const service = control(host);
		await service.run("main0001", T.open, { message: "do it", ...(worktree ? { worktree: true } : {}) });
		const child = [...host.tabsById.values()].find(tab => tab.tabId !== "main0001") as FakeTab;
		Object.assign(child, {
			busy: false,
			title: "Fix the parser",
			sessionPath: "/s/kid.jsonl",
			...(worktree ? { cwd: "/wt/w" } : {}),
			autoClosable: true,
			lastRun: { stopReason: "stop" },
			last: "Done.\nResult: ok",
		});
		if (worktree) host.landings.set("omp/agent/w", { hasWork: true, landed: true, clean: true });
		await service.autoClose("main0001");
		await service.autoClose("main0001");
		expect(host.tabsById.has(child.tabId)).toBe(false);
		host.closed = host.closedRecords;
		return { host, service, child };
	}

	it("says the control tools removed its worktree once its work landed, and how the follow-up goes on", async () => {
		const { host, service, child } = await closedChild(true);
		expect(host.removed).toEqual(["omp/agent/w"]);
		host.reopenError = new SessionFolderMissing("/wt/w", null);
		const sent = await service.run("main0001", T.send, { session: child.tabId, message: "one more fix" });
		expect(sent.isError).toBe(true);
		expect(sent.text).toContain("OMPdesk removed that worktree when it closed the session");
		expect(sent.text).toContain("your message was not delivered");
		expect(sent.text).toContain('ompdesk_session_open {"message":"…","folder":"/repo","worktree":true}');
		expect(sent.text).toContain(`ompdesk_session_read {"session":"${child.tabId}"}`);
		expect(prompts(host, child.tabId)).toHaveLength(1);
	});

	it("names the restore call when disk care saved the folder, for a send as for a reopen", async () => {
		const { host, service, child } = await closedChild(false);
		host.reopenError = new SessionFolderMissing("/repo", { id: "saved-7", branch: "omp/agent/w", removedAt: 0 });
		const sent = await service.run("main0001", T.send, { session: child.tabId, message: "one more fix" });
		expect(sent.isError).toBe(true);
		expect(sent.text).toContain(`ompdesk_session_open {"reopen":"${child.tabId}","restore":true}`);
		expect(sent.text).toContain("then send your message to the id that returns");
	});
});

describe("a cleanup refused while the person was in the session", () => {
	// 3 to 10 Nov 2026: 6 stops of opened sessions were refused, and nothing reminded their opener of them.
	const seen: Partial<FakeTab> = { tabId: "seen0002", title: "Seen", looked: true, sessionPath: "/s/a.jsonl" };
	const setup = () => {
		const host = new FakeHost(
			{ tabId: "boss0001", title: "Boss", busy: true, personTurn: false, sessionPath: "/s/boss.jsonl" },
			seen,
			{ tabId: "typed003", title: "Typed", userTouched: true, sessionPath: "/s/b.jsonl" },
		);
		host.parents.set("typed003", "boss0001");
		return { host, service: control(host), boss: host.tabsById.get("boss0001") as FakeTab };
	};
	const toBoss = (host: FakeHost) => host.mails.filter(mail => mail.to === "boss0001");

	it("is kept, and listed to its caller once, at the start of its next turn the person's own message starts", async () => {
		const { host, service, boss } = setup();
		const refused = await service.run("boss0001", T.stop, { session: "seen0002", close: true });
		expect(refused.isError).toBe(true);
		expect(refused.text).toMatch(/not started by the user's own message/);
		expect(refused.text).toContain("pending cleanup");
		await service.run("boss0001", T.stop, { session: "typed003", delete: true });
		expect(toBoss(host)).toEqual([]);

		// The person's message joins the turn that runs: no turn of theirs starts, so the list waits.
		await service.personTyped("boss0001");
		expect(toBoss(host)).toEqual([]);

		// The turn ended; the person's next message starts one.
		boss.busy = false;
		await service.personTyped("boss0001");
		expect(toBoss(host)).toHaveLength(1);
		const [note] = toBoss(host);
		expect(note?.delivery).toEqual({ triggerTurn: false });
		expect(note?.content).toContain('ompdesk_session_stop {"session":"seen0002","close":true}');
		expect(note?.content).toContain('ompdesk_session_stop {"session":"typed003","delete":true}');

		// In that turn the same call works, and nothing is listed again.
		Object.assign(boss, { busy: true, personTurn: true });
		const closed = await service.run("boss0001", T.stop, { session: "seen0002", close: true });
		expect(closed.isError, closed.text).toBe(false);
		boss.busy = false;
		await service.personTyped("boss0001");
		expect(toBoss(host).filter(mail => mail.content.includes("pending cleanups"))).toHaveLength(1);
	});

	it("lists nothing that is done since: a tab that closed, a call that went through later", async () => {
		const { host, service, boss } = setup();
		await service.run("boss0001", T.stop, { session: "seen0002", close: true });
		await service.run("boss0001", T.stop, { session: "typed003", close: true });
		// The person closed one tab themselves; they left the other, and a later close of it went through.
		host.tabsById.delete("seen0002");
		(host.tabsById.get("typed003") as FakeTab).userTouched = false;
		expect((await service.run("boss0001", T.stop, { session: "typed003", close: true })).isError).toBe(false);
		boss.busy = false;
		await service.personTyped("boss0001");
		expect(toBoss(host).filter(mail => mail.content.includes("pending cleanups"))).toEqual([]);
	});

	it("survives a relaunch and another tab id for the same session", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-pending-cleanups-"));
		try {
			const file = join(dir, "agent-pending-cleanups.json");
			const before = setup();
			before.host.files.cleanups = file;
			const first = control(before.host);
			await first.run("boss0001", T.stop, { session: "seen0002", close: true });

			// A relaunch gives the same session another tab id.
			const after = new FakeHost({ tabId: "boss0009", title: "Boss", sessionPath: "/s/boss.jsonl" }, seen);
			after.files.cleanups = file;
			await control(after).personTyped("boss0009");
			const told = after.mails.filter(mail => mail.to === "boss0009");
			expect(told).toHaveLength(1);
			expect(told[0]?.content).toContain('ompdesk_session_stop {"session":"seen0002","close":true}');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("an app action on another computer", () => {
	const usage = { reports: [] };
	/** The app's side of `ompdesk_app`, as far as an action that only sends an RPC command needs it. */
	const withApp = (host: FakeHost) => {
		host.appPorts = {
			getPref: () => undefined,
			setPref: async () => {},
			rpc: async () => ok(usage),
			invoke: async () => undefined,
			fire: () => {},
			send: () => {},
			manageEnabled: () => true,
			fullEnabled: () => true,
			note: async () => {},
			localize: en => en,
			sidebarView: () => ({ pinnedProjects: [], pinnedSessions: [], projectOrder: [], aliases: {} }) as never,
			openPrivacyPane: async () => {},
		};
		return control(host);
	};
	const read = { action: "usage.read", args: { device: desktop.name } };
	const asked = (host: FakeHost) =>
		host.sent.filter(entry => entry.command.type === "get_usage").map(entry => entry.tabId);

	it("asks a session that already runs there", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "Boss" },
			{ tabId: "remo0002", device: desktop.id, deviceName: desktop.name },
		);
		host.deviceList = [desktop];
		const result = await withApp(host).run("main0001", T.app, read);
		expect(result.isError, result.text).toBe(false);
		expect(asked(host)).toEqual(["remo0002"]);
		expect(host.spawned).toEqual([]);
	});

	it("opens a session there for the one call when none runs there, and closes and deletes it again", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" });
		host.deviceList = [desktop];
		const result = await withApp(host).run("main0001", T.app, read);
		expect(result.isError, result.text).toBe(false);
		expect(host.spawned).toEqual([{ device: desktop.id }]);
		const [opened] = asked(host);
		expect(opened).not.toBe("main0001");
		expect(host.deleted).toEqual([opened]);
		expect(host.tabsById.size).toBe(1);
		// No message went to it: nothing ran on a model there.
		expect(prompts(host, opened as string)).toEqual([]);
	});

	it("writes an omp setting there through one opened session: its schema, its value and the write", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" });
		host.deviceList = [desktop];
		const stock: Record<string, unknown> = { "compaction.thresholdTokens": 100000 };
		const answer = host.command;
		host.command = async (tabId, command, timeoutMs) => {
			if (command.type === "get_settings_schema")
				return ok({
					entries: [
						{ path: "compaction.thresholdTokens", type: "number", value: stock["compaction.thresholdTokens"] },
					],
				});
			if (command.type === "get_settings") return ok({ values: stock });
			if (command.type === "set_setting") stock[command.path] = command.value;
			return answer(tabId, command, timeoutMs);
		};
		const result = await withApp(host).run("main0001", T.app, {
			action: "omp_settings.set",
			args: { path: "compaction.thresholdTokens", value: 50000, device: desktop.name },
		});
		expect(result.isError, result.text).toBe(false);
		expect(stock["compaction.thresholdTokens"]).toBe(50000);
		// Three commands, one omp started there, and it is gone again.
		expect(host.spawned).toEqual([{ device: desktop.id }]);
		expect(host.deleted).toHaveLength(1);
		expect(host.tabsById.size).toBe(1);
	});

	it("refuses a computer that is not paired, naming the ones that are", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" });
		host.deviceList = [desktop];
		const result = await withApp(host).run("main0001", T.app, { action: "usage.read", args: { device: "Nowhere" } });
		expect(result.isError).toBe(true);
		expect(result.text).toContain(desktop.name);
		expect(host.spawned).toEqual([]);
	});
});

/**
 * The owner's report (12 Nov 2026, three paired computers): three sessions titled "메인" and two titled "문의", a
 * received message naming its sender by title alone, tab ids that differ per app and per launch, and a receipt that
 * named another session than the one the message reached.
 */
describe("one id per session: a message names its sender and reaches the session it names", () => {
	const MAIN = "01a1c4ad-72b6-75db-9140-8a896455855b";
	const ASK = "01a1c9f4-8354-70aa-91a9-473beaf7e427";
	const OLD_ASK = "01a1b001-0000-7000-8000-000000000001";
	const HELP = "01a1b002-0000-7000-8000-000000000002";
	const OTHER = "01a1b003-0000-7000-8000-000000000003";
	const file = (id: string, folder = "-Volumes-BACKUP-github-ompdesk--") =>
		`/Users/u/.omp/agent/sessions/${folder}/2026-11-11T09-33-27-252Z_${id}.jsonl`;
	const askFile = file(ASK, "-Desktop-GitHub-yuyu-mos");
	const seuput: ControlDevice = { id: "seuput", name: "SeuPut", state: "online" };
	const userText = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as AgentMessage;

	it("carries the sender's saved id in the message, and a read shows it to answer with", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "메인", sessionPath: file(MAIN) },
			{ tabId: "ask00002", title: "문의", sessionPath: askFile },
		);
		await control(host).run("main0001", T.send, { session: "ask00002", message: "받았다" });
		const [prompt = ""] = prompts(host, "ask00002");
		expect(prompt).toBe(wrapAgentMessage("받았다", "메인", MAIN));
		const asked = host.tabsById.get("ask00002") as FakeTab;
		asked.messages = [userText(prompt)];
		expect((await control(host).run("main0001", T.read, { session: "ask00002" })).text).toContain(
			`[user, sent by an agent (메인, saved id ${MAIN})] 받았다`,
		);
		// What journals hold from before the id was carried reads as it did.
		asked.messages = [userText(wrapAgentMessage("받았다", "메인"))];
		expect((await control(host).run("main0001", T.read, { session: "ask00002" })).text).toContain(
			"[user, sent by an agent (메인)] 받았다",
		);
	});

	it("lists every open session with its saved id, the one id that names it on every computer", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "메인", sessionPath: file(MAIN) },
			{
				tabId: "15ca089d159bfde0",
				title: "문의",
				sessionPath: askFile,
				device: seuput.id,
				deviceName: seuput.name,
				here: false,
			},
			{ tabId: "new00003", title: "Fresh" },
		);
		host.deviceList = [seuput];
		const service = control(host);
		expect((await service.run("main0001", T.list, {})).text).toContain(`- main0001 "메인" (saved id ${MAIN})`);
		const app = (await service.run("main0001", T.list, { scope: "app" })).text;
		expect(app).toContain(`- 15ca089d159bfde0 "문의" (saved id ${ASK})`);
		// A session that has no file yet has no saved id to give.
		expect(app).toMatch(/- new00003 "Fresh"\n/);
	});

	it("names in its receipt the session it reached as it is once woken, never the asleep tab's leftovers", async () => {
		// 11 Nov 2026 15:35:01 UTC: the send by saved id woke the restored tab 15ca089d159bfde0 (its layout kept no
		// title and the folder its tab was spawned in, ~/.omp/work) and answered `Sent to (untitled, in work): accepted,
		// turn started; it was idle`, while the session it reached was "문의", waiting for the user's answer.
		const host = new FakeHost(
			{ tabId: "main0001", title: "메인", sessionPath: file(MAIN) },
			{
				tabId: "15ca089d159bfde0",
				title: "",
				cwd: "/Users/seuput/.omp/work",
				status: "asleep",
				device: seuput.id,
				deviceName: seuput.name,
				sessionPath: askFile,
			},
		);
		host.deviceList = [seuput];
		// Main lists every tab afresh (host.ts `#controlTab`): a woken tab is a new row with what its omp says now.
		host.start = tabId => {
			const asleep = host.tabsById.get(tabId) as FakeTab;
			host.tabsById.set(tabId, {
				...asleep,
				status: "ready",
				title: "문의",
				cwd: "/Users/seuput/Desktop/GitHub/yuyu-mos",
				busy: true,
				asks: [select("판단에 필요한 사실", ["가", "나"])],
			});
		};
		const result = await control(host).run("main0001", T.send, { session: ASK, message: "받았다" });
		expect(prompts(host, "15ca089d159bfde0")).toHaveLength(1);
		expect(result.text).toContain(`Sent to "문의" (saved id ${ASK}, on SeuPut): accepted`);
		expect(result.text).toContain(`waiting for the user's answer: "판단에 필요한 사실"`);
		expect(result.text).not.toContain("untitled");
		expect(result.text).not.toContain("idle");
	});

	it("says what it reached when it joins a session open in a tab on a paired computer", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "메인", sessionPath: file(MAIN) });
		host.deviceList = [seuput];
		host.storedRows = [
			storedRow({
				id: ASK,
				path: askFile,
				title: "문의",
				device: seuput.id,
				deviceName: seuput.name,
				elsewhere: { work: "idle" },
			}),
		];
		const result = await control(host).run("main0001", T.send, { session: ASK, message: "받았다" });
		expect(host.spawned).toEqual([{ sessionPath: askFile, device: seuput.id, join: true }]);
		expect(result.text).toContain(`Sent to "문의" (saved id ${ASK}, on `);
	});

	it("never delivers to the tab a listed row named once that tab holds another session", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "메인" },
			{ tabId: "ask00002", title: "문의", sessionPath: askFile },
		);
		host.storedRows = [storedRow({ id: ASK, path: askFile, title: "문의", tabId: "ask00002" })];
		const service = control(host);
		await service.run("main0001", T.list, { scope: "stored" });
		// A new session in that tab: the row's tab id now names another conversation.
		(host.tabsById.get("ask00002") as FakeTab).sessionPath = file(OTHER);
		host.storedRows = [storedRow({ id: ASK, path: askFile, title: "문의" })];
		const result = await service.run("main0001", T.send, { session: ASK, message: "받았다" });
		expect(prompts(host, "ask00002")).toEqual([]);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("not open in any tab");
	});

	it("refuses a title another session holds open on a paired computer, and never takes a tab it only starts", async () => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "메인" },
			{ tabId: "old00002", title: "문의", sessionPath: file(OLD_ASK) },
			{ tabId: "help0003", title: "문의응대", sessionPath: file(HELP) },
		);
		host.deviceList = [seuput];
		const there = [summary({ sessionPath: askFile, sessionId: ASK, title: "문의", cwd: "/yuyu-mos" })];
		host.summaries = device => (device === seuput.id ? there : host.localRows);
		const service = control(host);
		const both = await service.run("main0001", T.send, { session: "문의", message: "받았다" });
		expect(both.isError).toBe(true);
		expect(both.text).toContain(`old00002 "문의" (saved id ${OLD_ASK})`);
		expect(both.text).toContain(`"문의" (saved id ${ASK}, open in a tab on SeuPut)`);
		expect(prompts(host, "old00002")).toEqual([]);
		// The older tab closed: the title names the paired computer's session alone, never a tab it only starts.
		host.tabsById.delete("old00002");
		const one = await service.run("main0001", T.send, { session: "문의", message: "받았다" });
		expect(prompts(host, "help0003")).toEqual([]);
		expect(one.text).not.toContain("문의응대");
	});
});

/**
 * 11 Nov 2026 16:01 UTC: 메인 answered "문의", the person's own session on SeuPut that it did not open, with
 * `delivery: "follow_up"` while 문의 was mid-turn. Stock held the answer in 문의's follow-up queue until that turn ended,
 * where the person saw it waiting and had to press 지금 추가 지시. A follow-up waits behind the turn only of a session
 * the sender opened (its next task); whatever reaches any other running session is read between its steps, unless a
 * card of the person's is open there (stock closes it for a steer: `bridge-agent-send-stock.test.ts`).
 */
describe("a message to a running session the sender did not open is read between its steps", () => {
	const MAIN = "01a1c4ad-72b6-75db-9140-8a896455855b";
	const ASK = "01a1c9f4-8354-70aa-91a9-473beaf7e427";
	const askFile = `/Users/seuput/.omp/agent/sessions/-Desktop-GitHub-yuyu-mos/2026-11-11T09-33-27-252Z_${ASK}.jsonl`;
	const mainFile = `/Users/u/.omp/agent/sessions/-Volumes-BACKUP-github-ompdesk--/2026-11-10T08-57-43-862Z_${MAIN}.jsonl`;
	const seuput: ControlDevice = { id: "seuput", name: "SeuPut", state: "online" };
	const behaviors = (host: FakeHost, tabId: string) =>
		host.sent.flatMap(entry =>
			entry.tabId === tabId && entry.command.type === "prompt" ? [entry.command.streamingBehavior] : [],
		);
	const world = (asks: ControlAsk[]) => {
		const host = new FakeHost(
			{ tabId: "main0001", title: "메인", sessionPath: mainFile },
			{
				tabId: "15ca089d159bfde0",
				title: "문의",
				sessionPath: askFile,
				device: seuput.id,
				deviceName: seuput.name,
				busy: true,
				busySince: 1,
				asks,
			},
		);
		host.deviceList = [seuput];
		return host;
	};
	const answer = { session: ASK, message: "결과: 재현했고 고쳤다", delivery: "follow_up" };

	it("steers a follow-up asked for a session it did not open", async () => {
		const host = world([]);
		const result = await control(host).run("main0001", T.send, answer);
		expect(behaviors(host, "15ca089d159bfde0")).toEqual(["steer"]);
		expect(result.text).toContain("delivered as steer");
		expect(result.text).not.toContain("queued as a follow-up");
	});

	it("keeps it a follow-up while that session shows the person a card, which a steer would close", async () => {
		const host = world([select("판단에 필요한 사실", ["가", "나"])]);
		const result = await control(host).run("main0001", T.send, answer);
		expect(behaviors(host, "15ca089d159bfde0")).toEqual(["followUp"]);
		expect(result.text).toContain(`waiting for the user's answer: "판단에 필요한 사실"`);
	});
});

/**
 * The three sends of 11 Nov 2026 (UTC) by the saved id of "문의", whose omp ran on SeuPut for a paired device's tab:
 * at 09:55 and 09:57 this computer's saved-session list could not be read (omp's packages out of step under the stock
 * helper), and the agent got the reader's own error; at 10:26, 39 s after SeuPut relaunched, no tab it could see held
 * the session and the agent was told it was "not open in any tab", so it sent to an older tab of the same title.
 */
describe("a message to a saved session whose holder this app cannot see", () => {
	const ASK = "01a1c9f4-8354-70aa-91a9-473beaf7e427";
	const askFile = `/Users/seuput/.omp/agent/sessions/-Desktop-GitHub-yuyu-mos/2026-11-11T09-33-27-252Z_${ASK}.jsonl`;
	const seuput: ControlDevice = { id: "seuput", name: "SeuPut", state: "online" };
	const askRow = (over: Partial<StoredSession> = {}) => storedRow({ id: ASK, path: askFile, title: "문의", ...over });

	it("says a paired computer's tab that has not started is out of its sight, and that opening it here joins it", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "메인" });
		host.storedRows = [askRow()];
		const result = await control(host).run("main0001", T.send, { session: ASK, message: "받았다" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("not open in any tab OMPdesk can see");
		expect(result.text).toContain("has not started since a relaunch");
		expect(result.text).toContain("never a second omp");
		expect(result.text).toContain(`{"reopen":"${ASK}"}`);
	});

	it("never tells to open again a session whose computer's list cannot be read now", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "메인" });
		host.deviceList = [seuput];
		host.storedRows = [askRow({ device: seuput.id, deviceName: seuput.name })];
		const service = control(host);
		await service.run("main0001", T.list, { scope: "stored", device: "SeuPut" });
		// The list was read; the link then drops and every read of SeuPut's list fails while it comes back.
		const stored = host.stored;
		host.stored = async (device, query) => {
			if (device === seuput.id) throw new Error("[remote_offline] SeuPut is offline");
			return stored(device, query);
		};
		const result = await service.run("main0001", T.send, { session: ASK, message: "받았다" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("What SeuPut holds could not be read now");
		expect(result.text).not.toContain("reopen");
		expect(host.spawned).toEqual([]);
	});

	it("says this computer's saved-session list could not be read, never only the reader's own error", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "메인" });
		const broken =
			"Export named 'providerLoginWarning' not found in module '/Users/seuput/.bun/install/global/node_modules/@oh-my-pi/pi-catalog/src/compat/auth.ts'.";
		host.stored = async () => {
			throw new Error(broken);
		};
		const result = await control(host).run("main0001", T.send, { session: ASK, message: "받았다" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain(`This computer's list of saved sessions could not be read (${broken})`);
		expect(result.text).toContain("nothing was done");
	});
});

describe("closing one exact relay view", () => {
	const handle: SessionViewHandle = {
		viewHost: "host-b",
		window: "window-b",
		tabId: "view-b",
		session: "11111111-aaaa",
		incarnation: "incarnation-b",
	};
	const facts = (tab: Partial<ControlTab> = {}): ViewCloseFacts => ({
		handle,
		tab: {
			tabId: handle.tabId,
			title: "Shared completed session",
			cwd: "/repo",
			status: "ready",
			busy: false,
			asks: [],
			hidden: false,
			sessionPath: "/s/time_11111111-aaaa.jsonl",
			...tab,
		},
		enabled: true,
		manageEnabled: true,
		fullEnabled: true,
	});

	it("lists actual app view handles, not saved summaries posing as views", async () => {
		const host = new FakeHost({ tabId: "source-a" });
		const other = { ...handle, viewHost: "host-c", tabId: "view-c", incarnation: "incarnation-c" };
		Object.assign(host, {
			listViews: async () => ({
				views: [facts(), { ...facts({ tabId: other.tabId }), handle: other }],
				unavailable: [],
			}),
		});
		const result = await control(host).run("source-a", T.list, { scope: "app" });
		expect(result.isError, result.text).toBe(false);
		expect(result.text).toContain(JSON.stringify(handle));
		expect(result.text).toContain(JSON.stringify(other));
	});

	it.each([true, false])("authorizes from the original source caller's person turn (%s)", async personTurn => {
		const host = new FakeHost({ tabId: "source-a", personTurn });
		host.full = true;
		const service = control(host);
		const remaining = new Set(["view-b", "view-c"]);
		const closeView = vi.fn(async (caller: string, requested: SessionViewHandle) => {
			expect(caller).toBe("source-a");
			expect(requested).toEqual(handle);
			await service.authorizeView(caller, facts({ looked: true, userTouched: true }), "host-a");
			remaining.delete(requested.tabId);
		});
		Object.assign(host, { closeView });
		const result = await service.run("source-a", T.stop, { session: handle.session, close: true, view: handle });
		expect(result.isError, result.text).toBe(!personTurn);
		if (personTurn) {
			expect(result.text).toMatch(/Closed view/);
			expect([...remaining]).toEqual(["view-c"]);
		} else {
			expect(result.text).toMatch(/not started by the user's own message/);
			expect(result.text).not.toMatch(/Closed view/);
			expect([...remaining]).toEqual(["view-b", "view-c"]);
		}
		expect(closeView).toHaveBeenCalledTimes(1);
		expect(host.sent.filter(entry => entry.command.type === "agent_control_turn").map(entry => entry.tabId)).toEqual(
			personTurn ? ["source-a", "source-a"] : ["source-a"],
		);
		expect(host.sent.filter(entry => entry.command.type === "abort")).toEqual([]);
		expect(host.spawned).toEqual([]);
		expect(host.deleted).toEqual([]);
		expect(host.deletedStored).toEqual([]);
		expect(host.views).toEqual([]);
		expect(host.tabsById.has("source-a")).toBe(true);
	});

	it("does not report a rejected receiver close as a closed view", async () => {
		const host = new FakeHost({ tabId: "source-a" });
		const closeView = vi.fn(async () => {
			throw new Error("View incarnation changed");
		});
		Object.assign(host, { closeView });
		const result = await control(host).run("source-a", T.stop, {
			session: handle.session,
			close: true,
			view: handle,
		});
		expect(result.isError).toBe(true);
		expect(result.text).toContain("View incarnation changed");
		expect(result.text).not.toMatch(/Closed view/);
		expect(closeView).toHaveBeenCalledTimes(1);
		expect(host.spawned).toEqual([]);
		expect(host.sent.filter(entry => entry.command.type === "abort")).toEqual([]);
		expect(host.deletedStored).toEqual([]);
	});

	it.each([
		{ close: false },
		{ close: true, delete: true },
		{ close: true, device: "host-b" },
		{ close: true, session: "different-session" },
	])("refuses invalid exact-view requests before contacting a receiver (%j)", async args => {
		const host = new FakeHost({ tabId: "source-a" });
		const closeView = vi.fn(async () => {});
		Object.assign(host, { closeView });
		const result = await control(host).run("source-a", T.stop, { session: handle.session, view: handle, ...args });
		expect(result.isError).toBe(true);
		expect(closeView).not.toHaveBeenCalled();
	});

	it("refuses an exact-view close when its host has no close port", async () => {
		const result = await control(new FakeHost({ tabId: "source-a" })).run("source-a", T.stop, {
			session: handle.session,
			close: true,
			view: handle,
		});
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/not available|unavailable/i);
	});

	it.each([
		{ tab: { hidden: true }, error: /hidden/i },
		{ tab: { busy: true }, error: /busy|running/i },
		{ tab: { asks: [select("Continue?", ["Yes", "No"])] }, error: /waiting/i },
		{ tab: { webEdits: "dirty" as const }, error: /unsaved|edits/i },
	])("refuses unsafe authenticated receiver facts without aborting (%j)", async ({ tab, error }) => {
		const host = new FakeHost({ tabId: "source-a", personTurn: true });
		host.full = true;
		const service = control(host);
		await expect(service.authorizeView("source-a", facts(tab), "host-a")).rejects.toThrow(error);
		expect(host.sent.filter(entry => entry.command.type === "abort")).toEqual([]);
		expect(host.spawned).toEqual([]);
		expect(host.deleted).toEqual([]);
	});

	it("refuses disabled receivers and callers no longer present", async () => {
		const host = new FakeHost({ tabId: "source-a", personTurn: true });
		const service = control(host);
		await expect(service.authorizeView("source-a", { ...facts(), enabled: false }, "host-a")).rejects.toThrow(
			/turned off/i,
		);
		host.tabsById.delete("source-a");
		await expect(service.authorizeView("source-a", facts(), "host-a")).rejects.toThrow(/gone|caller/i);
	});

	it("requires an explicit view for a saved session known to be open elsewhere", async () => {
		const host = new FakeHost({ tabId: "source-a" });
		host.storedRows = [storedRow({ elsewhere: { holder: "host-b", work: "idle" } })];
		const result = await control(host).run("source-a", T.stop, { session: handle.session, close: true });
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/view/i);
		expect(result.text).not.toMatch(/not open/i);
		expect(host.spawned).toEqual([]);
		expect(host.deletedStored).toEqual([]);
	});

	it("retains trusted local child ownership without granting it to a remote view", async () => {
		const host = new FakeHost(
			{ tabId: "source-a", personTurn: false },
			{ tabId: handle.tabId, sessionPath: "/s/time_11111111-aaaa.jsonl" },
		);
		host.parents.set(handle.tabId, "source-a");
		const service = control(host);
		const view = facts({ looked: true });
		const localReceipt = await service.authorizeView("source-a", view, "host-b");
		expect(localReceipt).toMatch(/^[a-f0-9]{64}$/);
		await service.releaseViewAuthorization(localReceipt);
		await expect(service.authorizeView("source-a", view, "host-a")).rejects.toThrow(
			/not started by the user's own message/,
		);
		expect(host.cards).toEqual([]);
	});

	it.each(["source", "receiver"])(
		"requires both hosts' elevated grants and keeps the card on the original caller (%s)",
		async low => {
			const host = new FakeHost({ tabId: "source-a", personTurn: true });
			host.full = low !== "source";
			host.manage = low !== "source";
			host.cardAnswer = false;
			const service = control(host);
			const view = {
				...facts({ looked: true }),
				fullEnabled: low !== "receiver",
				manageEnabled: low !== "receiver",
			};
			await expect(service.authorizeView("source-a", view, "host-a")).rejects.toThrow(/declined/);
			expect(host.cards).toHaveLength(1);
			expect(host.spawned).toEqual([]);
		},
	);

	it("refuses when the original caller's bridge cannot answer even for an unseen resting view", async () => {
		const host = new FakeHost({ tabId: "source-a" });
		const command = host.command;
		host.command = async (tabId, request, timeoutMs) =>
			request.type === "agent_control_turn" ? bad("bridge unavailable") : command(tabId, request, timeoutMs);
		await expect(control(host).authorizeView("source-a", facts(), "host-a")).rejects.toThrow(/bridge/i);
	});

	it.each(["bridge", "provenance", "run"])(
		"refuses source lifetime changes while its confirmation card is pending (%s)",
		async change => {
			const host = new FakeHost({
				tabId: "source-a",
				title: "Source",
				sessionPath: "/s/time_source-a.jsonl",
				personTurn: true,
				status: "running",
				busy: true,
				busySince: 10,
			});
			const source = host.tabsById.get("source-a");
			if (!source) throw new Error("Missing source fixture");
			const service = control(host);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const confirm = host.confirm;
			host.confirm = async (caller, title, message) => {
				entered.resolve();
				await release.promise;
				return confirm(caller, title, message);
			};
			let bridgeDown = false;
			const command = host.command;
			host.command = async (tabId, request, timeoutMs) =>
				bridgeDown && request.type === "agent_control_turn"
					? bad("Original caller bridge is down")
					: command(tabId, request, timeoutMs);
			const closed: string[] = [];
			const closeView = vi.fn(async (caller: string, requested: SessionViewHandle) => {
				await service.authorizeView(caller, facts({ looked: true }), "host-a");
				closed.push(requested.tabId);
			});
			Object.assign(host, { closeView });
			const pending = service.run("source-a", T.stop, { session: handle.session, close: true, view: handle });
			await entered.promise;
			if (change === "bridge") bridgeDown = true;
			else if (change === "provenance") source.personTurn = false;
			else source.busySince = 20;
			release.resolve();
			const result = await pending;
			expect(result.isError, result.text).toBe(true);
			expect(result.text).toMatch(/caller|bridge|turn/i);
			expect(result.text).not.toMatch(/Closed view/);
			expect(closeView).toHaveBeenCalledTimes(1);
			expect(closed).toEqual([]);
			expect(host.views).toEqual([]);
			expect(host.spawned).toEqual([]);
			expect(host.deleted).toEqual([]);
			expect(host.deletedStored).toEqual([]);
			expect(host.sent.filter(entry => entry.command.type === "abort")).toEqual([]);
		},
	);

	it.each(["person", "agent", "caller-gone", "grants", "provenance"])(
		"routes native listing and fences source changes before B's final acknowledgement (%s)",
		async scenario => {
			const personTurn = scenario !== "agent";
			const revoked = scenario !== "person" && scenario !== "agent";
			const host = new FakeHost({
				tabId: "source-a",
				title: "Source",
				sessionPath: "/s/time_source-a.jsonl",
				personTurn,
				status: "running",
				busy: true,
				busySince: 10,
			});
			host.full = true;
			const saved = storedRow({
				id: handle.session,
				path: "/s/time_11111111-aaaa.jsonl",
				elsewhere: { holder: "host-b", work: "idle" },
			});
			const execution = summary({
				sessionPath: saved.path,
				sessionId: saved.id,
				title: saved.title,
				status: "ready",
				openFor: "host-b",
			});
			host.storedRows = [saved];
			host.localRows = [execution];
			const requests: { viewHost: string; tabId: string; token: string }[] = [];
			const acknowledgements: Promise<boolean>[] = [];
			function localSurface(viewHost: string, windowId: number, tabId: string) {
				const viewHandle: SessionViewHandle = {
					...handle,
					viewHost,
					window: String(windowId),
					tabId,
					incarnation: `${viewHost}-incarnation`,
				};
				const win: ClientWindow = {
					webContents: {
						id: windowId,
						send(channel, payload) {
							if (channel !== AGENT_CONTROL_VIEW) throw new Error("Unexpected window event");
							const request = z
								.object({ tabId: z.string(), how: z.literal("close"), closeRequest: z.string() })
								.parse(payload);
							requests.push({ viewHost, tabId: request.tabId, token: request.closeRequest });
							if (scenario === "caller-gone") host.tabsById.delete("source-a");
							if (scenario === "grants") host.full = false;
							if (scenario === "provenance") {
								const source = host.tabsById.get("source-a");
								if (!source) throw new Error("Missing source fixture");
								source.personTurn = false;
							}
							queueMicrotask(() => {
								acknowledgements.push(local.complete(win, request.tabId, request.closeRequest, false));
							});
						},
					},
					isDestroyed: () => false,
					once: () => undefined,
					removeListener: () => undefined,
				};
				const surface: LocalViewSurface = {
					win,
					facts: {
						...facts({ tabId, looked: true, userTouched: true }),
						handle: viewHandle,
					},
				};
				let shown = true;
				const detach = vi.fn(
					async (
						selected: LocalViewSurface,
						stillClosable: () => boolean,
						beforeCommit: () => Promise<() => boolean>,
					) => {
						const guard = await beforeCommit();
						if (!guard() || !stillClosable()) return false;
						expect(selected.win).toBe(win);
						expect(selected.facts.handle).toEqual(viewHandle);
						shown = false;
						return true;
					},
				);
				const local: LocalViewHost = new LocalViewHost({
					surfaces: () => (shown ? [surface] : []),
					close: detach,
					isWeb: () => false,
					timeoutMs: 1_000,
				});
				return { local, detach, viewHandle };
			}
			const b = localSurface("host-b", 2, "view-b");
			const c = localSurface("host-c", 3, "view-c");
			const controls = new Map<string, ViewControl>();
			for (const [id, local] of [
				["host-b", b.local],
				["host-c", c.local],
			] satisfies [string, LocalViewHost][]) {
				controls.set(
					id,
					new ViewControl({
						deviceId: () => id,
						listLocal: () => local.list(),
						closeLocal: (selected, authorized, beforeCommit) => local.close(selected, authorized, beforeCommit),
						remote: { peers: () => [], channel: () => null },
						timeoutMs: 1_000,
					}),
				);
			}
			const connections = new Map<string, { target: ViewControl; conn: HostConnection; channel: ViewChannel }>();
			const a: ViewControl = new ViewControl({
				deviceId: () => "host-a",
				listLocal: () => [],
				closeLocal: async () => {
					throw new Error("A has no target view to close");
				},
				remote: {
					peers: () => ["host-b", "host-c", "old-peer"],
					channel: peer => {
						if (peer === "old-peer") {
							return {
								identity: {},
								request: async () => {
									throw new Error("unsupported view protocol");
								},
							};
						}
						const existing = connections.get(peer);
						if (existing) return existing.channel;
						const target = controls.get(peer);
						if (!target) return null;
						const identity = {};
						const conn: HostConnection = {
							peer: {
								deviceId: "host-a",
								name: "A",
								staticPub: "test-key",
								nodeId: "node-a",
								login: "test",
								pairedAt: 0,
							},
							emit(event, data) {
								if (event !== "views.challenge") throw new Error("Unexpected transport event");
								void a.challenge(peer, identity, data).catch(() => undefined);
							},
							close: () => target.disconnected("host-a", conn),
						};
						target.connected("host-a", conn);
						const channel: ViewChannel = {
							identity,
							request: (method, params) => target.call("host-a", method, params, conn),
						};
						connections.set(peer, { target, conn, channel });
						return channel;
					},
				},
				timeoutMs: 1_000,
			});
			const service = control(host);
			const authorize = vi.fn((caller: string, fresh: ViewCloseFacts) =>
				service.authorizeView(caller, fresh, "host-a"),
			);
			Object.assign(host, {
				listViews: () => a.list(),
				closeView: (caller: string, selected: SessionViewHandle) => {
					let receipt: string | undefined;
					let active = true;
					return a.close(selected, {
						authorize: async fresh => {
							receipt = await authorize(caller, fresh);
						},
						validate: async () => {
							if (!receipt) throw new Error("Missing source authorization receipt");
							await service.validateViewAuthorization(receipt, selected);
						},
						release: async () => {
							if (receipt) await service.releaseViewAuthorization(receipt);
							receipt = undefined;
							active = false;
						},
						current: () => active,
					});
				},
			});
			try {
				const listed = await service.run("source-a", T.list, { scope: "app" });
				expect(listed.isError, listed.text).toBe(false);
				expect(listed.text).toContain("Source");
				expect(listed.text).toContain("old-peer");
				expect(listed.text).toContain("unsupported view protocol");
				const handleSchema = z
					.object({
						viewHost: z.string(),
						window: z.string(),
						tabId: z.string(),
						session: z.string(),
						incarnation: z.string(),
					})
					.strict();
				const listedHandles = listed.text
					.split("\n")
					.filter(line => line.startsWith("{"))
					.map(line => handleSchema.parse(JSON.parse(line)));
				expect(listedHandles).toEqual([b.viewHandle, c.viewHandle]);
				const selected = listedHandles.find(item => item.viewHost === "host-b");
				if (!selected) throw new Error("Native listing omitted B's actual view");
				expect([...host.tabsById.keys()]).toEqual(["source-a"]);
				const beforeClose = host.sent.length;
				const result = await service.run("source-a", T.stop, {
					session: selected.session,
					close: true,
					view: selected,
				});
				expect(result.isError, result.text).toBe(!personTurn || revoked);
				expect(result.text).toMatch(
					!personTurn
						? /not started by the user's own message/
						: revoked
							? /caller|grant|authorization|turn/i
							: /Closed view/,
				);
				expect(authorize).toHaveBeenCalledTimes(1);
				expect(authorize.mock.calls[0]?.[0]).toBe("source-a");
				expect(
					host.sent
						.slice(beforeClose)
						.every(entry => entry.tabId === "source-a" && entry.command.type === "agent_control_turn"),
				).toBe(true);
				expect(b.local.list().map(item => item.handle)).toEqual(personTurn && !revoked ? [] : [b.viewHandle]);
				expect(c.local.list().map(item => item.handle)).toEqual([c.viewHandle]);
				expect(b.detach).toHaveBeenCalledTimes(personTurn && !revoked ? 1 : 0);
				expect(c.detach).not.toHaveBeenCalled();
				expect(requests.map(request => [request.viewHost, request.tabId])).toEqual(
					personTurn ? [["host-b", "view-b"]] : [],
				);
				expect(await Promise.all(acknowledgements)).toEqual(personTurn ? [!revoked] : []);
				expect(host.storedRows).toEqual([saved]);
				expect(host.localRows).toEqual([execution]);
				expect(host.spawned).toEqual([]);
				expect(host.deleted).toEqual([]);
				expect(host.deletedStored).toEqual([]);
				expect(host.views).toEqual([]);
				expect(host.sent.some(entry => entry.command.type === "abort")).toBe(false);
				const unavailableClose = await service.run("source-a", T.stop, {
					session: handle.session,
					close: true,
					view: { ...handle, viewHost: "old-peer" },
				});
				expect(unavailableClose.isError).toBe(true);
				expect(unavailableClose.text).not.toContain("Closed view");
				expect(b.local.list().map(item => item.handle)).toEqual(personTurn && !revoked ? [] : [b.viewHandle]);
				expect(c.local.list().map(item => item.handle)).toEqual([c.viewHandle]);
			} finally {
				for (const { target, conn } of connections.values()) target.disconnected("host-a", conn);
			}
		},
	);

	it("binds each source authorization receipt to its exact view and consumes it only once", async () => {
		const host = new FakeHost({ tabId: "source-a", personTurn: true });
		host.full = true;
		const service: unknown = control(host);
		if (
			typeof service !== "object" ||
			service === null ||
			!("authorizeView" in service) ||
			typeof service.authorizeView !== "function" ||
			!("validateViewAuthorization" in service) ||
			typeof service.validateViewAuthorization !== "function" ||
			!("releaseViewAuthorization" in service) ||
			typeof service.releaseViewAuthorization !== "function"
		) {
			throw new Error("View authorization receipts are unavailable");
		}
		const receipt: unknown = await service.authorizeView("source-a", facts(), "host-a");
		if (typeof receipt !== "string" || receipt.length === 0) throw new Error("Missing source authorization receipt");
		await expect(
			service.validateViewAuthorization(receipt, { ...handle, incarnation: "replacement" }),
		).rejects.toThrow();
		await expect(service.validateViewAuthorization(receipt, handle)).rejects.toThrow();
		await expect(service.releaseViewAuthorization(receipt)).resolves.toBeUndefined();

		const fresh: unknown = await service.authorizeView("source-a", facts(), "host-a");
		if (typeof fresh !== "string" || fresh.length === 0) throw new Error("Missing source authorization receipt");
		await expect(service.validateViewAuthorization(fresh, handle)).resolves.toBeUndefined();
		await expect(service.validateViewAuthorization(fresh, handle)).rejects.toThrow();
		await expect(service.releaseViewAuthorization(fresh)).resolves.toBeUndefined();

		const released: unknown = await service.authorizeView("source-a", facts(), "host-a");
		if (typeof released !== "string" || released.length === 0)
			throw new Error("Missing source authorization receipt");
		await service.releaseViewAuthorization(released);
		await expect(service.validateViewAuthorization(released, handle)).rejects.toThrow();
		await expect(service.releaseViewAuthorization(released)).resolves.toBeUndefined();
	});

	it("validates receiver facts without dropping a real waiting request", () => {
		const view = facts({ asks: [select("Continue?", ["Yes", "No"])] });
		expect(parseViewCloseFacts(view).tab.asks).toEqual(view.tab.asks);
		expect(() => parseViewCloseFacts({ ...view, fullEnabled: "true" })).toThrow();
		expect(() => parseViewCloseFacts({ ...view, person: true })).toThrow();
		expect(() => parseViewCloseFacts({ ...view, handle: { ...handle, viewHost: "x".repeat(201) } })).toThrow();
		expect(() => parseViewCloseFacts({ ...view, tab: { ...view.tab, busy: "false" } })).toThrow();
		expect(() =>
			parseViewCloseFacts({ ...view, tab: { ...view.tab, asks: [{ id: "bad", request: { method: "select" } }] } }),
		).toThrow();
	});
});
