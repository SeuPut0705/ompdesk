import { beforeEach, describe, expect, it } from "vitest";
import {
	AUTO_MODE_TIMEOUT_MS,
	type AutoModeActive,
	autoModeFromPref,
} from "../../resources/gui-bridge/auto-mode-contracts";
import {
	type AutoModeGuardInput,
	autoModeCriteria,
	autoModeSkip,
	goalObjective,
	MIN_CLASSIFIED_CHARS,
	modeFromAnswer,
	OBJECTIVE_MAX_CHARS,
} from "../../resources/gui-bridge/auto-mode-core";
import {
	autoModeFlags,
	markPlanRejected,
	markSuppressed,
	resetAutoModeFlags,
} from "../../resources/gui-bridge/auto-mode-state";

const idle: AutoModeActive = { plan: false, goal: false, loop: false, vibe: false, ratchet: false };

function input(over: Partial<AutoModeGuardInput> = {}): AutoModeGuardInput {
	return {
		text: "refactor the whole settings module across all files",
		enabled: true,
		streaming: false,
		active: idle,
		suppressed: false,
		...over,
	};
}

describe("autoModeSkip (guards)", () => {
	it("lets a plain prompt through", () => {
		expect(autoModeSkip(input())).toBeNull();
	});

	it("is off with the pref off, whatever else holds", () => {
		expect(autoModeSkip(input({ enabled: false }))).toBe("off");
	});

	it("never classifies mid-run (steer and follow-up messages)", () => {
		expect(autoModeSkip(input({ streaming: true }))).toBe("streaming");
	});

	it("never classifies slash commands or ! bash", () => {
		expect(autoModeSkip(input({ text: "/compact" }))).toBe("slash");
		expect(autoModeSkip(input({ text: "  /plan something big" }))).toBe("slash");
		expect(autoModeSkip(input({ text: "!ls -la /tmp" }))).toBe("bash");
	});

	it("never overrides a mode the user picked", () => {
		for (const mode of Object.keys(idle) as Array<keyof AutoModeActive>) {
			expect(autoModeSkip(input({ active: { ...idle, [mode]: true } }))).toBe("mode_active");
		}
	});

	it("stays out after the user undid a decision in this session", () => {
		expect(autoModeSkip(input({ suppressed: true }))).toBe("suppressed");
	});

	it("does not spend a model request on chat-length messages or empty text", () => {
		expect(autoModeSkip(input({ text: "   " }))).toBe("empty");
		expect(autoModeSkip(input({ text: "ok thanks" }))).toBe("short");
		expect(autoModeSkip(input({ text: "x".repeat(MIN_CLASSIFIED_CHARS) }))).toBeNull();
		// Counted in characters, not UTF-16 units: eleven Hangul syllables are still short.
		expect(autoModeSkip(input({ text: "가".repeat(MIN_CLASSIFIED_CHARS - 1) }))).toBe("short");
	});
});

describe("modeFromAnswer (classifier output parsing)", () => {
	const both = { plan: true, goal: true };

	it("maps a confident plan or goal choice", () => {
		expect(modeFromAnswer({ choice: "plan", probabilities: { plan: 0.9, goal: 0.05, none: 0.05 } }, both)).toEqual({
			mode: "plan",
		});
		expect(modeFromAnswer({ choice: "goal", probabilities: { goal: 0.8 } }, both)).toEqual({ mode: "goal" });
	});

	it("reads a choice without probabilities (a prompted chat judge) and ignores case and spaces", () => {
		expect(modeFromAnswer({ choice: " Plan " }, both)).toEqual({ mode: "plan" });
	});

	it("is none for none, for unknown or mis-typed output, and for nothing", () => {
		expect(modeFromAnswer({ choice: "none" }, both)).toEqual({ mode: "none", reason: "classified_none" });
		expect(modeFromAnswer({ choice: "loop" }, both)).toEqual({ mode: "none", reason: "ambiguous" });
		expect(modeFromAnswer({ choice: "vibe" }, both)).toEqual({ mode: "none", reason: "ambiguous" });
		expect(modeFromAnswer({ choice: 3 }, both)).toEqual({ mode: "none", reason: "ambiguous" });
		expect(modeFromAnswer({}, both)).toEqual({ mode: "none", reason: "ambiguous" });
		expect(modeFromAnswer(null, both)).toEqual({ mode: "none", reason: "ambiguous" });
	});

	it("treats a low-probability answer as ambiguous", () => {
		expect(modeFromAnswer({ choice: "plan", probabilities: { plan: 0.45, none: 0.4, goal: 0.15 } }, both)).toEqual({
			mode: "none",
			reason: "ambiguous",
		});
	});

	it("never returns a mode the session may not enter", () => {
		expect(modeFromAnswer({ choice: "plan" }, { plan: false, goal: true })).toEqual({
			mode: "none",
			reason: "plan_rejected",
		});
		expect(modeFromAnswer({ choice: "goal" }, { plan: true, goal: false })).toEqual({
			mode: "none",
			reason: "unavailable",
		});
	});

	it("offers plan only while the session may enter it", () => {
		expect(Object.keys(autoModeCriteria(true)).sort()).toEqual(["goal", "none", "plan"]);
		expect(Object.keys(autoModeCriteria(false)).sort()).toEqual(["goal", "none"]);
	});
});

describe("goalObjective", () => {
	it("folds whitespace and keeps a short prompt whole", () => {
		expect(goalObjective("  keep going\n\nuntil   the tests pass ")).toBe("keep going until the tests pass");
	});

	it("cuts a long prompt at the limit with an ellipsis", () => {
		const objective = goalObjective(`fix it ${"and more ".repeat(100)}`);
		expect([...objective].length).toBeLessThanOrEqual(OBJECTIVE_MAX_CHARS);
		expect(objective.endsWith("…")).toBe(true);
	});
});

describe("session memory", () => {
	beforeEach(resetAutoModeFlags);

	it("starts clean and remembers per session", () => {
		expect(autoModeFlags("a")).toEqual({ planRejected: false, suppressed: false });
		markPlanRejected("a");
		expect(autoModeFlags("a")).toEqual({ planRejected: true, suppressed: false });
		expect(autoModeFlags("b")).toEqual({ planRejected: false, suppressed: false });
		markSuppressed("b");
		expect(autoModeFlags("b").suppressed).toBe(true);
	});
});

describe("contracts", () => {
	it("is on unless the pref is exactly false, and never waits long", () => {
		expect(autoModeFromPref(undefined)).toBe(true);
		expect(autoModeFromPref("no")).toBe(true);
		expect(autoModeFromPref(false)).toBe(false);
		expect(AUTO_MODE_TIMEOUT_MS).toBeLessThanOrEqual(2000);
	});
});
