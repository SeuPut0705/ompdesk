import { useEffect, useMemo, useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { AgentMessage } from "../../../../shared/rpc-types";
import { useFrameSelector } from "../../../hooks/use-frame-selector";
import { type MessagesStore, useMessagesStore } from "../../../stores/messages";
import { useSessionStore } from "../../../stores/session";
import { useSessionRuntime } from "../../../stores/session-runtime-context";
import { type SubagentNode, type SubagentsStore, useSubagentsStore } from "../../../stores/subagents";
import { selectToolEntry, type ToolsStore, useToolsStore } from "../../../stores/tools";
import { backgroundJobVerdicts } from "../completion-events";
import { type AgentCompletion, mergeRunAgents, runTranscript, type TaskCallResult } from "./work-run";
import { type WorkEvidence, workOutcomes } from "./work-view";

const NO_MESSAGES: readonly AgentMessage[] = [];
const NO_COMPLETIONS: ReadonlyMap<string, AgentCompletion> = new Map();

export function useRunStores() {
	const runtime = useSessionRuntime();
	return {
		tools: (runtime?.stores.get("tools") as StoreApi<ToolsStore> | undefined) ?? useToolsStore,
		subagents: (runtime?.stores.get("subagents") as StoreApi<SubagentsStore> | undefined) ?? useSubagentsStore,
		messages: (runtime?.stores.get("messages") as StoreApi<MessagesStore> | undefined) ?? useMessagesStore,
	};
}

/**
 * Every agent this run spawned with how it settled: live registry rows merged
 * with what the transcript's task results and completion notices recorded, so
 * a reloaded session shows the lanes it showed live. `progress` re-renders on
 * every progress frame (lanes); otherwise only on status changes.
 */
export function useRunAgents(
	toolCallIds: readonly string[],
	detail: "status" | "progress" = "status",
): { agents: SubagentNode[]; completions: ReadonlyMap<string, AgentCompletion> } {
	const { tools, subagents, messages } = useRunStores();
	const ids = toolCallIds.join("\u0000");
	// The run's task calls by how far they got: a settled call carries stock's spawn rows.
	const taskKey = useFrameSelector(tools, state =>
		toolCallIds
			.flatMap(id => {
				const entry = selectToolEntry(state, id);
				return entry?.toolName === "task" ? [`${id}:${entry.status}:${entry.result == null ? 0 : 1}`] : [];
			})
			.join("|"),
	);
	const spawns = taskKey !== "";
	const committed = useFrameSelector(messages, state => (spawns ? state.messages : NO_MESSAGES));
	const live = useFrameSelector(messages, state => (spawns ? state.liveMessages : NO_MESSAGES));
	const liveKey = useFrameSelector(subagents, state =>
		[...state.subagents.values()]
			.filter(
				node =>
					!!node.parentToolCallId &&
					toolCallIds.includes(tools.getState().entryKeyForCallId(node.parentToolCallId)),
			)
			.map(node =>
				detail === "progress" ? `${node.id}:${node.status}:${node.lastUpdate}` : `${node.id}:${node.status}`,
			)
			.join("|"),
	);
	// This run's task calls the live registry holds agents for: their unanswered arguments name no lane.
	const registeredKey = useFrameSelector(subagents, state =>
		[
			...new Set(
				[...state.subagents.values()].flatMap(node => {
					const key = node.parentToolCallId ? tools.getState().entryKeyForCallId(node.parentToolCallId) : "";
					return key && toolCallIds.includes(key) ? [key] : [];
				}),
			),
		]
			.sort()
			.join("\u0000"),
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `ids`/`taskKey`/`registeredKey` are the content keys read here.
	const transcript = useMemo(() => {
		if (!spawns) return { agents: [], completions: NO_COMPLETIONS };
		const owns = (id: string) => toolCallIds.includes(tools.getState().entryKeyForCallId(id));
		const taskCalls = toolCallIds.flatMap((id): TaskCallResult[] => {
			const entry = selectToolEntry(tools.getState(), id);
			if (entry?.toolName !== "task") return [];
			if (entry.result != null)
				return [{ toolCallId: id, result: entry.result, timestamp: entry.endTime ?? entry.startTime }];
			// Ended without any result: only its arguments recorded the agents it started, unless
			// the live registry still holds them under the ids stock allocated.
			return entry.status === "aborted" && !registeredKey.split("\u0000").includes(id)
				? [{ toolCallId: id, result: null, timestamp: entry.endTime ?? entry.startTime, args: entry.args }]
				: [];
		});
		return runTranscript(live.length ? [...committed, ...live] : committed, owns, taskCalls);
	}, [spawns, taskKey, registeredKey, committed, live, ids, tools]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: liveKey/ids encode the store rows read here.
	const agents = useMemo(() => {
		const owned = [...subagents.getState().subagents.values()].filter(
			node =>
				!!node.parentToolCallId && toolCallIds.includes(tools.getState().entryKeyForCallId(node.parentToolCallId)),
		);
		return mergeRunAgents(owned, transcript);
	}, [liveKey, ids, transcript, subagents, tools]);
	return { agents, completions: transcript.completions };
}

/**
 * One outcome model for the whole run, main agent and subagents alike: the head's
 * counts and the outcome list read the same ledger. Finished agents' transcripts
 * are replayed once so their files and commands count after a reload too.
 */
export function useRunOutcome(toolCallIds: readonly string[], stoppedAt?: number) {
	const { tools, subagents, messages } = useRunStores();
	const cwd = useSessionStore(state => state.cwd);
	const { agents, completions } = useRunAgents(toolCallIds);
	const ids = toolCallIds.join("\u0000");
	// A backgrounded check settles later, in a committed `async-result` or `wait` result; a finished card reads it.
	const jobVerdicts = useFrameSelector(messages, state => backgroundJobVerdicts(state.messages));
	const toolsKey = useFrameSelector(tools, state =>
		toolCallIds
			.map(id => {
				const entry = selectToolEntry(state, id);
				return `${entry?.status}:${entry?.endTime}`;
			})
			.join("|"),
	);
	const surfacesKey = useFrameSelector(subagents, state =>
		agents.map(agent => `${agent.id}:${state.surfaces.get(agent.id)?.getState().finishedVersion ?? 0}`).join("|"),
	);
	const settledKey = agents
		.filter(agent => agent.status !== "running" && agent.status !== "pending")
		.map(agent => `${agent.id}:${agent.status}`)
		.join("|");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	useEffect(() => {
		if (!settledKey) return;
		let mounted = true;
		setLoading(true);
		void Promise.all(
			settledKey.split("|").map(row => subagents.getState().hydrateSurface(row.slice(0, row.lastIndexOf(":")))),
		)
			.catch(cause => mounted && setError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => mounted && setLoading(false));
		return () => {
			mounted = false;
		};
	}, [settledKey, subagents]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the keys encode every entry and surface read here.
	const outcome = useMemo(() => {
		const entries: WorkEvidence[] = toolCallIds.flatMap(id => {
			const entry = selectToolEntry(tools.getState(), id);
			return entry ? [{ entry, toolCallId: id }] : [];
		});
		for (const agent of agents) {
			for (const entry of subagents.getState().surfaces.get(agent.id)?.getState().finishedTools.values() ?? [])
				entries.push({ entry, agentName: agent.id });
		}
		return workOutcomes(entries, stoppedAt, cwd, jobVerdicts);
	}, [ids, toolsKey, surfacesKey, agents, stoppedAt, cwd, jobVerdicts, tools, subagents]);
	return { outcome, agents, completions, loading, error };
}
