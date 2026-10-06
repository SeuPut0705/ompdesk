import type { AgentMessage, SessionStats } from "../../../shared/rpc-types";
import type { ToolEntry } from "../../stores/tools";

interface TimeRange {
	start: number;
	end: number;
}

function timestampMs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function addRange(ranges: TimeRange[], start: number | null, end: number | null): void {
	if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
	ranges.push({ start, end });
}

/** Cache reads divided by every prompt token eligible for caching. */
export function sessionCacheHitPercent(stats: SessionStats | null): number | null {
	if (!stats) return null;
	const denominator = stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite;
	return denominator > 0 ? (stats.tokens.cacheRead / denominator) * 100 : 0;
}

/** Sum real model/tool activity, merging overlaps so parallel tools count once. */
export function sessionExecutionDurationMs({
	messages,
	streamingMessage,
	tools,
	awaitingModelSince,
	isStreaming,
	now,
}: {
	messages: AgentMessage[];
	streamingMessage: AgentMessage | null;
	tools: ReadonlyMap<string, Pick<ToolEntry, "startTime" | "endTime">>;
	awaitingModelSince: number | null;
	isStreaming: boolean;
	now: number;
}): number {
	const ranges: TimeRange[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const start = timestampMs(message.timestamp);
		const duration = typeof message.duration === "number" && Number.isFinite(message.duration) ? message.duration : 0;
		addRange(ranges, start, start === null ? null : start + Math.max(0, duration));
	}
	for (const tool of tools.values()) {
		addRange(ranges, tool.startTime, tool.endTime ?? (isStreaming ? now : null));
	}
	if (isStreaming) {
		const streamingStart = timestampMs(streamingMessage?.timestamp);
		addRange(ranges, streamingStart ?? awaitingModelSince, now);
	}
	if (ranges.length === 0) return 0;
	ranges.sort((left, right) => left.start - right.start || left.end - right.end);
	let total = 0;
	let current = ranges[0]!;
	for (let index = 1; index < ranges.length; index += 1) {
		const next = ranges[index]!;
		if (next.start <= current.end) {
			current.end = Math.max(current.end, next.end);
			continue;
		}
		total += current.end - current.start;
		current = next;
	}
	return total + current.end - current.start;
}
