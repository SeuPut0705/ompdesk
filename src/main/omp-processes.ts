/**
 * Every omp this app has running, and the file that names them for the next launch (`<userData>/omp-pids.json`). A
 * launch first stops the ones an earlier instance left running when it crashed or was forced out (`reapLeftovers`):
 * one omp stuck on a blocked thread kept every new omp on the machine stalled for three minutes after a relaunch
 * (8 Nov 2026). A quit stops them all and waits (`stopAll`).
 *
 * The file, whose a listed pid still is and a leftover's stop are the core's (`native/ompdesk/crates/core/src/omp`),
 * and the omps themselves are the tabs' lanes' (`native/ompdesk/crates/core/src/sidecar`): a lane writes the file at
 * each spawn and each exit (`SidecarOptions.ledgerFile`, this file's name) and stops its omp; `sidecar.stopAll` is the
 * quit's stop of every lane's, `omp.reap` the launch's. What stays here is the two calls and their bounds.
 */
import { CoreError, core } from "./core/process";

/** The file in userData that names the omps this app runs. */
export const OMP_PIDS_FILE = "omp-pids.json";
/**
 * How long an omp gets to end by itself once its stop began (SIGTERM; on Windows its stdin ended) before it is killed:
 * the lane's stop and a leftover's alike (`sidecar/stop.rs`, `omp/`).
 */
export const STOP_GRACE_MS = 5_000;
/** After the kill, how long a stop still waits for the exit (a process in uninterruptible sleep outlasts SIGKILL). */
export const KILL_WAIT_MS = 2_000;
/**
 * How long a quit waits for every omp's stop, all together: the longest one stop takes (ai-memory's 4 s stdin grace,
 * `STOP_GRACE_MS`, the kill's 2 s wait), under the quit watchdog's 30 s.
 */
export const QUIT_OMP_STOP_MS = 12_000;
/** What main waits for the core's answer to the quit's stop past the bound the core keeps. */
const STOP_ANSWER_SLACK_MS = 5_000;
/**
 * How long the launch's reap may take, and with it how long every tab's start is held: a leftover's whole stop, and
 * what a core that has to start on a loaded machine adds.
 */
const REAP_TIMEOUT_MS = STOP_GRACE_MS + KILL_WAIT_MS + 8_000;

export interface OmpProcessesOptions {
	/** A reap the core could not answer: `phase: "reap"`, `cause` (`timeout`, `error`) and the error. */
	log?: (message: string, details: Record<string, string | number | boolean>) => void;
}

export class OmpProcesses {
	readonly #file: string;
	readonly #bridgeDir: string;
	readonly #log: (message: string, details: Record<string, string | number | boolean>) => void;

	constructor(file: string, bridgeDir: string, options: OmpProcessesOptions = {}) {
		this.#file = file;
		this.#bridgeDir = bridgeDir;
		this.#log = options.log ?? ((message, details) => console.warn(`[omp-processes] ${message}`, details));
	}

	/** The file the lanes keep (`SidecarOptions.ledgerFile`). */
	get file(): string {
		return this.#file;
	}

	/**
	 * Stops every omp the core's lanes run (joining stops already under way) and resolves once all exited and the file
	 * says so, or after the bound. A core that is not running runs no omp: it is never started to say so.
	 */
	async stopAll(boundMs = QUIT_OMP_STOP_MS): Promise<void> {
		if (core().pid === null) return;
		await core()
			.call("sidecar.stopAll", { boundMs }, { timeoutMs: boundMs + STOP_ANSWER_SLACK_MS })
			.catch(() => {
				// A core that ended meanwhile took its omps with it.
			});
	}

	/**
	 * Stops the omps the file names that still run and are still the process this app started, never a reused pid of
	 * another program. Resolves with the pids confirmed stopped; a reap the core could not answer stops nothing, leaves
	 * the file as it is for the next launch and is logged.
	 */
	async reapLeftovers(): Promise<number[]> {
		try {
			const answer = await core().call<{ stopped: number[] }>(
				"omp.reap",
				{ file: this.#file, bridgeDir: this.#bridgeDir, graceMs: STOP_GRACE_MS, killWaitMs: KILL_WAIT_MS },
				{ timeoutMs: REAP_TIMEOUT_MS },
			);
			return answer.result.stopped;
		} catch (error) {
			this.#log("leftover omps not checked", {
				level: "warn",
				phase: "reap",
				cause: error instanceof CoreError && error.code === "timeout" ? "timeout" : "error",
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	}
}
