import { ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { AgentProgress } from "../../../shared/rpc-types";
import { useFrameSelector } from "../../hooks/use-frame-selector";
import { useMediaQuery } from "../../hooks/use-media-query";
import { cx, formatDuration, formatElapsed, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { activeTabCommand, useSessionRuntime } from "../../stores/session-runtime-context";
import { type SubagentsStore, useSubagentsStore } from "../../stores/subagents";
import { selectToolEntry, type ToolsStore, useToolsStore } from "../../stores/tools";
import { statusMeta } from "../panels/subagent-graph";
import { getToolHeader } from "../tools/index";
import { LiveStepPeek } from "./LiveStepPeek";
import { agentGroupState, agentWorkState, WorkStatus } from "./WorkStatus";
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

export function SubagentSurface({ id, store }: { id: string; store: StoreApi<SubagentsStore> }) {
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
				state={agentGroupState(store.getState().subagents.get(id)?.status)}
				nested
			/>
		</>
	);
}

/**
 * Stable agent lanes select a surface in the shared stage. Only the selected
 * agent leases per-event frames; closing it restores progress subscriptions.
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
	const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
	const laneMotion = motion && !reducedMotion;
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
	// Stock's spawn index, so lanes keep the order the task listed them in whichever reports first.
	const nodes = [...store.getState().subagents.values()]
		.filter(
			node =>
				node.parentToolCallId && toolCallIds.includes(tools.getState().entryKeyForCallId(node.parentToolCallId)),
		)
		.sort((a, b) => a.index - b.index);
	void key;
	const lanesRef = useRef<HTMLUListElement>(null);
	useLayoutEffect(() => {
		if (!expanded) return;
		const list = lanesRef.current;
		const current = list?.querySelector<HTMLElement>('[aria-current="true"]');
		if (!list || !current) return;
		const viewport = list.getBoundingClientRect();
		const row = current.getBoundingClientRect();
		if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom;
		else if (row.top < viewport.top) list.scrollTop -= viewport.top - row.top;
	}, [expanded]);
	const conclusions = workOutcomes(
		toolCallIds.flatMap(id => {
			const entry = selectToolEntry(tools.getState(), id);
			return entry ? [entry] : [];
		}),
		nodes,
	).conclusions;
	const hasRunning = nodes.some(node => statusMeta(node.status).live);
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
			<ul className="omp-work-cards" ref={lanesRef}>
				{nodes.map(node => {
					const progress = node.progress;
					const meta = statusMeta(node.status);
					const running = meta.live;
					const groupState = agentGroupState(node.status);
					const args = progressArgs(progress);
					const activity = running
						? progress?.currentTool
							? workNarrative(progress.currentTool, args, t, progress)
							: // The raw assignment is a model prompt, not a status line; its full text stays on the agent's page.
								(progress?.lastIntent ?? node.description ?? t("chat.work.starting"))
						: (conclusions.find(item => item.name === node.id)?.summary ??
							t(
								groupState === "failed"
									? "chat.work.failed"
									: groupState === "interrupted"
										? "chat.work.interrupted"
										: "chat.work.completed",
							));
					const header = running && progress?.currentTool ? getToolHeader(progress.currentTool, args) : null;
					const toolTarget =
						header?.path || header?.target || (typeof args.target === "string" ? args.target : "");
					const target = toolTarget && !activity.includes(toolTarget) ? toolTarget : "";
					const observed = store.getState().surfaces.get(node.id)?.getState();
					const toolCount = Math.max(
						progress?.toolCount ?? 0,
						(observed?.liveTools.size ?? 0) + (observed?.finishedTools.size ?? 0),
					);
					const tokens = progress?.tokens || store.getState().observedTokens.get(node.id) || 0;
					const plural = toolCount === 1 ? "" : "s";
					const elapsed = running
						? formatElapsed(progress?.durationMs ?? 0)
						: formatDuration(progress?.durationMs ?? 0);
					const open = expanded === node.id;
					return (
						<li
							className="omp-work-card"
							key={node.id}
							data-status={node.status}
							data-open={open}
							data-motion={laneMotion}
						>
							<button
								type="button"
								className="omp-work-card-button"
								aria-current={open || undefined}
								onClick={() => onExpandedChange(open ? null : node.id)}
							>
								<WorkStatus state={agentWorkState(node.status)} label={t(meta.labelKey)} motion={laneMotion} />
								<span className="omp-work-card-name">{node.id}</span>
								<span className="omp-work-card-activity" title={target ? `${activity} · ${target}` : activity}>
									<span
										className="omp-work-card-activity-text"
										key={`${progress?.currentTool ?? ""}\u0000${activity}\u0000${target}`}
									>
										{activity}
										{target ? <span className="omp-work-card-target">{target}</span> : null}
									</span>
								</span>
								<span className="omp-work-card-progress">
									<span className="omp-work-card-count">
										{tokens > 0
											? t("chat.work.progress", { tools: toolCount, plural, tokens: formatTokens(tokens) })
											: toolCount > 0
												? t("chat.work.toolsOnly", { tools: toolCount, plural })
												: null}
									</span>
									<span className="omp-work-card-elapsed">
										{elapsed && (tokens > 0 || toolCount > 0) ? " · " : ""}
										{elapsed}
									</span>
								</span>
								<ChevronRight aria-hidden className={cx("omp-work-card-chevron", open && "rotate-90")} />
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
