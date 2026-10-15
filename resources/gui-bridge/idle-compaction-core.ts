/**
 * The idle compaction timer's rules, without omp imports so the GUI's vitest
 * can drive them with a fake session and fake timers
 * (src/main/bridge-idle-compaction.test.ts). A copy of the TUI's
 * `#scheduleIdleCompaction` / `#cancelIdleCompaction` /
 * `refreshIdleCompactionTimer` (stock `modes/controllers/event-controller.ts`),
 * which only the terminal UI runs: RPC mode has no timer, and the bridge
 * cannot call the controller's private methods. The work itself stays stock's
 * (`AgentSession.runIdleCompaction()`).
 *
 * One difference: the TUI reads its editor, the bridge gets the GUI draft's
 * emptiness from the renderer (`setDraftEmpty`). Clearing a draft while idle
 * after a turn arms the timer, which the TUI would only do at the next `agent_end`.
 */

/** `cfgCompaction.get(settings)` fields this timer reads. */
export interface IdleSettings {
	idleEnabled: boolean;
	idleThresholdTokens: number;
	idleTimeoutSeconds: number;
}

/** The slice of the live AgentSession the timer touches. */
export interface IdleSession {
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	getContextUsage(): { tokens?: number | null } | undefined;
	runIdleCompaction(): Promise<void>;
}

/** Session event fields the timer reacts to. */
export interface IdleEvent {
	type: string;
	isTerminal?: boolean;
}

/** The three settings whose live change re-arms the timer (stock's `refreshIdleCompactionTimer`). */
export const IDLE_SETTING_PATHS: readonly string[] = [
	"compaction.idleEnabled",
	"compaction.idleThresholdTokens",
	"compaction.idleTimeoutSeconds",
];

export class IdleCompactionTimer<S extends IdleSession = IdleSession> {
	#timer: NodeJS.Timeout | undefined;
	#draftEmpty = true;
	readonly #read: (session: S) => IdleSettings | Promise<IdleSettings>;
	/** A turn ended and none started since: the window stock's timer covers. */
	#idleAfterTurn = false;

	constructor(read: (session: S) => IdleSettings | Promise<IdleSettings>) {
		this.#read = read;
	}

	get armed(): boolean {
		return this.#timer !== undefined;
	}

	cancel(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	async schedule(session: S): Promise<void> {
		this.cancel();
		// Context maintenance may reset the session before the timer fires.
		if (session.isCompacting) return;
		const settings = await this.#read(session);
		if (!settings.idleEnabled || !this.#draftEmpty) return;
		const threshold = settings.idleThresholdTokens;
		if (threshold <= 0 || (session.getContextUsage()?.tokens ?? 0) < threshold) return;
		// A turn may have started while the settings loaded.
		if (session.isStreaming || session.isCompacting) return;
		const timeoutMs = Math.max(60, Math.min(3600, settings.idleTimeoutSeconds)) * 1000;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			// Re-check like stock: pruning may have dropped usage below the threshold meanwhile.
			if (session.isStreaming || session.isCompacting || !this.#draftEmpty) return;
			if ((session.getContextUsage()?.tokens ?? 0) < threshold) return;
			void session.runIdleCompaction().catch(() => {
				// Stock reports its own failure through its compaction events.
			});
		}, timeoutMs);
		this.#timer.unref?.();
	}

	/** Stock arms after `agent_end` and cancels when a turn or an auto-compaction starts or ends. */
	onEvent(event: IdleEvent, session: S): Promise<void> | undefined {
		switch (event.type) {
			case "agent_start":
				this.#idleAfterTurn = false;
				this.cancel();
				return undefined;
			case "auto_compaction_start":
			case "auto_compaction_end":
				this.cancel();
				return undefined;
			case "agent_end":
				// A pending async wake is a pause, not idle.
				if (event.isTerminal === false) return undefined;
				this.#idleAfterTurn = true;
				return this.schedule(session);
			default:
				return undefined;
		}
	}

	/** A live write of one of {@link IDLE_SETTING_PATHS}: re-arm while idle, cancel while streaming. */
	settingChanged(path: string, session: S): Promise<void> | undefined {
		if (!IDLE_SETTING_PATHS.includes(path)) return undefined;
		if (!session.isStreaming) return this.schedule(session);
		this.cancel();
		return undefined;
	}

	async setDraftEmpty(empty: boolean, session: S): Promise<void> {
		const wasEmpty = this.#draftEmpty;
		this.#draftEmpty = empty;
		if (!empty) this.cancel();
		else if (!wasEmpty && this.#idleAfterTurn && !session.isStreaming) await this.schedule(session);
	}
}
