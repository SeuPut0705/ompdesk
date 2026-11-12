/**
 * Every omp this app has running, and the file that names them for the next launch (`<userData>/omp-pids.json`). A
 * launch first stops the ones an earlier instance left running when it crashed or was forced out (`reapLeftovers`):
 * one omp stuck on a blocked thread kept every new omp on the machine stalled for three minutes after a relaunch
 * (8 Nov 2026). A quit stops them all and waits (`stopAll`).
 *
 * The file, whose a listed pid still is and a leftover's stop are the core's (`native/ompdesk/crates/core/src/omp`):
 * `omp.track` at each spawn and `omp.exited` at each exit rewrite the file, `omp.reap` is the launch's. What stays
 * here is what needs the child process main spawned: the quit's stop of each (`stopOmp`: its stdin's end, the hold it
 * asks for while it saves a login) and the wait for all of them.
 */
import type { ChildProcess } from "node:child_process";
import { CoreError, core } from "./core/process";
import { KILL_WAIT_MS, STOP_GRACE_MS, stopOmp } from "./omp-stop";

/** The file in userData that names the omps this app runs. */
export const OMP_PIDS_FILE = "omp-pids.json";
/**
 * How long a quit waits for every omp's stop, all together: the longest one stop takes (ai-memory's 4 s stdin grace,
 * `STOP_GRACE_MS`, the kill's 2 s wait), under the quit watchdog's 30 s.
 */
export const QUIT_OMP_STOP_MS = 12_000;
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
	readonly #live = new Set<ChildProcess>();
	/** The spawns and exits told to the core so far, in order: an exit never overtakes its spawn. */
	#told: Promise<void> = Promise.resolve();

	constructor(file: string, bridgeDir: string, options: OmpProcessesOptions = {}) {
		this.#file = file;
		this.#bridgeDir = bridgeDir;
		this.#log = options.log ?? ((message, details) => console.warn(`[omp-processes] ${message}`, details));
	}

	/** Names the omp in the file until it exits. Nothing waits for it: a spawn never does. */
	track(child: ChildProcess): void {
		const pid = child.pid;
		if (pid === undefined) return;
		this.#live.add(child);
		this.#tell("omp.track", pid);
		child.once("exit", () => {
			this.#live.delete(child);
			this.#tell("omp.exited", pid);
		});
	}

	#tell(method: "omp.track" | "omp.exited", pid: number): void {
		this.#told = this.#told
			.then(() => core().call(method, { file: this.#file, pid }))
			.then(
				() => undefined,
				(error: unknown) => console.warn(`[omp-processes] ${this.#file} not saved: ${String(error)}`),
			);
	}

	/**
	 * Stops every omp still running (joining stops already under way) and resolves once all exited and the file says
	 * so, or after the bound.
	 */
	async stopAll(boundMs = QUIT_OMP_STOP_MS): Promise<void> {
		const stops = Promise.all([...this.#live].map(child => stopOmp(child))).then(() => this.#told);
		const { promise: bound, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, boundMs);
		await Promise.race([stops, bound]);
		clearTimeout(timer);
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
