import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AutopilotChildLive } from "../../../../resources/gui-bridge/modes/autopilot-contracts";
import { formatCost, formatDuration, formatElapsed, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { useTabRpc } from "../../lib/tab-rpc";
import { tabAutopilotStore, useAutopilotStore } from "../../stores/autopilot";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { type ToolEntry, useToolsStore } from "../../stores/tools";
import { IconButton } from "../common";
import { BoardRow, BoardSection, CappedRows, Dot, SECTION_CAP } from "../layout/work-board/board-parts";
import { AreaIcon } from "./AreaIcon";
import { AutopilotControls } from "./AutopilotControls";
import { AutopilotCyclesSection } from "./AutopilotCycles";
import { AutopilotShipSection, ShipLandRow } from "./AutopilotShip";
import { autopilotStep, ratePrediction } from "./autopilot-view";
import { FocusChips } from "./FocusChips";
import { useAutopilotActions } from "./use-autopilot-actions";
import { useAutopilotStateText } from "./use-autopilot-state-text";

/** A call within this of the cycle's start belongs to it (the two clocks come from different events). */
const CLOCK_SLACK_MS = 500;

/** The cycle's tool calls, live and finished, oldest first. */
function useCycleCalls(since: number | undefined): ToolEntry[] {
	const live = useToolsStore(s => s.liveTools);
	const finishedVersion = useToolsStore(s => s.finishedVersion);
	// biome-ignore lint/correctness/useExhaustiveDependencies: finishedVersion marks the finished map changing in place.
	return useMemo(() => {
		if (since === undefined) return [];
		const finished = useToolsStore.getState().finishedTools;
		return [...finished.values(), ...live.values()]
			.filter(entry => entry.startTime >= since - CLOCK_SLACK_MS && entry.status !== "aborted")
			.sort((a, b) => a.startTime - b.startTime);
	}, [since, live, finishedVersion]);
}

/** One line for a call: the bash command, the path, or the tool's own intent. */
function callLabel(entry: ToolEntry): string {
	const { args } = entry;
	const text = [args.command, args.path, args.file_path, args.pattern, args.op].find(
		value => typeof value === "string",
	);
	return `${entry.toolName}${typeof text === "string" && text ? `  ${text.replace(/\s+/g, " ").slice(0, 80)}` : ""}`;
}

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

const STATE_TONE = {
	running: "info",
	stopping: "warning",
	paused: "warning",
	waiting_quota: "info",
	ended: "muted",
} as const;

/**
 * The head of an Autopilot tab's board, under its name: the run's state with the time it has been active, then its
 * tokens and dollars with the pace. The branch against its base and why the pace is what it is are the tooltip.
 */
export function AutopilotBoardHead() {
	const t = useT();
	useBranchStatus();
	const status = useAutopilotStore(s => s.status);
	const branchStatus = useAutopilotStore(s => s.branchStatus);
	const stateText = useAutopilotStateText();
	const state = status.state ?? "running";
	// The coordinator reports the active time at each change; between them a running run keeps counting.
	const receivedAt = useRef(Date.now());
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new status restarts the count from its own active time.
	useEffect(() => {
		receivedAt.current = Date.now();
	}, [status]);
	const now = useNowTick(state === "running");
	const activeMs = (status.activeMs ?? 0) + (state === "running" ? Math.max(0, now - receivedAt.current) : 0);
	const rate = ratePrediction(status.cycles ?? []);
	const tokensPerHour = status.totals?.tokensPerHour ?? rate?.tokensPerHour;
	const usdPerHour = status.totals?.usdPerHour ?? rate?.usdPerHour;
	const ended = state === "ended";
	const reason =
		status.reason && (state === "paused" || ended)
			? `${t(`autopilot.reason.${status.reason}`)}${status.detail ? ` — ${status.detail}` : ""}`
			: null;
	const text = ended ? (reason ?? t("autopilot.state.ended")) : (stateText ?? t(`autopilot.state.${state}`));
	const branchLine = status.branch
		? [
				status.branch,
				branchStatus
					? t("autopilot.ahead", {
							ahead: branchStatus.ahead,
							behind: branchStatus.behind,
							base: status.baseBranch ?? "",
						})
					: null,
			]
				.filter(Boolean)
				.join(" ")
		: null;
	return (
		<div className="omp-work-board-run" data-board-autopilot-head>
			<span
				className="omp-work-board-run-state"
				data-autopilot-reason={reason ? status.reason : undefined}
				data-autopilot-state={state}
				title={[t(`autopilot.state.${state}`), reason, branchLine].filter(Boolean).join("\n")}
			>
				<Dot ring={state === "running"} tone={STATE_TONE[state]} />
				<span className="min-w-0 flex-1 truncate" data-board-autopilot-text>
					{text}
				</span>
				<span className="shrink-0 text-sc-xs tabular-nums text-(--sc-text-muted)">{formatDuration(activeMs)}</span>
			</span>
			{status.totals && (
				<span
					className="truncate tabular-nums"
					data-autopilot-totals
					title={
						rate || tokensPerHour !== undefined
							? t("autopilot.rateTip", { sample: rate?.sample ?? 5 })
							: t("autopilot.rateNone")
					}
				>
					{t("autopilot.tokens", { tokens: formatTokens(status.totals.tokens) })} ·{" "}
					{formatCost(status.totals.usd, 2)}
					{tokensPerHour !== undefined && usdPerHour !== undefined
						? ` · ≈ ${t("autopilot.perHour", { tokens: formatTokens(tokensPerHour), usd: formatCost(usdPerHour, 2) })}`
						: ""}
				</span>
			)}
		</div>
	);
}

const CHILD_TONE = { running: "info", done: "success", failed: "danger", closed: "muted" } as const;

function ChildRow({ child }: { child: AutopilotChildLive }) {
	const t = useT();
	const tab = useTabsStore(s => s.tabs.find(candidate => candidate.id === child.tabId));
	const label = tab?.title ?? child.branch ?? child.area ?? child.tabId;
	return (
		<BoardRow
			data={{ "data-autopilot-child": child.tabId }}
			label={label}
			lead={<Dot ring={child.status === "running"} tone={CHILD_TONE[child.status]} />}
			meta={t(`autopilot.child.${child.status}`)}
			onClick={tab ? () => void useTabsStore.getState().switchTab(child.tabId) : undefined}
			title={[label, child.branch, t(`autopilot.child.${child.status}`)].filter(Boolean).join("\n")}
		/>
	);
}

/**
 * The run's first board section: the cycle in flight (its item, or "Picking an item…", with the step it is in), the
 * cycle's child sessions, the red streak from two on, where green cycles go and the controls. What the next cycle
 * should do is typed into the tab's own composer, as in any session. An ended run keeps only what it did.
 */
function AutopilotRunSection() {
	const t = useT();
	const now = useAutopilotStore(s => s.status.now);
	const state = useAutopilotStore(s => s.status.state);
	const children = useAutopilotStore(s => s.status.children);
	const redStreak = useAutopilotStore(s => s.status.redStreak);
	const stateText = useAutopilotStateText();
	const calls = useCycleCalls(now?.startedAt);
	const step = autopilotStep(calls);
	const running = useToolsStore(s => [...s.liveTools.values()].at(-1));
	const clock = useNowTick(now !== undefined);
	const ended = state === "ended";
	const item = now ? (now.title ?? (now.area ? t(`autopilot.area.${now.area}`) : t("autopilot.picking"))) : null;
	return (
		<BoardSection
			aside={now ? formatElapsed(Math.max(0, clock - now.startedAt)) : undefined}
			id="autopilot"
			title={now ? t("autopilot.cycleN", { n: now.n }) : t("autopilot.now")}
		>
			{now && item ? (
				<BoardRow
					data={{
						"data-autopilot-cycle-live": String(now.n),
						...(now.title ? { "data-autopilot-pick": "" } : {}),
					}}
					label={item}
					lead={now.area ? <AreaIcon area={now.area} /> : <Dot ring tone="info" />}
					meta={step ? t(`autopilot.step.${step}`) : undefined}
					title={[item, step ? t(`autopilot.step.${step}`) : null, running ? callLabel(running) : null]
						.filter(Boolean)
						.join("\n")}
				/>
			) : (
				!ended && (
					<BoardRow
						data={{ "data-autopilot-between": "" }}
						label={state === "running" ? t("autopilot.between") : (stateText ?? t(`autopilot.state.${state}`))}
						lead={<Dot tone="muted" />}
					/>
				)
			)}
			{(children ?? []).map(child => (
				<ChildRow child={child} key={child.tabId} />
			))}
			{redStreak !== undefined && redStreak >= 2 && (
				<BoardRow
					data={{ "data-autopilot-red-streak": String(redStreak) }}
					label={<span className="text-(--sc-text-muted)">{t("autopilot.redStreak", { n: redStreak })}</span>}
					lead={<Dot tone="warning" />}
				/>
			)}
			<ShipLandRow />
			{!ended && (
				<li className="omp-work-board-item">
					<div className="omp-work-board-actions" data-autopilot-controls>
						<AutopilotControls />
					</div>
				</li>
			)}
			{!ended && <FocusRow />}
		</BoardSection>
	);
}

/**
 * What the recent cycles left for later and no later cycle did: what the agent is likely to take next, before the
 * rotation's pick. One line each, the whole sentence in the tooltip; nothing while there is none. ✕ takes one off the
 * agent's list (a later cycle that leaves it again brings it back). What the next cycle should do first is typed into
 * the tab's composer.
 */
function AutopilotFollowupsSection() {
	const t = useT();
	const followups = useAutopilotStore(s => s.status.followups);
	const cycles = useAutopilotStore(s => s.status.followupCycles);
	const ended = useAutopilotStore(s => s.status.state === "ended");
	const { run, pending } = useAutopilotActions();
	if (!followups || followups.length === 0) return null;
	// The cycle that last left each one: how long it has waited (an older bridge sends none).
	const leftIn = new Map(followups.map((text, index) => [text, cycles?.[index]]));
	return (
		<BoardSection count={followups.length} id="followups" title={t("autopilot.followups")}>
			<CappedRows cap={SECTION_CAP.followups} items={followups}>
				{text => (
					<BoardRow
						action={
							ended ? undefined : (
								<IconButton
									data-autopilot-followup-dismiss=""
									disabled={pending === "followup_dismiss"}
									icon={<X />}
									label={t("autopilot.followupDismiss")}
									onClick={() => void run({ action: "followup_dismiss", text })}
									size="sm"
								/>
							)
						}
						data={{ "data-autopilot-followup": "" }}
						key={text}
						label={text}
						lead={<Dot ring tone="muted" />}
						meta={leftIn.get(text) === undefined ? undefined : `#${leftIn.get(text)}`}
						title={
							leftIn.get(text) === undefined
								? text
								: `${text}\n${t("autopilot.followupLeftIn", { n: leftIn.get(text) ?? 0 })}`
						}
					/>
				)}
			</CappedRows>
		</BoardSection>
	);
}

/** The focus areas the next cycles favour; a tap opens their toggles in place. */
function FocusRow() {
	const t = useT();
	const focus = useAutopilotStore(s => s.status.settings?.focus);
	const { run, pending } = useAutopilotActions();
	const [open, setOpen] = useState(false);
	const current = focus ?? [];
	const focusText =
		current.length > 0 ? current.map(area => t(`autopilot.area.${area}`)).join(", ") : t("autopilot.focus.all");
	return (
		<>
			<BoardRow
				data={{ "data-autopilot-focus-row": "", "data-board-expands": "", "data-open": String(open) }}
				label={`${t("autopilot.focus.label")} · ${focusText}`}
				lead={<Dot tone="muted" />}
				onClick={() => setOpen(!open)}
				title={t("autopilot.focus.next")}
			/>
			{open && (
				<li className="omp-work-board-item">
					<div className="omp-work-board-detail">
						<FocusChips
							compact
							disabled={pending === "configure"}
							focus={current}
							onToggle={area =>
								void run({
									action: "configure",
									focus: current.includes(area) ? current.filter(other => other !== area) : [...current, area],
								})
							}
						/>
					</div>
				</li>
			)}
		</>
	);
}

/**
 * An Autopilot tab's board sections, the run's home: the cycle in flight with the controls, the cycles, the open
 * follow-ups and shipping. The board's own sections (questions, subagents, todos, changes) follow them.
 */
export function AutopilotBoardSections() {
	return (
		<>
			<AutopilotRunSection />
			<AutopilotCyclesSection />
			<AutopilotFollowupsSection />
			<AutopilotShipSection />
		</>
	);
}
