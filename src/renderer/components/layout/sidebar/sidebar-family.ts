/**
 * A session's family in the sidebar: the subagents it spawned and the sessions its agent opened
 * (`ompdesk_session_open`, in a worktree or not), shown together under its row as one compact group.
 * Pure rules here; the rows and the disclosure are `SidebarSubagents.tsx`, the look `styles/sidebar.css`.
 */

import type { CostSplit } from "../../../../shared/agent-control";
import type { SubagentSnapshot } from "../../../../shared/rpc-types";
import { isLiveSubagentStatus } from "../../panels/subagent-graph";

/** What a child is: a subagent of the session, a session opened in a worktree, or a plain opened session. */
export type FamilyKind = "subagent" | "worktree" | "session";

/** One status token for every kind of child: running pulse, waiting ⚠, done ✓, failed ✕, ready to merge, or paused/nothing. */
export type FamilyState = "running" | "waiting" | "done" | "failed" | "unmerged" | "idle";

/**
 * What an opened session is, as ONE status: the row's token, the fold rule and the chip's counts all read it. `failed`
 * is an error or stopped ending; `unmerged` is a clean finish whose branch still holds work nothing merged (ready to
 * merge, never a failure).
 */
export type ChildStatus = "running" | "waiting" | "done" | "failed" | "unmerged";

/** The facts a status is derived from (the sidebar reads them off the tab, the session list and the review queue). */
export interface ChildFacts {
	/** A question or approval waits for the person. */
	waiting: boolean;
	/** A turn, a background task or a subagent runs. */
	running: boolean;
	/** It has finished a turn with an answer (or is a stored session whose work is done). */
	finished: boolean;
	/** Its last turn ended in an error or was stopped. */
	failed: boolean;
	/** Its branch holds commits nothing merged, or uncommitted work. */
	unmerged: boolean;
}

/** First rule that holds wins. A session that has not run (merely open) has no status. */
const CHILD_STATUS_RULES: ReadonlyArray<readonly [when: (facts: ChildFacts) => boolean, status: ChildStatus]> = [
	[facts => facts.waiting, "waiting"],
	[facts => facts.running, "running"],
	[facts => facts.finished && facts.failed, "failed"],
	[facts => facts.finished && facts.unmerged, "unmerged"],
	[facts => facts.finished, "done"],
];

export function openedChildStatus(facts: ChildFacts): ChildStatus | null {
	return CHILD_STATUS_RULES.find(([when]) => when(facts))?.[1] ?? null;
}

/** The token each status shows: failed is the red ✕; unmerged work is the neutral ready-to-merge mark. */
export const CHILD_TOKEN: Readonly<Record<ChildStatus, FamilyState>> = {
	running: "running",
	waiting: "waiting",
	done: "done",
	failed: "failed",
	unmerged: "unmerged",
};

/** A subagent's status as the one token a row shows. `stale` (registered, no turn) needs a look like a wait does. */
export function subagentFamilyState(status: string): FamilyState {
	switch (status) {
		case "started":
		case "running":
		case "pending":
			return "running";
		case "parked":
		case "idle":
			return "idle";
		case "stale":
			return "waiting";
		case "failed":
			return "failed";
		default:
			return "done";
	}
}

/**
 * Finished and uneventful: the family never lists these (they stay in the session's own Subagent panel and work board).
 * A failed or stale agent stays a row, because someone has to look at it.
 */
export function isFoldedSubagent(status: string): boolean {
	return status === "completed" || status === "aborted" || status === "cancelled";
}

/**
 * Whether an opened session shows in its opener's family: everything but a finished one that landed clean. Running,
 * waiting, failed and unmerged/dirty ones show, and so does one that has not run yet (no status).
 */
export function isShownOpened(child: { status: ChildStatus | null }): boolean {
	return child.status !== "done";
}

export interface SubagentRowModel {
	agent: SubagentSnapshot;
	/** 0 = spawned by the session, 1 = spawned by a subagent (deeper clamps to 1). */
	depth: 0 | 1;
}

export interface SubagentFamilyRows {
	/** Live, failed and stale agents as a pre-order spawn tree in spawn order. Finished agents are not listed. */
	rows: SubagentRowModel[];
}

/**
 * The rows of a roster: finished agents (see `isFoldedSubagent`) are left out. Parent of a row: the explicit wire link,
 * else the agent whose transcript owns the spawning `task` call; a parent that is not shown, unresolved or cyclic makes
 * the agent a top-level spawn of the session.
 */
export function buildSubagentFamilyRows(
	subagents: ReadonlyMap<string, SubagentSnapshot>,
	toolCallOwners: ReadonlyMap<string, string>,
): SubagentFamilyRows {
	const shown = new Map<string, SubagentSnapshot>();
	for (const agent of subagents.values()) if (!isFoldedSubagent(agent.status)) shown.set(agent.id, agent);
	const agents = [...shown.values()].sort((a, b) => a.index - b.index);
	const children = new Map<string, SubagentSnapshot[]>();
	const roots: SubagentSnapshot[] = [];
	for (const agent of agents) {
		const linked = agent.parentSubagentId;
		const owner = agent.parentToolCallId ? toolCallOwners.get(agent.parentToolCallId) : undefined;
		const parentId =
			linked && linked !== agent.id && shown.has(linked)
				? linked
				: owner && owner !== agent.id && shown.has(owner)
					? owner
					: undefined;
		if (!parentId) {
			roots.push(agent);
			continue;
		}
		const siblings = children.get(parentId);
		if (siblings) siblings.push(agent);
		else children.set(parentId, [agent]);
	}

	const rows: SubagentRowModel[] = [];
	const visited = new Set<string>();
	const visit = (agent: SubagentSnapshot, level: number) => {
		if (visited.has(agent.id)) return;
		visited.add(agent.id);
		rows.push({ agent, depth: level === 0 ? 0 : 1 });
		for (const child of children.get(agent.id) ?? []) visit(child, level + 1);
	};
	for (const root of roots) visit(root, 0);
	// A parent cycle leaves members unreached from any root: show them flat.
	for (const agent of agents) visit(agent, 0);
	return { rows };
}

export interface FamilyCounts {
	/** Subagents of the session that show (finished ones are not listed, so not counted). */
	agents: number;
	/** Sessions its agent opened that show. */
	sessions: number;
	/** Children at work right now. */
	running: number;
	/** Children waiting for the person (an answer or approval, a stale registration): the chip's warning tint. */
	waiting: number;
}

/**
 * The summary the chip shows, for a roster and the opened sessions that show (`isShownOpened` already applied). Only
 * subagents that show count: a finished one is not listed anywhere in the family, so it is not in the chip either.
 */
export function familyCounts(
	subagents: Iterable<SubagentSnapshot>,
	opened: readonly { state: FamilyState }[],
	includeAgents = true,
): FamilyCounts {
	const counts: FamilyCounts = { agents: 0, sessions: opened.length, running: 0, waiting: 0 };
	const tally = (state: FamilyState) => {
		if (state === "running") counts.running++;
		if (state === "waiting") counts.waiting++;
	};
	if (includeAgents)
		for (const agent of subagents) {
			if (isFoldedSubagent(agent.status)) continue;
			counts.agents++;
			tally(subagentFamilyState(agent.status));
		}
	for (const child of opened) tally(child.state);
	return counts;
}

/** What a child ran on and what it has cost (USD), as far as stock has said; any field may be missing. */
export interface ChildUsage {
	/** `provider/id` stock resolved, else the requested model or role. */
	model?: string;
	/** The model role a subagent's model came from (`@task` → "task"); sessions have none. */
	role?: string;
	cost?: number;
	/** `cost` split by billing on the host that ran it (an opened session's, from main's push). */
	split?: CostSplit;
}

/** The tooltip line a child's model and role read as ("anthropic/claude-x · @task"); "" when unknown. */
export function childUsageText(model?: string, role?: string): string {
	return [model, role && `@${role}`].filter(Boolean).join(" · ");
}

/** Live subagents in a roster. */
export function countLiveSubagents(subagents: ReadonlyMap<string, SubagentSnapshot>): number {
	let count = 0;
	for (const agent of subagents.values()) if (isLiveSubagentStatus(agent.status)) count++;
	return count;
}
