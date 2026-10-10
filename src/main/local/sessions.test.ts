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

describe("get_transcript_page", () => {
	it("pages one bridge snapshot and rejects a cursor from a moved leaf", async () => {
		const entries = Array.from({ length: 5 }, (_, i) =>
			message(`u${i}`, i === 0 ? null : `u${i - 1}`, user(`m${i}`, i)),
		);
		let leafId = "u4";
		let fetches = 0;
		const bridge = new GuiBridgeClient("");
		const snapshot = async <T>(method: string) => {
			expect(method).toBe("sessions.transcript");
			fetches++;
			return { messages: entries.map(entry => ({ ...entry.message, entryId: entry.id })), leafId } as T;
		};
		vi.spyOn(bridge, "request").mockImplementation(snapshot);
		const ctx: LocalCommandContext = {
			cwd: "/tmp",
			omp: { bin: "omp", version: "18.6.1", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			bridge,
			emit: () => {},
			send: async () => {
				throw new Error("Transcript must not request raw entries");
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
		const otherBridge = new GuiBridgeClient("");
		vi.spyOn(otherBridge, "request").mockImplementation(snapshot);
		const stale = page(
			{ type: "get_transcript_page", limit: 2, cursor: second.nextCursor },
			{ ...ctx, bridge: otherBridge },
		);
		await expect(stale).rejects.toThrow("stale");
	});

	it("overlapping walks of one spawn share one projection instead of re-fetching per page", async () => {
		const entries = Array.from({ length: 6 }, (_, i) =>
			message(`u${i}`, i === 0 ? null : `u${i - 1}`, user(`m${i}`, i)),
		);
		let fetches = 0;
		const bridge = new GuiBridgeClient("");
		vi.spyOn(bridge, "request").mockImplementation(async <T>() => {
			fetches++;
			return { messages: entries.map(entry => ({ ...entry.message, entryId: entry.id })), leafId: "u5" } as T;
		});
		const ctx: LocalCommandContext = {
			cwd: "/tmp",
			omp: { bin: "omp", version: "18.6.1", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			bridge,
			emit: () => {},
			send: async () => {
				throw new Error("Transcript must not request raw entries");
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
