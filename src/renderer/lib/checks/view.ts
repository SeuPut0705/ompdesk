/**
 * What the check-control screens say of a hub frame (docs/design/check-control.md §8): which pools have work, how
 * full each is, how far a release's gates got and what its run waits on, what state a run is in and how its jobs
 * stand per OS. Pure: the sidebar block, the Checks page and the work board's row read these, so a figure is never
 * worked out twice. Shapes are the contract's (`src/shared/checks-contract.ts`); names come with the frame.
 */

import {
	type Decision,
	type GateStatus,
	type Job,
	LANES,
	type Origin,
	type OS,
	type Pool,
	type Run,
	type RunResult,
	type Snapshot,
} from "../../../shared/checks-contract";
import type { ChecksFrame, ChecksNames } from "../../../shared/checks-frame";

export type Os = (typeof OS)[number];
export type Lane = (typeof LANES)[number];

export const OS_NAME: Record<Os, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };

export type Freshness = "live" | "stale" | "lost";

/**
 * How far the frame can be trusted: `lost` while main cannot reach the hub, `stale` when the hub itself reads no
 * pool as live (its poll window passed for all of them). Nothing in a frame that is not `live` counts as current.
 */
export function freshness(frame: ChecksFrame): Freshness {
	if (frame.hub === "lost") return "lost";
	const { pools } = frame.snapshot;
	return pools.length > 0 && pools.every(pool => pool.state !== "live") ? "stale" : "live";
}

export function poolHasWork(pool: Pool): boolean {
	return pool.state !== "offline" && (pool.running > 0 || pool.queued > 0);
}

export type PoolKind = "github" | "here" | "paired" | "runner";

export function poolKind(pool: Pool, names: ChecksNames): PoolKind {
	if (pool.where.kind === "github-hosted") return "github";
	if (pool.where.kind === "self-hosted") return "runner";
	return names.devices[pool.where.deviceId]?.here ? "here" : "paired";
}

/** A pool's name: the computer's, "GitHub macOS", or a self-hosted runner's id. Never translated: all proper names. */
export function poolName(pool: Pool, names: ChecksNames): string {
	if (pool.where.kind === "github-hosted") return `GitHub ${OS_NAME[pool.os]}`;
	if (pool.where.kind === "self-hosted") return pool.where.runnerId;
	return names.devices[pool.where.deviceId]?.name ?? pool.where.deviceId;
}

const POOL_RANK: Record<PoolKind, number> = { github: 0, runner: 0, here: 1, paired: 2 };

/** The pools the sidebar draws: only those with work, GitHub's first, then this computer, then the rest as listed. */
export function poolsWithWork(frame: ChecksFrame): Pool[] {
	return frame.snapshot.pools
		.filter(poolHasWork)
		.map((pool, index) => ({ pool, index, rank: POOL_RANK[poolKind(pool, frame.names)] }))
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map(entry => entry.pool);
}

export type PoolTone = "plain" | "full";

/** How full a pool is: its share of slots in use, and `full` once none is free (a queue then only grows). */
export function poolFill(pool: Pool): { fraction: number; tone: PoolTone } {
	if (pool.limit <= 0) return { fraction: 0, tone: "plain" };
	const fraction = Math.min(1, pool.running / pool.limit);
	return { fraction, tone: pool.running >= pool.limit ? "full" : "plain" };
}

/** Jobs waiting over every pool that can be read: the sidebar head's figure. */
export function waitingJobs(snapshot: Snapshot): number {
	return snapshot.pools.reduce((sum, pool) => sum + (pool.state === "offline" ? 0 : pool.queued), 0);
}

/** A gate's name as a person reads it: the jobs it selects, or its whole workflow when it selects every job. */
export function gateName(status: GateStatus): string {
	const { workflow, jobs } = status.gate.jobs;
	return jobs.length > 0 ? jobs.join(", ") : workflow;
}

/** One release as the board draws it: its gates in the hub's order and the runs that decide them. */
export interface ReleaseView {
	id: string;
	gates: GateStatus[];
	runs: Run[];
}

export function releases(snapshot: Snapshot): ReleaseView[] {
	const byId = new Map<string, ReleaseView>();
	for (const status of snapshot.gates) {
		const id = status.gate.release;
		const view = byId.get(id) ?? { id, gates: [], runs: [] };
		view.gates.push(status);
		const run = snapshot.runs.find(entry => entry.id === status.run);
		if (run && !view.runs.includes(run)) view.runs.push(run);
		byId.set(id, view);
	}
	return [...byId.values()];
}

/** "6 of 10 gates green". A quarantined failure never counts: the hub says `red` for it. */
export function gateProgress(release: ReleaseView): { green: number; total: number } {
	return { green: release.gates.filter(status => status.state === "green").length, total: release.gates.length };
}

/** The jobs of a gate's run that the gate selects by name (every job of the run when it names none). */
export function gateJobs(status: GateStatus, snapshot: Snapshot): Job[] {
	const run = snapshot.runs.find(entry => entry.id === status.run);
	if (!run) return [];
	const names = status.gate.jobs.jobs;
	return names.length === 0 ? run.jobs : run.jobs.filter(job => names.includes(job.name));
}

/** A pool a release's jobs wait at, and how many of them. */
export interface ReleaseWait {
	pool: Pool;
	jobs: number;
	/** No slot is free: the jobs start only as others end. */
	full: boolean;
}

/** What a release's runs wait on: each pool where a job of theirs is held or queued, the fullest first. */
export function releaseWaits(release: ReleaseView, snapshot: Snapshot): ReleaseWait[] {
	const counts = new Map<string, number>();
	for (const run of release.runs) {
		for (const job of run.jobs) {
			if (job.state === "held" || job.state === "queued") counts.set(job.pool, (counts.get(job.pool) ?? 0) + 1);
		}
	}
	return [...counts]
		.flatMap(([id, jobs]) => {
			const pool = snapshot.pools.find(entry => entry.id === id);
			return pool ? [{ pool, jobs, full: poolFill(pool).tone === "full" }] : [];
		})
		.sort((a, b) => Number(b.full) - Number(a.full) || b.jobs - a.jobs);
}

export type RunState = "running" | "queued" | "held" | "passed" | "failed" | "cancelled" | "reused" | "superseded";

/** A job that has not ended: OMPdesk holds it, its pool queues it, or it runs. */
const jobIsLive = (state: Job["state"]) => state === "held" || state === "queued" || state === "running";

/**
 * One word for a run. What ended it comes first (superseded, reused, its verdict); a run still going is running
 * while any job runs, else queued while any waits at its pool, else held (OMPdesk has not let any job start).
 */
export function runState(run: Run): RunState {
	if (run.supersededBy) return "superseded";
	if (run.reusedFrom) return "reused";
	if (run.verdict === "green") return "passed";
	if (run.verdict === "red") return "failed";
	if (run.verdict === "cancelled") return "cancelled";
	if (run.jobs.some(job => job.state === "running")) return "running";
	if (run.jobs.some(job => job.state === "queued")) return "queued";
	return "held";
}

export function runIsLive(run: Run): boolean {
	const state = runState(run);
	return state === "running" || state === "queued" || state === "held";
}

/** When the run last moved: its newest job end, else start, else when it was queued. */
export function runMovedAt(run: Run): number | null {
	if (run.jobs.length === 0) return null;
	return Math.max(...run.jobs.map(job => job.endedAt ?? job.startedAt ?? job.queuedAt));
}

/** When the run was asked for. */
export function runQueuedAt(run: Run): number | null {
	return run.jobs.length > 0 ? Math.min(...run.jobs.map(job => job.queuedAt)) : null;
}

export interface OsTally {
	os: Os;
	running: number;
	queued: number;
	held: number;
	failed: number;
	/** Every job of this OS ended (passed, reused, failed or cancelled). */
	done: boolean;
	total: number;
}

/** A run's jobs per OS, the OS with live work first: "macOS 2 running · 6 queued · Linux, Windows done". */
export function jobTally(jobs: readonly Job[]): OsTally[] {
	const byOs = new Map<Os, OsTally>();
	for (const job of jobs) {
		const tally = byOs.get(job.os) ?? { os: job.os, running: 0, queued: 0, held: 0, failed: 0, done: true, total: 0 };
		tally.total += 1;
		if (job.state === "running") tally.running += 1;
		else if (job.state === "queued") tally.queued += 1;
		else if (job.state === "held") tally.held += 1;
		else if (job.state === "failed") tally.failed += 1;
		if (jobIsLive(job.state)) tally.done = false;
		byOs.set(job.os, tally);
	}
	return [...byOs.values()].sort((a, b) => Number(a.done) - Number(b.done));
}

export function jobsDone(jobs: readonly Job[]): { done: number; total: number } {
	return { done: jobs.filter(job => !jobIsLive(job.state)).length, total: jobs.length };
}

export interface LaneGroup {
	lane: Lane;
	runs: Run[];
	/** How many runs of the lane are in each state, for the lane header's aside. */
	states: Partial<Record<RunState, number>>;
}

/** Runs under their lane in admission order (release, land, branch, local); a lane with no run is left out. */
export function runsByLane(runs: readonly Run[]): LaneGroup[] {
	return LANES.flatMap(lane => {
		const own = runs.filter(run => run.lane === lane);
		if (own.length === 0) return [];
		const states: Partial<Record<RunState, number>> = {};
		for (const run of own) {
			const state = runState(run);
			states[state] = (states[state] ?? 0) + 1;
		}
		return [{ lane, runs: own, states }];
	});
}

/** The newest decision about a run: why it is held, reused, placed or cancelled. */
export function decisionFor(run: Run, decisions: readonly Decision[]): Decision | null {
	let newest: Decision | null = null;
	for (const decision of decisions) {
		if (decision.run === run.id && (!newest || decision.at > newest.at)) newest = decision;
	}
	return newest;
}

/** The answer an agent received last. */
export function lastAnswer(snapshot: Snapshot): RunResult | null {
	let newest: RunResult | null = null;
	for (const result of snapshot.answers) {
		if (!newest || result.answer.asOf > newest.answer.asOf) newest = result;
	}
	return newest;
}

export interface OriginView {
	kind: Origin["kind"];
	/** The session's title, or the name an outside caller claimed. Absent for a session main cannot name. */
	title?: string;
	goal?: string;
	device?: string;
	autopilot?: boolean;
}

/** Who started a run, with the names a row draws. An id the frame does not name stays out of sight. */
export function originView(origin: Origin, names: ChecksNames): OriginView {
	if (origin.kind === "outside") return { kind: "outside", title: origin.claimedName };
	if (origin.kind !== "session") return { kind: origin.kind };
	const session = names.sessions[origin.session];
	return {
		kind: "session",
		title: session?.title,
		goal: origin.goal,
		device: names.devices[origin.device]?.name,
		autopilot: session?.autopilot,
	};
}

/** The repository's own name of "owner/name". */
export function repoName(repo: string): string {
	return repo.slice(repo.lastIndexOf("/") + 1);
}

export const shortSha = (sha: string) => sha.slice(0, 7);

/**
 * The run a session waits on, for the work board's row: its newest live run. A session is named by its saved id, or
 * its tab's id before its file exists, on its computer (`local` for the hub's own).
 */
export function waitedRun(snapshot: Snapshot, session: { ids: readonly string[]; device: string }): Run | null {
	let newest: Run | null = null;
	for (const run of snapshot.runs) {
		const { origin } = run;
		if (origin.kind !== "session" || origin.device !== session.device || !session.ids.includes(origin.session))
			continue;
		if (!runIsLive(run)) continue;
		if (!newest || (runQueuedAt(run) ?? 0) > (runQueuedAt(newest) ?? 0)) newest = run;
	}
	return newest;
}
