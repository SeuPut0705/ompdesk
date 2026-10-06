import { describe, expect, it } from "vitest";
import type { AgentMessage, MessagesPage } from "../../shared/rpc-types";
import { GuiBridgeClient } from "../bridge-client";
import { attachEntryIds, handlers, projectTranscript, type SessionEntry } from "./sessions";
import type { LocalCommandContext } from "./types";

const T = "2026-01-01T00:00:00.000Z";

function message(id: string, parentId: string | null, body: AgentMessage): SessionEntry {
	return { type: "message", id, parentId, timestamp: T, message: body };
}

const user = (text: string, timestamp: number): AgentMessage => ({ role: "user", content: text, timestamp });
const assistant = (timestamp: number, content: AgentMessage["content"]): AgentMessage => ({
	role: "assistant",
	content,
	timestamp,
	provider: "p",
	model: "m",
	stopReason: "stop",
});

describe("projectTranscript", () => {
	it("follows the leaf's branch and stamps every message with its entry id", () => {
		const entries: SessionEntry[] = [
			message("u1", null, user("first", 1)),
			message("a1", "u1", assistant(2, [{ type: "text", text: "one" }])),
			message("u2", "a1", user("abandoned branch", 3)),
			message("u3", "a1", user("live branch", 4)),
			{ type: "model_change", id: "mc", parentId: "u3", timestamp: T, model: "p/m" },
		];
		const messages = projectTranscript(entries, "mc");
		expect(messages.map(m => m.entryId)).toEqual(["u1", "a1", "u3"]);
		expect(messages[2]).toMatchObject({ role: "user", content: "live branch" });
	});

	it("is empty for an explicit null leaf (rewound before the first entry)", () => {
		expect(projectTranscript([message("u1", null, user("x", 1))], null)).toEqual([]);
	});

	it("renders compactions inline and marks superseded ones", () => {
		const entries: SessionEntry[] = [
			message("u1", null, user("a", 1)),
			{ type: "compaction", id: "c1", parentId: "u1", timestamp: T, summary: "old", tokensBefore: 10 },
			message("u2", "c1", user("b", 2)),
			{ type: "compaction", id: "c2", parentId: "u2", timestamp: T, summary: "new", tokensBefore: 20 },
			{ type: "branch_summary", id: "b1", parentId: "c2", timestamp: T, summary: "went back", fromId: "u1" },
			{
				type: "custom_message",
				id: "x1",
				parentId: "b1",
				timestamp: T,
				customType: "note",
				content: "hi",
				display: true,
			},
		];
		const messages = projectTranscript(entries, "x1");
		expect(messages.map(m => [m.role, m.entryId])).toEqual([
			["user", "u1"],
			["compactionSummary", "c1"],
			["user", "u2"],
			["compactionSummary", "c2"],
			["branchSummary", "b1"],
			["custom", "x1"],
		]);
		expect(messages[1]?.summary).toContain("Superseded");
		expect(messages[3]?.summary).toBe("new");
	});

	it("strips tool calls whose result is not on the branch, and counts them", () => {
		const entries: SessionEntry[] = [
			message("u1", null, user("go", 1)),
			message(
				"a1",
				"u1",
				assistant(2, [
					{ type: "text", text: "calling" },
					{ type: "toolCall", id: "t1", name: "read", arguments: {} },
					{ type: "toolCall", id: "t2", name: "read", arguments: {} },
				]),
			),
			message("r1", "a1", {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				timestamp: 3,
			}),
		];
		const [, stripped] = projectTranscript(entries, "r1");
		expect(stripped?.strippedToolCalls).toBe(1);
		expect(Array.isArray(stripped?.content) && stripped.content.map(block => block.type)).toEqual([
			"text",
			"toolCall",
		]);
	});
});

describe("attachEntryIds", () => {
	it("matches live agent_end messages to their persisted entries", () => {
		const live = [user("hello", 10), assistant(11, [{ type: "text", text: "hi" }])];
		const entries = [
			message("e1", null, user("hello", 10)),
			message("e2", "e1", assistant(11, [{ type: "text", text: "hi" }])),
		];
		expect(attachEntryIds(live, entries).map(m => m.entryId)).toEqual(["e1", "e2"]);
	});

	it("leaves unpersisted messages without an id", () => {
		expect(attachEntryIds([user("not saved", 99)], [])[0]?.entryId).toBeUndefined();
	});
});

describe("get_transcript_page", () => {
	it("pages one get_entries snapshot and rejects a cursor from a moved leaf", async () => {
		const entries = Array.from({ length: 5 }, (_, i) =>
			message(`u${i}`, i === 0 ? null : `u${i - 1}`, user(`m${i}`, i)),
		);
		let leafId = "u4";
		let fetches = 0;
		const ctx: LocalCommandContext = {
			cwd: "/tmp",
			omp: { bin: "omp", version: "18.6.1", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			bridge: new GuiBridgeClient(""),
			emit: () => {},
			send: async <T>(command: { type: string }) => {
				expect(command.type).toBe("get_entries");
				fetches++;
				return { entries, leafId } as T;
			},
		};
		const page = handlers.get_transcript_page as (
			command: { type: string; cursor?: string; limit?: number },
			ctx: LocalCommandContext,
		) => Promise<MessagesPage>;

		const first = await page({ type: "get_transcript_page", limit: 2 }, ctx);
		expect(first.messages.map(m => m.entryId)).toEqual(["u0", "u1"]);
		expect(first.totalMessages).toBe(5);
		const second = await page({ type: "get_transcript_page", limit: 2, cursor: first.nextCursor }, ctx);
		expect(second.messages.map(m => m.entryId)).toEqual(["u2", "u3"]);
		expect(fetches).toBe(1);

		// A cursor outliving its snapshot (another spawn, no cached walk) is
		// checked against the live tree and refused once the leaf has moved.
		leafId = "u3";
		const stale = page(
			{ type: "get_transcript_page", limit: 2, cursor: second.nextCursor },
			{ ...ctx, bridge: new GuiBridgeClient("") },
		);
		await expect(stale).rejects.toThrow("stale");
	});

	it("overlapping walks of one spawn share one projection instead of re-fetching per page", async () => {
		const entries = Array.from({ length: 6 }, (_, i) =>
			message(`u${i}`, i === 0 ? null : `u${i - 1}`, user(`m${i}`, i)),
		);
		let fetches = 0;
		const ctx: LocalCommandContext = {
			cwd: "/tmp",
			omp: { bin: "omp", version: "18.6.1", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			bridge: new GuiBridgeClient(""),
			emit: () => {},
			send: async <T>() => {
				fetches++;
				return { entries, leafId: "u5" } as T;
			},
		};
		const page = handlers.get_transcript_page as (
			command: { type: string; cursor?: string; limit?: number },
			ctx: LocalCommandContext,
		) => Promise<MessagesPage>;

		// Two hydrations start, then the later one finishes first and releases the cache.
		let a = await page({ type: "get_transcript_page", limit: 2 }, ctx);
		let b = await page({ type: "get_transcript_page", limit: 2 }, ctx);
		while (b.nextCursor) b = await page({ type: "get_transcript_page", limit: 2, cursor: b.nextCursor }, ctx);
		const walked = [...a.messages];
		while (a.nextCursor) {
			a = await page({ type: "get_transcript_page", limit: 2, cursor: a.nextCursor }, ctx);
			walked.push(...a.messages);
		}
		expect(walked.map(m => m.entryId)).toEqual(["u0", "u1", "u2", "u3", "u4", "u5"]);
		// Two first pages plus at most one re-fetch for the walk whose cache was released.
		expect(fetches).toBeLessThanOrEqual(3);
	});
});
