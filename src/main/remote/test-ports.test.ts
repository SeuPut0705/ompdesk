import { afterEach, describe, expect, it, vi } from "vitest";
import { REMOTE_PORT_SPAN } from "./address";
import { freePortRun } from "./test-ports";

function touching(runs: readonly number[]): string[] {
	const sorted = [...runs].sort((a, b) => a - b);
	const found: string[] = [];
	for (let i = 1; i < sorted.length; i++) {
		const previous = sorted[i - 1] as number;
		const current = sorted[i] as number;
		if (current - previous < REMOTE_PORT_SPAN) found.push(`${previous} and ${current}`);
	}
	return found;
}

async function picks(count: number): Promise<number[]> {
	const runs: number[] = [];
	for (let i = 0; i < count; i++) runs.push(await freePortRun());
	return runs;
}

describe("freePortRun", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("never hands one process two runs that touch, so a host and a device of one test cannot find each other's neighbours", async () => {
		vi.stubEnv("TEST_PARALLEL_INDEX", "0");
		expect(touching(await picks(90))).toEqual([]);
	});

	it("keeps the runs of parallel workers apart: a run picked but not yet listened on is never another worker's", async () => {
		const all: number[] = [];
		for (const worker of ["0", "1", "2", "3"]) {
			vi.stubEnv("TEST_PARALLEL_INDEX", worker);
			all.push(...(await picks(90)));
		}
		expect(touching(all)).toEqual([]);
	});

	it("keeps Playwright's workers and Vitest's workers apart", async () => {
		const all: number[] = [];
		vi.stubEnv("TEST_PARALLEL_INDEX", "0");
		all.push(...(await picks(90)));
		vi.unstubAllEnvs();
		vi.stubEnv("VITEST_POOL_ID", "1");
		all.push(...(await picks(90)));
		expect(touching(all)).toEqual([]);
	});
});
