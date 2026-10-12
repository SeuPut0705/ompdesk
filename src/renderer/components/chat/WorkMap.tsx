import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { AgentProgress } from "../../../shared/rpc-types";
import { useFrameSelector } from "../../hooks/use-frame-selector";
import { cx, formatDuration, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { activeTabCommand, useSessionRuntime } from "../../stores/session-runtime-context";
import { type SubagentsStore, useSubagentsStore } from "../../stores/subagents";
import { selectToolEntry, type ToolsStore, useToolsStore } from "../../stores/tools";
import { LiveStepPeek } from "./LiveStepPeek";
import { agentWorkState, WorkStatus } from "./WorkStatus";
import { agentResultSummary, workNarrative, workOutcomes } from "./work-view";

function progressArgs(progress?: AgentProgress): Record<string, unknown> {
	if (!progress?.currentToolArgs) return {};
	try {
		const value: unknown = JSON.parse(progress.currentToolArgs);
		if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch {
		/* Stock also emits a human-readable args summary. */
	}
	return { target: progress.currentToolArgs };
}

function SubagentSurface({ id, store }: { id: string; store: StoreApi<SubagentsStore> }) {
	const t = useT();
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const tools = store.getState().surface(id);
	const status = store.getState().subagents.get(id)?.status;
	const key = useFrameSelector(tools, state =>
		JSON.stringify([...state.finishedTools.keys(), ...state.liveTools.keys()]),
	);
	const hasEvidence = key !== "[]";
	useEffect(() => {
		void status;
		// Initial hydration or one replay of events missed while this lane was collapsed.
		setLoading(true);
		void store
			.getState()
			.hydrateSurface(id)
			.catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setLoading(false));
	}, [id, store, status]);
	if (!hasEvidence)
		return (
			<div className="omp-live-work-calm" role={error ? "alert" : "status"}>
				{error
					? `${t("subagent.transcriptFailed")}: ${error}`
					: t(loading ? "subagent.loadingTranscript" : "subagent.noEntries")}
			</div>
		);
	return (
		<>
			{error ? (
				<div role="alert" className="omp-live-work-calm">
					{t("subagent.transcriptFailed")}: {error}
				</div>
			) : null}
			<LiveStepPeek
				toolCallIds={JSON.parse(key) as string[]}
				thinkingLive={false}
				toolsOverride={tools}
				turnIsLive={store.getState().subagents.get(id)?.status === "running"}
				nested
			/>
		</>
	);
}

/**
 * One lane per subagent of this group: status, name, what it is doing now (its
 * conclusion once done) and its counts. A lane opens its agent's own live
 * surface in place; only an open lane subscribes to per-event frames.
 */
export function WorkMap({
	toolCallIds,
	active,
	motion,
	expanded,
	onExpandedChange,
}: {
	toolCallIds: readonly string[];
	active: boolean;
	motion: boolean;
	expanded: string | null;
	onExpandedChange: (id: string | null) => void;
}) {
	const t = useT();
	const runtime = useSessionRuntime();
	const store = (runtime?.stores.get("subagents") as StoreApi<SubagentsStore> | undefined) ?? useSubagentsStore;
	const tools = (runtime?.stores.get("tools") as StoreApi<ToolsStore> | undefined) ?? useToolsStore;
	const key = useFrameSelector(store, state =>
		[...state.subagents.values()]
			.filter(
				node =>
					node.parentToolCallId && toolCallIds.includes(tools.getState().entryKeyForCallId(node.parentToolCallId)),
			)
			.map(node => {
				const p = node.progress;
				return [
					node.id,
					node.status,
					node.description,
					node.task,
					p?.currentTool,
					p?.currentToolArgs,
					p?.currentToolIntent,
					p?.lastIntent,
					p?.toolCount,
					p?.tokens,
					p?.durationMs,
					agentResultSummary({ ...p }),
					state.surfaces.get(node.id)?.getState().liveTools.size,
					state.surfaces.get(node.id)?.getState().finishedTools.size,
					state.observedTokens.get(node.id),
				].join("\u0000");
			})
			.join("\u0001"),
	);
	const nodes = [...store.getState().subagents.values()].filter(
		node => node.parentToolCallId && toolCallIds.includes(tools.getState().entryKeyForCallId(node.parentToolCallId)),
	);
	void key;
	const conclusions = workOutcomes(
		toolCallIds.flatMap(id => {
			const entry = selectToolEntry(tools.getState(), id);
			return entry ? [entry] : [];
		}),
		nodes,
	).conclusions;
	const hasRunning = nodes.some(node => node.status === "running" || node.status === "pending");
	const [streamError, setStreamError] = useState<string | null>(null);
	useEffect(() => {
		if (!active || !expanded || !hasRunning) return;
		const command = runtime?.command ?? activeTabCommand;
		let mounted = true;
		store.setState(state => ({ eventConsumers: state.eventConsumers + 1 }));
		setStreamError(null);
		void command({ type: "set_subagent_subscription", level: "events" })
			.then(response => {
				if (mounted && !response.success) setStreamError(response.error);
			})
			.catch(cause => {
				if (mounted) setStreamError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			store.setState(state => ({ eventConsumers: Math.max(0, state.eventConsumers - 1) }));
			mounted = false;
			void command({ type: "set_subagent_subscription", level: "progress" }).catch(() => undefined);
		};
	}, [active, expanded, hasRunning, runtime, store]);
	if (!nodes.length) return null;
	return (
		<div className="omp-work-map" data-expanded={expanded !== null} aria-label={t("chat.work.map")}>
			{streamError ? (
				<div className="omp-live-work-calm" role="alert">
					{t("subagent.transcriptFailed")}: {streamError}
				</div>
			) : null}
			<ul className="omp-work-cards">
				{nodes.map(node => {
					const progress = node.progress;
					const running = node.status === "running" || node.status === "pending";
					const args = progressArgs(progress);
					const activity = running
						? progress?.currentTool
							? workNarrative(progress.currentTool, args, t, progress)
							: (progress?.lastIntent ?? node.description ?? node.task ?? "")
						: (conclusions.find(item => item.name === node.id)?.summary ?? t("chat.work.completed"));
					const target = running && typeof args.target === "string" && args.target !== activity ? args.target : "";
					const observed = store.getState().surfaces.get(node.id)?.getState();
					const toolCount = Math.max(
						progress?.toolCount ?? 0,
						(observed?.liveTools.size ?? 0) + (observed?.finishedTools.size ?? 0),
					);
					const tokens = progress?.tokens || store.getState().observedTokens.get(node.id) || 0;
					const plural = toolCount === 1 ? "" : "s";
					const open = expanded === node.id;
					return (
						<li className="omp-work-card" key={node.id} data-status={node.status} data-open={open}>
							<button
								type="button"
								className="omp-work-card-button"
								aria-expanded={open}
								onClick={() => onExpandedChange(open ? null : node.id)}
							>
								<WorkStatus
									state={agentWorkState(node.status)}
									label={t(`subagent.status.${node.status === "running" ? "started" : node.status}`)}
									motion={motion}
								/>
								<span className="omp-work-card-name">{node.id}</span>
								<span className="omp-work-card-activity" title={target ? `${activity} · ${target}` : activity}>
									{activity}
									{target ? <span className="omp-work-card-target">{target}</span> : null}
								</span>
								<span className="omp-work-card-progress">
									{[
										tokens > 0
											? t("chat.work.progress", { tools: toolCount, plural, tokens: formatTokens(tokens) })
											: toolCount > 0
												? t("chat.work.toolsOnly", { tools: toolCount, plural })
												: null,
										formatDuration(progress?.durationMs ?? 0),
									]
										.filter(Boolean)
										.join(" · ")}
								</span>
								<ChevronRight aria-hidden className={cx("omp-work-card-chevron", open && "rotate-90")} />
							</button>
							{open ? (
								<div className="omp-work-lane-surface">
									<SubagentSurface id={node.id} store={store} />
								</div>
							) : null}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
