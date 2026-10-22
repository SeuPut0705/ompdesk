import { describe, expect, it } from "vitest";
import {
	type AutopilotCycleRecord,
	type AutopilotToolInput,
	DEFAULT_AUTOPILOT_SETTINGS,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import {
	BEGIN_PICK,
	beginHints,
	buildBegin,
	buildStatus,
	docsPickRefusal,
	finalizeCycle,
	followupAge,
	initialStateEntry,
	parseEndReport,
	writeOffNote,
} from "../../resources/gui-bridge/modes/autopilot-core";
import {
	isCheckCommand,
	judgeVerify,
	type LedgerCall,
	ledgerCall,
	mergeRepeatedEnd,
	parseNumstat,
	reconcileCommit,
	shouldSteerStop,
} from "../../resources/gui-bridge/modes/autopilot-verify";

type EndReport = Extract<AutopilotToolInput, { op: "end" }>;

const bash = (command: string, ok = true, background = false): LedgerCall => ({
	tool: "bash",
	command,
	ok,
	background,
});
const edit: LedgerCall = { tool: "edit", ok: true, background: false };

function cycle(n: number, extra: Partial<AutopilotCycleRecord> = {}): AutopilotCycleRecord {
	return {
		n,
		area: "bugs",
		title: `item ${n}`,
		summary: "",
		verify: "green",
		commit: `c${n}`,
		followups: [],
		children: [],
		startedAt: n * 1000,
		durationMs: 1000,
		tokens: 1,
		usd: 0,
		compactions: 0,
		...extra,
	};
}

describe("isCheckCommand", () => {
	it.each([
		["bun test", true],
		["bun test 2>&1 | tail -6", true],
		["cd app && bun run check:changed", true],
		["bun run locked -- bunx vitest run src/x.test.ts", true],
		["bun run locked -- --chunk 3 -- bunx playwright test e2e/x.e2e.ts", true],
		["npm run lint", true],
		["pnpm test --filter api", true],
		["pytest -q", true],
		["python3 -m pytest tests", true],
		["cargo test --workspace", true],
		["go vet ./...", true],
		["make check", true],
		["./scripts/check-all.sh", true],
		["tsc --noEmit", true],
		["CI=1 bunx vitest", true],
		["cat test/emitter.test.ts", false],
		["git log --oneline | grep test", false],
		["ls test", false],
		["git commit -qm 'fix: test the check'", false],
		['cat > test/a.test.ts <<\'EOF\'\nimport { test } from "bun:test";\ntest("x", () => {});\nEOF', false],
		["bun install", false],
	])("%s -> %s", (command, expected) => expect(isCheckCommand(command)).toBe(expected));

	it("the command the agent named counts, whatever it is", () => {
		expect(isCheckCommand("./tools/verify-everything --fast", "./tools/verify-everything --fast")).toBe(true);
		expect(isCheckCommand("ls", "./tools/verify-everything --fast")).toBe(false);
	});
});

describe("ledgerCall", () => {
	it("keeps edits and bash, nothing else", () => {
		expect(ledgerCall("edit", {}, {}, false)).toEqual({ tool: "edit", ok: true, background: false });
		expect(ledgerCall("read", {}, {}, false)).toBeNull();
		expect(ledgerCall("bash", { command: "bun test" }, { content: [] }, true)).toEqual({
			tool: "bash",
			command: "bun test",
			ok: false,
			background: false,
		});
	});
	it("a bash call that became a background job has no verdict yet", () => {
		const call = ledgerCall("bash", { command: "bun test" }, { details: { async: { state: "running" } } }, false);
		expect(call).toMatchObject({ ok: true, background: true });
	});
});

describe("judgeVerify", () => {
	const base = { claimed: "green" as const, changed: true };
	it("takes green when a check ran after the last edit and passed, naming that check", () => {
		expect(judgeVerify({ ...base, calls: [edit, bash("bun test")] })).toEqual({
			verify: "green",
			amendable: false,
			check: "bun test",
		});
		expect(judgeVerify({ ...base, calls: [edit, bash("bun test"), bash("bun run lint")] }).check).toBe(
			"bun run lint",
		);
		expect(judgeVerify({ ...base, calls: [bash("cat > a.ts <<EOF\nEOF\nbun test")] }).verify).toBe("green");
	});
	it("refuses green without any check: skipped, and the agent may amend", () => {
		const verdict = judgeVerify({ ...base, calls: [edit, bash("git commit -qm x")] });
		expect(verdict).toMatchObject({ verify: "skipped", amendable: true });
		expect(verdict.note).toContain("no check command");
		expect(verdict.why).toEqual({ kind: "no_check" });
	});
	it("a last check that failed makes the claim red", () => {
		const verdict = judgeVerify({ ...base, calls: [bash("bun test"), edit, bash("bun test", false)] });
		expect(verdict).toMatchObject({ verify: "red", amendable: true });
		expect(verdict.note).toContain("bun test");
		expect(verdict.why).toEqual({ kind: "check_failed", command: "bun test" });
	});
	it("a failure followed by a passing run is green", () => {
		expect(judgeVerify({ ...base, calls: [bash("bun test", false), edit, bash("bun test")] }).verify).toBe("green");
	});
	it("an edit after the last check is stale", () => {
		expect(judgeVerify({ ...base, calls: [bash("bun test"), edit] })).toMatchObject({
			verify: "skipped",
			amendable: true,
		});
	});
	it("a check that moved to a background job is not a failure", () => {
		expect(judgeVerify({ ...base, calls: [edit, bash("bun test", true, true)] }).verify).toBe("green");
	});
	it("takes a claim that is not green, or a cycle that changed nothing, as it is", () => {
		expect(judgeVerify({ claimed: "red", changed: true, calls: [] })).toEqual({ verify: "red", amendable: false });
		expect(judgeVerify({ claimed: "skipped", changed: true, calls: [] }).verify).toBe("skipped");
		expect(judgeVerify({ claimed: "green", changed: false, calls: [] }).verify).toBe("green");
	});
	it("names the declared check when it ran after the last edit, though a narrower check ran last", () => {
		// The name is what a land re-runs on the merged commit: a few e2e specs run after the repo's check made it
		// re-run only those (21 Oct 2026, a cycle reported `check:changed` and recorded a playwright subset).
		const declared = "bun run check:changed --base origin/main";
		const calls = [edit, bash(`${declared} 2>&1 | tail -2`), bash("bunx playwright test e2e/a.e2e.ts")];
		expect(judgeVerify({ ...base, calls, declared }).check).toBe(`${declared} 2>&1 | tail -2`);
		// Before the last edit it proves nothing about the change: the last check is named.
		const stale = [bash(declared), edit, bash("bun test")];
		expect(judgeVerify({ ...base, calls: stale, declared }).check).toBe("bun test");
	});

	it("the declared check command counts as a check", () => {
		const calls = [edit, bash("./tools/verify-everything --fast")];
		expect(judgeVerify({ ...base, calls }).verify).toBe("skipped");
		expect(judgeVerify({ ...base, calls, declared: "./tools/verify-everything --fast" }).verify).toBe("green");
	});
});

describe("mergeRepeatedEnd", () => {
	const first: EndReport = {
		op: "end",
		area: "bugs",
		title: "LruCache rejects invalid capacity",
		summary: "did it",
		verify: "green",
		commit: "497bca0",
		followups: ["a", "b"],
	};
	it("keeps the first report and only adds what it left out", () => {
		const again: EndReport = {
			op: "end",
			area: "bugs",
			title: "Autopilot stopped by user; no new work",
			summary: "nothing",
			verify: "skipped",
			followups: ["b", "c"],
			children: [{ session: "s", branch: "b", outcome: "merged" }],
		};
		expect(mergeRepeatedEnd(first, again)).toEqual({
			...first,
			followups: ["a", "b", "c"],
			children: again.children,
		});
	});
	it("never replaces a commit, children or ship the first report has", () => {
		const again: EndReport = { ...first, commit: "deadbee", title: "x" };
		expect(mergeRepeatedEnd(first, again).commit).toBe("497bca0");
		expect(mergeRepeatedEnd(first, again).title).toBe(first.title);
	});
});

describe("shouldSteerStop", () => {
	it("steers a turn in flight that has not reported; a reported cycle just ends", () => {
		expect(shouldSteerStop({ streaming: true, reported: false })).toBe(true);
		expect(shouldSteerStop({ streaming: true, reported: true })).toBe(false);
		expect(shouldSteerStop({ streaming: false, reported: false })).toBe(false);
	});
});

describe("reconcileCommit", () => {
	it("keeps a claimed hash that is in the history", () => {
		expect(reconcileCommit({ claimed: "abc1234", claimedKnown: true, head: "fff0000", moved: true })).toBe("abc1234");
	});
	it("fills in the commit the repository shows when the agent left it out or got it wrong", () => {
		expect(reconcileCommit({ claimedKnown: false, head: "fff0000", moved: true })).toBe("fff0000");
		expect(reconcileCommit({ claimed: "nope123", claimedKnown: false, head: "fff0000", moved: true })).toBe(
			"fff0000",
		);
	});
	it("a cycle that left HEAD where it was has no commit", () => {
		expect(
			reconcileCommit({ claimed: "abc1234", claimedKnown: false, head: "fff0000", moved: false }),
		).toBeUndefined();
		expect(reconcileCommit({ claimedKnown: false, moved: false })).toBeUndefined();
	});
});

describe("parseNumstat", () => {
	it("sums files and lines; binary files count as files", () => {
		expect(parseNumstat("3\t1\tsrc/a.ts\n10\t0\ttest/a.test.ts\n-\t-\tlogo.png\n", 2)).toEqual({
			files: 3,
			added: 13,
			removed: 1,
			commits: 2,
		});
	});
	it("flags a change that only touches documentation", () => {
		expect(parseNumstat("2\t2\tREADME.md\n5\t0\tdocs/guide.txt\n", 1)).toMatchObject({ files: 2, docOnly: true });
		expect(parseNumstat("2\t2\tREADME.md\n5\t0\tsrc/a.ts\n", 1)?.docOnly).toBeUndefined();
	});
	it("nothing listed is no change", () => expect(parseNumstat("", 0)).toBeNull());
});

describe("a verified report reaches the record", () => {
	it("finalizeCycle carries the note and the change; parseEndReport reads check", () => {
		const parsed = parseEndReport({
			area: "bugs",
			title: "t",
			summary: "s",
			verify: "green",
			check: " bun test ",
		});
		expect(parsed).toMatchObject({ check: "bun test" });
		const record = finalizeCycle({
			n: 1,
			report: { op: "end", area: "bugs", title: "t", summary: "s", verify: "skipped", commit: "abc1234" },
			startedAt: 0,
			now: 10,
			usage: { tokens: 1, usd: 0 },
			compactions: 0,
			verifyNote: { kind: "no_check" },
			change: { files: 1, added: 2, removed: 0, commits: 1 },
		});
		expect(record.verifyNote).toEqual({ kind: "no_check" });
		expect(record.change).toEqual({ files: 1, added: 2, removed: 0, commits: 1 });
		expect(
			finalizeCycle({ n: 2, startedAt: 0, now: 1, usage: { tokens: 0, usd: 0 }, compactions: 0 }).change,
		).toBeUndefined();
	});
});

describe("pick and the status's now", () => {
	it("the status shows the picked item and no guessed area before the pick", () => {
		const state = initialStateEntry({
			run: "r",
			root: "/w",
			branch: "autopilot/r",
			baseBranch: "main",
			excludedTools: [],
			now: 0,
		});
		const entries = [{ type: "custom", customType: "ompdesk.autopilot", data: state }];
		expect(buildStatus(entries, 5, { n: 1, startedAt: 1 }).now).toEqual({ n: 1, startedAt: 1 });
		expect(buildStatus(entries, 5, { n: 1, startedAt: 1, area: "bugs", title: "chunk loops" }).now).toEqual({
			n: 1,
			area: "bugs",
			title: "chunk loops",
			startedAt: 1,
		});
	});
});

describe("begin hints", () => {
	const facts = { open: [] as string[], maxParallel: 0 };
	it("counts how many cycles in a row carried a follow-up", () => {
		const records = [
			cycle(1, { followups: ["Emitter.once missing"] }),
			cycle(2, { followups: ["emitter.once   missing!", "x"] }),
			cycle(3, { followups: ["Emitter.once missing"] }),
		];
		expect(followupAge(records, "Emitter.once missing")).toBe(3);
		expect(followupAge([...records, cycle(4)], "Emitter.once missing")).toBe(0);
	});
	it("asks for a decision on a follow-up carried three cycles or more, oldest first, at most two", () => {
		const records = ["a", "b", "c"].map((_, i) =>
			cycle(i + 1, { followups: i === 2 ? ["old one", "older one", "new one"] : ["old one", "older one"] }),
		);
		const hints = beginHints(records, { ...facts, open: ["new one", "old one", "older one"] });
		expect(hints).toHaveLength(2);
		expect(hints[0]).toContain("carried for 3 cycles");
		expect(hints.join("\n")).not.toContain("new one");
	});
	it("says nothing when nothing stands out", () => {
		expect(beginHints([cycle(1, { followups: ["a"] })], { ...facts, open: ["a"] })).toEqual([]);
	});
	it("warns after a documentation-only cycle", () => {
		const docs = cycle(2, { area: "docs", change: { files: 1, added: 3, removed: 1, commits: 1, docOnly: true } });
		expect(beginHints([cycle(1), docs], facts).join(" ")).toContain("documentation only");
		expect(beginHints([cycle(1), cycle(2, { area: "docs" })], facts).join(" ")).toContain("documentation only");
		expect(beginHints([docs, cycle(3)], facts)).toEqual([]);
	});
	it("fan-out advice only when fan-out is on and there are two items to tempt it", () => {
		expect(beginHints([], { open: ["a", "b"], maxParallel: 2 }).join(" ")).toContain("Child sessions pay only");
		expect(beginHints([], { open: ["a", "b"], maxParallel: 0 })).toEqual([]);
		expect(beginHints([], { open: ["a"], maxParallel: 2 })).toEqual([]);
	});
	it("puts an open follow-up that names a defect ahead of docs and polish", () => {
		const hints = beginHints([cycle(1)], { ...facts, open: ["truncate breaks on n < 0", "document the CLI"] });
		expect(hints.join(" ")).toContain('"truncate breaks on n < 0"');
		expect(hints.join(" ")).not.toContain("document the CLI");
		expect(beginHints([cycle(1)], { ...facts, open: ["document the CLI"] })).toEqual([]);
	});
	it("refuses a docs pick right after a docs-only cycle unless a reason is given", () => {
		const docs = cycle(1, { area: "docs", change: { files: 1, added: 3, removed: 1, commits: 1, docOnly: true } });
		expect(docsPickRefusal([docs], "docs", undefined)).toContain("documentation only");
		expect(docsPickRefusal([docs], "docs", "  ")).not.toBeNull();
		expect(docsPickRefusal([docs], "docs", "the release notes are due")).toBeNull();
		expect(docsPickRefusal([docs], "bugs", undefined)).toBeNull();
		expect(docsPickRefusal([cycle(1)], "docs", undefined)).toBeNull();
	});
	it("flags a report that writes a found problem off as a limitation without a follow-up", () => {
		const report = { title: "README design notes", summary: "Negative n is a known limitation." };
		expect(writeOffNote(report)).toContain("followups");
		expect(writeOffNote({ ...report, followups: ["truncate with negative n"] })).toBeNull();
		expect(writeOffNote({ title: "Fix slugify", summary: "Replaced every space." })).toBeNull();
		expect(BEGIN_PICK).toMatch(/known bug or failing behaviour .* first/);
	});
	it("buildBegin carries the pick instruction and the hints", () => {
		const state = initialStateEntry({
			run: "r",
			root: "/w",
			branch: "autopilot/r",
			baseBranch: "main",
			excludedTools: [],
			now: 0,
		});
		const begin = buildBegin({
			cycle: 1,
			settings: DEFAULT_AUTOPILOT_SETTINGS,
			records: [],
			notes: [],
			stopping: false,
			branch: "autopilot/r",
			state,
			due: false,
			used: { tokens: 0, usd: 0 },
			activeMs: 0,
		});
		expect(begin.pick).toBe(BEGIN_PICK);
		expect(begin.pick).toContain('op:"pick"');
		expect(begin.hints).toBeUndefined();
	});
});
