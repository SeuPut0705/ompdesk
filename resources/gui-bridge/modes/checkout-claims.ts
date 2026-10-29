/**
 * Shared-checkout claims: which session owns a file it changed that nobody committed. One state machine, two halves:
 * - `ClaimBook`, the session's own claims (the bridge, one per omp process): a call's hook claims its files before the
 *   tool runs, its result settles them, an agent's run end settles that agent's calls, a retire from main drops what
 *   git no longer lists, a restart restores the journal under a new `instance`.
 * - `judgeClaim`, main's verdict on one claim in one pass: shown to the session's peers, or committed (released and
 *   retired).
 * Model: formal/checkout-claims (TLA+, every interleaving of these events with main's pass; `.omp/skills/
 * checkout-claims-verify`). Property test: src/main/checkout-claims.test.ts. Pure: no omp import, so main bundles it.
 */
import { isInside, normalizePath } from "./autopilot-guard-core";
import type { CheckoutStatus } from "./checkout-peers-contracts";

/** The most claims a session holds (a long session with no company never has them retired). */
export const CLAIMS_MAX = 2000;

/** How a call ends: its tool reported back (stock's `tool_result`). */
export interface CallEnd {
	isError: boolean;
	/** `details.async.jobId` of a bash call that went to the background: the command still runs, so its claims stay pending until the job ends. */
	job?: string;
	/** Files the result says it changed, in main's spelling: they join the call's claims. */
	reported?: readonly string[];
}

/** A call starting: what its hook claims, and what a successful run of it makes clean. */
export interface CallStart<T> {
	owner: string;
	/** Absent: the call is not tracked (its claims are taken and never pending). */
	id?: string;
	paths: readonly string[];
	/** A script that failed may still have written: a failed shell call keeps its claims, a failed file tool's are given back. */
	keepsOnError: boolean;
	/** Own claims a successful git run in the call makes clean (no globs). */
	drops: readonly string[];
	/** Main should read now when the call succeeds. */
	refresh: boolean;
	/** The caller's own data for the call, handed back when the call ends. */
	extra: T;
}

/** A call that has not reported back (or whose job still runs). */
interface Pending<T> {
	owner: string;
	/** The files the call claimed, each with the claim it took over (undefined: none). */
	claimed: Array<{ path: string; stamp: number; earlier: number | undefined }>;
	keepsOnError: boolean;
	drops: readonly string[];
	/** The stamp counter before the call: a drop never takes a claim a later call made. */
	seq: number;
	refresh: boolean;
	extra: T;
}

const pendingKey = (owner: string, id: string) => `${owner}\0${id}`;

export class ClaimBook<T = undefined> {
	/** This omp's load of the bridge: main tells a new one its peers again and never retires with another load's stamps. */
	readonly instance = globalThis.crypto.randomUUID();
	#files: string[] = [];
	#stamps = new Map<string, number>();
	#seq = 0;
	#revision = 0;
	/** The calls that have not reported back yet, by owner and tool call id (two agents' ids may repeat). */
	#pending = new Map<string, Pending<T>>();
	/** The calls whose command went to the background, by job id: they claim until the job ends. */
	#jobs = new Map<string, Pending<T>>();

	/** The files this session changed, newest first. */
	get files(): readonly string[] {
		return this.#files;
	}

	/** Moves whenever a file joins or leaves the claims: the journal writes when it moves. */
	get revision(): number {
		return this.#revision;
	}

	/** Each file's stamp: the number of the latest call that changed it, so main can retire exactly what it saw. */
	stamp(file: string): number {
		return this.#stamps.get(file) ?? 0;
	}

	/** What `checkout_status` and `checkout_retire` answer (without the task). */
	status(): Omit<CheckoutStatus, "task"> {
		const files = [...this.#files];
		return {
			files,
			stamps: files.map(file => this.stamp(file)),
			pending: [...this.#writing()],
			instance: this.instance,
		};
	}

	/** The paths a call still running (or its background job) is writing. */
	#writing(): Set<string> {
		const paths = new Set<string>();
		for (const call of [...this.#pending.values(), ...this.#jobs.values()])
			for (const claim of call.claimed) paths.add(claim.path);
		return paths;
	}

	/** A call's hook ran: its paths become the newest claims, pending until it reports back. True when a file joined. */
	begin(start: CallStart<T>): boolean {
		const had = new Set(this.#files);
		const gained = start.paths.some(path => !had.has(path));
		const seq = this.#seq;
		const claimed = this.#claim(start.paths);
		if (start.id !== undefined)
			this.#pending.set(pendingKey(start.owner, start.id), {
				owner: start.owner,
				claimed,
				keepsOnError: start.keepsOnError,
				drops: start.drops,
				seq,
				refresh: start.refresh,
				extra: start.extra,
			});
		return gained;
	}

	/** The caller's data of a call still pending. */
	extra(owner: string, id: string): T | undefined {
		return this.#pending.get(pendingKey(owner, id))?.extra;
	}

	/**
	 * The call `id` of `owner` reported back: its files are written now, so their stamps move on and a retirement main
	 * decided from a read taken while it ran matches nothing. A file tool that failed wrote nothing: its claims are given
	 * back (a failed script may still have written, its claims stay). A command that went to the background keeps its
	 * claims until the job ends. `changed`: main should read now. `ended`: the call's data (none when it was not pending).
	 */
	end(owner: string, id: string, outcome: CallEnd): { changed: boolean; ended?: T } {
		const key = pendingKey(owner, id);
		const call = this.#pending.get(key);
		if (!call) return { changed: false };
		this.#pending.delete(key);
		let changed = call.claimed.length > 0 || call.refresh;
		if (!outcome.isError && outcome.reported && outcome.reported.length > 0) {
			call.claimed.push(...this.#claim(outcome.reported));
			changed = true;
		}
		if (outcome.job !== undefined && !outcome.isError) {
			this.#jobs.set(outcome.job, call);
			return { changed, ended: call.extra };
		}
		if (outcome.isError) {
			if (!call.keepsOnError) return { changed: this.#revert(call) || changed, ended: call.extra };
		} else changed = this.#clean(call) || changed;
		this.#confirm(call);
		return { changed, ended: call.extra };
	}

	/** A background job ended: the files its command claimed are written now. True when it held any. */
	settleJob(jobId: string): boolean {
		const call = this.#jobs.get(jobId);
		if (!call) return false;
		this.#jobs.delete(jobId);
		this.#confirm(call);
		return true;
	}

	/**
	 * Jobs not in `running` have ended (stock's job list is the only place that says): their claims are written now. A
	 * list read from one agent (`owner`) says nothing of another agent's jobs. True when any held some.
	 */
	reconcileJobs(running: ReadonlySet<string>, owner?: string): boolean {
		let any = false;
		for (const [jobId, call] of [...this.#jobs])
			if (!running.has(jobId) && (owner === undefined || call.owner === owner)) any = this.settleJob(jobId) || any;
		return any;
	}

	/**
	 * `owner`'s run ended (one agent: the session's main agent or one subagent; they share this book). Stock ends a run
	 * once its calls ran, so a call of that agent still pending never ran (a denied approval, a later hook's block): a
	 * file tool's claims are given back, a shell call's stay (a script may have written). Another agent's calls may still
	 * run and stay pending.
	 */
	agentEnded(owner: string): { changed: boolean; ended: T[] } {
		let changed = false;
		const ended: T[] = [];
		for (const [key, call] of [...this.#pending]) {
			if (call.owner !== owner) continue;
			this.#pending.delete(key);
			ended.push(call.extra);
			if (call.keepsOnError) {
				this.#confirm(call);
				changed = call.claimed.length > 0 || changed;
			} else changed = this.#revert(call) || changed;
		}
		return { changed, ended };
	}

	/**
	 * Main saw these claims committed (`git status` no longer lists them): they stop being this session's. A file changed
	 * again since (its stamp moved on) stays: that later change is a fresh claim. A file a running call is still writing
	 * stays too.
	 */
	retire(claims: ReadonlyArray<{ file: string; stamp: number }>): void {
		const writing = this.#writing();
		this.#drop(
			new Set(
				claims
					.filter(claim => !writing.has(claim.file) && this.#stamps.get(claim.file) === claim.stamp)
					.map(claim => claim.file),
			),
		);
	}

	/** `checkout_retire`'s params: ignored unless main read them from this very load (a restarted omp numbers its stamps anew). True when applied. */
	retireFrom(params: unknown): boolean {
		const instance =
			typeof params === "object" && params !== null && "instance" in params ? params.instance : undefined;
		if (instance !== this.instance) return false;
		this.retire(retiredClaims(params));
		return true;
	}

	/** What the journal keeps: the files and their stamps (the stamps only say how fresh each claim was; a restore numbers them anew). */
	snapshot(): { files: string[]; stamps: number[] } {
		return { files: [...this.#files], stamps: this.#files.map(file => this.stamp(file)) };
	}

	/**
	 * The claims a session had when the omp last ran it (its journal entry) become this book's: a restart or a relaunch
	 * keeps protecting the work nobody committed, and main retires what git no longer lists. Undefined or malformed data
	 * means none, which is also what a switch to a session with no entry means. Stamps start anew, above every earlier one.
	 */
	restore(data: unknown): void {
		const list = typeof data === "object" && data !== null && "files" in data ? data.files : undefined;
		const files = Array.isArray(list)
			? list
					.filter((file): file is string => typeof file === "string" && file !== "")
					.map(file => normalizePath(file, "/"))
			: [];
		this.#pending.clear();
		this.#jobs.clear();
		this.#files = [];
		this.#stamps.clear();
		this.#revision++;
		this.#claim([...new Set(files)].slice(0, CLAIMS_MAX));
	}

	/** `paths` become the newest claims; each takes a stamp, and the ones before are remembered so a failed call can give the claim back. */
	#claim(paths: readonly string[]): Pending<T>["claimed"] {
		const fresh = [...new Set(paths)];
		if (fresh.length === 0) return [];
		const taken = new Set(fresh);
		const claimed = fresh.map(path => {
			const earlier = this.#stamps.get(path);
			const stamp = ++this.#seq;
			this.#stamps.set(path, stamp);
			return { path, stamp, earlier };
		});
		if (claimed.some(claim => claim.earlier === undefined)) this.#revision++;
		this.#files = [...fresh, ...this.#files.filter(file => !taken.has(file))];
		for (const gone of this.#files.splice(CLAIMS_MAX)) {
			this.#stamps.delete(gone);
			this.#revision++;
		}
		return claimed;
	}

	#drop(files: ReadonlySet<string>): void {
		if (files.size === 0) return;
		this.#files = this.#files.filter(file => !files.has(file));
		for (const file of files) this.#stamps.delete(file);
		this.#revision++;
	}

	/** The call wrote nothing: each file it claimed goes back to the claim it took over, unless a later call changed it. */
	#revert(call: Pending<T>): boolean {
		const gone = new Set<string>();
		let changed = false;
		for (const { path, stamp, earlier } of call.claimed) {
			if (this.#stamps.get(path) !== stamp) continue;
			changed = true;
			if (earlier === undefined) gone.add(path);
			else this.#stamps.set(path, earlier);
		}
		this.#drop(gone);
		return changed;
	}

	/** The call wrote: its files' stamps move on, so a retirement main decided from a read taken while it ran matches nothing. */
	#confirm(call: Pending<T>): void {
		for (const { path } of call.claimed) if (this.#stamps.has(path)) this.#stamps.set(path, ++this.#seq);
	}

	/** The files a successful git run made clean leave the claims at once (main confirms), unless a later call changed them. */
	#clean(call: Pending<T>): boolean {
		if (call.drops.length === 0) return false;
		const gone = new Set(
			this.#files.filter(
				file => call.drops.some(path => isInside(file, path)) && (this.#stamps.get(file) ?? 0) <= call.seq,
			),
		);
		this.#drop(gone);
		return gone.size > 0;
	}
}

/** `checkout_retire`'s claims; anything malformed is skipped. */
export function retiredClaims(params: unknown): Array<{ file: string; stamp: number }> {
	const files = typeof params === "object" && params !== null && "files" in params ? params.files : undefined;
	if (!Array.isArray(files)) return [];
	return files.flatMap(item =>
		typeof item === "object" &&
		item !== null &&
		"file" in item &&
		"stamp" in item &&
		typeof item.file === "string" &&
		typeof item.stamp === "number"
			? [{ file: item.file, stamp: item.stamp }]
			: [],
	);
}

/** What main knows of one claim in one pass. */
export interface ClaimFacts {
	/** A call of the session is still writing it. */
	pending: boolean;
	/** The session's bridge answered this pass (else main judges its last answer, which may miss a write started since). */
	fresh: boolean;
	/** It lies inside the worktree (else nothing can list it). */
	inside: boolean;
	/** Its edit stamp is known (a bridge older than `checkout_retire` sends none: it cannot be retired). */
	stamped: boolean;
	/** What git said of it this pass: listed (uncommitted), unlisted (committed or undone), or unknown (git failed). */
	git: "listed" | "unlisted" | "unknown";
	/** An earlier pass judged this very claim (same omp load, same stamp) committed. */
	committedBefore: boolean;
}

/** Shown to the peers as the session's, or committed: released for good and retired in the session's book (when `retire`). */
export type ClaimVerdict = { kind: "shown" } | { kind: "committed"; retire: boolean } | { kind: "hidden" };

/**
 * Main's verdict on one claim. A claim being written is shown whatever git says (the write may not show yet). A claim
 * judged committed stays committed: its stamp has not moved, so the session has not changed the file since, and a
 * later change of it is someone else's. Only the bridge's own answer of this pass can release a claim: a remembered
 * one may miss a write started since. Outside the worktree a claim is nobody's business and is retired.
 */
export function judgeClaim(facts: ClaimFacts): ClaimVerdict {
	if (!facts.inside)
		return facts.fresh && facts.stamped && !facts.pending ? { kind: "committed", retire: true } : { kind: "hidden" };
	if (facts.pending) return { kind: "shown" };
	if (facts.committedBefore) return { kind: "committed", retire: true };
	if (!facts.fresh || facts.git !== "unlisted") return { kind: "shown" };
	// Unlisted without a stamp: an older bridge, which cannot be told to retire.
	return facts.stamped ? { kind: "committed", retire: true } : { kind: "hidden" };
}
