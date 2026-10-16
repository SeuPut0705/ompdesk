/**
 * Who sizes a PTY when more than one window shows it (the desktop and a phone, design S11).
 *
 * A PTY has one size, so only one viewer may resize it; the others draw the PTY at its own columns × rows
 * (scaled to fit their width) and must not fit it to their own box. That viewer holds the lease:
 *
 *   - A viewer that is the only one looking holds it implicitly; a desktop with nobody else watching resizes
 *     exactly as before.
 *   - The first `resize` while nobody holds it takes it (`free`), and so does the explicit `claim` ("Use this
 *     screen's size") at any time.
 *   - Typing takes it only when the holder has not typed for `HOLDER_IDLE_MS`: whoever is plainly using the
 *     terminal moves the size to their screen, but two people typing in turn never fight over it.
 *   - A holder that stops asking (its panel closed, its phone asleep) for `PRESENCE_MS` has let go.
 *
 * Viewers are the routing ids of the windows (an Electron window's webContents id, a web device's negative
 * window id); a terminal is named by its owner key and session id.
 */
import type { TerminalLeaseState } from "../../shared/terminal-types";

/** A viewer that has not asked about a terminal for this long is no longer looking at it. */
export const PRESENCE_MS = 10_000;
/** A holder that has not typed for this long gives way to whoever types next. */
export const HOLDER_IDLE_MS = 15_000;

interface Standing {
	/** Viewer id → when it last asked about this terminal. */
	seen: Map<number, number>;
	holder: number | null;
	/** When the holder last typed (or took the lease). */
	active: number;
}

export interface TerminalLeaseOptions {
	now?: () => number;
}

export class TerminalLease {
	readonly #standings = new Map<string, Standing>();
	readonly #now: () => number;

	constructor(options: TerminalLeaseOptions = {}) {
		this.#now = options.now ?? Date.now;
	}

	#standing(terminal: string): Standing {
		let standing = this.#standings.get(terminal);
		if (!standing) {
			standing = { seen: new Map(), holder: null, active: 0 };
			this.#standings.set(terminal, standing);
		}
		return standing;
	}

	#present(standing: Standing, viewer: number): boolean {
		const seen = standing.seen.get(viewer);
		return seen !== undefined && this.#now() - seen < PRESENCE_MS;
	}

	/** Who holds it now, null when nobody (never taken, or the holder left). */
	#holder(standing: Standing): number | null {
		if (standing.holder === null) return null;
		if (!this.#present(standing, standing.holder)) {
			standing.holder = null;
			return null;
		}
		return standing.holder;
	}

	/** `viewer` is looking at `terminal`; its standing back. */
	seen(terminal: string, viewer: number): TerminalLeaseState {
		const standing = this.#standing(terminal);
		standing.seen.set(viewer, this.#now());
		for (const [other, at] of standing.seen) if (this.#now() - at >= PRESENCE_MS) standing.seen.delete(other);
		return this.state(terminal, viewer);
	}

	/** `viewer`'s standing: `you` holds it (or is the only viewer), `other` has it taken, `free` nobody holds it. */
	state(terminal: string, viewer: number): TerminalLeaseState {
		const standing = this.#standings.get(terminal);
		if (!standing) return "free";
		const holder = this.#holder(standing);
		if (holder === viewer) return "you";
		if (holder !== null) return "other";
		return "free";
	}

	/** Whether `viewer` may resize now; a free lease is taken by the resize. */
	mayResize(terminal: string, viewer: number): boolean {
		const standing = this.#standing(terminal);
		standing.seen.set(viewer, this.#now());
		const holder = this.#holder(standing);
		if (holder === viewer) return true;
		if (holder !== null) return false;
		standing.holder = viewer;
		standing.active = this.#now();
		return true;
	}

	/** The explicit "use my size": always taken. */
	claim(terminal: string, viewer: number): void {
		const standing = this.#standing(terminal);
		standing.seen.set(viewer, this.#now());
		standing.holder = viewer;
		standing.active = this.#now();
	}

	/** `viewer` typed into the terminal: the holder's idle clock restarts, or the lease moves to a typist after a pause. */
	typed(terminal: string, viewer: number): void {
		const standing = this.#standing(terminal);
		standing.seen.set(viewer, this.#now());
		const holder = this.#holder(standing);
		if (holder === viewer) {
			standing.active = this.#now();
		} else if (holder === null || this.#now() - standing.active >= HOLDER_IDLE_MS) {
			standing.holder = viewer;
			standing.active = this.#now();
		}
	}

	/** The terminal closed or its tab was released. */
	forget(terminal: string): void {
		this.#standings.delete(terminal);
	}

	/** Every terminal whose key starts with `prefix` (a tab's owner key). */
	forgetOwner(prefix: string): void {
		for (const terminal of [...this.#standings.keys()])
			if (terminal.startsWith(prefix)) this.#standings.delete(terminal);
	}
}
