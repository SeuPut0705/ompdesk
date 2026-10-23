/**
 * An omp that opens a session another live omp still owns moves it to a new file (stock `SessionManager`,
 * `"open-elsewhere"`): a relaunch right after an update, while the last launch's omp still journals and exits, split
 * the run it continued into two files. A start on a stored session waits for the owner to let go first, polled
 * through stock's own ownership lease (`sessions.owned` in the stock helper), and opens it anyway after
 * `SESSION_FREE_WAIT_MS` (an omp the person runs in a terminal can hold it for good) or when it cannot tell.
 */
export const SESSION_FREE_WAIT_MS = 15_000;
const POLL_MS = 250;

export interface SessionFreeDeps {
	owned: (sessionPath: string) => Promise<boolean>;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

/** Resolves once no other live omp owns `sessionPath`, or the wait is over; says which. */
export async function whenSessionFree(sessionPath: string, deps: SessionFreeDeps): Promise<"free" | "timeout"> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const deadline = now() + SESSION_FREE_WAIT_MS;
	for (;;) {
		const owned = await deps.owned(sessionPath).catch(() => false);
		if (!owned) return "free";
		if (now() >= deadline) return "timeout";
		await sleep(POLL_MS);
	}
}
