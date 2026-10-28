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
	/** A typed prompt as stock delivers it: the `input` hook, then the session's `prompt` call (whose setup it returns). */
	const prompt = (text: string) => {
		recorder.promptReceived(text, false);
		return recorder.promptStarted(text, false);
	};
	/** One prompt up to the model call's request being built and its stream opened. */
	const toRequest = (handlersMs = 5, prepareMs = 5) => {
		const setup = prompt("fix it");
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
		return setup;
	};
	return { frames, recorder, at, assistant, event, prompt, toRequest };
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
		w.prompt("fix it");
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
		w.prompt("fix it");
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
		w.prompt("fix it");
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
		w.prompt("fix it");
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
			w.prompt("fix it");
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

	it("takes the input hook's time only for the prompt call of the same text, at most ten minutes later", () => {
		const runFrom = (inputText: string, promptText: string, gapMs: number) => {
			const w = world();
			w.recorder.promptReceived(inputText, false);
			w.at(gapMs);
			w.recorder.promptStarted(promptText, false);
			w.event("agent_start");
			w.event("turn_start");
			w.at(40_000);
			w.event("agent_end", { messages: [w.assistant({ stopReason: "error" })] });
			return only(w.frames).waitedMs;
		};
		expect(runFrom("hello", "hello", 20)).toBe(40_020);
		// another extension's input hook rewrote it: the prompt call's own time
		expect(runFrom("hello", "hello, rewritten", 20)).toBe(40_000);
		expect(runFrom("hello", "hello", 11 * 60_000)).toBe(40_000);
	});

	it("gives a run outside any prompt call (a continue, a retry) no prompt's time, even with an input hook seen", () => {
		const w = world();
		w.recorder.promptReceived("handled locally by another extension", false);
		w.at(60_000);
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
				w.prompt("fix it");
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

describe("TurnStageRecorder: a prompt whose setup ended before its run", () => {
	it("Stop during setup then a normal turn: no frame (the stale run's time and handlers are not carried over)", () => {
		const w = world();
		w.recorder.promptReceived("first", false);
		w.at(10);
		w.recorder.handlersStart();
		w.at(5);
		w.recorder.handlersEnd();
		// Stop while stock's setup (auto thinking, pre-prompt compaction) still runs: no agent event at all.
		w.at(120_000);
		w.recorder.promptReceived("second", false);
		w.at(10);
		w.recorder.handlersStart();
		w.at(5);
		w.recorder.handlersEnd();
		w.event("agent_start");
		w.event("turn_start");
		w.recorder.providerRequest();
		w.event("message_start", { message: w.assistant() });
		w.at(800);
		w.event("message_update", { message: w.assistant() });
		w.event("agent_end", { messages: [w.assistant({ stopReason: "stop" })] });
		expect(w.frames).toEqual([]);
	});

	it("rejected prompt then queued run: the run counts from its own first event, not the rejected prompt", () => {
		const w = world();
		// Refused before any handler (usage preflight, cost cap): no agent event.
		w.recorder.promptReceived("refused", false);
		w.at(5 * 60_000);
		// A queued follow-up starts a run on its own.
		w.recorder.handlersStart();
		w.recorder.handlersEnd();
		w.event("agent_start");
		w.event("turn_start");
		w.recorder.providerRequest();
		w.at(40_000);
		w.event("agent_end", { messages: [w.assistant({ stopReason: "aborted" })] });
		const details = only(w.frames);
		expect(details.waitedMs).toBe(40_000);
		expect(w.frames[0].message).toContain("no prompt seen");
	});

	it("Stop during a long setup writes one cancelled line naming where it stood", () => {
		const w = world();
		const setup = w.prompt("fix it");
		w.at(10);
		w.recorder.handlersStart();
		w.at(5);
		w.recorder.handlersEnd();
		w.at(45_000);
		w.recorder.promptSettled(setup);
		const details = only(w.frames);
		expect(details).toMatchObject({
			outcome: "cancelled",
			lastStage: "handlers_end",
			longestGap: "handlers_end>setup_end 45000ms",
			providerRequestSent: false,
			waitedMs: 45_015,
			"at.handlers_start": 10,
			"at.setup_end": 45_015,
		});
		expect(details).not.toHaveProperty("at.agent_start");
		expect(w.frames[0].message).toContain("Prompt setup ended after 45.0 s without starting the model run");
	});

	it("a stall before any handler (preflight, sign-in refresh) then Stop names the prompt itself", () => {
		const w = world();
		const setup = w.prompt("fix it");
		w.at(360_000);
		w.recorder.promptSettled(setup);
		expect(only(w.frames)).toMatchObject({
			outcome: "cancelled",
			lastStage: "prompt",
			longestGap: "prompt>setup_end 360000ms",
		});
	});

	it("a prompt call that threw before its run is an error line with the message", () => {
		const w = world();
		const setup = w.prompt("fix it");
		w.at(31_000);
		w.recorder.promptSettled(setup, new Error("No API key found for anthropic.\n\nUse /login"));
		expect(only(w.frames)).toMatchObject({ outcome: "error", error: "No API key found for anthropic. Use /login" });
	});

	it("a short cancelled setup, a slash command that ran locally, and a prompt that ran write nothing at settle", () => {
		const w = world();
		const short = w.prompt("fix it");
		w.recorder.handlersStart();
		w.at(2_000);
		w.recorder.promptSettled(short);
		const command = w.recorder.promptStarted("/dump all", false);
		w.at(90_000);
		w.recorder.promptSettled(command);
		const ran = w.toRequest();
		w.at(100);
		w.event("message_update", { message: w.assistant() });
		w.event("agent_end", { messages: [w.assistant({ stopReason: "stop" })] });
		w.at(60_000);
		w.recorder.promptSettled(ran);
		expect(w.frames).toEqual([]);
	});

	it("a prompt call made while the session streams (a steer, a follow-up) tracks nothing and leaves the run alone", () => {
		const w = world();
		w.toRequest();
		expect(w.recorder.promptStarted("and also this", true)).toBeUndefined();
		w.recorder.promptSettled(undefined);
		w.at(45_000);
		w.event("message_update", { message: w.assistant() });
		expect(only(w.frames)).toMatchObject({ outcome: "late", waitedMs: 45_040 });
	});

	it("handlers run again by the same prompt call (stock's tool-set retry) keep the prompt's time and first start", () => {
		const w = world();
		w.prompt("fix it");
		w.at(10);
		w.recorder.handlersStart();
		w.at(20_000);
		w.recorder.handlersEnd();
		w.recorder.handlersStart();
		w.at(20_000);
		w.recorder.handlersEnd();
		w.event("agent_start");
		w.event("turn_start");
		w.event("message_update", { message: w.assistant() });
		expect(only(w.frames)).toMatchObject({ "at.handlers_start": 10, "at.handlers_end": 40_010, waitedMs: 40_010 });
	});

	it("a queued message's setup that went no further leaves nothing to the next run's handlers", () => {
		const w = world();
		w.recorder.handlersStart();
		w.at(5);
		w.recorder.handlersEnd();
		w.at(120_000);
		w.recorder.handlersStart();
		w.recorder.handlersEnd();
		w.event("agent_start");
		w.event("turn_start");
		w.at(100);
		w.event("message_update", { message: w.assistant() });
		expect(w.frames).toEqual([]);
	});

	it("a refused prompt call, then a queued run: nothing at the refusal, the run from its own first event", () => {
		const w = world();
		const refused = w.prompt("over the cost cap");
		w.at(50);
		w.recorder.promptSettled(refused);
		w.at(5 * 60_000);
		w.recorder.handlersStart();
		w.recorder.handlersEnd();
		w.event("agent_start");
		w.event("turn_start");
		w.at(40_000);
		w.event("agent_end", { messages: [w.assistant({ stopReason: "aborted" })] });
		expect(only(w.frames).waitedMs).toBe(40_000);
	});

	it("puts what says where the time went before the optional keys, so the log's key limit cuts only those", () => {
		const w = world();
		setActiveRecorder(w.recorder);
		try {
			w.prompt("fix it");
			w.event("auto_compaction_start");
			w.at(1);
			w.event("auto_compaction_end");
			w.recorder.handlersStart();
			noteSlowSpot("memoryRecallMs", 5);
			noteSlowSpot("sectionsMs", 1);
			w.at(1);
			w.recorder.handlersEnd();
			w.event("agent_start");
			w.event("turn_start");
			w.recorder.providerRequest();
			w.event("message_start", { message: w.assistant() });
			w.recorder.providerResponse();
			w.at(60_000);
			w.event("agent_end", {
				messages: [w.assistant({ stopReason: "error", errorMessage: "x", provider: "p", model: "m" })],
			});
		} finally {
			setActiveRecorder(undefined);
		}
		const keys = Object.keys(only(w.frames));
		const lastCore = Math.max(keys.indexOf("lastStage"), ...keys.flatMap((k, i) => (k.startsWith("at.") ? [i] : [])));
		const firstOptional = Math.min(
			...["error", "provider", "model", "memoryRecallMs", "sectionsMs"].map(key => keys.indexOf(key)),
		);
		expect(keys).toContain("at.agent_end");
		expect(lastCore).toBeLessThan(firstOptional);
		expect(keys.length).toBeLessThanOrEqual(TURN_STAGES_MAX_DETAILS);
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
