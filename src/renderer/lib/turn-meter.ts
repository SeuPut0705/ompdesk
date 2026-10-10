/** Provider-reported run totals plus the paced stock AgentSession.tokenRate.rate() reading. */
import type { AgentMessage, AgentSessionEvent } from "../../shared/rpc-types";

export interface TurnMeter {
	startedAt: number | null;
	endedAt: number | null;
	finalTokens: number;
	liveReportedTokens: number;
	messageStartedAt: number | null;
	generationMs: number;
	rate: number | null;
}
export const EMPTY_TURN_METER: TurnMeter = {
	startedAt: null,
	endedAt: null,
	finalTokens: 0,
	liveReportedTokens: 0,
	messageStartedAt: null,
	generationMs: 0,
	rate: null,
};
export function reportedOutputTokens(message: AgentMessage | undefined): number {
	const usage = message?.usage;
	if (usage == null || typeof usage !== "object") return 0;
	const output = (usage as Record<string, unknown>).output;
	return typeof output === "number" && Number.isFinite(output) && output > 0 ? output : 0;
}
export function turnMeterTokens(meter: TurnMeter): number {
	return meter.finalTokens + meter.liveReportedTokens;
}
export function averageTokensPerSecond(tokens: number, generationMs: number): number {
	return tokens > 0 && generationMs > 0 ? (tokens / generationMs) * 1000 : 0;
}
export function applyTurnMeterEvent(meter: TurnMeter, event: AgentSessionEvent, now: number): TurnMeter {
	switch (event.type) {
		case "token_rate":
			return { ...meter, rate: event.rate };
		case "agent_start":
			return { ...EMPTY_TURN_METER, startedAt: now, rate: meter.rate };
		case "message_start":
			if (event.message.role !== "assistant") return meter;
			return {
				...meter,
				startedAt: meter.startedAt ?? now,
				endedAt: null,
				liveReportedTokens: 0,
				messageStartedAt: now,
			};
		case "message_update": {
			const reported = reportedOutputTokens(event.message);
			return reported > meter.liveReportedTokens ? { ...meter, liveReportedTokens: reported } : meter;
		}
		case "message_end":
			if (event.message.role !== "assistant" || meter.messageStartedAt == null) return meter;
			return {
				...meter,
				finalTokens: meter.finalTokens + reportedOutputTokens(event.message),
				generationMs: meter.generationMs + Math.max(0, now - meter.messageStartedAt),
				liveReportedTokens: 0,
				messageStartedAt: null,
			};
		case "agent_end":
			return event.isTerminal === false
				? meter
				: { ...meter, endedAt: now, liveReportedTokens: 0, messageStartedAt: null };
		default:
			return meter;
	}
}
/** Finished run aggregates are GUI presentation, not stock's live rate window. */
export function summarizeMessagesOutput(messages: readonly AgentMessage[]): { tokens: number; rate: number } {
	let tokens = 0;
	let durationMs = 0;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const output = reportedOutputTokens(message);
		if (output === 0) continue;
		tokens += output;
		if (typeof message.duration === "number" && Number.isFinite(message.duration) && message.duration > 0)
			durationMs += message.duration;
	}
	return { tokens, rate: averageTokensPerSecond(tokens, durationMs) };
}
