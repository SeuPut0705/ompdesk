import { useEffect, useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { AgentProgress } from "../../../shared/rpc-types";
import { useFrameSelector } from "../../hooks/use-frame-selector";
import { cx, formatDuration, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { turnMeterTokens } from "../../lib/turn-meter";
import { type MessagesStore, useMessagesStore } from "../../stores/messages";
import { activeTabCommand, useSessionRuntime } from "../../stores/session-runtime-context";
import { type SubagentsStore, useSubagentsStore } from "../../stores/subagents";
import { selectToolEntry, type ToolsStore, useToolsStore } from "../../stores/tools";
import { LiveStepPeek } from "./LiveStepPeek";
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
		// Initial hydration or one replay of events missed while this card was collapsed.
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
		<div>
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
		</div>
	);
}

export function WorkMap({
	toolCallIds,
	active,
	motion,
	running,
	mainStepId,
	completion,
	expanded,
	onExpandedChange,
}: {
	toolCallIds: readonly string[];
	active: boolean;
	motion: boolean;
	running: boolean;
	mainStepId: string;
	completion: string;
	expanded: string | null;
	onExpandedChange: (id: string | null) => void;
}) {
	const t = useT();
	const runtime = useSessionRuntime();
	const store = (runtime?.stores.get("subagents") as StoreApi<SubagentsStore> | undefined) ?? useSubagentsStore;
	const tools = (runtime?.stores.get("tools") as StoreApi<ToolsStore> | undefined) ?? useToolsStore;
	const messages = (runtime?.stores.get("messages") as StoreApi<MessagesStore> | undefined) ?? useMessagesStore;
	const mainTokens = useFrameSelector(messages, state => turnMeterTokens(state.turnMeter));
	const mainActivity = useFrameSelector(tools, state => {
		const entry = selectToolEntry(state, mainStepId);
		return running && entry
			? workNarrative(entry.toolName, entry.args, t, undefined, entry.intent)
			: running
				? t("chat.thinking.live")
				: completion;
	});
	const now = useNowTick(active);
	const mainStarted = Math.min(...toolCallIds.map(id => selectToolEntry(tools.getState(), id)?.startTime ?? now));
	const mainEnded = running
		? now
		: Math.max(...toolCallIds.map(id => selectToolEntry(tools.getState(), id)?.endTime ?? mainStarted));
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
	if (!nodes.length || (running && !hasRunning && !expanded)) return null;
	return (
		<div className="omp-work-map" data-expanded={expanded !== null} aria-label={t("chat.work.map")}>
			{nodes.some(node => node.status === "running") ? (
				<div className="omp-work-main">
					{t("chat.work.waitingFor", {
						names: nodes
							.filter(node => node.status === "running")
							.map(node => node.id)
							.join(", "),
					})}
				</div>
			) : null}
			{streamError ? (
				<div className="omp-live-work-calm" role="alert">
					{t("subagent.transcriptFailed")}: {streamError}
				</div>
			) : null}
			<div className="omp-work-cards">
				<div className={cx("omp-work-card omp-work-main-card", running && motion && "omp-work-pulse")}>
					<span className="omp-work-card-name">
						{t("chat.work.main")}
						<span>{t(running ? "subagent.status.started" : "subagent.status.completed")}</span>
					</span>
					<span className="omp-work-card-activity">{mainActivity}</span>
					<span className="omp-work-card-progress">
						{t("chat.work.progress", {
							tools: toolCallIds.length,
							plural: toolCallIds.length === 1 ? "" : "s",
							tokens: formatTokens(mainTokens),
						})}{" "}
						· {formatDuration(Math.max(0, mainEnded - mainStarted))}
					</span>
				</div>
				{nodes.map(node => {
					const progress = node.progress;
					const running = node.status === "running" || node.status === "pending";
					const args = progressArgs(progress);
					const activity = running
						? progress?.currentTool
							? workNarrative(progress.currentTool, args, t, progress)
							: (progress?.lastIntent ?? node.description ?? node.task ?? "")
						: (conclusions.find(item => item.name === node.id)?.summary ?? t("chat.work.completed"));
					const observed = store.getState().surfaces.get(node.id)?.getState();
					const toolCount = Math.max(
						progress?.toolCount ?? 0,
						(observed?.liveTools.size ?? 0) + (observed?.finishedTools.size ?? 0),
					);
					const tokens = progress?.tokens || store.getState().observedTokens.get(node.id) || 0;
					return (
						<div className="omp-work-card" key={node.id} data-status={node.status}>
							<button
								type="button"
								className={cx("omp-work-card-button", running && motion && "omp-work-pulse")}
								aria-expanded={expanded === node.id}
								onClick={() => onExpandedChange(expanded === node.id ? null : node.id)}
							>
								<span className="omp-work-card-name">
									{node.id}{" "}
									<span>{t(`subagent.status.${node.status === "running" ? "started" : node.status}`)}</span>
								</span>
								<span className="omp-work-card-activity">
									{activity}
									{running && args.target ? ` · ${String(args.target)}` : ""}
								</span>
								<span className="omp-work-card-progress">
									{tokens > 0
										? t("chat.work.progress", {
												tools: toolCount,
												plural: toolCount === 1 ? "" : "s",
												tokens: formatTokens(tokens),
											})
										: t("chat.work.toolsOnly", { tools: toolCount, plural: toolCount === 1 ? "" : "s" })}{" "}
									· {formatDuration(progress?.durationMs ?? 0)}
								</span>
							</button>
						</div>
					);
				})}
			</div>
			{expanded ? (
				<div className="omp-work-card omp-work-expanded-card">
					<SubagentSurface id={expanded} store={store} />
				</div>
			) : null}
		</div>
	);
}
