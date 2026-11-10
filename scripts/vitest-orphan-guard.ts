/**
 * A test process whose runner is gone ends itself.
 *
 * Why: a `forks` worker of the node project outlives a killed or crashed Vitest (a run cut off with Ctrl-C, a
 * pipe that closed under it, a parent that was killed) and is then reparented to launchd/init. Such an orphan
 * keeps running its test file and holding what it allocated, and nothing ever collects it. Seven of them at 2.7 to
 * 3.5 GB each were alive on a 16 GB Mac when its WindowServer stalled for 158 s and the machine rebooted
 * (22 Oct 2026). Vitest itself only stops a worker it can still talk to.
 *
 * `exitWhenParentGone` is wired from `vitest.setup.ts`, so every worker of both projects carries it: a `threads`
 * worker's parent is the runner's own parent, which dies with the run too. `exitWhenGone` is what a test's own
 * long-lived fake (a fake omp, an idle stand-in) runs, through `DIES_WITH_TEST` in `src/main/test-fake-omp.ts`: two
 * fake omps that ignore SIGTERM were alive under launchd 33 hours after the worker that started them died (9 Nov
 * 2026). Plain Node, no Vitest import: the tests drive it in child processes.
 */

/** How often a worker looks for its parent. */
export const ORPHAN_CHECK_MS = 2_000;

/**
 * True while the process `pid` exists (signal 0 tests for it and sends nothing; EPERM is a live process of another
 * user). `src/main/process-alive.ts`'s rule, copied: this file's test runs it in plain Node, which cannot import an
 * extensionless TypeScript module.
 */
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
 * the old `ppid`). A worker already orphaned when this runs ends at once. The timer is unref'd, so it never holds a
 * finished worker open.
 */
export function exitWhenParentGone(intervalMs = ORPHAN_CHECK_MS): void {
	const parent = process.ppid;
	if (parent <= 1) {
		// A forked worker (an IPC child; `process.send` outlives the channel) parented by init lost its runner before
		// setup ran. A `threads` worker's `ppid` is the runner's own parent, which may be init on purpose (a container).
		if (typeof process.send === "function") process.exit(1);
		return;
	}
	exitWhen(() => process.ppid !== parent || !alive(parent), intervalMs);
}

/**
 * Ends this process once the process `owner` no longer runs, whoever its own parent is: a fake omp the app under test
 * started must outlive a killed app (an e2e checks the app's stop, not the fake's), but never the test that wrote it,
 * and on Windows its parent is the `omp.cmd` shim's cmd.exe, which outlives the test too.
 */
export function exitWhenGone(owner: number, intervalMs = ORPHAN_CHECK_MS): void {
	exitWhen(() => !alive(owner), intervalMs);
}

function exitWhen(gone: () => boolean, intervalMs: number): void {
	if (gone()) process.exit(1);
	const timer = setInterval(() => {
		if (!gone()) return;
		clearInterval(timer);
		process.exit(1);
	}, intervalMs);
	timer.unref();
}
