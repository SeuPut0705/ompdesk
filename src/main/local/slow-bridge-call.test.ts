import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SlowCallBreakdown, slowCallBreakdown, timedBridgeRequest } from "./slow-bridge-call";
import type { BridgeTiming, LocalCommandContext } from "./types";

const T0 = 1_800_000_000_000;

/** A bridge that sends after `connectMs`, is picked up by omp after `loopMs`, loads for `loadMs`, runs `callMs`. */
function context(phases: { connectMs: number; loopMs: number; loadMs: number; callMs: number }): LocalCommandContext {
	return {
		cwd: "/",
		omp: { bin: "omp", version: "0", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
		send: async <T>() => undefined as T,
		sidecar: { spawnedAt: T0 - 3_000, contextWaitMs: 0 },
		bridge: {
			connected: true,
			onEvent: () => () => undefined,
			request: async <T>(_method: string, _params?: unknown, onTiming?: (timing: BridgeTiming) => void) => {
				await vi.advanceTimersByTimeAsync(phases.connectMs);
				const sentAt = Date.now();
				const timing: BridgeTiming = { connectWaitMs: phases.connectMs, sentAt };
				onTiming?.(timing);
				await vi.advanceTimersByTimeAsync(phases.loopMs + phases.loadMs + phases.callMs);
				onTiming?.({
					...timing,
					receivedAt: sentAt + phases.loopMs,
					loadMs: phases.loadMs,
					bridgeMs: phases.callMs,
					answeredAt: Date.now(),
				});
				return ["entry"] as T;
			},
		},
	};
}

describe("timedBridgeRequest", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});
	afterEach(() => vi.useRealTimers());

	it("logs nothing for a call inside the budget", async () => {
		const logged: SlowCallBreakdown[] = [];
		const ctx = context({ connectMs: 10, loopMs: 20, loadMs: 0, callMs: 5 });
		await expect(timedBridgeRequest(ctx, "history_recent", {}, 8_000, b => logged.push(b))).resolves.toEqual([
			"entry",
		]);
		expect(logged).toEqual([]);
	});

	it("names where a slow call's time went: at the timeout, and again when the reply comes late", async () => {
		const logged: SlowCallBreakdown[] = [];
		const ctx = context({ connectMs: 1_000, loopMs: 9_000, loadMs: 2_000, callMs: 50 });
		await timedBridgeRequest(ctx, "history_recent", {}, 8_000, b => logged.push(b));
		expect(logged).toEqual([
			{
				method: "history_recent",
				stage: "timeout",
				totalMs: 8_000,
				contextWaitMs: 0,
				bridgeConnectWaitMs: 1_000,
				// Sent at 1 s, still unread by omp at 8 s.
				ompLoopWaitMs: 7_000,
				bridgeLoadMs: null,
				stockCallMs: null,
				sidecarAgeMs: 3_000,
			},
			{
				method: "history_recent",
				stage: "late",
				totalMs: 12_050,
				contextWaitMs: 0,
				bridgeConnectWaitMs: 1_000,
				ompLoopWaitMs: 9_000,
				bridgeLoadMs: 2_000,
				stockCallMs: 50,
				sidecarAgeMs: 3_000,
			},
		]);
	});
});

describe("slowCallBreakdown", () => {
	it("leaves what the call never reached unknown, and the age unknown without a spawn time", () => {
		expect(
			slowCallBreakdown({
				method: "history_recent",
				stage: "timeout",
				startedAt: T0,
				now: T0 + 8_000,
				timing: null,
				sidecar: undefined,
			}),
		).toEqual({
			method: "history_recent",
			stage: "timeout",
			totalMs: 8_000,
			contextWaitMs: null,
			bridgeConnectWaitMs: null,
			ompLoopWaitMs: null,
			bridgeLoadMs: null,
			stockCallMs: null,
			sidecarAgeMs: null,
		});
	});
});
