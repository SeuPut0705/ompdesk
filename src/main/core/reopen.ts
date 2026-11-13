/**
 * What main keeps in the core (a devices instance, a client's loop) is gone when the core ends: the numbers it held
 * belong to that core alone. Each owner opens its own again in the next one, through this.
 */
const FIRST_REST_MS = 1_000;
const LAST_REST_MS = 30_000;

/**
 * Runs `open` until it succeeds, resting after each failure (1 s, doubling to 30 s): the next core may not start at
 * once (one that failed to start rests 30 s, `core/process.ts`). Resolves `undefined` once `wanted()` is false: its
 * owner was disposed, or closed, or a later attempt took over. What `open` answered is returned even then, for the
 * owner to give back.
 */
export async function openAgain<T>(open: () => Promise<T>, wanted: () => boolean): Promise<T | undefined> {
	for (let rest = FIRST_REST_MS; wanted(); rest = Math.min(rest * 2, LAST_REST_MS)) {
		try {
			return await open();
		} catch {
			const rested = Promise.withResolvers<void>();
			setTimeout(rested.resolve, rest).unref();
			await rested.promise;
		}
	}
	return undefined;
}
