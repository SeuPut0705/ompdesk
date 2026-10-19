/**
 * The file every omp OMPdesk spawns reads memory's address from (the bridge's memory recall, env `OMP_GUI_MEMORY` =
 * this file's path; contract in resources/gui-bridge/modes/memory-recall-contracts.ts). Main rewrites it whenever
 * memory's state moves: `{url, dataDir}` while memory is on and its data dir is known, no file once it is off. A file
 * rather than spawn-time values because a tab's omp starts before memory's setup pass has found the data dir, and the
 * Settings switch may change while it runs.
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MemoryEnv } from "../../../resources/gui-bridge/modes/memory-recall-contracts";

export class RecallStateFile {
	readonly path: string;
	/** The JSON last written ("" after a removal), so an unchanged state writes nothing. */
	#written: string | undefined;
	/** One write at a time, in order: the last state wins. */
	#queue: Promise<void> = Promise.resolve();

	constructor(path: string) {
		this.path = path;
	}

	/**
	 * `env` known: write it. `env` null while memory is off: remove the file. `env` null while memory is on (its data dir
	 * not found yet this launch): keep what an earlier launch wrote, the server it names is a per-user service that is
	 * most likely still there.
	 */
	update(env: MemoryEnv | null, enabled: boolean): Promise<void> {
		const next = env ? JSON.stringify(env) : enabled ? undefined : "";
		if (next === undefined || next === this.#written) return this.#queue;
		this.#written = next;
		this.#queue = this.#queue
			.then(async () => {
				if (!next) return rm(this.path, { force: true });
				await mkdir(dirname(this.path), { recursive: true });
				const temp = `${this.path}.${process.pid}.tmp`;
				await writeFile(temp, next, { mode: 0o600 });
				await rename(temp, this.path);
			})
			.catch(() => {
				this.#written = undefined;
			});
		return this.#queue;
	}
}
