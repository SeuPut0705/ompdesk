import { beforeEach, describe, expect, it } from "vitest";
import {
	AUTO_MODE_IDLE_MS,
	AUTO_MODE_TIMEOUT_MS,
	type AutoModeActive,
	autoModeFromPref,
} from "../../resources/gui-bridge/modes/auto-mode-contracts";
import {
	AUTO_MODE_INSTRUCTIONS,
	type AutoModeGuardInput,
	autoModeCriteria,
	autoModeSkip,
	goalObjective,
	MIN_CLASSIFIED_CHARS,
	modeFromAnswer,
	OBJECTIVE_MAX_CHARS,
	PREVIOUS_MAX_CHARS,
	PrefetchSlot,
	previousExchange,
} from "../../resources/gui-bridge/modes/auto-mode-core";
import {
	autoModeFlags,
	markPlanRejected,
	markSuppressed,
	resetAutoModeFlags,
	setAutoPlan,
} from "../../resources/gui-bridge/modes/auto-mode-state";

const idle: AutoModeActive = { plan: false, goal: false };

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

	it("never classifies in a busy session: a turn within ten minutes, open todos, running subagents or jobs", () => {
		const now = 1_000_000_000;
		const quiet = { now, openTodos: 0, runningJobs: 0 };
		expect(AUTO_MODE_IDLE_MS).toBe(600_000);
		expect(autoModeSkip(input({ work: { ...quiet, lastActivityAt: now - 60_000 } }))).toBe("busy");
		expect(autoModeSkip(input({ work: { ...quiet, lastActivityAt: now - AUTO_MODE_IDLE_MS + 1 } }))).toBe("busy");
		expect(autoModeSkip(input({ work: { ...quiet, openTodos: 2 } }))).toBe("busy");
		expect(autoModeSkip(input({ work: { ...quiet, runningJobs: 1 } }))).toBe("busy");
		// The first message of a session, or one after ten idle minutes, starts new work.
		expect(autoModeSkip(input({ work: quiet }))).toBeNull();
		expect(autoModeSkip(input({ work: { ...quiet, lastActivityAt: now - AUTO_MODE_IDLE_MS } }))).toBeNull();
		// A mode the user picked still wins first.
		expect(autoModeSkip(input({ work: quiet, active: { ...idle, goal: true } }))).toBe("mode_active");
	});

	it("hands the judge the previous exchange, clipped, so it can tell a follow-up from new work", () => {
		expect(previousExchange(undefined, undefined)).toBeUndefined();
		expect(previousExchange("move the store to zustand", "Done: the store uses zustand.")).toBe(
			"user: move the store to zustand\nassistant: Done: the store uses zustand.",
		);
		const long = previousExchange("x".repeat(PREVIOUS_MAX_CHARS + 50), undefined) ?? "";
		expect([...long].length).toBeLessThanOrEqual(PREVIOUS_MAX_CHARS + "user: ".length);
		expect(AUTO_MODE_INSTRUCTIONS).toContain("always none when the message continues");
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

	it("reads a goal choice without probabilities (a prompted chat judge) and ignores case and spaces", () => {
		expect(modeFromAnswer({ choice: " Goal " }, both)).toEqual({ mode: "goal" });
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

	it("needs a stated probability of at least 0.7 for plan, which takes over the whole next turn", () => {
		// Real judge answers (/tmp/jev-bench, 19 Oct 2026, 139 calls each on Jev and Sonnet over 44 prompts): neither
		// model ever chose plan for a none- or goal-labelled prompt; Jev's plan probabilities there peak at 0.04 and
		// Sonnet's at 0. A Korean plan request ("이제 별개로 원격 세션 삭제 기능 새로 추가해줘…") came back at 0.73,
		// which 0.75 dropped; a vaguer one ("빌드시간,최적화,릴리즈시간 전부 개선해…") at 0.57–0.64 stays none.
		expect(modeFromAnswer({ choice: "plan", probabilities: { plan: 0.73, none: 0.27, goal: 0 } }, both)).toEqual({
			mode: "plan",
		});
		for (const answer of [
			{ choice: "plan", probabilities: { plan: 0.64, none: 0.22, goal: 0.14 } },
			{ choice: "plan", probabilities: { plan: 0.69 } },
			{ choice: "plan" },
		]) {
			expect(modeFromAnswer(answer, both)).toEqual({ mode: "none", reason: "ambiguous" });
		}
		expect(modeFromAnswer({ choice: "none", probabilities: { plan: 0.04, none: 0.92, goal: 0.04 } }, both)).toEqual({
			mode: "none",
			reason: "classified_none",
		});
		expect(modeFromAnswer({ choice: "plan", probabilities: { plan: 0.7 } }, both)).toEqual({ mode: "plan" });
		expect(modeFromAnswer({ choice: "goal", probabilities: { goal: 0.62 } }, both)).toEqual({ mode: "goal" });
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
		expect(autoModeFlags("a")).toEqual({ planRejected: false, suppressed: false, autoPlan: false });
		markPlanRejected("a");
		expect(autoModeFlags("a")).toEqual({ planRejected: true, suppressed: false, autoPlan: false });
		expect(autoModeFlags("b")).toEqual({ planRejected: false, suppressed: false, autoPlan: false });
		markSuppressed("b");
		expect(autoModeFlags("b").suppressed).toBe(true);
	});

	it("knows a plan mode entered for one request until it ends or the user takes it over", () => {
		setAutoPlan("a", true);
		expect(autoModeFlags("a").autoPlan).toBe(true);
		setAutoPlan("a", false);
		expect(autoModeFlags("a").autoPlan).toBe(false);
		setAutoPlan("never-seen", false);
		expect(autoModeFlags("never-seen")).toEqual({ planRejected: false, suppressed: false, autoPlan: false });
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

describe("PrefetchSlot (the question asked while typing)", () => {
	function deferred() {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		return { promise, resolve, reject };
	}

	it("joins a question about the same text and withdraws one about an older text", async () => {
		const slot = new PrefetchSlot<string>();
		const first = deferred();
		const signals: AbortSignal[] = [];
		const asked = (answer: Promise<string>) => (signal: AbortSignal) => {
			signals.push(signal);
			return answer;
		};
		const a = slot.run("fix the tests", asked(first.promise));
		expect(slot.run("fix the tests", asked(Promise.resolve("again")))).toBe(a);
		expect(signals).toHaveLength(1);
		const second = deferred();
		void slot.run("fix the tests and the build", asked(second.promise));
		expect(signals[0]?.aborted).toBe(true);
		expect(signals[1]?.aborted).toBe(false);
		first.reject(new Error("aborted"));
		second.resolve("none");
	});

	it("lets the decision at Enter wait for a question about its own text only, and never past its deadline", async () => {
		const slot = new PrefetchSlot<string>();
		const pending = deferred();
		void slot.run("migrate everything", () => pending.promise);
		let settled = false;
		const waiting = slot.settle("migrate everything").then(() => {
			settled = true;
		});
		await slot.settle("something else");
		await Promise.resolve();
		expect(settled).toBe(false);
		pending.resolve("plan");
		await waiting;
		expect(settled).toBe(true);

		const stuck = deferred();
		void slot.run("a question that never answers", () => stuck.promise);
		const deadline = new AbortController();
		const wait = slot.settle("a question that never answers", deadline.signal);
		deadline.abort();
		await expect(wait).resolves.toBeUndefined();
	});

	it("a failed question is settled too: the decision then asks for itself", async () => {
		const slot = new PrefetchSlot<string>();
		const failing = slot.run("x", () => Promise.reject(new Error("offline")));
		await expect(failing).rejects.toThrow("offline");
		await expect(slot.settle("x")).resolves.toBeUndefined();
	});
});
