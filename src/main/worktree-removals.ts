/**
 * The one reservation between removing a worktree and opening a tab in it. A removal (worktree-orphans.ts) claims
 * its folder synchronously, after checking that no open session uses it, and holds it until git is done; a tab that
 * would start in a claimed folder (SidecarPool.acquire, LocalHostServices' tab.open for a paired device) is refused
 * meanwhile. Check and claim, and acquire and its entry becoming an open folder, each run without an await between
 * them, so neither side can slip in between the other's check and its effect.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isInside } from "./local/git/parse";
import { LocalCommandError } from "./local/types";

const removing = new Set<string>();

function real(folder: string): string {
	try {
		return fs.realpathSync.native(folder);
	} catch {
		return path.resolve(folder);
	}
}

const covers = (worktree: string, folder: string) => folder === worktree || isInside(worktree, folder);

/** A removal holds `cwd` (it is that worktree or inside it): a tab must not start there. */
export function removalHolds(cwd: string): boolean {
	if (removing.size === 0) return false;
	const folder = real(cwd);
	for (const worktree of removing) if (covers(worktree, folder)) return true;
	return false;
}

/**
 * Run `remove` holding `worktree` (a real path): refused with `in_use` when one of `openFolders` (every open
 * session's folder, read now) is that worktree or inside it, or another removal holds it.
 */
export async function withRemovalClaim<T>(
	worktree: string,
	openFolders: () => readonly string[],
	remove: () => Promise<T>,
): Promise<T> {
	if (removing.has(worktree) || openFolders().some(folder => covers(worktree, real(folder))))
		throw new LocalCommandError(`${worktree} is in use by an open session; nothing was removed.`, "in_use");
	removing.add(worktree);
	try {
		return await remove();
	} finally {
		removing.delete(worktree);
	}
}
