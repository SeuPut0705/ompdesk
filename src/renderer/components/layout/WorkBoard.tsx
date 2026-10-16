/**
 * Work board: this session's live state docked in the right margin of a wide session pane —
 * the current turn, questions waiting on the user, running agents and background jobs, the plan,
 * the goal and, once idle, a line on the last turn. Everything is read from the stores and bridge
 * data the rest of the app already keeps; nothing here derives state of its own.
 *
 * `WorkBoardHost` decides whether the pane has room (a ResizeObserver on the pane, not the window:
 * `workBoardFits`) and whether the user wants it (pref, default on; never beside the side panel).
 * `WorkBoard` renders the sections and, while it has any, marks the pane `data-work-board` so the
 * transcript and composer columns shift left by the board's width (components.css). Empty sections
 * collapse, and a board with no section at all takes no room.
 */

import { Pause, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RpcGoalState } from "../../../shared/rpc-types";
import { useBackgroundJobs } from "../../hooks/use-background-jobs";
import { saveGuiPreference } from "../../lib/display-preferences";
import { cx, formatDuration, formatElapsed, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { useTabRpc } from "../../lib/tab-rpc";
import { isUserBlockingRequest, useExtensionUiStore } from "../../stores/extension-ui";
import { usePlanApprovalStore } from "../../stores/plan-approval";
import { useSessionStore } from "../../stores/session";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useSubagentsStore } from "../../stores/subagents";
import { useTabsStore } from "../../stores/tabs";
import { selectTodoCardVisible, useTodoStore } from "../../stores/todo";
import { type ToolEntry, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { useRunStores } from "../chat/use-work-run";
import { workOutcomes } from "../chat/work-view";
import { IconButton } from "../common";
import { statusMeta, subagentElapsedMs, subagentPrimaryLabel } from "../panels/subagent-graph";
import { liveSubagents, requestLabel, todoBoard, workBoardFits } from "./work-board";

type Tone = "info" | "success" | "warning" | "muted";

const MARK_TONE: Record<Tone, string> = {
	info: "bg-(--sc-info)",
	success: "bg-(--sc-success)",
	warning: "bg-(--sc-warning)",
	muted: "bg-(--sc-text-subtle)",
};

/** A state mark: a small dot whose colour is the state (info = working, success = done, warning = needs you). */
function Mark({ tone, pulse = false, ring = false }: { tone: Tone; pulse?: boolean; ring?: boolean }) {
	return (
		<span aria-hidden className="flex size-3 shrink-0 items-center justify-center">
			<span
				className={cx(
					"size-1.5 rounded-full",
					ring ? "border border-(--sc-text-subtle)" : MARK_TONE[tone],
					pulse && "omp-pulse-dot",
				)}
			/>
		</span>
	);
}

const ROW =
	"flex w-full min-w-0 items-start gap-2 rounded-(--sc-radius-sm) px-1.5 py-1 text-left text-sc-sm text-(--sc-text-secondary)";
const ROW_BUTTON = `${ROW} cursor-pointer hover:bg-(--sc-hover) hover:text-(--sc-text) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring)`;

function BoardSection({
	title,
	count,
	data,
	children,
}: {
	title: string;
	count?: ReactNode;
	data?: Record<string, string>;
	children: ReactNode;
}) {
	const id = useId();
	return (
		<section aria-labelledby={id} className="omp-work-board-section" {...data}>
			<h3 className="mb-1 flex items-baseline gap-1.5 px-1.5 text-sc-xs font-medium text-(--sc-text-muted)" id={id}>
				{title}
				{count !== undefined && <span className="tabular-nums text-(--sc-text-subtle)">{count}</span>}
			</h3>
			<ul className="flex flex-col gap-px">{children}</ul>
		</section>
	);
}

/** One row: a mark, a label that truncates, and a muted figure; `note` is an optional second line. */
function BoardRow({
	mark,
	label,
	meta,
	note,
	onClick,
	title,
	data,
}: {
	mark: ReactNode;
	label: ReactNode;
	meta?: ReactNode;
	note?: ReactNode;
	onClick?: () => void;
	title?: string;
	data?: Record<string, string>;
}) {
	const body = (
		<>
			<span className="flex h-5 items-center">{mark}</span>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="flex min-w-0 items-baseline gap-2">
					<span className="min-w-0 flex-1 truncate">{label}</span>
					{meta ? <span className="shrink-0 text-sc-xs tabular-nums text-(--sc-text-subtle)">{meta}</span> : null}
				</span>
				{note ? <span className="truncate text-sc-xs text-(--sc-text-subtle)">{note}</span> : null}
			</span>
		</>
	);
	return (
		<li>
			{onClick ? (
				<button className={ROW_BUTTON} onClick={onClick} title={title} type="button" {...data}>
					{body}
				</button>
			) : (
				<div className={ROW} title={title} {...data}>
					{body}
				</div>
			)}
		</li>
	);
}

/** The newest call still pending or running: the step the turn is on. */
function newestLiveTool(live: ReadonlyMap<string, ToolEntry>): ToolEntry | undefined {
	let newest: ToolEntry | undefined;
	for (const entry of live.values()) {
		if (entry.status !== "pending" && entry.status !== "running") continue;
		if (!newest || entry.startTime >= newest.startTime) newest = entry;
	}
	return newest;
}

/** Focus the question or approval card docked above this pane's composer. */
function focusPrompt(pane: HTMLElement): void {
	const card = pane.querySelector<HTMLElement>("[data-prompt-card]");
	if (!card) return;
	card.scrollIntoView?.({ block: "nearest" });
	(card.querySelector<HTMLElement>("input, textarea, button, [tabindex]") ?? card).focus?.();
}

const GOAL_STATUS_KEY: Record<string, string> = {
	active: "modesPanel.goal.statusValue.active",
	paused: "modesPanel.goal.statusValue.paused",
	"budget-limited": "modesPanel.goal.statusValue.budgetLimited",
	complete: "modesPanel.goal.statusValue.complete",
	dropped: "modesPanel.goal.statusValue.dropped",
};

/** Budget and time the goal has used: stock's `get_goal`, read again whenever the goal or a turn changes. */
function useGoalDetail(objective: string | undefined, status: string | undefined, turnActive: boolean) {
	const rpc = useTabRpc();
	const [detail, setDetail] = useState<RpcGoalState | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: objective, status and the turn are the re-read triggers.
	useEffect(() => {
		if (objective === undefined) {
			setDetail(null);
			return;
		}
		let cancelled = false;
		void rpc
			.getGoal()
			.then(response => {
				if (!cancelled && response.success) setDetail(response.data as RpcGoalState);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [rpc, objective, status, turnActive]);
	return detail;
}

/** The last finished turn's duration and files changed, noted as the turn ends. */
function useLastTurn(turnActive: boolean, startedAt: number | null) {
	const { tools } = useRunStores();
	const cwd = useSessionStore(state => state.cwd);
	const [last, setLast] = useState<{ durationMs: number; files: number } | null>(null);
	const started = useRef<number | null>(null);
	useEffect(() => {
		if (turnActive) {
			started.current = startedAt ?? started.current ?? Date.now();
			return;
		}
		const start = started.current;
		if (start === null) return;
		started.current = null;
		const entries = [...tools.getState().finishedTools.values()].filter(entry => entry.startTime >= start);
		setLast({ durationMs: Date.now() - start, files: workOutcomes(entries, undefined, cwd).files.length });
	}, [turnActive, startedAt, tools, cwd]);
	return last;
}

export function WorkBoard({ pane }: { pane: HTMLElement }) {
	const t = useT();
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;

	const turnActive = useTodoStore(state => state.turnActive);
	const turnStartedAt = useTodoStore(state => state.turnStartedAt);
	const retryInfo = useSessionStore(state => state.retryInfo);
	const compacting = useSessionStore(state => state.compactionInfo !== null);
	const awaitingModel = useSessionStore(state => state.awaitingModelSince !== null);
	const liveTool = useToolsStore(state => newestLiveTool(state.liveTools));

	const subagents = useSubagentsStore(state => state.subagents);
	const agents = useMemo(() => liveSubagents(subagents), [subagents]);
	const jobs = useBackgroundJobs();

	const phases = useTodoStore(state => state.phases);
	const planVisible = useTodoStore(selectTodoCardVisible);
	const plan = useMemo(() => (planVisible ? todoBoard(phases) : null), [phases, planVisible]);

	const goal = useSessionStore(state => state.goal);
	const goalStatus = useSessionStore(state => state.goalState?.status);
	const goalDetail = useGoalDetail(goal?.objective, goalStatus, turnActive);

	const pending = useExtensionUiStore(state => state.pendingRequests);
	const loginRequestIds = useExtensionUiStore(state => state.loginRequestIds);
	const blocking = useMemo(
		() => pending.filter(request => isUserBlockingRequest({ loginRequestIds }, request)),
		[pending, loginRequestIds],
	);
	const planProposal = usePlanApprovalStore(state => state.pending);

	const lastTurn = useLastTurn(turnActive, turnStartedAt);
	const now = useNowTick(turnActive || agents.length > 0 || jobs.length > 0);

	const waiting = blocking.length + (planProposal ? 1 : 0);
	const running = agents.length + jobs.length;
	const sections = [
		turnActive,
		waiting > 0,
		running > 0,
		plan !== null,
		goal !== null,
		!turnActive && lastTurn !== null,
	];
	const present = sections.some(Boolean);
	useLayoutEffect(() => {
		if (!present) return;
		pane.setAttribute("data-work-board", "");
		return () => pane.removeAttribute("data-work-board");
	}, [pane, present]);
	if (!present) return null;

	const step = retryInfo
		? t("chat.retry.inflight", { attempt: retryInfo.attempt, maxAttempts: retryInfo.maxAttempts })
		: compacting
			? t("workBoard.step.compacting")
			: liveTool
				? liveTool.intent?.trim() || liveTool.toolName
				: awaitingModel
					? t("workBoard.step.waiting")
					: t("workBoard.step.working");
	const elapsedOf = (start: number | null) => (start === null ? "" : formatElapsed(Math.max(0, now - start)));
	const filesPlural = (count: number) => (count === 1 ? "" : "s");

	return (
		<aside aria-label={t("workBoard.label")} className="omp-work-board" data-work-board-panel>
			<div className="flex items-center justify-between gap-2 px-1.5 pb-1">
				<h2 className="text-sc-xs font-semibold text-(--sc-text-muted)">{t("workBoard.label")}</h2>
				<IconButton
					icon={<X />}
					label={t("workBoard.hide")}
					onClick={() =>
						void saveGuiPreference("workBoard", false, () => useUiStore.getState().setWorkBoard(false))
					}
					size="sm"
				/>
			</div>

			{turnActive && (
				<BoardSection title={t("workBoard.turn")}>
					<BoardRow
						data={{ "data-board-turn": "" }}
						label={step}
						mark={<Mark pulse tone="info" />}
						meta={elapsedOf(turnStartedAt)}
						title={step}
					/>
				</BoardSection>
			)}

			{waiting > 0 && (
				<BoardSection count={waiting} title={t("workBoard.waiting")}>
					{planProposal && (
						<BoardRow
							data={{ "data-board-waiting": "plan" }}
							label={t("workBoard.planReview")}
							mark={<Mark tone="warning" />}
							onClick={() => focusPrompt(pane)}
						/>
					)}
					{blocking.map(request => {
						const label = requestLabel(request, t);
						return (
							<BoardRow
								data={{ "data-board-waiting": request.id }}
								key={request.id}
								label={label}
								mark={<Mark tone="warning" />}
								onClick={() => focusPrompt(pane)}
								title={label}
							/>
						);
					})}
				</BoardSection>
			)}

			{running > 0 && (
				<BoardSection count={running} title={t("workBoard.running")}>
					{agents.map(agent => {
						const label = subagentPrimaryLabel(agent, 48);
						const status = t(statusMeta(agent.status).labelKey);
						const elapsed = subagentElapsedMs(agent, now);
						const tokens = agent.progress?.tokens ?? 0;
						const waitingAgent = agent.status === "parked" || agent.status === "idle";
						return (
							<BoardRow
								data={{ "data-board-agent": agent.id, "data-status": agent.status }}
								key={agent.id}
								label={label}
								mark={
									waitingAgent ? (
										<Pause aria-hidden className="size-3 text-(--sc-text-subtle)" />
									) : (
										<Mark pulse tone="info" />
									)
								}
								meta={elapsed === null ? undefined : formatElapsed(elapsed)}
								note={
									tokens > 0
										? `${status} · ${t("workBoard.tokens", { tokens: formatTokens(tokens) })}`
										: status
								}
								onClick={() => tabId && useUiStore.getState().openSubagentPanel({ tabId, agentId: agent.id })}
								title={`${label}\n${status}`}
							/>
						);
					})}
					{jobs.map(job => (
						<BoardRow
							data={{ "data-board-job": job.id }}
							key={job.id}
							label={job.label}
							mark={<Mark pulse tone="info" />}
							meta={elapsedOf(job.startTime)}
							note={t(`jobs.type.${job.type}`)}
							onClick={() => useUiStore.getState().openJobs()}
							title={job.label}
						/>
					))}
				</BoardSection>
			)}

			{plan && (
				<BoardSection
					count={
						<>
							<span aria-hidden>
								{plan.done}/{plan.total}
							</span>
							<span className="sr-only">
								{t("workBoard.planProgress", { done: plan.done, total: plan.total })}
							</span>
						</>
					}
					data={{ "data-board-plan": "" }}
					title={t("dock.todo")}
				>
					{plan.rows.map((row, index) => (
						<BoardRow
							data={{ "data-todo-status": row.status }}
							key={`${index}:${row.content}`}
							label={
								<span
									className={cx(
										row.status === "completed" && "text-(--sc-text-subtle)",
										row.status === "in_progress" && "font-medium text-(--sc-text)",
									)}
								>
									{row.content}
								</span>
							}
							mark={
								row.status === "completed" ? (
									<Mark tone="success" />
								) : row.status === "in_progress" ? (
									<Mark pulse tone="info" />
								) : row.status === "blocked" ? (
									<Mark tone="warning" />
								) : (
									<Mark ring tone="muted" />
								)
							}
							onClick={() => useUiStore.getState().focusDockCard("todo")}
							title={row.content}
						/>
					))}
					{plan.hidden > 0 && (
						<li className="px-1.5 pl-6 text-sc-xs text-(--sc-text-subtle)">
							{t("workBoard.moreTodos", { count: plan.hidden })}
						</li>
					)}
				</BoardSection>
			)}

			{goal && (
				<BoardSection title={t("workBoard.goal")}>
					<BoardRow
						data={{ "data-board-goal": goalStatus ?? "" }}
						label={
							<span className="line-clamp-2 whitespace-normal">
								{goal.objective?.trim() || t("input.goal.label")}
							</span>
						}
						mark={
							<Mark
								tone={goalStatus === "active" ? "info" : goalStatus === "complete" ? "success" : "warning"}
							/>
						}
						note={goalNote(goalStatus, goalDetail, t)}
						onClick={() => useUiStore.getState().openModes("goal")}
						title={goal.objective}
					/>
				</BoardSection>
			)}

			{!turnActive && lastTurn && (
				<BoardSection title={t("workBoard.lastTurn")}>
					<BoardRow
						data={{ "data-board-last-turn": "" }}
						label={[
							formatDuration(lastTurn.durationMs),
							lastTurn.files > 0
								? t("chat.work.filesChanged", { count: lastTurn.files, plural: filesPlural(lastTurn.files) })
								: null,
						]
							.filter(Boolean)
							.join(" · ")}
						mark={<Mark ring tone="muted" />}
					/>
				</BoardSection>
			)}
		</aside>
	);
}

/** The goal's status in words plus the budget and time it has used, when `get_goal` reported any. */
function goalNote(
	status: string | undefined,
	detail: RpcGoalState | null,
	t: (key: string, params?: Record<string, string | number>) => string,
): string {
	const parts: string[] = [];
	const statusKey = status ? GOAL_STATUS_KEY[status] : undefined;
	parts.push(statusKey ? t(statusKey) : (status ?? ""));
	if (detail?.tokenBudget) {
		parts.push(
			t("workBoard.goalBudget", {
				used: formatTokens(detail.tokensUsed ?? 0),
				budget: formatTokens(detail.tokenBudget),
			}),
		);
	}
	const used = detail?.timeUsedSeconds ?? 0;
	if (detail?.timeLimitSeconds) {
		parts.push(
			t("workBoard.goalTime", {
				used: formatDuration(used * 1000),
				limit: formatDuration(detail.timeLimitSeconds * 1000),
			}),
		);
	} else if (used > 0) {
		parts.push(formatDuration(used * 1000));
	}
	return parts.filter(Boolean).join(" · ");
}

/**
 * Mount point inside a session pane's chat region. It owns the two gates — the user's pref and the
 * side panel (the board never sits beside it) — and the pane's width, which it watches itself: a
 * split pane or a narrow window is too narrow for the board exactly as `workBoardFits` says.
 */
export function WorkBoardHost() {
	const enabled = useUiStore(state => state.workBoard);
	const panelOpen = useUiStore(state => state.panelVisible);
	const slot = useRef<HTMLDivElement>(null);
	const [pane, setPane] = useState<HTMLElement | null>(null);
	const [fits, setFits] = useState(false);
	useLayoutEffect(() => {
		const element = slot.current?.closest<HTMLElement>(".omp-session-pane") ?? null;
		setPane(element);
		if (!element) return;
		setFits(workBoardFits(element.clientWidth));
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(entries => {
			const width = entries.at(-1)?.contentRect.width ?? element.clientWidth;
			setFits(workBoardFits(width));
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return (
		<div className="omp-work-board-slot" ref={slot}>
			{enabled && !panelOpen && fits && pane ? <WorkBoard pane={pane} /> : null}
		</div>
	);
}
