/**
 * The one builder of this computer's session summaries (`shared/session-summary.ts`): what every session row shows of
 * a session this computer runs, on every view of it (this computer's windows and phone pages, every paired computer,
 * `ompdesk_sessions`). Built here from facts main holds anyway: each running tab's status, run, asks and title (its
 * pool entry, or the tab `LocalHostServices` runs for a paired device), and its subagents, which main follows itself
 * from the `subagent_*` frames every omp writes over stdio (the pool keeps each omp's stream at `progress` at least),
 * so nothing a view missed can leave a row behind. A new omp's roster starts empty and is read once when it is ready
 * (subagents a restart revived before it was asked for frames).
 *
 * The summaries are numbered like the session list (`SessionListShare`): `current()` is the whole set at a version,
 * and each change is published once per burst as what changed from the last version.
 */
import { randomUUID } from "node:crypto";
import {
	assignmentHeadline,
	assignmentTitle,
	stripTitlePrefix,
	unwrapStockPrompt,
} from "../../resources/gui-bridge/modes/subagent-title-contracts";
import { asyncResultJobs } from "../shared/async-results";
import { RESTART_NOTES, restartCuts } from "../shared/restart-cuts";
import type { AgentMessage, AgentSessionEvent, SubagentFrame, SubagentSnapshot } from "../shared/rpc-types";
import {
	diffSummaries,
	type SessionSummary,
	type SummaryAgent,
	type SummaryDelta,
	type VersionedSummaries,
} from "../shared/session-summary";
import type { SidecarLike } from "./sidecar-types";

/** A session this computer runs, as its owner (the pool, the host services) knows it right now. */
export type SummaryFacts = Omit<SessionSummary, "agents">;

/** What the builder needs of a running tab's omp: its events and its RPC. */
export type SummarySidecar = Pick<SidecarLike, "on" | "rpcClient">;

/** A tab whose session the builder summarizes: its facts now and the omp its subagents run in. */
export interface SummarySource {
	sidecar: SummarySidecar;
	facts(): SummaryFacts | null;
}

/** How long a burst of changes is gathered before one change goes out. */
export const SUMMARY_DEBOUNCE_MS = 120;

/** Statuses a row never lists: the agent finished. */
const FINISHED: Record<string, true> = { completed: true, aborted: true, cancelled: true };

interface RosterAgent extends SummaryAgent {
	/** The original assignment, kept for the label: a later run's frame no longer carries it. */
	assignment?: string;
	description?: string;
}

/** One omp's subagents that a row lists, from its frames; finished ones leave. */
class Roster {
	readonly agents = new Map<string, RosterAgent>();
	/**
	 * The restart notes this omp's session wrote and the task deliveries of the agents they name (custom messages): the
	 * one restart-cut rule (`shared/restart-cuts.ts`) reads them, so an agent whose run a restart ended (a revived
	 * subagent that ended at once with stock's empty-message warning) is no row, while any other failure stays one. A
	 * delivery of an agent no note named never changes what the rule says, so it is not kept.
	 */
	#notes: AgentMessage[] = [];
	#named = new Set<string>();
	#cut: ReadonlyMap<string, unknown> = new Map();

	clear(): void {
		this.agents.clear();
		this.#notes = [];
		this.#named = new Set();
		this.#cut = new Map();
	}

	/** A batch of the session's events: the custom messages the restart-cut rule reads. Whether a row changed. */
	events(events: readonly AgentSessionEvent[]): boolean {
		let kept = false;
		for (const event of events) {
			if (event.type !== "message_end" || event.message.role !== "custom") continue;
			const message = event.message;
			if (RESTART_NOTES.has(message.customType)) {
				const subagents = (message.details as { subagents?: unknown } | undefined)?.subagents;
				for (const row of Array.isArray(subagents) ? subagents : [])
					if (typeof row?.id === "string") this.#named.add(row.id);
			} else if (
				message.customType !== "async-result" ||
				!asyncResultJobs(message).some(
					job => this.#named.has(job.agentId ?? "") || this.#named.has(job.jobId ?? ""),
				)
			)
				continue;
			this.#notes = [...this.#notes, message];
			kept = true;
		}
		if (kept) this.#cut = restartCuts(this.#notes).agents;
		return kept;
	}

	frame(frame: SubagentFrame, now: number): boolean {
		if (frame.type === "subagent_event") return false;
		if (frame.type === "subagent_lifecycle") {
			const p = frame.payload;
			const status = p.status === "started" ? "running" : p.status;
			return this.#put(p.id, status, now, existing => ({
				...existing,
				index: p.index,
				agent: p.agent,
				agentSource: p.agentSource,
				description: p.description ?? existing?.description,
				parentToolCallId: p.parentToolCallId ?? existing?.parentToolCallId,
				parentSubagentId: p.parentSubagentId ?? existing?.parentSubagentId,
				sessionFile: p.sessionFile ?? existing?.sessionFile,
			}));
		}
		const p = frame.payload;
		const progress = p.progress;
		if (!progress?.id) return false;
		return this.#put(progress.id, progress.status, now, existing => ({
			index: p.index,
			agent: p.agent,
			agentSource: p.agentSource,
			assignment: p.assignment ?? existing?.assignment ?? unwrapStockPrompt(p.task),
			description: progress.description ?? existing?.description,
			parentToolCallId: p.parentToolCallId ?? existing?.parentToolCallId,
			parentSubagentId: p.parentSubagentId ?? existing?.parentSubagentId,
			sessionFile: p.sessionFile ?? existing?.sessionFile,
			model: progress.resolvedModel ?? existing?.model,
			role: progress.modelRole ?? existing?.role,
			step: progress.lastIntent ?? progress.currentTool,
			tokens: progress.tokens,
			toolCount: progress.toolCount,
		}));
	}

	/**
	 * A new omp's registry as it becomes ready (`get_subagents`): the agents it revived before anyone asked it for
	 * frames. Merged over what frames said since it started (the roster was emptied then).
	 */
	snapshot(rows: readonly SubagentSnapshot[], now: number): void {
		for (const row of rows) {
			const status = row.status === "running" && row.live === false ? "stale" : row.status;
			this.#put(row.id, status, row.lastUpdate || now, () => ({
				index: row.index,
				agent: row.agent,
				agentSource: row.agentSource,
				assignment: row.assignment ?? unwrapStockPrompt(row.task),
				description: row.description,
				parentToolCallId: row.parentToolCallId,
				parentSubagentId: row.parentSubagentId,
				sessionFile: row.sessionFile,
				kind: row.kind,
				model: row.progress?.resolvedModel,
				role: row.progress?.modelRole,
				step: row.progress?.lastIntent ?? row.progress?.currentTool,
				tokens: row.progress?.tokens,
				toolCount: row.progress?.toolCount,
			}));
		}
	}

	#put(
		id: string,
		status: string,
		now: number,
		fields: (existing: RosterAgent | undefined) => Omit<RosterAgent, "id" | "status" | "startedAt" | "title">,
	): boolean {
		const existing = this.agents.get(id);
		if (FINISHED[status]) return this.agents.delete(id);
		const next = fields(existing);
		const startedAt = existing && existing.status === status ? existing.startedAt : (existing?.startedAt ?? now);
		this.agents.set(id, {
			...next,
			id,
			status,
			startedAt,
			// The row's label by the roster's rule (`subagentPrimaryLabel`): the assignment's title line first.
			title:
				assignmentTitle(next.assignment) ??
				(next.description ? stripTitlePrefix(next.description) : undefined) ??
				assignmentHeadline(next.assignment),
		});
		return true;
	}

	list(): SummaryAgent[] {
		return [...this.agents.values()].flatMap(({ assignment: _a, description: _d, ...agent }) => {
			// A run a restart ended is no failure of the agent's own: not listed, like a stopped one.
			if (agent.status === "failed" && this.#cut.has(agent.id)) return [];
			const out: SummaryAgent = { ...agent };
			for (const key of Object.keys(out) as (keyof SummaryAgent)[]) if (out[key] === undefined) delete out[key];
			return [out];
		});
	}
}

interface Timers {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	now(): number;
}

const REAL_TIMERS: Timers = {
	setTimeout: (fn, ms) => {
		const handle = setTimeout(fn, ms);
		handle.unref?.();
		return handle;
	},
	clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
	now: () => Date.now(),
};

export class SessionSummaries {
	readonly #sources: () => Iterable<SummarySource>;
	readonly #timers: Timers;
	readonly #rosters = new WeakMap<SummarySidecar, Roster>();
	readonly #epoch = randomUUID().slice(0, 8);
	#next = 0;
	#copy: VersionedSummaries | null = null;
	#timer: unknown = null;

	readonly #listeners = new Set<(delta: SummaryDelta) => void>();

	/** Hear each change: what turns the last version into this one. Returns the unsubscribe. */
	onChange(listener: (delta: SummaryDelta) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	constructor(sources: () => Iterable<SummarySource>, timers: Timers = REAL_TIMERS) {
		this.#sources = sources;
		this.#timers = timers;
	}

	/**
	 * Follow a tab's omp for as long as it lives (call once, when the tab gets it): its frames and statuses keep the
	 * summaries current. Its subagents start over with each omp it starts and are read once as it becomes ready.
	 */
	track(sidecar: SummarySidecar): void {
		if (this.#rosters.has(sidecar)) return;
		const roster = new Roster();
		this.#rosters.set(sidecar, roster);
		sidecar.on("subagentFrame", (frame: SubagentFrame) => {
			if (roster.frame(frame, this.#timers.now())) this.changed();
		});
		sidecar.on("status", (payload: { status?: string } | undefined) => {
			// A new omp knows nothing of the last one's subagents: they died with it.
			if (payload?.status === "starting" || payload?.status === "restarting" || payload?.status === "exited") {
				roster.clear();
			} else if (payload?.status === "ready") {
				void this.#readRoster(sidecar, roster);
			}
			this.changed();
		});
		sidecar.on("events", (events: AgentSessionEvent[]) => {
			if (Array.isArray(events)) roster.events(events);
			this.changed();
		});
		sidecar.on("frame", () => this.changed());
	}

	async #readRoster(sidecar: SummarySidecar, roster: Roster): Promise<void> {
		try {
			const answer = await sidecar.rpcClient?.command({ type: "get_subagents" });
			if (!answer?.success) return;
			const rows = (answer.data as { subagents?: SubagentSnapshot[] } | undefined)?.subagents;
			if (!Array.isArray(rows)) return;
			roster.snapshot(rows, this.#timers.now());
			this.changed();
		} catch {
			// The omp went away again: its next start reads again.
		}
	}

	/** Something a summary says may have changed: one change goes out once the burst settles. */
	changed(): void {
		if (this.#timer !== null) return;
		this.#timer = this.#timers.setTimeout(() => {
			this.#timer = null;
			this.#publish();
		}, SUMMARY_DEBOUNCE_MS);
	}

	/** Every summary at the latest version (a change still gathering is taken in first). */
	current(): VersionedSummaries {
		if (this.#timer !== null) {
			this.#timers.clearTimeout(this.#timer);
			this.#timer = null;
		}
		this.#publish();
		return this.#copy ?? { version: `${this.#epoch}.0`, sessions: [] };
	}

	#build(): SessionSummary[] {
		const sessions = new Map<string, SessionSummary>();
		for (const source of this.#sources()) {
			const facts = source.facts();
			if (!facts) continue;
			const agents = this.#rosters.get(source.sidecar)?.list() ?? [];
			// One file, one row: a tab that waits outranks one that runs, which outranks an idle one.
			const prior = sessions.get(facts.sessionPath);
			const summary: SessionSummary = { ...facts, agents };
			if (!prior || rank(summary) > rank(prior)) sessions.set(facts.sessionPath, summary);
		}
		return [...sessions.values()].sort((a, b) => (a.sessionPath < b.sessionPath ? -1 : 1));
	}

	#publish(): void {
		const sessions = this.#build();
		const before = this.#copy;
		const delta = before ? diffSummaries(before.sessions, sessions) : null;
		if (before && !delta) return;
		const version = `${this.#epoch}.${++this.#next}`;
		this.#copy = { version, sessions };
		if (before && delta)
			for (const listener of this.#listeners) listener({ base: before.version, version, ...delta });
	}
}

function rank(summary: SessionSummary): number {
	return summary.ask ? 3 : summary.status === "running" ? 2 : 1;
}
