/**
 * The background work a restart would interrupt: the running `task` subagents and background bash/eval jobs of every
 * tab on this computer (its windows' tabs and the ones it runs for paired devices).
 *
 * Source: the bridge's `composer.jobs` (the GUI's own jobs poll) on every omp whose run is on, a turn or settling
 * (a settling run is on only because background work keeps it). Electron-free: `index.ts` supplies the omps
 * (`members`) and a click on "Restart & install" asks fresh (`chrome-quit.ts`, the shell's
 * `chrome_core::quit::update_restart_confirmation`) to name what the relaunch starts again. The automatic install never looks: background
 * work does not hold it (the relaunch revives it, `app-auto-update.ts`).
 *
 * A tab whose request fails or times out is unknown work, counted like running work in the confirm: a timed-out
 * answer once read as no work for a tab running a subagent. The ask never throws.
 */
import type { BridgeJobRow } from "../../resources/gui-bridge/jobs-contracts";

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
	return backgroundTaskCount(work) > 0;
}

/** How many running tasks a restart interrupts: subagents, jobs and the omps that did not answer. */
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
	const work = parts.filter(hasBackgroundWork);
	if (work.length === 0) return NO_BACKGROUND_WORK;
	const sum = (count: (part: BackgroundWork) => number) => work.reduce((total, part) => total + count(part), 0);
	const unknown = sum(part => part.unknown ?? 0);
	return {
		subagents: sum(part => part.subagents),
		jobs: sum(part => part.jobs),
		subagentLabels: work.flatMap(part => part.subagentLabels),
		jobLabels: work.flatMap(part => part.jobLabels),
		...(unknown > 0 ? { unknown } : {}),
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

/** Every omp's running work, merged; a failed or slow omp is unknown work. Never rejects. */
export async function askBackgroundWork(
	members: () => readonly BackgroundWorkMember[],
	timeoutMs: number = BACKGROUND_WORK_REQUEST_TIMEOUT_MS,
): Promise<BackgroundWork> {
	try {
		return mergeBackgroundWork(await Promise.all(members().map(member => askMember(member, timeoutMs))));
	} catch {
		return UNKNOWN_WORK;
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
