/**
 * Who used the memory, written down when this computer runs short (the owner's report, 12 Nov 2026: the Mac froze and
 * no log line said what had filled it). Pure: the memory watch (`memory-watch.ts`) hands it one listing of every
 * process with its tag (`procs.list`), the tags and their sessions (`session-processes.ts`) and the open tabs, and
 * writes the result as one `memory short` line of `gui-runtime.jsonl`.
 *
 * A process is a session's when it carries the session's tag, or (an omp started before tags existed, a child that
 * cleared its environment) when it runs under a tab's omp. What runs under OMPdesk's own main process is OMPdesk's.
 * A tag no open tab holds belongs to a session that is gone or to another OMPdesk. Everything else is not OMPdesk's.
 */
import type { TaggedProcess, TagOwner } from "./session-processes";

/** How many processes the record names. */
export const RECORD_TOP_PROCESSES = 8;
/** How many sessions the record sums up. */
export const RECORD_TOP_SESSIONS = 6;

/** A tab whose omp runs on this computer. */
export interface RecordTab {
	pid?: number;
	/** Its title (a hosted tab's names its device). */
	label: string;
}

/** Whose a process is, as the record says it. */
export type ProcessOwner =
	| { kind: "session"; title: string; folder?: string; device?: string }
	/** It carries a tag no open tab holds. */
	| { kind: "closed-session" }
	| { kind: "ompdesk" }
	| { kind: "other" };

export interface RecordProcess {
	name: string;
	pid: number;
	mb: number;
	/** Minutes since it started; absent when the OS did not say. */
	ageMin?: number;
	owner: "session" | "closed session" | "OMPdesk" | "not OMPdesk's";
	session?: string;
	folder?: string;
	device?: string;
}

export interface RecordSession {
	session: string;
	folder?: string;
	device?: string;
	mb: number;
	processes: number;
}

export interface MemoryRecord {
	/** The largest processes, largest first. */
	top: RecordProcess[];
	/** The sessions that hold the most, largest first. */
	sessions: RecordSession[];
	/** Everything sessions hold, what OMPdesk itself holds, and the rest, in MB. */
	sessionsMb: number;
	ompdeskMb: number;
	otherMb: number;
}

const mb = (bytes: number): number => Math.round(bytes / 1024 ** 2);

/** Whose each process of `rows` is. */
export function processOwners(
	rows: readonly TaggedProcess[],
	owners: readonly TagOwner[],
	tabs: readonly RecordTab[],
	mainPid: number,
): Map<number, ProcessOwner> {
	const byPid = new Map(rows.map(row => [row.pid, row]));
	const labelByPid = new Map(tabs.flatMap(tab => (tab.pid === undefined ? [] : [[tab.pid, tab.label] as const])));
	const byTag = new Map(owners.map(owner => [owner.tag, owner]));
	const sessionOf = (owner: TagOwner): ProcessOwner => ({
		kind: "session",
		title: (owner.pid !== undefined ? labelByPid.get(owner.pid) : undefined) ?? "(not running)",
		folder: owner.cwd,
		...(owner.device !== undefined ? { device: owner.device } : {}),
	});
	const result = new Map<number, ProcessOwner>();
	const resolve = (row: TaggedProcess): ProcessOwner => {
		const known = result.get(row.pid);
		if (known) return known;
		let owner: ProcessOwner | undefined;
		const tagged = row.tag === undefined ? undefined : byTag.get(row.tag);
		if (tagged) owner = sessionOf(tagged);
		else {
			// Up the parents: a tab's omp makes it that tab's, OMPdesk's main process makes it OMPdesk's. A parent that
			// started after its child is a reused pid, not the parent.
			const seen = new Set<number>();
			for (let at: TaggedProcess | undefined = row; at && !seen.has(at.pid); ) {
				seen.add(at.pid);
				const label = labelByPid.get(at.pid);
				if (label !== undefined) {
					owner = { kind: "session", title: label };
					break;
				}
				if (at.pid === mainPid) {
					owner = { kind: "ompdesk" };
					break;
				}
				const parent = byPid.get(at.ppid);
				if (!parent || parent.pid === at.pid) break;
				if (parent.startedMs !== undefined && at.startedMs !== undefined && parent.startedMs > at.startedMs) break;
				at = parent;
			}
			owner ??= row.tag === undefined ? { kind: "other" } : { kind: "closed-session" };
		}
		result.set(row.pid, owner);
		return owner;
	};
	for (const row of rows) resolve(row);
	return result;
}

const OWNER_WORDS = {
	session: "session",
	"closed-session": "closed session",
	ompdesk: "OMPdesk",
	other: "not OMPdesk's",
} as const;

/** The record of one listing. */
export function memoryRecord(
	rows: readonly TaggedProcess[],
	owners: readonly TagOwner[],
	tabs: readonly RecordTab[],
	mainPid: number,
	now: number,
): MemoryRecord {
	const whose = processOwners(rows, owners, tabs, mainPid);
	const sessions = new Map<string, RecordSession>();
	let sessionsBytes = 0;
	let ompdeskBytes = 0;
	let otherBytes = 0;
	for (const row of rows) {
		const owner = whose.get(row.pid) ?? { kind: "other" };
		if (owner.kind === "ompdesk") ompdeskBytes += row.bytes;
		else if (owner.kind === "other") otherBytes += row.bytes;
		else {
			sessionsBytes += row.bytes;
			const title = owner.kind === "session" ? owner.title : "(closed session)";
			const folder = owner.kind === "session" ? owner.folder : undefined;
			const device = owner.kind === "session" ? owner.device : undefined;
			const key = `${title}\u0000${folder ?? ""}\u0000${device ?? ""}`;
			const sum = sessions.get(key) ?? {
				session: title,
				...(folder !== undefined ? { folder } : {}),
				...(device !== undefined ? { device } : {}),
				mb: 0,
				processes: 0,
			};
			// Bytes are summed in `mb` until the list is cut, then rounded once.
			sum.mb += row.bytes;
			sum.processes += 1;
			sessions.set(key, sum);
		}
	}
	const top = [...rows]
		.sort((a, b) => b.bytes - a.bytes || a.pid - b.pid)
		.slice(0, RECORD_TOP_PROCESSES)
		.map((row): RecordProcess => {
			const owner = whose.get(row.pid) ?? { kind: "other" };
			return {
				name: row.name,
				pid: row.pid,
				mb: mb(row.bytes),
				...(row.startedMs !== undefined ? { ageMin: Math.max(0, Math.round((now - row.startedMs) / 60_000)) } : {}),
				owner: OWNER_WORDS[owner.kind],
				...(owner.kind === "session"
					? {
							session: owner.title,
							...(owner.folder !== undefined ? { folder: owner.folder } : {}),
							...(owner.device !== undefined ? { device: owner.device } : {}),
						}
					: {}),
			};
		});
	return {
		top,
		sessions: [...sessions.values()]
			.sort((a, b) => b.mb - a.mb || a.session.localeCompare(b.session))
			.slice(0, RECORD_TOP_SESSIONS)
			.map(sum => ({ ...sum, mb: mb(sum.mb) })),
		sessionsMb: mb(sessionsBytes),
		ompdeskMb: mb(ompdeskBytes),
		otherMb: mb(otherBytes),
	};
}

/** How often the record is written while memory stays short. */
export const RECORD_EVERY_MS = 5 * 60_000;

/** When the record is due: as memory turns short, then every `RECORD_EVERY_MS` while it stays short. */
export class RecordClock {
	#last: number | null = null;

	/** One sample: whether to write the record now. */
	due(now: number, short: boolean): boolean {
		if (!short) {
			this.#last = null;
			return false;
		}
		if (this.#last !== null && now - this.#last < RECORD_EVERY_MS) return false;
		this.#last = now;
		return true;
	}
}
