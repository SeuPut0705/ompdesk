/**
 * The stock modules the stock helper's `git.worktree_location` reads (resources/gui-bridge/stock-helper/worktrees.ts),
 * for the fake omp install (`fixtureOmp`): the same root and hash the fake bridge's `git.worktree_location`
 * answers (e2e/fixture/rpc-ui.ts), so a worktree made without a session lands where one made through a tab does.
 */
import * as nodePath from "node:path";

let override: string | undefined;

export const Settings = { loadReadOnly: async (_options: { cwd: string }) => ({}) };
export const cfgWorktreeBase = { get: (_settings: unknown): string | undefined => undefined };

export function setWorktreesDir(dir: string | undefined): string | undefined {
	override = dir;
	return dir;
}

export function getWorktreesDir(): string {
	return process.env.OMP_WORKTREE_DIR ?? override ?? nodePath.join(process.env.PI_CODING_AGENT_DIR ?? "", "wt");
}

export function hashPath(absPath: string): string {
	return Bun.hash(nodePath.resolve(absPath)).toString(16).padStart(16, "0").slice(-7);
}
