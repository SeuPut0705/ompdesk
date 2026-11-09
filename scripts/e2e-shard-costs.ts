/**
 * Rewrites `scripts/e2e-shard-costs.json` from a full nightly's logs (`scripts/e2e-shard.ts` deals the shards by it):
 *
 *   bun scripts/e2e-shard-costs.ts <run-id>
 *
 * Sums each spec file's test times over every `e2e (shard …)` job of the run (the hosted macOS runner, one worker)
 * and keeps the files of `MIN_SECONDS` or more. A file the run did not reach keeps the cost it had while its spec
 * still exists. Run it on a nightly when its shards drift apart (their Playwright steps differ by minutes).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Shorter files are dealt by their test count (`TEST_SECONDS` in e2e-shard.ts). */
const MIN_SECONDS = 8;
const FILE = path.join(import.meta.dirname, "e2e-shard-costs.json");
const UNIT_SECONDS: Readonly<Record<string, number>> = { ms: 0.001, s: 1, m: 60 };

/**
 * Each spec file's summed test seconds in a shard's log, whose list reporter prints one line per test that ran:
 * `  ✓  12 e2e/smoke.e2e.ts:59:1 › title (13.4s)`, a failed one with `✘`, with colour codes between the parts.
 */
export function parseSpecSeconds(log: string): Map<string, number> {
	const seconds = new Map<string, number>();
	// gh prints the escape character of a colour code either raw or as the two characters `^[`.
	const plain = log.replace(/(?:\x1b|\^\[)\[[0-9;]*m/g, "");
	for (const match of plain.matchAll(
		/[✓✘]\s+\d+ e2e\/(\S+\.e2e\.ts):\d+:\d+ › .* \((\d+(?:\.\d+)?)(ms|s|m)\)\s*$/gm,
	)) {
		const file = match[1] ?? "";
		seconds.set(file, (seconds.get(file) ?? 0) + Number(match[2]) * (UNIT_SECONDS[match[3] ?? "s"] ?? 1));
	}
	return seconds;
}

if (import.meta.main) {
	const run = process.argv[2] ?? "";
	if (!/^\d+$/.test(run)) {
		console.error("usage: bun scripts/e2e-shard-costs.ts <run-id>");
		process.exit(2);
	}
	const gh = (...args: string[]) => {
		const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 512 << 20 });
		if (result.status !== 0) throw new Error(`gh ${args.join(" ")} failed: ${result.stderr}`);
		return result.stdout;
	};
	const jobs: Array<{ name: string; databaseId: number }> = JSON.parse(gh("run", "view", run, "--json", "jobs")).jobs;
	const measured = new Map<string, number>();
	for (const job of jobs.filter(entry => /\be2e \(shard /.test(entry.name))) {
		const found = parseSpecSeconds(gh("run", "view", run, "--job", String(job.databaseId), "--log"));
		console.log(`[e2e-shard-costs] ${job.name}: ${found.size} files`);
		for (const [file, seconds] of found) measured.set(file, (measured.get(file) ?? 0) + seconds);
	}
	if (measured.size === 0) {
		console.error(`[e2e-shard-costs] run ${run} has no e2e shard job with test lines`);
		process.exit(1);
	}
	const kept: Record<string, number> = JSON.parse(readFileSync(FILE, "utf8"));
	const costs = new Map(Object.entries(kept).filter(([file]) => existsSync(path.join("e2e", file))));
	for (const [file, seconds] of measured) {
		if (seconds >= MIN_SECONDS) costs.set(file, Math.round(seconds));
		else costs.delete(file);
	}
	writeFileSync(
		FILE,
		`${JSON.stringify(Object.fromEntries([...costs].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))), null, "\t")}\n`,
	);
	console.log(`[e2e-shard-costs] ${costs.size} files of ${MIN_SECONDS} s or more`);
}
