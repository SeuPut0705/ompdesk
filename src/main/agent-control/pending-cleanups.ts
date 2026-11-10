/**
 * Cleanups a control tool refused: a stop, close or delete of a session the person typed into, or of one the caller did
 * not open that the person looks at (tab-close.ts `needsPersonTurn`), asked in a turn their own message did not start
 * (service.ts `inUseRefusal`; that rule stands). A session the caller opened that the person only looks at is never
 * refused, so it never lands here. The refusal is kept here per caller, and the caller is told its list once, at the
 * start of its next turn the person's own message starts, when the same call is allowed.
 *
 * Kept in `<userData>/agent-pending-cleanups.json` (written atomically), newest `PENDING_CLEANUPS_MAX`.
 */
import { readFileSync } from "node:fs";
import { writeFileAtomicDeferred } from "../atomic-file";

export const PENDING_CLEANUPS_MAX = 200;

export type CleanupAction = "stop" | "close" | "delete";

export interface PendingCleanup {
	/** Who asked: the caller's session file (with its computer), else its tab id. */
	caller: string;
	/** The session it asked for: its file on the computer it runs on when it has one, and the tab id it was named by. */
	path?: string;
	device?: string;
	tabId: string;
	/** "" for a session hidden from agents. */
	title: string;
	action: CleanupAction;
	at: number;
}

function parseCleanup(value: unknown): PendingCleanup | null {
	if (typeof value !== "object" || value === null) return null;
	const { caller, path, device, tabId, title, action, at } = value as Record<string, unknown>;
	if (typeof caller !== "string" || !caller || typeof tabId !== "string" || !tabId) return null;
	if (action !== "stop" && action !== "close" && action !== "delete") return null;
	return {
		caller,
		...(typeof path === "string" && path ? { path } : {}),
		...(typeof device === "string" && device ? { device } : {}),
		tabId,
		title: typeof title === "string" ? title : "",
		action,
		at: typeof at === "number" ? at : 0,
	};
}

const sameSession = (a: PendingCleanup, b: PendingCleanup): boolean =>
	a.path !== undefined || b.path !== undefined ? a.path === b.path && a.device === b.device : a.tabId === b.tabId;

export class PendingCleanups {
	readonly #file: string | null;
	/** Oldest first. */
	#entries: PendingCleanup[] = [];
	#callOff: (() => void) | undefined;

	constructor(file: string | null) {
		this.#file = file;
		if (!file) return;
		try {
			const value: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (Array.isArray(value)) this.#entries = value.flatMap(item => parseCleanup(item) ?? []);
		} catch {
			// No record yet, or a damaged one: nothing waits as far as this launch knows.
		}
	}

	/** Keep a refused cleanup; the same caller asking for the same session again replaces its entry (the newest ask counts). */
	add(cleanup: PendingCleanup): void {
		this.#entries = [
			...this.#entries.filter(entry => entry.caller !== cleanup.caller || !sameSession(entry, cleanup)),
			cleanup,
		].slice(-PENDING_CLEANUPS_MAX);
		this.#save();
	}

	/** `cleanup` was carried out: its caller's entry for that session goes. */
	drop(cleanup: PendingCleanup): void {
		const kept = this.#entries.filter(entry => entry.caller !== cleanup.caller || !sameSession(entry, cleanup));
		if (kept.length === this.#entries.length) return;
		this.#entries = kept;
		this.#save();
	}

	/** What waits for `caller`, removed: it is told once. */
	take(caller: string): PendingCleanup[] {
		const taken = this.#entries.filter(entry => entry.caller === caller);
		if (taken.length === 0) return taken;
		this.#entries = this.#entries.filter(entry => entry.caller !== caller);
		this.#save();
		return taken;
	}

	#save(): void {
		if (!this.#file) return;
		this.#callOff?.();
		this.#callOff = writeFileAtomicDeferred(this.#file, JSON.stringify(this.#entries), { mode: 0o600 }, error =>
			console.warn(`[pending-cleanups] not saved: ${error}`),
		);
	}
}
