import { type ChildProcess, spawn } from "node:child_process";

/** How long a Windows omp gets to shut down on its own after its stdin ended, before its process tree is killed. */
export const WINDOWS_STOP_GRACE_MS = 5_000;

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/**
 * Ends an omp now. SIGTERM where signals exist. Windows has none: `kill` is TerminateProcess of the direct child only,
 * and omp starts through a `.cmd` or `.exe` shim whose real omp would be left running, so the whole tree goes
 * (`taskkill /T /F`, as the setup supervisor does). taskkill finds the tree through WMI and, with WMI down, exits 1 and
 * kills nothing; then the shim is ended, which closes the omp's stdin (omp exits when it ends).
 */
export function killOmp(child: ChildProcess): void {
	if (process.platform !== "win32" || child.pid === undefined) {
		child.kill("SIGTERM");
		return;
	}
	const fallBack = () => {
		if (!running(child)) return;
		child.stdin?.end();
		child.kill();
	};
	const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
	killer.once("error", fallBack);
	killer.once("exit", code => {
		if (code !== 0) fallBack();
	});
}

/**
 * Stops an omp the way a stop should read in its session journal: stock journals the session's `session_exit`, and a
 * relaunch's restore dates the stop by it (`cutByEarlierStop`, `shutdownMarks` in restart-core.ts). On macOS and Linux
 * that is SIGTERM, whose handler disposes the session. On Windows a tree kill runs no handler and journals nothing, so
 * the omp's stdin is ended first (stock disposes the session then, as on an app quit) and the tree is killed only when
 * it still runs after `WINDOWS_STOP_GRACE_MS`. The shim waits for the omp, so its exit means the omp is gone: a callback
 * waiting for that exit (a session delete, a folder removal) never runs while the omp still writes its session file on
 * the way out. The old omp's dispose overlaps a replacement's start on the same session as SIGTERM's handler does.
 */
export function stopOmp(child: ChildProcess): void {
	if (process.platform !== "win32" || child.pid === undefined || !child.stdin) {
		killOmp(child);
		return;
	}
	if (!running(child)) return;
	child.stdin.end();
	const timer = setTimeout(() => {
		if (running(child)) killOmp(child);
	}, WINDOWS_STOP_GRACE_MS);
	timer.unref();
	child.once("exit", () => clearTimeout(timer));
}
