import { Brain, CornerDownLeft } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { AgentMessage } from "../../../shared/rpc-types";
import { useFrameSelector } from "../../hooks/use-frame-selector";
import { useMediaQuery } from "../../hooks/use-media-query";
import { cx, formatDuration, formatElapsed } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { type MessagesStore, useMessagesStore } from "../../stores/messages";
import { useSessionRuntime } from "../../stores/session-runtime-context";
import { type SubagentsStore, useSubagentsStore } from "../../stores/subagents";
import { useTabsStore } from "../../stores/tabs";
import type { TodoSnapshot } from "../../stores/todo";
import { selectToolEntry, type ToolEntry, type ToolsStore, useToolsStore } from "../../stores/tools";
import { getToolHeader, getToolRenderer } from "../tools/index";
import { ToolPathTarget } from "../tools/ToolCard";
import { collapseWaitSteps, selectLiveStep } from "./live-step";
import { WorkContext } from "./WorkContext";
import { WorkCrossfade, workMotionDuration } from "./WorkCrossfade";
import { SubagentSurface, WorkMap } from "./WorkMap";
import { WorkNotes } from "./WorkNotes";
import { WorkOutcome } from "./WorkOutcome";
import { isInterruptedError, type WorkGroupState, type WorkState, WorkStatus } from "./WorkStatus";
import { isSkippedWork, lastReasoningSentence, workConclusion, workNarrative } from "./work-view";

const seenSteps = new WeakMap<
	StoreApi<ToolsStore>,
	Map<string, { count: number; hydration: number; away: boolean; waitingForHydration: boolean }>
>();

/**
 * One head, stable agent lanes, and a fixed-height stage shared by every step.
 * Nested agent views retain their own clock, stall warning and replay strip.
 */
export function LiveStepPeek({
	thinkingLive,
	toolCallIds,
	toolsOverride,
	nested = false,
	state = "running",
	stoppedAt,
	stepsListed = false,
	summaryRow,
	carriesContext = false,
	todoSnapshots,
	notes,
}: {
	thinkingLive: boolean;
	toolCallIds: readonly string[];
	toolsOverride?: StoreApi<ToolsStore>;
	nested?: boolean;
	/** The owner's resolved state (ExecutionGroup's summary, or the lane's agent); never recomputed here. */
	state?: WorkGroupState;
	/** Timestamp of stock's empty aborted reply after this group. */
	stoppedAt?: number;
	/** The group's own step list is open below: the replay strip would only repeat it. */
	stepsListed?: boolean;
	/** The group's summary row (counts, output meter, step-list toggle), carried in this card's head. */
	summaryRow?: ReactNode;
	/** Only the transcript's live-tail group carries the session context. */
	carriesContext?: boolean;
	todoSnapshots?: readonly TodoSnapshot[];
	notes?: readonly AgentMessage[];
}) {
	const turnIsLive = state === "running";
	const t = useT();
	const runtime = useSessionRuntime();
	const tools = toolsOverride ?? (runtime?.stores.get("tools") as StoreApi<ToolsStore> | undefined) ?? useToolsStore;
	const messages = (runtime?.stores.get("messages") as StoreApi<MessagesStore> | undefined) ?? useMessagesStore;
	const subagents = (runtime?.stores.get("subagents") as StoreApi<SubagentsStore> | undefined) ?? useSubagentsStore;
	const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
	const focused = useTabsStore(s => !runtime || s.activeTabId === runtime.tabId);
	const boxRef = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(true);
	const [catchUp, setCatchUp] = useState(0);
	const [catchUpReplay, setCatchUpReplay] = useState<string[]>([]);
	const hydrationVersion = useFrameSelector(tools, s => s.hydrationVersion);
	// Not steps of their own: stock's internal skipped waits, and in an agent lane the
	// agent's `yield` submission (its result already reads as the lane's conclusion).
	const hidden = (entry: ToolEntry | undefined) => isSkippedWork(entry) || (nested && entry?.toolName === "yield");
	const stepKey = useFrameSelector(tools, s => {
		const step = selectLiveStep(
			toolCallIds,
			{
				get: id => {
					const entry = selectToolEntry(s, id);
					return hidden(entry) ? undefined : entry;
				},
			},
			thinkingLive,
		);
		return step?.kind === "tool" ? step.id : step?.kind === "thinking" ? "thinking" : "";
	});
	const stripKey = useFrameSelector(tools, s =>
		toolCallIds
			.map(id => {
				const entry = selectToolEntry(s, id);
				return entry ? `${id}:${entry.status}:${entry.toolName}` : "";
			})
			.join("|"),
	);
	const [replay, setReplay] = useState<string | null>(null);
	const pinnedFromParallel = useRef(false);
	const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
	const validReplay = useFrameSelector(tools, state =>
		replay && hidden(selectToolEntry(state, replay)) ? null : replay,
	);
	const selected = validReplay ?? stepKey;
	const completion =
		useFrameSelector(messages, state =>
			turnIsLive || nested
				? ""
				: workConclusion(state.messages, state.liveMessages, id =>
						toolCallIds.includes(tools.getState().entryKeyForCallId(id)),
					),
		) ||
		t(
			state === "failed"
				? "chat.work.failed"
				: state === "interrupted"
					? "chat.work.interrupted"
					: "chat.work.completed",
		);
	// stripKey deliberately contains only status/kind, not any tool output.
	void stripKey;
	const steps = collapseWaitSteps(toolCallIds, {
		get: id => {
			const entry = selectToolEntry(tools.getState(), id);
			return hidden(entry) ? undefined : entry;
		},
	});
	const following = validReplay === null;
	// Between steps the model thinks: the head says so, and the surface keeps showing the step that
	// just finished instead of collapsing and growing back, so one step flows into the next.
	const thinkingBetween = selected === "thinking" && following && !nested && steps.length > 0;
	const surfaceKey = thinkingBetween ? (steps.at(-1)?.id ?? selected) : selected;
	// Only the shown entry/result is subscribed: unrelated partial results are ignored.
	const entry = useFrameSelector(tools, s => (surfaceKey ? selectToolEntry(s, surfaceKey) : undefined));
	const partial = useFrameSelector(tools, s => (surfaceKey ? s.partialResults.get(surfaceKey) : undefined));
	const reasoning = useFrameSelector(messages, s => (selected === "thinking" ? s.streamingThinking.slice(-600) : ""));
	const scrollRef = useRef<HTMLDivElement>(null);
	const stripRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);
	const previousStep = useRef(selected);
	const header = entry ? getToolHeader(entry.toolName, entry.args) : null;
	// A finished group always states its outcome, also while one agent lane stays open.
	const outcomeMode = !nested && !turnIsLive && following;
	const kind = surfaceKey === "thinking" ? "thinking" : (header?.tool ?? "thinking");
	const latest = kind === "bash" || kind === "eval" || kind === "write" || kind === "edit" || kind === "ast_edit";
	const selectedStep = steps.find(step => step.ids.includes(surfaceKey));
	// Calls running at the same time (parallel tool calls): each is listed so none hides behind another.
	const concurrent = steps.filter(step => {
		const item = selectToolEntry(tools.getState(), step.id);
		return turnIsLive && (item?.status === "running" || item?.status === "pending");
	});
	const pinnedLive = validReplay !== null && concurrent.some(step => step.ids.includes(validReplay));
	const live = (following || pinnedLive) && turnIsLive;
	useLayoutEffect(() => {
		if (!pinnedFromParallel.current || pinnedLive) return;
		pinnedFromParallel.current = false;
		setReplay(null);
	}, [pinnedLive]);
	const startTime = selectedStep?.startedAt ?? entry?.startTime ?? 0;
	const running = live && (entry?.status === "running" || entry?.status === "pending");
	const now = useNowTick(live && visible);
	const lastOutput = useRef({ surfaceKey, partial, time: Date.now() });
	if (lastOutput.current.surfaceKey !== surfaceKey || lastOutput.current.partial !== partial) {
		lastOutput.current = { surfaceKey, partial, time: Date.now() };
	}
	const silentSeconds = Math.floor(Math.max(0, now - lastOutput.current.time) / 1000);
	const waitingFor = useFrameSelector(subagents, s =>
		nested || !turnIsLive
			? ""
			: [...s.subagents.values()]
					.filter(
						node =>
							(node.status === "running" || node.status === "pending") &&
							!!node.parentToolCallId &&
							toolCallIds.includes(tools.getState().entryKeyForCallId(node.parentToolCallId)),
					)
					.map(node => node.id)
					.join(", "),
	);
	const hasLanes = useFrameSelector(
		subagents,
		s =>
			!nested &&
			[...s.subagents.values()].some(
				node =>
					!!node.parentToolCallId &&
					toolCallIds.includes(tools.getState().entryKeyForCallId(node.parentToolCallId)),
			),
	);
	const activityKey = useFrameSelector(subagents, s =>
		[...s.subagents.values()]
			.filter(
				node =>
					node.parentToolCallId && toolCallIds.includes(tools.getState().entryKeyForCallId(node.parentToolCallId)),
			)
			.map(node => `${node.id}:${node.status}:${node.lastUpdate}:${node.progress?.currentTool}`)
			.join("|"),
	);
	const canAutoFollow =
		!nested && turnIsLive && following && expandedAgent === null && (kind === "task" || kind === "wait");
	const chooseAgent = useCallback(
		(previous: string | null) => {
			let latest: { id: string; lastUpdate: number } | null = null;
			let active: { id: string; lastUpdate: number } | null = null;
			for (const node of subagents.getState().subagents.values()) {
				if (
					!node.parentToolCallId ||
					!toolCallIds.includes(tools.getState().entryKeyForCallId(node.parentToolCallId))
				)
					continue;
				if (!latest || node.lastUpdate > latest.lastUpdate) latest = node;
				if (
					(node.status === "running" || node.status === "pending") &&
					(!active || node.lastUpdate > active.lastUpdate)
				)
					active = node;
			}
			// A rehydrated live wait may have only finished workers: restore its last real output,
			// not an empty stage. A running worker always takes precedence.
			return (
				active?.id ?? (previous && subagents.getState().subagents.has(previous) ? previous : latest?.id) ?? null
			);
		},
		[subagents, tools, toolCallIds],
	);
	const [autoAgent, setAutoAgent] = useState<string | null>(() => (canAutoFollow ? chooseAgent(null) : null));
	const lastFollow = useRef(0);
	if (!lastFollow.current) lastFollow.current = Date.now();
	useEffect(() => {
		void activityKey;
		if (!canAutoFollow) return;
		const follow = () => {
			const candidate = chooseAgent(autoAgent);
			if (candidate !== autoAgent) {
				lastFollow.current = Date.now();
				setAutoAgent(candidate);
			}
		};
		const delay = autoAgent ? Math.max(0, 3000 - (Date.now() - lastFollow.current)) : 0;
		if (!delay) {
			follow();
			return;
		}
		const timer = setTimeout(follow, delay);
		return () => clearTimeout(timer);
	}, [activityKey, canAutoFollow, autoAgent, chooseAgent]);
	const shownAgent = expandedAgent ?? (canAutoFollow ? autoAgent : null);
	const groupKey = toolCallIds[0] ?? "thinking";
	useEffect(() => {
		if (typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting ?? false));
		if (boxRef.current) observer.observe(boxRef.current);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		const visibility = () => setVisible(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", visibility);
		return () => document.removeEventListener("visibilitychange", visibility);
	}, []);
	useEffect(() => {
		let seen = seenSteps.get(tools);
		if (!seen) {
			seen = new Map();
			seenSteps.set(tools, seen);
		}
		let previous = seen.get(groupKey);
		if (!previous || previous.hydration > hydrationVersion) {
			previous = { count: steps.length, hydration: hydrationVersion, away: false, waitingForHydration: false };
			seen.set(groupKey, previous);
		}
		if (!focused || !visible) {
			previous.away = true;
			previous.waitingForHydration ||= !focused;
			return;
		}
		if (previous.waitingForHydration && previous.hydration === hydrationVersion) return;
		if (previous.away && steps.length > previous.count) setCatchUp(steps.length - previous.count);
		previous.count = Math.max(previous.count, steps.length);
		previous.hydration = hydrationVersion;
		previous.away = false;
		previous.waitingForHydration = false;
	}, [focused, visible, groupKey, tools, steps.length, hydrationVersion]);
	useEffect(
		() => () => {
			const previous = seenSteps.get(tools)?.get(groupKey);
			if (!previous) return;
			previous.away = true;
			previous.waitingForHydration ||= Boolean(runtime && useTabsStore.getState().activeTabId !== runtime.tabId);
		},
		[tools, groupKey, runtime],
	);
	useEffect(() => {
		if (!catchUpReplay.length) return;
		setReplay(catchUpReplay[0] ?? null);
		const timer = setTimeout(
			() => {
				setCatchUpReplay(rest => rest.slice(1));
				if (catchUpReplay.length === 1) setReplay(null);
			},
			reducedMotion ? 0 : 350,
		);
		return () => clearTimeout(timer);
	}, [catchUpReplay, reducedMotion]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: streaming content must repin the nested renderer after layout.
	useLayoutEffect(() => {
		if (previousStep.current !== selected) {
			stickRef.current = true;
			previousStep.current = selected;
		}
		const element = scrollRef.current;
		if (!element) return;
		const shownTool = element.parentElement?.dataset.tool;
		const keepNewest =
			shownTool === "bash" ||
			shownTool === "eval" ||
			shownTool === "write" ||
			shownTool === "edit" ||
			shownTool === "ast_edit";
		if (!latest && !keepNewest) {
			element.scrollTop = 0;
			return;
		}
		if (stickRef.current) {
			element.scrollTop = element.scrollHeight;
			for (const child of element.querySelectorAll<HTMLElement>("pre, .overflow-y-auto, .overflow-auto")) {
				child.scrollTop = child.scrollHeight;
			}
		}
	}, [entry, partial, latest, selected]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: selected/status changes update chip geometry and aria-pressed after layout.
	useLayoutEffect(() => {
		const strip = stripRef.current;
		if (!strip) return;
		const revealCurrent = () => {
			const current = strip.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
			if (!current) return;
			const viewport = strip.getBoundingClientRect();
			const chip = current.getBoundingClientRect();
			if (chip.right > viewport.right) strip.scrollLeft += chip.right - viewport.right;
			else if (chip.left < viewport.left) strip.scrollLeft -= viewport.left - chip.left;
		};
		revealCurrent();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(revealCurrent);
		observer.observe(strip);
		return () => observer.disconnect();
	}, [selected, stripKey]);
	const calmWait = kind === "wait" && !entry?.isError && entry?.status !== "error" && entry?.status !== "aborted";
	const motion = !reducedMotion;
	// Top level, the head carries thinking and calm waits, and agent lanes are the task's own surface:
	// the surface below is for real tool output only.
	const showSurface =
		!outcomeMode &&
		expandedAgent === null &&
		!(nested && !turnIsLive && steps.length === 0) &&
		(nested ||
			!following ||
			(!!entry &&
				kind !== "thinking" &&
				!calmWait &&
				!(kind === "task" && hasLanes) &&
				// The todo row above already shows the list this step writes.
				!(kind === "todo" && carriesContext)));
	const narrative =
		!nested && !turnIsLive
			? completion
			: entry && selected !== "thinking"
				? entry.status === "pending" && entry.streamingArgs
					? header?.labelKey
						? t(header.labelKey)
						: (header?.tool ?? t("chat.thinking.live"))
					: workNarrative(entry.toolName, entry.args, t, undefined, entry.intent)
				: t("chat.thinking.live");
	const sub =
		!following && !pinnedLive
			? ""
			: waitingFor && (kind === "wait" || kind === "task" || selected === "thinking")
				? t("chat.work.waitingFor", { names: waitingFor })
				: selected === "thinking" && turnIsLive
					? lastReasoningSentence(reasoning)
					: concurrent.length > 1
						? t("chat.work.parallel", { count: concurrent.length })
						: calmWait && live
							? t("chat.work.waiting")
							: "";
	const headState: WorkState = state === "interrupted" ? "stopped" : state;
	// One clock: the current step's elapsed time, or the no-output warning for a silent command.
	const stalled = running && (kind === "bash" || kind === "eval") && silentSeconds > 10;
	const headMeta = running
		? stalled
			? t("chat.work.stalled", { seconds: silentSeconds })
			: formatElapsed(now - startTime)
		: "";
	// A calm wait's own clock: ticking while live, the exact span once it ended.
	const waited = !calmWait
		? ""
		: live
			? formatElapsed(now - startTime)
			: formatDuration(Math.max(0, (entry?.endTime ?? now) - startTime));
	// Once real output opens the stage, thinking never collapses it between steps.
	const openedStage = useRef(false);
	if (showSurface || hasLanes) openedStage.current = true;
	const stageOpen = !nested && (shownAgent !== null || (!outcomeMode && openedStage.current));
	const [stagePresent, setStagePresent] = useState(stageOpen);
	const retainedSurface = useRef<ReactNode>(null);
	const retainedFrame = useRef<{ identity: string; agent: string | null; tool: string | null } | null>(null);
	useLayoutEffect(() => {
		if (stageOpen) setStagePresent(true);
		else if (!motion) setStagePresent(false);
		else {
			const timer = setTimeout(() => setStagePresent(false), workMotionDuration(boxRef.current));
			return () => clearTimeout(timer);
		}
	}, [stageOpen, motion]);
	return (
		<div
			className={cx("omp-live-step", motion && "omp-work-motion")}
			ref={boxRef}
			data-following={live}
			data-running={running}
			data-surface={kind}
			data-outcome={outcomeMode}
			data-nested={nested}
			data-state={nested ? undefined : headState}
		>
			{!nested ? (
				<div className="omp-work-head">
					<WorkStatus
						state={headState}
						label={t(
							state === "running"
								? "subagent.status.started"
								: state === "failed"
									? "subagent.status.failed"
									: state === "interrupted"
										? "subagent.status.cancelled"
										: "subagent.status.completed",
						)}
						motion={motion}
					/>
					<div className="omp-work-head-text">
						<WorkCrossfade identity={`${surfaceKey}:${state}`} motion={motion}>
							<div className="omp-work-narrative" title={narrative}>
								{narrative}
							</div>
						</WorkCrossfade>
						{sub ? (
							<div className="omp-work-sub" title={headMeta ? `${sub} · ${headMeta}` : sub}>
								{sub}
								{headMeta ? " · " : null}
								{headMeta ? (
									<span className="omp-work-clock" data-stalled={stalled}>
										{headMeta}
									</span>
								) : null}
							</div>
						) : null}
					</div>
					{summaryRow || (headMeta && !sub) ? (
						<div className="omp-work-head-side">
							{headMeta && !sub ? (
								// Alone, the clock rides on the narrative's line instead of adding one.
								<span className="omp-work-clock omp-work-head-meta" data-stalled={stalled}>
									{headMeta}
								</span>
							) : null}
							{summaryRow}
						</div>
					) : null}
				</div>
			) : null}
			<span className="sr-only" role="status">
				{stalled ? t("chat.work.stalled", { seconds: 10 }) : ""}
			</span>
			{!nested ? <WorkContext live={carriesContext} snapshot={todoSnapshots?.at(-1)} /> : null}
			{!nested && notes?.length ? <WorkNotes messages={notes} live={turnIsLive} /> : null}
			{catchUp > 0 ? (
				<button
					type="button"
					className="omp-work-catch-up"
					onClick={() => {
						setCatchUpReplay(steps.slice(-catchUp).map(step => step.id));
						setCatchUp(0);
						setExpandedAgent(null);
					}}
				>
					{t("chat.work.catchUp", { count: catchUp, plural: catchUp === 1 ? "" : "s" })}
				</button>
			) : null}
			{!nested ? (
				<WorkMap
					toolCallIds={toolCallIds}
					active={turnIsLive && focused && visible}
					motion={motion}
					expanded={shownAgent}
					onExpandedChange={id => {
						setExpandedAgent(id ?? (expandedAgent === null ? shownAgent : null));
					}}
				/>
			) : null}
			{!nested && (stageOpen || stagePresent) ? (
				<div className="omp-work-stage-shell" data-open={stageOpen} aria-hidden={!stageOpen} inert={!stageOpen}>
					<div
						className="omp-work-stage"
						role="region"
						aria-label={t("chat.work.surface")}
						data-settled={
							thinkingBetween ||
							(!shownAgent && !showSurface) ||
							(canAutoFollow && !!shownAgent && !waitingFor) ||
							undefined
						}
					>
						{stageOpen ? renderStage() : retainedSurface.current}
					</div>
				</div>
			) : null}
			{nested ? (
				<WorkCrossfade identity={surfaceKey} motion={motion}>
					{renderSurface()}
				</WorkCrossfade>
			) : null}
			{outcomeMode ? (
				<div className="omp-work-outcome-shell">
					<div className="omp-work-outcome-content">
						<WorkOutcome toolCallIds={toolCallIds} showConclusions={false} stoppedAt={stoppedAt} />
					</div>
				</div>
			) : null}
			{renderStrip()}
		</div>
	);

	function renderStage() {
		if (shownAgent || showSurface) {
			retainedFrame.current = {
				identity: shownAgent ? `agent:${shownAgent}` : surfaceKey,
				agent: shownAgent,
				tool: shownAgent ? null : surfaceKey,
			};
		}
		const frame = retainedFrame.current;
		const surface = frame ? (
			<WorkCrossfade identity={frame.identity} motion={motion}>
				{frame.agent ? (
					<SubagentSurface id={frame.agent} store={subagents} />
				) : (
					renderSurface(frame.tool ?? surfaceKey)
				)}
			</WorkCrossfade>
		) : null;
		const stage = (
			<>
				{renderConcurrent()}
				{surface}
			</>
		);
		retainedSurface.current = stage;
		return stage;
	}
	function renderConcurrent() {
		return concurrent.length > 1 ? (
			<ul className="omp-work-parallel" aria-label={t("chat.work.parallel", { count: concurrent.length })}>
				{concurrent.map(step => {
					const item = selectToolEntry(tools.getState(), step.id);
					if (!item) return null;
					const meta = getToolHeader(item.toolName, item.args);
					const StepIcon = meta.icon;
					const shown = step.ids.includes(surfaceKey);
					return (
						<li key={step.ids[0]}>
							<button
								type="button"
								className="omp-work-parallel-row"
								aria-current={shown || undefined}
								onClick={() => {
									pinnedFromParallel.current = !(shown && following);
									setReplay(shown && following ? null : step.id);
									setExpandedAgent(null);
								}}
							>
								<WorkStatus state="running" label={t("subagent.status.started")} motion={motion} />
								<StepIcon aria-hidden className="omp-live-step-icon" />
								<span className="omp-work-parallel-label">
									{workNarrative(item.toolName, item.args, t, undefined, item.intent)}
								</span>
								<span className="omp-work-card-progress">{formatElapsed(now - step.startedAt)}</span>
							</button>
						</li>
					);
				})}
			</ul>
		) : null;
	}
	function renderSurface(id = surfaceKey) {
		const entry = selectToolEntry(tools.getState(), id);
		const partial = tools.getState().partialResults.get(id);
		const header = entry ? getToolHeader(entry.toolName, entry.args) : null;
		const Renderer = entry ? getToolRenderer(entry.toolName) : null;
		const Icon = header?.icon ?? Brain;
		const kind = header?.tool ?? "thinking";
		const calmWait = kind === "wait" && !entry?.isError && entry?.status !== "error" && entry?.status !== "aborted";
		return showSurface || id !== surfaceKey ? (
			<div className="omp-work-surface" data-tool={kind}>
				<div className="omp-live-work-heading">
					<Icon aria-hidden className="omp-live-step-icon" />
					<span className="shrink-0">
						{header?.labelKey ? t(header.labelKey) : (header?.tool ?? t("chat.thinking.live"))}
					</span>
					{header?.path ? (
						<ToolPathTarget path={header.path} />
					) : header?.target && kind !== "bash" && kind !== "eval" ? (
						<span className="min-w-0 truncate font-mono" title={header.target}>
							{header.target}
						</span>
					) : null}
					{!following && !pinnedLive ? (
						<span className="omp-live-work-mode" data-mode="replay">
							{t("chat.work.replay")}
						</span>
					) : thinkingBetween ? (
						<span className="omp-live-work-mode">{t("chat.work.justDone")}</span>
					) : nested && headMeta ? (
						// A lane has no head of its own: its clock and no-output warning sit on the step line.
						<span className="omp-live-work-mode omp-work-clock" data-stalled={stalled}>
							{headMeta}
						</span>
					) : null}
				</div>
				<div
					className="omp-live-step-scroll"
					ref={scrollRef}
					tabIndex={0}
					role="region"
					aria-label={t("chat.work.surface")}
					data-settled={thinkingBetween || undefined}
					onScroll={event => {
						const element = event.currentTarget;
						stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
					}}
				>
					<div className="omp-work-surface-content">
						{calmWait ? (
							<div className="omp-live-work-calm" data-wait-line>
								{t("chat.work.waiting")}
								{waited ? <span className="tabular-nums"> · {waited}</span> : null}
							</div>
						) : Renderer && entry ? (
							<Renderer
								key={id}
								args={entry.args}
								result={entry.result}
								partialResult={partial}
								isPartial={entry.status === "pending" || entry.status === "running"}
								isError={entry.isError || entry.status === "error"}
								interrupted={entry.status === "aborted"}
								livePreview
								toolCallId={id}
							/>
						) : (
							<div className="omp-live-work-calm">
								{lastReasoningSentence(reasoning) || t("chat.thinking.live")}
							</div>
						)}
					</div>
				</div>
			</div>
		) : null;
	}
	function renderStrip() {
		return steps.length === 0 || stepsListed || (nested && following && steps.length <= 1) ? null : (
			<div className="omp-live-work-strip" role="group" aria-label={t("chat.work.steps")}>
				<div className="omp-live-work-chips" ref={stripRef}>
					{steps.map((step, index) => {
						const item = selectToolEntry(tools.getState(), step.id);
						if (!item) return null;
						const meta = getToolHeader(item.toolName, item.args);
						const StepIcon = meta.icon;
						const label = `${index + 1}. ${meta.labelKey ? t(meta.labelKey) : meta.tool}${meta.path || meta.target ? ` · ${meta.path ?? meta.target}` : ""}`;
						const current = step.ids.includes(selected);
						const errored = item.status === "error" || (item.isError && item.status !== "aborted");
						const state =
							item.status === "pending" || item.status === "running"
								? "running"
								: isInterruptedError(item, stoppedAt)
									? "stopped"
									: errored
										? "failed"
										: "done";
						return (
							<button
								type="button"
								key={step.ids[0]}
								className={cx(
									"omp-live-work-chip",
									state !== "running" && "omp-live-work-chip--finished",
									live && current && motion && "omp-work-pulse",
								)}
								data-state={state}
								aria-label={label}
								title={label}
								aria-pressed={current}
								data-step-id={step.id}
								onClick={() => {
									pinnedFromParallel.current = false;
									setReplay(step.id);
									setExpandedAgent(null);
								}}
							>
								<StepIcon aria-hidden className="omp-live-step-icon" />
							</button>
						);
					})}
				</div>
				{following && expandedAgent === null ? null : (
					<button
						type="button"
						className="omp-live-work-chip omp-live-work-follow"
						onClick={() => {
							pinnedFromParallel.current = false;
							setReplay(null);
							setExpandedAgent(null);
						}}
					>
						<CornerDownLeft aria-hidden className="omp-live-step-icon" />
						{t(
							!nested && !turnIsLive
								? "chat.work.backToOutcome"
								: turnIsLive
									? "chat.work.backToCurrent"
									: "chat.work.backToLatest",
						)}
					</button>
				)}
			</div>
		);
	}
}
