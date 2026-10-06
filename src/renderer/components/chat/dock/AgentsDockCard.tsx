/**
 * Agents dock card: the live subagent roster rendered in the center dock
 * above the composer (previously the workspace drawer's agents tab). Live
 * tree of subagent nodes with status badges, elapsed time, progress line,
 * and lazily loaded transcripts (byte pagination). A List/Graph toggle in
 * the card header switches the compact spawn tree for the graphical DAG.
 *
 * Owns stream-time polling of get_subagents (moved from the ActivityStrip
 * agents chip): lifecycle/progress frames keep the store fresh while agents
 * run, but parked/idle transitions ride the AgentRegistry and emit NO wire
 * frame — without polling, a watchdog-parked agent would show "running"
 * until the next session hydration.
 */

import { Bot, ChevronRight, List, Network } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { SubagentSnapshot } from "../../../../shared/rpc-types";
import { useTabGuard } from "../../../hooks/use-tab-guard";
import { cx, formatCost, formatTokens } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useNowTick } from "../../../lib/now-tick";
import { useMessagesStore } from "../../../stores/messages";
import { useSessionStore } from "../../../stores/session";
import { useSubagentsStore } from "../../../stores/subagents";
import { Badge, Button, IconButton } from "../../common";
import { SubagentDag } from "../../panels/SubagentDag";
import { SubagentTranscript } from "../../panels/SubagentTranscript";
import {
	buildSubagentList,
	extractTaskToolCallIds,
	formatElapsed,
	isLiveSubagentStatus,
	statusMeta,
	subagentElapsedMs,
	subagentPrimaryLabel,
	useSubagentGraphStore,
} from "../../panels/subagent-graph";
import { DockCard } from "./DockCard";
import { buildAgentDockSummary } from "./dock-summary";
import { useWorkspaceDockFocus } from "./WorkspaceDockFocus";

type PanelView = "list" | "graph";

/** Poll cadence while a turn streams (covers frame-less parked/idle transitions). */
const STREAM_POLL_MS = 3000;

const SubagentRow = memo(function SubagentRow({
	agent,
	depth,
	expanded,
	onToggle,
	now,
}: {
	agent: SubagentSnapshot;
	depth: number;
	expanded: boolean;
	onToggle: () => void;
	now: number;
}) {
	const t = useT();
	const meta = statusMeta(agent.status);
	const live = isLiveSubagentStatus(agent.status);
	const elapsed = subagentElapsedMs(agent, now);
	const title = subagentPrimaryLabel(agent);
	const progressLine = live ? agent.progress?.description?.trim() : undefined;
	const description = agent.description?.trim();
	const detail = [progressLine, description].find(line => line && line !== title);
	const model = agent.progress?.resolvedModel;
	const usage =
		agent.progress && (agent.progress.requests > 0 || agent.progress.tokens > 0 || agent.progress.cost > 0)
			? `${formatTokens(agent.progress.tokens)} ${t("sessionInfo.tokens")} · ${formatCost(agent.progress.cost)}`
			: undefined;

	return (
		<div aria-level={depth + 1} className="relative" role="treeitem" style={{ marginLeft: Math.min(depth, 6) * 14 }}>
			{depth > 0 && (
				<span className="pointer-events-none absolute top-0 -left-2.5 h-5 w-2.5 rounded-bl-(--sc-radius-sm) border-b border-l border-(--sc-border-subtle)" />
			)}
			<div
				className={cx(
					"relative overflow-hidden rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-transparent transition-colors duration-(--sc-duration-fast) hover:bg-(--sc-hover)",
					agent.status === "cancelled" && "opacity-70",
				)}
			>
				<span
					aria-hidden
					className={cx(
						"absolute inset-y-2 left-0 w-0.5 rounded-full",
						live ? "bg-(--sc-accent)" : agent.status === "failed" ? "bg-(--sc-danger)" : "bg-(--sc-border)",
					)}
				/>
				<button
					aria-expanded={expanded}
					className="flex w-full items-start gap-1.5 rounded-(--sc-radius-md) py-2 pr-2.5 pl-2 text-left focus-visible:outline-2 focus-visible:outline-(--sc-accent)"
					onClick={onToggle}
					type="button"
				>
					<ChevronRight
						aria-hidden="true"
						className="omp-disclosure-chevron mt-0.5 shrink-0 text-(--sc-text-subtle)"
						size={14}
						style={{ transform: expanded ? "rotate(90deg)" : undefined }}
					/>
					<span className="min-w-0 flex-1">
						<span className="flex min-w-0 items-center gap-1.5">
							<span className="min-w-0 flex-1 truncate text-sc-md font-medium text-(--sc-text)" title={title}>
								{title}
							</span>
							<Badge dot={meta.live} pulse={meta.live} variant={meta.variant}>
								{t(meta.labelKey)}
							</Badge>
						</span>
						<span className="mt-1 flex min-w-0 items-center gap-1 text-sc-2xs text-(--sc-text-muted)">
							<Bot aria-hidden="true" className="shrink-0" size={14} />
							<span className="shrink-0">{agent.agent}</span>
							<span className="shrink-0 tabular-nums">#{agent.index + 1}</span>
							{model && <span className="min-w-0 truncate">· {model}</span>}
							{usage && <span className="shrink-0 tabular-nums">· {usage}</span>}
							{elapsed !== null && (
								<span className="ml-auto shrink-0 tabular-nums">{formatElapsed(elapsed)}</span>
							)}
						</span>
					</span>
				</button>
				{detail && (
					<div className="truncate px-6 pb-2 text-sc-sm text-(--sc-text-muted)" title={detail}>
						{detail}
					</div>
				)}
				{expanded && (
					<div className="border-t border-(--sc-border-subtle)">
						<SubagentTranscript agent={agent} />
					</div>
				)}
			</div>
		</div>
	);
});

function ViewToggle({ view, onChange }: { view: PanelView; onChange: (view: PanelView) => void }) {
	const t = useT();
	return (
		<div aria-label={t("subagentPanel.viewAria")} className="flex items-center gap-0.5" role="group">
			<IconButton
				icon={<List />}
				label={t("subagentPanel.listView")}
				onClick={() => onChange("list")}
				pressed={view === "list"}
				size="sm"
			/>
			<IconButton
				icon={<Network />}
				label={t("subagentPanel.graphView")}
				onClick={() => onChange("graph")}
				pressed={view === "graph"}
				size="sm"
			/>
		</div>
	);
}

export function AgentsDockCard({ pollMs = STREAM_POLL_MS }: { pollMs?: number }) {
	const t = useT();
	const { capture, isActive } = useTabGuard();
	const { managed, focusedCard, focusCard, clearFocus } = useWorkspaceDockFocus();
	const focused = focusedCard === "agents";
	const showFull = !managed || focused;
	const subagents = useSubagentsStore(state => state.subagents);
	const toolCallOwners = useSubagentGraphStore(state => state.toolCallOwners);
	const messages = useMessagesStore(state => state.messages);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const refresh = useSubagentsStore(state => state.refresh);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [view, setView] = useState<PanelView>("list");

	const agents = useMemo(() => [...subagents.values()].sort((a, b) => a.index - b.index), [subagents]);
	const hasRunning = agents.some(agent => isLiveSubagentStatus(agent.status));
	const runningCount = agents.filter(agent => isLiveSubagentStatus(agent.status)).length;
	const now = useNowTick(hasRunning);

	useEffect(() => {
		if (!isStreaming) return;
		const timer = setInterval(() => {
			// A poll resolving after a tab/session switch must not paint this
			// tab's agents over the new foreground session — the guard is
			// re-checked inside the store AFTER the await, before the write.
			const origin = capture();
			if (!isActive(origin)) return;
			void refresh({ expect: () => isActive(origin) });
		}, pollMs);
		return () => clearInterval(timer);
	}, [capture, isActive, isStreaming, pollMs, refresh]);

	const rootToolCallIds = useMemo(() => new Set(extractTaskToolCallIds(messages)), [messages]);
	const rows = useMemo(
		() => buildSubagentList(agents, rootToolCallIds, toolCallOwners),
		[agents, rootToolCallIds, toolCallOwners],
	);
	const summary = useMemo(() => buildAgentDockSummary(rows), [rows]);
	const displayedRows = showFull ? rows : summary.rows;

	const toggle = useCallback((id: string) => {
		setExpanded(prev => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const openAgent = useCallback(
		(id: string) => {
			if (managed && !focused) focusCard("agents");
			toggle(id);
		},
		[focusCard, focused, managed, toggle],
	);
	const changeView = useCallback(
		(next: PanelView) => {
			if (managed && next === "graph" && !focused) focusCard("agents");
			setView(next);
		},
		[focusCard, focused, managed],
	);

	useEffect(() => {
		if (focused && agents.length === 0) clearFocus();
	}, [agents.length, clearFocus, focused]);

	if (agents.length === 0) return null;

	return (
		<DockCard
			actions={<ViewToggle onChange={changeView} view={view} />}
			badge={
				<span className="shrink-0 tabular-nums">
					{runningCount > 0 ? `${runningCount}/${agents.length}` : agents.length}
				</span>
			}
			icon={Bot}
			id="agents"
			title={t("dock.agents")}
		>
			{view === "graph" ? (
				<div className="h-72">
					<SubagentDag />
				</div>
			) : (
				<div className="space-y-1.5 px-2 py-1.5" role="tree">
					{displayedRows.map(({ agent, depth }) => (
						<SubagentRow
							agent={agent}
							depth={depth}
							expanded={showFull && expanded.has(agent.id)}
							key={agent.id}
							now={now}
							onToggle={() => openAgent(agent.id)}
						/>
					))}
					{managed && !focused && summary.hiddenCount > 0 && (
						<Button className="w-full" onClick={() => focusCard("agents")} size="sm" variant="ghost">
							{t("dock.viewAllAgents", { hidden: summary.hiddenCount, total: summary.totalCount })}
						</Button>
					)}
				</div>
			)}
		</DockCard>
	);
}
