/**
 * Diagnostic only: a tab whose turn ended but that still reads running (settling: stock reported background work and
 * no `session_settled` has come) for {@link SETTLE_DIAGNOSTIC_MS} gets one runtime-log line with stock's own view
 * (`get_state`), main's run flags and the last settle frame main applied. It changes nothing: the tab keeps waiting
 * for stock. Two runs of 95 after the 20 Oct 2026 speed work stayed settling for good with the answer done, and
 * 414 later attempts did not reproduce it; this line is what the next one leaves behind.
 */
export const SETTLE_DIAGNOSTIC_MS = 60_000;

/** The last `prompt_result` / `session_settled` main applied to the tab's run. */
export interface SettleFrameNote {
	frame: "prompt_result" | "session_settled";
	settled: boolean;
	at: number;
}

export interface SettleWatchTimers {
	now(): number;
	setTimeout(run: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface SettleWatchDeps {
	/** Stock's state and main's flags for the tab, read when the line is written. */
	facts(tabId: string): Promise<Record<string, unknown>>;
	log(details: Record<string, unknown>): void;
	timers?: SettleWatchTimers;
	delayMs?: number;
}

const realTimers: SettleWatchTimers = {
	now: () => Date.now(),
	setTimeout: (run, ms) => {
		const handle = setTimeout(run, ms);
		handle.unref?.();
		return handle;
	},
	clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
};

export class SettleWatch {
	readonly #deps: SettleWatchDeps;
	readonly #timers: SettleWatchTimers;
	readonly #delay: number;
	readonly #pending = new Map<string, { handle: unknown; since: number }>();
	readonly #frames = new Map<string, SettleFrameNote>();

	constructor(deps: SettleWatchDeps) {
		this.#deps = deps;
		this.#timers = deps.timers ?? realTimers;
		this.#delay = deps.delayMs ?? SETTLE_DIAGNOSTIC_MS;
	}

	/** Main applied a settle frame to the tab's run. */
	noteFrame(tabId: string, frame: SettleFrameNote["frame"], settled: boolean): void {
		this.#frames.set(tabId, { frame, settled, at: this.#timers.now() });
	}

	/** The tab's settling state after any change; the line is written once per stretch of settling. */
	track(tabId: string, settling: boolean): void {
		const pending = this.#pending.get(tabId);
		if (!settling) {
			if (pending) this.#timers.clearTimeout(pending.handle);
			this.#pending.delete(tabId);
			return;
		}
		if (pending) return;
		const since = this.#timers.now();
		const handle = this.#timers.setTimeout(() => void this.#write(tabId, since), this.#delay);
		this.#pending.set(tabId, { handle, since });
	}

	/** The tab went away. */
	forget(tabId: string): void {
		this.track(tabId, false);
		this.#frames.delete(tabId);
	}

	async #write(tabId: string, since: number): Promise<void> {
		const facts = await this.#deps.facts(tabId).catch((error: unknown) => ({
			error: error instanceof Error ? error.message : String(error),
		}));
		// Settled (or gone) while stock answered: nothing was stuck.
		if (this.#pending.get(tabId)?.since !== since) return;
		const frame = this.#frames.get(tabId);
		this.#deps.log({
			tabId,
			settlingMs: this.#timers.now() - since,
			lastSettleFrame: frame ? { ...frame, ageMs: this.#timers.now() - frame.at } : null,
			...facts,
		});
	}
}
