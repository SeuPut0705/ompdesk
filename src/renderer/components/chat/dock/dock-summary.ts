import type { SubagentSnapshot } from "../../../../shared/rpc-types";
import type { UiTodoPhase, UiTodoTask } from "../../../stores/todo";
import { isLiveSubagentStatus, type SubagentListRow } from "../../panels/subagent-graph";

export const TODO_SUMMARY_THRESHOLD = 10;
export const TODO_COMPLETED_PREVIEW = 3;
export const AGENT_SUMMARY_LIMIT = 5;

export interface TodoDockSummary {
	phases: UiTodoPhase[];
	hiddenCount: number;
	totalCount: number;
}

/**
 * Above ten todos, keep every actionable task visible and add only the three
 * most recent completed tasks. Abandoned work is available in focused mode.
 */
export function buildTodoDockSummary(phases: UiTodoPhase[]): TodoDockSummary {
	const tasks = phases.flatMap(phase => phase.tasks);
	if (tasks.length <= TODO_SUMMARY_THRESHOLD) {
		return { phases, hiddenCount: 0, totalCount: tasks.length };
	}

	const visibleIds = new Set(
		tasks.filter(task => task.status !== "completed" && task.status !== "abandoned").map(task => task.id),
	);
	for (const task of tasks.filter(task => task.status === "completed").slice(-TODO_COMPLETED_PREVIEW)) {
		visibleIds.add(task.id);
	}

	const summaryPhases = phases
		.map(phase => ({ ...phase, tasks: phase.tasks.filter(task => visibleIds.has(task.id)) }))
		.filter(phase => phase.tasks.length > 0);
	return {
		phases: summaryPhases,
		hiddenCount: tasks.length - visibleIds.size,
		totalCount: tasks.length,
	};
}

export interface TodoDockPeek {
	done: number;
	/** Abandoned tasks never complete, so they stay out of the denominator. */
	total: number;
	/** The task being worked, else the next open one; absent once nothing is left. */
	current?: UiTodoTask;
}

/** What the collapsed todo card shows at a glance: progress and the current task. */
export function buildTodoDockPeek(phases: UiTodoPhase[]): TodoDockPeek {
	const tasks = phases.flatMap(phase => phase.tasks).filter(task => task.status !== "abandoned");
	return {
		done: tasks.filter(task => task.status === "completed").length,
		total: tasks.length,
		current:
			tasks.find(task => task.status === "in_progress") ??
			tasks.find(task => task.status === "pending" || task.status === "blocked"),
	};
}

export interface AgentDockPeek {
	running: number;
	done: number;
	failed: number;
	/** The most recently updated live agent, else the most recently updated one. */
	latest?: SubagentSnapshot;
}

/** What the collapsed subagents card shows at a glance: status counts and the latest agent. */
export function buildAgentDockPeek(agents: SubagentSnapshot[]): AgentDockPeek {
	const live = agents.filter(agent => isLiveSubagentStatus(agent.status));
	const newest = (pool: SubagentSnapshot[]) =>
		pool.reduce<SubagentSnapshot | undefined>(
			(best, agent) =>
				!best ||
				agent.lastUpdate > best.lastUpdate ||
				(agent.lastUpdate === best.lastUpdate && agent.index > best.index)
					? agent
					: best,
			undefined,
		);
	return {
		running: live.length,
		done: agents.filter(agent => agent.status === "completed").length,
		failed: agents.filter(agent => agent.status === "failed").length,
		latest: newest(live) ?? newest(agents),
	};
}

export interface AgentDockSummary {
	rows: SubagentListRow[];
	hiddenCount: number;
	totalCount: number;
}

/**
 * Keep every live/failed agent, then fill a five-row preview with the most
 * recently updated terminal agents. Ancestors are retained so the tree never
 * shows an indented orphan.
 */
export function buildAgentDockSummary(rows: SubagentListRow[]): AgentDockSummary {
	if (rows.length <= AGENT_SUMMARY_LIMIT) {
		return { rows, hiddenCount: 0, totalCount: rows.length };
	}

	const agentById = new Map(rows.map(row => [row.agent.id, row.agent]));
	const visibleIds = new Set<string>();
	const addWithAncestors = (id: string): void => {
		let current = agentById.get(id);
		const seen = new Set<string>();
		while (current && !seen.has(current.id)) {
			visibleIds.add(current.id);
			seen.add(current.id);
			current = current.parentSubagentId ? agentById.get(current.parentSubagentId) : undefined;
		}
	};

	for (const { agent } of rows) {
		if (isLiveSubagentStatus(agent.status) || agent.status === "waiting" || agent.status === "failed") {
			addWithAncestors(agent.id);
		}
	}

	const recentTerminal = rows
		.filter(
			({ agent }) => !isLiveSubagentStatus(agent.status) && agent.status !== "waiting" && agent.status !== "failed",
		)
		.toSorted((a, b) => b.agent.lastUpdate - a.agent.lastUpdate || b.agent.index - a.agent.index);
	for (const { agent } of recentTerminal) {
		if (visibleIds.size >= AGENT_SUMMARY_LIMIT) break;
		addWithAncestors(agent.id);
	}

	return {
		rows: rows.filter(({ agent }) => visibleIds.has(agent.id)),
		hiddenCount: rows.length - visibleIds.size,
		totalCount: rows.length,
	};
}
