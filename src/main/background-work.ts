/**
 * The background work a restart would cut: the running `task` subagents and background bash/eval jobs of every
 * tab on this computer (its windows' tabs and the ones it runs for paired devices).
 *
 * Source: the bridge's `composer.jobs` (the GUI's own jobs poll) on every omp whose run is on, a turn or settling
 * (a settling run is on only because background work keeps it). Electron-free: `index.ts` supplies the omps
 * (`members`), `updater.ts` feeds the answer to the automatic-install scheduler (`app-auto-update.ts`) and a
 * click on "Restart & install" asks it fresh (`app-quit.ts`, `quit-guard.ts`' `updateRestartConfirmation`).
 *
 * A tab whose request fails or times out is unknown, and unknown work holds a restart like running work (never cut
 * by an automatic one): a timed-out answer once read as no work for a tab running a subagent. The probe never throws.
 *
 * The countdown's last look is `freeze`: the same answer, from `composer.freeze_jobs`, which also stops each omp that
 * runs nothing from starting any job until `thaw`, its lease or the quit (resources/gui-bridge/job-gate.ts), so the
 * look and the install are one step.
 */
import type { BridgeJobFreeze, BridgeJobRow } from "../../resources/gui-bridge/jobs-contracts";

/** How old the scheduler's cached answer may get before the next tick asks again. */
export const BACKGROUND_WORK_REFRESH_MS = 5000;
/** One tab's `composer.jobs` answer is worth waiting this long for. */
export const BACKGROUND_WORK_REQUEST_TIMEOUT_MS = 3000;
/** The restart confirm names at most this many jobs and subagents. */
export const BACKGROUND_WORK_NAMED = 3;
/** How long one freeze stops an omp's job starts at most when no thaw or quit comes (the bridge caps it under 30 s). */
export const BACKGROUND_WORK_FREEZE_MS = 20_000;
const LABEL_CHARS = 40;

export interface BackgroundWork {
	/** Running `task` jobs: background subagents (a subagent's own nested subagents included). */
	subagents: number;
	/** Running background bash/eval jobs of the sessions themselves (a subagent's own shells go down with it). */
	jobs: number;
	/** The subagents' labels, in the tabs' job order. */
	subagentLabels: readonly string[];
	/** The shell and eval jobs' labels. */
	jobLabels: readonly string[];
	/** Omps whose answer failed or did not come in time: their work is not known, so it counts as running. */
	unknown?: number;
	/**
	 * Tool calls under way at a freeze (`composer.freeze_jobs`): each may still start a job, so the omp's gate stayed
	 * open. Never running work: they only delay the countdown's last moment.
	 */
	starting?: number;
}

export const NO_BACKGROUND_WORK: BackgroundWork = { subagents: 0, jobs: 0, subagentLabels: [], jobLabels: [] };

const UNKNOWN_WORK: BackgroundWork = { ...NO_BACKGROUND_WORK, unknown: 1 };

export function hasBackgroundWork(work: BackgroundWork): boolean {
	return backgroundTaskCount(work) > 0;
}

/** How many running tasks hold a restart: subagents, jobs and the omps that did not answer. */
export function backgroundTaskCount(work: BackgroundWork): number {
	return work.subagents + work.jobs + (work.unknown ?? 0);
}

/** The running work in one tab's `composer.jobs` rows; anything else the bridge sent is ignored. */
export function summarizeJobRows(rows: unknown): BackgroundWork {
	if (!Array.isArray(rows)) return NO_BACKGROUND_WORK;
	const subagentLabels: string[] = [];
	const jobLabels: string[] = [];
	for (const row of rows as Array<Partial<BridgeJobRow> | null>) {
		if (row?.kind !== "job" || !row.job || row.job.status !== "running") continue;
		const label = typeof row.job.label === "string" ? row.job.label : "";
		if (row.job.type === "task") subagentLabels.push(label);
		else if ((row.job.type === "bash" || row.job.type === "eval") && row.depth === 0) jobLabels.push(label);
	}
	if (subagentLabels.length + jobLabels.length === 0) return NO_BACKGROUND_WORK;
	return { subagents: subagentLabels.length, jobs: jobLabels.length, subagentLabels, jobLabels };
}

export function mergeBackgroundWork(parts: readonly BackgroundWork[]): BackgroundWork {
	const work = parts.filter(part => hasBackgroundWork(part) || part.starting);
	if (work.length === 0) return NO_BACKGROUND_WORK;
	const sum = (count: (part: BackgroundWork) => number) => work.reduce((total, part) => total + count(part), 0);
	const unknown = sum(part => part.unknown ?? 0);
	const starting = sum(part => part.starting ?? 0);
	return {
		subagents: sum(part => part.subagents),
		jobs: sum(part => part.jobs),
		subagentLabels: work.flatMap(part => part.subagentLabels),
		jobLabels: work.flatMap(part => part.jobLabels),
		...(unknown > 0 ? { unknown } : {}),
		...(starting > 0 ? { starting } : {}),
	};
}

/** One kind of running work as the restart confirm names it: its count, up to a few labels, and whether more ran. */
export interface NamedWork {
	count: number;
	names: string[];
	more: boolean;
}

/** The confirm's naming: at most `limit` labels in all, the subagents' first, each cut to one short line. */
export function namedBackgroundWork(
	work: BackgroundWork,
	limit: number = BACKGROUND_WORK_NAMED,
): { subagents: NamedWork; jobs: NamedWork } {
	const oneLine = (label: string) => {
		const text = label.replace(/\s+/g, " ").trim();
		return text.length > LABEL_CHARS ? `${text.slice(0, LABEL_CHARS - 1)}…` : text;
	};
	const subagentNames = work.subagentLabels.map(oneLine).filter(name => name !== "");
	const jobNames = work.jobLabels.map(oneLine).filter(name => name !== "");
	const shownSubagents = subagentNames.slice(0, limit);
	const shownJobs = jobNames.slice(0, limit - shownSubagents.length);
	return {
		subagents: {
			count: work.subagents,
			names: shownSubagents,
			more: shownSubagents.length < subagentNames.length,
		},
		jobs: { count: work.jobs, names: shownJobs, more: shownJobs.length < jobNames.length },
	};
}

type SentenceKey =
	| "updates.restartWork.subagents"
	| "updates.restartWork.jobs"
	| "updates.restartWork.unknown"
	| "updates.restartWork.and";

/**
 * The confirm's sentence subject: "2 subagents (LayoutSplit, StreamFast) and 1 background job (dev server)", and the
 * sessions whose answer did not come ("1 session that did not answer").
 */
export function backgroundWorkSentence(
	work: BackgroundWork,
	say: (key: SentenceKey, params?: Record<string, number>) => string,
): string {
	const named = namedBackgroundWork(work);
	const part = (key: "updates.restartWork.subagents" | "updates.restartWork.jobs", kind: NamedWork): string => {
		if (kind.count === 0) return "";
		const names = kind.names.length > 0 ? ` (${kind.names.join(", ")}${kind.more ? ", …" : ""})` : "";
		return `${say(key, { count: kind.count })}${names}`;
	};
	const unknown = work.unknown ? say("updates.restartWork.unknown", { count: work.unknown }) : "";
	return [
		part("updates.restartWork.subagents", named.subagents),
		part("updates.restartWork.jobs", named.jobs),
		unknown,
	]
		.filter(text => text !== "")
		.join(say("updates.restartWork.and"));
}

/** One omp whose run is on: how to ask its bridge. */
export interface BackgroundWorkMember {
	key: string;
	request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
}

/** A cached answer for the scheduler's synchronous facts; `pending` until the first answer of this live period. */
export interface BackgroundWorkReading {
	work: BackgroundWork;
	pending: boolean;
	/** When the request whose answer `work` is began (epoch ms); undefined before the first answer. */
	askedAt: number | undefined;
	/** That answer was a freeze every omp took: none can start work until `thaw`, the lease or the quit. */
	frozen: boolean;
}

/** What `updater.ts` reads: the scheduler's cached reading, a fresh answer for a click, and "nobody is looking". */
export interface BackgroundWorkSource {
	/** The last answer; starts a refresh when it is older than the refresh interval and none is under way. */
	read(): BackgroundWorkReading;
	/** The scheduler is not live (pref off, no installable update): drop the answer and thaw, ask nothing until read again. */
	idle(): void;
	/** Ask now (joining a request already under way); never rejects. */
	fresh(): Promise<BackgroundWork>;
	/**
	 * The countdown's last look: ask every omp now and stop each that runs nothing (and has no tool call under way) from
	 * starting work. `read().frozen` only when every omp stopped and none runs anything; otherwise every omp asked is
	 * let go at once. Joins a freeze under way; never rejects.
	 */
	freeze(): Promise<BackgroundWork>;
	/** Let every omp the last freeze stopped start work again. */
	thaw(): void;
}

/** A source with nothing running and nothing that could start, for callers that do not watch (tests of other rules). */
export const NO_BACKGROUND_WORK_SOURCE: BackgroundWorkSource = {
	read: () => ({ work: NO_BACKGROUND_WORK, pending: false, askedAt: Date.now(), frozen: true }),
	idle: () => {},
	fresh: async () => NO_BACKGROUND_WORK,
	freeze: async () => NO_BACKGROUND_WORK,
	thaw: () => {},
};

export interface BackgroundWorkWatcherOptions {
	/** The omps whose run is on right now (ready local sidecars, window tabs and hosted tabs). */
	members: () => readonly BackgroundWorkMember[];
	now?: () => number;
	refreshMs?: number;
	timeoutMs?: number;
	/** How long a freeze stops an omp's job starts when no thaw or quit comes. */
	freezeMs?: number;
}

export class BackgroundWorkWatcher implements BackgroundWorkSource {
	readonly #opts: BackgroundWorkWatcherOptions;
	#work: BackgroundWork = NO_BACKGROUND_WORK;
	/** An answer of this live period has landed. */
	#known = false;
	/** When the last request began or its answer landed; the refresh interval counts from here. */
	#askedAt: number | undefined;
	/** When the request whose answer `#work` is began. */
	#answerAskedAt: number | undefined;
	#inflight: Promise<BackgroundWork> | undefined;
	#freezing: Promise<BackgroundWork> | undefined;
	/** The omps the last freeze stopped, until `thaw`; set only when every omp asked stopped. */
	#frozen: readonly BackgroundWorkMember[] | undefined;
	/** `idle()` bumps it: an answer that lands after is of an earlier live period and is dropped. */
	#period = 0;

	constructor(options: BackgroundWorkWatcherOptions) {
		this.#opts = options;
	}

	read(): BackgroundWorkReading {
		const refreshMs = this.#opts.refreshMs ?? BACKGROUND_WORK_REFRESH_MS;
		const at = this.#now();
		if (!this.#inflight && (this.#askedAt === undefined || at - this.#askedAt >= refreshMs)) void this.fresh();
		return {
			work: this.#work,
			pending: !this.#known,
			askedAt: this.#answerAskedAt,
			frozen: this.#frozen !== undefined,
		};
	}

	idle(): void {
		this.thaw();
		if (!this.#known && this.#askedAt === undefined) return;
		this.#period++;
		this.#known = false;
		this.#askedAt = undefined;
		this.#answerAskedAt = undefined;
		this.#work = NO_BACKGROUND_WORK;
	}

	fresh(): Promise<BackgroundWork> {
		if (this.#inflight) return this.#inflight;
		const askedAt = this.#now();
		this.#askedAt = askedAt;
		const period = this.#period;
		const asked = this.#ask(member => askMember(member, this.#timeoutMs())).then(work => {
			if (period === this.#period) this.#land(askedAt, work);
			return work;
		});
		const inflight = asked.finally(() => {
			if (this.#inflight === inflight) this.#inflight = undefined;
		});
		this.#inflight = inflight;
		return inflight;
	}

	freeze(): Promise<BackgroundWork> {
		if (this.#freezing) return this.#freezing;
		const askedAt = this.#now();
		this.#askedAt = askedAt;
		const period = this.#period;
		const leaseMs = this.#opts.freezeMs ?? BACKGROUND_WORK_FREEZE_MS;
		const asked: BackgroundWorkMember[] = [];
		let stopped = 0;
		const freezing = this.#ask(async member => {
			asked.push(member);
			const answer = await freezeMember(member, leaseMs, this.#timeoutMs());
			if (answer.frozen) stopped++;
			return answer.work;
		})
			.then(work => {
				// No omp at all stops nothing and needs nothing stopped: the install follows in the same tick.
				const all = stopped === asked.length && !hasBackgroundWork(work) && !work.starting;
				if (!all || period !== this.#period) {
					// One omp still runs (or may start) work, or nobody watches any more: none stays stopped.
					for (const member of asked) thawMember(member, this.#timeoutMs());
					if (period === this.#period) this.#land(askedAt, work);
					return work;
				}
				this.#frozen = asked;
				this.#land(askedAt, work);
				return work;
			})
			.finally(() => {
				if (this.#freezing === freezing) this.#freezing = undefined;
			});
		this.#freezing = freezing;
		return freezing;
	}

	thaw(): void {
		const frozen = this.#frozen;
		this.#frozen = undefined;
		for (const member of frozen ?? []) thawMember(member, this.#timeoutMs());
	}

	/** An answer lands unless a newer one already did (a plain look asked before a freeze never replaces it). */
	#land(askedAt: number, work: BackgroundWork): void {
		// The interval counts from the answer: a slow omp is not asked again at once.
		this.#askedAt = this.#now();
		if (this.#answerAskedAt !== undefined && askedAt < this.#answerAskedAt) return;
		this.#answerAskedAt = askedAt;
		this.#work = work;
		this.#known = true;
	}

	#now(): number {
		return (this.#opts.now ?? Date.now)();
	}

	#timeoutMs(): number {
		return this.#opts.timeoutMs ?? BACKGROUND_WORK_REQUEST_TIMEOUT_MS;
	}

	async #ask(askOne: (member: BackgroundWorkMember) => Promise<BackgroundWork>): Promise<BackgroundWork> {
		let members: readonly BackgroundWorkMember[];
		try {
			members = this.#opts.members();
		} catch {
			return UNKNOWN_WORK;
		}
		return mergeBackgroundWork(await Promise.all(members.map(askOne)));
	}
}

/** One request with its own timeout; rejects on a failure or no answer in time. */
async function requestInTime(member: BackgroundWorkMember, method: string, params: unknown, timeoutMs: number) {
	let timer: NodeJS.Timeout | undefined;
	try {
		const { promise: timeout, reject } = Promise.withResolvers<never>();
		timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
		timer.unref();
		return await Promise.race([member.request(method, params, timeoutMs), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** One omp's running work; a failed, refused or slow answer is unknown work. */
async function askMember(member: BackgroundWorkMember, timeoutMs: number): Promise<BackgroundWork> {
	try {
		return summarizeJobRows(await requestInTime(member, "composer.jobs", {}, timeoutMs));
	} catch {
		return UNKNOWN_WORK;
	}
}

/** One omp's work at a freeze and whether it stopped starting work; a failed or slow answer is unknown work. */
async function freezeMember(
	member: BackgroundWorkMember,
	leaseMs: number,
	timeoutMs: number,
): Promise<{ work: BackgroundWork; frozen: boolean }> {
	try {
		const answer = (await requestInTime(member, "composer.freeze_jobs", { leaseMs }, timeoutMs)) as
			| Partial<BridgeJobFreeze>
			| undefined;
		const work = summarizeJobRows(answer?.rows);
		const starting = typeof answer?.starting === "number" && answer.starting > 0 ? answer.starting : 0;
		return { work: starting > 0 ? { ...work, starting } : work, frozen: answer?.frozen === true };
	} catch {
		return { work: UNKNOWN_WORK, frozen: false };
	}
}

/** Let one omp start work again; its lease lets it go anyway if this never arrives. */
function thawMember(member: BackgroundWorkMember, timeoutMs: number): void {
	void requestInTime(member, "composer.thaw_jobs", {}, timeoutMs).catch(() => undefined);
}
