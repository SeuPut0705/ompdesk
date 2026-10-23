/**
 * An omp that opens a session another live omp still owns moves it to a new file (stock `SessionManager`,
 * `"open-elsewhere"`): a relaunch right after an update, while the last launch's omp still journals and exits, split
 * the run it continued into two files. A start on a stored session waits for the owner to let go first, polled
 * through stock's own ownership lease (`sessions.owned` in the stock helper). Still owned after
 * `SESSION_FREE_WAIT_MS` (an omp the person runs in a terminal), the start opens nothing and says why
 * (SidecarManager: `error`, Restart waits again): opening it anyway is the split. A lease is an OS lock, so a dead
 * owner never holds it; when the helper cannot tell, the start goes on.
 */
export const SESSION_FREE_WAIT_MS = 60_000;
/**
 * Polled fast while an owner is likely just closing (an update's relaunch: the last launch's omp exits within seconds),
 * then slowly: a tab that keeps waiting for an omp in a terminal asks the stock helper every 2 s, not four times a second.
 */
const FAST_POLL_MS = 250;
const FAST_FOR_MS = 5_000;
const SLOW_POLL_MS = 2_000;

export interface SessionFreeDeps {
	owned: (sessionPath: string) => Promise<boolean>;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

/** Resolves once no other live omp owns `sessionPath` (`free`), or with `owned` once the wait is over. */
export async function whenSessionFree(sessionPath: string, deps: SessionFreeDeps): Promise<"free" | "owned"> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const started = now();
	const deadline = started + SESSION_FREE_WAIT_MS;
	for (;;) {
		const owned = await deps.owned(sessionPath).catch(() => false);
		if (!owned) return "free";
		if (now() >= deadline) return "owned";
		await sleep(now() - started < FAST_FOR_MS ? FAST_POLL_MS : SLOW_POLL_MS);
	}
}
