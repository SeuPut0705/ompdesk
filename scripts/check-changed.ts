/**
 * The agent's default edit loop (AGENTS.md › Build, test): the checks that can
 * fail because of what changed, in seconds instead of the release gate's
 * minutes. It holds no lock as a whole (`scripts/build-lock.ts`): the checks
 * take a `vitest` slot, the build the `build` slot, Playwright a `playwright` slot.
 *
 *   bun run check:changed [--base <ref>] [--no-e2e] [--list]
 *
 * "Changed" is the working tree against HEAD (or `--base`) plus untracked files, under `src/`, `e2e/`,
 * `resources/`, `scripts/` and the root configuration (`scripts/changed-scope.ts`): a root build input also builds,
 * and a test-runner input (vitest's config, package.json, bun.lock) runs the whole vitest suite.
 *
 * 1. Side by side: typecheck (always whole: a type error shows up far from the
 *    edit), biome on the changed files, the surface policy, and `vitest related`
 *    (every test file that imports a changed file, directly or transitively).
 * 2. Then, unless `--no-e2e` or nothing matches: `bun run build` (reused when
 *    out/ matches) and the Playwright specs that touch what changed: a changed
 *    spec, a spec whose file name or text mentions a changed source file's
 *    name (`layout/work-board/WorkBoard.tsx` finds `e2e/work-board.e2e.ts`), or a
 *    spec that uses the English text a changed component shows ("Search themes…";
 *    `scripts/changed-specs.ts`), and for a stylesheet the components using the classes of
 *    the rules it touched. That is a name match, not a dependency graph; the release gate (`bun run gate`)
 *    still runs every spec. A browser of Playwright's own (`chromium`,
 *    `webkit`) a picked spec imports but that is not installed gets one
 *    warning line, before the specs and again after a failed run.
 * 3. A change to e2e shared support (harness, fixtures) matches no single spec:
 *    the run says so and runs none; use `bunx playwright test <spec>` for the
 *    ones you touched.
 *
 * `--list` prints the chosen specs and exits without taking the lock.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { en } from "../src/renderer/locales/en";
import { acquireLock, describeExit, type RunResult, run, runLocked } from "./build-lock";
import { changedScope } from "./changed-scope";
import { specsFor } from "./changed-specs";
import { browsersNeeded, missingBrowsers, missingBrowsersNotice } from "./e2e-browsers";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "HEAD";

const git = (...a: string[]) =>
	execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 << 20 })
		.split("\n")
		.filter(Boolean);
const scope = changedScope(
	[...git("diff", "--name-only", base, "--"), ...git("ls-files", "-o", "--exclude-standard")].filter(file =>
		existsSync(file),
	),
);
const changed = scope.files;
const sourceChanged = changed.filter(file => /^(?:src|e2e|resources|scripts)\//.test(file));

/** A file's changed lines against `base` in the new file (1-based); an untracked file is changed throughout. */
function changedLines(file: string): number[] {
	const hunks = git("diff", "-U0", base, "--", file).filter(line => line.startsWith("@@"));
	if (hunks.length === 0)
		return readFileSync(file, "utf8")
			.split("\n")
			.map((_, index) => index + 1);
	return hunks.flatMap(hunk => {
		const [, from, count] = /\+(\d+)(?:,(\d+))?/.exec(hunk) ?? [];
		const start = Number(from);
		const length = count === undefined ? 1 : Number(count);
		// A deletion (`+N,0`) sits between line N and N+1: both may close or open the rule it touched.
		return length === 0 ? [start, start + 1] : Array.from({ length }, (_, index) => start + index);
	});
}

/** The renderer's source files whose text names a class (`git grep`, tracked files). */
function rendererSourcesNaming(className: string): string[] {
	try {
		return git("grep", "-l", "-F", className, "--", "src/renderer/*.ts", "src/renderer/*.tsx");
	} catch {
		return [];
	}
}

const BIOME_EXT = /\.(?:[cm]?[jt]sx?|json|jsonc|css)$/;
const BIOME_DIRS = /^(?:(?:src|e2e|resources|scripts)\/|[^/]+$)/;
const specs = flag("--no-e2e")
	? []
	: specsFor(sourceChanged, {
			specs: new Map(
				readdirSync("e2e")
					.filter(name => name.endsWith(".e2e.ts"))
					.map(spec => [spec, readFileSync(path.join("e2e", spec), "utf8")]),
			),
			read: file => readFileSync(file, "utf8"),
			strings: en,
			changedLines: file => changedLines(file),
			usersOf: className => rendererSourcesNaming(className),
		});
const supportChanged = changed.some(file => /^e2e\/(?!.*\.e2e\.ts$)/.test(file));

if (flag("--list")) {
	console.log(`changed (${changed.length}):\n${changed.map(file => `  ${file}`).join("\n")}`);
	console.log(`specs (${specs.length}):\n${specs.map(spec => `  ${spec}`).join("\n")}`);
	process.exit(0);
}
if (changed.length === 0) {
	console.log(`[check:changed] nothing changed against ${base}`);
	process.exit(0);
}

const biomeFiles = changed.filter(file => BIOME_DIRS.test(file) && BIOME_EXT.test(file));
const relatedFiles = changed.filter(file => /^(?:src|resources|scripts)\//.test(file) && /\.[cm]?[jt]sx?$/.test(file));
const CHECKS: Array<readonly [string, string[]]> = [["types", ["bun", "run", "check:types"]]];
// biome.json ignores some of these (stylesheets): a change of only those is no failure.
if (biomeFiles.length > 0)
	CHECKS.push(["biome", ["bunx", "biome", "check", "--no-errors-on-unmatched", ...biomeFiles]]);
CHECKS.push(["surfaces", ["node", "scripts/lint-surfaces.mjs"]]);
if (scope.allTests) CHECKS.push(["vitest", ["bunx", "vitest", "run"]]);
else if (relatedFiles.length > 0) {
	CHECKS.push(["vitest", ["bunx", "vitest", "related", "--run", "--passWithNoTests", ...relatedFiles]]);
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
console.log(
	`[check:changed] ${changed.length} changed file(s); ${CHECKS.map(([name]) => name).join(", ")} side by side`,
);
// The static checks and vitest side by side in one vitest slot; the build and Playwright take their own slots after.
const held = await acquireLock(["bun", "run", "check:changed"], { kind: "vitest", via: "check:changed" });
const started = performance.now();
const results = await Promise.all(
	CHECKS.map(async ([name, command]): Promise<readonly [string, RunResult]> => {
		const result = await run(command, { capture: true });
		if (result.code !== 0)
			console.log(`\n[check:changed] ✗ ${name} (${describeExit(result)})\n${result.output.trimEnd()}\n`);
		console.log(`[check:changed] ${result.code === 0 ? "✓" : "✗"} ${name} ${seconds(result.ms)}`);
		return [name, result];
	}),
);
held.release(results.some(([, result]) => result.code !== 0) ? 1 : 0);
const failed = results.filter(([, result]) => result.code !== 0).map(([name]) => name);
if (failed.length > 0) {
	console.log(`[check:changed] FAILED: ${failed.join(", ")}`);
	process.exit(1);
}
if (supportChanged && specs.length === 0) {
	console.log(
		"[check:changed] e2e support files changed but no spec matched; run the specs you touched with `bunx playwright test <spec>`",
	);
}
if (specs.length === 0) {
	// App source, resources or a root build input can break the bundle (an import main cannot resolve, the bundle check)
	// without touching a spec's name.
	if (scope.build) {
		console.log("[check:changed] build (a build input changed)");
		const build = await runLocked("build", ["bun", "run", "build"], { via: "check:changed" });
		if (build.code !== 0) process.exit(1);
	}
	console.log(`[check:changed] PASSED in ${seconds(performance.now() - started)} (no e2e spec matches the change)`);
	process.exit(0);
}
// A Playwright upgrade leaves its browsers to `playwright install`: say so in one line, here and after a failed run,
// instead of leaving it to every phone spec's launch error. Only a warning: a spec that imports a browser may skip.
const browsersOf = new Map(specs.map(spec => [spec, browsersNeeded(readFileSync(spec, "utf8"))]));
const browserNotice = missingBrowsersNotice(
	specs,
	browsersOf,
	await missingBrowsers([...new Set([...browsersOf.values()].flat())]),
);
if (browserNotice) console.log(`[check:changed] warning: ${browserNotice}`);
console.log(`[check:changed] build, then ${specs.length} spec file(s): ${specs.join(" ")}`);
const build = await runLocked("build", ["bun", "run", "build"], { via: "check:changed" });
if (build.code !== 0) process.exit(1);
// An opt-in spec (the responsive audit, a capture run) registers no test without its env: the specs exist, so
// "no tests found" means only that, never a pick gone wrong.
const e2e = await runLocked("playwright", ["bunx", "playwright", "test", "--pass-with-no-tests", ...specs], {
	via: "check:changed",
});
if (e2e.code !== 0 && browserNotice) console.log(`[check:changed] ${browserNotice}`);
console.log(
	`[check:changed] ${e2e.code === 0 ? "PASSED" : "FAILED: playwright"} in ${seconds(performance.now() - started)}`,
);
process.exit(e2e.code === 0 ? 0 : 1);
