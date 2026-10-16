import * as fs from "node:fs";

/** Stock `omp worktree list|clear --json`. */
export function runWorktree(): void {
	// Stock `omp worktree list|clear --json` over a JSON file of WorktreeEntry rows
	// (`OMP_GUI_TEST_AGENT_WORKTREES`; none when unset). clear drops the orphaned ones.
	const file = process.env.OMP_GUI_TEST_AGENT_WORKTREES;
	const entries: { path: string; orphanReason?: string }[] =
		file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
	if (process.argv[3] === "clear") {
		const targets = entries.filter(entry => entry.orphanReason !== undefined);
		if (targets.length === 0) console.log(JSON.stringify({ removed: 0, kept: entries.length }));
		else {
			if (file) fs.writeFileSync(file, JSON.stringify(entries.filter(entry => entry.orphanReason === undefined)));
			const results = targets.map(entry => ({ path: entry.path, ok: true }));
			console.log(JSON.stringify({ removed: targets.length, failed: 0, results }));
		}
	} else console.log(JSON.stringify(entries));
}
