import { describe, expect, it } from "vitest";
import {
	isNewRequest,
	STALE_TODO_MESSAGE_TYPE,
	staleTodoMessage,
	type TodoStaleEntry,
	todoStaleness,
} from "../../resources/gui-bridge/todo-stale-core";

const SNAPSHOT = "snap1";

function user(text: string): TodoStaleEntry {
	return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}
function assistant(): TodoStaleEntry {
	return { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } };
}
function snapshot(id = SNAPSHOT): TodoStaleEntry {
	return { id, type: "message", message: { role: "toolResult", toolName: "todo" } };
}
function reminder(id = SNAPSHOT): TodoStaleEntry {
	return { type: "custom_message", customType: STALE_TODO_MESSAGE_TYPE, details: { snapshotId: id } };
}

const open = [
	{
		name: "Fix the sidebar bug",
		tasks: [
			{ content: "reproduce", status: "completed" },
			{ content: "fix", status: "completed" },
			{ content: "push", status: "pending" },
		],
	},
];
const finished = [
	{
		name: "Fix the sidebar bug",
		tasks: [
			{ content: "reproduce", status: "completed" },
			{ content: "dropped idea", status: "abandoned" },
		],
	},
];

const REQUEST = "Add a Korean label to the export button and a test for it";

describe("todoStaleness", () => {
	it("calls a finished list stale on the first new request after it", () => {
		const branch = [user("fix the bug"), snapshot(), assistant()];
		expect(todoStaleness({ branch, snapshotId: SNAPSHOT, phases: finished, prompt: REQUEST })).toEqual({
			kind: "finished",
			done: 2,
			total: 2,
			phases: ["Fix the sidebar bug"],
			snapshotId: SNAPSHOT,
		});
	});

	it("leaves an open list alone on the request right after it was written", () => {
		const branch = [user("fix the bug"), snapshot(), assistant()];
		expect(todoStaleness({ branch, snapshotId: SNAPSHOT, phases: open, prompt: REQUEST })).toBeUndefined();
	});

	it("calls an open list stale once a whole request passed without touching it", () => {
		const branch = [user("fix the bug"), snapshot(), assistant(), user("now rename the menu item"), assistant()];
		expect(todoStaleness({ branch, snapshotId: SNAPSHOT, phases: open, prompt: REQUEST })).toMatchObject({
			kind: "untouched",
			done: 2,
			total: 3,
		});
	});

	it("does not count the prompt being sent when stock has journaled it already", () => {
		const branch = [user("fix the bug"), snapshot(), assistant(), user(REQUEST)];
		expect(todoStaleness({ branch, snapshotId: SNAPSHOT, phases: open, prompt: REQUEST })).toBeUndefined();
	});

	it("never reminds on a question or a short reply", () => {
		const branch = [user("fix the bug"), snapshot(), assistant(), user("rename the menu"), assistant()];
		for (const prompt of [
			"why did the build fail?",
			"지금 상태 어때?",
			"ㅇㅋ 고",
			"thanks!",
			"/compact",
			"!git status",
		])
			expect(todoStaleness({ branch, snapshotId: SNAPSHOT, phases: finished, prompt })).toBeUndefined();
	});

	it("reminds once per list, and once more only after three more requests left it as it was", () => {
		const after = [user("fix the bug"), snapshot(), assistant(), user("rename the menu"), reminder(), assistant()];
		expect(todoStaleness({ branch: after, snapshotId: SNAPSHOT, phases: open, prompt: REQUEST })).toBeUndefined();
		const later = [...after, user("one"), assistant(), user("two"), assistant(), user("three"), assistant()];
		expect(todoStaleness({ branch: later, snapshotId: SNAPSHOT, phases: open, prompt: REQUEST })).toMatchObject({
			kind: "untouched",
		});
		const twice = [...later, reminder(), assistant(), user("4"), user("5"), user("6"), user("7")];
		expect(todoStaleness({ branch: twice, snapshotId: SNAPSHOT, phases: open, prompt: REQUEST })).toBeUndefined();
	});

	it("starts over when the list changes: a reminder for an older list counts for nothing", () => {
		const branch = [user("a"), snapshot("old"), user("b"), reminder("old"), snapshot("new"), assistant()];
		expect(todoStaleness({ branch, snapshotId: "new", phases: finished, prompt: REQUEST })).toMatchObject({
			kind: "finished",
			snapshotId: "new",
		});
	});

	it("has nothing to say without a list", () => {
		const branch = [user("a"), assistant()];
		expect(todoStaleness({ branch, snapshotId: undefined, phases: [], prompt: REQUEST })).toBeUndefined();
		expect(
			todoStaleness({ branch, snapshotId: SNAPSHOT, phases: [{ name: "x", tasks: [] }], prompt: REQUEST }),
		).toBeUndefined();
	});

	it("leaves out stock's synthetic and agent-written user messages from the count", () => {
		const branch: TodoStaleEntry[] = [
			user("fix the bug"),
			snapshot(),
			{ type: "message", message: { role: "user", synthetic: true, content: "continue" } },
			{ type: "message", message: { role: "user", attribution: "agent", content: "continue" } },
		];
		expect(todoStaleness({ branch, snapshotId: SNAPSHOT, phases: open, prompt: REQUEST })).toBeUndefined();
	});
});

describe("isNewRequest", () => {
	it("tells new work from a question", () => {
		for (const text of [
			REQUEST,
			"이 버튼에 한국어 라벨을 붙이고 테스트도 추가해줘",
			"이거 고쳐줄래?",
			"Can you add retries to the uploader?",
			'<ompdesk-agent-message from="x">\nTitle: …\nChange: fix it\n</ompdesk-agent-message>',
			`Why does this fail?\n\n${"Then fix it and add a regression test. ".repeat(6)}`,
		])
			expect(isNewRequest(text), text).toBe(true);
		for (const text of [
			"",
			"왜 빌드가 실패했어?",
			"What is the current status?",
			"go on",
			"진행해",
			"how does the merge work",
		])
			expect(isNewRequest(text), text).toBe(false);
	});
});

describe("staleTodoMessage", () => {
	it("is one hidden line naming the list and what to do", () => {
		const message = staleTodoMessage({
			kind: "untouched",
			done: 9,
			total: 10,
			phases: ["Sidebar bug"],
			snapshotId: SNAPSHOT,
		});
		expect(message).toMatchObject({
			customType: STALE_TODO_MESSAGE_TYPE,
			display: false,
			attribution: "agent",
			details: { snapshotId: SNAPSHOT, kind: "untouched" },
		});
		expect(message.content).toContain("9/10");
		expect(message.content).toContain("Sidebar bug");
		expect(message.content).toContain('"init"');
		expect(message.content.split("\n").length).toBeLessThanOrEqual(3);
	});
});
