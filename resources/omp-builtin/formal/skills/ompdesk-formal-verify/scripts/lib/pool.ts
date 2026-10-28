import os from "node:os";

/**
 * How many independent checks run at once: `OMPDESK_FORMAL_JOBS` when it is a positive integer, else half the cores
 * (each TLC run is single-worker, and the machine keeps room for the person using it), at least 1.
 */
export function defaultJobs(env: NodeJS.ProcessEnv = process.env, cores: number = os.availableParallelism()): number {
	const given = Number(env.OMPDESK_FORMAL_JOBS);
	if (Number.isInteger(given) && given > 0) return given;
	return Math.max(1, Math.floor(cores / 2));
}

/**
 * Starts `work` for every item, at most `limit` at a time, in item order. The promises come back in item order too,
 * so a caller that awaits them one after the other reports in a fixed order however the runs finish.
 */
export function poolPromises<T, R>(
	items: T[],
	limit: number,
	work: (item: T, index: number) => Promise<R>,
): Promise<R>[] {
	let next = 0;
	let active = 0;
	const gates = items.map(() => Promise.withResolvers<R>());
	const pump = (): void => {
		while (active < limit && next < items.length) {
			const index = next++;
			active++;
			work(items[index] as T, index).then(
				value => {
					active--;
					gates[index]?.resolve(value);
					pump();
				},
				error => {
					active--;
					gates[index]?.reject(error);
					pump();
				},
			);
		}
	};
	// A rejection nobody has awaited yet must not crash the process; the caller still sees it when it awaits.
	for (const gate of gates) gate.promise.catch(() => {});
	pump();
	return gates.map(gate => gate.promise);
}
