/**
 * The exits of this computer's omps that were told to stop, by the folder they ran in: what a removal of that folder
 * waits for before git touches it. A tab's release (`SidecarPool`) and a paired device's tab closing here
 * (`LocalHostServices`) note theirs; `discardOpenedWorktree` waits on the folder's. This is the one signal that holds
 * on Windows, where no process's working folder can be read.
 */
import { isInside } from "./local/git/parse";
import { realFolder } from "./worktree-removals";

const pending = new Map<string, Set<Promise<void>>>();

/** An omp that ran in `cwd` is going: `exited` settles once its process is gone. */
export function noteOmpExit(cwd: string, exited: Promise<void>): void {
	const folder = realFolder(cwd);
	const set = pending.get(folder) ?? new Set();
	set.add(exited);
	pending.set(folder, set);
	void exited
		.catch(() => undefined)
		.finally(() => {
			set.delete(exited);
			if (set.size === 0 && pending.get(folder) === set) pending.delete(folder);
		});
}

/**
 * Settles true once every omp noted in `folder` (or inside it) has exited, false when one is still running after
 * `timeoutMs`.
 */
export async function ompsExitedIn(folder: string, timeoutMs: number): Promise<boolean> {
	const root = realFolder(folder);
	const waits = [...pending.entries()]
		.filter(([cwd]) => cwd === root || isInside(root, cwd))
		.flatMap(([, set]) => [...set].map(exit => exit.catch(() => undefined)));
	if (waits.length === 0) return true;
	const { promise: late, resolve } = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => resolve(false), timeoutMs);
	try {
		return await Promise.race([Promise.all(waits).then(() => true), late]);
	} finally {
		clearTimeout(timer);
	}
}
