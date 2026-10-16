import { ChevronUp } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useBackgroundJobs } from "../../../hooks/use-background-jobs";
import { useT } from "../../../lib/i18n";
import { isUserBlockingRequest, useExtensionUiStore } from "../../../stores/extension-ui";
import { usePlanApprovalStore } from "../../../stores/plan-approval";
import { useSessionStore } from "../../../stores/session";
import { useSubagentsStore } from "../../../stores/subagents";
import { selectTodoCardVisible, useTodoStore } from "../../../stores/todo";
import { Sheet } from "../../common";
import { liveSubagents, todoBoard } from "./work-board";

/**
 * The work board where it has no room beside the pane (a phone, a portrait tablet; design §6.3): one status line
 * above the composer — what waits for you first, then the turn, the plan's progress, what runs — and a tap
 * opens the board itself in a bottom sheet. The line is a live region, so the board's announcements stay.
 */
export function WorkBoardChip({ children }: { children: ReactNode }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const turnActive = useTodoStore(state => state.turnActive);
	const phases = useTodoStore(state => state.phases);
	const planVisible = useTodoStore(selectTodoCardVisible);
	const plan = useMemo(() => (planVisible ? todoBoard(phases) : null), [phases, planVisible]);
	const subagents = useSubagentsStore(state => state.subagents);
	const agents = useMemo(() => liveSubagents(subagents), [subagents]);
	const jobs = useBackgroundJobs();
	const goal = useSessionStore(state => state.goal);
	const pending = useExtensionUiStore(state => state.pendingRequests);
	const loginRequestIds = useExtensionUiStore(state => state.loginRequestIds);
	const blocking = useMemo(
		() => pending.filter(request => isUserBlockingRequest({ loginRequestIds }, request)),
		[pending, loginRequestIds],
	);
	const planProposal = usePlanApprovalStore(state => state.pending);

	const waiting = blocking.length + (planProposal ? 1 : 0);
	const running = agents.length + jobs.length;
	const label =
		waiting > 0
			? t("workBoard.status.waiting", { count: waiting })
			: plan
				? t("workBoard.planProgress", { done: plan.done, total: plan.total })
				: turnActive
					? t("workBoard.step.working")
					: running > 0
						? `${t("workBoard.running")} · ${running}`
						: goal
							? t("workBoard.goal")
							: null;
	if (label === null) return null;
	const state = waiting > 0 ? "waiting" : turnActive || running > 0 ? "working" : "idle";
	return (
		<>
			<button
				aria-expanded={open}
				aria-haspopup="dialog"
				className="omp-work-chip"
				data-state={state}
				data-work-chip=""
				onClick={() => setOpen(true)}
				type="button"
			>
				<span aria-hidden className="omp-work-board-pulse" data-state={state} />
				<span aria-live="polite" className="omp-work-chip-label" role="status">
					{label}
				</span>
				<ChevronUp aria-hidden className="size-(--sc-icon-md) shrink-0 text-(--sc-text-muted)" />
			</button>
			<Sheet
				bodyClassName="omp-work-chip-sheet px-3 pb-3"
				onClose={() => setOpen(false)}
				open={open}
				placement="bottom"
				title={t("workBoard.label")}
			>
				{children}
			</Sheet>
		</>
	);
}
