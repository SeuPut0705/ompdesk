/**
 * What became of the sessions an id was handed out for: its tab closed (by whom, when), or it was deleted (by whom,
 * when). The one record every control tool resolves a gone tab's id from, across relaunches.
 *
 * Why (measured over an orchestrating session's journals, 3 to 10 Nov 2026: `No session "<id>"` 14 times on ids
 * `ompdesk_session_open` had returned): an id used to keep naming its session only when the control tools themselves
 * had closed the tab, and only until the next relaunch (the automatic close alone was kept longer). A tab the person
 * closed, a window that went away, a close before an update's relaunch, and every deleted session (a throwaway's, the
 * sidebar's) answered the same "No session", so the agent could not tell a typo from a session that was gone for good.
 *
 * A session has one entry, by the computer it is saved on and its file (an entry with no file, a tab deleted before
 * stock wrote one, is kept by its ids alone). Closing it again, or deleting it, replaces the entry and keeps every id
 * it ever had. Kept in `<userData>/agent-session-fates.json` (written atomically), newest `SESSION_FATES_MAX`.
 */
import { readFileSync } from "node:fs";
import { writeFileAtomicDeferred } from "../atomic-file";

export const SESSION_FATES_MAX = 1000;
/** Ids one session keeps: its saved id, and a tab id per reopen or relaunch. */
const FATE_IDS_MAX = 24;

/** A session an id named, as it was when it went. */
export interface FatedSession {
	/** Every id that named it: its tab id, the ids that tab had before relaunches, its saved (stock) id. */
	ids: string[];
	/** Its session file on the computer it is saved on; absent when stock had written none. */
	path?: string;
	/** The paired host it is saved on; absent = this computer. */
	device?: string;
	/** "" for a session hidden from agents: its title is private. */
	title: string;
	/** The person had hidden it from agents when it went (this computer's sessions): its id still refuses. */
	hidden?: true;
	cwd: string;
	/** The session file of the session that opened it, when known: its opener deletes it with no card after a relaunch too. */
	openedBySession?: string;
}

export interface SessionFate extends FatedSession {
	state: "closed" | "deleted";
	/** Epoch ms; 0 when the record predates this file (an id from the older deleted-ids list). */
	at: number;
	/** Who closed or deleted it, in words an agent reads; "" when unknown. */
	by: string;
}

function parseFate(value: unknown): SessionFate | null {
	if (typeof value !== "object" || value === null) return null;
	const { ids, path, device, title, hidden, cwd, openedBySession, state, at, by } = value as Record<string, unknown>;
	const named = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
	if (named.length === 0 || (state !== "closed" && state !== "deleted")) return null;
	return {
		ids: named.slice(0, FATE_IDS_MAX),
		...(typeof path === "string" && path ? { path } : {}),
		...(typeof device === "string" && device ? { device } : {}),
		title: typeof title === "string" ? title : "",
		...(hidden === true ? { hidden: true as const } : {}),
		cwd: typeof cwd === "string" ? cwd : "",
		...(typeof openedBySession === "string" && openedBySession ? { openedBySession } : {}),
		state,
		at: typeof at === "number" ? at : 0,
		by: typeof by === "string" ? by : "",
	};
}

export class SessionFates {
	readonly #file: string | null;
	readonly #now: () => number;
	/** Oldest first. */
	#fates: SessionFate[] = [];
	#callOff: (() => void) | undefined;

	constructor(file: string | null, now: () => number = Date.now) {
		this.#file = file;
		this.#now = now;
		if (!file) return;
		try {
			const value: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (Array.isArray(value)) this.#fates = value.flatMap(item => parseFate(item) ?? []);
		} catch {
			// No record yet, or a damaged one: this launch knows of no session that went.
		}
	}

	/** The newest entry `id` names (a tab id is random and a saved id unique, so an id names one session). */
	find(id: string): SessionFate | undefined {
		return this.#fates.findLast(fate => fate.ids.includes(id));
	}

	/** The entry of the session saved at `path` on `device`. */
	of(path: string, device: string | undefined): SessionFate | undefined {
		return this.#fates.findLast(fate => fate.path === path && fate.device === device);
	}

	/** Its tab closed and the session stays saved. A deleted session stays deleted: a late close never revives it. */
	closed(session: FatedSession, by: string): void {
		this.#put(session, "closed", by, this.#now());
	}

	/** It was deleted; `at` when the delete is older than this call (a tombstone's time). */
	deleted(session: FatedSession, by: string, at = this.#now()): void {
		this.#put(session, "deleted", by, at);
	}

	#put(session: FatedSession, state: SessionFate["state"], by: string, at: number): void {
		const same = (fate: SessionFate): boolean =>
			session.path !== undefined
				? fate.path === session.path && fate.device === session.device
				: fate.path === undefined && fate.ids.some(id => session.ids.includes(id));
		const before = this.#fates.filter(same);
		if (state === "closed" && before.some(fate => fate.state === "deleted")) return;
		const earlier = before.at(-1);
		const ids = [...new Set([...session.ids, ...before.flatMap(fate => fate.ids)])].slice(0, FATE_IDS_MAX);
		const openedBySession = session.openedBySession ?? earlier?.openedBySession;
		this.#fates = [
			...this.#fates.filter(fate => !same(fate)),
			{
				...session,
				ids,
				// A delete that knows less than the close before it (a saved id alone) keeps what the close recorded.
				title: session.title || earlier?.title || "",
				cwd: session.cwd || earlier?.cwd || "",
				...(openedBySession ? { openedBySession } : {}),
				state,
				at,
				by,
			},
		].slice(-SESSION_FATES_MAX);
		if (!this.#file) return;
		this.#callOff?.();
		this.#callOff = writeFileAtomicDeferred(this.#file, JSON.stringify(this.#fates), { mode: 0o600 }, error =>
			console.warn(`[session-fates] not saved: ${error}`),
		);
	}
}

/** "on 2026-11-10 04:12 UTC by <who>", each part only when known. */
export function fateWhen(fate: Pick<SessionFate, "at" | "by">): string {
	const when = fate.at > 0 ? ` on ${new Date(fate.at).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
	return `${when}${fate.by ? ` by ${fate.by}` : ""}`;
}

/** Who a fate names when no session's own call closed or deleted it. */
export const FATE_BY = {
	/** A tab nobody closed through the control tools. */
	person: "the user or its window (its tab was closed in OMPdesk)",
	/** The control tools' own close of a finished child. */
	autoClose: "OMPdesk (its result had reached the session that opened it)",
	/** The control tools' own delete of a throwaway session. */
	throwaway: "OMPdesk (it was opened as throwaway, and its Result: ok answer had reached the session that opened it)",
	/** A delete the control tools did not make: only its tombstone tells of it. */
	app: "someone in OMPdesk (the sidebar's Delete, /delete or a paired device)",
} as const;
