/**
 * Workspace dock: the region between the transcript and the composer. While
 * this tab's transcript has a live work tail (state, not a card mount), that
 * tail carries todo progress, the goal and every subagent lane, so the dock keeps only
 * the plan-mode card; otherwise it shows the todo list (collapsed to one line)
 * and the goal strip. A plan proposal awaiting a decision carries the plan and
 * its choices itself, so the plan card steps aside until it is answered.
 * Subagents never get a card of their own: while a turn runs their lanes live
 * in the work card and the roster in the sidebar; between turns the island
 * row sums up agents still working or waiting and running background shells.
 * The dock still owns the stream-time roster poll, since it is mounted in every tab.
 * Each card self-gates its visibility, so the region collapses to zero height
 * on an idle session; the stack scrolls within a capped height so the composer
 * is never pushed off-screen, and every card sits behind its own error
 * boundary: a card crash must never take down the composer.
 */

import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSubagentRosterPoll } from "../../../hooks/use-subagent-roster-poll";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { liveWorkKey, useLiveWorkStore } from "../../../stores/live-work";
import { usePlanApprovalStore } from "../../../stores/plan-approval";
import { useSessionStore } from "../../../stores/session";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { selectTodoCardVisible, useTodoStore } from "../../../stores/todo";
import { PanelErrorBoundary } from "../../common";
import { GoalDockBar } from "./GoalDockBar";
import { PlanDockCard } from "./PlanDockCard";
import { TodoDockCard } from "./TodoDockCard";
import { useWorkspaceDockFocus, WorkspaceDockFocusProvider } from "./WorkspaceDockFocus";
import { WorkspaceIsland } from "./WorkspaceIsland";

const FOCUS_MIN_HEIGHT = 200;

/** The tallest a focused card may grow: the window keeps room for the composer and the transcript's head. */
function focusMaxHeight(): number {
	return Math.max(FOCUS_MIN_HEIGHT, window.innerHeight - 220);
}

function clampFocusHeight(height: number): number {
	return Math.round(Math.min(focusMaxHeight(), Math.max(FOCUS_MIN_HEIGHT, height)));
}

/** The cap before any resize (the scroller's CSS default `min(50dvh, calc(100dvh - 300px))`), within the handle's bounds. */
function defaultFocusHeight(): number {
	return clampFocusHeight(Math.min(window.innerHeight / 2, window.innerHeight - 300));
}

function WorkspaceDockContent() {
	const { focusedCard, clearFocus } = useWorkspaceDockFocus();
	const t = useT();
	const proposalPending = usePlanApprovalStore(s => s.pending !== null);
	const planCardVisible = useSessionStore(state => state.planModeEnabled) && !proposalPending;
	const tabId = useRuntimeTabId();
	// The running work card shows todos and the goal itself.
	const carriedByWork = useLiveWorkStore(state => state.cards[liveWorkKey(tabId)] ?? false);
	const goalVisible = useSessionStore(state => state.goal !== null) && !carriedByWork;
	const todoVisible = useTodoStore(selectTodoCardVisible) && !carriedByWork;
	const cardsVisible = planCardVisible || todoVisible;
	useLayoutEffect(() => {
		if (carriedByWork && focusedCard === "todo") clearFocus();
	}, [carriedByWork, focusedCard, clearFocus]);

	// Focused-card height: user-resizable via the drag handle above the stack,
	// persisted across launches. null = fall back to the viewport-derived cap.
	const scrollerRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{ startY: number; startH: number } | null>(null);
	const [focusHeight, setFocusHeight] = useState<number | null>(() => {
		try {
			const stored = Number(localStorage.getItem("omp.dock.focusHeight"));
			return stored >= FOCUS_MIN_HEIGHT ? clampFocusHeight(stored) : null;
		} catch {
			return null;
		}
	});
	const clampHeight = useCallback(clampFocusHeight, []);
	const persistHeight = useCallback((height: number) => {
		try {
			localStorage.setItem("omp.dock.focusHeight", String(height));
		} catch {
			/* storage unavailable — session-only */
		}
	}, []);
	useEffect(() => {
		const clamp = () => setFocusHeight(height => (height === null ? null : clampFocusHeight(height)));
		window.addEventListener("resize", clamp);
		return () => window.removeEventListener("resize", clamp);
	}, []);

	const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		const el = scrollerRef.current;
		if (!el) return;
		dragRef.current = { startY: event.clientY, startH: el.clientHeight };
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const onHandleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag) return;
		setFocusHeight(clampHeight(drag.startH + (drag.startY - event.clientY)));
	};
	const onHandleUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!dragRef.current) return;
		dragRef.current = null;
		event.currentTarget.releasePointerCapture(event.pointerId);
		if (focusHeight != null) persistHeight(focusHeight);
	};
	const onHandleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (!focusedCard) return;
		// The handle sets the card's cap, never its content's height: a short list stays short under any cap.
		const current = focusHeight ?? defaultFocusHeight();
		const next =
			event.key === "Home"
				? FOCUS_MIN_HEIGHT
				: event.key === "End"
					? focusMaxHeight()
					: event.key === "ArrowUp"
						? clampHeight(current + 48)
						: event.key === "ArrowDown"
							? clampHeight(current - 48)
							: null;
		if (next === null) return;
		event.preventDefault();
		setFocusHeight(next);
		persistHeight(next);
	};

	if (!cardsVisible && !goalVisible && carriedByWork) return null;

	return (
		<div className="flex flex-col gap-2 pb-2 empty:hidden" data-focused-card={focusedCard ?? undefined}>
			{!carriedByWork && (
				<PanelErrorBoundary>
					<WorkspaceIsland />
				</PanelErrorBoundary>
			)}
			{cardsVisible && (
				<>
					{focusedCard && (
						<div
							aria-label={t("dock.resizeHeight")}
							aria-orientation="horizontal"
							aria-valuemax={focusMaxHeight()}
							aria-valuemin={FOCUS_MIN_HEIGHT}
							aria-valuenow={focusHeight ?? defaultFocusHeight()}
							className="mx-auto h-1.5 w-16 cursor-row-resize touch-none rounded-(--sc-radius-full) bg-(--sc-border) hover:bg-(--sc-border-strong) focus-visible:outline-2 focus-visible:outline-(--sc-accent)"
							data-testid="workspace-dock-resize"
							onKeyDown={onHandleKeyDown}
							onPointerDown={onHandleDown}
							onPointerMove={onHandleMove}
							onPointerUp={onHandleUp}
							role="separator"
							tabIndex={0}
							title={t("dock.resizeHeight")}
						/>
					)}
					<div
						className={cx(
							// No stable scrollbar gutter: it would inset the cards from
							// the composer's edges. Overlay scrollbars need none.
							"flex flex-col gap-2 overflow-y-auto overscroll-contain",
							// Summary state stays compact. A FOCUSED card renders the full
							// list; its cap is an INLINE style — arbitrary-value classes
							// cannot express `calc(100dvh - 240px)` (the bare dash makes
							// the declaration invalid, silently removing every bound and
							// killing scrollability).
							focusedCard ? undefined : "max-h-[min(40vh,320px)]",
						)}
						data-testid="workspace-dock"
						ref={scrollerRef}
						style={focusedCard ? { maxHeight: focusHeight ?? "min(50dvh, calc(100dvh - 300px))" } : undefined}
					>
						{planCardVisible && (
							<PanelErrorBoundary>
								<PlanDockCard />
							</PanelErrorBoundary>
						)}
						{todoVisible && (
							<PanelErrorBoundary>
								<TodoDockCard />
							</PanelErrorBoundary>
						)}
					</div>
				</>
			)}
			{goalVisible && (
				<PanelErrorBoundary>
					<GoalDockBar />
				</PanelErrorBoundary>
			)}
		</div>
	);
}

export function WorkspaceDock() {
	useSubagentRosterPoll();
	return (
		<WorkspaceDockFocusProvider>
			<WorkspaceDockContent />
		</WorkspaceDockFocusProvider>
	);
}
