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

import { Check, Pause, X } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionSpend } from "../../../../../resources/gui-bridge/model-setup-contracts";
import type { RpcGoalState, SubagentSnapshot } from "../../../../shared/rpc-types";
import { useBackgroundJobs } from "../../../hooks/use-background-jobs";
import { useOpenedChildren } from "../../../hooks/use-opened-children";
import { usePresence } from "../../../hooks/use-presence";
import { useSessionSpend } from "../../../hooks/use-session-spend";
import { useShellMode } from "../../../hooks/use-shell-mode";
import { lazyChunk } from "../../../lib/chunk-load";
import { saveGuiPreference } from "../../../lib/display-preferences";
import { cx, formatDuration, formatElapsed, formatTokens } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { actionShortcut } from "../../../lib/keymap";
import { useNowTick } from "../../../lib/now-tick";
import { useProjectNames } from "../../../lib/project-origin";
import { costKinds, costWords } from "../../../lib/spend";
import { useTabRpc } from "../../../lib/tab-rpc";
import { ensureAgentReviewSubscription, useAgentReviewStore } from "../../../stores/agent-review";
import { isLiveAutopilot, useAutopilotStore } from "../../../stores/autopilot";
import { isUserBlockingRequest, useExtensionUiStore } from "../../../stores/extension-ui";
import { useMessagesStore } from "../../../stores/messages";
import { usePlanApprovalStore } from "../../../stores/plan-approval";
import { useSessionStore } from "../../../stores/session";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { selectTodoCardVisible, useTodoStore } from "../../../stores/todo";
import { type ToolEntry, useToolsStore } from "../../../stores/tools";
import { useUiStore } from "../../../stores/ui";
import { useWorkBoardStore } from "../../../stores/work-board";
import { formatTokenRate } from "../../chat/TurnOutputMeter";
import { useRunStores } from "../../chat/work/use-work-run";
import { IconButton, Kbd } from "../../common";
import { AutopilotBoardRows, useAutopilotStateText } from "../../panels/autopilot/AutopilotBoardCard";
import { statusMeta, subagentElapsedMs, subagentPrimaryLabel } from "../../panels/subagent-graph";
import { getToolHeader } from "../../tools/index";
import { AccountLimit } from "../AccountLimit";
import { childUsageText } from "../sidebar/sidebar-family";
import { BoardRow, BoardSection, CappedRows, Dot, SECTION_CAP } from "./board-parts";
import { WorkBoardChip } from "./WorkBoardChip";
import {
	goalMeta,
	liveSubagents,
	requestLabel,
	type TodoBoard,
	todoBoard,
	workBoardDocks,
	workBoardForm,
	workBoardWidth,
} from "./work-board";

/** The opened-session rows load when a session has such children: most never do. */
const OpenedSection = lazy(() => import("./WorkBoardOpened").then(module => ({ default: module.OpenedSection })));
/** The session rows (changes, last check, dev servers, same checkout, memory) and a failed check: a lazy chunk, since
 * the phone's first screen (the strip) never draws them. */
const FailedCheckSlot = lazyChunk(() =>
	import("./WorkBoardSession").then(module => ({ default: module.FailedCheckSlot })),
);
const SessionSlot = lazyChunk(() => import("./WorkBoardSession").then(module => ({ default: module.SessionSlot })));
/** The metered-spend rows load when this session spent on a metered provider (most sessions run on subscriptions). */
const SessionSpendLine = lazy(() =>
	import("./SessionSpendLine").then(module => ({ default: module.SessionSpendLine })),
);

/** Whether the session spent anything on a metered provider: only then the spend rows load and show. */
function hasCharge(spend: SessionSpend | null): spend is SessionSpend {
	return spend !== null && Object.values(spend.providers).some(row => row.billing === "metered" && row.cost > 0);
}

/** Steps the turn section lists: the newest few, oldest first, the live one last. */
const TURN_STEPS = 3;
/** A call's clock and the turn's come from different events of one batch: a call within this of the start is the turn's. */
const TURN_CLOCK_SLACK_MS = 500;

const WAITING_AGENT: Record<string, true> = { parked: true, idle: true };

function SegmentBar({ segments, label }: { segments: TodoBoard["segments"]; label: string }) {
	return (
		<span aria-label={label} className="omp-work-board-segments" role="img">
			{segments.map((status, index) => (
				<span data-status={status} key={index} />
			))}
		</span>
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
	const billing = useSessionSpend()?.billing;
	const costLine = costWords(t, costKinds({ model: progress?.resolvedModel, cost: progress?.cost }, billing));
	// One line: what it is and how long it has run. What it does now, its tokens, model and cost are its tooltip.
	return (
		<BoardRow
			exiting={exiting}
			data={{ "data-board-agent": agent.id, "data-status": agent.status }}
			label={label}
			lead={waiting ? <Pause aria-hidden className="size-3 text-(--sc-text-subtle)" /> : <Dot tone="info" />}
			meta={elapsed === null ? undefined : formatElapsed(elapsed)}
			onClick={onOpen}
			title={[
				label,
				waiting ? status : step,
				tokens > 0 ? t("workBoard.tokens", { tokens: formatTokens(tokens) }) : null,
				childUsageText(progress?.resolvedModel, progress?.modelRole),
				costLine,
			]
				.filter(Boolean)
				.join("\n")}
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

/**
 * `inline` is the board shown inside the phone's expanded status strip (WorkBoardChip): it takes no margin of the
 * pane, so it never marks the pane (`data-work-board*`), which would shift the transcript and composer by the
 * docked board's reserve; the strip already hides the dock cards that say the same.
 */
export function WorkBoard({ pane, inline = false }: { pane: HTMLElement; inline?: boolean }) {
	const t = useT();
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;
	const spend = useSessionSpend();
	useEffect(() => {
		ensureAgentReviewSubscription();
		if (tabId) void useAgentReviewStore.getState().refresh(tabId);
	}, [tabId]);
	const boardCwd = useSessionStore(state => state.cwd);
	const boardProject = useProjectNames(useMemo(() => (boardCwd ? [boardCwd] : []), [boardCwd]));
	// Only a linked worktree gets a line: `acme-web · Autopilot` instead of its folder name.
	const projectLine = boardCwd ? boardProject(boardCwd) : null;

	const turnActive = useTodoStore(state => state.turnActive);
	const turnStartedAt = useTodoStore(state => state.turnStartedAt);
	const retryInfo = useSessionStore(state => state.retryInfo);
	const compacting = useSessionStore(state => state.compactionInfo !== null);
	const awaitingModel = useSessionStore(state => state.awaitingModelSince !== null);
	const steps = useTurnSteps(turnActive, turnStartedAt);

	const subagents = useSubagentsStore(state => state.subagents);
	const agents = useMemo(() => liveSubagents(subagents), [subagents]);
	const jobs = useBackgroundJobs();
	const opened = useOpenedChildren(tabId);

	const phases = useTodoStore(state => state.phases);
	const planVisible = useTodoStore(selectTodoCardVisible);
	const plan = useMemo(() => (planVisible ? todoBoard(phases) : null), [phases, planVisible]);

	const goal = useSessionStore(state => state.goal);
	const goalStatus = useSessionStore(state => state.goalState?.status);
	const goalDetail = useGoalDetail(goal?.objective, goalStatus, turnActive);
	const autopilot = useAutopilotStore(isLiveAutopilot);
	const autopilotText = useAutopilotStateText();

	const pending = useExtensionUiStore(state => state.pendingRequests);
	const loginRequestIds = useExtensionUiStore(state => state.loginRequestIds);
	const blocking = useMemo(
		() => pending.filter(request => isUserBlockingRequest({ loginRequestIds }, request)),
		[pending, loginRequestIds],
	);
	const planProposal = usePlanApprovalStore(state => state.pending);

	const lastTurn = useTodoStore(state => state.lastTurn);
	const running = agents.length + jobs.length + opened.counts.running;
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
	const present =
		turnActive ||
		autopilot ||
		waiting > 0 ||
		running > 0 ||
		plan !== null ||
		goal !== null ||
		showsLast ||
		opened.rows.length > 0;
	const showsRunning = running > 0;
	const showsTodos = plan !== null;
	useLayoutEffect(() => {
		if (!present || inline) return;
		// The dock strips that say the same thing step aside while the board shows it (components.css).
		pane.setAttribute("data-work-board", "");
		if (showsRunning) pane.setAttribute("data-work-board-running", "");
		if (showsTodos) pane.setAttribute("data-work-board-todo", "");
		return () => {
			pane.removeAttribute("data-work-board");
			pane.removeAttribute("data-work-board-running");
			pane.removeAttribute("data-work-board-todo");
		};
	}, [pane, present, inline, showsRunning, showsTodos]);
	if (!present) return null;

	const working =
		agents.filter(agent => !WAITING_AGENT[agent.status]).length +
		jobs.length +
		opened.counts.running +
		(turnActive ? 1 : 0);
	const pulse = waiting > 0 || opened.counts.waiting > 0 ? "waiting" : working > 0 ? "working" : "idle";

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
	const jumpKey = actionShortcut("board.focus");

	return (
		<aside aria-label={t("workBoard.label")} className="omp-work-board" data-work-board-panel>
			{/* One line: the board's name, the plan's progress and its close; then the project of a linked worktree; then
			   one line of meters, the subscription accounts' windows and a metered provider's charge side by side where
			   they fit (each item's details are its tooltip). */}
			<header className="omp-work-board-head">
				<span aria-hidden className="omp-work-board-pulse" data-state={pulse} />
				<h2 className="omp-work-board-name">{t("workBoard.label")}</h2>
				{plan ? (
					<span
						className="omp-work-board-progress"
						title={t("workBoard.planProgress", { done: plan.done, total: plan.total })}
					>
						<SegmentBar
							label={t("workBoard.planProgress", { done: plan.done, total: plan.total })}
							segments={plan.segments}
						/>
						<span aria-hidden>
							{plan.done}/{plan.total}
						</span>
					</span>
				) : (
					<span />
				)}
				<IconButton
					className="omp-work-board-hide"
					icon={<X />}
					label={t("workBoard.hide")}
					onClick={() =>
						void saveGuiPreference("workBoard", false, () => useUiStore.getState().setWorkBoard(false))
					}
					size="sm"
				/>
				{projectLine?.worktree ? (
					<span className="omp-work-board-project" data-board-project title={projectLine.tooltip}>
						{projectLine.name}
					</span>
				) : null}
				<div className="omp-work-board-meters">
					<AccountLimit />
					{hasCharge(spend) ? (
						<Suspense fallback={null}>
							<SessionSpendLine spend={spend} />
						</Suspense>
					) : null}
				</div>
			</header>

			{waiting > 0 && (
				<BoardSection
					aside={jumpKey ? <Kbd shortcut={jumpKey} /> : null}
					count={waiting}
					live={t("workBoard.status.waiting", { count: waiting })}
					id="waiting"
					title={t("workBoard.waiting")}
					tone="warning"
				>
					<CappedRows
						cap={SECTION_CAP.waiting}
						items={[
							...(planProposal ? [{ id: "plan", label: t("workBoard.planReview") }] : []),
							...blocking.map(request => ({ id: request.id, label: requestLabel(request, t) })),
						]}
					>
						{item => (
							<BoardRow
								data={{ "data-board-waiting": item.id }}
								key={item.id}
								label={item.label}
								lead={<Dot tone="warning" />}
								onClick={() => focusPrompt(pane)}
								title={item.label}
							/>
						)}
					</CappedRows>
				</BoardSection>
			)}

			<Suspense fallback={null}>
				<FailedCheckSlot />
			</Suspense>

			{autopilot && (
				<BoardSection aside={autopilotText} id="autopilot" title={t("autopilot.name")}>
					<AutopilotBoardRows />
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
							lead={<Dot tone="info" />}
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
				<BoardSection count={agents.length + jobs.length} id="running" title={t("workBoard.running")}>
					<CappedRows
						cap={SECTION_CAP.running}
						items={[
							...presentedAgents.map(entry => ({ ...entry, kind: "agent" as const })),
							...presentedJobs.map(entry => ({ ...entry, kind: "job" as const })),
						]}
					>
						{entry =>
							entry.kind === "agent" ? (
								<AgentRow
									agent={entry.item}
									exiting={entry.exiting}
									key={entry.item.id}
									now={now}
									onOpen={() =>
										tabId && useUiStore.getState().openSubagentPanel({ tabId, agentId: entry.item.id })
									}
								/>
							) : (
								<BoardRow
									data={{ "data-board-job": entry.item.id }}
									exiting={entry.exiting}
									key={entry.item.id}
									label={entry.item.label}
									lead={<Dot tone="info" />}
									meta={clock(entry.item.startTime)}
									onClick={() => useUiStore.getState().openJobs()}
									title={`${entry.item.label}\n${t(`jobs.type.${entry.item.type}`)}`}
								/>
							)
						}
					</CappedRows>
				</BoardSection>
			)}

			{opened.rows.length > 0 && (
				<Suspense fallback={null}>
					<OpenedSection counts={opened.counts} now={now} rows={opened.rows} />
				</Suspense>
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
									<Dot tone="info" />
								) : row.status === "blocked" ? (
									<Dot tone="warning" />
								) : (
									<Dot ring tone="muted" />
								)
							}
							onClick={() => showTodoCard(pane)}
							title={row.content}
						/>
					))}
					{plan.hidden > 0 && (
						<li className="omp-work-board-more">{t("workBoard.moreTodos", { count: plan.hidden })}</li>
					)}
				</BoardSection>
			)}

			{goal && !autopilot && (
				<BoardSection id="goal" title={t("workBoard.goal")} aside={goalNote(goalStatus, t)}>
					<BoardRow
						data={{ "data-board-goal": goalStatus ?? "" }}
						label={goal.objective?.trim() || t("input.goal.label")}
						lead={
							<Dot tone={goalStatus === "complete" ? "success" : goalStatus === "active" ? "info" : "warning"} />
						}
						meta={goalMeta(goalDetail)}
						onClick={() => useUiStore.getState().openModes("goal")}
						title={[
							goal.objective,
							goalDetail?.tokenBudget
								? `${t("workBoard.goalBudgetLabel")}: ${t("workBoard.goalBudget", {
										used: formatTokens(goalDetail.tokensUsed ?? 0),
										budget: formatTokens(goalDetail.tokenBudget),
									})}`
								: null,
							goalDetail?.timeLimitSeconds
								? `${t("workBoard.goalTimeLabel")}: ${t("workBoard.goalTime", {
										used: formatDuration((goalDetail.timeUsedSeconds ?? 0) * 1000),
										limit: formatDuration(goalDetail.timeLimitSeconds * 1000),
									})}`
								: null,
						]
							.filter(Boolean)
							.join("\n")}
					/>
				</BoardSection>
			)}

			<Suspense fallback={null}>
				<SessionSlot
					aside={showsLast && lastTurn ? formatDuration(lastTurn.end - lastTurn.start) : undefined}
					turn={turnActive && startedAt !== null ? { start: startedAt, end: null } : lastTurn}
				/>
			</Suspense>
		</aside>
	);
}

/**
 * Mount point inside a session pane's chat region. It owns the gates — the user's pref and the side panel (the board
 * never sits beside it) — and the pane's width, which it watches itself (`workBoardFits`, `workBoardWidth`). Where the
 * board cannot dock (a phone, a tablet, a narrow window, a split pane, the side panel open) the pane shows the status
 * strip under its header instead, which expands into the same board: never nothing while the pref is on.
 */
export function WorkBoardHost() {
	const enabled = useUiStore(state => state.workBoard);
	const panelOpen = useUiStore(state => state.panelVisible);
	const slot = useRef<HTMLDivElement>(null);
	const [pane, setPane] = useState<HTMLElement | null>(null);
	const [paneWidth, setPaneWidth] = useState(0);
	useLayoutEffect(() => {
		const element = slot.current?.closest<HTMLElement>(".omp-session-pane") ?? null;
		setPane(element);
		if (!element) return;
		setPaneWidth(element.clientWidth);
		if (typeof ResizeObserver === "undefined") return;
		// The board sits beside the composer too, so its slot runs on past the chat region to the pane's foot.
		const region = slot.current?.parentElement;
		const reachFoot = () => {
			const gap = (element.getBoundingClientRect?.().bottom ?? 0) - (region?.getBoundingClientRect?.().bottom ?? 0);
			slot.current?.style.setProperty("inset-block-end", `${-Math.max(0, Math.round(gap))}px`);
		};
		const observer = new ResizeObserver(entries => {
			const size = entries.find(entry => entry.target === element)?.contentRect.width;
			if (size !== undefined) setPaneWidth(size);
			reachFoot();
		});
		observer.observe(element);
		if (region) observer.observe(region);
		return () => observer.disconnect();
	}, []);
	const shell = useShellMode();
	const form = workBoardForm({ enabled, panelOpen, fits: workBoardDocks(paneWidth, shell) });
	const width = form === "docked" ? workBoardWidth(paneWidth) : null;
	// The slot and the columns' reserve read the width from the pane (components.css `--omp-board-width`).
	useLayoutEffect(() => {
		if (!pane || width === null) return;
		pane.style.setProperty("--omp-board-width", `${width}px`);
		return () => {
			pane.style.removeProperty("--omp-board-width");
		};
	}, [pane, width]);
	return (
		<>
			<div className="omp-work-board-slot" ref={slot}>
				{form === "docked" && pane ? <WorkBoard pane={pane} /> : null}
			</div>
			{form === "strip" && pane && (
				<WorkBoardChip>
					<WorkBoard inline pane={pane} />
				</WorkBoardChip>
			)}
		</>
	);
}
