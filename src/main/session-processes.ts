/**
 * Whose process is it, and what a closed session leaves behind (the owner's report, 12 Nov 2026: finished work left dev
 * servers, browsers and an emulator running until a 16 GB Mac froze).
 *
 * Every tab's omp is spawned with a tag in its environment (`SESSION_TAG_ENV`, one random value per tab, kept for
 * every omp the tab starts). Whatever the omp starts inherits it, however deep, and keeps it after its parent is gone
 * (a daemon, a double fork, `nohup`, `&`), so the core process can read back, for any running process, which tab
 * started it (`procs.list`) and end exactly a tab's processes (`procs.end`: asked first, killed after a grace).
 *
 * A session's processes live as long as its tab:
 * - The tab closes (the person, an agent, a deleted session, a hosted tab whose grace ended, a closed window): once its
 *   omp has exited, every process that still carries its tag is ended.
 * - The app quits: nothing is ended. Tabs come back at the next launch, and a tab that comes back on its session takes
 *   its tag over, so a dev server its next turn needs is still there.
 * - The next launch (`sweep`) ends the processes of every tag the last one left whose session did not come back: no tab
 *   in the restored layout and no marker of interrupted work. This is also what cleans up after a crash or a forced
 *   quit, where no close ever ran.
 *
 * Never the wrong process: only tags this file wrote are ever ended (`<userData>/session-processes.json`), so a
 * process started outside OMPdesk, by another OMPdesk (another userData) or by a tab that is still open is not
 * touched. Stock omp's own shared workers (`STOCK_WORKER_ARG`: the project's service broker, whose services stop with
 * the project's last omp or stay while `launch.persist` is on, the LSP multiplexer, the blob broker) and what they
 * started are left to stock. A tag the app itself runs under (it was started from that session's shell) is refused by
 * the core.
 *
 * Not seen: a process that cleared its environment, one started through the system instead of as a child (macOS `open`,
 * a launchd job, a VM's XPC service), and on Windows a process this user may not read (elevated).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, normalize } from "node:path";
import { z } from "zod";
import { writeFileAtomicDeferred } from "./atomic-file";
import { core } from "./core/process";
import { SESSION_TAG_ENV } from "./omp-launch";
import type { SessionScratch } from "./session-scratch";

/** The file in userData that names every tab's tag. */
export const SESSION_PROCESSES_FILE = "session-processes.json";
/** Stock omp's worker selectors (`cli/worker-selectors.ts`): a process started with one is stock's own, never a session's leftover. */
export const STOCK_WORKER_ARG = "__omp_worker_";
/** How long a process asked to end gets before it is killed. */
export const END_GRACE_MS = 5_000;
/** The longest one `procs.end` may take in the core, and what main waits for it. */
const END_TIMEOUT_MS = 20_000;
const END_CALL_TIMEOUT_MS = END_TIMEOUT_MS + 5_000;
/** How long one process listing with its tags may take. */
export const LIST_TIMEOUT_MS = 10_000;
/**
 * How long after an end that left something running (stock's worker kept, a process that survived the kill) the tag is
 * tried once more: a worker whose omp is gone ends itself within seconds, and what it started then carries the tag alone.
 */
export const RETRY_REMAINING_MS = 60_000;

/** One process as `procs.list` answers it. */
export interface TaggedProcess {
	pid: number;
	ppid: number;
	/** Resident bytes. */
	bytes: number;
	/** When it started, ms since the epoch; absent when the OS did not say. */
	startedMs?: number;
	/** Its executable's file name. */
	name: string;
	/** The tag in its environment; absent when it has none or its environment cannot be read. */
	tag?: string;
}

interface EndedProcess {
	pid: number;
	name: string;
	bytes: number;
	/** It did not end when asked and was killed. */
	forced: boolean;
}

/** What `procs.end` answers. */
export interface EndResult {
	ended: EndedProcess[];
	/** Still running after the kill. */
	left: Array<{ pid: number; name: string }>;
	/** Stock's own workers and what they started. */
	kept: Array<{ pid: number; name: string }>;
	/** Tags the core refused: the app itself runs under them. */
	own: string[];
}

/** Every process with its tag; null when the core cannot answer in time. */
export async function listTaggedProcesses(): Promise<TaggedProcess[] | null> {
	try {
		const answer = await core().call<TaggedProcess[]>(
			"procs.list",
			{ env: SESSION_TAG_ENV, timeoutMs: LIST_TIMEOUT_MS },
			{ timeoutMs: LIST_TIMEOUT_MS },
		);
		return answer.result;
	} catch {
		return null;
	}
}

/** Ends every process that carries one of `tags`. */
async function endTaggedProcesses(tags: readonly string[]): Promise<EndResult> {
	const answer = await core().call<EndResult>(
		"procs.end",
		{ env: SESSION_TAG_ENV, tags, keepArg: STOCK_WORKER_ARG, graceMs: END_GRACE_MS, timeoutMs: END_TIMEOUT_MS },
		{ timeoutMs: END_CALL_TIMEOUT_MS },
	);
	return answer.result;
}

/** What a tab's omp is launched with that says whose its processes are. */
export interface SessionProcessFacts {
	cwd: string;
	/** The session file the tab is on; absent while stock has not written it. */
	sessionPath?: string;
	/** The paired device this computer runs the tab for. */
	device?: string;
}

/** One tab's tag in the file. A record of another shape (a damaged file, a tag that is no tag) is dropped. */
const TagRecordSchema = z.object({
	tag: z.string().regex(/^[0-9a-f]{32}$/),
	cwd: z.string(),
	sessionPath: z.string().optional(),
	device: z.string().optional(),
	/** When the tag was made. */
	since: z.number(),
});
type TagRecord = z.infer<typeof TagRecordSchema>;

/**
 * `live`: a tab of this launch holds it. `left`: the last launch wrote it and no tab has taken it over yet. `ending`:
 * its processes are being ended; it is never handed to a tab again.
 */
type TagState = "live" | "left" | "ending";

interface TagEntry {
	record: TagRecord;
	state: TagState;
	/** The tab's omp now, for the memory record's title. */
	pid?: number;
	/** Its end left something running and was tried again in this launch. */
	retried?: boolean;
}

/** A tab's hold on its tag. */
export interface SessionProcessHandle {
	readonly tag: string;
	/** The tab's scratch folder, named by its tag (session-scratch.ts); absent where none is kept. */
	readonly scratch?: string;
	/** The tab moved: another folder, another session file. */
	update(facts: Partial<SessionProcessFacts>): void;
	/** The tab's omp now (undefined: none runs). */
	setPid(pid: number | undefined): void;
	/** The tab is gone and its omp has exited: end what it left running. Nothing is ended during a quit. */
	close(): Promise<void>;
}

/** A tag and whose it is, for the memory record. */
export interface TagOwner extends SessionProcessFacts {
	tag: string;
	pid?: number;
}

export type SessionProcessLogDetails = Record<string, string | number | boolean>;

export interface SessionProcessesDeps {
	/** A quit is underway: its tab closes end nothing, and the tags stay in the file for the next launch. */
	frozen(): boolean;
	log(message: string, details: SessionProcessLogDetails): void;
	/** Ends the processes of `tags` (default: the core's `procs.end`). */
	end?(tags: readonly string[]): Promise<EndResult>;
	/** A new tag (default: 16 random bytes as hex). */
	newTag?(): string;
	now?(): number;
	/** Runs `run` after `ms` (default: an unref'd timer). */
	later?(run: () => void, ms: number): void;
	/** The folder each tag gets for its tab's throwaway files, and which sessions it served. */
	scratch?: Pick<SessionScratch, "open" | "session">;
}

/** What the launch's sweep keeps. */
export interface SweepOptions {
	/** Session files of this computer's own tabs that come back: the restored layouts and the markers of interrupted work. */
	keep: ReadonlySet<string>;
	/** Whether a tab this computer runs for a paired device holds the session now. */
	hostedHeld(sessionPath: string): boolean;
	/** How long a device has to come back for its tab (`HOST_TAB_GRACE_MS`): its session's processes wait as long. */
	hostedGraceMs: number;
}

/** A session file as a key: Windows names the same file in either case and with either slash. */
function sessionKey(path: string): string {
	const normal = normalize(path);
	return process.platform === "win32" ? normal.toLowerCase() : normal;
}

/** `node×3, chrome×5`, the most frequent first, at most six names. */
function nameCounts(processes: ReadonlyArray<{ name: string }>): string {
	const counts = new Map<string, number>();
	for (const { name } of processes) counts.set(name, (counts.get(name) ?? 0) + 1);
	return [...counts]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 6)
		.map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
		.join(", ");
}

export class SessionProcesses {
	readonly #file: string;
	readonly #deps: SessionProcessesDeps;
	readonly #end: (tags: readonly string[]) => Promise<EndResult>;
	readonly #newTag: () => string;
	readonly #now: () => number;
	readonly #later: (run: () => void, ms: number) => void;
	readonly #entries = new Map<string, TagEntry>();
	/** Ends under way; `settled()` waits for them. */
	readonly #ending = new Set<Promise<void>>();
	#cancelWrite: (() => void) | null = null;

	constructor(file: string, deps: SessionProcessesDeps) {
		this.#file = file;
		this.#deps = deps;
		this.#end = deps.end ?? endTaggedProcesses;
		this.#newTag = deps.newTag ?? (() => randomBytes(16).toString("hex"));
		this.#now = deps.now ?? Date.now;
		this.#later = deps.later ?? ((run, ms) => void setTimeout(run, ms).unref());
		for (const record of this.#read()) this.#entries.set(record.tag, { record, state: "left" });
	}

	/**
	 * A tab's first omp is about to start: its tag. A tab back on the session the last launch left a tag for takes
	 * that tag over, so what the session started before the relaunch is still its own; any other tab gets a new one.
	 * A tag whose processes are being ended is never taken over (a session reopened while its closed tab's leftovers
	 * are still going down starts clean).
	 */
	open(facts: SessionProcessFacts): SessionProcessHandle {
		const key = facts.sessionPath === undefined ? undefined : sessionKey(facts.sessionPath);
		let entry = key === undefined ? undefined : this.#left(key, facts.device)[0];
		if (entry) {
			entry.state = "live";
			entry.record = { ...entry.record, ...facts };
		} else {
			entry = { record: { tag: this.#newTag(), ...facts, since: this.#now() }, state: "live" };
			this.#entries.set(entry.record.tag, entry);
		}
		this.#save();
		const held = entry;
		const scratch = this.#deps.scratch?.open(held.record.tag, facts.sessionPath) ?? undefined;
		return {
			tag: held.record.tag,
			...(scratch !== undefined ? { scratch } : {}),
			update: next => {
				if (held.state !== "live") return;
				if (next.sessionPath !== undefined) this.#deps.scratch?.session(held.record.tag, next.sessionPath);
				const record = { ...held.record, ...next };
				if (
					record.cwd === held.record.cwd &&
					record.sessionPath === held.record.sessionPath &&
					record.device === held.record.device
				)
					return;
				held.record = record;
				this.#save();
			},
			setPid: pid => {
				held.pid = pid;
			},
			close: () => {
				held.pid = undefined;
				if (held.state !== "live" || this.#deps.frozen()) return Promise.resolve();
				return this.#endEntry(held, "closed");
			},
		};
	}

	/**
	 * A tab on `sessionPath` was released: what the last launch left for the session and no tab took over ends with
	 * it (a restored tab closed before it ever started its omp; a tag an earlier close could not end).
	 */
	sessionReleased(sessionPath: string): void {
		if (this.#deps.frozen()) return;
		for (const entry of this.#left(sessionKey(sessionPath), undefined)) void this.#endEntry(entry, "closed");
	}

	/**
	 * Once the launch's tabs are known: ends the processes of every tag the last launch left whose session did not come
	 * back. A tag kept here waits for its tab to start (`open`), for the tab's close (`sessionReleased`), or for the next
	 * launch. A hosted session's device may still be reconnecting, so its tag gets the host tab's own grace first.
	 */
	async sweep(options: SweepOptions): Promise<void> {
		const keep = new Set([...options.keep].map(sessionKey));
		const now: TagEntry[] = [];
		let hosted = false;
		for (const entry of this.#entries.values()) {
			if (entry.state !== "left") continue;
			const { sessionPath, device } = entry.record;
			if (device !== undefined) hosted = true;
			else if (sessionPath === undefined || !keep.has(sessionKey(sessionPath))) now.push(entry);
		}
		if (hosted) {
			this.#later(() => {
				if (this.#deps.frozen()) return;
				for (const entry of this.#entries.values()) {
					const { sessionPath, device } = entry.record;
					if (entry.state !== "left" || device === undefined) continue;
					if (sessionPath !== undefined && options.hostedHeld(sessionPath)) continue;
					void this.#endEntry(entry, "relaunch");
				}
			}, options.hostedGraceMs);
		}
		await Promise.all(now.map(entry => this.#endEntry(entry, "relaunch")));
	}

	/** The tags a tab holds now, or the last launch left for a tab that may still take them over. */
	held(): Set<string> {
		return new Set(
			[...this.#entries.values()].filter(entry => entry.state !== "ending").map(entry => entry.record.tag),
		);
	}

	/** Every tag this app knows and whose it is. */
	owners(): TagOwner[] {
		return [...this.#entries.values()].map(({ record, pid }) => ({
			tag: record.tag,
			cwd: record.cwd,
			...(record.sessionPath !== undefined ? { sessionPath: record.sessionPath } : {}),
			...(record.device !== undefined ? { device: record.device } : {}),
			...(pid !== undefined ? { pid } : {}),
		}));
	}

	/** Resolves once every end under way has settled (tests). */
	async settled(): Promise<void> {
		while (this.#ending.size > 0) await Promise.all([...this.#ending]);
	}

	/** The tags the last launch left for this session, not yet taken over. */
	#left(key: string, device: string | undefined): TagEntry[] {
		return [...this.#entries.values()].filter(({ state, record }) => {
			if (state !== "left" || record.sessionPath === undefined || sessionKey(record.sessionPath) !== key)
				return false;
			return (record.device !== undefined) === (device !== undefined);
		});
	}

	/**
	 * Ends what carries the entry's tag and forgets the tag. The entry stays in the file until the core answered, so a
	 * crash meanwhile leaves it for the next launch; a failed end puts it back as left for the same reason, and so does
	 * one that left something running (a stock worker and what it started, a process that survived the kill), which is
	 * tried once more after `RETRY_REMAINING_MS`.
	 */
	#endEntry(entry: TagEntry, reason: "closed" | "relaunch"): Promise<void> {
		entry.state = "ending";
		const { record } = entry;
		const run = (async () => {
			let result: EndResult;
			try {
				result = await this.#end([record.tag]);
			} catch (error) {
				entry.state = "left";
				this.#deps.log("not ended", {
					level: "warn",
					reason,
					...this.#whose(record),
					error: error instanceof Error ? error.message : String(error),
				});
				return;
			}
			if (result.kept.length > 0 || result.left.length > 0) {
				entry.state = "left";
				if (!entry.retried) {
					entry.retried = true;
					this.#later(() => {
						if (entry.state === "left" && !this.#deps.frozen()) void this.#endEntry(entry, reason);
					}, RETRY_REMAINING_MS);
				}
			} else {
				this.#entries.delete(record.tag);
				this.#save();
			}
			if (result.own.length > 0) {
				this.#deps.log("refused: OMPdesk itself runs under this session's tag", {
					level: "warn",
					reason,
					...this.#whose(record),
				});
				return;
			}
			// A session that left nothing writes nothing: most closes.
			if (result.ended.length === 0 && result.left.length === 0) return;
			this.#deps.log("ended", {
				level: result.left.length > 0 ? "warn" : "info",
				reason,
				...this.#whose(record),
				processes: result.ended.length,
				forced: result.ended.filter(process => process.forced).length,
				mb: Math.round(result.ended.reduce((sum, process) => sum + process.bytes, 0) / 1024 ** 2),
				names: nameCounts(result.ended),
				...(result.left.length > 0 ? { left: result.left.length, leftNames: nameCounts(result.left) } : {}),
				...(result.kept.length > 0 ? { kept: result.kept.length } : {}),
			});
		})();
		this.#ending.add(run);
		void run.finally(() => this.#ending.delete(run));
		return run;
	}

	#whose(record: TagRecord): SessionProcessLogDetails {
		return {
			folder: record.cwd,
			...(record.sessionPath !== undefined ? { session: basename(record.sessionPath) } : {}),
			...(record.device !== undefined ? { device: record.device } : {}),
		};
	}

	#read(): TagRecord[] {
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.#file, "utf8"));
			const tags = typeof parsed === "object" && parsed !== null && "tags" in parsed ? parsed.tags : undefined;
			if (!Array.isArray(tags)) return [];
			return tags.flatMap((value: unknown) => {
				const record = TagRecordSchema.safeParse(value);
				return record.success ? [record.data] : [];
			});
		} catch {
			return [];
		}
	}

	#save(): void {
		this.#cancelWrite?.();
		const tags = [...this.#entries.values()].map(entry => entry.record);
		this.#cancelWrite = writeFileAtomicDeferred(this.#file, `${JSON.stringify({ tags })}\n`, { mode: 0o600 }, error =>
			this.#deps.log("tags not saved", { level: "warn", error: String(error) }),
		);
	}
}
