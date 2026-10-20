/** Dev harness: the unused worktrees `get_orphan_worktrees` lists (Work tree view), one of each state. */
import type { DiskCareState, SavedWorktree, SavedWorktreeRestore } from "../../shared/disk-care";
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

/** The worktrees disk care saved and removed (`get_saved_worktrees`): one with a private archive, one without. */
export function savedWorktrees(now = Date.now()): { worktrees: SavedWorktree[] } {
	const DAY = 24 * HOUR;
	return {
		worktrees: [
			{
				id: "saved-1",
				path: "/Users/me/.omp/wt/gui-agent-billing-1a2b3c4",
				repo: "/Users/me/acme-web",
				branch: "omp/agent/billing",
				head: "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432",
				savedBranch: "omp/saved/billing",
				removedAt: now - 2 * DAY,
				archivedFiles: 12,
				archivedBytes: 4_300_000,
			},
			{
				id: "saved-2",
				path: "/Users/me/.omp/wt/gui-agent-lint-1a2b3c4",
				repo: "/Users/me/acme-web",
				branch: null,
				head: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
				savedBranch: "omp/saved/lint",
				removedAt: now - 9 * DAY,
				archivedFiles: 0,
				archivedBytes: 0,
			},
		],
	};
}

export function savedWorktreeRestore(): SavedWorktreeRestore {
	return {
		path: "/Users/me/.omp/wt/gui-agent-billing-1a2b3c4",
		branch: "omp/agent/billing",
		archive: { restored: 12, skipped: 0 },
	};
}

/** What `diskCare.getState` answers: a measured disk and the last run's freed bytes. */
export function diskCareState(now = Date.now()): DiskCareState {
	const GB = 1_073_741_824;
	return {
		running: false,
		automatic: true,
		usage: {
			measuredAt: now - 5 * 60_000,
			total: 14.2 * GB,
			parts: [
				{ id: "worktrees", bytes: 9.1 * GB, path: "/Users/me/.omp/wt" },
				{ id: "sessions", bytes: 2.4 * GB, path: "/Users/me/.omp/agent/sessions" },
				{ id: "ompLogs", bytes: 0.3 * GB, path: "/Users/me/.omp/logs" },
				{ id: "stats", bytes: 0.1 * GB, path: "/Users/me/.omp/stats" },
				{ id: "appData", bytes: 1.2 * GB, path: "/Users/me/Library/Application Support/OMPdesk" },
				{ id: "bunCache", bytes: 1.1 * GB, path: "/Users/me/.bun/install/cache" },
			],
		},
		lastRun: {
			trigger: "daily",
			startedAt: now - 3 * 60 * 60_000,
			endedAt: now - 3 * 60 * 60_000 + 40_000,
			freedBytes: 3.6 * GB,
			actions: [
				{ kind: "artifacts", count: 4, bytes: 2.9 * GB },
				{ kind: "worktree-saved", count: 1, bytes: 0.7 * GB },
			],
			kept: 1,
			failed: 0,
		},
	};
}
