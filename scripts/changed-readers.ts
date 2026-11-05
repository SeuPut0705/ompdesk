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

/** Every path changed against `base`: the working tree's diff, deleted files included, and the untracked files. */
export function changedPaths(base: string, cwd?: string): string[] {
	return [
		...new Set([
			...git(["diff", "--name-only", base, "--"], cwd),
			...git(["ls-files", "-o", "--exclude-standard"], cwd),
		]),
	];
}

/** The tracked unit tests whose text names a file changed against `base`, a deleted one included, by its file name. */
export function changedReaders(base: string, cwd?: string): string[] {
	const names = [...new Set(changedPaths(base, cwd).map(file => path.basename(file)))];
	if (names.length === 0) return [];
	try {
		return git(
			["grep", "-l", "-F", ...names.flatMap(name => ["-e", name]), "--", "*.test.ts", "*.test.tsx", "*.test.mjs"],
			cwd,
		);
	} catch {
		// `git grep` exits 1 when nothing matches.
		return [];
	}
}
