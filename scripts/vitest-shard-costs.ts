/**
 * Rewrites `scripts/vitest-shard-costs.json` from a CI run's logs:
 *
 *   bun scripts/vitest-shard-costs.ts <run-id>
 *
 * Reads every `check (…)` job (Linux: the node and renderer projects) and every `win-platform (…)` job of the run and
 * keeps each test file that took `MIN_SECONDS` or more, in seconds, per platform. Run it on a green push run of ci.yml
 * when the shards drift apart (a job's log ends each file's line with its milliseconds). A platform the run has no
 * job for (a pull request has no Windows job) keeps the costs it had.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Shorter files are most of the count and little of the time; the sequencer gives them one flat cost. */
const MIN_SECONDS = 2;
const FILE = path.join(import.meta.dirname, "vitest-shard-costs.json");

/**
 * Each test file's seconds in a vitest job's log, whose default reporter prints one line per file:
 * ` ✓  node  src/main/a.test.ts (86 tests | 1 skipped) 4789ms`, with colour codes between the parts.
 */
export function parseDurations(log: string): Map<string, number> {
	const seconds = new Map<string, number>();
	// gh prints the escape character of a colour code either raw or as the two characters `^[`.
	const plain = log.replace(/(?:\x1b|\^\[)\[[0-9;]*m/g, "");
	for (const match of plain.matchAll(
		/[✓❯×]\s+(?:\S+\s+)?(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+\([^)]*\)\s+(\d+)\s*ms/g,
	)) {
		const file = (match[1] ?? "").replaceAll("\\", "/");
		seconds.set(file, Math.max(seconds.get(file) ?? 0, Number(match[2]) / 1000));
	}
	return seconds;
}

if (import.meta.main) {
	const run = process.argv[2] ?? "";
	if (!/^\d+$/.test(run)) {
		console.error("usage: bun scripts/vitest-shard-costs.ts <run-id>");
		process.exit(2);
	}
	const gh = (...args: string[]) => {
		const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 512 << 20 });
		if (result.status !== 0) throw new Error(`gh ${args.join(" ")} failed: ${result.stderr}`);
		return result.stdout;
	};
	const jobs: Array<{ name: string; databaseId: number }> = JSON.parse(gh("run", "view", run, "--json", "jobs")).jobs;
	const costs: Record<string, Record<string, number>> = JSON.parse(readFileSync(FILE, "utf8"));
	for (const [platform, pattern] of [
		["linux", /^check \(/],
		["win32", /^win-platform \(/],
	] as const) {
		const measured = new Map<string, number>();
		for (const job of jobs.filter(entry => pattern.test(entry.name))) {
			const found = parseDurations(gh("run", "view", run, "--job", String(job.databaseId), "--log"));
			console.log(`[vitest-shard-costs] ${job.name}: ${found.size} files`);
			for (const [file, seconds] of found) measured.set(file, Math.max(measured.get(file) ?? 0, seconds));
		}
		if (measured.size === 0) {
			console.log(`[vitest-shard-costs] ${platform}: no job in run ${run}, costs kept`);
			continue;
		}
		costs[platform] = Object.fromEntries(
			[...measured]
				.filter(([, seconds]) => seconds >= MIN_SECONDS)
				.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
				.map(([file, seconds]) => [file, Math.round(seconds * 10) / 10]),
		);
	}
	writeFileSync(FILE, `${JSON.stringify(costs, null, "\t")}\n`);
}
