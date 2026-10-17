import { PanelRight } from "lucide-react";
import { formatCost, formatTokens } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useAutopilotStore } from "../../../stores/autopilot";
import { useUiStore } from "../../../stores/ui";
import { Button } from "../../common";
import { AreaIcon } from "./AreaIcon";
import { AutopilotStopButtons } from "./AutopilotControls";
import { useCycleCalls } from "./AutopilotNow";
import { autopilotChip, autopilotStep } from "./autopilot-view";
import { useAutopilotReservation } from "./use-autopilot-reservation";

const RECENT_CYCLES = 3;

/** The one-line state the card and the chip share ("Cycle 7 · Performance", "Ending…", "Paused: …"). */
export function useAutopilotStateText(): string | null {
	const t = useT();
	const status = useAutopilotStore(s => s.status);
	const reservation = useAutopilotReservation();
	const chip = autopilotChip(status, reservation);
	if (!chip) return null;
	switch (chip.kind) {
		case "stopping":
			return t("autopilot.stopping");
		case "paused":
			return chip.reason ? t(`autopilot.reason.${chip.reason}`) : t("autopilot.state.paused");
		case "quota":
			return chip.until === undefined
				? t("autopilot.state.waiting_quota")
				: t("autopilot.chip.quotaUntil", {
						time: new Date(chip.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
					});
		default:
			return chip.cycle > 0
				? chip.area
					? t("autopilot.cycleArea", { n: chip.cycle, area: t(`autopilot.area.${chip.area}`) })
					: t("autopilot.cycleN", { n: chip.cycle })
				: t("autopilot.state.running");
	}
}

/**
 * The work board's Autopilot card, as `<li>` rows for the board's own section: the state with the step in progress,
 * the last three cycles, the cost and shipping in a line each, and the two stops beside "open the screen".
 */
export function AutopilotBoardRows() {
	const t = useT();
	const text = useAutopilotStateText();
	const cycles = useAutopilotStore(s => s.status.cycles);
	const now = useAutopilotStore(s => s.status.now);
	const totals = useAutopilotStore(s => s.status.totals);
	const policy = useAutopilotStore(s => s.status.ship?.policy);
	const state = useAutopilotStore(s => s.status.state);
	const calls = useCycleCalls(now?.startedAt);
	const step = autopilotStep(calls);
	const recent = [...(cycles ?? [])].sort((a, b) => b.n - a.n).slice(0, RECENT_CYCLES);
	const ship = policy
		? policy.autoRelease.on
			? t("autopilot.board.shipRelease")
			: policy.autoPush
				? t("autopilot.board.shipPush")
				: t("autopilot.board.shipLocal")
		: null;
	return (
		<>
			<li className="omp-work-board-item" data-board-autopilot={state ?? ""}>
				<div className="omp-work-board-row">
					<span className="omp-work-board-lead">
						<span
							aria-hidden
							className="omp-work-board-dot"
							data-ring={state === "running" || undefined}
							data-tone={
								state === "running" ? "info" : state === "paused" || state === "stopping" ? "warning" : "muted"
							}
						/>
					</span>
					<span className="flex min-w-0 flex-1 flex-col">
						<span className="truncate" data-board-autopilot-text>
							{text}
						</span>
						{step && state === "running" && (
							<span className="omp-work-board-sub">{t(`autopilot.step.${step}`)}</span>
						)}
					</span>
				</div>
			</li>
			{recent.map(cycle => (
				<li className="omp-work-board-item" data-board-cycle={cycle.n} key={cycle.n}>
					<div className="omp-work-board-row" title={cycle.summary || cycle.title}>
						<span className="omp-work-board-lead">
							<AreaIcon area={cycle.area} />
						</span>
						<span className="min-w-0 flex-1 truncate">{cycle.title.trim() || t("autopilot.untitled")}</span>
						<span className="omp-work-board-meta">
							<span
								aria-label={t(`autopilot.verify.${cycle.verify}`)}
								className="omp-work-board-dot"
								data-tone={cycle.verify === "green" ? "success" : cycle.verify === "red" ? "warning" : "muted"}
								role="img"
							/>
						</span>
					</div>
				</li>
			))}
			{(totals || ship) && (
				<li className="omp-work-board-item">
					<div className="omp-work-board-row">
						<span
							className="min-w-0 flex-1 truncate tabular-nums text-(--sc-text-muted)"
							data-board-autopilot-totals
						>
							{[totals ? `${formatTokens(totals.tokens)} · ${formatCost(totals.usd, 2)}` : null, ship]
								.filter(Boolean)
								.join(" · ")}
						</span>
					</div>
				</li>
			)}
			<li className="omp-work-board-item">
				<div className="flex flex-wrap items-center gap-1.5 px-1 pt-1">
					<AutopilotStopButtons size="sm" />
					<Button
						data-board-autopilot-open
						icon={<PanelRight aria-hidden />}
						onClick={() => useUiStore.getState().openAutopilotPanel()}
						size="sm"
						variant="ghost"
					>
						{t("autopilot.board.open")}
					</Button>
				</div>
			</li>
		</>
	);
}
