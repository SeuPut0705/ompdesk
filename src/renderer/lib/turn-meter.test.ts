import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentSessionEvent } from "../../shared/rpc-types";
import {
	applyTurnMeterEvent,
	averageTokensPerSecond,
	CHARS_PER_TOKEN,
	EMPTY_TURN_METER,
	isTurnMeterEstimate,
	recordThroughputSample,
	summarizeMessagesOutput,
	THROUGHPUT_MIN_SPAN_MS,
	THROUGHPUT_WINDOW_MS,
	type ThroughputSample,
	type TurnMeter,
	throughputTokensPerSecond,
	turnMeterTokens,
} from "./turn-meter";

function steady(tokensPerSample: number, intervalMs: number, count: number, start = 0): ThroughputSample[] {
	let samples: readonly ThroughputSample[] = [];
	for (let index = 0; index < count; index++) {
		samples = recordThroughputSample(samples, tokensPerSample, start + index * intervalMs);
	}
	return [...samples];
}

const assistant = (extra: Partial<AgentMessage> = {}): AgentMessage =>
	({ role: "assistant", content: [], timestamp: 0, ...extra }) as AgentMessage;

const textDelta = (delta: string, message: AgentMessage = assistant()): AgentSessionEvent =>
	({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
	}) as AgentSessionEvent;

function run(events: Array<[AgentSessionEvent, number]>, from: TurnMeter = EMPTY_TURN_METER): TurnMeter {
	return events.reduce((meter, [event, now]) => applyTurnMeterEvent(meter, event, now), from);
}

describe("throughput window", () => {
	it("is zero with no samples", () => {
		expect(throughputTokensPerSecond([], 1_000)).toBe(0);
	});

	it("averages a steady stream over the window", () => {
		// 10 tokens every 100ms for 5s = 100 tok/s.
		const samples = steady(10, 100, 50);
		const now = 49 * 100;
		expect(throughputTokensPerSecond(samples, now)).toBeCloseTo(100, -1);
	});

	it("only counts samples inside the sliding window", () => {
		// A fast burst long ago, then a slow steady stream: the rate reflects the recent stream.
		const burst = steady(500, 10, 10, 0);
		const slow = steady(5, 100, 40, 10_000);
		const samples = [...burst, ...slow];
		const now = 10_000 + 39 * 100;
		expect(throughputTokensPerSecond(samples, now)).toBeCloseTo(50, -1);
		expect(samples.length).toBeGreaterThan(0);
		expect(recordThroughputSample(samples, 5, now).every(sample => sample.time >= now - THROUGHPUT_WINDOW_MS)).toBe(
			true,
		);
	});

	it("floors the span so the first delta cannot spike the rate", () => {
		const samples = recordThroughputSample([], 50, 1_000);
		expect(throughputTokensPerSecond(samples, 1_000)).toBe((50 / THROUGHPUT_MIN_SPAN_MS) * 1000);
	});

	it("decays while idle and reaches zero once the window passes", () => {
		const samples = steady(10, 100, 30);
		const lastAt = 29 * 100;
		const live = throughputTokensPerSecond(samples, lastAt);
		const idling = throughputTokensPerSecond(samples, lastAt + 1_500);
		expect(idling).toBeLessThan(live);
		expect(throughputTokensPerSecond(samples, lastAt + THROUGHPUT_WINDOW_MS + 1)).toBe(0);
	});

	it("ignores zero, negative and non-finite deltas", () => {
		expect(recordThroughputSample([], 0, 1)).toEqual([]);
		expect(recordThroughputSample([], -3, 1)).toEqual([]);
		expect(recordThroughputSample([], Number.NaN, 1)).toEqual([]);
	});
});

describe("turn meter reducer", () => {
	it("estimates streamed text, then takes the provider's final count", () => {
		const final = assistant({ usage: { input: 10, output: 42 } });
		const streaming = run([
			[{ type: "agent_start" } as AgentSessionEvent, 0],
			[{ type: "message_start", message: assistant() }, 10],
			[textDelta("x".repeat(40)), 110],
			[textDelta("x".repeat(40)), 210],
		]);
		expect(turnMeterTokens(streaming)).toBe(80 / CHARS_PER_TOKEN);
		expect(isTurnMeterEstimate(streaming)).toBe(true);
		expect(throughputTokensPerSecond(streaming.samples, 210)).toBeGreaterThan(0);

		const ended = run([[{ type: "message_end", message: final }, 1_010]], streaming);
		expect(turnMeterTokens(ended)).toBe(42);
		expect(isTurnMeterEstimate(ended)).toBe(false);
		expect(ended.generationMs).toBe(1_000);
		expect(averageTokensPerSecond(ended.finalTokens, ended.generationMs)).toBe(42);
	});

	it("keeps an estimate (and says so) when the provider reports no usage", () => {
		const meter = run([
			[{ type: "agent_start" } as AgentSessionEvent, 0],
			[{ type: "message_start", message: assistant() }, 0],
			[textDelta("x".repeat(20)), 100],
			[{ type: "message_end", message: assistant() }, 200],
		]);
		expect(meter.finalTokens).toBe(20 / CHARS_PER_TOKEN);
		expect(isTurnMeterEstimate(meter)).toBe(true);
	});

	it("prefers live usage on the partial message over the character estimate", () => {
		const meter = run([
			[{ type: "agent_start" } as AgentSessionEvent, 0],
			[{ type: "message_start", message: assistant() }, 0],
			[textDelta("abcd", assistant({ usage: { output: 30 } })), 100],
		]);
		expect(turnMeterTokens(meter)).toBe(30);
		expect(isTurnMeterEstimate(meter)).toBe(false);
	});

	it("resets on agent_start and stops sampling at agent_end", () => {
		const ended = run([
			[{ type: "agent_start" } as AgentSessionEvent, 0],
			[{ type: "message_start", message: assistant() }, 0],
			[textDelta("x".repeat(400)), 100],
			[{ type: "agent_end", messages: [] } as AgentSessionEvent, 200],
		]);
		expect(ended.endedAt).toBe(200);
		expect(ended.samples).toEqual([]);
		const next = run([[{ type: "agent_start" } as AgentSessionEvent, 500]], ended);
		expect(next).toEqual({ ...EMPTY_TURN_METER, startedAt: 500 });
	});

	it("leaves the meter untouched for events that carry no output", () => {
		const meter = run([[{ type: "agent_start" } as AgentSessionEvent, 0]]);
		expect(applyTurnMeterEvent(meter, { type: "turn_start" } as AgentSessionEvent, 10)).toBe(meter);
		expect(applyTurnMeterEvent(meter, { type: "message_start", message: { role: "user", content: "hi" } }, 10)).toBe(
			meter,
		);
	});
});

describe("finished row output", () => {
	it("sums provider usage and averages over the messages' durations", () => {
		const summary = summarizeMessagesOutput([
			assistant({ usage: { output: 300 }, duration: 3_000 }),
			{ role: "user", content: "x", timestamp: 0 } as AgentMessage,
			assistant({ usage: { output: 100 }, duration: 1_000 }),
		]);
		expect(summary).toEqual({ tokens: 400, rate: 100 });
	});

	it("reports no rate without durations and nothing without usage", () => {
		expect(summarizeMessagesOutput([assistant({ usage: { output: 50 } })])).toEqual({ tokens: 50, rate: 0 });
		expect(summarizeMessagesOutput([assistant()])).toEqual({ tokens: 0, rate: 0 });
	});
});
