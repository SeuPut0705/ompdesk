import { describe, expect, it } from "vitest";
import {
	TURN_STAGES_EVENT,
	TURN_STAGES_MAX_DETAILS,
	type TurnStagesFrame,
} from "../../resources/gui-bridge/turn-stages-contracts";
import { noteSlowSpot, setActiveRecorder, TurnStageRecorder } from "../../resources/gui-bridge/turn-stages-core";
import { turnStagesReport } from "./turn-stages-log";

/** The recorder on a hand-set clock, so a six-minute stall takes no time. */
function world(lateMs = 30_000) {
	const frames: TurnStagesFrame[] = [];
	let now = 1_000_000;
	const recorder = new TurnStageRecorder({
		emit: frame => frames.push(frame),
		now: () => now,
		lateMs,
		model: () => ({ provider: "anthropic", id: "claude-opus-5-5" }),
	});
	const at = (ms: number) => {
		now += ms;
	};
	const assistant = (extra: Record<string, unknown> = {}) => ({ role: "assistant", ...extra });
	const event = (type: string, extra: Record<string, unknown> = {}) => recorder.sessionEvent({ type, ...extra });
	/** One prompt up to the model call's request being built and its stream opened. */
	const toRequest = (handlersMs = 5, prepareMs = 5) => {
		recorder.promptReceived("fix it", false);
		at(10);
		recorder.handlersStart();
		at(handlersMs);
		recorder.handlersEnd();
		at(prepareMs);
		event("agent_start");
		event("turn_start");
		at(20);
		recorder.providerRequest();
		event("message_start", { message: assistant() });
	};
	return { frames, recorder, at, assistant, event, toRequest };
}

const only = (frames: TurnStagesFrame[]) => {
	expect(frames).toHaveLength(1);
	return frames[0].details;
};

describe("TurnStageRecorder", () => {
	it("says nothing for a turn whose output came in time", () => {
		const w = world();
		w.toRequest();
		w.at(800);
		w.recorder.providerResponse();
		w.at(400);
		w.event("message_update", { message: w.assistant() });
		w.at(2_000);
		w.event("agent_end", { messages: [w.assistant({ stopReason: "stop" })] });
		expect(w.frames).toEqual([]);
	});

	it("names the handlers as the stage of a late first output", () => {
		const w = world();
		// a before_agent_start handler holds the turn for 40 s
		w.toRequest(40_000);
		w.at(600);
		w.recorder.providerResponse();
		w.at(300);
		w.event("message_update", { message: w.assistant() });
		const details = only(w.frames);
		expect(w.frames[0].type).toBe(TURN_STAGES_EVENT);
		expect(details).toMatchObject({
			level: "warn",
			outcome: "late",
			call: 0,
			lastStage: "provider_response",
			providerRequestSent: true,
			providerRequests: 1,
			provider: "anthropic",
			model: "claude-opus-5-5",
			"at.handlers_start": 10,
			"at.handlers_end": 40_010,
		});
		expect(details.longestGap).toBe("handlers_start>handlers_end 40000ms");
		expect(details["at.first_output"]).toBe(40_010 + 5 + 20 + 600 + 300);
		expect(w.frames[0].message).toContain("First model output came 40.9 s after the prompt");
	});

	it("writes the line once as the output arrives, not again when the turn ends", () => {
		const w = world();
		w.toRequest(40_000);
		w.event("message_update", { message: w.assistant() });
		w.event("message_update", { message: w.assistant() });
		w.event("agent_end", { messages: [w.assistant({ stopReason: "error", errorMessage: "late" })] });
		expect(w.frames).toHaveLength(1);
	});

	it("records a provider that accepted the request and never answered, ended by stock's first-event timeout", () => {
		const w = world();
		w.toRequest();
		w.at(300_000);
		w.event("agent_end", {
			messages: [
				w.assistant({
					stopReason: "error",
					provider: "anthropic",
					model: "claude-opus-5-5",
					errorMessage: "Anthropic stream timed out\nwhile waiting for the first event",
				}),
			],
		});
		const details = only(w.frames);
		expect(details).toMatchObject({
			outcome: "error",
			lastStage: "stream_open",
			providerRequestSent: true,
			error: "Anthropic stream timed out while waiting for the first event",
		});
		expect(details.longestGap).toBe("stream_open>agent_end 300000ms");
		expect(details["at.agent_end"]).toBe(10 + 5 + 5 + 20 + 300_000);
		expect(details).not.toHaveProperty("at.provider_response");
		expect(details).not.toHaveProperty("at.first_output");
	});

	it("records a refused connection within seconds: no response, ended errored", () => {
		const w = world();
		w.toRequest();
		w.at(2_000);
		w.event("agent_end", { messages: [w.assistant({ stopReason: "error", errorMessage: "ECONNREFUSED" })] });
		const details = only(w.frames);
		expect(details).toMatchObject({ outcome: "error", lastStage: "stream_open", providerRequestSent: true });
		expect(details.waitedMs).toBe(10 + 5 + 5 + 20 + 2_000);
	});

	it("says no provider request was sent when the turn stalled before one", () => {
		const w = world();
		w.recorder.promptReceived("fix it", false);
		w.at(10);
		w.recorder.handlersStart();
		w.at(5);
		w.recorder.handlersEnd();
		w.at(360_000);
		w.event("agent_start");
		w.event("turn_start");
		w.at(15);
		w.event("agent_end", { messages: [w.assistant({ stopReason: "aborted" })] });
		const details = only(w.frames);
		expect(details).toMatchObject({ outcome: "aborted", providerRequestSent: false, providerRequests: 0 });
		expect(details.longestGap).toBe("handlers_end>agent_start 360000ms");
		expect(details.lastStage).toBe("turn_start");
	});

	it("names a stall before the first handler, between the prompt and stock's preparation", () => {
		const w = world();
		w.recorder.promptReceived("fix it", false);
		w.at(420_000);
		w.recorder.handlersStart();
		w.at(5);
		w.recorder.handlersEnd();
		w.event("agent_start");
		w.event("turn_start");
		w.event("agent_end", { messages: [w.assistant({ stopReason: "aborted" })] });
		expect(only(w.frames).longestGap).toBe("prompt>handlers_start 420000ms");
	});

	it("ignores provider hooks that came before the run started (side requests of a compaction or a judge)", () => {
		const w = world();
		w.recorder.promptReceived("fix it", false);
		w.recorder.handlersStart();
		w.recorder.providerRequest();
		w.recorder.providerResponse();
		w.recorder.handlersEnd();
		w.event("agent_start");
		w.event("turn_start");
		w.at(60_000);
		w.event("agent_end", { messages: [w.assistant({ stopReason: "aborted" })] });
		const details = only(w.frames);
		expect(details.providerRequestSent).toBe(false);
		expect(details).not.toHaveProperty("at.provider_request");
	});

	it("measures a call after a tool batch from its own turn_start", () => {
		const w = world();
		w.toRequest();
		w.event("message_update", { message: w.assistant() });
		w.at(5_000);
		w.event("turn_start");
		w.recorder.providerRequest();
		w.event("message_start", { message: w.assistant() });
		w.at(45_000);
		w.event("message_update", { message: w.assistant() });
		const details = only(w.frames);
		expect(details).toMatchObject({ outcome: "late", call: 1, waitedMs: 45_000, lastStage: "stream_open" });
		expect(details.longestGap).toBe("stream_open>first_output 45000ms");
		expect(w.frames[0].message).toContain("after the model call began");
	});

	it("a compaction inside the wait is named, with its end", () => {
		const w = world();
		w.recorder.promptReceived("fix it", false);
		w.at(10);
		w.event("auto_compaction_start");
		w.at(90_000);
		w.event("auto_compaction_end");
		w.recorder.handlersStart();
		w.recorder.handlersEnd();
		w.event("agent_start");
		w.event("turn_start");
		w.at(1);
		w.event("agent_end", { messages: [w.assistant({ stopReason: "aborted" })] });
		const details = only(w.frames);
		expect(details["at.compaction"]).toBe(10);
		expect(details["at.compaction_end"]).toBe(90_010);
		expect(details.longestGap).toBe("compaction>compaction_end 90000ms");
	});

	it("a compaction with no prompt in flight (idle compaction) starts nothing", () => {
		const w = world();
		w.event("auto_compaction_start");
		w.at(120_000);
		w.event("auto_compaction_end");
		expect(w.frames).toEqual([]);
	});

	it("counts OMPdesk's own slow spots", () => {
		const w = world();
		setActiveRecorder(w.recorder);
		try {
			w.recorder.promptReceived("fix it", false);
			w.recorder.handlersStart();
			noteSlowSpot("memoryRecallMs", 31_000.4);
			noteSlowSpot("sectionsMs", 2);
			noteSlowSpot("sectionsMs", 1);
			w.at(31_100);
			w.recorder.handlersEnd();
			w.event("agent_start");
			w.event("turn_start");
			w.event("agent_end", { messages: [w.assistant({ stopReason: "aborted" })] });
		} finally {
			setActiveRecorder(undefined);
		}
		expect(only(w.frames)).toMatchObject({ memoryRecallMs: 31_000, sectionsMs: 3 });
	});

	it("takes a steer, a follow-up or a slash command for no prompt: the run counts from its own first event", () => {
		const w = world();
		w.recorder.promptReceived("keep going", true);
		w.recorder.promptReceived("/dump all", false);
		w.at(500_000);
		w.recorder.handlersStart();
		w.recorder.handlersEnd();
		w.event("agent_start");
		w.event("turn_start");
		w.at(40_000);
		w.event("agent_end", { messages: [w.assistant({ stopReason: "aborted" })] });
		const [frame] = w.frames;
		expect(frame.details.waitedMs).toBe(40_000);
		expect(frame.message).toContain("no prompt seen");
	});

	it("forgets a prompt that started no run after ten minutes", () => {
		const w = world();
		w.recorder.promptReceived("hello", false);
		w.at(11 * 60_000);
		w.event("agent_start");
		w.event("turn_start");
		w.at(40_000);
		w.event("agent_end", { messages: [w.assistant({ stopReason: "error" })] });
		expect(only(w.frames).waitedMs).toBe(40_000);
	});

	it("starts clean after a run ends", () => {
		const w = world();
		w.toRequest();
		w.at(40_000);
		w.event("agent_end", { messages: [w.assistant({ stopReason: "aborted" })] });
		w.frames.length = 0;
		w.toRequest();
		w.at(100);
		w.event("message_update", { message: w.assistant() });
		w.event("agent_end", { messages: [w.assistant({ stopReason: "stop" })] });
		expect(w.frames).toEqual([]);
	});

	it("a run that ended normally or whose reply was cut with output records nothing", () => {
		const w = world();
		w.toRequest();
		w.at(100);
		w.event("message_update", { message: w.assistant() });
		w.at(500_000);
		w.event("agent_end", { messages: [w.assistant({ stopReason: "aborted" })] });
		expect(w.frames).toEqual([]);
	});

	it("stays inside the runtime log's detail limit with every key present, late or ended", () => {
		const lines: Array<Record<string, string | number | boolean>> = [];
		for (const ending of ["late", "agent_end"] as const) {
			const w = world();
			setActiveRecorder(w.recorder);
			try {
				w.recorder.promptReceived("fix it", false);
				w.at(1);
				w.event("auto_compaction_start");
				w.at(1);
				w.event("auto_compaction_end");
				w.recorder.handlersStart();
				noteSlowSpot("memoryRecallMs", 5);
				noteSlowSpot("sectionsMs", 1);
				w.at(1);
				w.recorder.handlersEnd();
				w.at(1);
				w.event("agent_start");
				w.event("turn_start");
				w.at(1);
				w.recorder.providerRequest();
				w.event("message_start", { message: w.assistant() });
				w.at(1);
				w.recorder.providerResponse();
				w.at(60_000);
				if (ending === "late") w.event("message_update", { message: w.assistant() });
				else
					w.event("agent_end", {
						messages: [w.assistant({ stopReason: "error", errorMessage: "x", provider: "p", model: "m" })],
					});
			} finally {
				setActiveRecorder(undefined);
			}
			lines.push(only(w.frames));
		}
		for (const details of lines) {
			expect(Object.keys(details).length).toBeLessThanOrEqual(TURN_STAGES_MAX_DETAILS);
			expect(details).toHaveProperty("memoryRecallMs");
			expect(details).toHaveProperty("sectionsMs");
		}
		expect(Object.keys(lines[0]).filter(key => key.startsWith("at."))).toHaveLength(10);
		expect(lines[1]).toHaveProperty("at.agent_end");
	});
});

describe("turnStagesReport", () => {
	it("is a turn-stages line with the frame's message and primitive details", () => {
		expect(
			turnStagesReport({
				type: TURN_STAGES_EVENT,
				message: "m",
				details: { level: "warn", "at.agent_end": 5, ok: true, nested: { a: 1 } },
			}),
		).toEqual({
			source: "turn-stages",
			message: "m",
			details: { level: "warn", "at.agent_end": 5, ok: true },
		});
	});

	it("ignores every other frame", () => {
		expect(turnStagesReport({ type: "agent_end" })).toBeUndefined();
		expect(turnStagesReport({ type: TURN_STAGES_EVENT })).toBeUndefined();
	});
});
