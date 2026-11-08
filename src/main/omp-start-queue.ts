/** How many omps may be starting at once. */
export const OMP_STARTS_AT_ONCE = 2;
/** Longest one start holds its place: a start that has not answered by then lets the next one go anyway. */
export const START_SLOT_CAP_MS = 15_000;

/** Gives the place back; a second call does nothing. */
export type StartSlotRelease = () => void;

/**
 * The one queue every omp start of this app goes through: at most `limit` omps starting at once, the next one starting
 * when one answered its first RPC, ended, or held its place `capMs`. A relaunch restored ten tabs and started ten omps
 * at once (8 Nov 2026, and 2 Nov 2026 on another Mac); every one of them stalled. `holdUntil` keeps every start back
 * until the launch's reap of leftover omps (`OmpProcesses.reapLeftovers`) is over.
 */
export class OmpStartQueue {
	readonly #limit: number;
	readonly #capMs: number;
	#running = 0;
	readonly #waiting: Array<() => void> = [];
	#held: Promise<void> = Promise.resolve();

	constructor(limit = OMP_STARTS_AT_ONCE, capMs = START_SLOT_CAP_MS) {
		this.#limit = limit;
		this.#capMs = capMs;
	}

	/** No start goes before `gate` settled (fulfilled or not). */
	holdUntil(gate: Promise<unknown>): void {
		const previous = this.#held;
		this.#held = Promise.allSettled([previous, gate]).then(() => undefined);
	}

	/** Resolves with the place once a start may go, first come first served. */
	async acquire(): Promise<StartSlotRelease> {
		await this.#held;
		if (this.#running < this.#limit) this.#running++;
		else {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiting.push(resolve);
			await promise;
		}
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			clearTimeout(timer);
			const next = this.#waiting.shift();
			// The place passes on: the count of starts under way stays the same.
			if (next) next();
			else this.#running--;
		};
		const timer = setTimeout(release, this.#capMs);
		timer.unref?.();
		return release;
	}
}
