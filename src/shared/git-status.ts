/** Porcelain v1 `XY` status helpers shared by main's source-control commands and the Changes panel. */

/** An unmerged path (`git status` "Unmerged paths": any `U`, or both added / both deleted). */
export function isConflictStatus(status: string): boolean {
	return status.includes("U") || status === "AA" || status === "DD";
}

/** How much of a path's change sits in the index: none, part (index and worktree differ) or all. */
export function stagedState(status: string): "none" | "partial" | "all" {
	const index = status[0] ?? " ";
	const worktree = status[1] ?? " ";
	if (index === " " || index === "?" || isConflictStatus(status)) return "none";
	return worktree === " " ? "all" : "partial";
}
