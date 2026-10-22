/**
 * Vitest setup: a test worker whose parent is gone ends itself.
 *
 * Why: a `forks` worker of the node project outlives a killed or crashed Vitest (a run cut off with Ctrl-C, a
 * pipe that closed under it, a parent that was killed) and is then reparented to launchd/init. Such an orphan
 * keeps running its test file and holding what it allocated, and nothing ever collects it. Seven of them at 2.7 to
 * 3.5 GB each were alive on a 16 GB Mac when its WindowServer stalled for 158 s and the machine rebooted
 * (22 Oct 2026). Vitest itself only stops a worker it can still talk to.
 *
 * Wired from `vitest.setup.ts`, so every worker of both projects carries it: a `threads` worker's parent is the
 * runner's own parent, which dies with the run too. Plain Node, no Vitest import: the test drives it in a child
 * process.
 */

/** How often a worker looks for its parent. */
export const ORPHAN_CHECK_MS = 2_000;

/** True while the process `pid` exists (signal 0 tests for it and sends nothing; EPERM is a live process of another user). */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Ends this process once its parent is gone: reparented (POSIX: `ppid` changes) or no longer running (Windows keeps
 * the old `ppid`). The timer is unref'd, so it never holds a finished worker open.
 */
export function exitWhenParentGone(intervalMs = ORPHAN_CHECK_MS): void {
	const parent = process.ppid;
	if (parent <= 1) return;
	const timer = setInterval(() => {
		if (process.ppid === parent && alive(parent)) return;
		clearInterval(timer);
		process.exit(1);
	}, intervalMs);
	timer.unref();
}
