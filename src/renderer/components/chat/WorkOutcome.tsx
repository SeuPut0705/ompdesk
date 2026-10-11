import { useEffect, useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import { useFrameSelector } from "../../hooks/use-frame-selector";
import { formatDuration } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSessionRuntime } from "../../stores/session-runtime-context";
import { type SubagentsStore, useSubagentsStore } from "../../stores/subagents";
import { selectToolEntry, type ToolsStore, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { agentResultSummary, type WorkEvidence, workOutcomes } from "./work-view";

export function WorkOutcome({ toolCallIds }: { toolCallIds: readonly string[] }) {
	const t = useT();
	const runtime = useSessionRuntime();
	const tools = (runtime?.stores.get("tools") as StoreApi<ToolsStore> | undefined) ?? useToolsStore;
	const subagents = (runtime?.stores.get("subagents") as StoreApi<SubagentsStore> | undefined) ?? useSubagentsStore;
	const belongs = (id: string | undefined) => !!id && toolCallIds.includes(tools.getState().entryKeyForCallId(id));
	const agentKey = useFrameSelector(subagents, state =>
		[...state.subagents.values()]
			.filter(node => belongs(node.parentToolCallId))
			.map(
				node =>
					`${node.id}:${node.status}:${node.progress?.toolCount ?? 0}:${agentResultSummary({ ...node.progress }) ?? ""}:${state.surfaces.get(node.id)?.getState().finishedVersion ?? 0}`,
			)
			.join("|"),
	);
	const detail = useUiStore(s => s.transcriptDetail);
	const key = useFrameSelector(tools, state =>
		toolCallIds
			.map(id => {
				const entry = selectToolEntry(state, id);
				return `${id}:${entry?.status}:${entry?.endTime}`;
			})
			.join("|"),
	);
	void key;
	void agentKey;
	const agents = [...subagents.getState().subagents.values()].filter(node => belongs(node.parentToolCallId));
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	useEffect(() => {
		void agentKey;
		const missing = [...subagents.getState().subagents.values()].filter(
			node =>
				!!node.parentToolCallId &&
				toolCallIds.includes(tools.getState().entryKeyForCallId(node.parentToolCallId)) &&
				node.status !== "running" &&
				node.status !== "pending",
		);
		if (!missing.length) return;
		setLoading(true);
		void Promise.all(missing.map(node => subagents.getState().hydrateSurface(node.id)))
			.catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setLoading(false));
	}, [agentKey, subagents, tools, toolCallIds]);
	const entries: WorkEvidence[] = toolCallIds.flatMap(id => {
		const entry = selectToolEntry(tools.getState(), id);
		return entry ? [entry] : [];
	});
	for (const agent of agents) {
		for (const entry of subagents.getState().surfaces.get(agent.id)?.getState().finishedTools.values() ?? [])
			entries.push({ entry, agentName: agent.id });
	}
	const outcome = workOutcomes(entries, agents);
	if (!outcome.files.length && !outcome.commands.length && !outcome.conclusions.length) return null;
	return (
		<details className="omp-work-outcome" open={detail === "full"}>
			<summary>
				{t("chat.work.outcome")} ·{" "}
				{t("chat.work.outcomeCounts", {
					files: outcome.files.length,
					filesPlural: outcome.files.length === 1 ? "" : "s",
					commands: outcome.commands.length,
					commandsPlural: outcome.commands.length === 1 ? "" : "s",
					agents: outcome.conclusions.length,
					agentsPlural: outcome.conclusions.length === 1 ? "" : "s",
				})}
			</summary>
			{loading ? <div role="status">{t("subagent.loadingTranscript")}</div> : null}
			{error ? (
				<div role="alert">
					{t("subagent.transcriptFailed")}: {error}
				</div>
			) : null}
			<ul>
				{outcome.files.map((file, index) => (
					<li key={`${file.path}-${index}`}>
						<span className="font-mono">{file.path}</span>
						{file.added !== undefined ? (
							<span className="omp-work-diff">
								{" "}
								+{file.added} −{file.removed}
							</span>
						) : null}
					</li>
				))}
				{outcome.commands.map((command, index) => (
					<li key={`${command.command}-${index}`}>
						{command.agentName ? (
							<>
								<strong>{command.agentName}</strong> ·{" "}
							</>
						) : null}
						<span className="font-mono">{command.command}</span> ·{" "}
						{command.unknown
							? t("chat.work.unknown")
							: command.exitCode === null
								? t(command.failed ? "tools.status.failed" : "chat.work.succeeded")
								: t(command.exitCode === 0 && !command.failed ? "chat.work.pass" : "chat.work.fail", {
										code: command.exitCode,
									})}
						{command.durationMs !== undefined ? (
							<> · {t("chat.work.duration", { time: formatDuration(command.durationMs) })}</>
						) : null}
					</li>
				))}
				{outcome.conclusions.map((agent, index) => (
					<li key={`${agent.name}-${index}`}>
						<strong>{agent.name}</strong> · {agent.summary}
					</li>
				))}
			</ul>
		</details>
	);
}
