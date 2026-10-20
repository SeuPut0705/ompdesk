/**
 * Closing the lid of a laptop that is charging must not stop OMPdesk's running work; on battery the OS keeps its own
 * behaviour. Electron's `powerSaveBlocker` (`prevent-app-suspension`) is an idle-sleep assertion a lid close ignores,
 * so whenever a keep-awake blocker is held (keep-awake.ts: "keep awake while working" and the host role's), this
 * policy also holds a platform `LidBackend` while the computer is a laptop on AC power. macOS and Windows differ
 * only in the backend (lid-backend-mac.ts, lid-backend-windows.ts); every rule is here. No Electron imports.
 */

import type { KeepAwakeBlocker } from "../remote/keep-awake";

export interface LidHoldOutcome {
	/** The backend changed something (false: the user's own setting already keeps the work running). */
	changed: boolean;
	details?: Record<string, unknown>;
}

export interface LidBackend {
	/** What holds the lid, for the log ("caffeinate", "powercfg"). */
	readonly name: string;
	/** A computer with a lid to close: it has a battery. Asked once, when first needed. */
	isLaptop(): Promise<boolean>;
	/** Undo what an earlier process left held (it crashed or was killed). Runs before the first hold. */
	recover(): Promise<Record<string, unknown> | null>;
	hold(): Promise<LidHoldOutcome>;
	release(): Promise<void>;
	/** Release synchronously (quit: the process may end right after). */
	releaseNow(): void;
}

/** Why the lid hold changed, for the log. */
export type LidAwakeReason = "work" | "charging" | "work-ended" | "on-battery" | "quit";

export type LidAwakeLog = (
	message: "held" | "released" | "recovered" | "skipped" | "failed",
	details: Record<string, unknown>,
) => void;

export interface LidAwakeOptions {
	backend: LidBackend;
	/** On AC power now (Electron `!powerMonitor.isOnBatteryPower()`). */
	onAc: boolean;
	log: LidAwakeLog;
}

export class LidAwake {
	readonly #backend: LidBackend;
	readonly #log: LidAwakeLog;
	readonly #blockers = new Set<string>();
	#onAc: boolean;
	#applied = false;
	#cause: LidAwakeReason = "work";
	#laptop: Promise<boolean> | undefined;
	#recovered: Promise<void> | undefined;
	#running: Promise<void> | undefined;
	#disposed = false;

	constructor(options: LidAwakeOptions) {
		this.#backend = options.backend;
		this.#log = options.log;
		this.#onAc = options.onAc;
	}

	/** The lid hold is in place now. */
	get held(): boolean {
		return this.#applied;
	}

	/** Undo a hold a crashed process left (Windows: its lid setting). Every hold waits for it. */
	start(): Promise<void> {
		this.#recovered ??= this.#backend.recover().then(
			details => {
				if (details) this.#log("recovered", { backend: this.#backend.name, ...details });
			},
			error => this.#log("failed", { step: "recover", backend: this.#backend.name, error: errorText(error) }),
		);
		return this.#recovered;
	}

	/** `inner`, also counting as work for the lid while any of its blockers is held. */
	wrap(inner: KeepAwakeBlocker, label: string): KeepAwakeBlocker {
		return {
			start: () => {
				const id = inner.start();
				this.#setBlocker(`${label}:${id}`, true);
				return id;
			},
			stop: id => {
				inner.stop(id);
				this.#setBlocker(`${label}:${id}`, false);
			},
		};
	}

	setOnAc(onAc: boolean): void {
		if (onAc === this.#onAc) return;
		this.#onAc = onAc;
		this.#cause = onAc ? "charging" : "on-battery";
		this.#kick();
	}

	/** Quit: release at once, whatever runs. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#applied) this.#releaseNow("quit");
	}

	/** Resolves once the hold matches the inputs (tests). */
	async settled(): Promise<void> {
		while (this.#running) await this.#running;
	}

	#setBlocker(key: string, held: boolean): void {
		const before = this.#blockers.size > 0;
		if (held) this.#blockers.add(key);
		else this.#blockers.delete(key);
		const after = this.#blockers.size > 0;
		if (before === after) return;
		this.#cause = after ? "work" : "work-ended";
		this.#kick();
	}

	#kick(): void {
		if (this.#disposed || this.#running) return;
		this.#running = this.#converge().finally(() => {
			this.#running = undefined;
		});
	}

	/** Moves the backend toward the inputs, one step at a time, until they agree (inputs may change meanwhile). */
	async #converge(): Promise<void> {
		await this.start();
		while (!this.#disposed) {
			let want = this.#blockers.size > 0 && this.#onAc;
			if (want) want = await this.#isLaptop();
			if (this.#disposed || want === this.#applied) return;
			const reason = this.#cause;
			try {
				if (want) {
					const outcome = await this.#backend.hold();
					this.#applied = true;
					if (this.#disposed) {
						this.#releaseNow("quit");
						return;
					}
					this.#log("held", { reason, backend: this.#backend.name, changed: outcome.changed, ...outcome.details });
				} else {
					await this.#backend.release();
					this.#applied = false;
					this.#log("released", { reason, backend: this.#backend.name });
				}
			} catch (error) {
				// The next change of an input tries again; retrying here would spin on a backend that keeps failing.
				this.#log("failed", {
					step: want ? "hold" : "release",
					reason,
					backend: this.#backend.name,
					error: errorText(error),
				});
				return;
			}
		}
	}

	#isLaptop(): Promise<boolean> {
		this.#laptop ??= this.#backend.isLaptop().then(
			laptop => {
				if (!laptop) this.#log("skipped", { reason: "no battery", backend: this.#backend.name });
				return laptop;
			},
			error => {
				this.#log("failed", { step: "battery", backend: this.#backend.name, error: errorText(error) });
				return false;
			},
		);
		return this.#laptop;
	}

	#releaseNow(reason: LidAwakeReason): void {
		this.#applied = false;
		try {
			this.#backend.releaseNow();
			this.#log("released", { reason, backend: this.#backend.name });
		} catch (error) {
			this.#log("failed", { step: "release", reason, backend: this.#backend.name, error: errorText(error) });
		}
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
