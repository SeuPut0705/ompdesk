/**
 * The agent's default edit loop (AGENTS.md › Build, test): the checks that can
 * fail because of what changed, in one lock hold, in seconds instead of the
 * release gate's minutes.
 *
 *   bun run check:changed [--base <ref>] [--no-e2e] [--list]
 *
 * "Changed" is the working tree against HEAD (or `--base`) plus untracked files.
 *
 * 1. Side by side: typecheck (always whole: a type error shows up far from the
 *    edit), biome on the changed files, the surface policy, and `vitest related`
 *    (every test file that imports a changed file, directly or transitively).
 * 2. Then, unless `--no-e2e` or nothing matches: `bun run build` (reused when
 *    out/ matches) and the Playwright specs that touch what changed: a changed
 *    spec, or a spec whose file name or text mentions a changed source file's
 *    name (`layout/WorkBoard.tsx` finds `e2e/work-board.e2e.ts`). That is a
 *    name match, not a dependency graph; the release gate (`bun run gate`)
 *    still runs every spec.
 * 3. A change to e2e shared support (harness, fixtures) matches no single spec:
 *    the run says so and runs none; use `bunx playwright test <spec>` for the
 *    ones you touched.
 *
 * `--list` prints the chosen specs and exits without taking the lock.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { acquireLock, type RunResult, run } from "./build-lock";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "HEAD";

const git = (...a: string[]) =>
	execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 << 20 })
		.split("\n")
		.filter(Boolean);
const changed = [
	...new Set([...git("diff", "--name-only", base, "--"), ...git("ls-files", "-o", "--exclude-standard")]),
]
	.filter(file => /^(?:src|e2e|resources|scripts)\//.test(file) && existsSync(file))
	.sort();

const BIOME_EXT = /\.(?:[cm]?[jt]sx?|json|jsonc|css)$/;
const BIOME_DIRS = /^(?:src|e2e|resources|scripts)\//;
const isTest = (file: string) => /\.(?:test|spec|bench)\.[cm]?[jt]sx?$/.test(file);

/**
 * Words a source file answers to in a spec: `layout/WorkBoard.tsx` → work-board,
 * workboard; `auto-title-core.ts` → auto-title-core and auto-title.
 */
function names(file: string): string[] {
	const stem = path.basename(file).replace(/(?:\.(?:test|spec))?\.[^.]+$/, "");
	const kebab = stem
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/_/g, "-")
		.toLowerCase();
	const bare = kebab.replace(/-(?:core|engine|contracts|service|store|stock|runner|utils|types)$/, "");
	return [...new Set([kebab, bare, bare.replace(/-/g, ""), stem])].filter(
		name => name.length >= 6 && name !== "index",
	);
}

function specsFor(files: string[]): string[] {
	const specs = readdirSync("e2e").filter(name => name.endsWith(".e2e.ts"));
	const picked = new Set<string>();
	const sources: string[] = [];
	for (const file of files) {
		if (file.startsWith("e2e/") && file.endsWith(".e2e.ts")) picked.add(path.basename(file));
		else if (/^(?:src|resources)\//.test(file) && !isTest(file)) sources.push(file);
	}
	const texts = new Map(specs.map(spec => [spec, readFileSync(path.join("e2e", spec), "utf8")]));
	for (const file of sources) {
		for (const name of names(file)) {
			for (const spec of specs) {
				// A plain lowercase word ("window", "changes") is in every spec's text; only a
				// hyphenated or camel-case name is distinctive enough to match the text.
				const inText = /[-A-Z]/.test(name) && texts.get(spec)?.includes(name);
				if (spec.includes(name) || inText) picked.add(spec);
			}
		}
	}
	return [...picked].sort().map(spec => `e2e/${spec}`);
}

const specs = flag("--no-e2e") ? [] : specsFor(changed);
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
if (biomeFiles.length > 0) CHECKS.push(["biome", ["bunx", "biome", "check", ...biomeFiles]]);
CHECKS.push(["surfaces", ["node", "scripts/lint-surfaces.mjs"]]);
if (relatedFiles.length > 0) {
	CHECKS.push(["vitest", ["bunx", "vitest", "related", "--run", "--passWithNoTests", ...relatedFiles]]);
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
await acquireLock(["bun", "run", "check:changed"]);
const started = performance.now();
console.log(
	`[check:changed] ${changed.length} changed file(s); ${CHECKS.map(([name]) => name).join(", ")} side by side`,
);
const results = await Promise.all(
	CHECKS.map(async ([name, command]): Promise<readonly [string, RunResult]> => {
		const result = await run(command, { capture: true });
		if (result.code !== 0)
			console.log(`\n[check:changed] ✗ ${name} (exit ${result.code})\n${result.output.trimEnd()}\n`);
		console.log(`[check:changed] ${result.code === 0 ? "✓" : "✗"} ${name} ${seconds(result.ms)}`);
		return [name, result];
	}),
);
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
	console.log(`[check:changed] PASSED in ${seconds(performance.now() - started)} (no e2e spec matches the change)`);
	process.exit(0);
}
console.log(`[check:changed] build, then ${specs.length} spec file(s): ${specs.join(" ")}`);
const build = await run(["bun", "run", "build"]);
if (build.code !== 0) process.exit(1);
const e2e = await run(["bunx", "playwright", "test", ...specs]);
console.log(
	`[check:changed] ${e2e.code === 0 ? "PASSED" : "FAILED: playwright"} in ${seconds(performance.now() - started)}`,
);
process.exit(e2e.code === 0 ? 0 : 1);
