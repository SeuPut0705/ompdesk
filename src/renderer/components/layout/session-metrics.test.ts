import { describe, expect, it } from "vitest";
import type { AgentMessage, SessionStats } from "../../../shared/rpc-types";
import { sessionCacheHitPercent, sessionExecutionDurationMs } from "./session-metrics";

const stats = {
	tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 300, cacheWrite: 100, total: 520 },
} as SessionStats;

describe("session metrics", () => {
	it("uses the shared cache-hit formula", () => {
		expect(sessionCacheHitPercent(stats)).toBe(60);
	});

	it("counts model and tool wall time without double-counting parallel work", () => {
		const messages = [
			{ role: "assistant", timestamp: 1_000, duration: 2_000 },
			{ role: "assistant", timestamp: 7_000, duration: 1_000 },
		] as AgentMessage[];
		const tools = [
			{ status: "done" as const, startTime: 3_000, endTime: 7_000 },
			{ status: "done" as const, startTime: 4_000, endTime: 6_000 },
		];
		expect(
			sessionExecutionDurationMs({
				messages,
				streamingMessage: null,
				tools,
				awaitingModelSince: null,
				isStreaming: false,
				now: 10_000,
			}),
		).toBe(7_000);
	});

	it("keeps the active request clock moving before the response arrives", () => {
		expect(
			sessionExecutionDurationMs({
				messages: [],
				streamingMessage: null,
				tools: [],
				awaitingModelSince: 8_000,
				isStreaming: true,
				now: 10_000,
			}),
		).toBe(2_000);
	});

	it("does not count history calls left aborted without an end time as running", () => {
		// A rebuilt transcript marks unanswered calls `aborted` with endTime null.
		// Counting them to "now" turned a call from hours ago into hours of execution.
		const tools = [
			{ status: "aborted" as const, startTime: 1_000, endTime: null },
			{ status: "running" as const, startTime: 3_600_000, endTime: null },
		];
		expect(
			sessionExecutionDurationMs({
				messages: [],
				streamingMessage: null,
				tools,
				awaitingModelSince: null,
				isStreaming: true,
				now: 3_605_000,
			}),
		).toBe(5_000);
	});
});
