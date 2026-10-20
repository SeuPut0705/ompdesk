/**
 * Side panel › Work tree: every session of this window that has a family, as one tree each: the session, its
 * subagents, the sessions its agent opened (on this computer or a paired device) and their own subagents and opened
 * sessions, and last each opened session's worktree branch. Live rows and the ones that need a look are listed; what
 * finished goes in the family's one closed "finished" fold, so the person still sees what the fan-out did, on which
 * model and at what cost. Sessions a paired device runs on this computer that are at work are roots of their own.
 *
 * Pure: `WorkTreePanel` feeds it from the stores the sidebar and the work board already read (tabs, each tab's
 * subagent roster, main's review push, the closed-children list, the hosted sessions). Rows come out flat in pre-order
 * with a depth, so a long tree renders as one list.
 */

import type { Billing } from "../../../../../resources/gui-bridge/model-setup-contracts";
import type { AgentChildUsage, AgentReviewItem, ClosedChild } from "../../../../shared/agent-control";
import type { IpcHostedSession } from "../../../../shared/ipc-types";
import type { SubagentSnapshot } from "../../../../shared/rpc-types";
import { type CostKinds, costKinds, NO_COST } from "../../../lib/spend";
import type { SessionTab } from "../../../stores/tabs";
import {
	buildSubagentFamilyRows,
	CHILD_TOKEN,
	type ChildUsage,
	type FamilyKind,
	type FamilyState,
	isFoldedSubagent,
	subagentFamilyState,
} from "../../layout/sidebar/sidebar-family";
import { openedChildRows } from "../../layout/work-board/opened-children";
import { isLiveSubagentStatus, subagentPrimaryLabel } from "../subagent-graph";

/** A row of the tree: a session, a subagent, an opened session (plain or in a worktree), or a worktree's branch. */
export type WorkTreeKind = FamilyKind | "branch";

/** What opening a row does: focus a tab, show a subagent's transcript, or open a stored session. */
export type WorkTreeTarget =
	| { kind: "tab"; tabId: string }
	| { kind: "subagent"; tabId: string; agentId: string }
	| { kind: "stored"; sessionPath: string; cwd?: string };

export interface WorkTreeNode {
	key: string;
	kind: WorkTreeKind;
	title: string;
	/** Null: no token (a session merely open, a branch). */
	state: FamilyState | null;
	/** 0 = the family's session; each level of nesting one more. */
	depth: number;
	usage: ChildUsage;
	/** The paired device it runs on, by name. */
	device?: string;
	/** A branch row: the base it would land in and whether it has. */
	base?: string | null;
	merge?: "merged" | "unmerged";
	target: WorkTreeTarget | null;
}

export interface WorkTreeFamily {
	root: WorkTreeNode;
	/** Live descendants and the ones that need a look, pre-order. */
	rows: WorkTreeNode[];
	/** Descendants that finished (and everything under them), for the closed fold. */
	finished: WorkTreeNode[];
	/** The whole family's cost by kind (`familySpend`): the session, its subagents at work, every session it opened. */
	cost: CostKinds;
	running: number;
	waiting: number;
}

export interface WorkTreeInput {
	tabs: readonly SessionTab[];
	/** Tab → its subagent roster (a tab without a runtime has none). */
	subagents: ReadonlyMap<string, ReadonlyMap<string, SubagentSnapshot>>;
	/** Parent tab → main's review list of the sessions it opened (`useAgentReviewStore.byTab`). */
	review: Readonly<Record<string, readonly AgentReviewItem[]>>;
	/** Session file → what an opened session runs on and has cost (main's review push). */
	usage: Readonly<Record<string, AgentChildUsage>>;
	closed: readonly ClosedChild[];
	/** Sessions paired devices run on this computer. */
	hosted: readonly IpcHostedSession[];
	deviceName: (deviceId: string) => string;
	/** Provider → billing class (`session_spend`), to class a cost no host split; undefined until read. */
	billing?: Readonly<Record<string, Billing>>;
}

const NO_AGENTS: ReadonlyMap<string, SubagentSnapshot> = new Map();
const NO_OWNERS: ReadonlyMap<string, string> = new Map();

/** The token a tab's own state reads as (the same reading the sidebar gives a session row). */
function tabState(tab: Pick<SessionTab, "status" | "awaitingInput" | "compacting" | "lastRun">): FamilyState {
	if (tab.awaitingInput !== undefined) return "waiting";
	if (tab.status === "running" || tab.compacting === true) return "running";
	if (tab.status === "error" || tab.lastRun?.stopReason === "error" || tab.lastRun?.stopReason === "aborted")
		return "failed";
	return "idle";
}

/** Whether `tab` was opened by another tab of this window (by tab id, or by session file after a relaunch). */
function hasOpenerHere(tab: SessionTab, tabs: readonly SessionTab[]): boolean {
	return tabs.some(
		other =>
			other.id !== tab.id &&
			(tab.openedBy === other.id ||
				(tab.openedBySession !== undefined && tab.openedBySession === other.sessionPath)),
	);
}

export function buildWorkTree(input: WorkTreeInput): WorkTreeFamily[] {
	const { tabs, subagents, review, usage, closed, hosted, deviceName, billing } = input;
	const live = tabs.filter(tab => !tab.ghost);
	const byId = new Map(live.map(tab => [tab.id, tab]));
	const families: WorkTreeFamily[] = [];

	for (const rootTab of live) {
		if (hasOpenerHere(rootTab, live)) continue;
		const rootState = tabState(rootTab);
		const family: WorkTreeFamily = {
			root: {
				key: `tab:${rootTab.id}`,
				kind: rootTab.worktree ? "worktree" : "session",
				title: rootTab.title || rootTab.task || "",
				// A session merely open has no token (the sidebar row of an idle session has none either).
				state: rootState === "idle" ? null : rootState,
				depth: 0,
				usage: {},
				...(rootTab.device ? { device: deviceName(rootTab.device) } : {}),
				target: { kind: "tab", tabId: rootTab.id },
			},
			rows: [],
			finished: [],
			cost: NO_COST,
			running: 0,
			waiting: 0,
		};
		const add = (node: WorkTreeNode, done: boolean) => {
			(done ? family.finished : family.rows).push(node);
			if (done) return;
			if (node.state === "running") family.running++;
			if (node.state === "waiting") family.waiting++;
		};
		const visited = new Set<string>([rootTab.id]);
		const visit = (tab: SessionTab, depth: number, done: boolean) => {
			const roster = subagents.get(tab.id) ?? NO_AGENTS;
			const subagentNode = (agent: SubagentSnapshot, level: number): WorkTreeNode => ({
				key: `agent:${tab.id}:${agent.id}`,
				kind: "subagent",
				title: subagentPrimaryLabel(agent),
				state: subagentFamilyState(agent.status),
				depth: level,
				usage: {
					model: agent.progress?.resolvedModel,
					role: agent.progress?.modelRole,
					cost: agent.progress?.cost,
				},
				target: { kind: "subagent", tabId: tab.id, agentId: agent.id },
			});
			for (const row of buildSubagentFamilyRows(roster, NO_OWNERS).rows)
				add(subagentNode(row.agent, depth + 1 + row.depth), done);
			for (const agent of [...roster.values()].sort((a, b) => a.index - b.index))
				if (isFoldedSubagent(agent.status)) add(subagentNode(agent, depth + 1), true);

			for (const child of openedChildRows({
				parent: tab,
				tabs: live,
				review: new Map((review[tab.id] ?? []).map(item => [item.tabId, item])),
				closed,
				deviceName,
			})) {
				const childTab = child.tabId ? byId.get(child.tabId) : undefined;
				if (childTab && visited.has(childTab.id)) continue;
				const childDone = done || child.status === "done";
				add(
					{
						key: child.tabId ? `tab:${child.tabId}` : `session:${child.key}`,
						kind: child.branch || childTab?.worktree ? "worktree" : "session",
						title: child.title,
						state: child.status ? CHILD_TOKEN[child.status] : null,
						depth: depth + 1,
						// Main's push for an open one (by session file), else what it recorded when it closed it.
						usage:
							usage[child.sessionPath ?? child.tabId ?? ""] ??
							closed.find(row => row.path === child.sessionPath) ??
							{},
						...(child.device ? { device: child.device } : {}),
						target: child.tabId
							? { kind: "tab", tabId: child.tabId }
							: child.sessionPath
								? { kind: "stored", sessionPath: child.sessionPath, ...(child.cwd ? { cwd: child.cwd } : {}) }
								: null,
					},
					childDone,
				);
				if (childTab) {
					visited.add(childTab.id);
					visit(childTab, depth + 1, childDone);
				}
				if (child.branch)
					add(
						{
							key: `branch:${child.key}`,
							kind: "branch",
							title: child.branch,
							state: null,
							depth: depth + 2,
							usage: {},
							base: child.base ?? null,
							...(child.merge ? { merge: child.merge } : {}),
							target: null,
						},
						childDone,
					);
			}
		};
		visit(rootTab, 0, false);
		// The whole family: the session, its subagents at work, every session opened under it; an opened session's
		// own subagents count once they finish, in its journal.
		const opened = [...family.rows, ...family.finished].filter(
			node => node.kind === "session" || node.kind === "worktree",
		);
		family.cost = familySpend(
			usage[rootTab.sessionPath ?? rootTab.id],
			(subagents.get(rootTab.id) ?? NO_AGENTS).values(),
			opened,
			billing,
		);
		if (family.rows.length > 0 || family.finished.length > 0) families.push(family);
	}

	// A paired device's session running on this computer has its family on that device; it is listed while at work.
	const shown = new Set(live.flatMap(tab => (tab.sessionPath ? [tab.sessionPath] : [])));
	for (const session of hosted) {
		if (shown.has(session.sessionPath)) continue;
		const state: FamilyState = session.awaitingInput
			? "waiting"
			: session.status === "running"
				? "running"
				: session.status === "error"
					? "failed"
					: "idle";
		if (state === "idle") continue;
		families.push({
			root: {
				key: `hosted:${session.sessionPath}`,
				kind: "session",
				title: session.title ?? "",
				state,
				depth: 0,
				usage: {},
				device: session.device,
				target: { kind: "stored", sessionPath: session.sessionPath, cwd: session.cwd },
			},
			rows: [],
			finished: [],
			cost: NO_COST,
			running: 0,
			waiting: 0,
		});
	}
	return families;
}

/**
 * What the whole family has cost, kind by kind (a metered charge, a subscription's estimate, never one sum): the
 * session's own journal (stock puts a finished subagent's spend there, with its task result), its subagents still at
 * work, and every session it opened (each its own journal), closed ones included, so nothing counts twice and the
 * total never drops when a child ends. A session's own split (classed on its host) is used whole; a subagent's cost
 * is classed by its model's provider.
 */
export function familySpend(
	root: ChildUsage | undefined,
	subagents: Iterable<SubagentSnapshot>,
	opened: readonly { usage?: ChildUsage }[],
	billing: Readonly<Record<string, Billing>> | undefined,
): CostKinds {
	let total = costKinds(root, billing);
	for (const agent of subagents)
		if (isLiveSubagentStatus(agent.status))
			total = addKinds(
				total,
				costKinds({ model: agent.progress?.resolvedModel, cost: agent.progress?.cost }, billing),
			);
	for (const child of opened) total = addKinds(total, costKinds(child.usage, billing));
	return total;
}

/** Two costs added kind by kind. */
function addKinds(a: CostKinds, b: CostKinds): CostKinds {
	return { charged: a.charged + b.charged, estimate: a.estimate + b.estimate, unknown: a.unknown + b.unknown };
}
