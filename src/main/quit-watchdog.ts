/**
 * Force-exit timer behind a committed quit or update install.
 *
 * Deliberately electron-free (the clock, the log and the exit are injected) so it is unit-tested
 * with fake timers; `app-quit.ts` wires it to `app.exit` and the runtime log.
 *
 * The quit is committed once `before-quit` has let the teardown run (⌘Q, tray, an update restart)
 * or `before-quit-for-update` fired. From there nothing may keep the process alive: a wedged
 * teardown (a sidecar that never exits, a stuck socket close) leaves the windows gone but the
 * process running, and the updater's swap helper (relaunch mode) or installer (NSIS, Squirrel)
 * waits for this process to exit before it replaces the bundle, so the update never applies.
 * The same idea as Orca's `update-install-exit-watchdog.ts` (MIT), reimplemented.
 */

/** Long enough for a healthy teardown (sidecars get their SIGTERM grace), short enough that an update is not stranded. */
export const QUIT_EXIT_TIMEOUT_MS = 30_000;

export type QuitWatchdogReason = "quit" | "update";

/** Whatever `setTimer` hands back; only `clearTimer` looks inside. */
export type QuitTimerHandle = unknown;

export interface QuitWatchdogReport {
	source: "background-task";
	message: string;
	details: { watchdog: "quit"; reason: QuitWatchdogReason; timeoutMs: number };
}

export interface QuitWatchdogDeps {
	/** Starts the timer. It must be unref'd: the watchdog never keeps the process alive. */
	setTimer: (fn: () => void, ms: number) => QuitTimerHandle;
	clearTimer: (handle: QuitTimerHandle) => void;
	/** Runtime-log report (`source: "background-task"`); called once, when the watchdog fires. */
	log: (report: QuitWatchdogReport) => void;
	/** Ends the process (`app.exit(0)`): a committed quit is wedged, not failed, so the code is clean. */
	exit: () => void;
	timeoutMs?: number;
}

export class QuitWatchdog {
	readonly #deps: QuitWatchdogDeps;
	#timer: QuitTimerHandle | undefined;
	#reason: QuitWatchdogReason | undefined;

	constructor(deps: QuitWatchdogDeps) {
		this.#deps = deps;
	}

	/** Whether a force exit is pending. */
	get armed(): boolean {
		return this.#timer !== undefined;
	}

	/** Start the countdown. A second call keeps the first countdown, so repeated `before-quit` events never extend it. */
	arm(reason: QuitWatchdogReason): void {
		if (this.#timer !== undefined) return;
		const timeoutMs = this.#deps.timeoutMs ?? QUIT_EXIT_TIMEOUT_MS;
		this.#reason = reason;
		this.#timer = this.#deps.setTimer(() => {
			this.#timer = undefined;
			this.#deps.log({
				source: "background-task",
				message: `Shutdown did not finish within ${timeoutMs}ms of committing the ${reason}; forcing exit`,
				details: { watchdog: "quit", reason, timeoutMs },
			});
			this.#deps.exit();
		}, timeoutMs);
	}

	/**
	 * The quit was cancelled (an install that failed before the app closed keeps the session running).
	 * With `reason`, only a countdown armed for that reason stops.
	 */
	disarm(reason?: QuitWatchdogReason): void {
		if (this.#timer === undefined) return;
		if (reason !== undefined && reason !== this.#reason) return;
		this.#deps.clearTimer(this.#timer);
		this.#timer = undefined;
	}
}
