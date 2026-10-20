/**
 * Crash-restart ladder shared by every tab's omp (`sidecar.ts`) and the bundled stats server
 * (`stats-server.ts`): a crash cycle gets a bounded backoff ladder. For the stats server, which spawns
 * only on demand, a server that already gave up can be revived by the next dashboard read — for a capped
 * number of rounds, after which the failure is reported instead of retried forever. Kept out of the
 * spawning modules so the ladder itself is testable.
 */

/** Restarts in a row before a crash cycle gives up. */
export const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAYS_MS = [1000, 2000, 4000];
/** Minimum gap between two demand-driven revive rounds. */
const REVIVE_COOLDOWN_MS = 30_000;
/** Revive rounds allowed since the last successful bind. */
const MAX_REVIVE_ROUNDS = 3;

/** The wait before restart `attempt` (1-based, up to MAX_RESTART_ATTEMPTS) of a crash cycle. */
export function restartDelay(attempt: number): number {
	return RESTART_DELAYS_MS[attempt - 1] ?? 4000;
}

/**
 * Windows ends every process of a logoff or shutdown with DBG_TERMINATE_PROCESS (0x40010004) while main
 * itself lives a few seconds longer. That is the session ending, not a crash: a respawn then dies with
 * STATUS_DLL_INIT_FAILED (0xC0000142) or hangs in startup until the machine is gone. `taskkill /f`, which
 * `terminate` uses, ends a process with exit code 1, and a POSIX exit code never exceeds 255.
 */
export const WINDOWS_SESSION_END_EXIT_CODE = 0x40010004;

export type Revive = "scheduled" | "already-pending" | "exhausted";

export class RestartBudget {
	#attempt = 0;
	#reviveRounds = 0;
	#lastReviveAt = Number.NEGATIVE_INFINITY;

	/**
	 * Delay before the next restart of this crash cycle, or null once the cycle
	 * is spent. Consumes a slot: calling it again advances the ladder.
	 */
	nextDelay(): number | null {
		if (this.#attempt >= MAX_RESTART_ATTEMPTS) return null;
		this.#attempt++;
		return restartDelay(this.#attempt);
	}

	/**
	 * A read asked for the server after it had given up. Cooldown bounds how
	 * often a broken binary is re-spawned; the round cap is what eventually lets
	 * the caller surface a dead-end instead of retrying for the session's life.
	 */
	revive(now: number): Revive {
		if (this.#reviveRounds >= MAX_REVIVE_ROUNDS) return "exhausted";
		if (now - this.#lastReviveAt < REVIVE_COOLDOWN_MS) return "already-pending";
		this.#reviveRounds++;
		this.#lastReviveAt = now;
		this.#attempt = 0;
		return "scheduled";
	}

	/** The server bound its port: both budgets start over. */
	noteReady(): void {
		this.#attempt = 0;
		this.#reviveRounds = 0;
		this.#lastReviveAt = Number.NEGATIVE_INFINITY;
	}
}
