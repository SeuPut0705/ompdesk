import { Brain, CornerDownLeft } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import { useFrameSelector } from "../../hooks/use-frame-selector";
import { useMediaQuery } from "../../hooks/use-media-query";
import { cx, formatDuration } from "../../lib/format";
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
import { WorkMap } from "./WorkMap";
import { WorkOutcome } from "./WorkOutcome";
import { isInterruptedError, type WorkGroupState, type WorkState, WorkStatus } from "./WorkStatus";
import { isSkippedWork, lastReasoningSentence, workConclusion, workNarrative } from "./work-view";

const seenSteps = new WeakMap<
	StoreApi<ToolsStore>,
	Map<string, { count: number; hydration: number; away: boolean; waitingForHydration: boolean }>
>();

/**
 * The live work card inside a running group: a head that says what is happening
 * now, one lane per subagent, the current step's own surface (terminal, editor,
 * capture…) sized to its content, and a replay strip rather than an accumulating
 * log. Nested inside an agent lane it renders only that agent's surface and strip.
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
	const contentRef = useRef<HTMLDivElement>(null);
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
		if (!latest) {
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
	const Renderer = entry ? getToolRenderer(entry.toolName) : null;
	const Icon = header?.icon ?? Brain;
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
				? workNarrative(entry.toolName, entry.args, t, undefined, entry.intent)
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
			: formatDuration(Math.max(0, now - startTime))
		: "";
	// Resize output directly without a React render. Only step changes ease the height;
	// streaming growth writes immediately so transcript measurements do not chase an animation.
	const smoothHeight = showSurface && motion && kind !== "browser" && kind !== "computer";
	const measuredStep = useRef(surfaceKey);
	useLayoutEffect(() => {
		const content = contentRef.current;
		const scroll = scrollRef.current;
		if (!scroll) return;
		if (!smoothHeight || !content || typeof ResizeObserver === "undefined") {
			scroll.style.height = "";
			delete scroll.dataset.heightTransition;
			return;
		}
		const style = getComputedStyle(scroll);
		const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
		const changedStep = measuredStep.current !== surfaceKey;
		measuredStep.current = surfaceKey;
		const measure = (animate: boolean) => {
			const height = `${Math.ceil(content.getBoundingClientRect().height + padding)}px`;
			if (scroll.style.height === height) return;
			scroll.dataset.heightTransition = String(animate);
			scroll.style.height = height;
		};
		measure(changedStep);
		const observer = new ResizeObserver(() => measure(false));
		observer.observe(content);
		return () => observer.disconnect();
	}, [smoothHeight, surfaceKey]);
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
						<div className="omp-work-narrative" key={`narrative-${surfaceKey}`} title={narrative}>
							{narrative}
						</div>
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
					expanded={expandedAgent}
					onExpandedChange={setExpandedAgent}
				/>
			) : null}
			{concurrent.length > 1 ? (
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
									<span className="omp-work-card-progress">
										{formatDuration(Math.max(0, now - step.startedAt))}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			) : null}
			{showSurface ? (
				<div className="omp-work-surface">
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
						<div className="omp-work-surface-content" ref={contentRef}>
							{calmWait ? (
								<div className="omp-live-work-calm" data-wait-line>
									{t("chat.work.waiting")}{" "}
									<span className="tabular-nums">
										· {formatDuration(Math.max(0, (live ? now : (entry?.endTime ?? now)) - startTime))}
									</span>
								</div>
							) : Renderer && entry ? (
								<Renderer
									key={surfaceKey}
									args={entry.args}
									result={entry.result}
									partialResult={partial}
									isPartial={entry.status === "pending" || entry.status === "running"}
									isError={entry.isError || entry.status === "error"}
									interrupted={entry.status === "aborted"}
									livePreview
									toolCallId={surfaceKey}
								/>
							) : (
								<div className="omp-live-work-calm">
									{lastReasoningSentence(reasoning) || t("chat.thinking.live")}
								</div>
							)}
						</div>
					</div>
				</div>
			) : null}
			{outcomeMode ? <WorkOutcome toolCallIds={toolCallIds} showConclusions={false} stoppedAt={stoppedAt} /> : null}
			{steps.length === 0 || stepsListed || (nested && following && steps.length <= 1) ? null : (
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
					{following ? null : (
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
			)}
		</div>
	);
}
