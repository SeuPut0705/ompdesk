import { describe, expect, it } from "vitest";
import { askedWhole, changeWhole, pickedTests, plan, shardCounts, TEST_JOBS } from "./ci-plan";

describe("which runs run everything", () => {
	it("picks by the change only on a branch's dispatch that is neither the landing gate nor asked whole", () => {
		const dispatch = { event: "workflow_dispatch", scope: "changed", mac: false };
		expect(askedWhole(dispatch)).toBeUndefined();
		expect(askedWhole({ ...dispatch, scope: "full" })).toContain("scope=full");
		expect(askedWhole({ ...dispatch, mac: true })).toContain("landing gate");
		expect(askedWhole({ ...dispatch, event: "push" })).toContain("push to main");
		expect(askedWhole({ ...dispatch, event: "pull_request" })).toContain("pull request");
	});

	it("runs everything for a change to the checks themselves or to what runs every test, and for no change at all", () => {
		expect(changeWhole(["src/main/a.ts", "native/ompdesk/crates/core/src/lib.rs", "docs/a.md"])).toBeUndefined();
		// Another workflow, or the macOS jobs' action, is no part of this run: the tests that read them are picked.
		expect(
			changeWhole([".github/workflows/mac-checks.yml", ".github/actions/native-parity/action.yml"]),
		).toBeUndefined();
		expect(changeWhole(["src/main/a.ts", ".github/workflows/ci.yml"])).toContain(".github/workflows/ci.yml");
		expect(changeWhole([".github/actions/install/action.yml"])).toContain("install");
		expect(changeWhole(["src/main/a.ts", "vitest.setup.ts"])).toContain("vitest.setup.ts");
		expect(changeWhole(["bun.lock"])).toContain("bun.lock");
		expect(changeWhole([])).toContain("no change");
	});
});

describe("the tests a change runs", () => {
	it("are what it reaches, what names it and what lists folders, each with its first reason, and no deleted test", () => {
		const world = {
			files: new Set(["src/a.ts", "src/a.test.ts", "src/b.test.ts", "src/reads.test.ts", "src/lists.test.ts"]),
			imports: [["src/a.test.ts", "./a"]] as const,
			paths: [],
		};
		const picked = pickedTests(
			["src/a.ts", "src/b.test.ts", "src/deleted.test.ts"],
			{ ...world, imports: [...world.imports] },
			["src/reads.test.ts", "src/a.test.ts"],
			["src/lists.test.ts", "src/reads.test.ts"],
		);
		expect([...picked]).toEqual([
			["src/a.test.ts", "reaches src/a.ts"],
			["src/b.test.ts", "changed"],
			["src/lists.test.ts", "lists a folder of the repository"],
			["src/reads.test.ts", "names a changed file"],
		]);
	});
});

describe("how many shards a group gets", () => {
	// Worker seconds and longest file as the recorded runs of 13 Nov 2026 had them: node, renderer, Windows.
	const measured = [
		{ seconds: 2120, longest: 110 },
		{ seconds: 700, longest: 30 },
		{ seconds: 1750, longest: 140 },
	];

	it("follows the measured totals, within the run's share of the account's jobs", () => {
		expect(shardCounts(measured, TEST_JOBS)).toEqual([3, 1, 3]);
		// Half again as much work asks for five, two and four: over the share, so the shards that stay lightest go.
		const grown = measured.map(group => ({ ...group, seconds: group.seconds * 1.5 }));
		expect(shardCounts(grown, TEST_JOBS)).toEqual([4, 2, 3]);
		expect(shardCounts(grown, 99)).toEqual([5, 2, 4]);
	});

	it("never makes a shard shorter than the group's longest file, which no split can outrun", () => {
		expect(shardCounts([{ seconds: 3000, longest: 400 }], TEST_JOBS)).toEqual([2]);
		expect(shardCounts([{ seconds: 300, longest: 290 }], TEST_JOBS)).toEqual([1]);
	});

	it("takes shards from the group with the lightest ones while the run is over its share, and none from an empty group", () => {
		expect(shardCounts(measured, 5)).toEqual([2, 1, 2]);
		expect(shardCounts([{ seconds: 0, longest: 0 }, measured[1] ?? { seconds: 0, longest: 0 }], 1)).toEqual([0, 1]);
	});
});

describe("a run's jobs", () => {
	const tests = ["scripts/a.test.ts", "src/main/slow.test.ts", "src/renderer/b.test.tsx"];
	const timings = { linux: { "src/main/slow.test.ts": 1500 }, win32: { "src/main/slow.test.ts": 1700 } };

	it("are every group's shards by name, the first node job marked, Windows only where the run has it", () => {
		const made = plan({ why: "a push to main runs every test" }, tests, timings, true);
		expect(made.scope).toBe("full");
		// One file is the whole group: no split can outrun it.
		expect(made.check).toEqual([
			{ name: "node", args: "--project=node", first: true },
			{ name: "renderer", args: "--project=renderer", first: false },
		]);
		expect(made.win).toEqual([{ name: "1/1", args: "" }]);
		expect(plan({ why: "a pull request runs every test" }, tests, timings, false).win).toEqual([]);

		const split = plan(
			{ why: "x" },
			[...tests, ...Array.from({ length: 40 }, (_, index) => `src/main/t${index}.test.ts`)],
			{ linux: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`src/main/t${index}.test.ts`, 50])) },
			false,
		);
		expect(split.check.map(job => `${job.name}: ${job.args}`)).toEqual([
			"node 1/3: --project=node --shard=1/3",
			"node 2/3: --project=node --shard=2/3",
			"node 3/3: --project=node --shard=3/3",
			"renderer: --project=renderer",
		]);
	});

	it("leave out a group none of the picked tests is in", () => {
		const made = plan(
			{ why: "the change", picked: new Map([["src/renderer/b.test.tsx", "changed"]]) },
			tests,
			timings,
			true,
		);
		expect(made.scope).toBe("changed");
		expect(made.check).toEqual([{ name: "renderer", args: "--project=renderer", first: false }]);
		expect(made.win).toEqual([]);
	});
});
