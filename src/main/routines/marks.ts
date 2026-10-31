/**
 * Where each routine's trigger stood, kept across a relaunch (`<userData>/routine-marks.json`): a git trigger's commit,
 * a GitHub trigger's seen ids and default-branch head, an email trigger's mailbox cursor, a files trigger's listing.
 * A source started with its mark reads what changed since it, so what happened while OMPdesk was closed fires once
 * on start; a source without one takes its baseline as before.
 *
 * A mark belongs to one trigger as it was set (`key`: the routine's event and session): an edited trigger, one turned
 * off, a deleted routine and everything while all schedules are paused lose theirs (`RoutineTriggers` calls `drop`),
 * so what happened meanwhile never fires later, as before. Quitting keeps them. Each source parses its own mark
 * (it is JSON from disk); one it cannot read counts as none.
 */
import { readFileSync } from "node:fs";
import { writeFileAtomic, writeFileAtomicSync } from "../atomic-file";

export interface TriggerMarks {
	/** The mark saved for this routine's trigger as set now; undefined when none (or it was for another setting). */
	get(id: string, key: string): unknown;
	set(id: string, key: string, mark: unknown): void;
	/** Forgets the marks of these routines. */
	drop(ids: Iterable<string>): void;
	/** The routines with a mark. */
	ids(): string[];
}

interface Entry {
	key: string;
	mark: unknown;
}

/** Marks in memory only: a test's, or a launch that keeps none. */
export class MemoryMarks implements TriggerMarks {
	protected readonly entries = new Map<string, Entry>();

	get(id: string, key: string): unknown {
		const entry = this.entries.get(id);
		return entry?.key === key ? entry.mark : undefined;
	}

	set(id: string, key: string, mark: unknown): void {
		const entry = this.entries.get(id);
		if (entry?.key === key && JSON.stringify(entry.mark) === JSON.stringify(mark)) return;
		this.entries.set(id, { key, mark });
		this.changed();
	}

	drop(ids: Iterable<string>): void {
		let any = false;
		for (const id of ids) any = this.entries.delete(id) || any;
		if (any) this.changed();
	}

	ids(): string[] {
		return [...this.entries.keys()];
	}

	protected changed(): void {}
}

/** Marks in a file, written after each change (one write at a time, the newest state) and once more at `dispose`. */
export class FileMarks extends MemoryMarks {
	readonly #file: string;
	#writes: Promise<void> = Promise.resolve();
	#dirty = false;
	/** Changed since it was read: `dispose` writes it (a write in flight then is dropped by `commitIf`). */
	#touched = false;
	#disposed = false;

	constructor(file: string) {
		super();
		this.#file = file;
		try {
			const stored = JSON.parse(readFileSync(file, "utf8")) as { marks?: Record<string, Entry> } | null;
			for (const [id, entry] of Object.entries(stored?.marks ?? {}))
				if (typeof entry?.key === "string") this.entries.set(id, { key: entry.key, mark: entry.mark });
		} catch {
			// No file yet, or one that does not parse: every trigger takes its baseline again.
		}
	}

	/** Writes the newest state now (the app is quitting); later changes are not written. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (!this.#touched) return;
		try {
			writeFileAtomicSync(this.#file, this.#text(), { mode: 0o600 });
		} catch (error) {
			console.error("[routines] couldn't save the triggers' marks:", error);
		}
	}

	protected override changed(): void {
		if (this.#disposed) return;
		this.#dirty = true;
		this.#touched = true;
		this.#writes = this.#writes
			.then(() => {
				if (this.#disposed || !this.#dirty) return;
				this.#dirty = false;
				return writeFileAtomic(this.#file, this.#text(), { mode: 0o600, commitIf: () => !this.#disposed });
			})
			.catch(error => console.error("[routines] couldn't save the triggers' marks:", error));
	}

	#text(): string {
		return JSON.stringify({ version: 1, marks: Object.fromEntries(this.entries) });
	}
}
