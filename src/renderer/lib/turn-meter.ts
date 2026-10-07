/**
 * Live output-token meter for the running agent turn: how many tokens the
 * model has produced so far and how fast, shown on the running work-summary
 * row ("↓ 12.4k · 86 tok/s").
 *
 * Providers rarely stream usage, so while a message streams its count is
 * either the partial message's `usage.output` (when the provider reports it)
 * or an estimate from streamed text/thinking/tool-argument characters. At
 * message_end the provider's final count replaces the estimate. A meter that
 * still includes an estimate says so (`isTurnMeterEstimate`), and the UI marks
 * the number with "~".
 *
 * Pure reducer + helpers; the messages store owns the instance.
 */
import type { AgentMessage, AgentSessionEvent } from "../../shared/rpc-types";

/** Sliding window (ms) the live throughput averages over. */
export const THROUGHPUT_WINDOW_MS = 3000;
/** Floor for the averaging span, so the first deltas of a stream cannot spike the rate. */
export const THROUGHPUT_MIN_SPAN_MS = 500;
/** Rough characters-per-token used when the provider reports no live usage. */
export const CHARS_PER_TOKEN = 4;

export interface ThroughputSample {
	/** When the tokens were observed (ms, same clock as `now`). */
	time: number;
	tokens: number;
}

export interface TurnMeter {
	/** agent_start time; null when no run has been observed. */
	startedAt: number | null;
	/** agent_end time; null while the run is live. */
	endedAt: number | null;
	/** Output tokens of the run's finalized assistant messages. */
	finalTokens: number;
	/** True when any finalized message lacked provider usage and was estimated. */
	finalEstimated: boolean;
	/** Streamed characters (text, thinking, tool arguments) of the in-flight message. */
	liveChars: number;
	/** `usage.output` the provider reported on the in-flight partial message (0 if none). */
	liveReportedTokens: number;
	/** message_start time of the in-flight assistant message. */
	messageStartedAt: number | null;
	/** Summed streaming time of the run's finalized assistant messages. */
	generationMs: number;
	/** Recent token deltas, oldest first, pruned to the throughput window. */
	samples: readonly ThroughputSample[];
}

export const EMPTY_TURN_METER: TurnMeter = {
	startedAt: null,
	endedAt: null,
	finalTokens: 0,
	finalEstimated: false,
	liveChars: 0,
	liveReportedTokens: 0,
	messageStartedAt: null,
	generationMs: 0,
	samples: [],
};

/** Provider-reported output tokens on a message, or 0 when it carries none. */
export function reportedOutputTokens(message: AgentMessage | undefined): number {
	const usage = message?.usage;
	if (usage == null || typeof usage !== "object") return 0;
	const output = (usage as Record<string, unknown>).output;
	return typeof output === "number" && Number.isFinite(output) && output > 0 ? output : 0;
}

/** Tokens of the in-flight message: the provider's count when reported, else the character estimate. */
export function liveMessageTokens(meter: TurnMeter): number {
	return meter.liveReportedTokens > 0 ? meter.liveReportedTokens : meter.liveChars / CHARS_PER_TOKEN;
}

/** Output tokens the run has produced so far (finalized + in flight). */
export function turnMeterTokens(meter: TurnMeter): number {
	return meter.finalTokens + liveMessageTokens(meter);
}

/** Whether the shown token count includes an estimate. */
export function isTurnMeterEstimate(meter: TurnMeter): boolean {
	return meter.finalEstimated || (meter.liveReportedTokens === 0 && meter.liveChars > 0);
}

/** Drop samples older than the window, keeping the array identity when nothing aged out. */
export function pruneSamples(
	samples: readonly ThroughputSample[],
	now: number,
	windowMs = THROUGHPUT_WINDOW_MS,
): readonly ThroughputSample[] {
	const threshold = now - windowMs;
	let first = 0;
	while (first < samples.length && (samples[first]?.time ?? 0) < threshold) first++;
	return first === 0 ? samples : samples.slice(first);
}

/** Append one token delta and prune the window. Non-positive/non-finite deltas are ignored. */
export function recordThroughputSample(
	samples: readonly ThroughputSample[],
	tokens: number,
	now: number,
	windowMs = THROUGHPUT_WINDOW_MS,
): readonly ThroughputSample[] {
	if (!Number.isFinite(tokens) || tokens <= 0) return pruneSamples(samples, now, windowMs);
	return [...pruneSamples(samples, now, windowMs), { time: now, tokens }];
}

/**
 * Tokens per second over the sliding window: the tokens observed inside it
 * divided by the time they span (from the oldest sample still inside the
 * window to now, floored at {@link THROUGHPUT_MIN_SPAN_MS}). 0 when nothing
 * arrived within the window — the stream is idle (a tool runs, the model waits).
 */
export function throughputTokensPerSecond(
	samples: readonly ThroughputSample[],
	now: number,
	windowMs = THROUGHPUT_WINDOW_MS,
): number {
	const live = pruneSamples(samples, now, windowMs);
	const oldest = live[0];
	if (!oldest) return 0;
	let tokens = 0;
	for (const sample of live) tokens += sample.tokens;
	const span = Math.min(windowMs, Math.max(THROUGHPUT_MIN_SPAN_MS, now - oldest.time));
	return (tokens / span) * 1000;
}

/** Average output rate over the run's finished generation time; 0 when unknown. */
export function averageTokensPerSecond(tokens: number, generationMs: number): number {
	if (!(tokens > 0) || !(generationMs > 0)) return 0;
	return (tokens / generationMs) * 1000;
}

function streamedDeltaChars(event: Extract<AgentSessionEvent, { type: "message_update" }>): number {
	const update = event.assistantMessageEvent;
	if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
		return update.delta.length;
	}
	return 0;
}

/** Fold one session event into the meter. Returns the same object when the event is irrelevant. */
export function applyTurnMeterEvent(meter: TurnMeter, event: AgentSessionEvent, now: number): TurnMeter {
	switch (event.type) {
		case "agent_start":
			return { ...EMPTY_TURN_METER, startedAt: now };
		case "message_start": {
			if (event.message.role !== "assistant") return meter;
			return {
				...meter,
				// A view that joined mid-run never saw agent_start.
				startedAt: meter.startedAt ?? now,
				endedAt: null,
				liveChars: 0,
				liveReportedTokens: 0,
				messageStartedAt: now,
			};
		}
		case "message_update": {
			const chars = streamedDeltaChars(event);
			const reported = reportedOutputTokens(event.message);
			if (chars === 0 && reported <= meter.liveReportedTokens) return meter;
			const before = liveMessageTokens(meter);
			const next: TurnMeter = {
				...meter,
				liveChars: meter.liveChars + chars,
				liveReportedTokens: Math.max(meter.liveReportedTokens, reported),
			};
			return { ...next, samples: recordThroughputSample(meter.samples, liveMessageTokens(next) - before, now) };
		}
		case "message_end": {
			if (event.message.role !== "assistant" || meter.messageStartedAt == null) return meter;
			const reported = reportedOutputTokens(event.message);
			const tokens = reported > 0 ? reported : liveMessageTokens(meter);
			return {
				...meter,
				finalTokens: meter.finalTokens + tokens,
				finalEstimated: meter.finalEstimated || (reported === 0 && tokens > 0),
				generationMs: meter.generationMs + Math.max(0, now - meter.messageStartedAt),
				liveChars: 0,
				liveReportedTokens: 0,
				messageStartedAt: null,
			};
		}
		case "agent_end":
			if (event.isTerminal === false) return meter;
			return { ...meter, endedAt: now, liveChars: 0, liveReportedTokens: 0, messageStartedAt: null, samples: [] };
		default:
			return meter;
	}
}

/** Final per-row figures for finished work: summed provider usage and duration. */
export function summarizeMessagesOutput(messages: readonly AgentMessage[]): { tokens: number; rate: number } {
	let tokens = 0;
	let durationMs = 0;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const output = reportedOutputTokens(message);
		if (output === 0) continue;
		tokens += output;
		if (typeof message.duration === "number" && Number.isFinite(message.duration) && message.duration > 0) {
			durationMs += message.duration;
		}
	}
	return { tokens, rate: averageTokensPerSecond(tokens, durationMs) };
}
