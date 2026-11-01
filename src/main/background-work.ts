/**
 * The background work a restart would cut: the running `task` subagents and background bash/eval jobs of every
 * tab on this computer (its windows' tabs and the ones it runs for paired devices).
 *
 * Source: the bridge's `composer.jobs` (the GUI's own jobs poll) on every omp whose run is on, a turn or settling
 * (a settling run is on only because background work keeps it). Electron-free: `index.ts` supplies the omps
 * (`members`), `updater.ts` feeds the answer to the automatic-install scheduler (`app-auto-update.ts`) and a
 * click on "Restart & install" asks it fresh (`app-quit.ts`, `quit-guard.ts`' `updateRestartConfirmation`).
 *
 * A tab whose request fails or times out is unknown, and unknown work holds a restart like running work (bounded by
 * the scheduler's max wait): a timed-out answer once read as no work for a tab running a subagent. The probe never
 * throws.
 */
import type { BridgeJobRow } from "../../resources/gui-bridge/jobs-contracts";

/** How old the scheduler's cached answer may get before the next tick asks again. */
export const BACKGROUND_WORK_REFRESH_MS = 5000;
/** One tab's `composer.jobs` answer is worth waiting this long for. */
export const BACKGROUND_WORK_REQUEST_TIMEOUT_MS = 3000;
/** The restart confirm names at most this many jobs and subagents. */
export const BACKGROUND_WORK_NAMED = 3;
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
}

export const NO_BACKGROUND_WORK: BackgroundWork = { subagents: 0, jobs: 0, subagentLabels: [], jobLabels: [] };

const UNKNOWN_WORK: BackgroundWork = { ...NO_BACKGROUND_WORK, unknown: 1 };

export function hasBackgroundWork(work: BackgroundWork): boolean {
	return work.subagents + work.jobs + (work.unknown ?? 0) > 0;
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
	const work = parts.filter(hasBackgroundWork);
	if (work.length === 0) return NO_BACKGROUND_WORK;
	return {
		subagents: work.reduce((sum, part) => sum + part.subagents, 0),
		jobs: work.reduce((sum, part) => sum + part.jobs, 0),
		subagentLabels: work.flatMap(part => part.subagentLabels),
		jobLabels: work.flatMap(part => part.jobLabels),
		...(work.some(part => part.unknown) ? { unknown: work.reduce((sum, part) => sum + (part.unknown ?? 0), 0) } : {}),
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
}

/** What `updater.ts` reads: the scheduler's cached reading, a fresh answer for a click, and "nobody is looking". */
export interface BackgroundWorkSource {
	/** The last answer; starts a refresh when it is older than the refresh interval and none is under way. */
	read(): BackgroundWorkReading;
	/** The scheduler is not live (pref off, no installable update): drop the answer, ask nothing until read again. */
	idle(): void;
	/** Ask now (joining a request already under way); never rejects. */
	fresh(): Promise<BackgroundWork>;
}

/** A source with nothing running, for callers that do not watch (tests of other rules). */
export const NO_BACKGROUND_WORK_SOURCE: BackgroundWorkSource = {
	read: () => ({ work: NO_BACKGROUND_WORK, pending: false, askedAt: undefined }),
	idle: () => {},
	fresh: async () => NO_BACKGROUND_WORK,
};

export interface BackgroundWorkWatcherOptions {
	/** The omps whose run is on right now (ready local sidecars, window tabs and hosted tabs). */
	members: () => readonly BackgroundWorkMember[];
	now?: () => number;
	refreshMs?: number;
	timeoutMs?: number;
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
	/** `idle()` bumps it: an answer that lands after is of an earlier live period and is dropped. */
	#period = 0;

	constructor(options: BackgroundWorkWatcherOptions) {
		this.#opts = options;
	}

	read(): BackgroundWorkReading {
		const refreshMs = this.#opts.refreshMs ?? BACKGROUND_WORK_REFRESH_MS;
		const at = (this.#opts.now ?? Date.now)();
		if (!this.#inflight && (this.#askedAt === undefined || at - this.#askedAt >= refreshMs)) void this.fresh();
		return { work: this.#work, pending: !this.#known, askedAt: this.#answerAskedAt };
	}

	idle(): void {
		if (!this.#known && this.#askedAt === undefined) return;
		this.#period++;
		this.#known = false;
		this.#askedAt = undefined;
		this.#answerAskedAt = undefined;
		this.#work = NO_BACKGROUND_WORK;
	}

	fresh(): Promise<BackgroundWork> {
		if (this.#inflight) return this.#inflight;
		const askedAt = (this.#opts.now ?? Date.now)();
		this.#askedAt = askedAt;
		const period = this.#period;
		const asked = this.#ask().then(work => {
			if (period === this.#period) {
				// The interval counts from the answer: a slow omp is not asked again at once.
				this.#askedAt = (this.#opts.now ?? Date.now)();
				this.#answerAskedAt = askedAt;
				this.#work = work;
				this.#known = true;
			}
			return work;
		});
		const inflight = asked.finally(() => {
			if (this.#inflight === inflight) this.#inflight = undefined;
		});
		this.#inflight = inflight;
		return inflight;
	}

	async #ask(): Promise<BackgroundWork> {
		const timeoutMs = this.#opts.timeoutMs ?? BACKGROUND_WORK_REQUEST_TIMEOUT_MS;
		let members: readonly BackgroundWorkMember[];
		try {
			members = this.#opts.members();
		} catch {
			return UNKNOWN_WORK;
		}
		return mergeBackgroundWork(await Promise.all(members.map(member => askMember(member, timeoutMs))));
	}
}

/** One omp's running work; a failed, refused or slow answer is unknown work. */
async function askMember(member: BackgroundWorkMember, timeoutMs: number): Promise<BackgroundWork> {
	let timer: NodeJS.Timeout | undefined;
	try {
		const { promise: timeout, reject } = Promise.withResolvers<never>();
		timer = setTimeout(() => reject(new Error("composer.jobs timed out")), timeoutMs);
		timer.unref();
		return summarizeJobRows(await Promise.race([member.request("composer.jobs", {}, timeoutMs), timeout]));
	} catch {
		return UNKNOWN_WORK;
	} finally {
		clearTimeout(timer);
	}
}
