import { describe, expect, it, vi } from "vitest";
import {
	MAX_AGENT_SCHEDULES,
	MAX_AGENT_SESSIONS,
	MAX_OPENS_PER_TURN,
	AGENT_CONTROL_TOOLS as T,
	wrapAgentMessage,
} from "../../shared/agent-control";
import type {
	AgentMessage,
	ExtensionUIRequest,
	ExtensionUIResponse,
	RpcCommand,
	RpcResponse,
} from "../../shared/rpc-types";
import type { ScheduleDraft } from "../../shared/schedules";
import type { BranchFacts, MergeOutcome, WorktreeRef } from "./branches";
import { AgentLimits } from "./limits";
import {
	AgentControl,
	type AgentControlHost,
	type ControlAsk,
	type ControlTab,
	currentStep,
	type OpenedChild,
	renderMessage,
	type ScheduleRow,
	type ScheduleSource,
	type SpawnRequest,
} from "./service";

const ok = (data: unknown = {}): RpcResponse => ({ type: "response", success: true, data }) as RpcResponse;
const bad = (error: string): RpcResponse => ({ type: "response", success: false, error }) as RpcResponse;

interface FakeTab extends ControlTab {
	last?: string;
	messages?: AgentMessage[];
	subagents?: { id: string; status: string }[];
	todos?: { name: string; tasks: { content: string; status: string }[] }[];
}

class FakeHost implements AgentControlHost {
	tabsById = new Map<string, FakeTab>();
	sent: { tabId: string; command: RpcCommand }[] = [];
	views: { tabId: string; how: string }[] = [];
	cards: { title: string; message: string }[] = [];
	cardAnswer = true;
	approve = false;
	manage = false;
	stopping = new Set<string>();
	turnNo = 1;
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
	manageEnabled = () => this.manage;
	turn = () => this.turnNo;
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
	facts = new Map<string, BranchFacts>();
	mergeResult: MergeOutcome = { merged: true, sha: "abc1234", summary: "2 files changed" };
	merges: string[] = [];
	discarded: string[] = [];
	branchFacts = async (worktree: WorktreeRef): Promise<BranchFacts> => {
		const facts = this.facts.get(worktree.branch);
		if (!facts) throw new Error("no such branch");
		return facts;
	};
	mergeBranch = async (worktree: WorktreeRef) => {
		this.merges.push(worktree.branch);
		return this.mergeResult;
	};
	discardWorktree = async (worktree: WorktreeRef) => {
		this.discarded.push(worktree.branch);
	};
	scheduleRows: ScheduleRow[] = [];
	scheduleSource: ScheduleSource | null = {
		list: () => this.scheduleRows,
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
	schedules = () => this.scheduleSource;
	observe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	text = (key: string, params: Record<string, string>) => `${key}:${params.caller}:${params.target}`;

	spawn = async (_caller: string, request: SpawnRequest) => {
		this.spawned.push(request);
		const tab = this.add({
			title: "",
			cwd: request.folder ?? "/repo",
			status: "ready",
			...(request.worktree
				? { worktree: { name: "w", branch: "omp/agent/w", baseCwd: "/repo", path: "/wt/w" } }
				: {}),
		});
		return { tabId: tab.tabId, ...(tab.worktree ? { worktree: tab.worktree } : {}) };
	};

	command = async (tabId: string, command: RpcCommand): Promise<RpcResponse> => {
		this.sent.push({ tabId, command });
		const tab = this.tabsById.get(tabId);
		if (!tab) return bad("gone");
		switch (command.type) {
			case "get_state":
				return ok({ isStreaming: tab.busy, todoPhases: tab.todos ?? [], planModeEnabled: false });
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
			default:
				return ok();
		}
	};
}

function control(host: AgentControlHost, limits?: AgentLimits) {
	return new AgentControl(host, limits ?? new AgentLimits());
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
		expect(prompts(host, one as string)[0]).toBe(wrapAgentMessage("part one", "Boss"));
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

	it("holds the per-turn, per-hour and open-at-once caps", async () => {
		const host = new FakeHost({ tabId: "main0001" });
		const service = control(host);
		const many = Array.from({ length: MAX_OPENS_PER_TURN + 1 }, () => ({ message: "x" }));
		expect((await service.run("main0001", T.open, { sessions: many })).isError).toBe(true);
		expect((await service.run("main0001", T.open, { sessions: many.slice(0, MAX_OPENS_PER_TURN) })).isError).toBe(
			false,
		);
		const again = await service.run("main0001", T.open, { message: "one more" });
		expect(again.text).toMatch(/This turn/);
		host.turnNo = 2;
		expect((await service.run("main0001", T.open, { message: "next turn" })).isError).toBe(false);
		host.turnNo = 3;
		expect((await service.run("main0001", T.open, { message: "sixth" })).isError).toBe(false);
		expect(host.tabsById.size - 1).toBe(MAX_AGENT_SESSIONS);
		host.turnNo = 4;
		const atOnce = await service.run("main0001", T.open, { message: "seventh" });
		expect(atOnce.isError).toBe(true);
		expect(atOnce.text).toMatch(/open at once/);
		expect(host.tabsById.size - 1).toBe(MAX_AGENT_SESSIONS);
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
		expect(result.text).toContain("it was idle and started on it");
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

	it("cuts a relay chain and spends the message budget per turn", async () => {
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
		const cut = await service.run("dddd0004", T.send, { session: "eeee0005", message: "4" });
		expect(cut.isError).toBe(true);
		expect(cut.text).toMatch(/hop/);
		expect(prompts(host, "eeee0005")).toEqual([]);
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
		expect(stopped.text).toContain("Stopped and closed");
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

	it("skips the card when the user turned it off", async () => {
		const host = new FakeHost({ tabId: "main0001" }, { tabId: "work0002", busy: true });
		host.manage = true;
		expect((await control(host).run("main0001", T.stop, { session: "work0002" })).text).toMatch(/Stopped/);
		expect(host.cards).toHaveLength(0);
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

	it("explains a session without a worktree, a remote one, and an empty default", async () => {
		const host = new FakeHost(
			{ tabId: "main0001" },
			{ tabId: "plain002", title: "Plain", last: "done" },
			{
				tabId: "remot003",
				title: "Far",
				deviceName: "Studio",
				last: "done",
				worktree: { name: "w", branch: "b", baseCwd: "/r", path: "/p" },
			},
		);
		const service = control(host);
		expect((await service.run("main0001", T.compare, {})).text).toMatch(/No worktree sessions/);
		const both = await service.run("main0001", T.compare, { sessions: ["plain002", "remot003"] });
		expect(both.text).toContain("no worktree");
		expect(both.text).toContain("on this computer's sessions only");
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
		host.mergeResult = { merged: false, reason: "conflict", files: ["src/a.ts"] };
		const conflict = await service.run("main0001", T.merge, { session: ids[0] });
		expect(conflict.isError).toBe(true);
		expect(conflict.text).toContain("Merge conflict in src/a.ts: the merge was aborted");
		host.facts.set("omp/agent/b", { ...clean, branch: "omp/agent/b", uncommitted: 2 });
		expect((await service.run("main0001", T.merge, { session: ids[1] })).text).toMatch(/uncommitted file/);
		expect(host.merges).toEqual(["omp/agent/a"]);
		(host.tabsById.get(ids[1]) as FakeTab).busy = true;
		expect((await service.run("main0001", T.merge, { session: ids[1] })).text).toMatch(/still working/);
	});

	it("refuses a session without a branch, a hidden one, and itself", async () => {
		const host = new FakeHost({ tabId: "main0001" }, { tabId: "plain002" }, { tabId: "priv0003", hidden: true });
		const service = control(host);
		expect((await service.run("main0001", T.merge, { session: "plain002" })).text).toMatch(/no worktree branch/);
		expect((await service.run("main0001", T.merge, { session: "priv0003" })).text).toMatch(/hid this session/);
		expect((await service.run("main0001", T.merge, { session: "main0001" })).text).toMatch(/own session/);
	});
});

describe("the review queue", () => {
	it("lists the sessions the caller opened with their diff stat, running ones as running", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		(host.tabsById.get(ids[1]) as FakeTab).busy = true;
		const { items } = await service.review("main0001", "list");
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
		expect((await service.review("main0001", "list")).items.map(item => item.tabId)).not.toContain("other004");
	});

	it("Approve merges without asking (the click is the confirmation) and a conflict keeps the item with its files", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		host.mergeResult = { merged: false, reason: "conflict", files: ["src/a.ts"] };
		const conflicted = await service.review("main0001", "approve", ids[0]);
		expect(conflicted.message).toContain("Merge conflict");
		expect(conflicted.items.find(item => item.tabId === ids[0])).toMatchObject({
			state: "conflict",
			note: "src/a.ts",
		});
		host.mergeResult = { merged: true, sha: "def5678", summary: "" };
		const merged = await service.review("main0001", "approve", ids[0]);
		expect(merged.message).toContain("Merged omp/agent/a");
		expect(merged.items.map(item => item.tabId)).toEqual([ids[1]]);
		expect(host.cards).toHaveLength(0);
	});

	it("Discard closes the session and removes its worktree and branch; Dismiss only hides the item", async () => {
		const { host, service, ids } = await withWorktreeChildren();
		(host.tabsById.get(ids[0]) as FakeTab).status = "asleep";
		const discarded = await service.review("main0001", "discard", ids[0]);
		expect(host.views).toContainEqual({ tabId: ids[0], how: "close" });
		expect(host.discarded).toEqual(["omp/agent/a"]);
		expect(discarded.items.map(item => item.tabId)).toEqual([ids[1]]);
		const dismissed = await service.review("main0001", "dismiss", ids[1]);
		expect(dismissed.items).toEqual([]);
		expect(host.discarded).toEqual(["omp/agent/a"]);
		expect(host.tabsById.has(ids[1])).toBe(true);
	});

	it("acts only on sessions the caller opened, and a session without a branch is simply accepted", async () => {
		const host = new FakeHost({ tabId: "main0001" }, { tabId: "theirs02", title: "Theirs" });
		const service = control(host);
		await expect(service.review("main0001", "approve", "theirs02")).rejects.toThrow(/not one this session opened/);
		const [plain] = await service.openSessions("main0001", [{ message: "x" }]);
		(host.tabsById.get(plain as string) as FakeTab).busy = false;
		const accepted = await service.review("main0001", "approve", plain);
		expect(host.merges).toEqual([]);
		expect(accepted.items).toEqual([]);
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

	it("holds the caps: interval, folder, number of agent schedules, remote callers, bad arguments", async () => {
		const host = new FakeHost({ tabId: "main0001" }, { tabId: "remo0002", deviceName: "Studio" });
		host.manage = true;
		const service = control(host);
		const base = { action: "create", name: "n", prompt: "p" };
		expect((await service.run("main0001", T.schedule, { ...base, every_minutes: 10 })).text).toMatch(/at least 30/);
		expect(
			(await service.run("main0001", T.schedule, { ...base, every_minutes: 60, folder: "relative/dir" })).text,
		).toMatch(/absolute/);
		expect((await service.run("remo0002", T.schedule, { ...base, every_minutes: 60 })).text).toMatch(/this computer/);
		expect((await service.run("main0001", T.schedule, { ...base })).text).toMatch(
			/exactly one of every_minutes or daily_at/,
		);
		expect(
			(await service.run("main0001", T.schedule, { action: "create", name: "n", every_minutes: 60 })).text,
		).toMatch(/needs prompt/);
		for (let i = 0; i < MAX_AGENT_SCHEDULES; i++)
			expect(
				(await service.run("main0001", T.schedule, { ...base, name: `n${i}`, every_minutes: 60 })).isError,
			).toBe(false);
		const sixth = await service.run("main0001", T.schedule, { ...base, every_minutes: 60 });
		expect(sixth.isError).toBe(true);
		expect(sixth.text).toMatch(/limit is 5/);
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
