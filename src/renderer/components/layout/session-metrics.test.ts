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
		const tools = new Map([
			["a", { startTime: 3_000, endTime: 7_000 }],
			["b", { startTime: 4_000, endTime: 6_000 }],
		]);
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
				tools: new Map(),
				awaitingModelSince: 8_000,
				isStreaming: true,
				now: 10_000,
			}),
		).toBe(2_000);
	});
});
