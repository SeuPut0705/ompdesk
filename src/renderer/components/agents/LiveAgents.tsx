/**
 * Agents › Live: the session's subagents (running, parked, finished) from the
 * subagents store (get_subagents hydration + lifecycle frames), with status,
 * elapsed time, model and the latest progress note. While the session's model
 * pool is on, a subagent that ran on a pool model names that member and its
 * role instead of the bare selector. Each row opens the agent's transcript in
 * a Sheet; row actions stop (inline-confirmed abort_subagent) or revive
 * (revive_subagent) one agent. Toolbar: pause / resume every agent, and stop
 * the whole turn while something runs.
 */

import { Bot, Check, MessageSquare, Pause, Play, RefreshCw, RotateCcw, Square, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { RpcModelPoolMember, SubagentSnapshot } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { abortActiveTurn } from "../../lib/messages";
import { isPresetRole, poolMemberFor } from "../../lib/model-pool";
import { useNowTick } from "../../lib/now-tick";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { useSubagentsStore } from "../../stores/subagents";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Badge, Button, EmptyState, IconButton, ListRow, Sheet } from "../common";
import { SubagentTranscript } from "../panels/SubagentTranscript";
import {
	formatElapsed,
	isLiveSubagentStatus,
	statusMeta,
	subagentElapsedMs,
	subagentPrimaryLabel,
} from "../panels/subagent-graph";
import { agentSourceLabel } from "./agent-settings";

/**
 * Running first, then failed, stopped, done; recency breaks ties. Keyed by the
 * live predicate rather than raw status strings: the wire status is free-form
 * (`running`/`pending`/`idle`/`parked`/`aborted` all occur).
 */
function statusOrder(status: string): number {
	if (isLiveSubagentStatus(status)) return 0;
	if (status === "failed") return 1;
	if (status === "cancelled" || status === "aborted") return 2;
	return 3;
}

const REASON_KEY: Record<string, string> = {
	advisor_readonly: "agentHub.hub.reason.advisorReadonly",
	main_agent: "agentHub.hub.reason.mainAgent",
	not_found: "agentHub.hub.reason.notFound",
	not_parked: "agentHub.hub.reason.notParked",
};

type RowActionState = "idle" | "confirming" | "working";

const AgentRow = memo(function AgentRow({
	agent,
	now,
	actionState,
	poolMember,
	ready,
	onView,
	onAbort,
	onAbortConfirm,
	onAbortCancel,
	onRevive,
}: {
	agent: SubagentSnapshot;
	now: number;
	actionState: RowActionState;
	/** The model-pool member this agent ran on (pool on and its model listed). */
	poolMember: RpcModelPoolMember | undefined;
	ready: boolean;
	onView: () => void;
	onAbort: () => void;
	onAbortConfirm: () => void;
	onAbortCancel: () => void;
	onRevive: () => void;
}) {
	const t = useT();
	const meta = statusMeta(agent.status);
	const elapsed = subagentElapsedMs(agent, now);
	const title = subagentPrimaryLabel(agent);
	// A stale registration has no live turn, but cancel is the recovery action
	// upstream exposes specifically for clearing it from the registry.
	const stoppable = (meta.live || agent.status === "stale") && agent.kind !== "advisor";
	const revivable = agent.status === "parked" && agent.kind !== "advisor";
	const notConnected = !ready ? t("agentHub.notConnected") : undefined;
	const description = [
		agent.agent,
		agent.agentSource ? agentSourceLabel(t, agent.agentSource) : undefined,
		agent.kind === "advisor" ? t("agentHub.hub.readOnly") : t("agentHub.hub.kind.sub"),
		poolMember
			? t("modelPool.liveLabel", {
					name: poolMember.name,
					role: isPresetRole(poolMember.role) ? t(`modelPool.role.${poolMember.role}`) : poolMember.role,
				})
			: agent.progress?.resolvedModel,
		agent.progress?.description,
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<ListRow
			actions={
				<>
					<IconButton icon={<MessageSquare />} label={t("agentHub.hub.viewMessages")} onClick={onView} size="sm" />
					{stoppable && actionState !== "confirming" && (
						<IconButton
							disabled={actionState === "working" || !ready}
							icon={<Square />}
							label={t("agentHub.hub.abortAgent")}
							onClick={onAbort}
							size="sm"
							title={notConnected}
						/>
					)}
					{stoppable && actionState === "confirming" && (
						<>
							<IconButton
								autoFocus
								disabled={!ready}
								icon={<Check />}
								label={t("agentHub.hub.confirmAbort")}
								onClick={onAbortConfirm}
								size="sm"
								variant="danger"
							/>
							<IconButton icon={<X />} label={t("agentHub.hub.cancelAbort")} onClick={onAbortCancel} size="sm" />
						</>
					)}
					{revivable && (
						<IconButton
							disabled={actionState === "working" || !ready}
							icon={<RotateCcw />}
							label={t("agentHub.hub.reviveAgent")}
							onClick={onRevive}
							size="sm"
							title={notConnected}
						/>
					)}
				</>
			}
			description={description}
			leading={
				<Badge dot pulse={meta.live} variant={meta.variant}>
					{t(meta.labelKey)}
				</Badge>
			}
			meta={elapsed !== null ? formatElapsed(elapsed) : undefined}
			onClick={onView}
			selected={actionState === "confirming"}
			title={title}
			titleText={title}
		/>
	);
});

export function LiveAgents() {
	const tabRpc = useTabRpc();
	const t = useT();
	const ready = useSessionStore(s => s.status) === "ready";
	const agentsPaused = useSessionStore(s => s.agentsPaused);
	const subagents = useSubagentsStore(s => s.subagents);
	const pool = useSessionStore(s => s.modelPool);
	const loadError = useSubagentsStore(s => s.error);
	const openAgents = useUiStore(s => s.openAgents);
	const [pausePending, setPausePending] = useState(false);
	const [stopping, setStopping] = useState(false);
	const [viewingId, setViewingId] = useState<string | null>(null);
	const [rowAction, setRowAction] = useState<{ id: string; state: "confirming" | "working" } | null>(null);

	// The transcript sheet closes if its agent leaves the roster (released mid-view).
	useEffect(() => {
		if (viewingId !== null && !subagents.has(viewingId)) setViewingId(null);
	}, [viewingId, subagents]);
	const viewing = viewingId !== null ? (subagents.get(viewingId) ?? null) : null;

	const sorted = useMemo(
		() => [...subagents.values()].sort((a, b) => statusOrder(a.status) - statusOrder(b.status) || b.index - a.index),
		[subagents],
	);
	// Per-status tallies over the statuses actually on the wire (unknown ones included).
	const counts = useMemo(() => {
		const result = new Map<string, number>();
		for (const agent of subagents.values()) result.set(agent.status, (result.get(agent.status) ?? 0) + 1);
		return result;
	}, [subagents]);
	const hasRunning = sorted.some(agent => isLiveSubagentStatus(agent.status));
	const now = useNowTick(hasRunning);

	const stopTurn = useCallback(async () => {
		if (!ready) return;
		setStopping(true);
		try {
			const res = await abortActiveTurn();
			if (!res.success) toast({ variant: "error", title: t("agentHub.hub.abortFailed"), message: res.error });
		} catch (cause) {
			toast({ variant: "error", title: t("agentHub.hub.abortFailed"), message: String(cause) });
		} finally {
			setStopping(false);
		}
	}, [ready, t]);

	const togglePaused = useCallback(async () => {
		if (!ready || pausePending) return;
		setPausePending(true);
		try {
			const response = await tabRpc.setAgentsPaused(!agentsPaused);
			if (!response.success) throw new Error(response.error);
			const data = response.data as { paused?: boolean; pausedAt?: number } | undefined;
			const paused = data?.paused ?? !agentsPaused;
			useSessionStore.setState({
				agentsPaused: paused,
				agentsPausedAt: paused ? (data?.pausedAt ?? Date.now()) : null,
			});
		} catch (cause) {
			toast({ variant: "error", title: t("agentHub.hub.pauseFailed"), message: String(cause) });
		} finally {
			setPausePending(false);
		}
	}, [agentsPaused, pausePending, ready, t, tabRpc.setAgentsPaused]);

	// Refetch after each lifecycle action — a release/revival may not emit a
	// frame. The store refresh merges, so finished agents survive the fetch.
	const refresh = useCallback(() => {
		if (!ready) return;
		return useSubagentsStore.getState().refresh();
	}, [ready]);

	const runRowAction = useCallback(
		async (id: string, action: "abort" | "revive") => {
			if (!ready) return;
			const failTitle = action === "abort" ? t("agentHub.hub.abortAgentFailed") : t("agentHub.hub.reviveFailed");
			setRowAction({ id, state: "working" });
			try {
				const res = action === "abort" ? await tabRpc.abortSubagent(id) : await tabRpc.reviveSubagent(id);
				if (!res.success) {
					toast({ variant: "error", title: failTitle, message: res.error });
					return;
				}
				const data = res.data as { ok?: boolean; reason?: string } | undefined;
				if (!data?.ok) {
					const reasonKey = (data?.reason && REASON_KEY[data.reason]) || "agentHub.hub.reason.abortFailed";
					toast({ variant: "error", title: failTitle, message: t(reasonKey) });
					return;
				}
				await refresh();
			} catch (cause) {
				toast({ variant: "error", title: failTitle, message: String(cause) });
			} finally {
				setRowAction(null);
			}
		},
		[ready, t, refresh, tabRpc.abortSubagent, tabRpc.reviveSubagent],
	);

	const notConnected = !ready ? t("agentHub.notConnected") : undefined;

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-2">
				{[...counts].map(([status, count]) => {
					const meta = statusMeta(status);
					return (
						<Badge dot key={status} pulse={meta.live} variant={meta.variant}>
							{t(meta.labelKey)} {count}
						</Badge>
					);
				})}
				{pool?.enabled && (
					<Badge variant="accent">{t("modelPool.liveActive", { count: pool.members.length })}</Badge>
				)}
				<div className="ml-auto flex items-center gap-2">
					<Button
						aria-pressed={agentsPaused}
						disabled={!ready}
						icon={agentsPaused ? <Play /> : <Pause />}
						loading={pausePending}
						onClick={() => void togglePaused()}
						size="sm"
						title={notConnected ?? (agentsPaused ? t("agentHub.hub.resumeAgents") : t("cmd.pause.desc"))}
						variant="secondary"
					>
						{agentsPaused ? t("agentHub.hub.resumeAgents") : t("agentHub.hub.pauseAgents")}
					</Button>
					{hasRunning && (
						<Button
							disabled={!ready}
							icon={<Square />}
							loading={stopping}
							onClick={() => void stopTurn()}
							size="sm"
							title={notConnected}
							variant="secondary"
						>
							{t("agentHub.hub.abortTurn")}
						</Button>
					)}
				</div>
			</div>

			{sorted.length === 0 ? (
				// A roster that never loaded is a different claim from none spawned.
				loadError ? (
					<EmptyState
						actions={
							<Button
								disabled={!ready}
								icon={<RefreshCw />}
								onClick={() => void refresh()}
								size="sm"
								title={notConnected}
								variant="secondary"
							>
								{t("common.retry")}
							</Button>
						}
						description={<span role="alert">{loadError}</span>}
						icon={<Bot />}
						title={t("subagent.loadFailed")}
					/>
				) : (
					<EmptyState
						actions={
							<Button onClick={() => openAgents("definitions")} size="sm" variant="secondary">
								{t("agents.live.viewDefinitions")}
							</Button>
						}
						description={t("subagent.emptyHint")}
						icon={<Bot />}
						title={t("subagent.empty")}
					/>
				)
			) : (
				<div className="flex flex-col gap-0.5">
					{sorted.map(agent => (
						<AgentRow
							actionState={rowAction?.id === agent.id ? rowAction.state : "idle"}
							agent={agent}
							key={agent.id}
							now={now}
							onAbort={() => setRowAction({ id: agent.id, state: "confirming" })}
							onAbortCancel={() => setRowAction(null)}
							onAbortConfirm={() => void runRowAction(agent.id, "abort")}
							onRevive={() => void runRowAction(agent.id, "revive")}
							onView={() => setViewingId(agent.id)}
							poolMember={poolMemberFor(pool, agent.progress?.resolvedModel)}
							ready={ready}
						/>
					))}
				</div>
			)}

			<Sheet
				description={viewing ? `${viewing.agent} · ${t(statusMeta(viewing.status).labelKey)}` : undefined}
				onClose={() => setViewingId(null)}
				open={viewing !== null}
				size="lg"
				title={viewing ? subagentPrimaryLabel(viewing) : ""}
			>
				{viewing && <SubagentTranscript agent={viewing} />}
			</Sheet>
		</div>
	);
}
