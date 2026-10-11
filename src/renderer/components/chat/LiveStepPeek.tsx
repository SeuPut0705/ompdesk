import { Brain, Radio } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import { useFrameSelector } from "../../hooks/use-frame-selector";
import { useMediaQuery } from "../../hooks/use-media-query";
import { cx, formatDuration } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { type MessagesStore, useMessagesStore } from "../../stores/messages";
import { useSessionRuntime } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { selectToolEntry, type ToolsStore, useToolsStore } from "../../stores/tools";
import { getToolHeader, getToolRenderer } from "../tools/index";
import { ToolPathTarget } from "../tools/ToolCard";
import { collapseWaitSteps, selectLiveStep } from "./live-step";
import { WorkMap } from "./WorkMap";
import { WorkOutcome } from "./WorkOutcome";
import { isSkippedWork, lastReasoningSentence, workConclusion, workNarrative } from "./work-view";

const seenSteps = new WeakMap<
	StoreApi<ToolsStore>,
	Map<string, { count: number; hydration: number; away: boolean; waitingForHydration: boolean }>
>();

/** One bounded work surface, with a replay strip rather than an accumulating log. */
export function LiveStepPeek({
	thinkingLive,
	toolCallIds,
	toolsOverride,
	nested = false,
	turnIsLive = true,
}: {
	thinkingLive: boolean;
	toolCallIds: readonly string[];
	toolsOverride?: StoreApi<ToolsStore>;
	nested?: boolean;
	turnIsLive?: boolean;
}) {
	const t = useT();
	const runtime = useSessionRuntime();
	const tools = toolsOverride ?? (runtime?.stores.get("tools") as StoreApi<ToolsStore> | undefined) ?? useToolsStore;
	const messages = (runtime?.stores.get("messages") as StoreApi<MessagesStore> | undefined) ?? useMessagesStore;
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
		) || t("chat.work.completed");
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
	const outcomeMode = !nested && !turnIsLive && following && expandedAgent === null;
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
	const now = useNowTick(running);
	const lastOutput = useRef({ selected, partial, time: Date.now() });
	if (lastOutput.current.selected !== selected || lastOutput.current.partial !== partial) {
		lastOutput.current = { selected, partial, time: Date.now() };
	}
	const silentSeconds = Math.floor(Math.max(0, now - lastOutput.current.time) / 1000);
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
	return (
		<div
			className={cx("omp-live-step", !reducedMotion && "omp-work-motion")}
			ref={boxRef}
			data-following={live}
			data-running={running}
			data-surface={kind}
			data-outcome={outcomeMode}
		>
			<div className="omp-work-narrative" key={`narrative-${selected}`}>
				{!nested && !turnIsLive
					? completion
					: entry
						? workNarrative(entry.toolName, entry.args, t, undefined, entry.intent)
						: t("chat.thinking.live")}
			</div>
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
					motion={!reducedMotion}
					running={turnIsLive}
					mainStepId={stepKey}
					completion={completion}
					expanded={expandedAgent}
					onExpandedChange={setExpandedAgent}
				/>
			) : null}
			{!outcomeMode ? (
				<div className="omp-live-work-heading">
					<Icon aria-hidden className="omp-live-step-icon" />
					<span>{header?.labelKey ? t(header.labelKey) : (header?.tool ?? t("chat.thinking.live"))}</span>
					{header?.path ? (
						<ToolPathTarget path={header.path} />
					) : header?.target ? (
						<span className="min-w-0 truncate font-mono" title={header.target}>
							{header.target}
						</span>
					) : null}
					<span className="omp-live-work-mode">
						{t(following ? (turnIsLive ? "chat.work.live" : "chat.work.latest") : "chat.work.replay")}
					</span>
				</div>
			) : null}
			{running && (kind === "bash" || kind === "eval") ? (
				<div className="omp-work-clock" role="status">
					{silentSeconds > 10
						? t("chat.work.stalled", { seconds: silentSeconds })
						: formatDuration(Math.max(0, now - startTime))}
				</div>
			) : null}
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
				{outcomeMode ? (
					<WorkOutcome toolCallIds={toolCallIds} />
				) : kind === "wait" && !entry?.isError && entry?.status !== "error" && entry?.status !== "aborted" ? (
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
					<div className="omp-live-work-calm">{lastReasoningSentence(reasoning) || t("chat.thinking.live")}</div>
				)}
			</div>
			<div className="omp-live-work-strip" role="group" aria-label={t("chat.work.steps")}>
				<div className="omp-live-work-chips" ref={stripRef}>
					{steps.map((step, index) => {
						const item = selectToolEntry(tools.getState(), step.id);
						if (!item) return null;
						const meta = getToolHeader(item.toolName, item.args);
						const StepIcon = meta.icon;
						const label = `${index + 1}. ${meta.labelKey ? t(meta.labelKey) : meta.tool}${meta.path || meta.target ? ` · ${meta.path ?? meta.target}` : ""}`;
						return (
							<button
								type="button"
								key={step.ids[0]}
								className={cx(
									"omp-live-work-chip",
									item.status !== "pending" && item.status !== "running" && "omp-live-work-chip--finished",
									live && step.ids.includes(selected) && !reducedMotion && "omp-work-pulse",
								)}
								aria-label={label}
								title={label}
								aria-pressed={step.ids.includes(selected)}
								data-step-id={step.id}
								onClick={() => {
									setReplay(step.id);
									setExpandedAgent(null);
								}}
							>
								<StepIcon aria-hidden className="omp-live-step-icon" />
								<span className="tabular-nums">{index + 1}</span>
							</button>
						);
					})}
				</div>
				<button
					type="button"
					className="omp-live-work-chip omp-live-work-follow"
					aria-pressed={following && (turnIsLive || nested || expandedAgent === null)}
					onClick={() => {
						setReplay(null);
						setExpandedAgent(null);
					}}
				>
					<Radio aria-hidden className="omp-live-step-icon" />
					{t(!nested && !turnIsLive ? "chat.work.outcome" : turnIsLive ? "chat.work.live" : "chat.work.latest")}
				</button>
			</div>
		</div>
	);
}
