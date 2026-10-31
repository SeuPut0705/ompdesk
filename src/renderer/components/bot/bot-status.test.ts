import { describe, expect, it } from "vitest";
import type { BotRoutine } from "../../../shared/bot-desk";
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

const routine = (id: string, next: string | null): BotRoutine => ({
	id,
	name: id,
	prompt: id,
	frequency: { kind: "interval", minutes: 30 },
	enabled: next !== null,
	next,
	runs: [],
});

describe("nextWake", () => {
	it("is the earliest start, skipping paused and unreadable ones", () => {
		expect(
			nextWake([
				routine("a", "2026-11-02T09:00:00.000Z"),
				routine("b", null),
				routine("c", "2026-11-01T06:30:00.000Z"),
				routine("d", "not a date"),
			]),
		).toBe("2026-11-01T06:30:00.000Z");
	});

	it("is null when no routine has a start", () => {
		expect(nextWake([])).toBeNull();
		expect(nextWake([routine("a", null)])).toBeNull();
	});
});
