/**
 * What each test file costs on GitHub's runners, as the runs themselves recorded it: the cost the shards of both
 * suites are dealt by (`scripts/vitest-sequencer.ts`, `scripts/e2e-shard.ts`) and a run's shard counts are picked from
 * (`scripts/ci-plan.ts`).
 *
 * A record is seconds per file, per group: vitest's by the runner's platform (`linux`, `win32`), a file's cost being
 * its worker's whole time for it (environment, setup files, imports, tests: `scripts/vitest-timings-reporter.ts`);
 * Playwright's as `e2e`, a spec file's passed tests summed (`scripts/e2e-timings-reporter.ts`). Each job writes what it
 * measured, the run's last job folds those into the record the run started from (`merge` below) and saves it as a
 * cache (`vitest-timings-`, `e2e-timings-`), and the next run's first job hands that record to every shard as one
 * file, so all jobs of a run deal from the same numbers.
 *
 * The two JSON files beside this one are the record's last snapshot, for what has no record at hand: release.yml,
 * omp-latest.yml, a repository's first run, a computer. Rewrite one from a full run's artifact when it has drifted:
 *
 *   gh run download <run-id> -n test-timings && bun scripts/test-timings.ts seed test-timings.json scripts/vitest-shard-costs.json
 *   gh run download <run-id> -n e2e-timings && bun scripts/test-timings.ts seed e2e-timings.json scripts/e2e-shard-costs.json
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Seconds per test file, by its path from the repository root with forward slashes. */
export type Costs = Record<string, number>;
export type Timings = Record<string, Costs>;
/** What one job measured. */
export interface JobTimings {
	group: string;
	files: Costs;
}

/** A vitest file no run has measured yet: the mean of the files under a second, which most new files are. */
export const UNMEASURED_SECONDS = 0.8;
/** A snapshot keeps the files that steer a deal; the rest are most of the count and little of the time. */
const SEED_MIN_SECONDS = 1;
/**
 * How much of a file's cost is its newest measurement. The same file's time differs by a third between two runs of one
 * commit on these runners (41 node files of 10 s or more in ci runs 43482864186 and 43484284198: median ratio 1.33, a
 * tenth of them past 1.74), so one run alone is a noisy cost; half and half settles in a few runs.
 */
const NEWEST_WEIGHT = 0.5;

/** The record a run was handed, else the snapshot in the repository. */
export function loadTimings(file: string | undefined, seed: Timings): Timings {
	return file ? JSON.parse(readFileSync(file, "utf8")) : seed;
}

/** `record` with each job's files folded in, and without the files `exists` no longer finds. */
export function mergeTimings(record: Timings, jobs: readonly JobTimings[], exists: (file: string) => boolean): Timings {
	const merged: Timings = {};
	for (const group of new Set([...Object.keys(record), ...jobs.map(job => job.group)])) {
		const before = record[group] ?? {};
		// Two jobs of a run never hold the same file.
		const measured: Costs = Object.assign({}, ...jobs.filter(job => job.group === group).map(job => job.files));
		const costs: Costs = {};
		for (const file of new Set([...Object.keys(before), ...Object.keys(measured)])) {
			if (!exists(file)) continue;
			const [was, now] = [before[file], measured[file]];
			const seconds = was === undefined ? now : now === undefined ? was : was + (now - was) * NEWEST_WEIGHT;
			if (seconds !== undefined) costs[file] = Math.round(seconds * 10) / 10;
		}
		merged[group] = costs;
	}
	return merged;
}

/** Longest first, so a diff of a snapshot reads top down. */
function ordered(record: Timings, min: number): Timings {
	return Object.fromEntries(
		Object.entries(record).map(([group, costs]) => [
			group,
			Object.fromEntries(
				Object.entries(costs)
					.filter(([, seconds]) => seconds >= min)
					.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
			),
		]),
	);
}

if (import.meta.main) {
	const [command, record = "", target = ""] = process.argv.slice(2);
	if (command === "merge" && record && target) {
		// <record.json> <folder of the jobs' files>: a run with no record starts an empty one.
		const jobs: JobTimings[] = readdirSync(target, { recursive: true, encoding: "utf8" })
			.filter(name => name.endsWith(".json"))
			.map(name => JSON.parse(readFileSync(path.join(target, name), "utf8")));
		const merged = mergeTimings(existsSync(record) ? loadTimings(record, {}) : {}, jobs, existsSync);
		writeFileSync(record, `${JSON.stringify(ordered(merged, 0))}\n`);
		for (const [group, costs] of Object.entries(merged)) {
			const total = Object.values(costs).reduce((sum, seconds) => sum + seconds, 0);
			console.log(`[test-timings] ${group}: ${Object.keys(costs).length} files, ${Math.round(total)} s`);
		}
	} else if (command === "seed" && record && target) {
		writeFileSync(target, `${JSON.stringify(ordered(loadTimings(record, {}), SEED_MIN_SECONDS), null, "\t")}\n`);
	} else {
		console.error(
			"usage: bun scripts/test-timings.ts merge <record.json> <jobs-dir> | seed <record.json> <snapshot.json>",
		);
		process.exit(2);
	}
}
