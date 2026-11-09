/**
 * What a session row shows of a live session, built once by the computer that runs it (main's `SessionSummaries`)
 * and read by every view of that computer's sessions: its own windows, its phone pages, every paired computer, and
 * `ompdesk_sessions`. A view never assembles a row's run state or subagent count from the tab events it happened to
 * receive: it holds this computer's summaries at a version and applies the next change on it, or reads them whole
 * when it holds none or missed a change. Dependency-free: main, the renderer and the paired link share it.
 */
import type { AgentSource, SidecarRestartProgress, SubagentSnapshot } from "./rpc-types";

/** A tab's status as a row reads it: the sidecar's, `running` while a turn or its background work runs. */
export type SummaryStatus = "asleep" | "starting" | "ready" | "running" | "exited" | "error" | "restarting" | "waiting";

/** What the session waits on: a tool or plan approval, or any other answer (an ask, a confirmation, a text field). */
export type SummaryAsk = "approval" | "input";

/**
 * One subagent the row lists (running, waiting, failed): finished ones are never listed, so the summary leaves them
 * out. `title` is the row's label by the one rule (`subagentLabel`); `startedAt` this computer's clock.
 */
export interface SummaryAgent {
	id: string;
	index: number;
	agent: string;
	agentSource?: AgentSource;
	status: string;
	title?: string;
	parentToolCallId?: string;
	parentSubagentId?: string;
	kind?: "sub" | "advisor";
	startedAt: number;
	model?: string;
	role?: string;
	/** What it does now (stock's last intent, else its current tool): the row's tooltip. */
	step?: string;
	/** Stock's progress tally, the row's tooltip ("128.4k tokens · 48 tool calls") and the Work tree's cost. */
	tokens?: number;
	toolCount?: number;
	cost?: number;
	/** Its own transcript file (a row's click reads it through the tab that holds the session). */
	sessionFile?: string;
}

const UNSAVED_PREFIX = "tab:";

/** The key of the summary of a tab whose omp has named no session file yet: its row is a live row of that tab. */
export function unsavedSessionKey(tabId: string): string {
	return `${UNSAVED_PREFIX}${tabId}`;
}

/** A summary of a tab with no session file yet: no saved session, no stored row, nothing to list by file. */
export function isUnsavedSession(summary: Pick<SessionSummary, "sessionPath">): boolean {
	return summary.sessionPath.startsWith(UNSAVED_PREFIX);
}

/**
 * The sessions a computer runs for its paired devices (a device's tab there, `openFor`) that a list can show by file:
 * this computer's sidebar rows, the Work tree and the tabs it counts as held. A device's tab whose omp has named no
 * file yet is a row of that device's own, not of this computer's list.
 */
export function hostedSummaries(sessions: readonly SessionSummary[]): SessionSummary[] {
	return sessions.filter(summary => summary.openFor !== undefined && !isUnsavedSession(summary));
}

export interface SessionSummary {
	/**
	 * The session file: the key every view finds its row by. A tab whose omp has named no file yet (a first turn stock
	 * has not written) is summarized under `unsavedSessionKey(tabId)`, so its row reads the same one source.
	 */
	sessionPath: string;
	/** The tab that runs it on the computer that built the summary. */
	tabId: string;
	cwd: string;
	kind: "agent" | "chat";
	status: SummaryStatus;
	/** With `running`: only background work runs, the turn itself ended. */
	settling?: true;
	/** Stock compacts the session's context (often between turns): work under way, as a turn is. */
	compacting?: true;
	/** When the running turn started (the building computer's clock). */
	since?: number;
	ask?: SummaryAsk;
	/** The turn waits for the internet connection (turn-resume.ts). */
	awaitingConnection?: true;
	/** With `error`: another omp still holds the session, a wait that ends by itself. */
	sessionHeld?: true;
	/** With `starting`: it waits its turn in the computer's start queue (`SidecarStatusPayload.queued`). */
	queued?: true;
	/** With `error`, `exited` or `restarting`: why, as the tab's omp said it, and the restart attempts so far. */
	failure?: SummaryFailure;
	sessionId?: string;
	title?: string;
	autoTitle?: string;
	/** The paired device this computer runs the session for (a tab of that device's), by its name. */
	openFor?: string;
	agents: SummaryAgent[];
}

/** Why a session's omp failed, exited or restarts (`failureOf`). */
export interface SummaryFailure {
	message?: string;
	restart?: SidecarRestartProgress;
}

/**
 * The one rule for what a tab's last status says of a failure: only `error`, `exited` and `restarting` carry one. The
 * pool's tab listing (every window's banner, `IpcTabInfo.message`/`restart`) and every summary read it from here.
 */
export function failureOf(payload: {
	status: string;
	message?: string;
	restart?: SidecarRestartProgress;
}): SummaryFailure | undefined {
	if (payload.status !== "error" && payload.status !== "exited" && payload.status !== "restarting") return undefined;
	return {
		...(payload.message === undefined ? {} : { message: payload.message }),
		...(payload.restart === undefined ? {} : { restart: payload.restart }),
	};
}

/** Every summary of one computer at one version (`epoch.n`: a new epoch each run, so another run's copy never matches). */
export interface VersionedSummaries {
	version: string;
	sessions: SessionSummary[];
}

/** What changed from `base` to `version`: summaries that are new or differ, and the session files no longer run. */
export interface SummaryDelta {
	base: string;
	version: string;
	set: SessionSummary[];
	remove: string[];
}

/** One computer's summaries changed: `device` names a paired host's (absent = the computer the view belongs to). */
export interface SummariesChanged {
	device?: string;
	/** What changed, or the whole set (a host's after its link came up, or a change the sender could not diff). */
	change: SummaryDelta | VersionedSummaries;
}

/** Whether version `a` comes before `b` of the same run; versions of two runs are never compared. */
export function olderSummaryVersion(a: string, b: string): boolean {
	const [epochA, nA] = a.split(".");
	const [epochB, nB] = b.split(".");
	return epochA === epochB && Number(nA) < Number(nB);
}

/**
 * The copy a receiver holds after `change`: the whole set as given, a delta applied on the version it was made from,
 * else null (a delta on another version: the receiver missed a change and reads the whole set again).
 */
export function applySummaryChange(
	held: VersionedSummaries | null,
	change: SummaryDelta | VersionedSummaries,
): VersionedSummaries | null {
	if ("sessions" in change) return held && olderSummaryVersion(change.version, held.version) ? held : change;
	if (!held || held.version !== change.base) return null;
	const byPath = new Map(held.sessions.map(session => [session.sessionPath, session]));
	for (const path of change.remove) byPath.delete(path);
	for (const session of change.set) byPath.set(session.sessionPath, session);
	return { version: change.version, sessions: [...byPath.values()] };
}

/** What turns `before` into `after`; null when they hold the same summaries. */
export function diffSummaries(
	before: readonly SessionSummary[],
	after: readonly SessionSummary[],
): Pick<SummaryDelta, "set" | "remove"> | null {
	const old = new Map(before.map(session => [session.sessionPath, JSON.stringify(session)]));
	const set: SessionSummary[] = [];
	for (const session of after) {
		const prior = old.get(session.sessionPath);
		old.delete(session.sessionPath);
		if (prior !== JSON.stringify(session)) set.push(session);
	}
	const remove = [...old.keys()];
	return set.length === 0 && remove.length === 0 ? null : { set, remove };
}

/** A summary's subagent as the roster rows read one (`SubagentSnapshot`): its label stands in the description. */
export function summaryAgentSnapshot(agent: SummaryAgent): SubagentSnapshot {
	return {
		id: agent.id,
		index: agent.index,
		agent: agent.agent,
		...(agent.agentSource ? { agentSource: agent.agentSource } : {}),
		...(agent.title ? { description: agent.title } : {}),
		status: agent.status,
		lastUpdate: agent.startedAt,
		...(agent.parentToolCallId ? { parentToolCallId: agent.parentToolCallId } : {}),
		...(agent.parentSubagentId ? { parentSubagentId: agent.parentSubagentId } : {}),
		...(agent.kind ? { kind: agent.kind } : {}),
		...(agent.sessionFile ? { sessionFile: agent.sessionFile } : {}),
	};
}

/** The subagents of a summary that run now (not waiting, not failed): the row's filled pill. */
export function runningAgentCount(summary: Pick<SessionSummary, "agents"> | undefined): number {
	let count = 0;
	for (const agent of summary?.agents ?? []) if (RUNNING[agent.status]) count++;
	return count;
}

const RUNNING: Record<string, true> = { started: true, running: true, pending: true };
