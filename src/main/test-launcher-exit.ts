import { processAlive } from "./process-alive";

/** Set by playwright.config.ts in every runner and worker: the pid of the process that launches test apps. */
export const LAUNCHER_PID_ENV = "OMP_GUI_TEST_LAUNCHER_PID";
const CHECK_MS = 1000;

/**
 * A test launch ends when the process that launched it is gone. Playwright's exit handler is the only thing that
 * ends an app it launched, and a worker that dies without running it (Node 24.15's 0xC0000409 on Windows, an outer
 * `taskkill /F`) left the app, its Chromium helpers and its omp running: 108 of them on a Windows PC after a day of
 * agent runs. The worker's stdin pipe cannot tell: Electron's main process on Windows has no stdin stream (its
 * `process.stdin` is an empty Readable), and Playwright starts the app under a `cmd.exe` that outlives the worker.
 * So main checks the launcher's pid once a second. The variable is taken out of the environment, so a relaunch or a
 * child the app spawns does not inherit it.
 */
export function exitWithLauncher(
	env: NodeJS.ProcessEnv,
	exit: () => void,
	alive: (pid: number) => boolean = processAlive,
): NodeJS.Timeout | null {
	const launcher = Number(env[LAUNCHER_PID_ENV]);
	delete env[LAUNCHER_PID_ENV];
	if (!Number.isInteger(launcher) || launcher <= 0 || launcher === process.pid) return null;
	const timer = setInterval(() => {
		if (alive(launcher)) return;
		clearInterval(timer);
		exit();
	}, CHECK_MS);
	timer.unref();
	return timer;
}
