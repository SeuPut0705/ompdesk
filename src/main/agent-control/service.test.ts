import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotStartOptions, AutopilotStatus } from "../../../resources/gui-bridge/modes/autopilot-contracts";
import { type ClosedChild, AGENT_CONTROL_TOOLS as T, wrapAgentMessage } from "../../shared/agent-control";
import type {
	AgentMessage,
	ExtensionUIRequest,
	ExtensionUIResponse,
	RpcCommand,
	RpcGitUnlanded,
	RpcResponse,
} from "../../shared/rpc-types";
import type { ScheduleDraft } from "../../shared/schedules";
import type { RpcTurnEdits } from "../../shared/turn-edits";
import type { BranchEvidence, BranchFacts, LandingFacts, MergeOutcome, WorktreeRef, WorktreeRemoval } from "./branches";
import { CallJournal } from "./call-journal";
import type { MailDelivery } from "./mail";
import {
	AgentControl,
	type AgentControlHost,
	type AutopilotSource,
	type ControlAsk,
	type ControlDevice,
	type ControlTab,
	checksRun,
	currentStep,
	DRAFT_WAIT_MS,
	elapsedText,
	type OpenedChild,
	parseVerdict,
	renderMessage,
	type ScheduleRow,
	type ScheduleSource,
	type SpawnRequest,
	type StoredSession,
} from "./service";

const ok = (data: unknown = {}): RpcResponse => ({ type: "response", success: true, data }) as RpcResponse;
const bad = (error: string): RpcResponse => ({ type: "response", success: false, error }) as RpcResponse;

interface FakeTab extends ControlTab {
	last?: string;
	messages?: AgentMessage[];
	subagents?: { id: string; status: string }[];
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
	/** The control-tool calls this computer recorded (`call-journal.ts`); absent: none recorded. */
	calls?: CallJournal;

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
	tabs = (): ControlTab[] => [...this.tabsById.values()];
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
	};
	view = (_caller: string, event: { tabId: string; how: string }) => {
		this.views.push(event);
		if (event.how === "close") this.tabsById.delete(event.tabId);
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
	scheduleRows: ScheduleRow[] = [];
	scheduleSource: ScheduleSource | null = {
		list: async () => this.scheduleRows,
		save: async draft => {
			const row: ScheduleRow = {
				id: `sched${this.scheduleRows.length + 1}000`,
				name: draft.name,
				frequency: draft.frequency,
				cwd: draft.cwd,
				enabled: draft.enabled,
				nextRun: "2026-10-18T09:00:00.000Z",
				lastStatus: null,
			};
			this.scheduleRows.push(row);
			this.savedDrafts.push(draft);
			return row;
		},
		remove: async id => {
			this.scheduleRows = this.scheduleRows.filter(row => row.id !== id);
		},
	};
	savedDrafts: ScheduleDraft[] = [];
	/** The device each `schedules()` call asked for (undefined = this computer). */
	scheduleDevices: (string | undefined)[] = [];
	schedules = (device?: string) => {
		this.scheduleDevices.push(device);
		return this.scheduleSource;
	};
	autopilot: AutopilotSource | undefined;
	observe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	text = (key: string, params: Record<string, string>) => `${key}:${params.caller}:${params.target}`;
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
		this.mails.push({ to, content, details, delivery });
	};
	reviewChanged = vi.fn();

	spawn = async (caller: string, request: SpawnRequest) => {
		this.spawned.push(request);
		const tab = this.add({
			title: "",
			cwd: request.folder ?? "/repo",
			...(typeof request.device === "string" ? { device: request.device, deviceName: "DESKTOP-PC" } : {}),
			...(request.task ? { task: request.task } : {}),
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

	command = async (tabId: string, command: RpcCommand, timeoutMs?: number): Promise<RpcResponse> => {
		this.sent.push({ tabId, command });
		const tab = this.tabsById.get(tabId);
		if (!tab) return bad("gone");
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
			case "get_subagents":
				return ok({ subagents: tab.subagents ?? [] });
			case "get_transcript_page":
				return ok({
					messages: tab.messages ?? [],
					totalMessages: (tab.messages ?? []).length,
					prevCursor: command.cursor ? undefined : "cur1",
				});
			case "get_available_models":
				return ok({ models: [{ provider: "anthropic", id: "claude-x" }] });
			case "get_turn_edits":
				return tab.turn ? ok(tab.turn) : bad("unknown command: get_turn_edits");
			case "get_git_unlanded":
				return ok(tab.unlanded ?? null);
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

function control(host: AgentControlHost, timers?: ConstructorParameters<typeof AgentControl>[1]) {
	return new AgentControl(host, timers);
}

/** `call` on a fake clock moved until it settles, so a bounded wait for a device's link passes in no real time. */
async function onFakeClock<T>(call: () => Promise<T>): Promise<T> {
	vi.useFakeTimers();
	try {
		const pending = call();
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		for (let step = 0; step < 400 && !settled; step++) await vi.advanceTimersByTimeAsync(250);
		return await pending;
	} finally {
		vi.useRealTimers();
	}
}

/**
 * Runs `call` while the omp of the tab it closes has not exited (`host.exited` waits on it): `pendingWhileRunning` says
 * whether `call` was still going a second of the fake clock later, and `result` is what it returned once the omp exited.
 */
async function whileOmpRuns<T>(
	host: FakeHost,
	call: () => Promise<T>,
): Promise<{ pendingWhileRunning: boolean; result: T }> {
	vi.useFakeTimers();
	try {
		const exit = Promise.withResolvers<void>();
		host.exited = () => exit.promise;
		let settled = false;
		const pending = call().finally(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(1_000);
		const pendingWhileRunning = !settled;
		exit.resolve();
		return { pendingWhileRunning, result: await pending };
	} finally {
		vi.useRealTimers();
	}
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
				subagents: [{ id: "s1", status: "running" }],
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

describe("elapsedText", () => {
	it("says how long a turn has run in seconds, minutes, then hours and minutes", () => {
		expect(elapsedText(40_400)).toBe("40 s");
		expect(elapsedText(12 * 60_000 + 59_000)).toBe("12 min");
		expect(elapsedText(2 * 3_600_000)).toBe("2 h");
		expect(elapsedText(2 * 3_600_000 + 5 * 60_000)).toBe("2 h 5 min");
	});
});

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

	it("marks a just-started session a worker even when its omp takes longer than the default 8 s to answer", async () => {
		const host = new FakeHost({ tabId: "main0001", title: "Boss" });
		host.workerAnswersAfterMs = 12_000;
		const result = await control(host).run("main0001", T.open, { message: "go", worktree: { base: "default" } });
		expect(result.isError).toBe(false);
		expect(result.text).toContain("Opened session");
		const child = [...host.tabsById.keys()].find(id => id !== "main0001") ?? "";
		expect(prompts(host, child)).toHaveLength(1);
		expect(host.discarded).toEqual([]);
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
		const result = await onFakeClock(() => control(host).run("main0001", T.open, { message: "go", worktree: true }));
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

	it("waits while the person types into the target, then sends; gives up after a minute with nothing sent", async () => {
		vi.useFakeTimers();
		try {
			const host = new FakeHost({ tabId: "main0001", title: "Boss" }, { tabId: "work0002", drafting: true });
			const service = control(host);
			const sending = service.run("main0001", T.send, { session: "work0002", message: "please review" });
			await vi.advanceTimersByTimeAsync(5_000);
			expect(prompts(host, "work0002")).toEqual([]);
			(host.tabsById.get("work0002") as FakeTab).drafting = false;
			for (const listener of host.listeners) listener();
			expect((await sending).text).toContain("it was idle and starts on it");
			expect(prompts(host, "work0002")).toHaveLength(1);

			(host.tabsById.get("work0002") as FakeTab).drafting = true;
			const refused = service.run("main0001", T.send, { session: "work0002", message: "and this" });
			await vi.advanceTimersByTimeAsync(DRAFT_WAIT_MS + 1_000);
			const result = await refused;
			expect(result.isError).toBe(true);
			expect(result.text).toContain("The person is typing in");
			expect(prompts(host, "work0002")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("sees a draft the person starts while the send reads the target's journal", async () => {
		vi.useFakeTimers();
		try {
			const host = new FakeHost({ tabId: "main0001", title: "Boss" }, { tabId: "work0002" });
			// host.ts builds new tab objects on every read: a listing is a snapshot.
			host.tabs = () => [...host.tabsById.values()].map(tab => ({ ...tab }));
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
			await vi.advanceTimersByTimeAsync(10);
			(host.tabsById.get("work0002") as FakeTab).drafting = true;
			release();
			await vi.advanceTimersByTimeAsync(5_000);
			expect(prompts(host, "work0002")).toEqual([]);
			(host.tabsById.get("work0002") as FakeTab).drafting = false;
			for (const listener of host.listeners) listener();
			expect((await sending).isError).toBeFalsy();
			expect(prompts(host, "work0002")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("answers a repeat of a delivered request at once, never waiting on the person's draft", async () => {
		vi.useFakeTimers();
		try {
			const host = new FakeHost({ tabId: "main0001", title: "Boss" }, { tabId: "work0002" });
			const service = control(host);
			const args = { session: "work0002", message: "please review", request_id: "r1" };
			expect((await service.run("main0001", T.send, args)).isError).toBeFalsy();
			(host.tabsById.get("work0002") as FakeTab).drafting = true;
			let answered: { text: string; isError?: boolean } | undefined;
			void service.run("main0001", T.send, args).then(result => {
				answered = result;
			});
			await vi.advanceTimersByTimeAsync(10);
			expect(answered?.isError).toBeFalsy();
			expect(answered?.text).toMatch(/already delivered; nothing sent again/);
			expect(prompts(host, "work0002")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("delivers a steer to a running session and a follow-up by default", async () => {
		const host = new FakeHost({ tabId: "main0001" }, { tabId: "work0002", busy: true });
		const service = control(host);
		await service.run("main0001", T.send, { session: "work0002", message: "now", delivery: "steer" });
		await service.run("main0001", T.send, { session: "work0002", message: "later" });
		const behaviours = host.sent
			.filter(entry => entry.command.type === "prompt")
			.map(entry => (entry.command as { streamingBehavior?: string }).streamingBehavior);
		expect(behaviours).toEqual(["steer", "followUp"]);
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
		await vi.waitFor(() => expect(host.listeners.size).toBeGreaterThan(0));
		const a = host.tabsById.get("work0002") as FakeTab;
		a.busy = false;
		const polls = () => host.sent.filter(entry => entry.command.type === "get_last_assistant_text").length;
		const before = polls();
		host.emit();
		await vi.waitFor(() => expect(polls()).toBeGreaterThan(before));
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
		vi.useFakeTimers();
		try {
			const waiting = control(slow).run("main0001", T.result, {
				session: "work0002",
				wait: true,
				timeout_seconds: 1,
			});
			await vi.advanceTimersByTimeAsync(5000);
			expect((await waiting).text).toMatch(/Still running after waiting 1 s/);
		} finally {
			vi.useRealTimers();
		}
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

	it("currentStep and renderMessage read the tail rules", () => {
		expect(currentStep(messages)).toBeNull();
		expect(currentStep(messages.slice(0, 2))).toBe("running read (look at a.ts)");
		expect(renderMessage({ role: "system" })).toBeNull();
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
		expect(service.childrenOf("main0001").sort()).toEqual([...ids].sort());
		host.tabsById.delete(ids[0] as string);
		expect(service.childrenOf("main0001")).toEqual([ids[1]]);
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
		expect(host.cards).toEqual([{ title: "mergeTitle:undefined:undefined", message: "mergeMessage:Boss:Alpha" }]);
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
			{ title: "scheduleTitle:undefined:undefined", message: "scheduleMessage:Boss:undefined" },
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
			/exactly one of every_minutes or daily_at/,
		);
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
		expect(listed.text).toContain("[made by an agent: you can cancel it]");
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

	it("says so when there is no Schedules service", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		host.scheduleSource = null;
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
		expect(host.scheduleDevices).toEqual(["studio-id"]);
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
		const offline = await onFakeClock(() => service.run("main0001", T.schedule, { action: "list", device: "PC" }));
		expect(offline.isError).toBe(true);
		expect(offline.text).toMatch(/PC is offline/);
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
				parallel: 2,
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
			maxParallel: 2,
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
		expect(service.childrenOf("main0001")).toEqual(["apr10000", "apr20000"]);

		host.deviceList = [{ id: "dev1", name: "Mac", state: "offline" }];
		const away = await onFakeClock(() =>
			service.run("main0001", T.autopilot, { action: "start", device: "Mac", folder: "/far" }),
		);
		expect(away.text).toMatch(/offline/);
		expect(pilot.starts).toHaveLength(2);
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
		expect(service.childrenOf("main0001")).toEqual(["apr10000"]);
	});
});

describe("autoClose: opened sessions whose work landed", () => {
	/** The caller opens one session; its tab then reads as a finished, agent-opened child with a stored file. */
	async function finishedChild(options: { worktree?: boolean; patch?: Partial<FakeTab> } = {}) {
		const host = new FakeHost({ tabId: "main0001", title: "Boss", sessionPath: "/s/boss.jsonl" });
		const service = control(host);
		await service.run("main0001", T.open, { message: "do it", ...(options.worktree ? { worktree: true } : {}) });
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
				closedAt: expect.any(Number),
				model: "openai/gpt-z",
				cost: 0.42,
			},
		]);
		expect(host.deleted).toEqual([]);
		expect(host.removed).toEqual([]);
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

		it("still sends the done mail after a progress report or a question on the same dispatch", async () => {
			for (const kind of ["progress", "question", "note"] as const) {
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

	it("closes only on a Result: ok line, whatever the prose says", async () => {
		for (const [last, closed] of [
			["All tests failed, nothing works.\nResult: problem — tests failed", false],
			["Everything is done and checked.", false],
			["Done.\nResult: ok", true],
		] as const) {
			const { host, service } = await finishedChild({ patch: { last } });
			await service.autoClose("main0001");
			expect(closes(host), last).toHaveLength(closed ? 1 : 0);
		}
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
			finalTurn("Done.\nResult: problem — tests failed"),
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
		const off = await onFakeClock(() => service.run("main0001", T.list, { scope: "stored", device: "Laptop" }));
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
		expect((await service.run("main0001", T.read, { session: "11111111-aaaa", before: "99" })).isError).toBe(true);
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
			{ tabId: "open0002", title: "Live", messages: [{ role: "user", content: "live text" } as AgentMessage] },
		);
		host.storedRows = [storedRow({ tabId: "open0002" })];
		const text = (await control(host).run("main0001", T.read, { session: "11111111-aaaa" })).text;
		expect(text).toContain('"Live"');
		expect(text).toContain("live text");
	});
});

describe("ompdesk_session_open on a device and reopen", () => {
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
		const off = await onFakeClock(() => service.run("main0001", T.open, { device: "Laptop" }));
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
		const host = new FakeHost({ tabId: "main0001" }, { tabId: "open0002" });
		host.storedRows = [storedRow({ tabId: "open0002" }), storedRow({ id: "44444444-dddd", hidden: true })];
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

describe("checksRun and parseVerdict", () => {
	it("keeps check-like bash commands with their outcome and skips the rest", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "a", name: "bash", arguments: { command: "ls -la" } }],
			},
			{ role: "toolResult", toolCallId: "a", content: "x" },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "b", name: "bash", arguments: { command: "cargo test" } }],
			},
			{ role: "toolResult", toolCallId: "b", content: "test result: FAILED. exit code 101" },
			{ role: "bashExecution", command: "bun run lint", exitCode: 0 },
		] as AgentMessage[];
		expect(checksRun(messages)).toEqual([
			{ command: "cargo test", passed: false, tail: "test result: FAILED. exit code 101" },
			{ command: "bun run lint", passed: true, tail: "" },
		]);
	});

	it("reads the verdict JSON out of prose and refuses a wrong shape", () => {
		expect(parseVerdict('ok {"ranking":[{"session":"a","score":5}],"winner":null} done')).toMatchObject({
			ranking: [{ session: "a", score: 5, criteria: [] }],
			winner: null,
		});
		expect(parseVerdict('{"ranking":[{"session":"a","score":500}]}')).toBeNull();
		expect(parseVerdict("no json")).toBeNull();
	});
});

describe("ompdesk_report: sessions tell their opener", () => {
	async function family() {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss" });
		const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
		const service = control(host, {
			setTimer: (fn, ms) => {
				const timer = { fn, ms, cleared: false };
				timers.push(timer);
				return timer;
			},
			clearTimer: timer => {
				(timer as { cleared: boolean }).cleared = true;
			},
		});
		const opened = await service.run("boss0001", T.open, {
			sessions: [{ message: "Title: part A\nDo A" }, { message: "Title: part B\nDo B" }],
		});
		const [a, b] = [...opened.text.matchAll(/Opened session (\w+)/g)].map(match => match[1] as string);
		const fire = () => {
			for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn();
		};
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
		await service.run(a, T.report, { kind: "question", text: "Keep the old API?" });
		const child = host.tabsById.get(a);
		if (!child) throw new Error("no child");
		// The person answered in the child's own tab: its next turn started after the question.
		child.busy = true;
		child.busySince = Date.now() + 1;
		const item = (await service.reviewItems("boss0001")).find(entry => entry.tabId === a);
		expect(item?.waiting).toBeUndefined();
		expect(item?.state).toBe("running");
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
		fire();
		await Promise.resolve();
		expect(host.mails).toHaveLength(1);
		expect(host.mails[0]?.details).toMatchObject({ text: "step 2", merged: 1 });
		expect(host.mails[0]?.delivery).toEqual({ triggerTurn: false });
		await service.run(a, T.report, { kind: "progress", text: "step 3" });
		await service.run(a, T.report, { kind: "done", text: "finished" });
		fire();
		await Promise.resolve();
		expect(host.mails.map(mail => mail.details.text)).toEqual(["step 2", "finished"]);
	});

	it("sends progress to a busy opener as a no-turn report, never stock's hidden next-turn queue", async () => {
		const { host, service, a, fire } = await family();
		const boss = host.tabsById.get("boss0001");
		if (boss) boss.busy = true;
		await service.run(a, T.report, { kind: "progress", text: "halfway" });
		fire();
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

	it("never closes a session the user looks at or typed into, its own child included", async () => {
		const host = new FakeHost(
			{ tabId: "boss0001", title: "Boss" },
			{ tabId: "seen0002", looked: true },
			{ tabId: "typed003", userTouched: true },
		);
		host.parents.set("seen0002", "boss0001");
		const service = control(host);
		for (const session of ["seen0002", "typed003"]) {
			const refused = await service.run("boss0001", T.stop, { session, close: true });
			expect(refused.isError).toBe(true);
			expect(refused.text).toMatch(/user's view or they typed/);
		}
		expect(host.views).toEqual([]);
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

	it("tells a busy child that reports of a follow-up queued for it, and steers the next one", async () => {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss" });
		const service = control(host);
		const opened = await service.run("boss0001", T.open, { message: "Title: part A\nDo A" });
		const kid = /Opened session (\w+)/.exec(opened.text)?.[1] as string;
		// The child works (its first prompt made it busy); the opener queues more work behind its turn.
		const queued = await service.run("boss0001", T.send, { session: kid, message: "Also do C" });
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
		await service.run("boss0001", T.send, { session: kid, message: "Also do C" });
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
		abortAfter: number | null = 12_000;
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

	function world(): MatrixHost {
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
		// The Laptop's link was blipping: it comes back two seconds in, and its tab re-attaches.
		setTimeout(() => {
			const lap = host.deviceList.find(device => device.id === "lap");
			if (lap) lap.state = "online";
			const blip = host.tabsById.get("blip5555");
			if (blip) blip.status = "ready";
			host.emit();
		}, 2_000);
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
		"send · title": { tool: T.send, args: { session: "Busy builder", message: "go" }, ok: /queued as a follow-up/ },
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
		const outcome = await onFakeClock(() => {
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
		const { outcome, waited } = await onFakeClock(async () => {
			const host = world();
			// The Laptop never comes back this time.
			vi.clearAllTimers();
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
	/**
	 * `laterCalls(…, 600)` writes the journal file 1,800 times, each a synchronous atomic write of up to 500 records:
	 * 0.4 s here, past vitest's 5 s on a loaded CI runner (check (node), 21 Oct 2026).
	 */
	const LATER_CALLS_TIMEOUT_MS = 30_000;

	// 21 Oct 2026: a host re-sends every host tool call its omp still waits on to a relaunched device (host-services.ts
	// `hostCalls`), and the device may have carried the call out before it died, between the effect and the result.
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-control-calls-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	const file = () => join(dir, "agent-control-calls.json");
	/** The first delivery of host call `call-1`, and the host's re-send of it to a relaunched device. */
	const first1 = { id: "call-1" };
	const resent1 = { id: "call-1", resent: true };
	const DAY = 24 * 60 * 60_000;

	/** This computer as it relaunched: a new caller tab id on the same session file, the journal read back from disk. */
	function relaunch(host: FakeHost, from: string, to: string, now?: () => number): void {
		const caller = host.tabsById.get(from);
		host.tabsById.delete(from);
		if (caller) host.add({ ...caller, tabId: to });
		for (const [child, parent] of host.parents) if (parent === from) host.parents.set(child, to);
		host.calls = new CallJournal(file(), now);
	}

	/** The app dies right after the call's effect: its result is never written. */
	function dyingAfterTheEffect(journal: CallJournal): CallJournal {
		journal.finish = () => {};
		return journal;
	}

	/** Days pass and `count` other calls run, each answered and taken by its host. */
	function laterCalls(journal: CallJournal, clock: { at: number }, count: number): void {
		clock.at += 4 * DAY;
		for (let index = 0; index < count; index++) {
			journal.begin({ key: `\n/s/other.jsonl\nlater-${index}`, tool: T.send, callerTabId: "other003" });
			journal.finish(`\n/s/other.jsonl\nlater-${index}`, { text: "ok", isError: false });
			journal.acknowledge(`later-${index}`);
		}
	}

	it("opens one session when the app died after opening it and before recording the result", async () => {
		const host = new FakeHost({ tabId: "boss0001", title: "Boss", sessionPath: "/s/boss.jsonl" });
		host.calls = dyingAfterTheEffect(new CallJournal(file()));
		const first = await control(host).run("boss0001", T.open, { message: "Title: Part A\nDo A" }, first1);
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
		host.calls = new CallJournal(file());
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
		host.calls = dyingAfterTheEffect(new CallJournal(file()));
		// The app dies before the session opened (the spawn never came back).
		const spawn = host.spawn;
		host.spawn = async () => {
			throw new Error("the app quit");
		};
		await control(host).run("boss0001", T.open, { message: "Do A" }, first1);
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
		host.calls = dyingAfterTheEffect(new CallJournal(file()));
		const args = { action: "create", name: "Nightly", prompt: "run checks", every_minutes: 60 };
		await control(host).run("boss0001", T.schedule, args, first1);
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

	it(
		"keeps a call the host has not acknowledged past 3 days and 500 newer calls: replayed then, it still runs once",
		async () => {
			// A host waits on a call with no time limit, so it may re-send one days and many calls later.
			const clock = { at: Date.UTC(2026, 9, 21) };
			const now = () => clock.at;
			const host = new FakeHost({ tabId: "boss0001", title: "Boss", sessionPath: "/s/boss.jsonl" });
			host.calls = dyingAfterTheEffect(new CallJournal(file(), now));
			await control(host).run("boss0001", T.open, { message: "Do A" }, first1);
			// A finished call whose result never reached the host stays too.
			const finished = new CallJournal(file(), now);
			host.calls = finished;
			const answered = await control(host).run("boss0001", T.open, { message: "Do B" }, { id: "call-2" });
			laterCalls(finished, clock, 600);

			relaunch(host, "boss0001", "boss0002", now);
			expect((await control(host).run("boss0002", T.open, { message: "Do A" }, resent1)).text).toMatch(
				/before OMPdesk restarted/,
			);
			expect(
				await control(host).run("boss0002", T.open, { message: "Do B" }, { id: "call-2", resent: true }),
			).toEqual(answered);
			expect(host.spawned).toHaveLength(2);
		},
		LATER_CALLS_TIMEOUT_MS,
	);

	it(
		"forgets an acknowledged call in time, and a re-sent call it has no record of is reconciled, never run",
		async () => {
			const clock = { at: Date.UTC(2026, 9, 21) };
			const now = () => clock.at;
			const host = new FakeHost({ tabId: "boss0001", title: "Boss", sessionPath: "/s/boss.jsonl" });
			const journal = new CallJournal(file(), now);
			host.calls = journal;
			await control(host).run("boss0001", T.open, { message: "Title: Part A\nDo A" }, first1);
			journal.acknowledge("call-1");
			laterCalls(journal, clock, 600);
			expect(journal.get("\n/s/boss.jsonl\ncall-1")).toBeUndefined();

			// Forgotten (or a new profile): the host's re-send finds the session it opened instead of opening another.
			relaunch(host, "boss0001", "boss0002", now);
			const again = await control(host).run("boss0002", T.open, { message: "Title: Part A\nDo A" }, resent1);
			expect(again.text).toMatch(/before OMPdesk restarted/);
			// Nothing to find: its outcome is unknown, and still nothing runs.
			const nothing = await control(host).run(
				"boss0002",
				T.open,
				{ message: "Do C" },
				{ id: "call-9", resent: true },
			);
			expect(nothing.isError).toBe(true);
			expect(nothing.text).toMatch(/outcome is unknown after OMPdesk restarted/);
			expect(host.spawned).toHaveLength(1);
		},
		LATER_CALLS_TIMEOUT_MS,
	);
});
