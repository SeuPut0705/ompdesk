/**
 * Work board: this session's live state docked in the right margin of a wide session pane, in four
 * zones — Needs you (a question or approval, a plan up for review, a failed check, a session the agent
 * opened that waits for an answer), Now (the turn's current step, subagents, jobs, sessions at work),
 * the plan (the goal, then the todos) and Current work (what the turn left). Everything is
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

import { Bot, Check, Rocket, SquareTerminal, Target } from "lucide-react";
import { type CSSProperties, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionSpend } from "../../../../../resources/gui-bridge/model-setup-contracts";
import type { RpcGoalState, SubagentSnapshot } from "../../../../shared/rpc-types";
import { useBackgroundJobs } from "../../../hooks/use-background-jobs";
import { useOpenedChildren } from "../../../hooks/use-opened-children";
import { usePresence } from "../../../hooks/use-presence";
import { useSessionSpend } from "../../../hooks/use-session-spend";
import { useShellMode } from "../../../hooks/use-shell-mode";
import { pendingAsks } from "../../../lib/attention";
import { lazyChunk } from "../../../lib/chunk-load";
import { cx, formatDuration, formatTokens } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { actionShortcut } from "../../../lib/keymap";
import { useNowTick } from "../../../lib/now-tick";
import { useProjectNames, useWorktreeKindLabels } from "../../../lib/project-origin";
import { costKinds, costWords } from "../../../lib/spend";
import { useTabRpc } from "../../../lib/tab-rpc";
import { ensureAgentReviewSubscription, useAgentReviewStore } from "../../../stores/agent-review";
import { useCheckFailed } from "../../../stores/attention";
import { isAutopilotTab, isLiveAutopilot, useAutopilotStore } from "../../../stores/autopilot";
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
import { Kbd } from "../../common";
import { statusMeta, subagentElapsedMs, subagentPrimaryLabel } from "../../panels/subagent-graph";
import { getToolHeader } from "../../tools/index";
import { AccountLimit } from "../AccountLimit";
import { childUsageText } from "../sidebar/sidebar-family";
import {
	BoardRow,
	BoardSection,
	CappedRows,
	Dot,
	elapsedLabel,
	KindMark,
	SECTION_CAP,
	WorkTreeButton,
} from "./board-parts";
import { WorkBoardChip } from "./WorkBoardChip";
import {
	attentionClause,
	boardCounts,
	goalMeta,
	isWaitingSubagent,
	liveSubagents,
	requestLabel,
	type TodoBoard,
	todoBoard,
	workBoardDocks,
	workBoardForm,
	workBoardWidth,
	workingSubagents,
} from "./work-board";

/** An Autopilot run's head line and sections: a lazy chunk, since only a run's tab draws them. */
const AutopilotBoardHead = lazyChunk(() =>
	import("../../autopilot/AutopilotBoard").then(module => ({ default: module.AutopilotBoardHead })),
);
const AutopilotBoardSections = lazyChunk(() =>
	import("../../autopilot/AutopilotBoard").then(module => ({ default: module.AutopilotBoardSections })),
);
/** The opened-session rows load when a session has such children: most never do (the strip loads them ahead). */
const NowChildren = lazy(() => import("./WorkBoardOpened").then(module => ({ default: module.NowChildren })));
const WaitingChildren = lazy(() => import("./WorkBoardOpened").then(module => ({ default: module.WaitingChildren })));
/** The session rows (changes, last check, dev servers, same checkout, memory) and a failed check: a lazy chunk, since
 * the phone's first screen (the strip) never draws them. */
const NeedsCheck = lazyChunk(() => import("./WorkBoardSession").then(module => ({ default: module.NeedsCheck })));
const SessionSlot = lazyChunk(() => import("./WorkBoardSession").then(module => ({ default: module.SessionSlot })));
/** Whether the newest check failed: a row of Needs you and the head's count. */
const FailedCheckWatch = lazyChunk(() =>
	import("./WorkBoardSession").then(module => ({ default: module.FailedCheckWatch })),
);
/** The metered-spend rows load when this session spent on a metered provider (most sessions run on subscriptions). */
const SessionSpendLine = lazy(() =>
	import("./SessionSpendLine").then(module => ({ default: module.SessionSpendLine })),
);

/** Whether the session spent anything on a metered provider: only then the spend rows load and show. */
function hasCharge(spend: SessionSpend | null): spend is SessionSpend {
	return spend !== null && Object.values(spend.providers).some(row => row.billing === "metered" && row.cost > 0);
}

/** Steps Now lists for the turn: the newest one, the live one when a call runs. */
const TURN_STEPS = 1;
/** A call's clock and the turn's come from different events of one batch: a call within this of the start is the turn's. */
const TURN_CLOCK_SLACK_MS = 500;

function stepHeader(entry: ToolEntry, t: (key: string, params?: Record<string, string | number>) => string) {
	const header = getToolHeader(entry.toolName, entry.args);
	return {
		Icon: header.icon,
		text: header.target || (header.labelKey ? t(header.labelKey, header.labelParams) : header.tool),
	};
}

function SegmentBar({ segments, label }: { segments: TodoBoard["segments"]; label: string }) {
	return (
		<span
			aria-label={label}
			className="omp-work-board-segments"
			role="img"
			style={{ "--segments": segments.length } as CSSProperties}
		>
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

/**
 * Budget and time the goal has used: stock's `get_goal`, read again whenever the goal changes, a turn starts or ends,
 * and on each of stock's `goal_updated` frames (`frame`, a new object every frame), which follow every tool call a
 * goal turn makes: a long turn's budget moves as it runs.
 */
function useGoalDetail(objective: string | undefined, frame: unknown, turnActive: boolean) {
	const rpc = useTabRpc();
	const [detail, setDetail] = useState<RpcGoalState | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: objective, each goal frame and the turn are the re-read triggers.
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
	}, [rpc, objective, frame, turnActive]);
	return detail;
}

/** The turn's newest calls, live and finished, oldest first. */
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
	const waiting = isWaitingSubagent(agent.status);
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
			lead={waiting ? <KindMark icon={Bot} tone="muted" /> : <KindMark icon={Bot} tone="info" />}
			meta={elapsed === null ? undefined : elapsedLabel(elapsed)}
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
	// Only a linked worktree gets a line: `acme-web · Parallel work` instead of its folder name; a run `acme-web` and its rocket.
	const projectLine = boardCwd ? boardProject(boardCwd) : null;
	const kindLabels = useWorktreeKindLabels();

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
	const goalState = useSessionStore(state => state.goalState);
	const goalStatus = goalState?.status;
	const goalDetail = useGoalDetail(goal?.objective, goalState, turnActive);
	// An Autopilot tab's board is the run's home: its head names the run, its first sections are the run's.
	const autopilotTab = useAutopilotStore(isAutopilotTab);
	const autopilotRunning = useAutopilotStore(state => isLiveAutopilot(state) && state.status.state === "running");

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
	const checkFailed = useCheckFailed(tabId);
	// What the last turn left (the session rows' lazy chunk tells it), for a quiet board's head.
	const [outcome, setOutcome] = useState<string | null>(null);

	const asks = pendingAsks({ pendingRequests: pending, loginRequestIds }, planProposal !== null);
	const showsLast = !turnActive && lastTurn !== null;
	const present =
		turnActive ||
		autopilotTab ||
		asks.length > 0 ||
		running > 0 ||
		presentedAgents.length + presentedJobs.length > 0 ||
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

	// The head, the Needs you section and its live region read these (the strip's label reads the same), so a figure is
	// never stated twice with two values.
	const counts = boardCounts({
		asks,
		childrenWaiting: opened.counts.waiting,
		childrenRunning: opened.counts.running,
		checkFailed,
		agents: agents.length,
		agentsWorking: workingSubagents(agents).length,
		jobs: jobs.length,
		turnWorking: turnActive || autopilotRunning,
	});
	const needsText = counts.attention ? attentionClause(counts.attention, t) : "";
	const needsTone = counts.attention?.kind === "checkFailed" ? "danger" : "warning";
	// One clause, the most important: what needs the person, else what runs, else that the board works (a child at
	// work alone is "Working…", never "Idle"), else what the last turn left.
	const clause = counts.attention
		? { tone: needsTone, text: needsText }
		: counts.running > 0
			? { tone: undefined, text: t("workBoard.head.running", { count: counts.running }) }
			: counts.working > 0
				? { tone: undefined, text: t("workBoard.step.working") }
				: {
						tone: undefined,
						text:
							[showsLast ? t("workBoard.head.done") : null, outcome].filter(Boolean).join(" · ") ||
							t("workBoard.head.idle"),
					};

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
	const clock = (from: number | null) => (from === null ? "" : elapsedLabel(Math.max(0, now - from)));
	// The turn's paced token rate, the one the per-message meter shows; not shown between turns.
	const speed = turnLive && rate != null && rate > 0 ? t("chat.meter.rate", { rate: formatTokenRate(rate) }) : "";
	const jumpKey = actionShortcut("board.focus");

	const askItems = [
		...(planProposal ? [{ id: "plan", label: t("workBoard.planReview"), review: true }] : []),
		...blocking.map(request => ({ id: request.id, label: requestLabel(request, t), review: false })),
	];
	const waitingChildren = opened.rows.filter(row => row.status === "waiting");
	const nowChildren = opened.rows.filter(row => row.status !== "waiting");
	// The presented lists, not the live ones: the last row of a finished agent or job fades out inside its section.
	const runsNow = turnActive || presentedAgents.length + presentedJobs.length > 0 || opened.counts.running > 0;
	const showsNow = runsNow || nowChildren.length > 0;
	// What the sessions this one opened lead to (the Work tree sheet) sits in the head of the section that lists them.
	const workTree = opened.rows.length === 0 ? null : showsNow ? "now" : "needs";
	const showsGoal = goal !== null && !autopilotTab;
	const lastStep = steps.at(-1);
	const nowLead = turnActive
		? (turnState ?? (lastStep ? lastStep.intent?.trim() || stepHeader(lastStep, t).text : ""))
		: presentedAgents[0]
			? subagentPrimaryLabel(presentedAgents[0].item, 48)
			: (presentedJobs[0]?.item.label ??
				(nowChildren[0] ? nowChildren[0].title || t("workBoard.review.untitled") : ""));
	const nowFigure = counts.running + counts.childrenRunning;
	const planLead =
		plan?.active ??
		plan?.rows[0]?.content ??
		(showsGoal && goal
			? goal.objective?.trim() || t("input.goal.label")
			: t("workBoard.doneFolded", { count: plan?.done ?? 0 }));
	// A finished plan with no goal leads with its "N done": that is its figure already.
	const planFigure = plan && (plan.rows.length > 0 || showsGoal) ? `${plan.done}/${plan.total}` : undefined;

	return (
		<aside aria-label={t("workBoard.label")} className="omp-work-board" data-work-board-panel>
			{/* One line of status (the pulse, the one clause that matters, a figure for what runs), the project of a
			   linked worktree, then one line of meters: the subscription accounts' windows and a metered provider's
			   charge side by side where they fit (each item's details are its tooltip). The strip names itself above. */}
			<header className="omp-work-board-head" data-board-head>
				<span aria-hidden className="omp-work-board-pulse" data-state={counts.pulse} />
				<h2 className="omp-work-board-name" data-board-name>
					{autopilotTab ? (
						// A run's board is named by its rocket (the user's call, 23 Oct 2026); the word is for screen readers.
						<>
							<Rocket aria-hidden className="inline size-(--sc-icon-sm) align-[-0.125em]" />
							<span className="sr-only">{t("autopilot.name")}</span>
						</>
					) : (
						t("workBoard.label")
					)}
				</h2>
				{inline ? null : (
					<>
						<p className="omp-work-board-status" data-board-status>
							<span data-tone={clause.tone}>{clause.text}</span>
						</p>
						{counts.needs > 0 && counts.running > 0 ? (
							<span
								className="omp-work-board-figure"
								data-tone="info"
								title={t("workBoard.head.running", { count: counts.running })}
							>
								{t("workBoard.head.runningShort", { count: counts.running })}
							</span>
						) : null}
					</>
				)}
				{autopilotTab ? (
					<Suspense fallback={null}>
						<AutopilotBoardHead />
					</Suspense>
				) : null}
				{projectLine?.worktree ? (
					<span className="omp-work-board-project" data-board-project title={projectLine.tooltip}>
						{projectLine.worktree.worktree?.kind === "autopilot" ? (
							// A run is its project and the rocket, as in the title bar; the word is for screen readers.
							<>
								{projectLine.worktree.project}
								<Rocket aria-hidden className="ms-1 inline size-3 align-[-0.125em]" />
								<span className="sr-only"> · {kindLabels.autopilot}</span>
							</>
						) : (
							projectLine.name
						)}
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

			{counts.needs > 0 && (
				<BoardSection
					action={workTree === "needs" ? <WorkTreeButton /> : null}
					aside={jumpKey ? <Kbd shortcut={jumpKey} /> : null}
					count={counts.needs}
					live={needsText}
					id="needs"
					title={t("workBoard.needs")}
					tone={needsTone}
				>
					<CappedRows cap={SECTION_CAP.asks} items={askItems}>
						{item => (
							<BoardRow
								data={{ "data-board-waiting": item.id }}
								key={item.id}
								label={item.label}
								lead={<Dot tone="warning" />}
								onClick={() => focusPrompt(pane)}
								tag={{ word: t(item.review ? "workBoard.kind.review" : "workBoard.kind.ask"), tone: "warning" }}
								title={item.label}
							/>
						)}
					</CappedRows>
					{checkFailed && (
						<Suspense fallback={null}>
							<NeedsCheck tag={{ word: t("workBoard.kind.check"), tone: "danger" }} />
						</Suspense>
					)}
					{waitingChildren.length > 0 && (
						<Suspense fallback={null}>
							<WaitingChildren
								now={now}
								rows={waitingChildren}
								tag={{ word: t("workBoard.kind.child"), tone: "warning" }}
							/>
						</Suspense>
					)}
				</BoardSection>
			)}

			{autopilotTab && (
				<Suspense fallback={null}>
					<AutopilotBoardSections />
				</Suspense>
			)}

			{showsNow && (
				<BoardSection
					action={workTree === "now" ? <WorkTreeButton /> : null}
					aside={turnActive ? [clock(startedAt), speed].filter(Boolean).join(" · ") : undefined}
					id="now"
					summary={{ lead: nowLead, count: nowFigure > 0 ? nowFigure : undefined }}
					title={runsNow ? t("workBoard.now") : t("workBoard.opened")}
				>
					{turnActive &&
						(turnState ? (
							<BoardRow
								data={{ "data-board-turn": "" }}
								label={turnState}
								lead={<Dot tone="info" />}
								title={turnState}
							/>
						) : (
							steps.map((entry, index) => {
								const { Icon, text } = stepHeader(entry, t);
								const live = entry.status === "pending" || entry.status === "running";
								const last = index === steps.length - 1;
								return (
									<BoardRow
										data={{ "data-board-step": entry.status, ...(last ? { "data-board-turn": "" } : {}) }}
										key={`${entry.startTime}:${index}`}
										label={entry.intent?.trim() && last ? entry.intent : text}
										lead={
											<Icon
												aria-hidden
												className={cx("size-3.5", live ? "text-(--sc-info)" : "text-(--sc-text-subtle)")}
											/>
										}
										meta={
											live
												? clock(entry.startTime)
												: formatDuration(Math.max(0, (entry.endTime ?? entry.startTime) - entry.startTime))
										}
										title={text}
									/>
								);
							})
						))}
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
									lead={<KindMark icon={SquareTerminal} tone="info" />}
									meta={clock(entry.item.startTime)}
									onClick={() => useUiStore.getState().openJobs()}
									title={`${entry.item.label}\n${t(`jobs.type.${entry.item.type}`)}`}
								/>
							)
						}
					</CappedRows>
					{nowChildren.length > 0 && (
						<Suspense fallback={null}>
							<NowChildren now={now} rows={nowChildren} />
						</Suspense>
					)}
				</BoardSection>
			)}

			{(plan || showsGoal) && (
				<BoardSection
					id="plan"
					summary={{ lead: planLead, count: planFigure }}
					mid={
						plan ? (
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
						) : undefined
					}
					// Not "Plan": that is the plan-mode card's word, and Needs you can say "a plan is ready for review".
					title={t(plan ? (showsGoal ? "workBoard.goalAndTodos" : "dock.todo") : "workBoard.goal")}
				>
					{showsGoal && goal && (
						<BoardRow
							data={{ "data-board-goal": goalStatus ?? "" }}
							label={goal.objective?.trim() || t("input.goal.label")}
							lead={
								<KindMark
									icon={Target}
									tone={goalStatus === "complete" ? "success" : goalStatus === "active" ? "info" : "warning"}
								/>
							}
							meta={goalMeta(goalDetail) ?? goalNote(goalStatus, t)}
							onClick={() => useUiStore.getState().openModes("goal")}
							title={[
								goal.objective,
								goalNote(goalStatus, t),
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
					)}
					{plan && plan.done > 0 && (
						<BoardRow
							data={{ "data-board-done-folded": "" }}
							label={
								<span className="text-(--sc-text-subtle)">
									{t("workBoard.doneFolded", { count: plan.done })}
								</span>
							}
							lead={<Check aria-hidden className="size-3 text-(--sc-success)" />}
						/>
					)}
					{plan?.rows.map((row, index) => (
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
					{plan && plan.hidden > 0 && (
						<li className="omp-work-board-more">{t("workBoard.moreTodos", { count: plan.hidden })}</li>
					)}
				</BoardSection>
			)}

			<Suspense fallback={null}>
				<SessionSlot
					aside={showsLast && lastTurn ? formatDuration(lastTurn.end - lastTurn.start) : undefined}
					onOutcome={setOutcome}
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
 * strip under its header instead, which expands into the same board: never nothing. A reveal for this pane's tab (`revealWorkBoard`: the composer chip's or the dock's "show the run")
 * unfolds the run's section and brings it into view, docked, or expands the strip.
 */
export function WorkBoardHost() {
	const panelOpen = useUiStore(state => state.panelVisible);
	const reveal = useUiStore(state => state.workBoardReveal);
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;
	const [stripReveal, setStripReveal] = useState(0);
	const seenReveal = useRef(reveal?.seq ?? 0);
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
	const form = workBoardForm({ panelOpen, fits: workBoardDocks(paneWidth, shell) });
	useEffect(() => {
		if (!reveal || reveal.seq === seenReveal.current) return;
		seenReveal.current = reveal.seq;
		if (reveal.tabId !== null && reveal.tabId !== tabId) return;
		if (form === "strip") setStripReveal(reveal.seq);
		else if (form === "docked") {
			// The strip opens the run's zone in its panel instead, never through the docked board's folds.
			const folds = useWorkBoardStore.getState();
			if (folds.collapsed.autopilot) folds.toggle("autopilot");
			// After the unfold above has rendered the section's rows.
			setTimeout(() => {
				const section = pane?.querySelector<HTMLElement>('[data-board-section="autopilot"]');
				section?.scrollIntoView?.({ block: "nearest" });
				section?.querySelector<HTMLElement>(".omp-work-board-fold")?.focus();
			}, 0);
		}
	}, [reveal, tabId, form, pane]);
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
			{/* The pane's one failed-check watcher, mounted whatever the board shows and wherever it sits (docked, the
			   strip, the strip's open panel): two watchers on one tab entry let a closing one clear the failure. */}
			<Suspense fallback={null}>
				<FailedCheckWatch />
			</Suspense>
			<div className="omp-work-board-slot" ref={slot}>
				{form === "docked" && pane ? <WorkBoard pane={pane} /> : null}
			</div>
			{form === "strip" && pane && (
				<WorkBoardChip reveal={stripReveal}>
					<WorkBoard inline pane={pane} />
				</WorkBoardChip>
			)}
		</>
	);
}
