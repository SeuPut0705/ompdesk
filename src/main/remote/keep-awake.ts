/**
 * Keep-awake policy for the host role: while the option is on and a paired
 * device is connected, or a host tab is still running a turn, this computer
 * must not sleep. The blocker is acquired at once and released after a quiet
 * period, so a device that drops and reconnects does not flap it; turning the
 * option off releases it immediately. No Electron imports — the caller injects
 * `powerSaveBlocker.start('prevent-app-suspension')` and `stop`.
 */

/** Quiet period after the last use before the blocker goes. */
export const KEEP_AWAKE_RELEASE_MS = 60_000;

export interface KeepAwakeBlocker {
	/** Acquire; returns the blocker id `stop` takes. */
	start(): number;
	stop(id: number): void;
}

export interface KeepAwakeInput {
	/** The option is on (and the host role is running). */
	enabled: boolean;
	/** At least one paired device is connected. */
	connected: boolean;
	/** At least one host tab is running a turn. */
	running: boolean;
}

export interface KeepAwakeOptions {
	blocker: KeepAwakeBlocker;
	releaseMs?: number;
	/**
	 * `held` changed on the policy's own schedule (the debounced release).
	 * Changes made inside `update()` are visible to its caller right away.
	 */
	onChange?: () => void;
}

export class KeepAwakePolicy {
	readonly #blocker: KeepAwakeBlocker;
	readonly #releaseMs: number;
	readonly #onChange: (() => void) | undefined;
	#id: number | null = null;
	#releaseTimer: NodeJS.Timeout | undefined;

	constructor(options: KeepAwakeOptions) {
		this.#blocker = options.blocker;
		this.#releaseMs = options.releaseMs ?? KEEP_AWAKE_RELEASE_MS;
		this.#onChange = options.onChange;
	}

	/** The blocker is held now (in use, or within the quiet period after). */
	get held(): boolean {
		return this.#id !== null;
	}

	update(input: KeepAwakeInput): void {
		if (input.enabled && (input.connected || input.running)) {
			this.#cancelRelease();
			this.#id ??= this.#blocker.start();
			return;
		}
		if (!input.enabled) {
			this.#release();
			return;
		}
		if (this.#id === null || this.#releaseTimer) return;
		this.#releaseTimer = setTimeout(() => {
			this.#releaseTimer = undefined;
			this.#release();
			this.#onChange?.();
		}, this.#releaseMs);
		this.#releaseTimer.unref?.();
	}

	/** Release now, whatever the state (quit). */
	dispose(): void {
		this.#release();
	}

	#cancelRelease(): void {
		clearTimeout(this.#releaseTimer);
		this.#releaseTimer = undefined;
	}

	#release(): void {
		this.#cancelRelease();
		if (this.#id === null) return;
		const id = this.#id;
		this.#id = null;
		this.#blocker.stop(id);
	}
}
