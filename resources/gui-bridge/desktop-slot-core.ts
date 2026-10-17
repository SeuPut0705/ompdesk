/**
 * The bridge side of the desktop slot (contract: ./desktop-slot-contracts.ts), as a state machine with no omp
 * imports so the GUI's vitest can drive it with fake runs and fake timers (src/main/bridge-desktop-slot.test.ts).
 *
 * One `DesktopSlotCore` per omp process. Main owns the slot; this keeps what the bridge must know about it:
 *
 * - `holding`: this session was granted the slot and has not let go. An acting run while holding runs at once;
 *   a read-only run always passes (and, while holding, counts as progress).
 * - An acting run without the slot asks main (`desktop_slot_acquire`) and waits for `grant`. A grant that
 *   `waited` (main queued the request) means the screen changed hands meanwhile, so the run does not run: it
 *   returns the stale notice, the agent re-screenshots and repeats. A grant that did not wait runs at once.
 * - Letting go (turn end, idle, `revoke` from main) first aborts the in-flight acting run and awaits the
 *   controllers' `revokeControl`, and only then emits `desktop_slot_release` (revoke needs none: main asked).
 */
import { DESKTOP_SLOT_IDLE_MS, type DesktopSlotReason } from "./desktop-slot-contracts";

/** A frame this module sends to main (`env.emit`; main adds the tab). */
export type SlotFrame =
	| { type: "desktop_slot_acquire"; requestId: string }
	| { type: "desktop_slot_touch" }
	| { type: "desktop_slot_release"; reason: DesktopSlotReason; requestId?: string };

export interface SlotHost {
	emit(frame: SlotFrame): void;
	/** Abort-free revoke of every controller (`revokeControl?.()` of each supervisor seen); awaited before a release or revoke answers. */
	revokeControllers(): Promise<void>;
	newId(): string;
	idleMs?: number;
}

/** What an acting run is, for {@link DesktopSlotCore.runActing}. */
export interface ActingRun<T> {
	/** Runs the stock input run; `signal` is the stock signal chained with the slot's own abort. */
	run(signal: AbortSignal | undefined): Promise<T>;
	/** The result of a run that had to wait: nothing ran. */
	stale(): T;
	/** The result of a run the slot was taken back from. */
	revoked(): T;
	/** The stock signal (the user's stop of this tool call). */
	signal?: AbortSignal;
}

interface Waiter {
	grant(waited: boolean): void;
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

export class DesktopSlotCore {
	readonly #host: SlotHost;
	#holding = false;
	#idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** The in-flight acting runs' own aborts (revoke aborts them), with whether revoke did. */
	readonly #inflight = new Map<AbortController, { revoked: boolean }>();
	readonly #waiting = new Map<string, Waiter>();
	/** A let-go in progress (aborting and revoking): new acting runs wait for it before asking again. */
	#leaving: Promise<void> | undefined;

	constructor(host: SlotHost) {
		this.#host = host;
	}

	get holding(): boolean {
		return this.#holding;
	}

	/** Acting runs asking for the slot right now. */
	get waitingCount(): number {
		return this.#waiting.size;
	}

	/** A read-only run: always passes; a holder's counts as progress. */
	async runReadOnly<T>(run: () => Promise<T>): Promise<T> {
		if (!this.#holding) return run();
		this.#progress();
		try {
			return await run();
		} finally {
			if (this.#holding) this.#progress();
		}
	}

	/** An acting run: runs when the slot is held, otherwise queues for it (see the module comment). */
	async runActing<T>(acting: ActingRun<T>): Promise<T> {
		const { signal } = acting;
		for (;;) {
			if (signal?.aborted) throw abortReason(signal);
			if (this.#leaving) {
				await this.#leaving;
				continue;
			}
			if (this.#holding) return this.#runHeld(acting);
			const waited = await this.#acquire(signal);
			if (waited) {
				// Granted after waiting: the slot is ours now, but the screen may have changed, so nothing runs.
				this.#progress();
				return acting.stale();
			}
			if (!this.#holding) continue;
			return this.#runHeld(acting);
		}
	}

	async #runHeld<T>(acting: ActingRun<T>): Promise<T> {
		const own = new AbortController();
		const state = { revoked: false };
		this.#inflight.set(own, state);
		const stock = acting.signal;
		const onStock = () => own.abort(stock ? abortReason(stock) : undefined);
		stock?.addEventListener("abort", onStock, { once: true });
		this.#progress();
		try {
			return await acting.run(own.signal);
		} catch (error) {
			// Revoked under it (and not stopped by the person): a notice, not a crash.
			if (state.revoked && !stock?.aborted) return acting.revoked();
			throw error;
		} finally {
			stock?.removeEventListener("abort", onStock);
			this.#inflight.delete(own);
			if (this.#holding) this.#progress();
		}
	}

	/** Asks main for the slot; resolves with whether the grant waited. Rejects with the stock abort. */
	#acquire(signal: AbortSignal | undefined): Promise<boolean> {
		const requestId = this.#host.newId();
		return new Promise<boolean>((resolve, reject) => {
			const onAbort = () => {
				if (!this.#waiting.delete(requestId)) return;
				// Main drops this request from its queue (or, when it already granted it, takes the slot back).
				this.#host.emit({ type: "desktop_slot_release", reason: "abort", requestId });
				reject(signal ? abortReason(signal) : undefined);
			};
			this.#waiting.set(requestId, {
				grant: waited => {
					signal?.removeEventListener("abort", onAbort);
					this.#holding = true;
					this.#progress();
					resolve(waited);
				},
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#host.emit({ type: "desktop_slot_acquire", requestId });
		});
	}

	/** `desktop_slot.grant`: false when no run waits under that id (it was cancelled meanwhile). */
	grant(requestId: string, waited: boolean): boolean {
		const waiter = this.#waiting.get(requestId);
		if (!waiter) return false;
		this.#waiting.delete(requestId);
		waiter.grant(waited);
		return true;
	}

	/** `desktop_slot.revoke`: abort the in-flight run, revoke the controllers, drop the slot. No release frame: main asked. */
	revoke(_reason: string): Promise<void> {
		return this.#leave(false, undefined);
	}

	/** The session's turn ended: let go. */
	turnEnd(): Promise<void> {
		return this.#leave(true, "turn_end");
	}

	/** Cancels the idle timer, e.g. when the process is going away. */
	dispose(): void {
		this.#clearIdle();
	}

	#leave(emitRelease: boolean, reason: DesktopSlotReason | undefined): Promise<void> {
		if (this.#leaving) return this.#leaving;
		if (!this.#holding) return Promise.resolve();
		this.#clearIdle();
		for (const [own, state] of this.#inflight) {
			state.revoked = true;
			own.abort();
		}
		const leaving = (async () => {
			try {
				await this.#host.revokeControllers();
			} finally {
				this.#holding = false;
				this.#leaving = undefined;
				if (emitRelease && reason) this.#host.emit({ type: "desktop_slot_release", reason });
			}
		})();
		this.#leaving = leaving;
		return leaving;
	}

	/** A run started or ended: tell main (resets its lease) and restart the idle timer. */
	#progress(): void {
		this.#host.emit({ type: "desktop_slot_touch" });
		this.#armIdle();
	}

	#clearIdle(): void {
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
	}

	#armIdle(): void {
		this.#clearIdle();
		const timer = setTimeout(() => {
			this.#idleTimer = undefined;
			// A run still in flight is progress, not idleness.
			if (this.#inflight.size > 0) this.#armIdle();
			else void this.#leave(true, "idle").catch(() => undefined);
		}, this.#host.idleMs ?? DESKTOP_SLOT_IDLE_MS);
		if (typeof timer === "object") timer.unref?.();
		this.#idleTimer = timer;
	}
}
