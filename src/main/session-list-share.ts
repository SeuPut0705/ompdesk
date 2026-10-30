/**
 * One computer's session list, read once per change and shared by everyone who shows it (`shared/session-list-delta.ts`).
 * Every desktop window, phone page and paired computer showed the sidebar by asking for the whole list after each
 * change: with two windows and two paired computers one settled append cost four stock scans of every journal and
 * four whole lists (128 KB of JSON on this Mac, 30 Oct 2026). Here a change reads the list once, numbers it, and hands
 * on what changed (`onChange`); an ask is answered from the copy, or waits with every other ask for the one read that
 * is under way. Never a queue: concurrent askers get the same answer when it lands.
 */
import { randomUUID } from "node:crypto";
import type { SessionInfo } from "../shared/ipc-types";
import { diffSessionList, type SessionListDelta, type VersionedSessionList } from "../shared/session-list-delta";

export class SessionListShare {
	readonly #read: () => Promise<SessionInfo[]>;
	readonly #epoch = randomUUID().slice(0, 8);
	#next = 0;
	#copy: VersionedSessionList | null = null;
	/** Bumped by every change; the copy is current while it was read at the latest generation. */
	#generation = 0;
	#copyGeneration = -1;
	#reading: Promise<void> | null = null;

	/**
	 * The list changed: `delta` is what turns the last version into this one. Null when there was no copy to compare
	 * with (nobody read it yet, or the last read failed): whoever shows the list asks for it.
	 */
	onChange: ((delta: SessionListDelta | null) => void) | null = null;

	/** `read` gives the whole list in `compareSessionRows` order. */
	constructor(read: () => Promise<SessionInfo[]>) {
		this.#read = read;
	}

	/** The list as of now: the copy while nothing changed since it was read, else the read every asker shares. */
	async current(): Promise<VersionedSessionList> {
		const wanted = this.#generation;
		while (this.#copy === null || this.#copyGeneration < wanted) {
			this.#reading ??= this.#readOnce().finally(() => {
				this.#reading = null;
			});
			await this.#reading;
		}
		return this.#copy;
	}

	/** The next ask reads again (it no longer takes the copy); nothing is read until someone asks. */
	stale(): void {
		this.#generation++;
	}

	/** Something listed may have changed: read now and hand on what changed, or say so when there is no copy to compare. */
	changed(): void {
		this.stale();
		if (this.#copy === null) {
			this.onChange?.(null);
			return;
		}
		this.current().catch(() => {
			// The next ask reads again; whoever holds the last version gets the change then.
		});
	}

	/** A list someone else read (a host's change applied here): becomes the current copy, handed on like a read. */
	set(rows: SessionInfo[]): void {
		this.#publish(rows, this.#generation);
	}

	/** The copy, current or not; null before the first read. */
	held(): VersionedSessionList | null {
		return this.#copy;
	}

	async #readOnce(): Promise<void> {
		const generation = this.#generation;
		this.#publish(await this.#read(), generation);
	}

	#publish(rows: SessionInfo[], generation: number): void {
		const before = this.#copy;
		this.#copyGeneration = Math.max(this.#copyGeneration, generation);
		const delta = before ? diffSessionList(before.sessions, rows) : null;
		if (before && !delta) return;
		const version = `${this.#epoch}.${++this.#next}`;
		this.#copy = { version, sessions: rows };
		if (before && delta) this.onChange?.({ base: before.version, version, ...delta });
	}
}
