import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Removes a test's `folder`, waiting out EBUSY and EPERM: a process gone from the process table can hold its working
 * folder and the files it opened a moment longer on Windows, refused as EBUSY (v0.89.0's release run, 161 ms into the
 * test) or EPERM (a Windows 11 PC, 3 Nov 2026: refused at 104 ms, removed at 318 ms; a stock omp's agent dir after its
 * `exit`, the same day). `rmSync`'s own `maxRetries` did not retry there (that release run asked 20), so this retries
 * itself, every 200 ms for at most 8 s; the holder is not identified. Call it only once the processes that used the
 * folder have exited: it waits out the release, not a live holder.
 */
export async function removeWhenFree(folder: string): Promise<void> {
	const deadline = Date.now() + 8_000;
	for (;;) {
		try {
			rmSync(folder, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if ((code !== "EBUSY" && code !== "EPERM") || Date.now() > deadline) throw error;
			await sleep(200);
		}
	}
}
