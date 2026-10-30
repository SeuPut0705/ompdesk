/**
 * One-at-a-time work whose every step has a bound. A plain `previous.then(next)` chain stops for good when one step
 * never settles: each later call waits behind it and nothing says so. Here a step that runs past `maxStepMs` is
 * stopped (its `signal` aborts, `onStall` ends what it still runs), fails its own caller with a `StepStalledError`
 * and is logged as a `chain-stall` line, and the next step starts at once. The stopped step is not awaited again:
 * whatever it still holds is the abort handler's job.
 *
 * A chain whose steps all end by themselves (every child process they run has its own timeout that kills it) needs
 * no bound; this is for the ones whose steps can wait on something nothing times out.
 */
import { writeRuntimeLog } from "./runtime-log";

/** A step ran past its bound and was stopped; the chain went on without it. */
export class StepStalledError extends Error {
	readonly chain: string;
	readonly step: string;
	readonly ms: number;

	constructor(chain: string, step: string, ms: number) {
		super(`${step} did not finish in ${formatSpan(ms)} and was stopped so the next one can run (${chain}).`);
		this.name = "StepStalledError";
		this.chain = chain;
		this.step = step;
		this.ms = ms;
	}
}

function formatSpan(ms: number): string {
	if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
	return `${Math.round(ms / 1000)} s`;
}

export interface SerialChainOptions {
	/** Names the chain in the log line and the error. */
	name: string;
	/** The longest one step runs. */
	maxStepMs: number;
	/** Runs once when a step hit its bound, before the next step starts: end whatever the step still runs. */
	onStall?: (stall: StepStalledError) => void;
	/** Where the `chain-stall` line goes; the runtime log by default. */
	log?: (stall: StepStalledError) => void;
}

function writeStall(stall: StepStalledError): void {
	try {
		writeRuntimeLog({
			source: "chain-stall",
			message: `${stall.chain}: ${stall.step} stopped after ${stall.ms} ms`,
			details: { level: "warn", chain: stall.chain, step: stall.step, ms: stall.ms },
		});
	} catch {
		// A log that cannot be written must not keep the chain from going on.
	}
}

export class SerialChain {
	readonly #options: SerialChainOptions;
	#tail: Promise<void> = Promise.resolve();
	#pending = 0;

	constructor(options: SerialChainOptions) {
		this.#options = options;
	}

	/** Steps queued or running. */
	get pending(): number {
		return this.#pending;
	}

	/**
	 * Run `task` after every step queued before it ended. Resolves with its result, rejects with its error, or with a
	 * `StepStalledError` once `maxStepMs` (the step's own bound, else the chain's) passed (counted from when the step starts, not from when it was queued).
	 */
	run<T>(task: (signal: AbortSignal) => Promise<T> | T, step = "step", maxStepMs?: number): Promise<T> {
		this.#pending += 1;
		const result = this.#tail.then(() => this.#step(task, step, maxStepMs ?? this.#options.maxStepMs));
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		this.#tail = settled;
		void settled.then(() => {
			this.#pending -= 1;
		});
		return result;
	}

	#step<T>(task: (signal: AbortSignal) => Promise<T> | T, step: string, maxStepMs: number): Promise<T> {
		const { name, onStall, log } = this.#options;
		const controller = new AbortController();
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const timer = setTimeout(() => {
			const stall = new StepStalledError(name, step, maxStepMs);
			(log ?? writeStall)(stall);
			controller.abort(stall);
			try {
				onStall?.(stall);
			} catch {
				// Ending what the step still runs is best effort; the chain goes on either way.
			}
			reject(stall);
		}, maxStepMs);
		timer.unref();
		Promise.resolve()
			.then(() => task(controller.signal))
			.then(resolve, reject)
			.finally(() => clearTimeout(timer));
		return promise;
	}
}
