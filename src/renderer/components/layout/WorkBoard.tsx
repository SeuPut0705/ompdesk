/**
 * Work board: this session's live state docked in the right margin of a wide session pane —
 * questions waiting on the user, the current turn with its last steps, running agents and
 * background jobs, the todo list, the goal and, once idle, a line on the last turn. Everything is
 * read from the stores and bridge data the rest of the app already keeps; nothing here derives
 * state of its own.
 *
 * `WorkBoardHost` decides whether the pane has room (a ResizeObserver on the pane, not the window:
 * `workBoardFits`) and whether the user wants it (pref, default on; never beside the side panel).
 * `WorkBoard` renders the sections and, while it has any, marks the pane `data-work-board` so the
 * transcript and composer columns shift left by the board's width (components.css). The dock strips
 * that say the same thing (agents, todos) step aside through `data-work-board-running` / `-todo`.
 * Empty sections collapse, and a board with no section at all takes no room.
 */

import { Check, ChevronRight, Pause, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RpcGoalState, SubagentSnapshot } from "../../../shared/rpc-types";
import { useBackgroundJobs } from "../../hooks/use-background-jobs";
import { usePresence } from "../../hooks/use-presence";
import { saveGuiPreference } from "../../lib/display-preferences";
import { cx, formatDuration, formatElapsed, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { actionShortcut } from "../../lib/keymap";
import { useNowTick } from "../../lib/now-tick";
import { useTabRpc } from "../../lib/tab-rpc";
import { isUserBlockingRequest, useExtensionUiStore } from "../../stores/extension-ui";
import { useMessagesStore } from "../../stores/messages";
import { usePlanApprovalStore } from "../../stores/plan-approval";
import { useSessionStore } from "../../stores/session";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useSubagentsStore } from "../../stores/subagents";
import { useTabsStore } from "../../stores/tabs";
import { selectTodoCardVisible, useTodoStore } from "../../stores/todo";
import { type ToolEntry, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { useWorkBoardStore, type WorkBoardSectionId } from "../../stores/work-board";
import { formatTokenRate } from "../chat/TurnOutputMeter";
import { useRunStores } from "../chat/use-work-run";
import { workOutcomes } from "../chat/work-view";
import { IconButton, Kbd } from "../common";
import { statusMeta, subagentElapsedMs, subagentPrimaryLabel } from "../panels/subagent-graph";
import { ProviderMark } from "../settings/providers/ProviderMark";
import { getToolHeader } from "../tools/index";
import { AccountLimit } from "./AccountLimit";
import { liveSubagents, requestLabel, type TodoBoard, todoBoard, workBoardFits } from "./work-board";

/** Steps the turn section lists: the newest few, oldest first, the live one last. */
const TURN_STEPS = 4;
/** A call's clock and the turn's come from different events of one batch: a call within this of the start is the turn's. */
const TURN_CLOCK_SLACK_MS = 500;

const WAITING_AGENT: Record<string, true> = { parked: true, idle: true };

function Dot({
	tone,
	live = false,
	ring = false,
}: {
	tone: "info" | "success" | "warning" | "muted";
	live?: boolean;
	ring?: boolean;
}) {
	return (
		<span
			aria-hidden
			className="omp-work-board-dot"
			data-live={live || undefined}
			data-ring={ring || undefined}
			data-tone={tone}
		/>
	);
}

function SegmentBar({ segments, label }: { segments: TodoBoard["segments"]; label: string }) {
	return (
		<span aria-label={label} className="omp-work-board-segments" role="img">
			{segments.map((status, index) => (
				<span data-status={status} key={index} />
			))}
		</span>
	);
}

function Meter({ label, value, text }: { label: string; value: number; text: string }) {
	const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<span className="flex items-baseline justify-between gap-2 text-sc-xs text-(--sc-text-subtle)">
				<span>{label}</span>
				<span className="tabular-nums">{text}</span>
			</span>
			<span
				aria-label={label}
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={percent}
				aria-valuetext={text}
				className="omp-work-board-meter"
				data-hot={percent >= 90 || undefined}
				role="progressbar"
			>
				<span style={{ width: `${percent}%` }} />
			</span>
		</div>
	);
}

function BoardSection({
	id,
	title,
	count,
	aside,
	tone,
	children,
}: {
	id: WorkBoardSectionId;
	title: string;
	count?: ReactNode;
	aside?: ReactNode;
	tone?: "warning";
	children: ReactNode;
}) {
	const t = useT();
	const headId = useId();
	const folded = useWorkBoardStore(state => state.collapsed[id] === true);
	return (
		<section
			aria-labelledby={headId}
			className="omp-work-board-section omp-fade-up"
			data-board-section={id}
			data-tone={tone}
		>
			<h3 className="omp-work-board-title" id={headId}>
				<button
					aria-expanded={!folded}
					className="omp-work-board-fold"
					onClick={() => useWorkBoardStore.getState().toggle(id)}
					title={t(folded ? "workBoard.expand" : "workBoard.collapse", { section: title })}
					type="button"
				>
					<ChevronRight aria-hidden className="omp-work-board-chevron" data-open={!folded || undefined} />
					<span className="truncate">{title}</span>
					{count !== undefined && <span className="omp-work-board-count">{count}</span>}
				</button>
				{aside ? <span className="omp-work-board-aside">{aside}</span> : null}
			</h3>
			{folded ? null : <ul className="omp-work-board-list">{children}</ul>}
		</section>
	);
}

/** One row: a lead mark, a label that truncates, a muted figure and an optional second line. */
function BoardRow({
	lead,
	label,
	meta,
	sub,
	onClick,
	title,
	data,
	live = false,
	exiting = false,
}: {
	lead: ReactNode;
	label: ReactNode;
	meta?: ReactNode;
	sub?: ReactNode;
	onClick?: () => void;
	title?: string;
	data?: Record<string, string>;
	live?: boolean;
	exiting?: boolean;
}) {
	const body = (
		<>
			<span className="omp-work-board-lead">{lead}</span>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="flex min-w-0 items-baseline gap-2">
					<span className="min-w-0 flex-1 truncate">{label}</span>
					{meta ? <span className="omp-work-board-meta">{meta}</span> : null}
				</span>
				{sub ? <span className="omp-work-board-sub">{sub}</span> : null}
			</span>
		</>
	);
	return (
		<li
			aria-hidden={exiting || undefined}
			className="omp-work-board-item"
			data-exiting={exiting || undefined}
			data-live={live || undefined}
		>
			{onClick ? (
				<button className="omp-work-board-row" onClick={onClick} title={title} type="button" {...data}>
					{body}
				</button>
			) : (
				<div className="omp-work-board-row" title={title} {...data}>
					{body}
				</div>
			)}
		</li>
	);
}

/** Focus the question or approval card docked above this pane's composer. */
function focusPrompt(pane: HTMLElement): void {
	const card = pane.querySelector<HTMLElement>("[data-prompt-card]");
	if (!card) return;
	card.scrollIntoView?.({ block: "nearest" });
	(card.querySelector<HTMLElement>("input, textarea, button, [tabindex]") ?? card).focus?.();
}

/** Bring the run's todo list in the conversation into view; a list with no card there has nothing to show. */
function showTodoCard(pane: HTMLElement): void {
	const cards = pane.querySelectorAll<HTMLElement>("[data-todo-snapshot]");
	cards[cards.length - 1]?.scrollIntoView?.({ block: "center", behavior: "smooth" });
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

interface LastTurn {
	durationMs: number;
	files: number;
	added: number;
	removed: number;
}

/** The last finished turn's duration and what it changed, noted as the turn ends. */
function useLastTurn(turnActive: boolean, startedAt: number | null): LastTurn | null {
	const { tools } = useRunStores();
	const cwd = useSessionStore(state => state.cwd);
	const [last, setLast] = useState<LastTurn | null>(null);
	const started = useRef<number | null>(null);
	useEffect(() => {
		if (turnActive) {
			started.current = startedAt ?? started.current ?? Date.now();
			return;
		}
		const start = started.current;
		if (start === null) return;
		started.current = null;
		const entries = [...tools.getState().finishedTools.values()].filter(
			entry => entry.startTime >= start - TURN_CLOCK_SLACK_MS,
		);
		const { files } = workOutcomes(entries, undefined, cwd);
		setLast({
			durationMs: Date.now() - start,
			files: files.length,
			added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
			removed: files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
		});
	}, [turnActive, startedAt, tools, cwd]);
	return last;
}

/** The turn's newest few calls, live and finished, oldest first. */
function useTurnSteps(active: boolean, startedAt: number | null): ToolEntry[] {
	const { tools } = useRunStores();
	const live = useToolsStore(state => state.liveTools);
	const finishedVersion = useToolsStore(state => state.finishedVersion);
	// biome-ignore lint/correctness/useExhaustiveDependencies: finishedVersion marks the finished map changing in place.
	return useMemo(() => {
		if (!active || startedAt === null) return [];
		const all = [...tools.getState().finishedTools.values(), ...live.values()];
		return all
			.filter(entry => entry.startTime >= startedAt - TURN_CLOCK_SLACK_MS && entry.status !== "aborted")
			.sort((a, b) => a.startTime - b.startTime)
			.slice(-TURN_STEPS);
	}, [active, startedAt, tools, live, finishedVersion]);
}

function providerOf(model: string | undefined): { id: string; name: string } | null {
	const id = model?.includes("/") ? model.slice(0, model.indexOf("/")) : "";
	return id ? { id, name: id } : null;
}

function AgentRow({
	agent,
	now,
	onOpen,
	exiting,
}: {
	agent: SubagentSnapshot;
	now: number;
	onOpen: () => void;
	exiting: boolean;
}) {
	const t = useT();
	const label = subagentPrimaryLabel(agent, 48);
	const status = t(statusMeta(agent.status).labelKey);
	const waiting = WAITING_AGENT[agent.status] === true;
	const elapsed = subagentElapsedMs(agent, now);
	const progress = agent.progress;
	const step = progress?.currentToolIntent ?? progress?.lastIntent ?? progress?.currentTool ?? status;
	const tokens = progress?.tokens ?? 0;
	const provider = providerOf(progress?.resolvedModel);
	return (
		<BoardRow
			exiting={exiting}
			data={{ "data-board-agent": agent.id, "data-status": agent.status }}
			label={label}
			lead={waiting ? <Pause aria-hidden className="size-3 text-(--sc-text-subtle)" /> : <Dot live tone="info" />}
			live={!waiting}
			meta={elapsed === null ? undefined : formatElapsed(elapsed)}
			onClick={onOpen}
			sub={
				<>
					{provider ? <ProviderMark className="omp-work-board-provider" provider={provider} /> : null}
					<span className="min-w-0 flex-1 truncate">{waiting ? status : step}</span>
					{tokens > 0 ? (
						<span className="shrink-0 tabular-nums">
							{t("workBoard.tokens", { tokens: formatTokens(tokens) })}
						</span>
					) : null}
				</>
			}
			title={`${label}\n${status}${progress?.resolvedModel ? `\n${progress.resolvedModel}` : ""}`}
		/>
	);
}

function goalNote(
	status: string | undefined,
	t: (key: string, params?: Record<string, string | number>) => string,
): string {
	const key = status ? GOAL_STATUS_KEY[status] : undefined;
	return key ? t(key) : (status ?? "");
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
	const steps = useTurnSteps(turnActive, turnStartedAt);

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
	const running = agents.length + jobs.length;
	const now = useNowTick(turnActive || running > 0);
	const presentedAgents = usePresence(agents, agent => agent.id);
	const presentedJobs = usePresence(jobs, job => job.id);
	const rate = useMessagesStore(state => state.turnMeter.rate);
	const turnLive = useMessagesStore(state => state.turnMeter.startedAt != null && state.turnMeter.endedAt == null);

	const hydrate = useWorkBoardStore(state => state.hydrate);
	useEffect(() => {
		void hydrate();
	}, [hydrate]);

	const waiting = blocking.length + (planProposal ? 1 : 0);
	const showsLast = !turnActive && lastTurn !== null;
	const present = turnActive || waiting > 0 || running > 0 || plan !== null || goal !== null || showsLast;
	const showsRunning = running > 0;
	const showsTodos = plan !== null;
	useLayoutEffect(() => {
		if (!present) return;
		// The dock strips that say the same thing step aside while the board shows it (components.css).
		pane.setAttribute("data-work-board", "");
		if (showsRunning) pane.setAttribute("data-work-board-running", "");
		if (showsTodos) pane.setAttribute("data-work-board-todo", "");
		return () => {
			pane.removeAttribute("data-work-board");
			pane.removeAttribute("data-work-board-running");
			pane.removeAttribute("data-work-board-todo");
		};
	}, [pane, present, showsRunning, showsTodos]);
	if (!present) return null;

	const working = agents.filter(agent => !WAITING_AGENT[agent.status]).length + jobs.length + (turnActive ? 1 : 0);
	const summary = [
		working > 0 ? t("workBoard.status.working", { count: working }) : null,
		waiting > 0 ? t("workBoard.status.waiting", { count: waiting }) : null,
	].filter(Boolean);
	const pulse = waiting > 0 ? "waiting" : working > 0 ? "working" : "idle";

	const turnState = retryInfo
		? t("chat.retry.inflight", { attempt: retryInfo.attempt, maxAttempts: retryInfo.maxAttempts })
		: compacting
			? t("workBoard.step.compacting")
			: awaitingModel && steps.length === 0
				? t("workBoard.step.waiting")
				: steps.length === 0
					? t("workBoard.step.working")
					: null;
	const startedAt = turnStartedAt;
	const clock = (from: number | null) => (from === null ? "" : formatElapsed(Math.max(0, now - from)));
	// The turn's paced token rate, the one the per-message meter shows; not shown between turns.
	const speed = turnLive && rate != null && rate > 0 ? t("chat.meter.rate", { rate: formatTokenRate(rate) }) : "";
	const plural = (count: number) => (count === 1 ? "" : "s");
	const jumpKey = actionShortcut("board.focus");

	return (
		<aside aria-label={t("workBoard.label")} className="omp-work-board" data-work-board-panel>
			{waiting > 0 && (
				<span aria-live="polite" className="sr-only" role="status">
					{t("workBoard.status.waiting", { count: waiting })}
				</span>
			)}
			<header className="omp-work-board-head">
				<span aria-hidden className="omp-work-board-pulse" data-state={pulse} />
				<h2 className="omp-work-board-name">{t("workBoard.label")}</h2>
				<IconButton
					className="omp-work-board-hide"
					icon={<X />}
					label={t("workBoard.hide")}
					onClick={() =>
						void saveGuiPreference("workBoard", false, () => useUiStore.getState().setWorkBoard(false))
					}
					size="sm"
				/>
				<p className="omp-work-board-status">
					{summary.length > 0 ? summary.join(" · ") : t("workBoard.status.idle")}
				</p>
				{plan ? (
					<span className="omp-work-board-progress">
						<SegmentBar
							label={t("workBoard.planProgress", { done: plan.done, total: plan.total })}
							segments={plan.segments}
						/>
						<span aria-hidden>{t("workBoard.status.done", { done: plan.done, total: plan.total })}</span>
					</span>
				) : null}
				<AccountLimit />
			</header>

			{waiting > 0 && (
				<BoardSection
					aside={jumpKey ? <Kbd shortcut={jumpKey} /> : null}
					count={waiting}
					id="waiting"
					title={t("workBoard.waiting")}
					tone="warning"
				>
					{planProposal && (
						<BoardRow
							data={{ "data-board-waiting": "plan" }}
							label={t("workBoard.planReview")}
							lead={<Dot tone="warning" />}
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
								lead={<Dot tone="warning" />}
								onClick={() => focusPrompt(pane)}
								title={label}
							/>
						);
					})}
				</BoardSection>
			)}

			{turnActive && (
				<BoardSection
					aside={[clock(startedAt), speed].filter(Boolean).join(" · ")}
					id="turn"
					title={t("workBoard.turn")}
				>
					{turnState ? (
						<BoardRow
							data={{ "data-board-turn": "" }}
							label={turnState}
							lead={<Dot live tone="info" />}
							live
							title={turnState}
						/>
					) : (
						steps.map((entry, index) => {
							const header = getToolHeader(entry.toolName, entry.args);
							const Icon = header.icon;
							const running = entry.status === "pending" || entry.status === "running";
							const text =
								header.target || (header.labelKey ? t(header.labelKey, header.labelParams) : header.tool);
							const last = index === steps.length - 1;
							return (
								<BoardRow
									data={{ "data-board-step": entry.status, ...(last ? { "data-board-turn": "" } : {}) }}
									key={`${entry.startTime}:${index}`}
									label={entry.intent?.trim() && last ? entry.intent : text}
									lead={
										<Icon
											aria-hidden
											className={cx("size-3.5", running ? "text-(--sc-info)" : "text-(--sc-text-subtle)")}
										/>
									}
									live={running}
									meta={
										running
											? clock(entry.startTime)
											: formatDuration(Math.max(0, (entry.endTime ?? entry.startTime) - entry.startTime))
									}
									title={text}
								/>
							);
						})
					)}
				</BoardSection>
			)}

			{presentedAgents.length + presentedJobs.length > 0 && (
				<BoardSection count={running} id="running" title={t("workBoard.running")}>
					{presentedAgents.map(({ item: agent, exiting }) => (
						<AgentRow
							agent={agent}
							exiting={exiting}
							key={agent.id}
							now={now}
							onOpen={() => tabId && useUiStore.getState().openSubagentPanel({ tabId, agentId: agent.id })}
						/>
					))}
					{presentedJobs.map(({ item: job, exiting }) => (
						<BoardRow
							data={{ "data-board-job": job.id }}
							exiting={exiting}
							key={job.id}
							label={job.label}
							lead={<Dot live tone="info" />}
							live
							meta={clock(job.startTime)}
							onClick={() => useUiStore.getState().openJobs()}
							sub={t(`jobs.type.${job.type}`)}
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
					id="todos"
					title={t("dock.todo")}
				>
					{plan.doneBefore > 0 && (
						<BoardRow
							data={{ "data-board-done-folded": "" }}
							label={
								<span className="text-(--sc-text-subtle)">
									{t("workBoard.doneFolded", { count: plan.doneBefore })}
								</span>
							}
							lead={<Check aria-hidden className="size-3 text-(--sc-success)" />}
						/>
					)}
					{plan.rows.map((row, index) => (
						<BoardRow
							data={{ "data-todo-status": row.status }}
							key={`${index}:${row.content}`}
							label={
								<span
									className={cx(
										row.status === "completed" && "text-(--sc-text-subtle) line-through",
										row.status === "in_progress" && "font-medium text-(--sc-text)",
									)}
								>
									{row.content}
								</span>
							}
							lead={
								row.status === "completed" ? (
									<Check aria-hidden className="size-3 text-(--sc-success)" />
								) : row.status === "in_progress" ? (
									<Dot live tone="info" />
								) : row.status === "blocked" ? (
									<Dot tone="warning" />
								) : (
									<Dot ring tone="muted" />
								)
							}
							live={row.status === "in_progress"}
							onClick={() => showTodoCard(pane)}
							title={row.content}
						/>
					))}
					{plan.hidden > 0 && (
						<li className="omp-work-board-more">{t("workBoard.moreTodos", { count: plan.hidden })}</li>
					)}
				</BoardSection>
			)}

			{goal && (
				<BoardSection id="goal" title={t("workBoard.goal")} aside={goalNote(goalStatus, t)}>
					<BoardRow
						data={{ "data-board-goal": goalStatus ?? "" }}
						label={
							<span className="line-clamp-2 whitespace-normal">
								{goal.objective?.trim() || t("input.goal.label")}
							</span>
						}
						lead={
							<Dot
								live={goalStatus === "active"}
								tone={goalStatus === "complete" ? "success" : goalStatus === "active" ? "info" : "warning"}
							/>
						}
						onClick={() => useUiStore.getState().openModes("goal")}
						sub={
							goalDetail?.tokenBudget ||
							goalDetail?.timeLimitSeconds ||
							(goalDetail?.timeUsedSeconds ?? 0) > 0 ? (
								<span className="flex min-w-0 flex-1 flex-col gap-1.5 pt-1">
									{goalDetail?.tokenBudget ? (
										<Meter
											label={t("workBoard.goalBudgetLabel")}
											text={t("workBoard.goalBudget", {
												used: formatTokens(goalDetail.tokensUsed ?? 0),
												budget: formatTokens(goalDetail.tokenBudget),
											})}
											value={(goalDetail.tokensUsed ?? 0) / goalDetail.tokenBudget}
										/>
									) : null}
									{goalDetail?.timeLimitSeconds ? (
										<Meter
											label={t("workBoard.goalTimeLabel")}
											text={t("workBoard.goalTime", {
												used: formatDuration((goalDetail.timeUsedSeconds ?? 0) * 1000),
												limit: formatDuration(goalDetail.timeLimitSeconds * 1000),
											})}
											value={(goalDetail.timeUsedSeconds ?? 0) / goalDetail.timeLimitSeconds}
										/>
									) : (goalDetail?.timeUsedSeconds ?? 0) > 0 ? (
										<span className="tabular-nums">
											{formatDuration((goalDetail?.timeUsedSeconds ?? 0) * 1000)}
										</span>
									) : null}
								</span>
							) : undefined
						}
						title={goal.objective}
					/>
				</BoardSection>
			)}

			{showsLast && lastTurn && (
				<BoardSection id="last" title={t("workBoard.lastTurn")} aside={formatDuration(lastTurn.durationMs)}>
					<BoardRow
						data={{ "data-board-last-turn": "" }}
						label={
							lastTurn.files > 0 ? (
								<span>
									{t("chat.work.filesChanged", { count: lastTurn.files, plural: plural(lastTurn.files) })}
								</span>
							) : (
								t("workBoard.noChanges")
							)
						}
						lead={<Check aria-hidden className="size-3 text-(--sc-text-subtle)" />}
						meta={
							lastTurn.added + lastTurn.removed > 0 ? (
								<span className="tabular-nums">
									<span className="text-(--sc-success)">+{lastTurn.added}</span>{" "}
									<span className="text-(--sc-danger)">−{lastTurn.removed}</span>
								</span>
							) : undefined
						}
						onClick={lastTurn.files > 0 ? () => useUiStore.getState().setPanelTab("diff") : undefined}
					/>
				</BoardSection>
			)}
		</aside>
	);
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
		// The board sits beside the composer too, so its slot runs on past the chat region to the pane's foot.
		const region = slot.current?.parentElement;
		const reachFoot = () => {
			const gap = (element.getBoundingClientRect?.().bottom ?? 0) - (region?.getBoundingClientRect?.().bottom ?? 0);
			slot.current?.style.setProperty("inset-block-end", `${-Math.max(0, Math.round(gap))}px`);
		};
		const observer = new ResizeObserver(entries => {
			const size = entries.find(entry => entry.target === element)?.contentRect.width;
			if (size !== undefined) setFits(workBoardFits(size));
			reachFoot();
		});
		observer.observe(element);
		if (region) observer.observe(region);
		return () => observer.disconnect();
	}, []);
	return (
		<div className="omp-work-board-slot" ref={slot}>
			{enabled && !panelOpen && fits && pane ? <WorkBoard pane={pane} /> : null}
		</div>
	);
}
