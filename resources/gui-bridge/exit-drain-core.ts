/**
 * An exit that waits for omp's own exit cleanup (rules: `.omp/rules/interrupted-work.md` › Keep awake… › One stop).
 *
 * Stock ends an RPC omp with `process.exit(code)` right after it disposed the session (rpc-mode.ts `disposeAndExit`:
 * its stdin closed, or an extension asked for a shutdown), and the cleanup pass the `exit` event starts is not awaited.
 * One cleanup must not be dropped: a login refresh in flight (`pi-ai` auth/refresh.ts, exit-only, up to 125 s). The
 * provider has swapped the refresh token by then, so an omp that ends before it saved the new one leaves a spent token
 * in the store every omp shares, and that account drops off the list at its next refresh (`invalid_grant`). A signal's
 * exit awaits the same pass (postmortem.ts `exitAfterSignal`); this gives `process.exit` what a signal already has.
 *
 * Pure: stock's `postmortem` comes in as `deps`, so vitest can drive it with a fake process.
 */

/** What of stock's `postmortem` (`@oh-my-pi/pi-utils`) the drained exit uses. */
export interface ExitDrainDeps {
	/** Runs every cleanup callback, awaited (a callback with its own deadline holds the pass open), then `process.exit`. */
	quit(code: number, options: { drainStdout: boolean }): Promise<void>;
	/** The native exit, whatever stands in `process.exit`. */
	exitProcess(code: number): void;
	/** The key under which a stand-in for `process.exit` names the primitive it shadows; `exitProcess` follows it. */
	NATIVE_PROCESS_EXIT: symbol;
}

/** The part of `process` an exit goes through. */
export interface ExitingProcess {
	exit: (code?: number | string | null) => never;
	exitCode?: number | string | null;
}

const DRAINED = Symbol.for("ompdesk.gui-bridge.exit-drain");

/**
 * From now on `proc.exit` ends the process only once stock's cleanup pass has settled. The first call starts the pass
 * (`quit`, whose own closing `process.exit` lands here again and is ignored) and the native exit follows it, with the
 * code that call gave; calls made meanwhile join it. Installing twice changes nothing.
 */
export function drainOnExit(proc: ExitingProcess, deps: ExitDrainDeps): void {
	if (Reflect.get(proc.exit, DRAINED)) return;
	const native = proc.exit;
	let leaving = false;
	const drained = (code?: number | string | null): void => {
		if (leaving) return;
		leaving = true;
		const status = Number(code ?? proc.exitCode ?? 0) || 0;
		const end = () => deps.exitProcess(status);
		void deps.quit(status, { drainStdout: false }).then(end, end);
	};
	Reflect.set(drained, DRAINED, true);
	Reflect.set(drained, deps.NATIVE_PROCESS_EXIT, native);
	proc.exit = drained as ExitingProcess["exit"];
}
