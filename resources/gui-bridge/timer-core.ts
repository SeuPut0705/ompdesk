/**
 * The idle-window state machine the bridge's copies of the TUI's idle timers share (idle-compaction-core.ts,
 * session-recap-core.ts), without omp imports so the GUI's vitest can drive it with a fake session and fake
 * timers. Stock's `modes/controllers/event-controller.ts` gives both the same shape: a terminal `agent_end`
 * opens an idle window and arms the timer, `agent_start` closes it, any start or end of an auto-compaction
 * cancels it, and the arm reads its settings asynchronously, so every cancel supersedes an arm still reading.
 * The bridge also gets the GUI draft's emptiness from the renderer (`setDraftEmpty`): a draft cancels the timer,
 * and clearing it inside an open window arms it again, which the TUI would only do at the next `agent_end`.
 *
 * Each timer keeps its own settings, delay bounds, fire and live-setting rules.
 */

/** The slice of the live AgentSession every idle timer touches. */
export interface TimerSession {
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
}

/** Session event fields the timers react to. */
export interface TimerEvent {
	type: string;
	isTerminal?: boolean;
}

export abstract class IdleWindowTimer<S extends TimerSession, Settings> {
	#timer: NodeJS.Timeout | undefined;
	/** Bumped by every cancel, so an arm still reading its settings knows it was superseded. */
	#generation = 0;
	#draftEmpty = true;
	/** A terminal `agent_end` opened an idle window and no turn started since. */
	#windowOpen = false;
	/** The timer's settings as stock reads them. */
	readonly #read: (session: S) => Settings | Promise<Settings>;

	constructor(read: (session: S) => Settings | Promise<Settings>) {
		this.#read = read;
	}

	get armed(): boolean {
		return this.#timer !== undefined;
	}

	protected get draftEmpty(): boolean {
		return this.#draftEmpty;
	}

	protected get windowOpen(): boolean {
		return this.#windowOpen;
	}

	protected closeWindow(): void {
		this.#windowOpen = false;
	}

	/**
	 * How long to wait with the settings just read, the draft empty and no newer arm or cancel; `undefined`
	 * leaves the timer off.
	 */
	protected abstract delayMs(settings: Settings, session: S): number | undefined;

	/** The timer fired, with the settings it was armed with. */
	protected abstract fire(session: S, settings: Settings): void;

	cancel(): void {
		this.#generation += 1;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	async schedule(session: S): Promise<void> {
		this.cancel();
		// The settings read awaits: an arm or a cancel that comes meanwhile supersedes this one,
		// or two arms would each set a timer and only the second could ever be cancelled.
		const generation = this.#generation;
		// Context maintenance may reset the session before the timer fires.
		if (session.isCompacting) return;
		const settings = await this.#read(session);
		if (generation !== this.#generation || !this.#draftEmpty) return;
		const delay = this.delayMs(settings, session);
		if (delay === undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.fire(session, settings);
		}, delay);
		this.#timer.unref?.();
	}

	/** Stock arms after a terminal `agent_end` and cancels when a turn or an auto-compaction starts or ends. */
	onEvent(event: TimerEvent, session: S): Promise<void> | undefined {
		switch (event.type) {
			case "agent_start":
				// The window of the turn before is over; the next terminal agent_end opens one.
				this.#windowOpen = false;
				this.cancel();
				return undefined;
			case "auto_compaction_start":
			case "auto_compaction_end":
				this.cancel();
				return undefined;
			case "agent_end":
				// A pending async wake is a pause, not idle.
				if (event.isTerminal === false) return undefined;
				this.#windowOpen = true;
				return this.schedule(session);
			default:
				return undefined;
		}
	}

	async setDraftEmpty(empty: boolean, session: S): Promise<void> {
		const wasEmpty = this.#draftEmpty;
		this.#draftEmpty = empty;
		if (!empty) this.cancel();
		else if (!wasEmpty && this.#windowOpen && !session.isStreaming) await this.schedule(session);
	}
}
