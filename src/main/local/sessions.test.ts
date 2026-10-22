import { describe, expect, it, vi } from "vitest";
import { transcriptPageMessages, transcriptRunStart } from "../../../resources/gui-bridge/transcript-page";
import type { AgentMessage, MessagesPage } from "../../shared/rpc-types";
import type { RpcTurnEdits } from "../../shared/turn-edits";
import { GuiBridgeClient } from "../bridge-client";
import { BACKWARD_PAGE_BUDGET, handlers } from "./sessions";
import type { LocalCommandContext } from "./types";

const T = "2026-01-01T00:00:00.000Z";

function message(id: string, parentId: string | null, body: AgentMessage) {
	return { type: "message", id, parentId, timestamp: T, message: body };
}

const user = (text: string, timestamp: number): AgentMessage => ({ role: "user", content: text, timestamp });

/** A bridge serving its replay page by page, as gui-bridge sessions.transcript does. */
function pagedBridge(entries: ReturnType<typeof message>[], leaf: () => string) {
	const requested: unknown[] = [];
	const bridge = new GuiBridgeClient("");
	vi.spyOn(bridge, "request").mockImplementation(async <T>(method: string, params?: unknown) => {
		expect(method).toBe("sessions.transcript");
		requested.push(params);
		const { offset, limit, snapToTurn } = params as { offset: number; limit: number; snapToTurn?: boolean };
		const messages = entries.map(entry => ({ ...entry.message, entryId: entry.id }));
		const end = Math.min(messages.length, offset + limit);
		const startIndex = snapToTurn ? transcriptRunStart(messages, offset, end) : offset;
		return { leafId: leaf(), total: messages.length, startIndex, messages: messages.slice(startIndex, end) } as T;
	});
	const ctx: LocalCommandContext = {
		cwd: "/tmp",
		omp: { bin: "omp", version: "18.8.7", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
		bridge,
		send: async () => {
			throw new Error("Transcript must not request raw entries");
		},
	};
	return { ctx, requested };
}

const chain = (n: number) =>
	Array.from({ length: n }, (_, i) => message(`u${i}`, i === 0 ? null : `u${i - 1}`, user(`m${i}`, i)));

describe("get_transcript_page", () => {
	it("asks the bridge for one page at a time and rejects a cursor from a moved leaf", async () => {
		let leafId = "u4";
		const { ctx, requested } = pagedBridge(chain(5), () => leafId);
		const page = handlers.get_transcript_page as (
			command: { type: string; cursor?: string; limit?: number },
			ctx: LocalCommandContext,
		) => Promise<MessagesPage>;

		const first = await page({ type: "get_transcript_page", limit: 2 }, ctx);
		expect(first.messages.map(m => m.entryId)).toEqual(["u0", "u1"]);
		expect(first.totalMessages).toBe(5);
		const second = await page({ type: "get_transcript_page", limit: 2, cursor: first.nextCursor }, ctx);
		expect(second.messages.map(m => m.entryId)).toEqual(["u2", "u3"]);
		// Never the whole transcript in one bridge reply: it would hold up every other bridge request.
		expect(requested).toEqual([
			{ offset: 0, limit: 2 },
			{ offset: 2, limit: 2 },
		]);

		leafId = "u3";
		await expect(page({ type: "get_transcript_page", limit: 2, cursor: second.nextCursor }, ctx)).rejects.toThrow(
			"stale",
		);
	});

	it("loads the tail then preceding pages with snapshot-bound cursors", async () => {
		let leaf = "u1499";
		const { ctx, requested } = pagedBridge(chain(1500), () => leaf);
		const page = handlers.get_transcript_page as (
			command: Record<string, unknown>,
			ctx: LocalCommandContext,
		) => Promise<MessagesPage>;
		const tail = await page({ type: "get_transcript_page", fromEnd: true, limit: 200 }, ctx);
		expect(tail.startIndex).toBe(1300);
		expect(tail.messages[0]?.entryId).toBe("u1300");
		expect(tail.messages.at(-1)?.entryId).toBe("u1499");
		expect(tail.nextCursor).toBeUndefined();
		expect(requested).toEqual([
			{ offset: 0, limit: 0 },
			{ offset: 1300, limit: 200, snapToTurn: true },
		]);
		const older = await page({ type: "get_transcript_page", cursor: tail.prevCursor, limit: 200 }, ctx);
		expect(older.startIndex).toBe(1100);
		expect(older.messages.at(-1)?.entryId).toBe("u1299");
		leaf = "different";
		await expect(page({ type: "get_transcript_page", cursor: older.prevCursor, limit: 200 }, ctx)).rejects.toThrow(
			"stale",
		);
	});

	it("reads a heavy tail in fewer messages, within its budget, and the rest page by page above it", async () => {
		// Typed prompts every 2 messages, so every message starts or joins a short run; each weighs about 6 KB.
		const heavy = Array.from({ length: 400 }, (_, i) =>
			message(`u${i}`, i === 0 ? null : `u${i - 1}`, user(`${"tool output line\n".repeat(400)}${i}`, i)),
		);
		const { ctx } = pagedBridge(heavy, () => "u399");
		const page = handlers.get_transcript_page as (
			command: Record<string, unknown>,
			ctx: LocalCommandContext,
		) => Promise<MessagesPage>;
		const tail = await page({ type: "get_transcript_page", fromEnd: true, limit: 200 }, ctx);
		expect(JSON.stringify(tail.messages).length).toBeLessThanOrEqual(BACKWARD_PAGE_BUDGET);
		expect(tail.messages.length).toBeGreaterThanOrEqual(20);
		expect(tail.messages.at(-1)?.entryId).toBe("u399");
		expect(tail.startIndex).toBe(400 - tail.messages.length);
		// The page above starts where this one does, so nothing is skipped or read twice.
		const older = await page({ type: "get_transcript_page", cursor: tail.prevCursor, limit: 200 }, ctx);
		expect(older.messages.at(-1)?.entryId).toBe(`u${(tail.startIndex ?? 0) - 1}`);
		expect(JSON.stringify(older.messages).length).toBeLessThanOrEqual(BACKWARD_PAGE_BUDGET);
		// A light transcript still comes in one page of what was asked.
		const { ctx: light } = pagedBridge(chain(300), () => "u299");
		expect((await page({ type: "get_transcript_page", fromEnd: true, limit: 200 }, light)).messages).toHaveLength(
			200,
		);
	});

	it("handles short and empty tails without a preceding cursor", async () => {
		const page = handlers.get_transcript_page as (
			command: Record<string, unknown>,
			ctx: LocalCommandContext,
		) => Promise<MessagesPage>;
		for (const total of [0, 3]) {
			const { ctx } = pagedBridge(chain(total), () => "leaf");
			const tail = await page({ type: "get_transcript_page", fromEnd: true, limit: 200 }, ctx);
			expect(tail.startIndex).toBe(0);
			expect(tail.messages).toHaveLength(total);
			expect(tail.prevCursor).toBeUndefined();
		}
	});

	it("rejects a backward cursor when the total changes without a leaf change", async () => {
		const entries = chain(4);
		const { ctx } = pagedBridge(entries, () => "same-leaf");
		const page = handlers.get_transcript_page as (
			command: Record<string, unknown>,
			ctx: LocalCommandContext,
		) => Promise<MessagesPage>;
		const tail = await page({ type: "get_transcript_page", fromEnd: true, limit: 2 }, ctx);
		entries.pop();
		await expect(page({ type: "get_transcript_page", cursor: tail.prevCursor, limit: 2 }, ctx)).rejects.toThrow(
			"stale",
		);
	});

	it("snaps a tool result/assistant step back to the start of its run", () => {
		const messages = [
			{ role: "user" },
			{ role: "assistant" },
			{ role: "toolResult" },
			{ role: "assistant" },
			{ role: "user" },
		];
		expect(transcriptRunStart(messages, 2, 4)).toBe(0);
		expect(transcriptRunStart(messages, 3, 4)).toBe(0);
		expect(transcriptRunStart(messages, 4, 5)).toBe(4);
		expect(transcriptRunStart(messages, 5, 5)).toBe(5);
		const steered = [
			{ role: "user" },
			{ role: "assistant" },
			{ role: "toolResult" },
			{ role: "user", steering: true },
		];
		expect(transcriptRunStart(steered, 3, 4)).toBe(0);
	});

	it("starts a page after the last run that ended, not at a prompt typed hours of goal continuations ago", () => {
		// A goal or Autopilot run continues with custom messages, never a typed prompt: snapping to the prompt made one
		// page of a long run 4.6 MB (1754 messages), on every hydrate and every reconnect of a paired device.
		const messages = [
			{ role: "user" },
			{ role: "assistant", stopReason: "toolUse" },
			{ role: "toolResult" },
			{ role: "assistant", stopReason: "stop" },
			{ role: "custom" },
			{ role: "assistant", stopReason: "toolUse" },
			{ role: "toolResult" },
			{ role: "assistant", stopReason: "toolUse" },
			{ role: "toolResult" },
		];
		expect(transcriptRunStart(messages, 6, 9)).toBe(4);
		expect(transcriptRunStart(messages, 8, 9)).toBe(4);
		// A run that stopped on a tool call is not over: the page never starts at its result.
		expect(transcriptRunStart(messages, 2, 4)).toBe(0);
	});
});

describe("get_transcript", () => {
	it("assembles the whole transcript from bounded pages", async () => {
		const { ctx, requested } = pagedBridge(chain(600), () => "u599");
		const getTranscript = handlers.get_transcript as (
			command: { type: string },
			ctx: LocalCommandContext,
		) => Promise<{ messages: AgentMessage[] }>;
		const full = await getTranscript({ type: "get_transcript" }, ctx);
		expect(full.messages).toHaveLength(600);
		expect(full.messages.at(-1)).toMatchObject({ entryId: "u599" });
		expect(requested.length).toBeGreaterThan(1);
	});
});

describe("get_turn_edits", () => {
	const getTurnEdits = handlers.get_turn_edits as (
		command: { type: string },
		ctx: LocalCommandContext,
	) => Promise<RpcTurnEdits>;
	const call = (id: string, name: string, args: Record<string, unknown>) => ({
		type: "toolCall" as const,
		id,
		name,
		arguments: args,
	});
	const assistant = (timestamp: number, ...content: ReturnType<typeof call>[]): AgentMessage => ({
		role: "assistant",
		content: [{ type: "text", text: "working" }, ...content],
		timestamp,
	});
	const result = (toolCallId: string, toolName: string, timestamp: number): AgentMessage => ({
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		details: { diff: "+1 x" },
		timestamp,
	});

	it("returns only the file-changing calls of the newest turn, with their results and the turn's clock", async () => {
		const bodies: AgentMessage[] = [
			user("first", 1),
			assistant(2, call("old", "edit", { path: "old.ts" })),
			result("old", "edit", 3),
			user("second", 10),
			assistant(11, call("w1", "write", { path: "b.ts", content: "b\n" }), call("r1", "read", { path: "c.ts" })),
			result("w1", "write", 12),
			result("r1", "read", 13),
			// A steer joins the running turn; it starts none.
			{ role: "user", content: "also", steering: true, timestamp: 14 },
			assistant(15, call("b1", "bash", { command: "ls" })),
			result("b1", "bash", 16),
			{ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 17 },
		];
		const entries = bodies.map((body, i) => message(`m${i}`, i === 0 ? null : `m${i - 1}`, body));
		const { ctx } = pagedBridge(entries, () => "m10");
		const turn = await getTurnEdits({ type: "get_turn_edits" }, ctx);
		expect(turn).toMatchObject({ cwd: "/tmp", startedAt: 10, endedAt: 17 });
		expect(turn.messages).toEqual([
			{ role: "assistant", content: [call("w1", "write", { path: "b.ts", content: "b\n" })], timestamp: 11 },
			expect.objectContaining({ role: "toolResult", toolCallId: "w1", details: { diff: "+1 x" } }),
		]);
	});

	it("reads back page by page to the prompt of a long turn", async () => {
		const bodies: AgentMessage[] = [user("go", 1), assistant(2, call("e0", "edit", { path: "first.ts" }))];
		bodies.push(result("e0", "edit", 3));
		for (let i = 0; i < 600; i++) bodies.push(assistant(4 + i, call(`b${i}`, "bash", { command: "true" })));
		const entries = bodies.map((body, i) => message(`m${i}`, i === 0 ? null : `m${i - 1}`, body));
		const { ctx, requested } = pagedBridge(entries, () => "leaf");
		const turn = await getTurnEdits({ type: "get_turn_edits" }, ctx);
		expect(turn.startedAt).toBe(1);
		expect(turn.messages.map(m => m.role)).toEqual(["assistant", "toolResult"]);
		// Bounded pages, never the whole transcript in one bridge reply.
		expect(requested.length).toBeGreaterThan(2);
	});

	it("keeps an edit made near the start of a turn longer than a thousand messages", async () => {
		const bodies: AgentMessage[] = [user("go", 1), assistant(2, call("e0", "edit", { path: "early.ts" }))];
		bodies.push(result("e0", "edit", 3));
		for (let i = 0; i < 1500; i++) bodies.push(assistant(4 + i, call(`b${i}`, "bash", { command: "true" })));
		const entries = bodies.map((body, i) => message(`m${i}`, i === 0 ? null : `m${i - 1}`, body));
		const { ctx } = pagedBridge(entries, () => "leaf");
		const turn = await getTurnEdits({ type: "get_turn_edits" }, ctx);
		expect(turn.startedAt).toBe(1);
		expect(turn.messages[0]).toMatchObject({ content: [{ id: "e0", arguments: { path: "early.ts" } }] });
	});
});

describe("switch_session", () => {
	it("binds the explicit model in the switch itself", async () => {
		const sent: Record<string, unknown>[] = [];
		const ctx: LocalCommandContext = {
			cwd: "/tmp",
			omp: { bin: "omp", version: "18.7.0", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			bridge: new GuiBridgeClient(""),
			send: async <T>(command: { type: string }) => {
				sent.push(command);
				return { cancelled: false } as T;
			},
		};
		const switchSession = handlers.switch_session as (
			command: { type: string; sessionPath: string; provider?: string; modelId?: string },
			ctx: LocalCommandContext,
		) => Promise<{ cancelled: boolean }>;
		await switchSession({ type: "switch_session", sessionPath: "/s.jsonl", provider: "p", modelId: "m" }, ctx);
		expect(sent).toEqual([{ type: "switch_session", sessionPath: "/s.jsonl", provider: "p", modelId: "m" }]);
	});
});

describe("transcriptPageMessages", () => {
	it("leaves provider request bookkeeping out of a page and keeps everything shown", () => {
		const content = [{ type: "text" as const, text: "done" }];
		const reply = {
			role: "assistant",
			content,
			timestamp: 2,
			usage: { input: 1 },
			inputTransformations: [{ type: "thinking_dropped", path: "messages.4.content.0" }],
			requestControls: { messageIndex: 2 },
			contextSnapshot: { tokens: 10 },
		};
		const question = user("why", 1);
		const [userRow, replyRow] = transcriptPageMessages([question, reply]);
		expect(userRow).toBe(question);
		expect(replyRow).toEqual({ role: "assistant", content, timestamp: 2, usage: { input: 1 } });
		expect(replyRow?.content).toBe(content);
		expect(reply.inputTransformations).toHaveLength(1);
	});

	it("leaves out a thinking block's provider signature, which nothing on the page reads", () => {
		// An opaque blob the provider checks when the conversation is sent again (stock reads it from the journal, never
		// a page): about a fifth of a long session's tail page.
		const reply = {
			role: "assistant",
			content: [
				{ type: "thinking" as const, thinking: "plan", thinkingSignature: "x".repeat(500) },
				{ type: "text" as const, text: "done" },
			],
			timestamp: 2,
		};
		const [row] = transcriptPageMessages([reply]);
		expect(row?.content).toEqual([
			{ type: "thinking", thinking: "plan" },
			{ type: "text", text: "done" },
		]);
		expect(reply.content[0]).toHaveProperty("thinkingSignature");
		const plain = { role: "assistant", content: [{ type: "text" as const, text: "ok" }], timestamp: 3 };
		expect(transcriptPageMessages([plain])[0]).toBe(plain);
	});
});
