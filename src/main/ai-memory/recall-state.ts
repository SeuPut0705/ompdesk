/**
 * The file every omp OMPdesk spawns reads memory's address from (the bridge's memory recall, env `OMP_GUI_MEMORY` =
 * this file's path; contract in resources/gui-bridge/modes/memory-recall-contracts.ts). Main rewrites it whenever
 * memory's state moves: `{url, dataDir}` once the data dir is known. A file rather than spawn-time values because a
 * tab's omp starts before memory's setup pass has found the data dir.
 */

import type { MemoryEnv } from "../../../resources/gui-bridge/modes/memory-recall-contracts";
import { writeFileAtomic } from "../atomic-file";

export class RecallStateFile {
	readonly path: string;
	/** The JSON last written, so an unchanged state writes nothing. */
	#written: string | undefined;
	/** One write at a time, in order: the last state wins. */
	#queue: Promise<void> = Promise.resolve();

	constructor(path: string) {
		this.path = path;
	}

	/**
	 * `env` known: write it. `env` null (the data dir not found yet this launch): keep what an earlier launch wrote, the
	 * server it names is a per-user service that is most likely still there.
	 */
	update(env: MemoryEnv | null): Promise<void> {
		const next = env ? JSON.stringify(env) : undefined;
		if (next === undefined || next === this.#written) return this.#queue;
		this.#written = next;
		this.#queue = this.#queue
			.then(() => writeFileAtomic(this.path, next, { mode: 0o600 }))
			.catch(() => {
				this.#written = undefined;
			});
		return this.#queue;
	}
}
