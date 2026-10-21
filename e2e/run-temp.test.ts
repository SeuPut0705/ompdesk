import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RUN_TEMP_ENV, sweepStaleRunTemps } from "./run-temp";

describe("sweepStaleRunTemps", () => {
	let base: string;
	let ownBefore: string | undefined;
	beforeEach(() => {
		base = fs.mkdtempSync(path.join(os.tmpdir(), "run-temp-sweep-"));
		ownBefore = process.env[RUN_TEMP_ENV];
	});
	afterEach(() => {
		if (ownBefore === undefined) delete process.env[RUN_TEMP_ENV];
		else process.env[RUN_TEMP_ENV] = ownBefore;
		fs.rmSync(base, { recursive: true, force: true });
	});

	const run = (name: string, owner?: number) => {
		const dir = path.join(base, name);
		fs.mkdirSync(dir);
		if (owner !== undefined) fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid: owner }));
		return dir;
	};

	it("clears only the folders of runs whose runner is gone, never this run's or a live one's", () => {
		const dead = run("ompdesk-e2e-dead", 111);
		const live = run("ompdesk-e2e-live", 222);
		const own = run("ompdesk-e2e-own", 111);
		const unclaimedNew = run("ompdesk-e2e-fresh");
		const unclaimedOld = run("ompdesk-e2e-old");
		const old = new Date(Date.now() - 5 * 60_000);
		fs.utimesSync(unclaimedOld, old, old);
		const unrelated = run("omp-gui-smoke-abc", 111);
		process.env[RUN_TEMP_ENV] = own;

		const cleared: string[] = [];
		const result = sweepStaleRunTemps(base, {
			alive: pid => pid === 222,
			clear: dir => cleared.push(dir),
			now: Date.now,
		});

		expect(result.sort()).toEqual([dead, unclaimedOld].sort());
		expect(cleared.sort()).toEqual([dead, unclaimedOld].sort());
		expect([live, own, unclaimedNew, unrelated].every(dir => !cleared.includes(dir))).toBe(true);
	});

	it("leaves a folder it cannot clear for the next run", () => {
		const dead = run("ompdesk-e2e-held", 111);
		const result = sweepStaleRunTemps(base, {
			alive: () => false,
			clear: () => {
				throw new Error("EBUSY");
			},
			now: Date.now,
		});
		expect(result).toEqual([]);
		expect(fs.existsSync(dead)).toBe(true);
	});
});
