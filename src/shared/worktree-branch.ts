/**
 * Settings › Project folders › Worktree branch prefix (C82): what new worktree
 * branches start with. Unset keeps the defaults: `omp/gui/<name>` for a
 * worktree tab and stock's `wt/<timestamp>` for a session worktree
 * (`worktree.onStart`). Read in the renderer (preview, worktree_create), in
 * main (the session-worktree start) and checked again where the branch is made.
 */
export const WORKTREE_BRANCH_PREFIX_PREF = "worktreeBranchPrefix";
export const GUI_WORKTREE_BRANCH_PREFIX = "omp/gui/";
export const WORKTREE_BRANCH_PREFIX_MAX = 40;

/**
 * The prefix when git accepts it in front of a branch name (a subset of
 * `git check-ref-format`: letters, digits, `.`, `_`, `-`, `/`; no empty, dotted or
 * `.lock` path segment, no `..`), ending in `/`, `-` or `_` so it reads apart from
 * the name; else null.
 */
export function worktreeBranchPrefix(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const prefix = raw.trim();
	if (prefix.length === 0 || prefix.length > WORKTREE_BRANCH_PREFIX_MAX) return null;
	if (!/^[A-Za-z0-9._/-]+$/.test(prefix) || !/[/_-]$/.test(prefix) || prefix.includes("..")) return null;
	if (prefix.startsWith("-")) return null;
	const segments = prefix.split("/");
	// The last segment is the start of the branch's own name, so only the folders before it must be whole.
	return segments
		.slice(0, -1)
		.every(segment => segment.length > 0 && !segment.startsWith(".") && !segment.endsWith(".lock")) &&
		!(segments.at(-1) ?? "").startsWith(".")
		? prefix
		: null;
}
