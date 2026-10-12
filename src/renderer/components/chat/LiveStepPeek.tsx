import { Brain, CornerDownLeft } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { selectToolEntry, type ToolsStore, useToolsStore } from "../../stores/tools";
import { getToolHeader, getToolRenderer } from "../tools/index";
import { ToolPathTarget } from "../tools/ToolCard";
import { collapseWaitSteps, selectLiveStep } from "./live-step";
import { WorkMap } from "./WorkMap";
import { WorkOutcome } from "./WorkOutcome";
import { type WorkGroupState, type WorkState, WorkStatus } from "./WorkStatus";
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
}: {
	thinkingLive: boolean;
	toolCallIds: readonly string[];
	toolsOverride?: StoreApi<ToolsStore>;
	nested?: boolean;
	/** The owner's resolved state (ExecutionGroup's summary, or the lane's agent); never recomputed here. */
	state?: WorkGroupState;
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
	const stepKey = useFrameSelector(tools, s => {
		const step = selectLiveStep(
			toolCallIds,
			{
				get: id => {
					const entry = selectToolEntry(s, id);
					return isSkippedWork(entry) ? undefined : entry;
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
	const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
	const validReplay = useFrameSelector(tools, state =>
		replay && isSkippedWork(selectToolEntry(state, replay)) ? null : replay,
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
	// Only the chosen entry/result is subscribed: unrelated partial results are ignored.
	const entry = useFrameSelector(tools, s => (selected ? selectToolEntry(s, selected) : undefined));
	const partial = useFrameSelector(tools, s => (selected ? s.partialResults.get(selected) : undefined));
	const reasoning = useFrameSelector(messages, s => (selected === "thinking" ? s.streamingThinking.slice(-600) : ""));
	const scrollRef = useRef<HTMLDivElement>(null);
	const stripRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);
	const previousStep = useRef(selected);
	const header = entry ? getToolHeader(entry.toolName, entry.args) : null;
	const following = validReplay === null;
	// A finished group always states its outcome, also while one agent lane stays open.
	const outcomeMode = !nested && !turnIsLive && following;
	const live = following && turnIsLive;
	const kind = selected === "thinking" ? "thinking" : (header?.tool ?? "thinking");
	const latest = kind === "bash" || kind === "eval" || kind === "write" || kind === "edit" || kind === "ast_edit";
	// stripKey deliberately contains only status/kind, not any tool output.
	void stripKey;
	const steps = collapseWaitSteps(toolCallIds, {
		get: id => {
			const entry = selectToolEntry(tools.getState(), id);
			return isSkippedWork(entry) ? undefined : entry;
		},
	});
	const selectedStep = steps.find(step => step.ids.includes(selected));
	const startTime = selectedStep?.startedAt ?? entry?.startTime ?? 0;
	const running = live && (entry?.status === "running" || entry?.status === "pending");
	const now = useNowTick(live && visible);
	const lastOutput = useRef({ selected, partial, time: Date.now() });
	if (lastOutput.current.selected !== selected || lastOutput.current.partial !== partial) {
		lastOutput.current = { selected, partial, time: Date.now() };
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
		(nested || !following || (!!entry && kind !== "thinking" && !calmWait && !(kind === "task" && hasLanes)));
	const narrative =
		!nested && !turnIsLive
			? completion
			: entry && selected !== "thinking"
				? workNarrative(entry.toolName, entry.args, t, undefined, entry.intent)
				: t("chat.thinking.live");
	const sub = !following
		? ""
		: waitingFor && (kind === "wait" || kind === "task" || kind === "thinking")
			? t("chat.work.waitingFor", { names: waitingFor })
			: kind === "thinking" && turnIsLive
				? lastReasoningSentence(reasoning)
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
						<div className="omp-work-narrative" key={`narrative-${selected}`} title={narrative}>
							{narrative}
						</div>
						{sub ? (
							<div className="omp-work-sub" title={sub}>
								{sub}
							</div>
						) : null}
					</div>
					{headMeta ? (
						<span className="omp-work-head-meta omp-work-clock" data-stalled={stalled} role="status">
							{headMeta}
						</span>
					) : null}
				</div>
			) : null}
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
						{!following ? (
							<span className="omp-live-work-mode" data-mode="replay">
								{t("chat.work.replay")}
							</span>
						) : null}
					</div>
					<div
						className="omp-live-step-scroll"
						ref={scrollRef}
						tabIndex={0}
						role="region"
						aria-label={t("chat.work.surface")}
						onScroll={event => {
							const element = event.currentTarget;
							stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
						}}
					>
						{calmWait ? (
							<div className="omp-live-work-calm" data-wait-line>
								{t("chat.work.waiting")}{" "}
								<span className="tabular-nums">
									· {formatDuration(Math.max(0, (live ? now : (entry?.endTime ?? now)) - startTime))}
								</span>
							</div>
						) : Renderer && entry ? (
							<Renderer
								key={selected}
								args={entry.args}
								result={entry.result}
								partialResult={partial}
								isPartial={entry.status === "pending" || entry.status === "running"}
								isError={entry.isError || entry.status === "error"}
								interrupted={entry.status === "aborted"}
								livePreview
								toolCallId={selected}
							/>
						) : (
							<div className="omp-live-work-calm">
								{lastReasoningSentence(reasoning) || t("chat.thinking.live")}
							</div>
						)}
					</div>
				</div>
			) : null}
			{outcomeMode ? <WorkOutcome toolCallIds={toolCallIds} showConclusions={false} /> : null}
			{steps.length === 0 || (nested && following && steps.length <= 1) ? null : (
				<div className="omp-live-work-strip" role="group" aria-label={t("chat.work.steps")}>
					<div className="omp-live-work-chips" ref={stripRef}>
						{steps.map((step, index) => {
							const item = selectToolEntry(tools.getState(), step.id);
							if (!item) return null;
							const meta = getToolHeader(item.toolName, item.args);
							const StepIcon = meta.icon;
							const label = `${index + 1}. ${meta.labelKey ? t(meta.labelKey) : meta.tool}${meta.path || meta.target ? ` · ${meta.path ?? meta.target}` : ""}`;
							const current = step.ids.includes(selected);
							const state =
								item.status === "pending" || item.status === "running"
									? "running"
									: item.status === "error" || (item.isError && item.status !== "aborted")
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
