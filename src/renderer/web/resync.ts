/**
 * Catching up after a reconnect that missed events (ws-transport.ts `onResync`), in place: the page reads its state
 * again (resync-page.ts: the tab list, the visible tabs' transcripts and session state, the open asks and the
 * snapshots the missed pushes would have replaced) instead of loading itself again, so a phone that lost its link
 * mid-reply keeps its scroll, its draft and whatever the person was doing. A failed pass is tried again after a
 * short wait (`retryMs`, growing); only after `maxFailures` failures in a row does the page give up and reload,
 * and that reload waits for a moment nobody uses the page (sw-update.ts `reloadWhenUnused`).
 */

export interface PageResyncOptions {
	/** Read the page's state again; false (or a throw) when it could not (the link dropped again, the host refused). */
	run: () => Promise<boolean>;
	/** `maxFailures` passes in a row failed: the last resort. Called once. */
	giveUp: (failures: number) => void;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	retryMs?: number;
	maxFailures?: number;
}

export class PageResync {
	readonly #options: PageResyncOptions;
	#running = false;
	#again = false;
	#failures = 0;
	#retry: unknown = null;
	#gaveUp = false;
	/** Passes that completed, for the tests and the runtime log. */
	passes = 0;

	constructor(options: PageResyncOptions) {
		this.#options = options;
	}

	/** The page must catch up: a pass runs now, or once more after the one in flight. */
	request(): void {
		if (this.#gaveUp) return;
		if (this.#retry !== null) {
			(this.#options.clearTimer ?? clearTimeout)(this.#retry as ReturnType<typeof setTimeout>);
			this.#retry = null;
		}
		if (this.#running) {
			this.#again = true;
			return;
		}
		void this.#pass();
	}

	async #pass(): Promise<void> {
		this.#running = true;
		this.#again = false;
		let ok: boolean;
		try {
			ok = await this.#options.run();
		} catch {
			ok = false;
		}
		this.#running = false;
		if (ok) {
			this.passes++;
			this.#failures = 0;
			if (this.#again) this.request();
			return;
		}
		this.#failures++;
		const max = this.#options.maxFailures ?? 3;
		if (this.#failures >= max) {
			this.#gaveUp = true;
			this.#options.giveUp(this.#failures);
			return;
		}
		if (this.#again) {
			this.request();
			return;
		}
		const wait = (this.#options.retryMs ?? 2000) * this.#failures;
		this.#retry = (this.#options.setTimer ?? setTimeout)(() => {
			this.#retry = null;
			this.request();
		}, wait);
	}
}
