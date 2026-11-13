/**
 * What one run of ci.yml runs, decided once by its `plan` job and handed to the jobs after it:
 *
 *  - **Scope.** A branch's run while it is worked on (`ci-run.ts ci -f batch=true`) runs the unit tests its change
 *    reaches and OMPdesk's Rust checks only when the change touches what they read; types, biome, the surface policy
 *    and the build always run whole. The change is the branch against where it left `origin/main`, and the pick is
 *    `check:changed`'s (`scripts/changed-tests.ts`, `scripts/changed-readers.ts`), without its cap: every test that
 *    reaches a changed file through imports and named paths, every test naming one, and the tests that list the
 *    repository's folders. Everything runs on a push to main, a pull request, the landing gate (`-f mac=true`),
 *    `-f scope=full`, and a change to what decides how every test runs (the workflows, vitest's config, the packages).
 *    release.yml has no plan and stays whole.
 *  - **Shards.** How many jobs each vitest group gets, from what its files cost in the recorded runs
 *    (`scripts/test-timings.ts`): enough that a shard's tests take about `SHARD_SECONDS`, never so many that a shard is
 *    shorter than the group's longest file, and all groups together within this run's share of the account's jobs.
 *    Each job then takes its shard of the same record (`scripts/vitest-sequencer.ts`), so they end together.
 *
 * It writes the matrices to `$GITHUB_OUTPUT`, what it picked and why to the run's summary, and into `.ci/` the record
 * every job deals from and, for a picked run, the test files (`OMPDESK_TEST_FILES`, vitest.config.ts).
 *
 *   EVENT=workflow_dispatch SCOPE=changed bun scripts/ci-plan.ts   # the plan of this checkout, printed
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withoutGitSelectors } from "../src/shared/git-env";
import { changeBase, changedPaths, changedReaders, folderListers } from "./changed-readers";
import { changedScope } from "./changed-scope";
import { reachedTests, type SourceImports, sourceImports, TEST } from "./changed-tests";
import { RUNNER_LIMITS } from "./ci-run";
import { type Costs, loadTimings, UNMEASURED_SECONDS } from "./test-timings";
import seed from "./vitest-shard-costs.json";

/**
 * Worker seconds a vitest job gets through per second of wall time on a hosted runner (4 cores, 4 workers): 3.6 in
 * every node and Windows job of ci run 43482864186, 3.2 in the renderer's two.
 */
const WORKER_RATE = 3.6;
/**
 * The wall time a shard's tests aim at. With a job's 30 to 60 s of setup it ends under the 290 to 425 s `native` takes
 * on Windows, so vitest is not what a whole run waits for, at the seven test jobs a run had before (three, one and
 * three for the totals of 13 Nov 2026).
 */
const SHARD_SECONDS = 200;
/** Runs this repository has going at once on a working day (four on 13 Nov 2026 18:55 UTC); each gets a share. */
const RUNS_AT_ONCE = 3;
/** A run's jobs beside vitest's: static, build, `native` on Linux and on Windows. */
const OTHER_JOBS = 4;
/** vitest jobs one run may hold at once, so `RUNS_AT_ONCE` whole runs fit the account's cap. */
export const TEST_JOBS = Math.floor(RUNNER_LIMITS.jobs / RUNS_AT_ONCE) - OTHER_JOBS;

/** Why a run runs everything whatever changed, else nothing. */
export function askedWhole(ask: { event: string; scope: string; mac: boolean }): string | undefined {
	if (ask.event === "push") return "a push to main runs every test";
	if (ask.event !== "workflow_dispatch") return `a ${ask.event.replace("_", " ")} runs every test`;
	if (ask.mac) return "the landing gate (mac=true) runs every test";
	if (ask.scope === "full") return "asked for with scope=full";
	return undefined;
}

/** What every test job of a run is made of. Another workflow or action is a file like any other: tests read them. */
const RUN_ITSELF = [".github/workflows/ci.yml", ".github/actions/install/"];

/** Why this change runs everything, else nothing. */
export function changeWhole(changed: readonly string[]): string | undefined {
	if (changed.length === 0) return "the branch holds no change against main";
	const checks = changed.find(file => RUN_ITSELF.some(part => file.startsWith(part)));
	if (checks) return `${checks} changed: the checks themselves`;
	const runner = changed.find(file => changedScope([file]).allTests);
	return runner ? `${runner} changed: it decides how every test runs` : undefined;
}

/** The test files a change runs, each with why. */
export function pickedTests(
	changed: readonly string[],
	world: SourceImports,
	readers: readonly string[],
	listers: readonly string[],
): Map<string, string> {
	const picked = new Map<string, string>();
	for (const [test, from] of reachedTests(changed, world))
		picked.set(test, test === from ? "changed" : `reaches ${from}`);
	for (const test of readers) if (!picked.has(test)) picked.set(test, "names a changed file");
	for (const test of listers) if (!picked.has(test)) picked.set(test, "lists a folder of the repository");
	// A deleted test is a changed path with nothing to run.
	return new Map([...picked].filter(([test]) => world.files.has(test)).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * How many shards each group gets: its worker seconds over what a shard takes in `SHARD_SECONDS`, at most as many as
 * leave the average shard as long as the group's longest file (a shard cannot end before that file does), and, while
 * all groups together are over `budget`, one fewer for the group whose shards stay the lightest without it.
 */
export function shardCounts(groups: ReadonlyArray<{ seconds: number; longest: number }>, budget: number): number[] {
	const counts = groups.map(({ seconds, longest }) =>
		seconds === 0
			? 0
			: Math.max(
					1,
					Math.min(
						Math.ceil(seconds / (WORKER_RATE * SHARD_SECONDS)),
						Math.floor(seconds / (WORKER_RATE * longest)),
					),
				),
	);
	for (;;) {
		const spare = counts.flatMap((count, index) => (count > 1 ? [index] : []));
		if (counts.reduce((sum, count) => sum + count, 0) <= budget || spare.length === 0) return counts;
		const after = (index: number) => (groups[index]?.seconds ?? 0) / ((counts[index] ?? 2) - 1);
		const least = spare.reduce((a, b) => (after(a) <= after(b) ? a : b));
		counts[least] = (counts[least] ?? 1) - 1;
	}
}

interface Group {
	id: "node" | "renderer" | "win";
	/** The record's group: the runner's platform. */
	costs: "linux" | "win32";
	files: string[];
	/** The group's files of a whole run. */
	of: number;
	seconds: number;
	longest: number;
}

export interface Plan {
	scope: "changed" | "full";
	why: string;
	/** ci.yml's `check` matrix: the node and renderer projects on Linux. */
	check: { name: string; args: string; first: boolean }[];
	/** ci.yml's `win-platform` matrix. */
	win: { name: string; args: string }[];
	groups: (Group & { shards: number })[];
}

/** The groups' jobs. `tests` is every test file of the tree, `picked` the ones a change runs (absent: all). */
export function plan(
	scope: { why: string; picked?: ReadonlyMap<string, string> },
	tests: readonly string[],
	timings: Readonly<Record<string, Costs>>,
	windows: boolean,
	budget = TEST_JOBS,
): Plan {
	const renderer = (file: string) => file.startsWith("src/renderer/");
	const groups = (
		[
			{ id: "node", costs: "linux", has: (file: string) => !renderer(file) },
			{ id: "renderer", costs: "linux", has: renderer },
			...(windows ? [{ id: "win", costs: "win32", has: (file: string) => !renderer(file) } as const] : []),
		] as const
	).map(({ id, costs, has }): Group => {
		const all = tests.filter(has);
		const files = scope.picked ? all.filter(file => scope.picked?.has(file)) : all;
		const seconds = files.map(file => timings[costs]?.[file] ?? UNMEASURED_SECONDS);
		return {
			id,
			costs,
			files,
			of: all.length,
			seconds: Math.round(seconds.reduce((sum, cost) => sum + cost, 0)),
			longest: Math.max(0, ...seconds),
		};
	});
	const counts = shardCounts(groups, budget);
	const jobs = (id: Group["id"]) => {
		const count = counts[groups.findIndex(group => group.id === id)] ?? 0;
		return Array.from({ length: count }, (_, index) => ({
			label: count === 1 ? "" : `${index + 1}/${count}`,
			shard: count === 1 ? "" : `--shard=${index + 1}/${count}`,
		}));
	};
	return {
		scope: scope.picked ? "changed" : "full",
		why: scope.why,
		check: (["node", "renderer"] as const).flatMap(id =>
			jobs(id).map(({ label, shard }, index) => ({
				name: `${id} ${label}`.trim(),
				args: `--project=${id} ${shard}`.trim(),
				first: id === "node" && index === 0,
			})),
		),
		win: jobs("win").map(({ label, shard }) => ({ name: label || "1/1", args: shard })),
		groups: groups.map((group, index) => ({ ...group, shards: counts[index] ?? 0 })),
	};
}

const git = (args: string[]) =>
	execFileSync("git", args, { env: withoutGitSelectors(process.env), encoding: "utf8", maxBuffer: 64 << 20 })
		.split("\n")
		.filter(Boolean);

/**
 * The changed files OMPdesk's Rust checks read: the workspace's own, the two actions the `native` job is, and what the
 * sources read by a path that climbs out of the workspace (`include_str!("../../…/scripts/mac-signing.json")`).
 */
function rustInputs(changed: readonly string[]): string[] {
	const read = ["native/ompdesk/", ".github/actions/native-check/", ".github/actions/native-toolchain/"];
	const outside = new Set(
		git(["grep", "-o", "-E", String.raw`"(\.\./)+[^"]+"`, "--", "native/ompdesk/*.rs"]).map(line => {
			const cut = line.indexOf(":");
			return path.posix.join(path.posix.dirname(line.slice(0, cut)), line.slice(cut + 2, -1));
		}),
	);
	return changed.filter(file => read.some(part => file.startsWith(part)) || outside.has(file));
}

function summary(
	made: Plan,
	base: string,
	changed: readonly string[],
	rust: string,
	picked?: ReadonlyMap<string, string>,
) {
	const all = made.groups.filter(group => group.id !== "win");
	const count = (of: (group: Group) => number) => all.reduce((sum, group) => sum + of(group), 0);
	const lines = [
		made.scope === "full"
			? `### Scope: everything (${made.why})`
			: `### Scope: the change (${count(group => group.files.length)} of ${count(group => group.of)} test files)`,
		"",
		...(picked
			? [`${changed.length} file(s) changed since \`${base.slice(0, 9)}\`, where this branch left main.`, ""]
			: []),
		"| Job | Test files | Recorded worker time | Shards | A shard's tests |",
		"| --- | --- | --- | --- | --- |",
		...made.groups.map(
			group =>
				`| ${group.id === "win" ? "win-platform" : `check (${group.id})`} | ${group.files.length} of ${group.of} | ${group.seconds} s | ${group.shards} | ${group.shards ? `~${Math.round(Math.max(group.longest, group.seconds / group.shards / WORKER_RATE))} s` : "not run"} |`,
		),
		`| native | | | | ${rust} |`,
		"| static, build | | | | always whole |",
		"",
	];
	if (picked) {
		const why = new Map<string, number>();
		for (const reason of picked.values()) why.set(reason, (why.get(reason) ?? 0) + 1);
		lines.push(
			"| Why | Test files |",
			"| --- | --- |",
			...[...why].sort((a, b) => b[1] - a[1]).map(([reason, tests]) => `| ${reason} | ${tests} |`),
			"",
			"<details><summary>Every test file this run picked</summary>",
			"",
			...[...picked].map(([test, reason]) => `- \`${test}\`: ${reason}`),
			"",
			"</details>",
			"",
			"Everything runs with `-f scope=full`, at the landing gate (`-f mac=true`) and on every push to main.",
		);
	}
	return lines.join("\n");
}

if (import.meta.main) {
	const env = process.env;
	const record = env.OMPDESK_TEST_TIMINGS ?? ".ci/test-timings.json";
	const timings = loadTimings(existsSync(record) ? record : undefined, seed);
	const world = sourceImports();
	const tests = [...world.files].filter(file => TEST.test(file) && !file.startsWith("tmp/")).sort();
	let whole = askedWhole({ event: env.EVENT ?? "", scope: env.SCOPE ?? "", mac: env.MAC === "true" });
	let base = "";
	let changed: string[] = [];
	if (!whole) {
		try {
			base = changeBase(env.BASE_REF ?? "origin/main");
			changed = changedPaths(base);
			whole = changeWhole(changed);
		} catch {
			whole = "this branch and main share no commit here";
		}
	}
	const picked = whole ? undefined : pickedTests(changed, world, changedReaders(base), folderListers());
	const made = plan(
		{ why: whole ?? "the change", picked },
		tests,
		timings,
		env.WINDOWS === "true" && env.EVENT !== "pull_request",
	);
	const rust = picked ? rustInputs(changed) : [];
	const native = !picked || rust.length > 0;
	const text = summary(
		made,
		base,
		changed,
		!native ? "not run: the change touches nothing its checks read" : picked ? `runs: ${rust[0]} changed` : "runs",
		picked,
	);
	console.log(text);
	mkdirSync(path.dirname(record), { recursive: true });
	writeFileSync(record, `${JSON.stringify(timings)}\n`);
	if (picked)
		writeFileSync(path.join(path.dirname(record), "test-files.json"), `${JSON.stringify([...picked.keys()])}\n`);
	if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
	if (env.GITHUB_OUTPUT)
		appendFileSync(
			env.GITHUB_OUTPUT,
			[
				`scope=${made.scope}`,
				`check=${JSON.stringify(made.check)}`,
				`win=${JSON.stringify(made.win)}`,
				`native=${native}`,
				"",
			].join("\n"),
		);
}
