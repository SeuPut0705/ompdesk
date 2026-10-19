import { describe, expect, it, vi } from "vitest";
import type { AutopilotStartOptions, AutopilotStatus } from "../../../resources/gui-bridge/modes/autopilot-contracts";
import { type ClosedChild, AGENT_CONTROL_TOOLS as T, wrapAgentMessage } from "../../shared/agent-control";
import type {
	AgentMessage,
	ExtensionUIRequest,
	ExtensionUIResponse,
	RpcCommand,
	RpcResponse,
} from "../../shared/rpc-types";
import type { ScheduleDraft } from "../../shared/schedules";
import type { BranchEvidence, BranchFacts, LandingFacts, MergeOutcome, WorktreeRef, WorktreeRemoval } from "./branches";
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
	type OpenedChild,
	parseVerdict,
	renderMessage,
	type ScheduleRow,
	type ScheduleSource,
	type ShipLevel,
	type SpawnRequest,
	type StoredSession,
} from "./service";

const ok = (data: unknown = {}): RpcResponse => ({ type: "response", success: true, data }) as RpcResponse;
const bad = (error: string): RpcResponse => ({ type: "response", success: false, error }) as RpcResponse;

interface FakeTab extends ControlTab {
	last?: string;
	messages?: AgentMessage[];
	subagents?: { id: string; status: string }[];
	todos?: { name: string; tasks: { content: string; status: string }[] }[];
	/** What the fake omp answers `get_state.model` and `get_session_stats.history.cost` with. */
	model?: { provider: string; id: string };
	cost?: number;
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
	tasks = new Map<string, string>();
	setTask = (tabId: string, task: string) => {
		this.tasks.set(tabId, task);
	};
	view = (_caller: string, event: { tabId: string; how: string }) => {
		this.views.push(event);
		if (event.how === "close") this.tabsById.delete(event.tabId);
	};
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
	recordClosed = (child: ClosedChild) => {
		this.closedRecords.push(child);
	};
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
			status: "ready",
			...(request.worktree
				? { worktree: { name: "w", branch: "omp/agent/w", baseCwd: "/repo", path: "/wt/w" } }
				: {}),
		});
		this.parents.set(tab.tabId, caller);
		return { tabId: tab.tabId, ...(tab.worktree ? { worktree: tab.worktree } : {}) };
	};

	command = async (tabId: string, command: RpcCommand): Promise<RpcResponse> => {
		this.sent.push({ tabId, command });
		const tab = this.tabsById.get(tabId);
		if (!tab) return bad("gone");
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
		expect(result.text).toMatch(/work0002 "Worker".*\n\s+running, running bash \(run vitest\)/);
		expect(result.text).toContain("1 subagent(s) running");
		expect(result.text).toContain("todos 1/2 done (now: test it)");
		expect(result.text).toContain("last answer: I fixed the parser");
		expect(result.text).toContain(`waiting for the user's answer: "Allow tool: bash"`);
		expect(result.text).toContain("priv0004 (hidden from agents by the user)");
		expect(result.text).not.toContain("Secret plans");
		expect(result.text).not.toContain("classified");
		expect(result.text).toContain("this session");
	});

	it("refuses when the switch is off or the caller's tab is gone", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		host.enabled = () => false;
		expect((await control(host).run("main0001", T.list, {})).text).toMatch(/turned off/);
		const other = new FakeHost({ tabId: "main0001" });
		expect((await control(other).run("zzzz9999", T.list, {})).isError).toBe(true);
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
		const many = Array.from({ length: 10 }, (_, index) => ({ message: `part ${index}` }));
		expect((await service.run("main0001", T.open, { sessions: many })).isError).toBe(false);
		expect((await service.run("main0001", T.open, { message: "one more" })).isError).toBe(false);
		expect(host.tabsById.size - 1).toBe(11);
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

	it("refuses hidden and not-started sessions", async () => {
		const host = new FakeHost(
			{ tabId: "main0001" },
			{ tabId: "work0002", hidden: true },
			{ tabId: "work0003", status: "asleep" },
		);
		const service = control(host);
		expect((await service.run("main0001", T.read, { session: "work0002" })).text).toMatch(/hid this session/);
		expect((await service.run("main0001", T.read, { session: "work0003" })).text).toMatch(/has not started/);
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
		expect(items.find(item => item.tabId === ids[0])).toMatchObject({ commitsAhead: 2 });
		const deleted = await service.run("main0001", T.stop, { session: ids[1], delete: true });
		expect(deleted.text).toContain("Removed its worktree /wt/omp/agent/b and branch omp/agent/b.");
		expect(host.gitCalls.length).toBeGreaterThan(0);
		expect(host.gitCalls.every(call => call.device === desktop.id)).toBe(true);
		expect(host.gitCalls).toContainEqual({ op: "remove", branch: "omp/agent/b", device: desktop.id });
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

	it("tells what every opened session runs on and cost, a landed one without an item included", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		Object.assign(host.tabsById.get(ids[0]) as FakeTab, {
			model: { provider: "anthropic", id: "claude-x" },
			cost: 0.3,
		});
		Object.assign(host.tabsById.get(ids[1]) as FakeTab, { cost: 0.12 });
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
		expect(review.usage).toEqual({
			"/s/kid0.jsonl": { model: "anthropic/claude-x", cost: 0.3 },
			"/s/kid1.jsonl": { cost: 0.12 },
		});
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
		const offline = await service.run("main0001", T.schedule, { action: "list", device: "PC" });
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
		defaultShip: ShipLevel = "commit";
		defaultBranch: string | null = "main";
		failStart: string | null = null;
		n = 0;
		constructor(readonly host: FakeHost) {}
		plan = async () => ({ defaultShip: this.defaultShip, defaultBranch: this.defaultBranch });
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
		expect(pilot.starts).toEqual([{ caller: "main0001", source: "main0001", options: {} }]);
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

	it("treats a stored release preference as release", async () => {
		const { host, pilot, service } = setup();
		host.manage = true;
		pilot.defaultShip = "release";
		await service.run("main0001", T.autopilot, { action: "start" });
		expect(host.cards).toHaveLength(1);
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
				notify: "cycles",
				backlog: ["one", "two"],
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
			notify: "cycles",
			backlog: ["one", "two"],
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
		const away = await service.run("main0001", T.autopilot, { action: "start", device: "Mac", folder: "/far" });
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
		const off = await service.run("main0001", T.list, { scope: "stored", device: "Laptop" });
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
		const off = await service.run("main0001", T.open, { device: "Laptop" });
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

	it("names the dispatch in the child's task, and a done report wakes the opener after its turn", async () => {
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
		expect(mail?.delivery).toEqual({ triggerTurn: true, deliverAs: "followUp" });
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

	it("holds progress for a busy opener's next turn", async () => {
		const { host, service, a, fire } = await family();
		const boss = host.tabsById.get("boss0001");
		if (boss) boss.busy = true;
		await service.run(a, T.report, { kind: "progress", text: "halfway" });
		fire();
		await Promise.resolve();
		expect(host.mails[0]?.delivery).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });
	});

	it("lets a child write to a sibling as a note, never to an outsider, and refuses a session nobody opened", async () => {
		const { host, service, a, b } = await family();
		host.add({ tabId: "else0009", title: "Other" });
		await service.run(a, T.report, { kind: "done", to: b, text: "I changed X, rebase" });
		expect(host.mails[0]).toMatchObject({ to: b, details: { kind: "note" } });
		expect((await service.run(a, T.report, { kind: "note", to: "else0009", text: "hi" })).text).toMatch(
			/only to the session that opened you or to a sibling/,
		);
		expect((await service.run("boss0001", T.report, { kind: "done", text: "x" })).text).toMatch(/nobody opened/);
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
