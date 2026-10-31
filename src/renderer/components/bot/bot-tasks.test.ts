import { describe, expect, it } from "vitest";
import { type BotDecision, EMPTY_BOT_DESK } from "../../../shared/bot-desk";
import type { OpenedChildRow } from "../layout/work-board/opened-children";
import { botTasks } from "./bot-tasks";

const NOW = Date.parse("2026-11-01T10:00:00.000Z");

function row(key: string, status: OpenedChildRow["status"], extra: Partial<OpenedChildRow> = {}): OpenedChildRow {
	return { key, tabId: key, sessionPath: `/s/${key}.jsonl`, title: key, status, ...extra };
}

function lists(rows: OpenedChildRow[], extra: Partial<typeof EMPTY_BOT_DESK> = {}, unread = new Set<string>()) {
	return botTasks({
		rows,
		desk: { ...EMPTY_BOT_DESK, ...extra },
		unread: child => unread.has(child.key),
		now: NOW,
	});
}

const keys = (items: { key: string }[]) => items.map(item => item.key);

describe("botTasks", () => {
	it("keeps a finished session in progress as Done? until the owner marks it, and only then completes it", () => {
		const before = lists([row("a", "done", { at: 1 }), row("b", "unmerged", { at: 2 })]);
		expect(before.progress.map(item => (item.kind === "task" ? item.state : item.kind))).toEqual([
			"review",
			"review",
		]);
		expect(before.completed).toEqual([]);

		const after = lists([row("a", "done", { at: 1 }), row("b", "unmerged", { at: 2 })], {
			tasksDone: ["/s/a.jsonl"],
		});
		expect(keys(after.progress)).toEqual(["task:b"]);
		expect(after.completed.map(item => (item.kind === "task" ? item.state : item.kind))).toEqual(["done"]);
	});

	it("puts what needs the owner first, then failures, running work and what looks done, newest first within each", () => {
		const { progress } = lists([
			row("done-old", "done", { at: 1 }),
			row("run", "running"),
			row("done-new", "done", { at: 5 }),
			row("fail", "failed"),
			row("ask", "waiting"),
		]);
		expect(keys(progress)).toEqual(["task:ask", "task:fail", "task:run", "task:done-new", "task:done-old"]);
	});

	it("a running or failed session never completes, whatever the owner's marks say", () => {
		const { progress, completed } = lists([row("run", "running"), row("fail", "failed")], {
			tasksDone: ["/s/run.jsonl", "/s/fail.jsonl"],
		});
		expect(keys(progress)).toEqual(["task:fail", "task:run"]);
		expect(completed).toEqual([]);
	});

	it("marks unread only what finished and was not looked at", () => {
		const { progress } = lists([row("a", "done"), row("b", "running")], {}, new Set(["a", "b"]));
		expect(progress.map(item => (item.kind === "task" ? [item.key, item.unread] : []))).toEqual([
			["task:b", false],
			["task:a", true],
		]);
	});

	it("schedules the wakes and completes answered and expired decisions, newest first, beside done tasks", () => {
		const answered: BotDecision = {
			id: "d1",
			state: "answered",
			question: "Ship?",
			options: [],
			at: "2026-11-01T08:00:00.000Z",
			answer: "Yes",
			answeredAt: "2026-11-01T09:00:00.000Z",
		};
		const lapsed: BotDecision = {
			id: "d2",
			state: "open",
			question: "Hold the slot?",
			options: [],
			at: "2026-11-01T08:00:00.000Z",
			expiresAt: "2026-11-01T09:30:00.000Z",
		};
		const waiting: BotDecision = { ...lapsed, id: "d3", expiresAt: "2026-11-01T11:00:00.000Z" };
		const result = lists([row("a", "done", { at: Date.parse("2026-11-01T08:30:00.000Z") })], {
			tasksDone: ["/s/a.jsonl"],
			decisions: [answered, lapsed, waiting],
			routines: [
				{
					id: "w1",
					name: "check CI",
					prompt: "check CI",
					frequency: { kind: "interval", minutes: 30 },
					enabled: true,
					next: "2026-11-01T12:00:00.000Z",
					runs: [],
				},
				{
					id: "e1",
					name: "on push",
					prompt: "look",
					frequency: { kind: "event", event: { source: "git", repo: "/r", branch: "main" } },
					enabled: true,
					next: null,
					runs: [],
				},
			],
		});
		expect(keys(result.scheduled)).toEqual(["wake:w1"]);
		expect(keys(result.completed)).toEqual(["decision:d2", "decision:d1", "task:a"]);
		expect(result.completed[0]).toMatchObject({ kind: "decision", outcome: "expired" });
	});
});
