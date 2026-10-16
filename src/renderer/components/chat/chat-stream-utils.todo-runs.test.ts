import { afterEach, expect, it, vi } from "vitest";
import type { AgentMessage, TodoPhase } from "../../../shared/rpc-types";
import { createTodoStore } from "../../stores/todo";
import { buildHistoryRows, mergeTodoSnapshots } from "./chat-stream-utils";
import { workTurnStartedAt } from "./work/work-turn";

// Diagnostic timestamps/roles from the real Xw4UOX scenario journal (2026-10-12).
// The screenshot projection omitted user2 and todo calls; keep that case beside
// the complete user chronology, so attribution does not depend on visibility.
const user1: AgentMessage = {
	role: "user",
	timestamp: 1791827421351,
	content: "Create notes.txt and edit alpha to beta.",
};
const user2: AgentMessage = {
	role: "user",
	timestamp: 1791827436493,
	content: "Use your todo tool to create Read, Count, Report.",
};
const write: AgentMessage = {
	role: "assistant",
	timestamp: 1791827425524,
	content: [
		{ type: "toolCall", id: "real-write", name: "write", arguments: { path: "notes.txt", content: "alpha\n" } },
	],
};
const edit: AgentMessage = {
	role: "assistant",
	timestamp: 1791827428519,
	content: [{ type: "toolCall", id: "real-edit", name: "edit", arguments: { path: "notes.txt", edits: [] } }],
};
const answer1: AgentMessage = {
	role: "assistant",
	timestamp: 1791827431976,
	content: [{ type: "text", text: "Created notes.txt and changed alpha to beta." }],
};
const ls: AgentMessage = {
	role: "assistant",
	timestamp: 1791827442646,
	content: [{ type: "toolCall", id: "real-ls", name: "bash", arguments: { command: "ls" } }],
};
const wc: AgentMessage = {
	role: "assistant",
	timestamp: 1791827450411,
	content: [{ type: "toolCall", id: "real-wc", name: "bash", arguments: { command: "wc -l notes.txt" } }],
};
const answer2: AgentMessage = {
	role: "assistant",
	timestamp: 1791827454819,
	content: [{ type: "text", text: "notes.txt contains 1 line." }],
};
const phases: TodoPhase[] = [
	{
		name: "Work",
		tasks: [
			{ content: "Read", status: "completed" },
			{ content: "Count", status: "in_progress" },
			{ content: "Report", status: "pending" },
		],
	},
];
afterEach(() => vi.useRealTimers());

it.each([true, false])("assigns an early todo snapshot only to its captured turn (user visible: %s)", includeUser => {
	const snapshot = {
		id: "real-todos",
		ts: 1791827442644,
		duringTurn: true,
		turnStartedAt: 1791827436493,
		endedAt: 1791827458479,
		phases,
	};
	const rows = mergeTodoSnapshots(
		buildHistoryRows([user1, write, edit, answer1, ...(includeUser ? [user2] : []), ls, wc, answer2], "compact"),
		[snapshot],
	);
	const work = rows.filter(row => row.kind === "process");
	expect(work).toHaveLength(2);
	expect(work[0]?.kind === "process" && work[0].todoSnapshots).toBeUndefined();
	expect(work[1]?.kind === "process" && work[1].todoSnapshots).toEqual([snapshot]);
	expect(rows.some(row => row.kind === "todoSnapshot")).toBe(false);
});

it("attributes the complete stock user/tool sequence with the earlier source stream timestamp", () => {
	const todoCall: AgentMessage = {
		role: "assistant",
		timestamp: 1791827438373,
		content: [{ type: "toolCall", id: "real-todo", name: "todo", arguments: {} }],
	};
	const result: AgentMessage = {
		role: "toolResult",
		toolName: "todo",
		toolCallId: "real-todo",
		timestamp: 1791827442644,
		content: [{ type: "text", text: "Todos updated" }],
		details: { phases },
	};
	const snapshot = {
		id: "complete-stock-turn",
		ts: 1791827442644,
		duringTurn: true,
		turnStartedAt: 1791827438373,
		endedAt: 1791827458479,
		phases,
	};
	const rows = mergeTodoSnapshots(
		buildHistoryRows([user1, write, edit, answer1, user2, todoCall, result, ls, wc, answer2], "compact"),
		[snapshot],
	);
	const work = rows.filter(row => row.kind === "process");
	expect(work[0]?.kind === "process" && work[0].todoSnapshots).toBeUndefined();
	expect(work[1]?.kind === "process" && work[1].todoSnapshots).toEqual([snapshot]);
});

it.each([true, false])("keeps a captured cardless turn standalone (user visible: %s)", includeUser => {
	const snapshot = {
		id: "todo-only-followup",
		ts: 1791827466310,
		duringTurn: true,
		turnStartedAt: 1791827458479,
		endedAt: 1791827469224,
		phases,
	};
	const rows = mergeTodoSnapshots(
		buildHistoryRows(
			[
				user1,
				write,
				edit,
				answer1,
				user2,
				ls,
				wc,
				answer2,
				...(includeUser ? [{ ...user2, timestamp: 1791827458479 }] : []),
				{ ...answer2, timestamp: 1791827466335 },
			],
			"compact",
		),
		[snapshot],
	);
	expect(rows.filter(row => row.kind === "process").every(row => row.kind === "process" && !row.todoSnapshots)).toBe(
		true,
	);
	expect(rows.find(row => row.kind === "todoSnapshot")).toEqual({ kind: "todoSnapshot", entry: snapshot });
});

it("captures and closes the exact todo turn without coalescing the next turn into it", () => {
	vi.useFakeTimers();
	const store = createTodoStore();
	store.getState().setPhases([]);
	vi.setSystemTime(1791827436493);
	store.getState().setTurnActive(true);
	vi.setSystemTime(1791827442644);
	store.getState().setPhases(phases);
	vi.setSystemTime(1791827458479);
	store.getState().setTurnActive(false);
	const first = store.getState().history[0];
	expect(first?.turnStartedAt).toBe(1791827436493);
	expect(first?.endedAt).toBe(1791827458479);
	vi.setSystemTime(1791827458482);
	store.getState().setTurnActive(true);
	vi.setSystemTime(1791827466310);
	store
		.getState()
		.setPhases(
			phases.map(phase => ({ ...phase, tasks: phase.tasks.map(task => ({ ...task, status: "completed" })) })),
		);
	expect(store.getState().history).toHaveLength(2);
	expect(store.getState().history[0]).toBe(first);
	expect(store.getState().history[1]?.turnStartedAt).toBe(1791827458482);
	expect(store.getState().history[1]?.endedAt).toBeUndefined();
});

it("refines frame-receipt clocks from source messages without changing epoch or stealing the next turn", () => {
	vi.useFakeTimers();
	const store = createTodoStore();
	store.getState().setPhases([]);
	vi.setSystemTime(1791827438400);
	store.getState().setTurnActive(true);
	store.getState().setTurnActive(true, 1791827438373);
	const epoch = store.getState().historyEpoch;
	vi.setSystemTime(1791827442644);
	store.getState().setPhases(phases);
	expect(store.getState().history[0]?.turnStartedAt).toBe(1791827438373);
	store.getState().setTurnActive(true, 1791827450411);
	expect(store.getState().historyEpoch).toBe(epoch);
	expect(store.getState().history[0]?.turnStartedAt).toBe(1791827438373);
	vi.setSystemTime(1791827458500);
	store.getState().setTurnActive(false);
	store.getState().setTurnActive(true);
	store.getState().setTurnActive(true, 1791827458482);
	expect(store.getState().history[0]?.endedAt).toBe(1791827458482);
	vi.setSystemTime(1791827466310);
	store
		.getState()
		.setPhases(
			phases.map(phase => ({ ...phase, tasks: phase.tasks.map(task => ({ ...task, status: "completed" })) })),
		);
	const rows = mergeTodoSnapshots(
		buildHistoryRows(
			[user1, write, edit, answer1, user2, ls, wc, answer2, { ...answer2, timestamp: 1791827466335 }],
			"compact",
		),
		store.getState().history,
	);
	const work = rows.filter(row => row.kind === "process");
	expect(work[0]?.kind === "process" && work[0].todoSnapshots).toBeUndefined();
	expect(work[1]?.kind === "process" && work[1].todoSnapshots?.[0]?.epoch).toBe(epoch);
	expect(rows.find(row => row.kind === "todoSnapshot")?.entry.epoch).toBe(store.getState().historyEpoch);
});

it("hydrates an automatic continuation from the shared final-reply boundary, not the older user input", () => {
	const continuation: AgentMessage = {
		role: "assistant",
		timestamp: 1791827458482,
		content: [{ type: "toolCall", id: "todo-followup", name: "todo", arguments: {} }],
	};
	expect(workTurnStartedAt([user1, write, edit, answer1, user2, ls, wc, answer2, continuation])).toBe(1791827458482);
	expect(workTurnStartedAt([user1, write, edit, answer1, user2, ls, wc, answer2])).toBeUndefined();
	expect(workTurnStartedAt([user1, write, edit, answer1, user2])).toBeUndefined();
});

it("never gives a cardless turn's snapshot to a later user when its end frame is observed late", () => {
	const nextUser: AgentMessage = { role: "user", timestamp: 1791827470367, content: "Run exit 3." };
	const failingCall: AgentMessage = {
		role: "assistant",
		timestamp: 1791827472354,
		content: [{ type: "toolCall", id: "real-failure", name: "bash", arguments: { command: "exit 3" } }],
	};
	const snapshot = {
		id: "late-closed-cardless-turn",
		ts: 1791827466310,
		duringTurn: true,
		turnStartedAt: 1791827458482,
		endedAt: 1791827483000,
		phases,
	};
	const rows = mergeTodoSnapshots(
		buildHistoryRows(
			[
				user1,
				write,
				edit,
				answer1,
				user2,
				ls,
				wc,
				answer2,
				{ ...answer2, timestamp: 1791827466335 },
				nextUser,
				failingCall,
			],
			"compact",
		),
		[snapshot],
	);
	expect(rows.filter(row => row.kind === "process").every(row => row.kind === "process" && !row.todoSnapshots)).toBe(
		true,
	);
	expect(rows.find(row => row.kind === "todoSnapshot")).toEqual({ kind: "todoSnapshot", entry: snapshot });
});
