import { type ChildProcess, spawn } from "node:child_process";

/** How long the fallback of `stopOmp` lets an omp finish on its own after its stdin ended, before the shim is killed. */
const TASKKILL_FALLBACK_GRACE_MS = 5_000;

/**
 * Stop an omp. SIGTERM where signals exist. Windows has none: `kill` is TerminateProcess of the direct child only, and
 * omp starts through a `.cmd` or `.exe` shim whose real omp would be left running, so the whole tree goes (`taskkill
 * /T /F`, as the setup supervisor does). taskkill finds the tree through WMI and, with WMI down, exits 1 and kills
 * nothing: the omp would then run on until the app exits, holding its folder. So a taskkill that failed while the child
 * still runs falls back to ending its stdin (omp exits when it ends). The shim waits for the omp, so its exit means
 * the omp is gone: a callback waiting for that exit (a session delete, a folder removal) never runs while the omp
 * still writes its session file on the way out. Only an omp that ignores the closed stdin gets TerminateProcess of the
 * shim, after a grace period.
 */
export function stopOmp(child: ChildProcess): void {
	if (process.platform === "win32" && child.pid !== undefined) {
		const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		const fallBack = () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.stdin?.end();
			const timer = setTimeout(() => child.kill(), TASKKILL_FALLBACK_GRACE_MS);
			timer.unref();
			child.once("exit", () => clearTimeout(timer));
		};
		killer.once("error", fallBack);
		killer.once("exit", code => {
			if (code !== 0) fallBack();
		});
		return;
	}
	child.kill("SIGTERM");
}
