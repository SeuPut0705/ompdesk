/** Stock `omp worktree list|clear --json` with no agent worktrees (AgentWorktreesRow.test.tsx covers the listing). */
export function runWorktree(): void {
	console.log(JSON.stringify(process.argv[3] === "clear" ? { removed: 0, kept: 0 } : []));
}
