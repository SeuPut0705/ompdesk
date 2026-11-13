/**
 * The unit tests a change reaches without an import (`scripts/check-changed.ts`). A test whose text names a file by its
 * file name reads it as text (a stylesheet's rules, a component's classes, CHANGELOG.md raw), so `vitest related`, which
 * follows imports, never reached it: on 6 Nov 2026 a settings row's padding and then a changelog section turned main red
 * while check:changed passed. A deleted file counts as well: a test that reads it fails now.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { withoutGitSelectors } from "../src/shared/git-env";

const git = (args: string[], cwd?: string) =>
	execFileSync("git", args, { cwd, env: withoutGitSelectors(process.env), encoding: "utf8", maxBuffer: 64 << 20 })
		.split("\n")
		.filter(Boolean);

/**
 * The commit a change is measured from: `HEAD` as given, any other ref by where this branch left it (`git merge-base`),
 * so `--base origin/main` on a branch behind it counts this branch's own work, not what landed on main since.
 */
export function changeBase(base: string, cwd?: string): string {
	return base === "HEAD" ? base : (git(["merge-base", base, "HEAD"], cwd)[0] ?? base);
}

/** Every path changed against `base`: the working tree's diff, deleted files included, and the untracked files. */
export function changedPaths(base: string, cwd?: string): string[] {
	return [
		...new Set([
			...git(["diff", "--name-only", base, "--"], cwd),
			...git(["ls-files", "-o", "--exclude-standard"], cwd),
		]),
	];
}

const TESTS = ["*.test.ts", "*.test.tsx", "*.test.mjs"];

/** The tracked test files `git grep` finds; it exits 1 when nothing matches. */
function testsMatching(args: string[], cwd?: string): string[] {
	try {
		return git(["grep", "-l", ...args, "--", ...TESTS], cwd);
	} catch {
		return [];
	}
}

/** The tracked unit tests whose text names a file changed against `base`, a deleted one included, by its file name. */
export function changedReaders(base: string, cwd?: string): string[] {
	const names = [...new Set(changedPaths(base, cwd).map(file => path.basename(file)))];
	return names.length === 0 ? [] : testsMatching(["-F", ...names.flatMap(name => ["-e", name])], cwd);
}

/**
 * The tracked unit tests that list a folder of the repository from their own place (the workflows, the rule files, a
 * skill pack, the stylesheets): what a file added to or taken from such a folder reaches, with no test importing or
 * naming it. A run that picks its tests by a change runs these whatever changed (`scripts/ci-plan.ts`; 33 files and
 * 34 s of the node project's 1681 s in ci run 43484284198).
 */
export function folderListers(cwd?: string): string[] {
	return testsMatching(
		[
			"--all-match",
			"-E",
			...["-e", String.raw`readdir(Sync)?\(|globSync\(|new Glob\(|import\.meta\.glob`],
			...["-e", String.raw`__dirname|import\.meta\.(dirname|url)|process\.cwd\(\)`],
		],
		cwd,
	);
}
