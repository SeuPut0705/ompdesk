/**
 * The idle compaction timer's rules, without omp imports so the GUI's vitest
 * can drive them with a fake session and fake timers
 * (src/main/bridge-idle-compaction.test.ts). A copy of the TUI's
 * `#scheduleIdleCompaction` / `#cancelIdleCompaction` /
 * `refreshIdleCompactionTimer` (stock `modes/controllers/event-controller.ts`),
 * which only the terminal UI runs: RPC mode has no timer, and the bridge
 * cannot call the controller's private methods. The work itself stays stock's
 * (`AgentSession.runIdleCompaction()`). The idle window, the arm's
 * supersession and the GUI draft are timer-core.ts's, shared with the recap.
 */

import { IdleWindowTimer, type TimerSession } from "./timer-core";

/** What an arm reads from stock: `cfgCompaction.get(settings)`'s idle fields and stock `getCacheWarmingDelayMs`. */
export interface IdleSettings {
	idleEnabled: boolean;
	idleThresholdTokens: number;
	idleTimeoutSeconds: number;
	/** Stock `session/cache-warmer` `getCacheWarmingDelayMs`: when stock would refresh an entry of this lifetime. */
	cacheWarmingDelayMs(ttlMs: number): number | undefined;
	/**
	 * Stock's `#promptCachePersistent` (pi-catalog `isPromptCachePersistent` of the session's model, omp 18.12.6): a
	 * cache that never expires (logged-in Codex) stays warm across any idle gap, so idle compaction would only throw
	 * it away. Asked at the arm and again when the timer fires.
	 */
	promptCachePersistent(): boolean;
}

/** Stock `PromptCacheEntry` (`session/cache-warmer`): the cache entry the latest main-loop request wrote. */
export interface PromptCacheEntry {
	touchedAt: number;
	tier: "short" | "long";
	ttlMs: number;
}

/** The slice of the live AgentSession the timer touches. */
export interface IdleSession extends TimerSession {
	getContextUsage(): { tokens?: number | null } | undefined;
	runIdleCompaction(): Promise<void>;
	readonly promptCacheEntry?: PromptCacheEntry;
}

/** The three settings whose live change re-arms the timer (stock's `refreshIdleCompactionTimer`). */
export const IDLE_SETTING_PATHS: readonly string[] = [
	"compaction.idleEnabled",
	"compaction.idleThresholdTokens",
	"compaction.idleTimeoutSeconds",
];

/** Stock clamps the delay to this many seconds. */
const MIN_SECONDS = 60;
const MAX_SECONDS = 3600;
/** Stock's `IDLE_COMPACTION_CACHE_LEAD_MS` (event-controller.ts, not exported): compact this long before stock would refresh the entry. */
export const IDLE_COMPACTION_CACHE_LEAD_MS = 5_000;

export class IdleCompactionTimer<S extends IdleSession = IdleSession> extends IdleWindowTimer<S, IdleSettings> {
	protected delayMs(settings: IdleSettings, session: S): number | undefined {
		if (!settings.idleEnabled || settings.promptCachePersistent()) return undefined;
		const threshold = settings.idleThresholdTokens;
		if (threshold <= 0 || (session.getContextUsage()?.tokens ?? 0) < threshold) return undefined;
		// A turn may have started while the settings loaded.
		if (session.isStreaming || session.isCompacting) return undefined;
		// Stock compacts just before a 1-hour (long-tier) prompt cache entry would lapse, while the summary request
		// can still read the cached prefix; a 5-minute entry, an unknown lifetime and an expired entry fall back to
		// the configured delay.
		const entry = session.promptCacheEntry?.tier === "long" ? session.promptCacheEntry : undefined;
		const refreshMs = entry ? settings.cacheWarmingDelayMs(entry.ttlMs) : undefined;
		const now = Date.now();
		if (entry && refreshMs !== undefined && entry.touchedAt + entry.ttlMs > now)
			return Math.max(0, entry.touchedAt + refreshMs - IDLE_COMPACTION_CACHE_LEAD_MS - now);
		return Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, settings.idleTimeoutSeconds)) * 1000;
	}

	protected fire(session: S, settings: IdleSettings): void {
		// Re-check like stock: pruning may have dropped usage below the threshold meanwhile.
		if (session.isStreaming || session.isCompacting || !this.draftEmpty) return;
		if (settings.promptCachePersistent()) return;
		if ((session.getContextUsage()?.tokens ?? 0) < settings.idleThresholdTokens) return;
		void session.runIdleCompaction().catch(() => {
			// Stock reports its own failure through its compaction events.
		});
	}

	/** A live write of one of {@link IDLE_SETTING_PATHS}: re-arm while idle, cancel while streaming. */
	settingChanged(path: string, session: S): Promise<void> | undefined {
		if (!IDLE_SETTING_PATHS.includes(path)) return undefined;
		if (!session.isStreaming) return this.schedule(session);
		this.cancel();
		return undefined;
	}
}
