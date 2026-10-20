/**
 * The term corpus of memory recall's coverage gate (resources/gui-bridge/modes/memory-recall-core.ts `codeRuleSelect`):
 * how many conclusions hold each content term, kept in `<userData>/ai-memory/recall-terms.json` for the bridge. Both
 * conclusion streams are read after saved cursors (same reset rule as sync.ts `readConclusions`: another store, or a
 * cursor past the stream's end, rebuilds from zero). Deletions are not subtracted, so the document frequencies go
 * slightly stale until the store changes (then the rebuild corrects them).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { addConclusionTerms, type RecallTermStats } from "../../../resources/gui-bridge/modes/memory-recall-core";
import { type MemoryStore, readConclusions } from "./sync";

const PAGE = 200;

interface TermsFile extends RecallTermStats {
	v: 1;
	store: string;
	native: number;
	synced: number;
}

function empty(): TermsFile {
	return { v: 1, store: "", native: 0, synced: 0, n: 0, df: {} };
}

function parse(raw: string): TermsFile | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (value === null || typeof value !== "object" || Reflect.get(value, "v") !== 1) return undefined;
		const { store, native, synced, n, df } = value as Record<string, unknown>;
		if (typeof store !== "string" || typeof native !== "number" || typeof synced !== "number") return undefined;
		if (typeof n !== "number" || df === null || typeof df !== "object") return undefined;
		return { v: 1, store, native, synced, n, df: { ...(df as Record<string, number>) } };
	} catch {
		return undefined;
	}
}

export class RecallTermsIndex {
	readonly #store: Pick<MemoryStore, "conclusions">;
	readonly #file: string;
	readonly #log: ((message: string, details?: object) => void) | undefined;
	#running: Promise<void> | undefined;

	constructor(deps: {
		store: Pick<MemoryStore, "conclusions">;
		file: string;
		log?: (message: string, details?: object) => void;
	}) {
		this.#store = deps.store;
		this.#file = deps.file;
		this.#log = deps.log;
	}

	/** Reads the rows after the saved cursors and writes the file when something changed. One at a time; never throws. */
	refresh(): Promise<void> {
		this.#running ??= this.#run().finally(() => {
			this.#running = undefined;
		});
		return this.#running;
	}

	async #run(): Promise<void> {
		try {
			const saved = parse(await readFile(this.#file, "utf8").catch(() => ""));
			let state = saved ?? empty();
			let changed = false;
			// A cursor that no longer holds (another store, or past the stream's end) rebuilds both streams from zero.
			const reads = async (): Promise<boolean> => {
				for (const source of ["native", "synced"] as const) {
					for (;;) {
						const { page, after } = await readConclusions(
							this.#store as MemoryStore,
							source,
							state[source],
							state.store,
							PAGE,
						);
						if (after !== state[source]) return false;
						if (state.store !== page.store) {
							state.store = page.store;
							changed = true;
						}
						for (const row of page.rows) addConclusionTerms(state, row.body);
						if (page.next !== state[source]) changed = true;
						state[source] = page.next;
						if (!page.more) break;
					}
				}
				return true;
			};
			if (!(await reads())) {
				state = empty();
				changed = true;
				await reads();
			}
			if (!changed && saved) return;
			await mkdir(dirname(this.#file), { recursive: true });
			const temp = `${this.#file}.${process.pid}.tmp`;
			await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
			await rename(temp, this.#file);
		} catch (failure) {
			this.#log?.("recall-terms-failed", { error: failure instanceof Error ? failure.message : String(failure) });
		}
	}
}
