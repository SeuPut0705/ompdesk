import { describe, expect, it } from "vitest";
import type {
	AutopilotCycleRecord,
	AutopilotStatus,
} from "../../../../../resources/gui-bridge/modes/autopilot-contracts";
import {
	APPROVAL_GRACE_MS,
	approvalHeldBack,
	areaMix,
	autopilotChip,
	autopilotProgress,
	autopilotStep,
	overnightSummary,
	ratePrediction,
	toolStep,
} from "./autopilot-view";

function cycle(partial: Partial<AutopilotCycleRecord> & Pick<AutopilotCycleRecord, "n">): AutopilotCycleRecord {
	return {
		area: "tests",
		title: `Cycle ${partial.n}`,
		summary: "",
		verify: "green",
		followups: [],
		children: [],
		startedAt: 1_000_000 * partial.n,
		durationMs: 600_000,
		tokens: 100_000,
		usd: 0.5,
		compactions: 0,
		...partial,
	};
}

const bash = (command: string) => ({ toolName: "bash", args: { command } });

describe("toolStep", () => {
	it("classifies reading tools as audit", () => {
		for (const toolName of ["read", "grep", "glob", "find", "ast_grep", "lsp"]) {
			expect(toolStep({ toolName, args: {} })).toBe("audit");
		}
	});

	it("classifies editing tools as implement", () => {
		for (const toolName of ["edit", "write", "ast_edit", "notebook"]) {
			expect(toolStep({ toolName, args: {} })).toBe("implement");
		}
	});

	it("classifies a bash check, test or typecheck as verify", () => {
		expect(toolStep(bash("bun run check:changed"))).toBe("verify");
		expect(toolStep(bash("bunx vitest run src/a.test.ts"))).toBe("verify");
		expect(toolStep(bash("bunx tsc --noEmit"))).toBe("verify");
		expect(toolStep(bash("OMPDESK_LOCK_OWNER=x bun run locked -- bunx playwright test"))).toBe("verify");
	});

	it("classifies git commit as commit, even when the message mentions tests", () => {
		expect(toolStep(bash('git commit -m "test: add vitest case"'))).toBe("commit");
		expect(toolStep(bash("git add src && git commit -m x"))).toBe("commit");
	});

	it("reads git status/log/diff as audit and leaves other bash unclassified", () => {
		expect(toolStep(bash("git status --short"))).toBe("audit");
		expect(toolStep(bash("git log --oneline -5"))).toBe("audit");
		expect(toolStep(bash("ls -la"))).toBeNull();
		expect(toolStep({ toolName: "bash", args: {} })).toBeNull();
	});

	it("ignores the autopilot tool and unknown tools", () => {
		expect(toolStep({ toolName: "autopilot", args: { op: "begin" } })).toBeNull();
		expect(toolStep({ toolName: "todo", args: {} })).toBeNull();
	});
});

describe("autopilotStep / autopilotProgress", () => {
	it("is the newest classified call's step", () => {
		expect(autopilotStep([{ toolName: "read", args: {} }, { toolName: "edit", args: {} }, bash("ls")])).toBe(
			"implement",
		);
	});

	it("is null with nothing classified", () => {
		expect(autopilotStep([])).toBeNull();
		expect(autopilotStep([bash("ls")])).toBeNull();
	});

	it("marks every step before the current one done", () => {
		expect(
			autopilotProgress([
				{ toolName: "read", args: {} },
				{ toolName: "edit", args: {} },
			]),
		).toEqual({
			current: "implement",
			done: ["audit"],
		});
		expect(autopilotProgress([])).toEqual({ current: null, done: [] });
	});

	it("does not go back when the agent reads again after verifying", () => {
		const progress = autopilotProgress([
			{ toolName: "edit", args: {} },
			bash("bun run check"),
			{ toolName: "read", args: {} },
		]);
		expect(progress.current).toBe("verify");
		expect(progress.done).toEqual(["audit", "implement"]);
	});
});

describe("areaMix", () => {
	it("counts reported cycles per area in the fixed order and skips unreported ones", () => {
		const mix = areaMix([
			cycle({ n: 1, area: "tests" }),
			cycle({ n: 2, area: "design" }),
			cycle({ n: 3, area: "tests" }),
			cycle({ n: 4, area: "unreported", verify: "unreported" }),
			cycle({ n: 5, area: "user" }),
		]);
		expect(mix.rows.map(row => [row.area, row.count])).toEqual([
			["design", 1],
			["tests", 2],
			["user", 1],
		]);
		expect(mix.total).toBe(4);
		expect(mix.max).toBe(2);
	});

	it("is empty with no cycles", () => {
		expect(areaMix([])).toEqual({ rows: [], total: 0, max: 0 });
	});
});

describe("ratePrediction", () => {
	it("needs two cycles", () => {
		expect(ratePrediction([cycle({ n: 1 })])).toBeNull();
		expect(ratePrediction([])).toBeNull();
	});

	it("averages the last five cycles into hourly rates", () => {
		const cycles = [1, 2, 3, 4, 5, 6, 7].map(n =>
			cycle({ n, durationMs: 1_800_000, tokens: n <= 2 ? 10_000_000 : 100_000, usd: n <= 2 ? 99 : 0.5 }),
		);
		const rate = ratePrediction(cycles);
		expect(rate?.sample).toBe(5);
		// 5 cycles x 100k tokens in 5 x 0.5 h.
		expect(rate?.tokensPerHour).toBeCloseTo(200_000, 0);
		expect(rate?.usdPerHour).toBeCloseTo(1, 5);
	});

	it("ignores cycles without a duration", () => {
		expect(ratePrediction([cycle({ n: 1, durationMs: 0 }), cycle({ n: 2, durationMs: 0 })])).toBeNull();
	});
});

describe("overnightSummary", () => {
	it("counts what finished since the user left", () => {
		const cycles = [
			cycle({ n: 1, startedAt: 1_000, durationMs: 500, commit: "aaa" }),
			cycle({ n: 2, startedAt: 10_000, durationMs: 1_000, commit: "bbb" }),
			cycle({ n: 3, startedAt: 20_000, durationMs: 1_000, verify: "red" }),
			cycle({ n: 4, startedAt: 30_000, durationMs: 1_000, ship: { kind: "release", version: "v1.2.0" } }),
		];
		const summary = overnightSummary({ cycles, since: 5_000, ship: undefined });
		expect(summary).toEqual({ cycles: 3, commits: 1, red: 1, releases: ["v1.2.0"], pushes: 0, failedShips: 0 });
	});

	it("counts the pushes and failed ship steps main ran meanwhile", () => {
		const summary = overnightSummary({
			cycles: [],
			since: 5_000,
			ship: [
				{ id: "a", kind: "push", state: "done", at: 6_000 },
				{ id: "b", kind: "push", state: "done", at: 1_000 },
				{ id: "c", kind: "merge", state: "failed", at: 7_000 },
			],
		});
		expect(summary.pushes).toBe(1);
		expect(summary.failedShips).toBe(1);
	});

	it("is all zeros when nothing happened", () => {
		expect(overnightSummary({ cycles: [], since: 0, ship: [] })).toEqual({
			cycles: 0,
			commits: 0,
			red: 0,
			releases: [],
			pushes: 0,
			failedShips: 0,
		});
	});
});

describe("autopilotChip", () => {
	const base: AutopilotStatus = {
		active: true,
		state: "running",
		cycle: 7,
		now: { n: 7, area: "performance", startedAt: 1 },
	};

	it("is null for a session that is no run, or one that ended", () => {
		expect(autopilotChip({ active: false }, undefined)).toBeNull();
		expect(autopilotChip({ ...base, state: "ended", reason: "user" }, undefined)).toBeNull();
	});

	it("names the running cycle and its area", () => {
		expect(autopilotChip(base, undefined)).toEqual({ kind: "running", cycle: 7, area: "performance" });
	});

	it("falls back to the last finished cycle number when none is in flight", () => {
		expect(autopilotChip({ ...base, now: undefined, cycle: 6 }, undefined)).toEqual({
			kind: "running",
			cycle: 6,
			area: undefined,
		});
	});

	it("shows ending, paused with its reason, and a quota wait", () => {
		expect(autopilotChip({ ...base, state: "stopping" }, undefined)).toEqual({ kind: "stopping", cycle: 7 });
		expect(autopilotChip({ ...base, state: "paused", reason: "cycles" }, undefined)).toEqual({
			kind: "paused",
			cycle: 7,
			reason: "cycles",
		});
		expect(autopilotChip({ ...base, state: "waiting_quota", quotaResetAt: 9_000 }, undefined)).toEqual({
			kind: "quota",
			cycle: 7,
			until: 9_000,
		});
	});

	it("treats a running run with a booked quota reservation as waiting for the quota", () => {
		expect(autopilotChip(base, 12_000)).toEqual({ kind: "quota", cycle: 7, until: 12_000 });
	});

	it("keeps a paused run paused even with a reservation", () => {
		expect(autopilotChip({ ...base, state: "paused", reason: "user_pause" }, 12_000)?.kind).toBe("paused");
	});
});

describe("approvalHeldBack", () => {
	it("holds an approval card back while main's approver has had no time to answer", () => {
		expect(approvalHeldBack(10_000, 10_500)).toBe(true);
		expect(approvalHeldBack(undefined, 10_500)).toBe(true);
	});

	it("shows the card once it has waited the grace period", () => {
		expect(approvalHeldBack(10_000, 10_000 + APPROVAL_GRACE_MS)).toBe(false);
		expect(approvalHeldBack(10_000, 60_000)).toBe(false);
	});
});
