import { describe, expect, it } from "vitest";
import { deal } from "./shard-deal";

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
