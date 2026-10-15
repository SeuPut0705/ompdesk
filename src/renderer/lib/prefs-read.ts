/**
 * Reading a pref the app later writes back whole (sidebar blob, keymap table,
 * starter guide, quota bookings, model pools). A failed `prefs.get` is not an
 * empty pref: a store that took it for one would persist its defaults over
 * the data it never saw. Stores therefore stay un-hydrated on a failed read,
 * refuse or queue writes until one succeeds, and retry here.
 */

/** Pauses between the boot attempts at one pref: four reads over about 7.5 s, then the store waits for its next write to try once more. */
export const PREFS_BOOT_RETRY_MS: readonly number[] = [500, 2_000, 5_000];

export type PrefRead = { ok: true; value: unknown } | { ok: false };

/**
 * One `prefs.get`, retried after each of `retryDelaysMs` while it fails.
 * `ok: false` means the stored value is unknown, not that it is empty. A
 * missing bridge (`window.omp.prefs` absent) counts as a failed read.
 */
export async function readPref(key: string, retryDelaysMs: readonly number[] = []): Promise<PrefRead> {
	for (let attempt = 0; ; attempt++) {
		try {
			return { ok: true, value: await window.omp.prefs.get(key) };
		} catch {
			const delay = retryDelaysMs[attempt];
			if (delay === undefined) return { ok: false };
			await new Promise<void>(resolve => setTimeout(resolve, delay));
		}
	}
}
