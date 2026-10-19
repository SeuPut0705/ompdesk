/**
 * A bridge call the renderer gives up on after the RPC timeout (rpc-client.ts `DEFAULT_TIMEOUT_MS`) says where its
 * time went, in gui-runtime.jsonl: once when the timeout passes (what is known by then) and once more if the reply
 * still comes (the whole breakdown). Nothing is retried or waited for longer: this only observes.
 */
import { DEFAULT_TIMEOUT_MS } from "../rpc-client";
import { writeRuntimeLog } from "../runtime-log";
import type { BridgeTiming, LocalCommandContext } from "./types";

/** Where a slow bridge call spent its time; null fields were not reached (or the bridge is older). */
export interface SlowCallBreakdown {
	method: string;
	/** `timeout`: the budget passed with no reply yet; `late`: the reply came after it; `failed`: the call failed after it. */
	stage: "timeout" | "late" | "failed";
	totalMs: number;
	/** Building the command's context (learning the session from stock `get_state`). */
	contextWaitMs: number | null;
	/** Waiting for the bridge socket to connect. */
	bridgeConnectWaitMs: number | null;
	/** Sent, but omp's event loop had not got to it yet (omp busy with other work). */
	ompLoopWaitMs: number | null;
	/** The bridge waiting for its modules to load (stock imports at omp startup). */
	bridgeLoadMs: number | null;
	/** The stock call itself. */
	stockCallMs: number | null;
	/** How long the sidecar's omp had been running when the call started. */
	sidecarAgeMs: number | null;
}

export function slowCallBreakdown(input: {
	method: string;
	stage: SlowCallBreakdown["stage"];
	startedAt: number;
	now: number;
	timing: BridgeTiming | null;
	sidecar: LocalCommandContext["sidecar"];
}): SlowCallBreakdown {
	const { timing, sidecar } = input;
	const waitForLoop =
		timing?.receivedAt !== undefined
			? timing.receivedAt - timing.sentAt
			: timing && input.stage === "timeout"
				? input.now - timing.sentAt
				: null;
	return {
		method: input.method,
		stage: input.stage,
		totalMs: input.now - input.startedAt,
		contextWaitMs: sidecar?.contextWaitMs ?? null,
		bridgeConnectWaitMs: timing?.connectWaitMs ?? null,
		ompLoopWaitMs: waitForLoop,
		bridgeLoadMs: timing?.loadMs ?? null,
		stockCallMs: timing?.bridgeMs ?? null,
		sidecarAgeMs: sidecar?.spawnedAt ? input.startedAt - sidecar.spawnedAt : null,
	};
}

/** `ctx.bridge.request(method, params)`, logging a breakdown when it outlives `budgetMs`. */
export async function timedBridgeRequest<T>(
	ctx: LocalCommandContext,
	method: string,
	params: unknown,
	budgetMs = DEFAULT_TIMEOUT_MS,
	log: (breakdown: SlowCallBreakdown) => void = breakdown =>
		writeRuntimeLog({
			level: "warn",
			source: "slow-bridge-call",
			message: `${method} ${breakdown.stage === "timeout" ? `passed its ${budgetMs} ms timeout` : `ended ${breakdown.stage}`}`,
			details: breakdown,
		}),
): Promise<T> {
	const startedAt = Date.now() - (ctx.sidecar?.contextWaitMs ?? 0);
	let timing: BridgeTiming | null = null;
	let overdue = false;
	const timer = setTimeout(
		() => {
			overdue = true;
			log(slowCallBreakdown({ method, stage: "timeout", startedAt, now: Date.now(), timing, sidecar: ctx.sidecar }));
		},
		budgetMs - (ctx.sidecar?.contextWaitMs ?? 0),
	);
	const settle = (stage: "late" | "failed") => {
		clearTimeout(timer);
		if (overdue) log(slowCallBreakdown({ method, stage, startedAt, now: Date.now(), timing, sidecar: ctx.sidecar }));
	};
	try {
		const value = await ctx.bridge.request<T>(method, params, settled => {
			timing = settled;
		});
		settle("late");
		return value;
	} catch (error) {
		settle("failed");
		throw error;
	}
}
