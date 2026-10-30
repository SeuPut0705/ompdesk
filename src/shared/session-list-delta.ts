/**
 * A computer's session list kept as one shared copy and sent on as what changed (main's `SessionListShare`): each
 * window, each paired computer and each of its windows holds the version it last got, applies the next change on it,
 * and asks for the whole list only when it holds no copy or missed a change. Used by main (both computers) and the
 * renderer's session-list feed, so the order and the rule for "the same row" are this one copy.
 */
import type { SessionInfo } from "./ipc-types";

/** The whole list at one version (`epoch.n`: a new epoch each run, so a copy from another run never matches). */
export interface VersionedSessionList {
	version: string;
	sessions: SessionInfo[];
}

/** What changed from `base` to `version`: rows that are new or differ, and the paths no longer listed. */
export interface SessionListDelta {
	base: string;
	version: string;
	set: SessionInfo[];
	remove: string[];
}

/** Whether version `a` comes before `b` of the same run (`epoch.n`); versions of two runs are never compared. */
export function olderSessionListVersion(a: string, b: string): boolean {
	const [epochA, nA] = a.split(".");
	const [epochB, nB] = b.split(".");
	return epochA === epochB && Number(nA) < Number(nB);
}

/** The order of every session list: the newest `modified` first, then by path, so a receiver rebuilds the same order. */
export function compareSessionRows(a: SessionInfo, b: SessionInfo): number {
	const newer = (Date.parse(b.modified) || 0) - (Date.parse(a.modified) || 0);
	if (newer !== 0) return newer;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Every field equal (a row's fields are all strings, numbers, null or absent). */
export function sameSessionRow(a: SessionInfo, b: SessionInfo): boolean {
	const keys = Object.keys(a) as Array<keyof SessionInfo>;
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every(key => a[key] === b[key]);
}

/** What turns `before` into `after` (both in {@link compareSessionRows} order); null when they list the same rows. */
export function diffSessionList(
	before: readonly SessionInfo[],
	after: readonly SessionInfo[],
): Pick<SessionListDelta, "set" | "remove"> | null {
	const old = new Map(before.map(row => [row.path, row]));
	const set: SessionInfo[] = [];
	for (const row of after) {
		const prior = old.get(row.path);
		old.delete(row.path);
		if (!prior || !sameSessionRow(prior, row)) set.push(row);
	}
	const remove = [...old.keys()];
	return set.length === 0 && remove.length === 0 ? null : { set, remove };
}

/** `rows` with `delta` applied, in {@link compareSessionRows} order; unchanged rows keep their objects. */
export function applySessionListDelta(
	rows: readonly SessionInfo[],
	delta: Pick<SessionListDelta, "set" | "remove">,
): SessionInfo[] {
	const byPath = new Map(rows.map(row => [row.path, row]));
	for (const path of delta.remove) byPath.delete(path);
	for (const row of delta.set) byPath.set(row.path, row);
	return [...byPath.values()].sort(compareSessionRows);
}
