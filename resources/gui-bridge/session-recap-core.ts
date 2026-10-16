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
 * The idle window, the arm's supersession and the GUI draft are
 * timer-core.ts's, shared with idle compaction: the TUI reads its editor, the
 * bridge gets the GUI draft's emptiness from the renderer (`setDraftEmpty`).
 * Clearing a draft while a window is still pending arms the timer, which the
 * TUI would only do at the next `agent_end`.
 */

import { IdleWindowTimer, type TimerSession } from "./timer-core";

/** `recap.*` as stock's `cfgRecap` reads them. */
export interface RecapSettings {
	enabled: boolean;
	idleSeconds: number;
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

export interface RecapHooks<S extends TimerSession> {
	read(session: S): RecapSettings | Promise<RecapSettings>;
	/** Stock's recap turn; undefined when there is nothing to recap or the reply was empty. */
	generate(session: S, signal: AbortSignal): Promise<Recap | undefined>;
	/** Journal and show a recap that is still current. */
	deliver(session: S, recap: Recap): Promise<void>;
}

/** Stock's idle window (`#idleRecapPending`) runs from a terminal `agent_end` until its timer fires. */
export class RecapTimer<S extends TimerSession = TimerSession> extends IdleWindowTimer<S, RecapSettings> {
	#abort: AbortController | undefined;
	readonly #hooks: RecapHooks<S>;

	constructor(hooks: RecapHooks<S>) {
		super(session => hooks.read(session));
		this.#hooks = hooks;
	}

	/** A recap turn is in flight. */
	get running(): boolean {
		return this.#abort !== undefined;
	}

	/** Drops the timer and aborts a recap turn in flight: any activity supersedes the recap. */
	override cancel(): void {
		super.cancel();
		this.#abort?.abort();
		this.#abort = undefined;
	}

	/** The session changed under the timer (switch, branch, tree move): no idle window of the old one carries over. */
	reset(): void {
		this.cancel();
		this.closeWindow();
	}

	protected delayMs(settings: RecapSettings, session: S): number | undefined {
		if (!settings.enabled) return undefined;
		// A turn may have started while the settings loaded.
		if (session.isStreaming) return undefined;
		return Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, settings.idleSeconds)) * 1000;
	}

	protected fire(session: S): void {
		this.closeWindow();
		void this.#run(session);
	}

	/** Stock's idle gate, shared by the timer fire and the re-check after the reply lands. */
	#idle(session: S): boolean {
		return !session.isStreaming && !session.isCompacting && this.draftEmpty;
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

	/** A live write of one of {@link RECAP_SETTING_PATHS}: rearm (or cancel, per the new values) inside a pending idle window. */
	settingChanged(path: string, session: S): Promise<void> | undefined {
		if (!RECAP_SETTING_PATHS.includes(path)) return undefined;
		if (!this.windowOpen || session.isStreaming) return undefined;
		return this.schedule(session);
	}
}
