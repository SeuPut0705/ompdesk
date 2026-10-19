/**
 * A session's family in the sidebar: the subagents it spawned and the sessions its agent opened
 * (`ompdesk_session_open`, in a worktree or not), shown together under its row as one compact group.
 * Pure rules here; the rows and the disclosure are `SidebarSubagents.tsx`, the look `styles/sidebar.css`.
 */

import { agentMessageSender } from "../../../../shared/agent-control";
import type { SubagentSnapshot } from "../../../../shared/rpc-types";
import { isLiveSubagentStatus } from "../../panels/subagent-graph";

/** What a child is: a subagent of the session, a session opened in a worktree, or a plain opened session. */
export type FamilyKind = "subagent" | "worktree" | "session";

/** One status token for every kind of child: running pulse, waiting ⚠, done ✓, failed ✕, or paused/nothing. */
export type FamilyState = "running" | "waiting" | "done" | "failed" | "idle";

/** What an opened session is, as ONE status: the row's token, the fold rule and the chip's counts all read it. */
export type ChildStatus = "running" | "waiting" | "done" | "problem";

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
	[facts => facts.finished && (facts.failed || facts.unmerged), "problem"],
	[facts => facts.finished, "done"],
];

export function openedChildStatus(facts: ChildFacts): ChildStatus | null {
	return CHILD_STATUS_RULES.find(([when]) => when(facts))?.[1] ?? null;
}

/** The token each status shows: a problem is the failed ✕ (an error ending, or work that has not landed). */
export const CHILD_TOKEN: Readonly<Record<ChildStatus, FamilyState>> = {
	running: "running",
	waiting: "waiting",
	done: "done",
	problem: "failed",
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
 * waiting, failed and unmerged/dirty ones (status `problem`) show, and so does one that has not run yet (no status).
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

/** Live subagents in a roster. */
export function countLiveSubagents(subagents: ReadonlyMap<string, SubagentSnapshot>): number {
	let count = 0;
	for (const agent of subagents.values()) if (isLiveSubagentStatus(agent.status)) count++;
	return count;
}

/** The tab fields the opener rule reads. */
export interface FamilyTab {
	id: string;
	sessionPath?: string;
	sessionId?: string;
	openedBy?: string;
	openedBySession?: string;
}

/** The session fields the opener rule reads. */
export interface FamilySession {
	path: string;
	id: string;
	liveTabId?: string;
	/** What its row reads: the sender title of an agent's brief names it. */
	title?: string;
	/** The indexed first prompt: an `<ompdesk-agent-message>` brief marks a session an agent opened. */
	firstMessage?: string;
	/** Stock's `created`: an opener is older than what it opened. */
	created?: string;
}

/**
 * The session a legacy child (opened before provenance was kept: no tab link, no closed record) names as its sender in
 * the brief its first message holds: the newest session titled so that existed when the child was made. Null for a
 * person's own prompt, a brief without a sender, or a sender nobody here is titled as.
 */
function briefOpenerOf(child: FamilySession, sessions: readonly FamilySession[]): FamilySession | null {
	const from = (agentMessageSender(child.firstMessage ?? "") ?? "").replaceAll(/\s+/g, " ").trim();
	if (!from) return null;
	const born = Date.parse(child.created ?? "");
	let best: FamilySession | null = null;
	let bestMade = Number.NEGATIVE_INFINITY;
	for (const candidate of sessions) {
		if (candidate.path === child.path || (candidate.title ?? "").replaceAll(/\s+/g, " ").trim() !== from) continue;
		const made = Date.parse(candidate.created ?? "");
		if (made > born) continue;
		const rank = Number.isNaN(made) ? Number.NEGATIVE_INFINITY : made;
		if (!best || rank > bestMade) {
			best = candidate;
			bestMade = rank;
		}
	}
	return best;
}

/**
 * Which session each opened session nests under: child session path → the path of the session that started the chain.
 * A tab names its opener by tab id while both live, and by the opener's session file after a relaunch (every tab id is
 * new then, and the opener needs no tab: its stored session is enough). A session without a tab (main closed it after
 * its work landed, or the person closed it) is found by the record naming the opener's file, else, for one opened
 * before either was kept, by the sender its first message's agent brief names. Whatever its folder or worktree, an
 * opened session goes under its opener; one opened by an opened session goes under the first of them, so the family
 * is one level deep. A session whose opener is not in the list (deleted, or in another lane) is not nested, and a
 * cycle nests nothing.
 */
export function openerOfSessions(
	tabs: readonly FamilyTab[],
	sessions: readonly FamilySession[],
	closedOpeners: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
	const tabOf = (session: FamilySession): FamilyTab | undefined =>
		(session.liveTabId ? tabs.find(tab => tab.id === session.liveTabId) : undefined) ??
		tabs.find(tab => tab.sessionPath !== undefined && tab.sessionPath === session.path) ??
		tabs.find(tab => tab.sessionId !== undefined && tab.sessionId === session.id);
	const sessionOf = new Map<string, FamilySession>();
	for (const session of sessions) {
		const tab = tabOf(session);
		if (tab && !sessionOf.has(tab.id)) sessionOf.set(tab.id, session);
	}
	const known = new Set(sessions.map(session => session.path));
	const direct = new Map<string, string>();
	for (const tab of tabs) {
		const child = sessionOf.get(tab.id);
		if (!child) continue;
		const opener =
			(tab.openedBy ? tabs.find(entry => entry.id === tab.openedBy) : undefined) ??
			(tab.openedBySession ? tabs.find(entry => entry.sessionPath === tab.openedBySession) : undefined);
		const parent = opener && opener.id !== tab.id ? sessionOf.get(opener.id)?.path : undefined;
		const path = parent ?? (tab.openedBySession && known.has(tab.openedBySession) ? tab.openedBySession : undefined);
		if (path && path !== child.path) direct.set(child.path, path);
	}
	for (const session of sessions) {
		if (direct.has(session.path)) continue;
		const opener = closedOpeners.get(session.path);
		if (opener && opener !== session.path && known.has(opener)) {
			direct.set(session.path, opener);
			continue;
		}
		const sender = briefOpenerOf(session, sessions);
		if (sender) direct.set(session.path, sender.path);
	}
	const roots = new Map<string, string>();
	for (const child of direct.keys()) {
		const seen = new Set([child]);
		let root = direct.get(child);
		while (root && direct.has(root) && !seen.has(root)) {
			seen.add(root);
			root = direct.get(root);
		}
		if (root && !seen.has(root)) roots.set(child, root);
	}
	return roots;
}
