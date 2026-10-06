import type { AgentSessionEvent, RpcLoopLimit, RpcLoopModeState } from "../../shared/rpc-types";
import { formatDuration } from "./format";

export type LoopLimitInfo =
	| { kind: "count"; count: number }
	| { kind: "iterations"; initial: number; remaining: number }
	| { kind: "duration"; durationMs: number; deadlineMs: number };

export function parseLoopLimit(limit: unknown): LoopLimitInfo | null {
	if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
		return { kind: "count", count: limit };
	}
	if (limit !== null && typeof limit === "object") {
		const record = limit as Record<string, unknown>;
		if (record.kind === "iterations" && typeof record.initial === "number" && typeof record.remaining === "number") {
			return { kind: "iterations", initial: record.initial, remaining: record.remaining };
		}
		if (
			record.kind === "duration" &&
			typeof record.durationMs === "number" &&
			typeof record.deadlineMs === "number"
		) {
			return { kind: "duration", durationMs: record.durationMs, deadlineMs: record.deadlineMs };
		}
	}
	return null;
}

type LoopModeUpdateEvent = Extract<AgentSessionEvent, { type: "loop_mode_update" }>;

/** Accept the flattened GUI frame and the sidecar's nested runtime frame. */
export function normalizeLoopUpdate(event: LoopModeUpdateEvent): RpcLoopModeState | null {
	const raw = event as unknown as {
		enabled?: boolean;
		state?:
			| RpcLoopModeState["state"]
			| { enabled?: boolean; state?: string; prompt?: string; limit?: number | RpcLoopLimit };
		prompt?: string;
		limit?: number | RpcLoopLimit;
	};
	const toLimit = (limit: number | RpcLoopLimit | undefined): RpcLoopLimit | undefined =>
		typeof limit === "number" ? { kind: "iterations", initial: limit, remaining: limit } : limit;
	if (raw.state !== null && typeof raw.state === "object") {
		const nested = raw.state;
		if (typeof nested.enabled !== "boolean" || typeof nested.state !== "string") return null;
		return {
			enabled: nested.enabled,
			state: nested.state as RpcLoopModeState["state"],
			prompt: nested.prompt,
			limit: toLimit(nested.limit),
		};
	}
	if (typeof raw.enabled !== "boolean" || typeof raw.state !== "string") return null;
	return {
		enabled: raw.enabled,
		state: raw.state as RpcLoopModeState["state"],
		prompt: raw.prompt,
		limit: toLimit(raw.limit),
	};
}

export function loopLimitText(
	t: (key: string, params?: Record<string, string | number>) => string,
	limit: LoopLimitInfo,
): string {
	switch (limit.kind) {
		case "count":
			return t("modesPanel.loop.limitValue.count", { count: limit.count });
		case "iterations":
			return t("modesPanel.loop.limitValue.iterations", { remaining: limit.remaining, initial: limit.initial });
		case "duration":
			return t("modesPanel.loop.limitValue.duration", { duration: formatDuration(limit.durationMs) });
	}
}
