import { describe, expect, it } from "vitest";
import { type SendSlotFacts, sendSlot } from "./send-slot";

const idle: SendSlotFacts = {
	recording: false,
	editingQueued: false,
	stoppable: false,
	hasDraft: false,
	micOffered: false,
};

describe("sendSlot", () => {
	it.each([
		["idle, empty", {}, "send", false],
		["typing", { hasDraft: true }, "send", false],
		["a turn runs, empty draft", { stoppable: true }, "stop", false],
		["a turn runs with a draft", { stoppable: true, hasDraft: true }, "send", true],
		["phone dictation, empty", { micOffered: true }, "mic", false],
		["phone dictation while a turn runs, empty: Stop wins", { micOffered: true, stoppable: true }, "stop", false],
		["phone dictation, typing", { micOffered: true, hasDraft: true }, "send", false],
		["editing a queued message during a turn", { editingQueued: true, stoppable: true }, "save", true],
		["recording a take during a turn", { recording: true, stoppable: true }, "dictation", true],
	] as const)("%s → %s", (_name, facts, state, stopHint) => {
		expect(sendSlot({ ...idle, ...facts })).toEqual({ state, stopHint });
	});
});
