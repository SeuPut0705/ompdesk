/**
 * One-at-a-time work whose every step has a bound. A plain `previous.then(next)` chain stops for good when one step
 * never settles: each later call waits behind it and nothing says so. Here a step that runs past `maxStepMs` is
 * stopped (its `signal` aborts, `onStall` ends what it still runs), fails its own caller with a `StepStalledError`
 * and is logged as a `chain-stall` line. The stopped step is not awaited again: whatever it still holds is the abort
 * handler's job. The caller hears of the stop at once, but the next step starts only when what the stopped step
 * already handed to the OS (`trackEffect`: an fs call, a child process until it exits) settled: it waits for that at
 * most `STALLED_DRAIN_MAX_MS` from the stop, and then it and every later step fail with a `ChainBusyError` naming
 * what still runs, until it ended. A call in flight never finishes against the next step's state.
 *
 * A chain whose steps all end by themselves (every child process they run has its own timeout that kills it) needs
 * no bound; this is for the ones whose steps can wait on something nothing times out.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { writeRuntimeLog } from "./runtime-log";

/**
 * The longest a step waits, counted from a stop, for the calls the stopped step had in flight; after it the chain
 * refuses new steps (`ChainBusyError`) until those calls ended.
 */
export const STALLED_DRAIN_MAX_MS = 60_000;

/**
 * The step whose code is running (across its awaits). A stopped step is not awaited again, so it can still resume
 * later: every await that leads to a side effect (a spawn, a write, a state change, an emit) asks `throwIfStepStalled`
 * first, and a step that was stopped ends there instead of acting on the next step's state.
 */
const currentStep = new AsyncLocalStorage<AbortSignal>();

/** The signal of the chain step this code runs in, or undefined outside any step. */
export function currentStepSignal(): AbortSignal | undefined {
	return currentStep.getStore();
}

/** True once the chain step this code runs in was stopped for running past its bound. */
export function stepStalled(): boolean {
	return currentStep.getStore()?.aborted === true;
}

/**
 * `call` fenced to the chain step it is made in: it throws before it starts and as soon as it returns when that step was
 * stopped, so a step that resumes after its bound cannot start the next call or go on to act on what it returned.
 * Outside any step it is `call`.
 */
export function fencedCall<A extends unknown[], R>(call: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
	return async (...args: A) => {
		throwIfStepStalled();
		const result = await call(...args);
		throwIfStepStalled();
		return result;
	};
}

/** What each running step still has in flight, by the step's signal: label by promise. */
const effectsOf = new WeakMap<AbortSignal, Map<Promise<unknown>, string>>();

/**
 * Records `effect` (an fs call already handed to the OS, a child process until it exits) as in flight for the chain
 * step this code runs in. A step that is stopped fails its caller at once, but its chain does not start the next step
 * until every recorded effect settled, and refuses it (`ChainBusyError`) when that takes longer than
 * `STALLED_DRAIN_MAX_MS`: a call the OS already has must not finish against the next step's state. Outside any step it records nothing. Returns `effect`.
 */
export function trackEffect<T>(label: string, effect: Promise<T>): Promise<T> {
	const signal = currentStep.getStore();
	const effects = signal && effectsOf.get(signal);
	if (!effects) return effect;
	effects.set(effect, label);
	const done = () => void effects.delete(effect);
	effect.then(done, done);
	return effect;
}

/**
 * `fencedCall` for a call that changes state outside the process (fs, a child): the call it starts is also tracked with
 * `trackEffect`, so the chain waits for it when the step is stopped while it runs. The label names it in the log.
 */
export function fencedEffect<A extends unknown[], R>(
	label: string,
	call: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
	return async (...args: A) => {
		throwIfStepStalled();
		const result = await trackEffect(label, call(...args));
		throwIfStepStalled();
		return result;
	};
}

/** Throws the step's `StepStalledError` when it was stopped; a no-op in a live step and outside any step. */
export function throwIfStepStalled(): void {
	const signal = currentStep.getStore();
	if (signal?.aborted) throw signal.reason;
}

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

/**
 * A step was stopped and what it handed to the OS (an fs call, a child process) is still running: the chain does not
 * run another step on that state until it ended. `pending` names what is still running.
 */
export class ChainBusyError extends Error {
	readonly chain: string;
	readonly pending: string[];

	constructor(chain: string, step: string, pending: string[]) {
		super(
			`${chain} is busy: ${step} was stopped while ${pending.join(", ")} was still running, and nothing else runs on it until that ended. Try again in a moment.`,
		);
		this.name = "ChainBusyError";
		this.chain = chain;
		this.pending = pending;
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
	/** Where the line goes when what a stopped step had in flight outlasts `STALLED_DRAIN_MAX_MS`; the runtime log by default. */
	logBusy?: (chain: string, step: string, pending: string[]) => void;
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

function writeBusy(chain: string, step: string, pending: string[]): void {
	writeRuntimeLog({
		source: "chain-stall",
		message: `${chain}: ${step} was stopped ${STALLED_DRAIN_MAX_MS} ms ago and still has ${pending.length} call(s) running; the chain refuses new steps until they end (${pending.join(", ")})`,
		details: { level: "warn", chain, step, pending },
	});
}

/** What a stopped step still had in flight, until it all ended. */
interface Hold {
	step: string;
	effects: Map<Promise<unknown>, string>;
	/** Resolves, and the hold leaves the chain, once everything in `effects` settled. */
	settled: Promise<void>;
	/** Resolves once the hold is older than `STALLED_DRAIN_MAX_MS`. */
	late: Promise<void>;
	isLate: boolean;
}

export class SerialChain {
	readonly #options: SerialChainOptions;
	#tail: Promise<void> = Promise.resolve();
	#pending = 0;
	readonly #holds = new Set<Hold>();

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
	 *
	 * A call made inside another chain's step is fenced to that step: its signal also aborts when the caller's step is
	 * stopped, the call rejects with the caller's reason, and a step queued behind others never starts once its caller
	 * was stopped. A caller that is already stopped gets a rejection and the chain is not touched.
	 *
	 * A step that was stopped while its calls to the OS (`trackEffect`) were still running holds the chain: the next
	 * step starts when they ended, waits for them at most `STALLED_DRAIN_MAX_MS` counted from the stop, and then (as
	 * does every step that comes later) is refused with a `ChainBusyError` naming them, until they ended.
	 */
	run<T>(task: (signal: AbortSignal) => Promise<T> | T, step = "step", maxStepMs?: number): Promise<T> {
		const parent = currentStep.getStore();
		if (parent?.aborted) return Promise.reject(parent.reason);
		const late = this.#lateHold();
		if (late) return Promise.reject(this.#busy(late));
		this.#pending += 1;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		// Stopped while still waiting for its turn: the caller is told at once, the step is skipped when its turn comes.
		const onParentAbort = () => reject(parent?.reason);
		parent?.addEventListener("abort", onParentAbort, { once: true });
		const inner = this.#tail.then(async () => {
			if (parent?.aborted) throw parent.reason;
			await this.#clearHolds();
			if (parent?.aborted) throw parent.reason;
			return this.#step(task, step, maxStepMs ?? this.#options.maxStepMs, parent);
		});
		inner.then(
			value => {
				parent?.removeEventListener("abort", onParentAbort);
				resolve(value);
			},
			error => {
				parent?.removeEventListener("abort", onParentAbort);
				reject(error);
			},
		);
		const settled = inner.then(
			() => undefined,
			() => undefined,
		);
		this.#tail = settled;
		void settled.then(() => {
			this.#pending -= 1;
		});
		return promise;
	}

	/** Whether a stopped step still has a call running that holds the chain. */
	get held(): boolean {
		return this.#holds.size > 0;
	}

	/** Settles once no stopped step has a call running. */
	async released(): Promise<void> {
		while (this.#holds.size > 0) await Promise.all([...this.#holds].map(hold => hold.settled));
	}

	#lateHold(): Hold | undefined {
		for (const hold of this.#holds) if (hold.isLate) return hold;
		return undefined;
	}

	#busy(hold: Hold): ChainBusyError {
		const pending = [...this.#holds].flatMap(one => [...one.effects.values()]);
		return new ChainBusyError(this.#options.name, hold.step, pending);
	}

	/** Waits (within the holds' bound) until no stopped step has a call running; throws `ChainBusyError` when one still has. */
	async #clearHolds(): Promise<void> {
		for (;;) {
			const hold = this.#holds.values().next().value;
			if (!hold) return;
			if (!hold.isLate) await Promise.race([hold.settled, hold.late]);
			if (this.#holds.has(hold)) throw this.#busy(hold);
		}
	}

	/** Records what the stopped step `signal` belongs to still has in flight, when it has anything. */
	#hold(signal: AbortSignal, step: string): void {
		const effects = effectsOf.get(signal);
		if (!effects || effects.size === 0) return;
		const { name, logBusy } = this.#options;
		const late = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			hold.isLate = true;
			late.resolve();
			try {
				(logBusy ?? writeBusy)(name, step, [...effects.values()]);
			} catch {
				// A log that cannot be written must not keep the chain from going on.
			}
		}, STALLED_DRAIN_MAX_MS);
		timer.unref();
		const hold: Hold = { step, effects, settled: Promise.resolve(), late: late.promise, isLate: false };
		this.#holds.add(hold);
		hold.settled = (async () => {
			while (effects.size > 0) await Promise.allSettled([...effects.keys()]);
			clearTimeout(timer);
			this.#holds.delete(hold);
		})();
	}

	#step<T>(
		task: (signal: AbortSignal) => Promise<T> | T,
		step: string,
		maxStepMs: number,
		parent: AbortSignal | undefined,
	): Promise<T> {
		const { name, onStall, log } = this.#options;
		const controller = new AbortController();
		effectsOf.set(controller.signal, new Map());
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
			this.#hold(controller.signal, step);
			reject(stall);
		}, maxStepMs);
		timer.unref();
		// The caller's step was stopped: this one is stopped with it and frees the chain, without being a stall of its own.
		const onParentAbort = () => {
			controller.abort(parent?.reason);
			this.#hold(controller.signal, step);
			reject(parent?.reason);
		};
		parent?.addEventListener("abort", onParentAbort, { once: true });
		Promise.resolve()
			.then(() => currentStep.run(controller.signal, () => task(controller.signal)))
			.then(resolve, reject)
			.finally(() => {
				clearTimeout(timer);
				parent?.removeEventListener("abort", onParentAbort);
			});
		return promise;
	}
}
