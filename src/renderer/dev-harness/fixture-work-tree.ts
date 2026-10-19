/** Dev harness: the unused worktrees `get_orphan_worktrees` lists (Work tree view), one of each state. */
import type { RpcOrphanWorktrees } from "../../shared/rpc-types";

const HOUR = 60 * 60_000;

export function orphanWorktrees(now = Date.now()): RpcOrphanWorktrees {
	const at = (hours: number) => now - hours * HOUR;
	return {
		root: "/Users/me/.omp/wt",
		worktrees: [
			{
				path: "/Users/me/.omp/wt/gui-agent-parser-1a2b3c4",
				branch: "omp/agent/parser",
				repo: "/Users/me/acme-web",
				state: "landed",
				squashed: true,
				commitsAhead: 0,
				dirtyFiles: 0,
				modifiedAt: at(3),
			},
			{
				path: "/Users/me/.omp/wt/gui-agent-docs-1a2b3c4",
				branch: "omp/agent/docs",
				repo: "/Users/me/acme-web",
				state: "landed",
				commitsAhead: 0,
				dirtyFiles: 0,
				modifiedAt: at(26),
			},
			{
				path: "/Users/me/.omp/wt/gui-agent-spike-1a2b3c4",
				branch: "omp/agent/spike",
				repo: "/Users/me/acme-web",
				state: "untouched",
				commitsAhead: 0,
				dirtyFiles: 0,
				modifiedAt: at(50),
			},
			{
				path: "/Users/me/.omp/wt/gui-agent-cache-1a2b3c4",
				branch: "omp/agent/cache",
				repo: "/Users/me/acme-web",
				state: "unlanded",
				commitsAhead: 3,
				dirtyFiles: 0,
				modifiedAt: at(5),
			},
			{
				path: "/Users/me/.omp/wt/gui-agent-ui-1a2b3c4",
				branch: "omp/agent/ui",
				repo: "/Users/me/acme-web",
				state: "dirty",
				commitsAhead: 1,
				dirtyFiles: 4,
				modifiedAt: at(1),
			},
		],
	};
}
