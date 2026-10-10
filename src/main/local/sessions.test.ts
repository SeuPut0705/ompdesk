import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, MessagesPage } from "../../shared/rpc-types";
import { GuiBridgeClient } from "../bridge-client";
import { handlers } from "./sessions";
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
		const { offset, limit } = params as { offset: number; limit: number };
		const messages = entries.map(entry => ({ ...entry.message, entryId: entry.id }));
		return { leafId: leaf(), total: messages.length, messages: messages.slice(offset, offset + limit) } as T;
	});
	const ctx: LocalCommandContext = {
		cwd: "/tmp",
		omp: { bin: "omp", version: "18.8.7", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
		bridge,
		emit: () => {},
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

describe("switch_session", () => {
	it("binds the explicit model in the switch itself", async () => {
		const sent: Record<string, unknown>[] = [];
		const ctx: LocalCommandContext = {
			cwd: "/tmp",
			omp: { bin: "omp", version: "18.7.0", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			bridge: new GuiBridgeClient(""),
			emit: () => {},
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
