import { run } from "./proc";

export interface DriftResult {
	status: "ok" | "drift" | "unstamped" | "bad-commit" | "git-error" | "no-covers";
	/** Covered files that differ from the sync commit. */
	files: string[];
	message: string;
}

/** Runs git in the code root; `ok` is false when git is missing or exits non-zero. */
export async function git(codeRoot: string, args: string[]): Promise<{ ok: boolean; out: string }> {
	const result = await run("git", args, { cwd: codeRoot, timeoutMs: 60_000 });
	return { ok: !result.spawnError && result.code === 0, out: `${result.stdout}${result.stderr}`.trim() };
}

/**
 * Did the files a model covers change since the commit at which it was last confirmed? The working tree is
 * compared with the sync commit, so uncommitted edits count too.
 */
export async function checkDrift(codeRoot: string, covers: string[], syncCommit: string | null): Promise<DriftResult> {
	if (covers.length === 0) return { status: "no-covers", files: [], message: "no covered files listed" };
	if (!syncCommit) {
		return {
			status: "unstamped",
			files: [],
			message: "no syncCommit yet: the model was never confirmed against the code (use --stamp)",
		};
	}
	const known = await git(codeRoot, ["cat-file", "-e", `${syncCommit}^{commit}`]);
	if (!known.ok)
		return {
			status: "bad-commit",
			files: [],
			message: `syncCommit ${syncCommit} is not a commit of this repository`,
		};
	const changed = await git(codeRoot, ["diff", "--name-only", syncCommit, "--", ...covers]);
	if (!changed.ok)
		return { status: "git-error", files: [], message: `git diff failed: ${changed.out.split(/\r?\n/)[0]}` };
	const files = changed.out.split(/\r?\n/).filter(Boolean);
	if (files.length === 0)
		return { status: "ok", files, message: `covered files unchanged since ${syncCommit.slice(0, 10)}` };
	return {
		status: "drift",
		files,
		message: `DRIFT: ${files.length} covered file(s) changed since ${syncCommit.slice(0, 10)}; check the model still describes them, then re-stamp`,
	};
}

/** True when covered files have uncommitted changes (a stamp of HEAD would not describe them). */
export async function hasUncommitted(codeRoot: string, covers: string[]): Promise<boolean> {
	if (covers.length === 0) return false;
	const status = await git(codeRoot, ["status", "--porcelain", "--", ...covers]);
	return status.out.length > 0;
}
