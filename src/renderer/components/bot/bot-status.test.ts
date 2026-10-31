import { describe, expect, it } from "vitest";
import { botState, nextWake, tabBotFacts } from "./bot-status";

describe("botState", () => {
	it("is asleep with no tab or an unspawned one, however it is flagged", () => {
		expect(botState(tabBotFacts(undefined))).toBe("asleep");
		expect(botState(tabBotFacts({ status: "asleep" }))).toBe("asleep");
		expect(botState(tabBotFacts({ status: "exited", awaitingInput: "input" }))).toBe("asleep");
	});

	it("puts its own prompt before its run, and a run before idle", () => {
		expect(botState(tabBotFacts({ status: "running", awaitingInput: "approval" }))).toBe("waiting");
		expect(botState(tabBotFacts({ status: "running" }))).toBe("working");
		expect(botState(tabBotFacts({ status: "ready", compacting: true }))).toBe("working");
		expect(botState(tabBotFacts({ status: "ready" }))).toBe("idle");
	});

	it("reads the row's facts for a bot another window or a paired device holds", () => {
		expect(botState({ open: true, asleep: false, waiting: false, running: true })).toBe("working");
		expect(botState({ open: false, asleep: false, waiting: false, running: true })).toBe("asleep");
	});
});

describe("nextWake", () => {
	it("is the earliest start, skipping paused and unreadable ones", () => {
		expect(
			nextWake([
				{ id: "a", prompt: "a", next: "2026-11-02T09:00:00.000Z" },
				{ id: "b", prompt: "b", next: null },
				{ id: "c", prompt: "c", next: "2026-11-01T06:30:00.000Z" },
				{ id: "d", prompt: "d", next: "not a date" },
			]),
		).toBe("2026-11-01T06:30:00.000Z");
	});

	it("is null when no wake has a start", () => {
		expect(nextWake([])).toBeNull();
		expect(nextWake([{ id: "a", prompt: "a", next: null }])).toBeNull();
	});
});
