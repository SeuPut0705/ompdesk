import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../shared/rpc-types";
import { applyTurnMeterEvent, EMPTY_TURN_METER, summarizeMessagesOutput, turnMeterTokens } from "./turn-meter";

const assistant: AgentMessage = { role: "assistant", content: [], timestamp: 1 };
describe("stock live meter", () => {
	it("uses host rate without estimating tokens from streamed characters", () => {
		let meter = applyTurnMeterEvent(EMPTY_TURN_METER, { type: "agent_start" }, 0);
		meter = applyTurnMeterEvent(meter, { type: "message_start", message: assistant }, 10);
		meter = applyTurnMeterEvent(
			meter,
			{
				type: "message_update",
				message: assistant,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a".repeat(1000), partial: assistant },
			},
			20,
		);
		expect(turnMeterTokens(meter)).toBe(0);
		meter = applyTurnMeterEvent(meter, { type: "token_rate", rate: 83.5 }, 30);
		expect(meter.rate).toBe(83.5);
		meter = applyTurnMeterEvent(meter, { type: "token_rate", rate: null }, 40);
		expect(meter.rate).toBeNull();
	});
	it("aggregates provider totals and keeps nonterminal turns running", () => {
		let meter = applyTurnMeterEvent(EMPTY_TURN_METER, { type: "agent_start" }, 0);
		for (const output of [42, 18]) {
			meter = applyTurnMeterEvent(meter, { type: "message_start", message: assistant }, 10);
			meter = applyTurnMeterEvent(
				meter,
				{ type: "message_end", message: { ...assistant, usage: { output } } },
				1010,
			);
		}
		expect(turnMeterTokens(meter)).toBe(60);
		expect(meter.generationMs).toBe(2000);
		expect(applyTurnMeterEvent(meter, { type: "agent_end", isTerminal: false }, 1020)).toBe(meter);
		expect(applyTurnMeterEvent(meter, { type: "agent_end" }, 1030).endedAt).toBe(1030);
	});
	it("keeps finalized work totals independent of live stock throughput", () => {
		expect(
			summarizeMessagesOutput([
				{ ...assistant, usage: { output: 40 }, duration: 1000 },
				{ ...assistant, usage: { output: 20 }, duration: 1000 },
			]),
		).toEqual({ tokens: 60, rate: 30 });
	});
	it("holds the model's wait from the request until a usable answer, output or the run's end", () => {
		const sent = { type: "model_request", phase: "sent" } as const;
		let meter = applyTurnMeterEvent(EMPTY_TURN_METER, { type: "agent_start" }, 0);
		expect(meter.modelWaitSince).toBeNull();
		meter = applyTurnMeterEvent(meter, sent, 100);
		expect(meter.modelWaitSince).toBe(100);
		// A rebuilt body sent again inside the call keeps the first request's time.
		meter = applyTurnMeterEvent(meter, sent, 400);
		expect(meter.modelWaitSince).toBe(100);
		expect(applyTurnMeterEvent(meter, { type: "model_request", phase: "answered" }, 500).modelWaitSince).toBeNull();
		const update = {
			type: "message_update",
			message: assistant,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a", partial: assistant },
		} as const;
		expect(applyTurnMeterEvent(meter, update, 500).modelWaitSince).toBeNull();
		// A failed attempt stock retries ends its run unanswered: the retry's own status takes over.
		expect(applyTurnMeterEvent(meter, { type: "agent_end", isTerminal: false }, 500).modelWaitSince).toBeNull();
		expect(applyTurnMeterEvent(meter, { type: "agent_end" }, 500).modelWaitSince).toBeNull();
		expect(applyTurnMeterEvent(meter, { type: "agent_start" }, 500).modelWaitSince).toBeNull();
	});
});
