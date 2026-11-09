import { describe, expect, it } from "vitest";
import { deal } from "./shard-deal";
import { fileSeconds } from "./vitest-sequencer";
import { parseDurations } from "./vitest-shard-costs";

const seconds = (files: ReadonlyArray<{ file: string; seconds: number }>, shard: readonly string[]) =>
	shard.reduce((sum, file) => sum + (files.find(entry => entry.file === file)?.seconds ?? 0), 0);

describe("dealing test files to shards", () => {
	// A few long files among many short ones, as in the node project.
	const files = [
		...[121, 88, 66, 64, 49, 40, 40, 32].map((cost, index) => ({ file: `long-${index}.test.ts`, seconds: cost })),
		...Array.from({ length: 200 }, (_, index) => ({ file: `short-${index}.test.ts`, seconds: 0.8 })),
	];

	it.each([2, 3, 6])("puts every file in exactly one of %i shards", total => {
		const shards = deal(files, total);
		expect(shards).toHaveLength(total);
		expect(shards.flat().sort()).toEqual(files.map(entry => entry.file).sort());
	});

	it("deals the same shards whatever order the files are listed in, so two jobs of a run agree", () => {
		const reversed = [...files].reverse();
		expect(deal(reversed, 2)).toEqual(deal(files, 2));
	});

	it("balances the work, not the count", () => {
		const [first = [], second = []] = deal(files, 2);
		expect(Math.abs(seconds(files, first) - seconds(files, second))).toBeLessThan(1);
		// Cut by count, as vitest's own shard does, the long files can all land on one side.
		const byCount = [files.slice(0, 104), files.slice(104)].map(part => part.reduce((sum, e) => sum + e.seconds, 0));
		expect(Math.abs((byCount[0] ?? 0) - (byCount[1] ?? 0))).toBeGreaterThan(300);
	});
});

describe("a test file's estimated cost", () => {
	it("is its measured seconds, and a flat cost for a file no run measured", () => {
		const measured = { "src/main/slow-stock.test.ts": 120 };
		expect(fileSeconds("src/main/slow-stock.test.ts", measured)).toBeGreaterThan(120);
		expect(fileSeconds("src/main/new.test.ts", measured)).toBeLessThan(2);
		expect(fileSeconds("src/main/new.test.ts", measured)).toBeGreaterThan(0);
	});
});

describe("reading a vitest job's log", () => {
	const ESC = "\x1b";
	it("takes each file's time from its line, colour codes or not, in either spelling of the escape", () => {
		const log = [
			`check (node 1/2)\tUNKNOWN STEP\t2026-11-09T16:59:50.4Z  ${ESC}[32m✓${ESC}[39m ${ESC}[30m${ESC}[43m node ${ESC}[49m${ESC}[39m src/main/ai-memory/service.test.ts ${ESC}[2m(${ESC}[22m${ESC}[2m67 tests${ESC}[22m${ESC}[2m | ${ESC}[22m${ESC}[33m1 skipped${ESC}[39m${ESC}[2m)${ESC}[22m${ESC}[33m 4789${ESC}[2mms${ESC}[22m${ESC}[39m`,
			"check (node 1/2)\tUNKNOWN STEP\t2026-11-09T16:59:51.0Z  ^[[32m✓^[[39m ^[[30m^[[43m node ^[[49m^[[39m src/main/turn-resume.test.ts ^[[2m(^[[22m^[[2m238 tests^[[22m^[[2m)^[[22m^[[33m 473^[[2mms^[[22m^[[39m",
			"win-platform (1/2)\tUNKNOWN STEP\t2026-11-09T17:01:05.0Z  ✓ src\\main\\disk\\disk-care.test.ts (6 tests) 28100ms",
			"check (node 1/2)\tUNKNOWN STEP\t2026-11-09T17:04:30.0Z  Test Files  295 passed | 5 skipped (300)",
		].join("\n");
		expect(Object.fromEntries(parseDurations(log))).toEqual({
			"src/main/ai-memory/service.test.ts": 4.789,
			"src/main/turn-resume.test.ts": 0.473,
			"src/main/disk/disk-care.test.ts": 28.1,
		});
	});

	it("keeps the longer time of a file a job ran twice", () => {
		const log = " ✓ a.test.ts (1 test) 3000ms\n ✓ a.test.ts (1 test) 1200ms";
		expect(parseDurations(log).get("a.test.ts")).toBe(3);
	});
});
