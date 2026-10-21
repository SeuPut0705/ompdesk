import { describe, expect, it } from "vitest";
import {
	AUTOPILOT_AREAS,
	AUTOPILOT_BACKLOG_ENTRY,
	AUTOPILOT_CYCLE_ENTRY,
	AUTOPILOT_NOTE_ENTRY,
	AUTOPILOT_OBJECTIVE,
	AUTOPILOT_SHIP_REQUEST_ENTRY,
	AUTOPILOT_STATE_ENTRY,
	type AutopilotCycleRecord,
	type AutopilotLimits,
	type AutopilotSettings,
	type AutopilotShipPolicy,
	type AutopilotShipRequest,
	DEFAULT_AUTOPILOT_SETTINGS,
	NO_LIMITS,
	shipPolicyForPreset,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import {
	backlogItems,
	budgetLeft,
	buildBegin,
	buildStatus,
	classifyStall,
	customEntries,
	cycleRecords,
	decideAfterCycle,
	dueForRelease,
	finalizeCycle,
	greenCyclesSinceRelease,
	hourlyRates,
	inFlightAfter,
	initialStateEntry,
	isDuplicateTitle,
	isRedCycle,
	type JournalEntry,
	lastRunRelease,
	lastStateEntry,
	limitReached,
	mergeSettings,
	nextStateEntry,
	normalizeTitle,
	openFollowups,
	parseEndReport,
	pendingNotes,
	pendingShipRequests,
	proposeReleaseCheck,
	realUserText,
	redStreak,
	rotation,
	shipLevelOf,
	totalsOf,
	usageDelta,
	userMessagesSinceLastCycle,
	verifyShipQuote,
} from "../../resources/gui-bridge/modes/autopilot-core";
import {
	AUTOPILOT_CHILD_SECTION,
	AUTOPILOT_STOPPING_STEER,
	autopilotSection,
} from "../../resources/gui-bridge/modes/autopilot-prompt";

let counter = 0;
function rec(over: Partial<AutopilotCycleRecord> = {}): AutopilotCycleRecord {
	counter++;
	return {
		n: over.n ?? counter,
		area: "tests",
		title: `item ${counter}`,
		summary: "s",
		verify: "green",
		commit: `c${counter}`,
		followups: [],
		children: [],
		startedAt: 1_000 * counter,
		durationMs: 60_000,
		tokens: 1000,
		usd: 0.1,
		compactions: 0,
		...over,
	};
}

function seq(...overs: Array<Partial<AutopilotCycleRecord>>): AutopilotCycleRecord[] {
	return overs.map((over, i) => rec({ n: i + 1, title: `t${i + 1}`, ...over }));
}

const RED = { verify: "red", commit: undefined } as const;
const GREEN = { verify: "green" } as const;
const SKIP = { verify: "skipped", commit: undefined } as const;
const NOREP = { area: "unreported", verify: "unreported", commit: undefined, title: "(no report)" } as const;

describe("normalizeTitle / duplicates", () => {
	it("ignores case, punctuation and spacing", () => {
		expect(normalizeTitle("  Fix: Tab-close  race! ")).toBe("fix tab close race");
		expect(normalizeTitle("탭 닫기 경쟁 수정")).toBe("탭 닫기 경쟁 수정");
		expect(normalizeTitle("***")).toBe("");
	});
	it("flags a repeat inside the last 30 cycles only", () => {
		const records = Array.from({ length: 31 }, (_, i) => rec({ n: i + 1, title: i === 0 ? "Old item" : `x${i}` }));
		expect(isDuplicateTitle(records, "old item")).toBe(false); // cycle 1 fell out of the window of 30
		expect(isDuplicateTitle(records, "X5")).toBe(true);
		expect(isDuplicateTitle(records, " x5 ")).toBe(true);
		expect(isDuplicateTitle(records, "new")).toBe(false);
		expect(isDuplicateTitle(records, "")).toBe(false);
	});
	it("ignores unreported cycles' placeholder title", () => {
		expect(isDuplicateTitle(seq(NOREP), "(no report)")).toBe(false);
	});
});

describe("rotation", () => {
	it("starts at the first area and prefers never-done areas in order", () => {
		expect(rotation([], []).suggested).toBe("design");
		const r = rotation(seq({ area: "design" }), []);
		expect(r.suggested).toBe("performance");
		expect(r.counts.design).toBe(1);
		expect(r.lastCycleOfArea.design).toBe(1);
		expect(r.lastCycleOfArea.docs).toBeNull();
	});
	it("picks the area that waited longest once all were done", () => {
		const records = seq(...AUTOPILOT_AREAS.map(area => ({ area })), { area: "design" }, { area: "performance" });
		// design: 8, performance: 9, features last at 3 -> the oldest is features.
		expect(rotation(records, []).suggested).toBe("features");
	});
	it("stays inside the focus, empty focus = all", () => {
		const records = seq({ area: "tests" }, { area: "docs" });
		expect(rotation(records, ["tests", "docs"]).suggested).toBe("tests");
		expect(rotation(records, ["bugs", "docs"]).suggested).toBe("bugs");
		expect(rotation(records, ["docs"]).suggested).toBe("docs");
	});
	it("does not count user/release/unreported cycles", () => {
		const r = rotation(seq({ area: "user" }, { area: "release" }, NOREP), []);
		expect(Object.values(r.counts).every(n => n === 0)).toBe(true);
	});
});

describe("red / no-commit / no-report / churn", () => {
	it("isRedCycle", () => {
		expect(isRedCycle({ verify: "red" })).toBe(true);
		expect(isRedCycle({ verify: "green", commit: "a" })).toBe(false);
		expect(isRedCycle({ verify: "skipped", commit: "a" })).toBe(true);
		expect(isRedCycle({ verify: "unreported", commit: "a" })).toBe(true);
		expect(isRedCycle({ verify: "skipped" })).toBe(false);
	});
	const RED_TABLE: Array<[string, Array<Partial<AutopilotCycleRecord>>, number]> = [
		["empty", [], 0],
		["all green", [GREEN, GREEN], 0],
		["one red at the end", [GREEN, RED], 1],
		["three reds", [RED, RED, RED], 3],
		["a green resets", [RED, RED, GREEN, RED], 1],
		["skipped without commit is neutral", [RED, SKIP, RED], 2],
		["unreported without commit is neutral", [RED, NOREP, RED], 2],
		["green after neutral ends it", [RED, GREEN, SKIP], 0],
		["committed-but-not-green is red", [{ verify: "skipped", commit: "x" }], 1],
	];
	for (const [name, overs, expected] of RED_TABLE) {
		it(`redStreak: ${name}`, () => expect(redStreak(seq(...overs))).toBe(expected));
	}
});

describe("stall classification", () => {
	const base = { lastTurnErrored: false, planMode: false, todosAllBlocked: false };
	const TABLE: Array<[string, Partial<typeof base>, unknown]> = [
		[
			"plan mode is nudged out of, whatever else is true",
			{ planMode: true, lastTurnErrored: true, todosAllBlocked: true },
			{ kind: "nudge", reason: "plan" },
		],
		["an errored turn takes the error path", { lastTurnErrored: true, todosAllBlocked: true }, { kind: "error" }],
		["blocked todos are nudged", { todosAllBlocked: true }, { kind: "nudge", reason: "blocked" }],
		["a quiet turn is nudged", {}, { kind: "nudge", reason: "no_progress" }],
	];
	for (const [name, facts, expected] of TABLE) {
		it(name, () => expect(classifyStall({ ...base, ...facts })).toEqual(expected));
	}
});

describe("ceilings", () => {
	const used = { tokens: 1_000, usd: 2 };
	it("all off never stops", () => {
		expect(limitReached(NO_LIMITS, { tokens: 1e12, usd: 1e6 }, 1e12, 1e6)).toBeUndefined();
		expect(budgetLeft(NO_LIMITS, used, 0, 0)).toBeUndefined();
	});
	const TABLE: Array<[string, Partial<AutopilotLimits>, number, number, unknown]> = [
		["tokens reached", { tokens: 1_000 }, 0, 0, "budget"],
		["tokens not reached", { tokens: 1_001 }, 0, 0, undefined],
		["minutes reached", { minutes: 1 }, 60_000, 0, "time"],
		["minutes not reached", { minutes: 1 }, 59_999, 0, undefined],
		["cycles reached", { cycles: 3 }, 0, 3, "cycles"],
		["cycles not reached", { cycles: 3 }, 0, 2, undefined],
		["usd reached", { usd: 2 }, 0, 0, "cost"],
		["usd not reached", { usd: 2.01 }, 0, 0, undefined],
	];
	for (const [name, limits, ms, cycles, expected] of TABLE) {
		it(name, () => expect(limitReached({ ...NO_LIMITS, ...limits }, used, ms, cycles)).toBe(expected));
	}
	it("budgetLeft reports only the ceilings that are on", () => {
		expect(budgetLeft({ tokens: 5_000, minutes: null, cycles: 10, usd: null }, used, 0, 4)).toEqual({
			tokens: 4_000,
			cycles: 6,
		});
		expect(budgetLeft({ tokens: 500, minutes: 2, cycles: null, usd: 1 }, used, 90_000, 0)).toEqual({
			tokens: 0,
			minutes: 1,
			usd: 0,
		});
	});
});

describe("decideAfterCycle", () => {
	const facts = (records: AutopilotCycleRecord[], over: Partial<Parameters<typeof decideAfterCycle>[0]> = {}) => ({
		records,
		settings: DEFAULT_AUTOPILOT_SETTINGS,
		used: totalsOf(records),
		activeMs: 0,
		...over,
	});
	it("nothing for a healthy cycle", () => {
		expect(decideAfterCycle(facts(seq(GREEN, GREEN)))).toBeUndefined();
		expect(decideAfterCycle(facts([]))).toBeUndefined();
	});
	it("a red streak, a missing report, compaction churn, a failed release and cycles without a commit never stop the run", () => {
		const never: Array<AutopilotCycleRecord[]> = [
			seq(RED, RED, RED, RED, RED, RED),
			seq(NOREP, NOREP, NOREP, NOREP),
			seq({ compactions: 3 }, { compactions: 3 }, { compactions: 3 }),
			seq({ area: "release", verify: "red" }),
			seq({ ship: { kind: "release", version: "1.0.0" }, verify: "red" }),
			seq(SKIP, SKIP, SKIP, SKIP, SKIP, SKIP, SKIP, SKIP),
		];
		for (const records of never) expect(decideAfterCycle(facts(records))).toBeUndefined();
	});
	it("only a ceiling the user set stops it, whatever the cycles were", () => {
		const settings: AutopilotSettings = { ...DEFAULT_AUTOPILOT_SETTINGS, limits: { ...NO_LIMITS, cycles: 2 } };
		expect(decideAfterCycle(facts(seq(GREEN, GREEN), { settings }))?.reason).toBe("cycles");
		expect(decideAfterCycle(facts(seq(RED, RED, RED), { settings }))?.reason).toBe("cycles");
		expect(decideAfterCycle(facts(seq(RED, RED, RED, RED, RED, RED)))).toBeUndefined();
	});
	it("the token budget counts each cycle's record as amended with its children's usage", () => {
		const settings: AutopilotSettings = { ...DEFAULT_AUTOPILOT_SETTINGS, limits: { ...NO_LIMITS, tokens: 2_500 } };
		// Parent 1 000 + child 600 folded into cycle 1, then 1 000 in cycle 2: 2 600 reaches the 2 500 ceiling...
		expect(decideAfterCycle(facts(seq({ tokens: 1_600 }, { tokens: 1_000 }), { settings }))?.reason).toBe("budget");
		// ...which the parents alone (2 000) would not.
		expect(decideAfterCycle(facts(seq({ tokens: 1_000 }, { tokens: 1_000 }), { settings }))).toBeUndefined();
	});
});

describe("releases", () => {
	const policy = (over: Partial<AutopilotShipPolicy["autoRelease"]> = {}): AutopilotShipPolicy => ({
		...shipPolicyForPreset("release"),
		autoRelease: { on: true, cadence: { kind: "every", n: 3 }, ...over },
	});
	const facts = (records: AutopilotCycleRecord[], over = {}) => ({
		policy: policy(),
		records,
		hasProcedure: true,
		releaseInFlight: false,
		proposed: false,
		...over,
	});
	it("counts green committed cycles since the last green release", () => {
		expect(greenCyclesSinceRelease(seq(GREEN, GREEN, GREEN))).toBe(3);
		expect(greenCyclesSinceRelease(seq(GREEN, { area: "release", verify: "green" }, GREEN))).toBe(1);
		expect(greenCyclesSinceRelease(seq(GREEN, { area: "release", verify: "red" }, GREEN))).toBe(2);
		expect(greenCyclesSinceRelease(seq(GREEN, { verify: "green", commit: undefined }))).toBe(1);
		expect(greenCyclesSinceRelease(seq(GREEN, { reverted: true }))).toBe(1);
	});
	it("every-N cadence", () => {
		expect(dueForRelease(facts(seq(GREEN, GREEN)))).toBe(false);
		expect(dueForRelease(facts(seq(GREEN, GREEN, GREEN)))).toBe(true);
		expect(dueForRelease(facts(seq(GREEN, GREEN, GREEN, { area: "release", verify: "green" })))).toBe(false);
	});
	it("never due when off, without a procedure, during a release, after red, or when the last cycle is not green", () => {
		const three = seq(GREEN, GREEN, GREEN);
		expect(dueForRelease(facts(three, { policy: policy({ on: false }) }))).toBe(false);
		expect(dueForRelease(facts(three, { hasProcedure: false }))).toBe(false);
		expect(dueForRelease(facts(three, { releaseInFlight: true }))).toBe(false);
		expect(dueForRelease(facts(seq(GREEN, GREEN, GREEN, RED)))).toBe(false);
		expect(dueForRelease(facts(seq(GREEN, GREEN, GREEN, SKIP)))).toBe(false);
		expect(dueForRelease(facts([]))).toBe(false);
	});
	it("agent cadence needs an accepted proposal and one green cycle", () => {
		const agent = policy({ cadence: { kind: "agent" } });
		expect(dueForRelease(facts(seq(GREEN), { policy: agent }))).toBe(false);
		expect(dueForRelease(facts(seq(GREEN), { policy: agent, proposed: true }))).toBe(true);
		expect(dueForRelease(facts(seq(RED), { policy: agent, proposed: true }))).toBe(false);
	});
	it("lastRunRelease: the run's last green release and how long ago it ended, never a refusal", () => {
		// Context for the agent's cadence judgment (a run released three times in one afternoon without it); the
		// project's own Release section decides, so a hotfix can still ship at once.
		const ok = { policyOn: true, hasProcedure: true, releaseInFlight: false, clean: true };
		const hour = 3_600_000;
		const released = rec({ n: 1, area: "release", verify: "green", startedAt: 0, durationMs: hour / 2 });
		released.ship = { kind: "release", version: "1.2.3" };
		const failed = rec({ n: 2, area: "release", verify: "red", startedAt: hour, durationMs: 60_000 });
		failed.ship = { kind: "release", version: "1.2.4" };
		const records = [
			released,
			failed,
			rec({ n: 3, verify: "green", commit: "abc", startedAt: hour, durationMs: 60_000 }),
		];
		expect(lastRunRelease(records, 2 * hour)).toEqual({ version: "1.2.3", cycle: 1, minutesAgo: 90 });
		expect(lastRunRelease(seq(GREEN), 2 * hour)).toBeUndefined();
		expect(proposeReleaseCheck(records, ok)).toEqual({ ok: true });
	});
	it("proposeReleaseCheck: every precondition", () => {
		const ok = { policyOn: true, hasProcedure: true, releaseInFlight: false, clean: true };
		const greens = seq(GREEN, GREEN);
		expect(proposeReleaseCheck(greens, ok)).toEqual({ ok: true });
		expect(proposeReleaseCheck(greens, { ...ok, policyOn: false })).toMatchObject({ ok: false });
		expect(proposeReleaseCheck(greens, { ...ok, hasProcedure: false })).toMatchObject({ ok: false });
		expect(proposeReleaseCheck(greens, { ...ok, releaseInFlight: true })).toMatchObject({
			ok: false,
			reason: expect.stringContaining("release is already in flight"),
		});
		expect(proposeReleaseCheck(greens, { ...ok, clean: false })).toMatchObject({
			ok: false,
			reason: expect.stringContaining("clean"),
		});
		expect(proposeReleaseCheck(seq(GREEN, RED), ok)).toMatchObject({ ok: false });
		expect(proposeReleaseCheck([], ok)).toMatchObject({ ok: false });
		expect(proposeReleaseCheck(seq({ area: "release", verify: "green" }), ok)).toMatchObject({
			ok: false,
			reason: expect.stringContaining("since the last release"),
		});
	});
	it("inFlightAfter: main's push mark comes and goes, a release mark outlasts it", () => {
		const push = { kind: "push" as const, startedAt: 1 };
		const release = { kind: "release" as const, startedAt: 2 };
		expect(inFlightAfter(undefined, push)).toEqual(push);
		expect(inFlightAfter(push, null)).toBeUndefined();
		expect(inFlightAfter(push, undefined)).toEqual(push);
		expect(inFlightAfter(push, release)).toEqual(release);
		// The last green cycle's push settling after the next `begin` made that cycle the release.
		expect(inFlightAfter(release, push)).toEqual(release);
		expect(inFlightAfter(release, null)).toEqual(release);
	});
	it("shipLevelOf: release scope only when auto release is on AND due", () => {
		const local = shipPolicyForPreset("local");
		const push = shipPolicyForPreset("push");
		const release = shipPolicyForPreset("release");
		expect(shipLevelOf(local, true)).toBe("local");
		expect(shipLevelOf(push, true)).toBe("push");
		expect(shipLevelOf(release, false)).toBe("push");
		expect(shipLevelOf(release, true)).toBe("release");
		expect(shipLevelOf({ ...release, autoPush: false }, false)).toBe("local");
	});
});

describe("ship quote verification", () => {
	const messages = ["Please finish this, then push now.", "지금 배포해줘"];
	const TABLE: Array<[string, "push" | "release", string, boolean]> = [
		["a real push request", "push", "push now", true],
		["case and whitespace are ignored", "push", "PUSH   NOW", true],
		["a Korean release request", "release", "지금 배포해", true],
		["not in any message", "push", "push everything to main", false],
		["too short", "push", "p", false],
		["empty", "push", "   ", false],
		["a real message that does not ask for a push", "push", "finish this", false],
		["a push quote used for a release", "release", "push now", false],
		["substring of a real message", "push", "then push now", true],
		["korean push on a release message", "push", "지금 배포해", false],
	];
	for (const [name, kind, quote, ok] of TABLE) {
		it(name, () => expect(verifyShipQuote(kind, quote, messages).ok).toBe(ok));
	}
	it("a failure carries a reason", () => {
		expect(verifyShipQuote("push", "nope nope", messages)).toMatchObject({
			ok: false,
			reason: expect.stringContaining("not in a message"),
		});
	});
	it("realUserText: user only, not synthetic, not agent-attributed, not wrapped", () => {
		expect(realUserText({ role: "user", content: "hi" })).toBe("hi");
		expect(
			realUserText({
				role: "user",
				content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }],
			}),
		).toBe("ab");
		expect(realUserText({ role: "user", content: "hi", attribution: "user" })).toBe("hi");
		expect(realUserText({ role: "user", content: "hi", synthetic: true })).toBeUndefined();
		expect(realUserText({ role: "user", content: "hi", attribution: "agent" })).toBeUndefined();
		expect(realUserText({ role: "assistant", content: "hi" })).toBeUndefined();
		expect(realUserText({ role: "custom", content: "hi" })).toBeUndefined();
		expect(
			realUserText({
				role: "user",
				content: '<ompdesk-agent-message from="A">\npush now\n</ompdesk-agent-message>',
			}),
		).toBeUndefined();
		expect(realUserText({ role: "user", content: "  " })).toBeUndefined();
		expect(realUserText(null)).toBeUndefined();
		expect(realUserText("hi")).toBeUndefined();
	});
	it("userMessagesSinceLastCycle: only after the last cycle record", () => {
		const entries: JournalEntry[] = [
			{ type: "message", message: { role: "user", content: "old push now" } },
			{ type: "custom", customType: AUTOPILOT_CYCLE_ENTRY, data: rec() },
			{ type: "message", message: { role: "user", content: "new ask" } },
			{ type: "message", message: { role: "user", content: "goal continuation", synthetic: true } },
			{ type: "message", message: { role: "assistant", content: "ok" } },
			{
				type: "message",
				message: { role: "user", content: '<ompdesk-agent-message from="x">\nship it\n</ompdesk-agent-message>' },
			},
		];
		expect(userMessagesSinceLastCycle(entries)).toEqual(["new ask"]);
	});
});

describe("settings merge", () => {
	const base = DEFAULT_AUTOPILOT_SETTINGS;
	it("applies valid parts and ignores invalid ones", () => {
		const next = mergeSettings(base, {
			focus: ["tests", "bogus", "tests", "docs"],
			ship: { autoPush: true, remote: "  up  ", autoRelease: { on: true, cadence: { kind: "every", n: 7.4 } } },
			limits: { tokens: 5000, minutes: -1, cycles: Number.NaN },
			maxParallel: 99,
		});
		expect(next.focus).toEqual(["tests", "docs"]);
		expect(next.ship).toEqual({
			autoPush: true,
			remote: "up",
			autoRelease: { on: true, cadence: { kind: "every", n: 7 } },
		});
		expect(next.limits).toEqual({ tokens: 5000, minutes: null, cycles: null, usd: null });
		expect(next.maxParallel).toBe(99);
	});
	it("null clears a limit, an absent key keeps it, bad values keep the old one", () => {
		const withLimits: AutopilotSettings = { ...base, limits: { tokens: 10, minutes: 20, cycles: 30, usd: 40 } };
		expect(mergeSettings(withLimits, { limits: { tokens: null } }).limits).toEqual({
			tokens: null,
			minutes: 20,
			cycles: 30,
			usd: 40,
		});
		expect(mergeSettings(withLimits, { limits: { usd: 0 } }).limits.usd).toBe(40);
		expect(mergeSettings(withLimits, {}).limits).toEqual(withLimits.limits);
	});
	it("cadence: agent, and an invalid cadence keeps the old one", () => {
		expect(
			mergeSettings(base, { ship: { autoRelease: { on: true, cadence: { kind: "agent" } } } }).ship.autoRelease,
		).toEqual({ on: true, cadence: { kind: "agent" } });
		expect(mergeSettings(base, { maxParallel: -3 }).maxParallel).toBe(0);
		expect(mergeSettings(base, { maxParallel: "x" as never }).maxParallel).toBe(base.maxParallel);
		expect(mergeSettings({ ...base, maxParallel: 2 }, { maxParallel: null }).maxParallel).toBeNull();
		expect(base.maxParallel).toBeNull();
	});
	it("does not mutate its input", () => {
		const frozen = structuredClone(base);
		mergeSettings(base, { focus: ["docs"], ship: { autoPush: true } });
		expect(base).toEqual(frozen);
	});
});

describe("state entries", () => {
	const start = initialStateEntry({
		run: "2026-10-17",
		root: "/w",
		branch: "autopilot/2026-10-17",
		baseBranch: "main",
		excludedTools: ["ask"],
		now: 1_000,
	});
	it("initial entry is running with default settings", () => {
		expect(start).toMatchObject({
			state: "running",
			activeMs: 0,
			at: 1_000,
			startedAt: 1_000,
			excludedTools: ["ask"],
			settings: DEFAULT_AUTOPILOT_SETTINGS,
		});
		expect(start.role).toBeUndefined();
		expect(
			initialStateEntry({
				run: "r",
				root: "/w",
				branch: "b",
				baseBranch: "main",
				excludedTools: [],
				now: 1,
				role: "child",
			}).role,
		).toBe("child");
	});
	it("a running stretch adds its time; a paused one does not", () => {
		const paused = nextStateEntry(start, { state: "paused", reason: "user_pause" }, 61_000);
		expect(paused.activeMs).toBe(60_000);
		expect(paused.reason).toBe("user_pause");
		const resumed = nextStateEntry(paused, { state: "running" }, 500_000);
		expect(resumed.activeMs).toBe(60_000);
		expect(resumed.reason).toBeUndefined();
		const stopping = nextStateEntry(resumed, { state: "stopping" }, 510_000);
		expect(nextStateEntry(stopping, { state: "ended", reason: "user" }, 515_000).activeMs).toBe(
			60_000 + 10_000 + 5_000,
		);
	});
	it("a state change drops the old reason, detail and quota time; a same-state update keeps them", () => {
		const waiting = nextStateEntry(start, { state: "waiting_quota", detail: "14:20", quotaResetAt: 9 }, 2_000);
		expect(waiting.quotaResetAt).toBe(9);
		expect(nextStateEntry(waiting, { inFlight: undefined }, 3_000).quotaResetAt).toBe(9);
		const back = nextStateEntry(waiting, { state: "running" }, 4_000);
		expect(back).not.toHaveProperty("quotaResetAt");
		expect(back).not.toHaveProperty("detail");
	});
});

describe("journal replay", () => {
	const custom = (customType: string, data: unknown): JournalEntry => ({ type: "custom", customType, data });
	it("cycleRecords: one per number, the later entry wins, sorted", () => {
		const entries = [
			custom(AUTOPILOT_CYCLE_ENTRY, rec({ n: 2, title: "b" })),
			custom(AUTOPILOT_CYCLE_ENTRY, rec({ n: 1, title: "a" })),
			custom(AUTOPILOT_CYCLE_ENTRY, rec({ n: 2, title: "b", reverted: true })),
		];
		const records = cycleRecords(entries);
		expect(records.map(r => r.n)).toEqual([1, 2]);
		expect(records[1].reverted).toBe(true);
	});
	it("customEntries skips other types and non-object payloads", () => {
		expect(customEntries([custom("x", { a: 1 }), custom("y", 5), { type: "message" }], "x")).toEqual([{ a: 1 }]);
		expect(customEntries([custom("x", null)], "x")).toEqual([]);
	});
	it("backlog: add, remove, done", () => {
		const entries = [
			custom(AUTOPILOT_BACKLOG_ENTRY, { op: "add", id: "a", text: "first", at: 1 }),
			custom(AUTOPILOT_BACKLOG_ENTRY, { op: "add", id: "b", text: "second", at: 2 }),
			custom(AUTOPILOT_BACKLOG_ENTRY, { op: "add", id: "c", text: "third", at: 3 }),
			custom(AUTOPILOT_BACKLOG_ENTRY, { op: "remove", id: "b", at: 4 }),
			custom(AUTOPILOT_BACKLOG_ENTRY, { op: "done", id: "a", cycle: 6, at: 5 }),
			custom(AUTOPILOT_BACKLOG_ENTRY, { op: "done", id: "zzz", cycle: 6, at: 6 }),
		];
		expect(backlogItems(entries)).toEqual([
			{ id: "a", text: "first", done: true, cycle: 6 },
			{ id: "c", text: "third", done: false },
		]);
	});
	it("notes are pending until a begin happens after them", () => {
		const entries = [
			custom(AUTOPILOT_NOTE_ENTRY, { id: "1", text: "early", at: 100 }),
			custom(AUTOPILOT_NOTE_ENTRY, { id: "2", text: "late", at: 5_000 }),
		];
		const records = [rec({ n: 1, startedAt: 1_000 })];
		expect(pendingNotes(entries, [], undefined).map(n => n.id)).toEqual(["1", "2"]);
		expect(pendingNotes(entries, records, undefined).map(n => n.id)).toEqual(["2"]);
		expect(pendingNotes(entries, records, 6_000)).toEqual([]);
	});
	it("openFollowups: dedupes, drops the ones a later cycle did, newest first", () => {
		const records = seq(
			{ followups: ["Add retries", "Fix flaky test"] },
			{ title: "fix flaky test" },
			{ followups: ["add retries", "Docs for X"] },
		);
		expect(openFollowups(records)).toEqual(["add retries", "Docs for X"]);
		expect(openFollowups([])).toEqual([]);
	});
	it("openFollowups: a later cycle that resolves a follow-up closes it, whatever its title says", () => {
		const records = seq(
			{ followups: ["The land check's tail drops the first error", "Docs for X"] },
			{
				title: "A refused land names the check's first error",
				resolved: ["the land check's tail drops the first error"],
			},
		);
		expect(openFollowups(records)).toEqual(["Docs for X"]);
		const reopened = seq({ followups: ["Docs for X"] }, { resolved: ["Docs for X"] }, { followups: ["Docs for X"] });
		expect(openFollowups(reopened)).toEqual(["Docs for X"]);
	});
	it("parseEndReport keeps the resolved follow-ups, and finalizeCycle records them", () => {
		const report = parseEndReport({
			area: "bugs",
			title: "t",
			summary: "s",
			verify: "green",
			resolved: [" a ", 3, ""],
		});
		expect(report).toMatchObject({ resolved: [" a ", ""] });
		if ("error" in report) throw new Error(report.error);
		const record = finalizeCycle({
			n: 2,
			startedAt: 0,
			now: 1,
			usage: { tokens: 0, usd: 0 },
			compactions: 0,
			report,
		});
		expect(record.resolved).toEqual(["a"]);
	});
});

describe("usage", () => {
	it("usageDelta never goes negative", () => {
		expect(usageDelta({ tokens: 10, usd: 1 }, { tokens: 25, usd: 1.5 })).toEqual({ tokens: 15, usd: 0.5 });
		expect(usageDelta({ tokens: 10, usd: 1 }, { tokens: 5, usd: 0.5 })).toEqual({ tokens: 0, usd: 0 });
	});
	it("totals and hourly rates (last five cycles, needs two)", () => {
		expect(totalsOf(seq(GREEN, GREEN))).toEqual({ tokens: 2000, usd: 0.2 });
		expect(hourlyRates([])).toEqual({});
		expect(hourlyRates(seq(GREEN))).toEqual({});
		const rates = hourlyRates(seq(GREEN, GREEN)); // 2000 tokens in 120 s
		expect(rates.tokensPerHour).toBe(60_000);
		expect(rates.usdPerHour).toBeCloseTo(6);
		expect(hourlyRates(seq({ durationMs: 0 }, { durationMs: 0 }))).toEqual({});
		const many = seq(...Array.from({ length: 8 }, (_, i) => ({ tokens: i < 3 ? 1_000_000 : 1000 })));
		expect(hourlyRates(many).tokensPerHour).toBe(60_000);
	});
});

describe("finalizeCycle / parseEndReport", () => {
	const usage = { tokens: 5, usd: 0.5 };
	it("unreported when the agent never reported", () => {
		const record = finalizeCycle({ n: 3, startedAt: 1_000, now: 4_000, usage, compactions: 1 });
		expect(record).toMatchObject({
			n: 3,
			area: "unreported",
			verify: "unreported",
			durationMs: 3_000,
			tokens: 5,
			usd: 0.5,
			compactions: 1,
			followups: [],
			children: [],
		});
		expect(record.commit).toBeUndefined();
	});
	it("takes the report over", () => {
		const record = finalizeCycle({
			n: 4,
			startedAt: 0,
			now: 10,
			usage,
			compactions: 0,
			report: {
				op: "end",
				area: "bugs",
				title: " Fix it ",
				summary: " done ",
				verify: "green",
				commit: "abc",
				backlogId: "b1",
				followups: [" a ", ""],
				ship: { kind: "release", version: "1.2.3" },
				children: [{ session: "s", branch: "x", outcome: "merged" }],
			},
		});
		expect(record).toMatchObject({
			area: "bugs",
			title: "Fix it",
			summary: "done",
			verify: "green",
			commit: "abc",
			backlogId: "b1",
			followups: ["a"],
			ship: { kind: "release", version: "1.2.3" },
			children: [{ session: "s", branch: "x", outcome: "merged" }],
		});
	});
	it("never reports a negative duration", () => {
		expect(finalizeCycle({ n: 1, startedAt: 10, now: 5, usage, compactions: 0 }).durationMs).toBe(0);
	});
	it("parseEndReport validates the model's input", () => {
		const good = { area: "tests", title: "t", summary: "s", verify: "green" };
		expect(parseEndReport(good)).toMatchObject({ op: "end", area: "tests" });
		expect(parseEndReport({ ...good, area: "user" })).toMatchObject({ area: "user" });
		expect(parseEndReport({ ...good, area: "release" })).toMatchObject({ area: "release" });
		expect(parseEndReport({ ...good, area: "weird" })).toHaveProperty("error");
		expect(parseEndReport({ ...good, title: "  " })).toHaveProperty("error");
		expect(parseEndReport({ ...good, summary: 3 })).toHaveProperty("error");
		expect(parseEndReport({ ...good, verify: "maybe" })).toHaveProperty("error");
		const full = parseEndReport({
			...good,
			commit: " abc ",
			followups: ["x", 3],
			ship: { kind: "release", version: "1", runUrl: "https://r" },
			children: [{ session: "s", branch: "b", outcome: "nonsense" }, { branch: "nope" }, null],
		});
		expect(full).toMatchObject({
			commit: "abc",
			followups: ["x"],
			ship: { kind: "release", version: "1", runUrl: "https://r" },
			children: [{ session: "s", branch: "b", outcome: "unmerged" }],
		});
		expect(parseEndReport({ ...good, ship: { kind: "push", version: "1" } })).not.toHaveProperty("ship");
	});
});

describe("buildBegin / buildStatus", () => {
	const state = {
		...initialStateEntry({
			run: "r",
			root: "/w",
			branch: "autopilot/r",
			baseBranch: "main",
			excludedTools: ["ask"],
			now: 1_000,
		}),
		settings: { ...DEFAULT_AUTOPILOT_SETTINGS, focus: ["tests" as const], limits: { ...NO_LIMITS, cycles: 10 } },
		releaseProcedure: { file: "AGENTS.md", anchors: ["Release"] },
		inFlight: { kind: "push" as const, startedAt: 5 },
	};
	it("begin carries rotation, recent cycles, follow-ups, ship state and the open ceilings", () => {
		const records = seq({ area: "design", followups: ["later"] }, GREEN, ...Array.from({ length: 12 }, () => ({})));
		const begin = buildBegin({
			cycle: 15,
			settings: state.settings,
			records,
			backlog: [
				{ id: "a", text: "pinned", done: false },
				{ id: "b", text: "old", done: true, cycle: 2 },
			],
			notes: [{ id: "n", text: "do x", at: 1 }],
			stopping: false,
			branch: state.branch,
			state,
			due: true,
			used: totalsOf(records),
			activeMs: 0,
		});
		expect(begin.cycle).toBe(15);
		expect(begin.focus).toEqual(["tests"]);
		expect(begin.backlog).toEqual([{ id: "a", text: "pinned", done: false }]);
		expect(begin.notes).toHaveLength(1);
		expect(begin.recent).toHaveLength(10);
		expect(begin.recent.at(-1)?.n).toBe(14);
		expect(begin.rotation.suggested).toBe("tests");
		expect(begin.openFollowups).toEqual(["later"]);
		expect(begin.redStreak).toBe(0);
		expect(begin.ship).toMatchObject({
			remote: "origin",
			branch: "autopilot/r",
			due: true,
			inFlight: { kind: "push" },
			releaseProcedure: { file: "AGENTS.md" },
		});
		expect(begin.budgetLeft).toEqual({ cycles: 0 });
	});
	it("begin without ceilings has no budgetLeft; reverted cycles are marked", () => {
		const records = seq({ reverted: true });
		const begin = buildBegin({
			cycle: 2,
			settings: DEFAULT_AUTOPILOT_SETTINGS,
			records,
			backlog: [],
			notes: [],
			stopping: true,
			branch: "b",
			state: { ...state, inFlight: undefined, releaseProcedure: undefined },
			due: false,
			used: { tokens: 0, usd: 0 },
			activeMs: 0,
		});
		expect(begin).not.toHaveProperty("budgetLeft");
		expect(begin.recent[0].reverted).toBe(true);
		expect(begin.stopping).toBe(true);
		expect(begin.ship).not.toHaveProperty("inFlight");
		expect(begin.ship).not.toHaveProperty("releaseProcedure");
	});
	it("status of a session that is no run", () => {
		expect(buildStatus([], 5)).toEqual({ active: false });
		expect(buildStatus([{ type: "message" }], 5)).toEqual({ active: false });
	});
	it("status from the journal: last state entry wins, cycles replay, live cycle shows", () => {
		const entries: JournalEntry[] = [
			{
				type: "custom",
				customType: AUTOPILOT_STATE_ENTRY,
				data: { ...state, state: "paused", reason: "tests_failing", at: 1_000 },
			},
			{ type: "custom", customType: AUTOPILOT_STATE_ENTRY, data: { ...state, activeMs: 30_000, at: 100_000 } },
			{
				type: "custom",
				customType: AUTOPILOT_CYCLE_ENTRY,
				data: rec({ n: 1, startedAt: 10, durationMs: 1000, tokens: 100, usd: 1 }),
			},
			{
				type: "custom",
				customType: AUTOPILOT_CYCLE_ENTRY,
				data: rec({ n: 2, startedAt: 20, durationMs: 1000, tokens: 200, usd: 2 }),
			},
			{ type: "custom", customType: AUTOPILOT_NOTE_ENTRY, data: { id: "n", text: "t", at: 500_000 } },
		];
		const status = buildStatus(entries, 160_000, { n: 3, area: "tests", startedAt: 150_000 });
		expect(status).toMatchObject({
			active: true,
			state: "running",
			run: "r",
			root: "/w",
			branch: "autopilot/r",
			baseBranch: "main",
			cycle: 3,
			now: { n: 3, area: "tests", startedAt: 150_000 },
			activeMs: 30_000 + 60_000,
			totals: { tokens: 300, usd: 3 },
			ship: {
				queue: [],
				inFlight: { kind: "push" },
				releaseProcedure: { file: "AGENTS.md" },
				policy: state.settings.ship,
			},
			children: [],
			notes: [{ id: "n" }],
		});
		expect(status.cycles?.map(c => c.n)).toEqual([1, 2]);
		expect(status.reason).toBeUndefined();
		expect(status.totals?.tokensPerHour).toBeGreaterThan(0);
	});

	it("leaves out of the status what only the journal's readers need: a cycle's check command and closed follow-ups", () => {
		// The whole status goes to every window and paired device on each update; main lands from the cycle-end frame's
		// record and `begin` reads follow-ups from the journal. On a 67-cycle run these were 30 % of a 111 KB status.
		const record = rec({ n: 1, checkCommand: "bun run check:changed --base origin/main", resolved: ["a"] });
		const entries: JournalEntry[] = [
			{ type: "custom", customType: AUTOPILOT_STATE_ENTRY, data: state },
			{ type: "custom", customType: AUTOPILOT_CYCLE_ENTRY, data: record },
		];
		const cycle = buildStatus(entries, 160_000).cycles?.[0];
		expect(cycle).toMatchObject({ n: 1, title: record.title, summary: record.summary });
		expect(cycle).not.toHaveProperty("checkCommand");
		expect(cycle).not.toHaveProperty("resolved");
		expect(cycleRecords(entries)[0]).toMatchObject({ checkCommand: record.checkCommand, resolved: ["a"] });
	});

	it("names the follow-ups no later cycle did, newest first, and none when every one was done", () => {
		const cycleEntry = (data: AutopilotCycleRecord): JournalEntry => ({
			type: "custom",
			customType: AUTOPILOT_CYCLE_ENTRY,
			data,
		});
		const entries: JournalEntry[] = [
			{ type: "custom", customType: AUTOPILOT_STATE_ENTRY, data: state },
			cycleEntry(rec({ n: 1, followups: ["trim the log", "name the port"] })),
			cycleEntry(rec({ n: 2, followups: ["lazy-load the drag library"], resolved: ["name the port"] })),
		];
		expect(buildStatus(entries, 160_000).followups).toEqual(["lazy-load the drag library", "trim the log"]);
		entries.push(cycleEntry(rec({ n: 3, resolved: ["trim the log", "lazy-load the drag library"] })));
		expect(buildStatus(entries, 160_000)).not.toHaveProperty("followups");
	});

	it("carries a cycle's summary as the log copies it, 400 characters on one line, the journal keeping it whole", () => {
		// Only the cycle's tooltip and the Markdown log read it, and the log clips it to the same 400; a run's summaries
		// were most of its status (a 73-cycle run: 63 KB of them, 41 KB clipped).
		const summary = `First line\n\n${"word ".repeat(200)}`;
		const entries: JournalEntry[] = [
			{ type: "custom", customType: AUTOPILOT_STATE_ENTRY, data: state },
			{ type: "custom", customType: AUTOPILOT_CYCLE_ENTRY, data: rec({ n: 1, summary }) },
			{ type: "custom", customType: AUTOPILOT_CYCLE_ENTRY, data: rec({ n: 2, summary: "Short one" }) },
		];
		const cycles = buildStatus(entries, 160_000).cycles ?? [];
		expect(cycles[0]?.summary).toHaveLength(400);
		expect(cycles[0]?.summary.startsWith("First line word word")).toBe(true);
		expect(cycles[0]?.summary.endsWith("…")).toBe(true);
		expect(cycles[1]?.summary).toBe("Short one");
		expect(cycleRecords(entries)[0]?.summary).toBe(summary);
	});
	it("a paused or ended run's active time stops, quota wait is exposed, ended is still a run", () => {
		const paused = {
			...state,
			state: "waiting_quota" as const,
			quotaResetAt: 99,
			detail: "14:20",
			activeMs: 1_000,
			at: 1_000,
		};
		const status = buildStatus([{ type: "custom", customType: AUTOPILOT_STATE_ENTRY, data: paused }], 900_000);
		expect(status).toMatchObject({ state: "waiting_quota", activeMs: 1_000, quotaResetAt: 99, detail: "14:20" });
		const ended = buildStatus(
			[{ type: "custom", customType: AUTOPILOT_STATE_ENTRY, data: { ...state, state: "ended", reason: "user" } }],
			5,
		);
		expect(ended).toMatchObject({ active: true, state: "ended", reason: "user" });
		expect(lastStateEntry([])).toBeUndefined();
	});
});

describe("ship requests", () => {
	const request = (over: Partial<AutopilotShipRequest>): JournalEntry => ({
		type: "custom",
		customType: AUTOPILOT_SHIP_REQUEST_ENTRY,
		data: { kind: "push", quote: "push now", cycle: 1, at: 100, ...over },
	});
	it("a request is pending until a later entry marks its `at` consumed", () => {
		expect(pendingShipRequests([])).toEqual([]);
		expect(pendingShipRequests([request({ at: 1 }), request({ at: 2, kind: "release" })]).map(r => r.at)).toEqual([
			1, 2,
		]);
		const taken = [request({ at: 1 }), request({ at: 2 }), request({ at: 1, consumedAt: 9 })];
		expect(pendingShipRequests(taken).map(r => r.at)).toEqual([2]);
	});
});

describe("prompt sections", () => {
	it("the parent section is static for a given fan-out and carries the protocol and the hard limits", () => {
		const text = autopilotSection(3);
		expect(autopilotSection(3)).toBe(text);
		expect(text.startsWith("<autopilot>")).toBe(true);
		expect(text.endsWith("</autopilot>")).toBe(true);
		for (const phrase of [
			'autopilot({op:"begin"})',
			"HARD LIMITS",
			"At most 3 sessions",
			"wait",
			"never call goal complete",
			"eval and debug",
		]) {
			expect(text, phrase).toContain(phrase);
		}
		// Nothing that changes during the run is in it: no cycle number, branch or date.
		expect(text).not.toMatch(/\bcycle \d+\b|20\d\d-\d\d-\d\d/);
	});
	it("fan-out off says so and offers no session tools", () => {
		const text = autopilotSection(0);
		expect(text).toContain("Fan-out is off");
		expect(text).not.toContain("At most");
		expect(text).not.toContain("ompdesk_session_open");
	});
	it("the child section is one item, no push, no questions", () => {
		expect(AUTOPILOT_CHILD_SECTION).toContain("ONE item");
		expect(AUTOPILOT_CHILD_SECTION).toContain("never push");
		expect(AUTOPILOT_CHILD_SECTION).toContain("HARD LIMITS");
		expect(AUTOPILOT_CHILD_SECTION).not.toContain("autopilot({op");
	});
	it("the objective fits stock's 300 characters and the steer tells the agent how to end", () => {
		expect(AUTOPILOT_OBJECTIVE.length).toBeLessThanOrEqual(300);
		expect(AUTOPILOT_STOPPING_STEER).toContain("autopilot end");
		expect(AUTOPILOT_STOPPING_STEER).toContain("wait");
	});
});
