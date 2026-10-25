import { Bot, ChevronDown, GitBranch, Rocket, SquareTerminal } from "lucide-react";
import {
	type CSSProperties,
	type ReactNode,
	type RefObject,
	type TouchEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useBackLayer } from "../../../hooks/use-back-layer";
import { useBackgroundJobs } from "../../../hooks/use-background-jobs";
import { useOpenedChildren } from "../../../hooks/use-opened-children";
import { pendingAsks } from "../../../lib/attention";
import { useT } from "../../../lib/i18n";
import { ensureAgentReviewSubscription, useAgentReviewStore } from "../../../stores/agent-review";
import { useCheckFailed } from "../../../stores/attention";
import { isAutopilotTab, isLiveAutopilot, useAutopilotStore } from "../../../stores/autopilot";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { usePlanApprovalStore } from "../../../stores/plan-approval";
import { useSessionStore } from "../../../stores/session";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { selectTodoCardVisible, useTodoStore } from "../../../stores/todo";
import { useAutopilotStateText } from "../../autopilot/use-autopilot-state-text";
import { SummaryBoard, type ZoneOpen } from "./board-parts";
import { attentionClause, boardCounts, liveSubagents, todoBoard, workingSubagents } from "./work-board";

const PANEL_ID = "omp-work-strip-panel";
/** Exit time of the panel's height transition (mobile.css `omp-strip-out`). */
const LEAVE_MS = 160;
/** An upward drag at least this long on the strip or the grip collapses the panel. */
const SWIPE_UP_PX = 32;
/** Space kept between the panel's far edge and its pane's edge. */
const ROOM_MARGIN_PX = 8;
/** Room above the strip that still shows a few of the board's rows: the panel opens upward from this much. */
const MIN_UP_PX = 160;

interface StripRoom {
	/** The panel opens above the strip (clear of the composer) when its pane leaves room for a few rows there. */
	up: boolean;
	/** That side's room: `--strip-room` caps the panel's height below the stylesheet's 50dvh. */
	px: number;
}

/**
 * Where the panel opens and how tall it may be. A phone's strip sits under the header, so it opens downward over the
 * transcript; a desktop window's sits in the dock just above the composer, where opening downward covered the
 * composer and ran past the window (22 Oct 2026), so it opens upward while {@link MIN_UP_PX} fits there. A short
 * pane (a short window, a split stacked in two, a question card filling the dock) can leave less: then it opens
 * downward, over the dock and never past the composer's top. Measured again
 * when the pane resizes or anything beside the strip on the way up to it is added or resizes (a card appearing in the
 * dock moves the strip without resizing it).
 */
function useStripRoom(root: RefObject<HTMLDivElement | null>, open: boolean, shown: boolean): StripRoom | undefined {
	const [room, setRoom] = useState<StripRoom | undefined>(undefined);
	// biome-ignore lint/correctness/useExhaustiveDependencies: measured once the strip shows and again at each open.
	useLayoutEffect(() => {
		const strip = root.current;
		if (!strip) return;
		const pane = strip.closest(".omp-session-pane") ?? document.documentElement;
		const measure = (): void => {
			const box = strip.getBoundingClientRect();
			const bounds = pane.getBoundingClientRect();
			const above = box.top - bounds.top;
			// Downward it stops at the pane's composer, never over it (the composer sits below the strip in every shell).
			const composer = pane.querySelector(".omp-composer-box")?.getBoundingClientRect();
			const floor = composer && composer.top > box.bottom ? composer.top : bounds.bottom;
			const below = floor - box.bottom;
			const up = above - ROOM_MARGIN_PX >= MIN_UP_PX || above > below;
			const px = Math.max(0, Math.floor((up ? above : below) - ROOM_MARGIN_PX));
			setRoom(previous => (previous?.up === up && previous.px === px ? previous : { up, px }));
		};
		const resized = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
		const ancestors: Element[] = [];
		for (let node: Element = strip; node !== pane && node.parentElement; node = node.parentElement)
			ancestors.push(node.parentElement);
		// Every sibling on the way up, also one added later (a card landing in the dock moves the strip unresized).
		const watch = (): void => {
			resized?.disconnect();
			resized?.observe(pane);
			for (const ancestor of ancestors) for (const child of ancestor.children) resized?.observe(child);
		};
		const added =
			typeof MutationObserver === "function"
				? new MutationObserver(() => {
						watch();
						measure();
					})
				: null;
		for (const ancestor of ancestors) added?.observe(ancestor, { childList: true });
		watch();
		measure();
		return () => {
			resized?.disconnect();
			added?.disconnect();
		};
	}, [root, open, shown]);
	return room;
}

/**
 * The work board where it has no room beside the pane (a phone, a portrait tablet; design §6.3): one status strip
 * under the header — what waits for you first, then the turn, the plan's progress with the current task, the
 * running subagents and jobs — and a tap expands the strip itself downward into the board, an inline panel over
 * the top of the transcript (no scrim, nothing dimmed, nothing pushed), opening on its summary (`SummaryBoard`:
 * Needs you listed, every other zone one line until a tap opens it). It collapses on a second tap, a swipe up
 * on the strip or the panel's grip, the back gesture, a tap outside, or a tap on a row (which also acts). Nothing
 * is remembered: every mount starts collapsed. The strip says what the dock's todo card would, so mobile.css hides
 * that card beside it. The line is a live region, so the board's announcements stay. A bump of `reveal` (the pane's
 * "show the run", WorkBoardHost) expands it.
 */
export function WorkBoardChip({ children, reveal = 0 }: { children: ReactNode; reveal?: number }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	// The zones opened or closed in this open of the panel: a fresh open, also one while the last still leaves, starts
	// on the summary; a reveal ("show the run") opens the run's zone, also in a panel already open.
	const [zones, setZones] = useState<ZoneOpen>({});
	const setZone = useCallback((id: keyof ZoneOpen, value: boolean) => {
		setZones(previous => ({ ...previous, [id]: value }));
	}, []);
	const expand = useCallback(
		(revealed = false) => {
			if (!open) setZones(revealed ? { autopilot: true } : {});
			else if (revealed) setZone("autopilot", true);
			setOpen(true);
		},
		[open, setZone],
	);
	const seenReveal = useRef(reveal);
	useEffect(() => {
		if (reveal === seenReveal.current) return;
		seenReveal.current = reveal;
		expand(true);
	}, [reveal, expand]);
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
	const hasOpened = opened.rows.length > 0;
	// The board's rows of those sessions are a lazy chunk: loaded before the panel opens, so a tap on Now's line shows
	// them with the zone instead of a frame after it.
	useEffect(() => {
		if (hasOpened) void import("./WorkBoardOpened").catch(() => {});
	}, [hasOpened]);
	const goal = useSessionStore(state => state.goal);
	const pending = useExtensionUiStore(state => state.pendingRequests);
	const loginRequestIds = useExtensionUiStore(state => state.loginRequestIds);
	const planPending = usePlanApprovalStore(state => state.pending !== null);
	// A run's own words (cycle and area, a pause reason, a quota wait, its end): in an Autopilot tab the strip is where
	// the run is reached wherever the board cannot dock.
	const runText = useAutopilotStateText();
	const ended = useAutopilotStore(state => isAutopilotTab(state) && state.status.state === "ended");
	const autopilotState = runText ?? (ended ? t("autopilot.state.ended") : null);
	const autopilotRunning = useAutopilotStore(state => isLiveAutopilot(state) && state.status.state === "running");

	// A failed check is a row of Needs you, so it is said with what waits on the person: the board counts it in the same
	// figure, read from the attention store the pane's one watcher (`WorkBoardHost`) writes.
	const failed = useCheckFailed(runtimeTabId ?? activeTabId);
	const counts = boardCounts({
		asks: pendingAsks({ pendingRequests: pending, loginRequestIds }, planPending),
		childrenWaiting: opened.counts.waiting,
		childrenRunning: opened.counts.running,
		checkFailed: failed,
		agents: agents.length,
		agentsWorking: workingSubagents(agents).length,
		jobs: jobs.length,
		turnWorking: turnActive || autopilotRunning,
	});
	const running = counts.running + counts.childrenRunning;
	const label = counts.attention
		? attentionClause(counts.attention, t)
		: autopilotState
			? `${t("autopilot.name")} · ${autopilotState}`
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
	// Measured while collapsed too (the chevron points the way the panel will open), and again at each open.
	const room = useStripRoom(root, open, label !== null);
	if (label === null) return null;
	const swipeStart = (event: TouchEvent<HTMLElement>) => {
		swipe.current = event.touches[0]?.clientY ?? null;
	};
	const swipeEnd = (event: TouchEvent<HTMLElement>) => {
		const from = swipe.current;
		swipe.current = null;
		const to = event.changedTouches[0]?.clientY;
		if (open && from !== null && to !== undefined && from - to >= SWIPE_UP_PX) close();
	};
	const state = counts.pulse;
	return (
		<div className="omp-work-strip" data-work-strip="" ref={root}>
			{/* controls-ok: the omp-work-chip class draws the whole control */}
			<button
				aria-controls={open || leaving ? PANEL_ID : undefined}
				aria-expanded={open}
				className="omp-work-chip"
				data-open={open || undefined}
				data-opens={room?.up ? "up" : undefined}
				data-state={state}
				data-work-chip=""
				onClick={() => (open ? close() : expand())}
				onTouchEnd={swipeEnd}
				onTouchStart={swipeStart}
				type="button"
			>
				<span aria-hidden className="omp-work-board-pulse" data-state={state} />
				<span aria-live="polite" className="omp-work-chip-label" role="status">
					{plan && counts.needs === 0 && !autopilotState ? (
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
					) : counts.needs === 0 && autopilotState ? (
						// A run is its rocket, then its state (the user's call, 23 Oct 2026); the word is for screen readers.
						<span className="inline-flex min-w-0 items-center gap-1.5">
							<Rocket aria-hidden className="size-(--sc-icon-sm) shrink-0" data-work-chip-run />
							<span className="sr-only">{t("autopilot.name")} · </span>
							<span className="truncate">{autopilotState}</span>
						</span>
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
					data-opens={room?.up ? "up" : undefined}
					style={room === undefined ? undefined : ({ "--strip-room": `${room.px}px` } as CSSProperties)}
					// A tap on a row acts (its own handler runs first) and collapses; the fold toggles and a row that
					// expands in place (`data-board-expands`, the memory row) keep the panel open.
					onClick={event => {
						const row =
							event.target instanceof Element ? event.target.closest("button.omp-work-board-row") : null;
						if (row && !row.hasAttribute("data-board-expands")) close();
					}}
				>
					<div className="omp-work-strip-body">
						<SummaryBoard onChange={setZone} open={zones}>
							{children}
						</SummaryBoard>
					</div>
					<div aria-hidden className="omp-work-strip-grip" onTouchEnd={swipeEnd} onTouchStart={swipeStart} />
				</div>
			)}
		</div>
	);
}
