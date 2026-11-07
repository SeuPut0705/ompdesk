/**
 * The dev harness's session summaries (`shared/session-summary.ts`): main's own `SessionSummaries` builder over fixture
 * tabs, so the sidebar's rows, chips and working cues render what the app builds, not a copy of its rules. Each tab is
 * a source the way the pool's tabs are: its facts (status, ask, settling, ...) and a small fake omp whose events the
 * builder follows (`subagentFrame`, `status`) and whose registry it reads once per start (`get_subagents`).
 *
 * `window.__harness.summaries` is how a spec or a page plays what the pool and stock do: set a tab's facts, write a
 * stock `subagent_*` frame to a tab's omp, restart its omp over a registry.
 */

import {
	SessionSummaries,
	type SummaryFacts,
	type SummarySidecar,
	type SummarySource,
} from "../../main/session-summaries";
import type {
	AgentProgress,
	RpcCommand,
	RpcResponse,
	SubagentFrame,
	SubagentLifecyclePayload,
	SubagentSnapshot,
} from "../../shared/rpc-types";
import { type SummaryDelta, unsavedSessionKey, type VersionedSummaries } from "../../shared/session-summary";
import { PROJECT, tabsFixture } from "./fixture";
import { BOARD_BUSY, BOARD_FAMILY } from "./fixture-board";

export interface HarnessSummaries {
	/**
	 * A tab's facts as its owner (the pool) knows them: the given ones over what it had (a new tab starts as an idle
	 * agent tab with no session file yet, summarized under `unsavedSessionKey`); a key set to `undefined` is dropped
	 * (a prompt answered); `null` closes the tab.
	 */
	tab(tabId: string, facts: Partial<SummaryFacts> | null): void;
	/** One frame stock's omp writes to a tab's stdio (`subagent_lifecycle`, `subagent_progress`). */
	frame(tabId: string, frame: SubagentFrame): void;
	/**
	 * Stock's `subagent_progress` for an agent of a tab: `task` is the prompt it was sent (the wrapped assignment, or a
	 * follow-up message's text), `assignment` the original one a first run carries and a later run does not.
	 */
	progress(tabId: string, agent: HarnessSubagent): void;
	/** Stock's `subagent_lifecycle` for an agent of a tab: it started, or its run ended. */
	lifecycle(tabId: string, agent: Pick<SubagentLifecyclePayload, "id" | "index" | "status" | "description">): void;
	/** A tab's omp starts again with `registry` as its subagents (what `get_subagents` answers once it is ready). */
	restart(tabId: string, registry: SubagentSnapshot[]): void;
	/** Every summary now, as `window.omp.sessions.summaries()` reads them. */
	current(): VersionedSummaries;
}

export interface HarnessSummariesOptions {
	/** The subagents a tab's omp holds when it starts. */
	subagentsOf(tabId: string): SubagentSnapshot[];
	/** A change out of the builder, to push to the page (`SESSION_SUMMARIES_CHANGED`). */
	onChange(change: SummaryDelta): void;
}

/** A subagent of a tab as stock's progress frame carries it. */
export interface HarnessSubagent {
	id: string;
	index: number;
	/** Default `running`. */
	status?: AgentProgress["status"];
	task?: string;
	assignment?: string;
	sessionFile?: string;
}

type Listener = (...args: unknown[]) => void;

/** What the builder uses of a tab's omp: its events and its RPC. */
class FakeOmp {
	readonly #listeners = new Map<string, Set<Listener>>();
	registry: SubagentSnapshot[];

	constructor(registry: SubagentSnapshot[]) {
		this.registry = registry;
	}

	readonly rpcClient = {
		command: async (command: RpcCommand): Promise<RpcResponse> => ({
			type: "response",
			command: command.type,
			success: true,
			data: command.type === "get_subagents" ? { subagents: this.registry } : {},
		}),
	};

	on(event: string, listener: Listener): this {
		const set = this.#listeners.get(event) ?? new Set<Listener>();
		set.add(listener);
		this.#listeners.set(event, set);
		return this;
	}

	emit(event: string, payload?: unknown): void {
		for (const listener of this.#listeners.get(event) ?? []) listener(payload);
	}
}

interface HarnessTab {
	omp: FakeOmp;
	facts: SummaryFacts;
	source: SummarySource;
}

const query = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();

/**
 * A page whose open session runs a turn: `?board=busy` (not its `&family=1` orchestrator, idle after its turn while the
 * sessions it opened work) and `?card=live` (a card whose test run is still going).
 */
const OPEN_TURN_RUNS = (BOARD_BUSY && !BOARD_FAMILY) || query.get("card") === "live";

export function createHarnessSummaries(options: HarnessSummariesOptions): HarnessSummaries {
	const tabs = new Map<string, HarnessTab>();
	const summaries = new SessionSummaries(() => [...tabs.values()].map(tab => tab.source));
	summaries.onChange(options.onChange);

	const open = (tabId: string, facts: SummaryFacts): HarnessTab => {
		const omp = new FakeOmp(options.subagentsOf(tabId));
		const tab: HarnessTab = {
			omp,
			facts,
			// The builder reads an omp's events and RPC; the fake has exactly those.
			source: { sidecar: omp as unknown as SummarySidecar, facts: () => tab.facts },
		};
		tabs.set(tabId, tab);
		summaries.track(tab.source.sidecar);
		omp.emit("status", { status: "ready" });
		return tab;
	};

	const defaults = (tabId: string): SummaryFacts => ({
		sessionPath: unsavedSessionKey(tabId),
		tabId,
		cwd: PROJECT,
		kind: "agent",
		status: "ready",
	});

	for (const info of tabsFixture()) {
		open(info.tabId, {
			...defaults(info.tabId),
			cwd: info.cwd,
			sessionPath: info.sessionPath ?? unsavedSessionKey(info.tabId),
			...(info.sessionId ? { sessionId: info.sessionId } : {}),
			...(info.title ? { title: info.title } : {}),
			...(OPEN_TURN_RUNS && info.tabId === "tab-1" ? { status: "running" as const } : {}),
		});
	}

	const frame = (tabId: string, subagentFrame: SubagentFrame) => {
		tabs.get(tabId)?.omp.emit("subagentFrame", subagentFrame);
	};

	return {
		tab(tabId, facts) {
			if (facts === null) {
				if (tabs.delete(tabId)) summaries.changed();
				return;
			}
			const existing = tabs.get(tabId);
			const next = Object.fromEntries(
				Object.entries({ ...(existing?.facts ?? defaults(tabId)), ...facts }).filter(
					([, value]) => value !== undefined,
				),
			) as unknown as SummaryFacts;
			if (existing) existing.facts = next;
			else open(tabId, next);
			summaries.changed();
		},
		frame,
		progress(tabId, agent) {
			const task = agent.task ?? agent.assignment ?? "";
			const status = agent.status ?? "running";
			frame(tabId, {
				type: "subagent_progress",
				payload: {
					index: agent.index,
					agent: "task",
					agentSource: "bundled",
					task,
					assignment: agent.assignment,
					detached: true,
					...(agent.sessionFile ? { sessionFile: agent.sessionFile } : {}),
					progress: {
						index: agent.index,
						id: agent.id,
						agent: "task",
						agentSource: "bundled",
						status,
						task,
						assignment: agent.assignment,
						recentTools: [],
						recentOutput: [],
						toolCount: 2,
						requests: 1,
						tokens: 1200,
						cost: 0,
						durationMs: 60_000,
					},
				},
			});
		},
		lifecycle(tabId, agent) {
			frame(tabId, {
				type: "subagent_lifecycle",
				payload: { ...agent, agent: "task", agentSource: "bundled", detached: true },
			});
		},
		restart(tabId, registry) {
			const tab = tabs.get(tabId);
			if (!tab) return;
			tab.omp.registry = registry;
			tab.omp.emit("status", { status: "restarting" });
			tab.omp.emit("status", { status: "ready" });
		},
		current: () => summaries.current(),
	};
}
