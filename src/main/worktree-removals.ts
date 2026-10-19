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

/**
 * The one form both sides compare: the OS's real path (Windows: the long name of an 8.3 path, the drive and every
 * part in their on-disk case, native separators), or the resolved path of a folder that does not exist.
 */
export function realFolder(folder: string): string {
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
	const folder = realFolder(cwd);
	for (const worktree of removing) if (covers(worktree, folder)) return true;
	return false;
}

/**
 * Run `remove` holding `worktree`: refused with `in_use` when one of `openFolders` (every open session's folder, read
 * now) is that worktree or inside it, or another removal holds it.
 */
export async function withRemovalClaim<T>(
	worktree: string,
	openFolders: () => readonly string[],
	remove: () => Promise<T>,
): Promise<T> {
	const held = realFolder(worktree);
	if (removing.has(held) || openFolders().some(folder => covers(held, realFolder(folder))))
		throw new LocalCommandError(`${worktree} is in use by an open session; nothing was removed.`, "in_use");
	removing.add(held);
	try {
		return await remove();
	} finally {
		removing.delete(held);
	}
}
