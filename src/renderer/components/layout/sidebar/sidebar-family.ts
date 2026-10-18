/**
 * A session's family in the sidebar: the subagents it spawned and the sessions its agent opened
 * (`ompdesk_session_open`, in a worktree or not), shown together under its row as one compact group.
 * Pure rules here; the rows and the disclosure are `SidebarSubagents.tsx`, the look `styles/sidebar.css`.
 */

import type { SubagentSnapshot } from "../../../../shared/rpc-types";
import { isLiveSubagentStatus } from "../../panels/subagent-graph";

/** What a child is: a subagent of the session, a session opened in a worktree, or a plain opened session. */
export type FamilyKind = "subagent" | "worktree" | "session";

/** One status token for every kind of child: running pulse, waiting ⚠, done ✓, failed ✕, or paused/nothing. */
export type FamilyState = "running" | "waiting" | "done" | "failed" | "idle";

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
 * Finished and uneventful: these fold into the group's "n done" row. A failed or stale agent stays a row of its own,
 * because someone has to look at it.
 */
export function isFoldedSubagent(status: string): boolean {
	return status === "completed" || status === "aborted" || status === "cancelled";
}

/** A state that keeps the family open: something runs, or something waits for the person. */
export function isActiveFamilyState(state: FamilyState): boolean {
	return state === "running" || state === "waiting";
}

export interface SubagentRowModel {
	agent: SubagentSnapshot;
	/** 0 = spawned by the session, 1 = spawned by a subagent (deeper clamps to 1). */
	depth: 0 | 1;
}

export interface SubagentFamilyRows {
	/** Live, failed and stale agents as a pre-order spawn tree in spawn order. */
	rows: SubagentRowModel[];
	/** Finished agents (see `isFoldedSubagent`), in spawn order, behind the "n done" row. */
	done: SubagentSnapshot[];
}

/**
 * Split a roster into the rows that show and the finished ones that fold. Parent of a row: the explicit wire link, else
 * the agent whose transcript owns the spawning `task` call; a parent that is not shown, unresolved or cyclic makes the
 * agent a top-level spawn of the session.
 */
export function buildSubagentFamilyRows(
	subagents: ReadonlyMap<string, SubagentSnapshot>,
	toolCallOwners: ReadonlyMap<string, string>,
): SubagentFamilyRows {
	const shown = new Map<string, SubagentSnapshot>();
	const done: SubagentSnapshot[] = [];
	for (const agent of subagents.values()) {
		if (isFoldedSubagent(agent.status)) done.push(agent);
		else shown.set(agent.id, agent);
	}
	done.sort((a, b) => a.index - b.index);
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
	return { rows, done };
}

export interface FamilyCounts {
	/** Subagents of the session (finished ones included). */
	agents: number;
	/** Sessions its agent opened. */
	sessions: number;
	/** Children at work right now. */
	running: number;
	/** Children at work or waiting for the person: what keeps the family open. */
	active: number;
}

/** The summary the chip shows and the open/closed rule reads, for a roster and the opened sessions. */
export function familyCounts(
	subagents: Iterable<SubagentSnapshot>,
	opened: readonly { state: FamilyState }[],
	includeAgents = true,
): FamilyCounts {
	const counts: FamilyCounts = { agents: 0, sessions: opened.length, running: 0, active: 0 };
	const tally = (state: FamilyState) => {
		if (state === "running") counts.running++;
		if (isActiveFamilyState(state)) counts.active++;
	};
	if (includeAgents)
		for (const agent of subagents) {
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
}

/**
 * Which session each opened session nests under: child session path → the path of the session that started the chain.
 * A tab names its opener by tab id while both live, and by the opener's session file after a relaunch (every tab id is
 * new then). Whatever its folder or worktree, an opened session goes under its opener; one opened by an opened session
 * goes under the first of them, so the family is one level deep. A session whose opener is not in the list (closed, or
 * in another lane) is not nested, and a cycle nests nothing.
 */
export function openerOfSessions(tabs: readonly FamilyTab[], sessions: readonly FamilySession[]): Map<string, string> {
	const tabOf = (session: FamilySession): FamilyTab | undefined =>
		(session.liveTabId ? tabs.find(tab => tab.id === session.liveTabId) : undefined) ??
		tabs.find(tab => tab.sessionPath !== undefined && tab.sessionPath === session.path) ??
		tabs.find(tab => tab.sessionId !== undefined && tab.sessionId === session.id);
	const sessionOf = new Map<string, FamilySession>();
	for (const session of sessions) {
		const tab = tabOf(session);
		if (tab && !sessionOf.has(tab.id)) sessionOf.set(tab.id, session);
	}
	const direct = new Map<string, string>();
	for (const tab of tabs) {
		const child = sessionOf.get(tab.id);
		if (!child) continue;
		const opener =
			(tab.openedBy ? tabs.find(entry => entry.id === tab.openedBy) : undefined) ??
			(tab.openedBySession ? tabs.find(entry => entry.sessionPath === tab.openedBySession) : undefined);
		const parent = opener && opener.id !== tab.id ? sessionOf.get(opener.id) : undefined;
		if (parent && parent.path !== child.path) direct.set(child.path, parent.path);
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
