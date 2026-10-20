import { Bot, ChevronDown, GitBranch, SquareTerminal } from "lucide-react";
import {
	lazy,
	type ReactNode,
	Suspense,
	type TouchEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useBackLayer } from "../../../hooks/use-back-layer";
import { useBackgroundJobs } from "../../../hooks/use-background-jobs";
import { useOpenedChildren } from "../../../hooks/use-opened-children";
import { useT } from "../../../lib/i18n";
import { ensureAgentReviewSubscription, useAgentReviewStore } from "../../../stores/agent-review";
import { isUserBlockingRequest, useExtensionUiStore } from "../../../stores/extension-ui";
import { usePlanApprovalStore } from "../../../stores/plan-approval";
import { useSessionStore } from "../../../stores/session";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { selectTodoCardVisible, useTodoStore } from "../../../stores/todo";
import { liveSubagents, todoBoard } from "./work-board";

const PANEL_ID = "omp-work-strip-panel";
/** Exit time of the panel's height transition (mobile.css `omp-strip-out`). */
const LEAVE_MS = 160;
/** An upward drag at least this long on the strip or the grip collapses the panel. */
const SWIPE_UP_PX = 32;
/** The session rows' rules (`WorkBoardSession.tsx`), loaded after the first screen: only whether the newest check failed. */
const FailedCheckWatch = lazy(() =>
	import("./WorkBoardSession").then(module => ({ default: module.FailedCheckWatch })),
);

/**
 * The work board where it has no room beside the pane (a phone, a portrait tablet; design §6.3): one status strip
 * under the header — what waits for you first, then the turn, the plan's progress with the current task, the
 * running subagents and jobs — and a tap expands the strip itself downward into the board, an inline panel over
 * the top of the transcript (no scrim, nothing dimmed, nothing pushed). It collapses on a second tap, a swipe up
 * on the strip or the panel's grip, the back gesture, a tap outside, or a tap on a row (which also acts). Nothing
 * is remembered: every mount starts collapsed. The strip says what the dock's todo card would, so mobile.css hides
 * that card beside it. The line is a live region, so the board's announcements stay.
 */
export function WorkBoardChip({ children }: { children: ReactNode }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	/** The panel stays mounted for its exit (height transition); never under reduced motion. */
	const [leaving, setLeaving] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const swipe = useRef<number | null>(null);
	const leaveTimer = useRef<number | undefined>(undefined);
	const close = useCallback(() => {
		setOpen(false);
		window.clearTimeout(leaveTimer.current);
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true) return;
		setLeaving(true);
		leaveTimer.current = window.setTimeout(() => setLeaving(false), LEAVE_MS);
	}, []);
	useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
	useBackLayer(open, close);
	const turnActive = useTodoStore(state => state.turnActive);
	const phases = useTodoStore(state => state.phases);
	const planVisible = useTodoStore(selectTodoCardVisible);
	const plan = useMemo(() => (planVisible ? todoBoard(phases) : null), [phases, planVisible]);
	const subagents = useSubagentsStore(state => state.subagents);
	const agents = useMemo(() => liveSubagents(subagents), [subagents]);
	const jobs = useBackgroundJobs();
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const opened = useOpenedChildren(runtimeTabId ?? activeTabId);
	// The board asks for the opened sessions when it mounts; the strip mounts it only when expanded, so it asks itself
	// (a phone viewing a desktop's session knows the children only from this list).
	useEffect(() => {
		const tabId = runtimeTabId ?? activeTabId;
		ensureAgentReviewSubscription();
		if (tabId) void useAgentReviewStore.getState().refresh(tabId);
	}, [runtimeTabId, activeTabId]);
	const goal = useSessionStore(state => state.goal);
	const pending = useExtensionUiStore(state => state.pendingRequests);
	const loginRequestIds = useExtensionUiStore(state => state.loginRequestIds);
	const blocking = useMemo(
		() => pending.filter(request => isUserBlockingRequest({ loginRequestIds }, request)),
		[pending, loginRequestIds],
	);
	const planProposal = usePlanApprovalStore(state => state.pending);

	const waiting = blocking.length + (planProposal ? 1 : 0) + opened.counts.waiting;
	const running = agents.length + jobs.length + opened.counts.running;
	// A failed check is said right after what waits on the person: the board puts it at its top too. Its rules are the
	// session rows' lazy chunk (the phone's first screen has no room), which reports here once loaded.
	const [failed, setFailed] = useState(false);
	const label =
		waiting > 0
			? t("workBoard.status.waiting", { count: waiting })
			: failed
				? t("workBoard.session.checkFailed")
				: plan
					? t("workBoard.planProgress", { done: plan.done, total: plan.total })
					: turnActive
						? t("workBoard.step.working")
						: running > 0
							? `${t("workBoard.running")} · ${running}`
							: goal
								? t("workBoard.goal")
								: null;
	// What the strip says is gone (the run ended and the board emptied): nothing to expand either.
	useEffect(() => {
		if (label === null && open) close();
	}, [label, open, close]);
	// A tap outside collapses it; the tap itself still reaches what it hit (a listener, not a backdrop).
	useEffect(() => {
		if (!open) return;
		const away = (event: Event) => {
			if (event.target instanceof Node && !root.current?.contains(event.target)) close();
		};
		document.addEventListener("pointerdown", away);
		return () => document.removeEventListener("pointerdown", away);
	}, [open, close]);
	const watch = (
		<Suspense fallback={null}>
			<FailedCheckWatch onChange={setFailed} />
		</Suspense>
	);
	if (label === null) return watch;
	const swipeStart = (event: TouchEvent<HTMLElement>) => {
		swipe.current = event.touches[0]?.clientY ?? null;
	};
	const swipeEnd = (event: TouchEvent<HTMLElement>) => {
		const from = swipe.current;
		swipe.current = null;
		const to = event.changedTouches[0]?.clientY;
		if (open && from !== null && to !== undefined && from - to >= SWIPE_UP_PX) close();
	};
	const state = waiting > 0 ? "waiting" : turnActive || running > 0 ? "working" : "idle";
	return (
		<div className="omp-work-strip" data-work-strip="" ref={root}>
			{watch}
			<button
				aria-controls={open || leaving ? PANEL_ID : undefined}
				aria-expanded={open}
				className="omp-work-chip"
				data-open={open || undefined}
				data-state={state}
				data-work-chip=""
				onClick={() => (open ? close() : setOpen(true))}
				onTouchEnd={swipeEnd}
				onTouchStart={swipeStart}
				type="button"
			>
				<span aria-hidden className="omp-work-board-pulse" data-state={state} />
				<span aria-live="polite" className="omp-work-chip-label" role="status">
					{plan && waiting === 0 && !failed ? (
						<>
							<span className="sr-only">{label}</span>
							<span aria-hidden className="omp-work-chip-plan">
								<span className="omp-work-chip-bar">
									<span style={{ width: `${(plan.done / plan.total) * 100}%` }} />
								</span>
								<span className="tabular-nums">
									{plan.done}/{plan.total}
								</span>
								{plan.active ? <span className="omp-work-chip-active">{plan.active}</span> : null}
							</span>
						</>
					) : (
						label
					)}
				</span>
				{opened.counts.total > 0 && (
					<span aria-hidden className="omp-work-chip-count" data-count="sessions">
						<GitBranch className="size-(--sc-icon-sm)" />
						{opened.counts.total}
					</span>
				)}
				{agents.length > 0 && (
					<span aria-hidden className="omp-work-chip-count" data-count="agents">
						<Bot className="size-(--sc-icon-sm)" />
						{agents.length}
					</span>
				)}
				{jobs.length > 0 && (
					<span aria-hidden className="omp-work-chip-count" data-count="jobs">
						<SquareTerminal className="size-(--sc-icon-sm)" />
						{jobs.length}
					</span>
				)}
				<ChevronDown
					aria-hidden
					className="omp-work-chip-chevron size-(--sc-icon-md) shrink-0 text-(--sc-text-muted)"
				/>
			</button>
			{(open || leaving) && (
				<div
					className="omp-work-strip-panel"
					data-leaving={!open || undefined}
					data-work-strip-panel=""
					id={PANEL_ID}
					// A tap on a row acts (its own handler runs first) and collapses; the fold toggles keep the panel
					// open.
					onClick={event => {
						if (event.target instanceof Element && event.target.closest("button.omp-work-board-row")) close();
					}}
				>
					<div className="omp-work-strip-body">{children}</div>
					<div aria-hidden className="omp-work-strip-grip" onTouchEnd={swipeEnd} onTouchStart={swipeStart} />
				</div>
			)}
		</div>
	);
}
