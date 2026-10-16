/**
 * The idle recap timer's rules, without omp imports so the GUI's vitest can
 * drive them with a fake session and fake timers
 * (src/main/bridge-session-recap.test.ts). A copy of the TUI's
 * `#scheduleIdleRecap` / `#cancelIdleRecap` / `#runIdleRecap` /
 * `#idleConditionsHold` / `refreshIdleRecapTimer` (stock
 * `modes/controllers/event-controller.ts`), which only the terminal UI runs:
 * RPC mode has no timer, and the bridge cannot call the controller's private
 * methods. The recap itself stays stock's (its prompt, `runEphemeralTurn`,
 * `recordRecap`); `generate` and `deliver` are supplied by session-recap.ts.
 *
 * One difference, as in idle-compaction-core.ts: the TUI reads its editor, the
 * bridge gets the GUI draft's emptiness from the renderer (`setDraftEmpty`).
 * Clearing a draft while a window is still pending arms the timer, which the
 * TUI would only do at the next `agent_end`.
 */

/** `recap.*` as stock's `cfgRecap` reads them. */
export interface RecapSettings {
	enabled: boolean;
	idleSeconds: number;
}

/** The slice of the live AgentSession the timer touches. */
export interface RecapSession {
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
}

/** Session event fields the timer reacts to. */
export interface RecapEvent {
	type: string;
	isTerminal?: boolean;
}

/** The settings whose live change re-arms the timer (stock's `refreshIdleRecapTimer`). */
export const RECAP_SETTING_PATHS: readonly string[] = ["recap.enabled", "recap.idleSeconds"];

/** Stock clamps the delay to this many seconds. */
const MIN_SECONDS = 1;
const MAX_SECONDS = 3600;

/** What a generated recap hands to `deliver`: the whole reply (journaled) and its one-line preview (shown). */
export interface Recap {
	reply: string;
	preview: string;
}

export interface RecapHooks<S extends RecapSession> {
	read(session: S): RecapSettings | Promise<RecapSettings>;
	/** Stock's recap turn; undefined when there is nothing to recap or the reply was empty. */
	generate(session: S, signal: AbortSignal): Promise<Recap | undefined>;
	/** Journal and show a recap that is still current. */
	deliver(session: S, recap: Recap): Promise<void>;
}

export class RecapTimer<S extends RecapSession = RecapSession> {
	#timer: NodeJS.Timeout | undefined;
	/** Bumped by every cancel, so an arm still reading its settings knows it was superseded. */
	#generation = 0;
	#abort: AbortController | undefined;
	#draftEmpty = true;
	/** True from a terminal `agent_end` until this idle window's timer fires (stock's `#idleRecapPending`). */
	#pending = false;
	readonly #hooks: RecapHooks<S>;

	constructor(hooks: RecapHooks<S>) {
		this.#hooks = hooks;
	}

	get armed(): boolean {
		return this.#timer !== undefined;
	}

	/** A recap turn is in flight. */
	get running(): boolean {
		return this.#abort !== undefined;
	}

	/** Drops the timer and aborts a recap turn in flight: any activity supersedes the recap. */
	cancel(): void {
		this.#generation += 1;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#abort?.abort();
		this.#abort = undefined;
	}

	/** The session changed under the timer (switch, branch, tree move): no idle window of the old one carries over. */
	reset(): void {
		this.cancel();
		this.#pending = false;
	}

	async schedule(session: S): Promise<void> {
		this.cancel();
		const generation = this.#generation;
		if (session.isCompacting) return;
		const settings = await this.#hooks.read(session);
		// An arm or a cancel that came while the settings loaded supersedes this one.
		if (generation !== this.#generation) return;
		if (!settings.enabled || !this.#draftEmpty) return;
		// A turn may have started while the settings loaded.
		if (session.isStreaming) return;
		const seconds = Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, settings.idleSeconds));
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#pending = false;
			void this.#run(session);
		}, seconds * 1000);
		this.#timer.unref?.();
	}

	/** Stock's idle gate, shared by the timer fire and the re-check after the reply lands. */
	#idle(session: S): boolean {
		return !session.isStreaming && !session.isCompacting && this.#draftEmpty;
	}

	async #run(session: S): Promise<void> {
		if (!this.#idle(session)) return;
		const abort = new AbortController();
		this.#abort = abort;
		try {
			const recap = await this.#hooks.generate(session, abort.signal);
			// Idle conditions are re-checked after the reply so a stale recap never lands over fresh work.
			if (this.#abort !== abort || abort.signal.aborted || !this.#idle(session) || !recap) return;
			await this.#hooks.deliver(session, recap);
		} catch {
			// Stock only debug-logs a failed recap turn.
		} finally {
			if (this.#abort === abort) this.#abort = undefined;
		}
	}

	/** Stock arms after a terminal `agent_end` and cancels when a turn or an auto-compaction starts or ends. */
	onEvent(event: RecapEvent, session: S): Promise<void> | undefined {
		switch (event.type) {
			case "agent_start":
				// The window of the turn before is over; the next terminal agent_end opens one.
				this.#pending = false;
				this.cancel();
				return undefined;
			case "auto_compaction_start":
			case "auto_compaction_end":
				this.cancel();
				return undefined;
			case "agent_end":
				// A pending async wake is a pause, not idle.
				if (event.isTerminal === false) return undefined;
				this.#pending = true;
				return this.schedule(session);
			default:
				return undefined;
		}
	}

	/** A live write of one of {@link RECAP_SETTING_PATHS}: rearm (or cancel, per the new values) inside a pending idle window. */
	settingChanged(path: string, session: S): Promise<void> | undefined {
		if (!RECAP_SETTING_PATHS.includes(path)) return undefined;
		if (!this.#pending || session.isStreaming) return undefined;
		return this.schedule(session);
	}

	async setDraftEmpty(empty: boolean, session: S): Promise<void> {
		const wasEmpty = this.#draftEmpty;
		this.#draftEmpty = empty;
		if (!empty) this.cancel();
		else if (!wasEmpty && this.#pending && !session.isStreaming) await this.schedule(session);
	}
}
