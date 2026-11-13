/**
 * Which files the app could not save because the disk is full, kept apart from the writers that retry them
 * (`atomic-file.ts`) and from the notice the person sees (`disk-full-notice.ts`). Electron-free.
 *
 * A writer `report`s a file the moment its write fails for lack of space and `clear`s it when a write of that file
 * goes through (or is called off). Listeners hear the set of names that changed, once per tick: a writer that is
 * replaced by a newer one clears and reports within one tick, which reads as no change at all.
 */
import { basename } from "node:path";

/** No space left on the device, or the person's quota on it is used up. */
export function isDiskFull(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
	return code === "ENOSPC" || code === "EDQUOT";
}

export type DiskFullListener = (names: readonly string[]) => void;

export class DiskFullWatch {
	/** File path to the name the person reads. */
	readonly #full = new Map<string, string>();
	readonly #listeners = new Set<DiskFullListener>();
	#told = "[]";
	#scheduled = false;

	report(file: string): void {
		if (this.#full.has(file)) return;
		this.#full.set(file, basename(file));
		this.#schedule();
	}

	clear(file: string): void {
		if (this.#full.delete(file)) this.#schedule();
	}

	/** The names of the files waiting for space, in the order they failed. */
	names(): string[] {
		return [...this.#full.values()];
	}

	/** Hears every change of `names()`; one that is not empty now is delivered at once. Returns the unsubscribe. */
	onChange(listener: DiskFullListener): () => void {
		this.#listeners.add(listener);
		const names = this.names();
		if (names.length > 0) this.#deliver(listener, names);
		return () => this.#listeners.delete(listener);
	}

	#schedule(): void {
		if (this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			const names = this.names();
			const key = JSON.stringify(names);
			if (key === this.#told) return;
			this.#told = key;
			for (const listener of [...this.#listeners]) this.#deliver(listener, names);
		});
	}

	/** A listener that throws must not reach the event loop: nobody is waiting on this write. */
	#deliver(listener: DiskFullListener, names: readonly string[]): void {
		try {
			listener(names);
		} catch (error) {
			console.warn(`[disk-full] a listener failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

/** The one watch of the app: every writer of `atomic-file.ts` reports to it. */
export const diskFull = new DiskFullWatch();
