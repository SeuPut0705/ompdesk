/**
 * The loop the omp, vendor CLI and extension updaters share (omp-updater.ts, cli-tools/updater.ts,
 * ext-update/updater.ts): a timer that ticks at start and re-arms from the end of each tick, a serial
 * queue of passes, the start/dispose guards and the failure back-off. Each updater keeps its own checks,
 * state and pref. OMPdesk's own updater (updater.ts) runs on a different schedule and is not one of them.
 */
import { SerialChain } from "./serial-chain";

/** Between checks while all is well. */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** The longest wait after repeated failures. */
export const MAX_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Delay before the next scheduled check after `failures` failed ones in a row. */
export function nextCheckDelay(failures: number): number {
	return Math.min(CHECK_INTERVAL_MS * 2 ** Math.min(failures, 8), MAX_CHECK_INTERVAL_MS);
}

/** One item's failures in a row, and the earliest time a scheduled pass checks it again. */
export interface Backoff {
	failures: number;
	/** No scheduled check before this (ms since the epoch); 0 = due. */
	nextAt: number;
}

/** Record how an item's check ended: a failure pushes its next scheduled check out, anything else clears the back-off. */
export function settleBackoff(item: Backoff, failed: boolean, now: number): void {
	item.failures = failed ? item.failures + 1 : 0;
	item.nextAt = failed ? now + nextCheckDelay(item.failures) : 0;
}

export interface UpdateSchedulerOptions {
	/** This launch checks on a timer: a packaged app, or a test launch that opts in. */
	scheduled: boolean;
	/** One scheduled check: at start, then whenever the timer fires. A rejection does not end the schedule. */
	tick: () => Promise<unknown>;
	/** The wait after a tick ends; `CHECK_INTERVAL_MS` by default. */
	delay?: () => number;
}

/** The longest one queued check or update pass runs; past it the pass is stopped and the next starts. */
export const UPDATE_STEP_MAX_MS = 30 * 60_000;

export class UpdateScheduler {
	readonly #options: UpdateSchedulerOptions;
	#timer: NodeJS.Timeout | null = null;
	#queue = new SerialChain({ name: "update scheduler", maxStepMs: UPDATE_STEP_MAX_MS });
	#started = false;
	#disposed = false;

	constructor(options: UpdateSchedulerOptions) {
		this.#options = options;
	}

	get started(): boolean {
		return this.#started;
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	/** Machine setup finished its first pass: a scheduled launch ticks now. False when it had started already or was disposed. */
	start(): boolean {
		if (this.#started || this.#disposed) return false;
		this.#started = true;
		if (this.#options.scheduled) void this.tick();
		return true;
	}

	/** Tick now; the next tick is one delay after this one ends (a pending timer is dropped). */
	async tick(): Promise<void> {
		clearTimeout(this.#timer ?? undefined);
		this.#timer = null;
		try {
			await this.#options.tick();
		} catch {
			// A throw from a dependency (a destroyed window, an unreadable env) must not end the schedule.
		} finally {
			if (!this.#disposed)
				this.#timer = setTimeout(() => void this.tick(), this.#options.delay?.() ?? CHECK_INTERVAL_MS);
		}
	}

	/** Run `work` after everything queued before it; skipped once disposed. Rejects with its error, and the queue goes on. */
	enqueue(work: () => Promise<unknown>): Promise<void> {
		return this.#queue.run(async () => {
			if (!this.#disposed) await work();
		});
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#timer ?? undefined);
		this.#timer = null;
	}
}
