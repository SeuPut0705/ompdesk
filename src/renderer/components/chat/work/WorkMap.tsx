import { ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { AgentProgress } from "../../../../shared/rpc-types";
import { useFrameSelector } from "../../../hooks/use-frame-selector";
import { useMediaQuery } from "../../../hooks/use-media-query";
import { cx, formatDuration, formatElapsed, formatTokens } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { activeTabCommand, useSessionRuntime } from "../../../stores/session-runtime-context";
import type { SubagentsStore } from "../../../stores/subagents";
import { statusMeta } from "../../panels/subagent-graph";
import { getToolHeader } from "../../tools/index";
import { LiveStepPeek } from "../LiveStepPeek";
import { useRunAgents, useRunStores } from "./use-work-run";
import { agentGroupState, agentWorkState, WorkStatus } from "./WorkStatus";
import { agentConclusion, agentDurationMs } from "./work-run";
import { workNarrative } from "./work-view";

/** Stock progress carries a display preview of the call's arguments, sometimes JSON. */
function progressArgs(preview: string | undefined): Record<string, unknown> {
	if (!preview) return {};
	try {
		const value: unknown = JSON.parse(preview);
		if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch {
		/* Stock also emits a human-readable args summary. */
	}
	return { target: preview };
}

/**
 * What a running lane is doing: the call in flight (stock's currentTool), or
 * between calls the one that just ended, so the lane names a tool from the
 * moment the first one starts. Only the call's own intent counts: stock's
 * `lastIntent` belongs to an earlier call, so it stands in only when stock
 * counted calls without naming one.
 */
function laneCall(progress: AgentProgress | undefined): { tool: string; args: string; intent?: string } | null {
	if (progress?.currentTool)
		return { tool: progress.currentTool, args: progress.currentToolArgs ?? "", intent: progress.currentToolIntent };
	const last = progress?.recentTools?.[0];
	return last ? { tool: last.tool, args: last.args, intent: last.intent } : null;
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
	const { subagents: store } = useRunStores();
	// Stock's spawn index, so lanes keep the order the task listed them in whichever reports first.
	const { agents: nodes, completions, resumed } = useRunAgents(toolCallIds, "progress");
	const observedKey = useFrameSelector(store, state =>
		nodes
			.map(node => {
				const surface = state.surfaces.get(node.id)?.getState();
				return `${surface?.liveTools.size ?? 0}:${surface?.finishedTools.size ?? 0}`;
			})
			.join("|"),
	);
	void observedKey;
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
		<div className="omp-work-map" data-expanded={expanded !== null} role="group" aria-label={t("chat.work.map")}>
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
					const completion = completions.get(node.id);
					const call = running ? laneCall(progress) : null;
					const args = progressArgs(call?.args);
					const activity = call
						? workNarrative(call.tool, args, t, undefined, call.intent)
						: running
							? // Before the first call only: the raw assignment is a model prompt, not a status line.
								((progress?.toolCount ? progress.lastIntent : undefined) ??
								// A revived agent's first request after a restart can take minutes: it goes on, not starts.
								(resumed.has(node.id) ? t("chat.work.resuming") : undefined) ??
								node.description ??
								t("chat.work.starting"))
							: ((groupState === "complete" || groupState === "failed"
									? agentConclusion(node, completion)
									: undefined) ??
								t(
									groupState === "failed"
										? "chat.work.failed"
										: groupState === "interrupted"
											? "chat.work.interrupted"
											: "chat.work.completed",
								));
					const header = call ? getToolHeader(call.tool, args) : null;
					const toolTarget =
						header?.path || header?.target || (typeof args.target === "string" ? args.target : "");
					const target = toolTarget && !activity.includes(toolTarget) ? toolTarget : "";
					const observed = store.getState().surfaces.get(node.id)?.getState();
					const toolCount = Math.max(
						progress?.toolCount ?? 0,
						(observed?.liveTools.size ?? 0) + (observed?.finishedTools.size ?? 0),
					);
					// Settled lanes show what a reload can show too: stock's tokens exist only while running.
					const tokens = running ? progress?.tokens || store.getState().observedTokens.get(node.id) || 0 : 0;
					const plural = toolCount === 1 ? "" : "s";
					// A settled lane whose run recorded no duration (a reloaded detached agent) states none,
					// never a made-up "0ms".
					const settledMs = running ? 0 : agentDurationMs(node, completion);
					const elapsed = running
						? formatElapsed(progress?.durationMs ?? 0)
						: settledMs > 0
							? formatDuration(settledMs)
							: "";
					const open = expanded === node.id;
					// One name for a user stop everywhere: "Interrupted", never stock's "cancelled".
					const label = t(
						meta.labelKey === "subagent.status.cancelled" ? "tools.status.interrupted" : meta.labelKey,
					);
					return (
						<li
							className="omp-work-card"
							key={node.id}
							data-status={node.status}
							data-open={open}
							data-motion={laneMotion}
						>
							{/* controls-ok: the omp-work-card-button class draws the whole control */}
							<button
								type="button"
								className="omp-work-card-button"
								aria-current={open || undefined}
								// The lane opens its transcript in the card's stage: a disclosure.
								aria-expanded={open}
								onClick={() => onExpandedChange(open ? null : node.id)}
							>
								<WorkStatus state={agentWorkState(node.status)} label={label} motion={laneMotion} />
								<span className="omp-work-card-name">{node.id}</span>
								<span className="omp-work-card-activity" title={target ? `${activity} · ${target}` : activity}>
									<span
										className="omp-work-card-activity-text"
										key={`${call?.tool ?? ""}\u0000${activity}\u0000${target}`}
									>
										{activity}
										{target ? <span className="omp-work-card-target">{target}</span> : null}
									</span>
								</span>
								<span className="omp-work-card-progress">
									<span className="omp-work-card-count">
										{/* A lane that has not called a tool yet states its tokens alone, never "0 tools". */}
										{tokens > 0
											? toolCount > 0
												? t("chat.work.progress", {
														tools: toolCount,
														plural,
														tokens: formatTokens(tokens),
													})
												: t("chat.meter.tokens", { tokens: formatTokens(tokens) })
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
