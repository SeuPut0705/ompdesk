import { GitBranch } from "lucide-react";
import { useEffect, useRef } from "react";
import type { AutopilotState } from "../../../../../resources/gui-bridge/modes/autopilot-contracts";
import { formatCost, formatDuration, formatTokens } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useNowTick } from "../../../lib/now-tick";
import { useTabRpc } from "../../../lib/tab-rpc";
import { tabAutopilotStore, useAutopilotStore } from "../../../stores/autopilot";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { Badge, type BadgeVariant, Tooltip } from "../../common";
import { ratePrediction } from "./autopilot-view";

export const STATE_BADGE: Record<AutopilotState, BadgeVariant> = {
	running: "success",
	stopping: "warning",
	paused: "warning",
	waiting_quota: "info",
	ended: "muted",
};

/** Commits the branch is ahead of / behind the branch it was cut from, read again whenever the run's shape changes. */
function useBranchStatus(): void {
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const root = useAutopilotStore(s => s.status.root);
	const base = useAutopilotStore(s => s.status.baseBranch);
	const branch = useAutopilotStore(s => s.status.branch);
	const finished = useAutopilotStore(s => s.status.cycles?.length ?? 0);
	const state = useAutopilotStore(s => s.status.state);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a finished cycle or a state change moves the branch.
	useEffect(() => {
		if (!root || !base || !branch) return;
		let live = true;
		void rpc
			.autopilotBranchStatus(root, base, branch)
			.then(response => {
				if (!live || !response.success) return;
				const data = response.data as { ahead?: unknown; behind?: unknown } | undefined;
				if (typeof data?.ahead === "number" && typeof data.behind === "number")
					tabAutopilotStore(tabId).getState().setBranchStatus({ ahead: data.ahead, behind: data.behind });
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [rpc, tabId, root, base, branch, finished, state]);
}

/** Status badge, cycle, time active, branch against its base, and the tokens and dollars spent (with the pace). */
export function AutopilotHeader() {
	const t = useT();
	useBranchStatus();
	const status = useAutopilotStore(s => s.status);
	const branchStatus = useAutopilotStore(s => s.branchStatus);
	const state = status.state ?? "running";
	// The coordinator reports the active time at each change; between them a running run keeps counting.
	const receivedAt = useRef(Date.now());
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new status restarts the count from its own active time.
	useEffect(() => {
		receivedAt.current = Date.now();
	}, [status]);
	const now = useNowTick(state === "running");
	const activeMs = (status.activeMs ?? 0) + (state === "running" ? Math.max(0, now - receivedAt.current) : 0);
	const cycle = status.now?.n ?? status.cycle ?? 0;
	const rate = ratePrediction(status.cycles ?? []);
	const tokensPerHour = status.totals?.tokensPerHour ?? rate?.tokensPerHour;
	const usdPerHour = status.totals?.usdPerHour ?? rate?.usdPerHour;
	return (
		<header className="flex flex-col gap-1.5 px-3 py-3" data-autopilot-header>
			<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
				<Badge dot pulse={state === "running"} variant={STATE_BADGE[state]}>
					<span data-autopilot-state={state}>{t(`autopilot.state.${state}`)}</span>
				</Badge>
				{cycle > 0 && <span className="text-sc-sm font-medium">{t("autopilot.cycleN", { n: cycle })}</span>}
				<span className="text-sc-sm text-(--sc-text-muted) tabular-nums">{formatDuration(activeMs)}</span>
			</div>
			{status.branch && (
				<div className="flex min-w-0 items-center gap-1.5 text-sc-xs text-(--sc-text-secondary)">
					<GitBranch aria-hidden className="size-(--sc-icon-sm) shrink-0" />
					<span className="min-w-0 truncate font-mono" title={status.branch}>
						{status.branch}
					</span>
					{branchStatus && (
						<span className="shrink-0 tabular-nums text-(--sc-text-muted)" data-autopilot-ahead>
							{t("autopilot.ahead", {
								ahead: branchStatus.ahead,
								behind: branchStatus.behind,
								base: status.baseBranch ?? "",
							})}
						</span>
					)}
				</div>
			)}
			{status.totals && (
				<Tooltip
					content={
						rate || tokensPerHour !== undefined
							? t("autopilot.rateTip", { sample: rate?.sample ?? 5 })
							: t("autopilot.rateNone")
					}
				>
					<div
						className="flex flex-wrap items-baseline gap-x-3 text-sc-xs text-(--sc-text-secondary) tabular-nums"
						data-autopilot-totals
					>
						<span>
							{t("autopilot.tokens", { tokens: formatTokens(status.totals.tokens) })} ·{" "}
							{formatCost(status.totals.usd, 2)}
						</span>
						{tokensPerHour !== undefined && usdPerHour !== undefined && (
							<span className="text-(--sc-text-muted)">
								≈{" "}
								{t("autopilot.perHour", {
									tokens: formatTokens(tokensPerHour),
									usd: formatCost(usdPerHour, 2),
								})}
							</span>
						)}
					</div>
				</Tooltip>
			)}
			{status.reason && (state === "paused" || state === "ended") && (
				<p className="text-sc-xs text-(--sc-text-muted)" data-autopilot-reason={status.reason}>
					{t(`autopilot.reason.${status.reason}`)}
					{status.detail ? ` — ${status.detail}` : ""}
				</p>
			)}
		</header>
	);
}
