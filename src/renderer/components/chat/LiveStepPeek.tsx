import { Brain, CornerDownLeft } from "lucide-react";
import {
	createContext,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useReducer,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import type { StoreApi } from "zustand/vanilla";
import type { AgentMessage } from "../../../shared/rpc-types";
import { useFrameSelector } from "../../hooks/use-frame-selector";
import { useMediaQuery } from "../../hooks/use-media-query";
import { cx, formatDuration, formatElapsed, resultDetails, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { type MessagesStore, useMessagesStore } from "../../stores/messages";
import { useSessionRuntime } from "../../stores/session-runtime-context";
import { type SubagentNode, type SubagentsStore, useSubagentsStore } from "../../stores/subagents";
import { useTabsStore } from "../../stores/tabs";
import type { TodoSnapshot } from "../../stores/todo";
import { selectToolEntry, type ToolEntry, type ToolsStore, useToolsStore } from "../../stores/tools";
import { getToolHeader, getToolRenderer, type ToolHeader } from "../tools/index";
import { ToolPathTarget } from "../tools/ToolCard";
import { collapseWaitSteps, selectLiveStep, type WorkStripStep } from "./live-step";
import { liveFocusTarget, revealLiveFocus, STAGE_SCROLL_KEYS } from "./stage-follow";
import { WorkContext } from "./WorkContext";
import { useWorkFrameOutgoing, WorkCrossfade, workMotionDuration } from "./WorkCrossfade";
import { SubagentSurface, WorkMap } from "./WorkMap";
import { WorkNotes } from "./WorkNotes";
import { WorkOutcome } from "./WorkOutcome";
import { isInterruptedError, type WorkGroupState, type WorkState, WorkStatus } from "./WorkStatus";
import { isSkippedWork, lastReasoningSentence, workNarrative } from "./work-view";

const seenSteps = new WeakMap<
	StoreApi<ToolsStore>,
	Map<string, { count: number; hydration: number; away: boolean; waitingForHydration: boolean }>
>();

/** An auto-followed agent keeps the stage at least this long before a main step may take it. */
const AGENT_DWELL_MS = 2000;
/** Moving the stage from one auto-followed agent to another waits longer: lanes report in bursts. */
const AGENT_SWITCH_MS = 3000;
/** Parallel picks appear only for an overlap that lasts, and stay briefly after it ends. */
const PICKS_APPEAR_MS = 150;
const PICKS_LINGER_MS = 600;

/** A streaming call's arguments minus an intent still being written, which may stop mid-word. */
function settledArgs(entry: ToolEntry): Record<string, unknown> {
	if (entry.status !== "pending" || !entry.streamingArgs || Object.keys(entry.args).at(-1) !== "i") return entry.args;
	const { i: _unfinished, ...settled } = entry.args;
	return settled;
}

/**
 * The shown step's own words for the head's reserved sub line when nothing live is said there:
 * its target (command, path, pattern) unless the narrative already names it, else the latest
 * line of its progress output. A read's output is the file itself, not progress: its last line
 * (a lone "};") says nothing about the step. Empty when the step has neither — nothing is made up.
 */
function stepDetail(header: ToolHeader | null, narrative: string, partial: unknown): string {
	const target = (header?.path || header?.target || "").trim();
	// A code cell's target is its title or language, which its narrative already states.
	if (target && header?.tool !== "eval" && !narrative.includes(target)) return target;
	if (header?.activity === "read") return "";
	return (
		resultText(partial)
			.split("\n")
			.map(line => line.trim())
			.findLast(Boolean) ?? ""
	);
}

/**
 * A call becomes a step on screen once it has something real to say: execution, finished
 * arguments, a wire intent, a finished streamed intent, or a streamed argument value (a command
 * or path as it is typed). Until then the card keeps the previous step, so a step never flashes
 * its bare tool name or an empty surface first.
 */
function stepReady(entry: ToolEntry) {
	return (
		entry.status !== "pending" ||
		!entry.streamingArgs ||
		!!entry.intent?.trim() ||
		Object.values(settledArgs(entry)).some(value => value !== "" && value != null)
	);
}

/**
 * An agent's tools in the order they started. Its store lists finished calls before live ones,
 * so the raw order reshuffles whenever a call ends and the lane's surface would flip with it.
 */
function byStart(ids: readonly string[], state: ToolsStore): readonly string[] {
	return [...ids].sort(
		(a, b) =>
			(selectToolEntry(state, a)?.startTime ?? 0) - (selectToolEntry(state, b)?.startTime ?? 0) ||
			(a < b ? -1 : a > b ? 1 : 0),
	);
}

function agentHasOutput(node: SubagentNode, store: SubagentsStore) {
	const surface = store.surfaces.get(node.id)?.getState();
	return (
		(node.progress?.toolCount ?? 0) > 0 ||
		!!node.progress?.currentTool ||
		(surface?.liveTools.size ?? 0) + (surface?.finishedTools.size ?? 0) > 0
	);
}

/** The top-level card lends its strip row to a lane the reader opened, so only one strip ever shows.
    `undefined`: not inside a lane; `null`: inside a lane that draws no strip (auto-followed, or its
    row has not mounted yet): the card's own strip stays the one strip. */
const LaneStripSlot = createContext<HTMLElement | null | undefined>(undefined);

/**
 * The card's frame before the model's first event: the same head the run then fills,
 * instead of a bare spinner that the card later replaces.
 */
export function WorkCardPending() {
	const t = useT();
	const motion = !useMediaQuery("(prefers-reduced-motion: reduce)");
	return (
		<div className={cx("omp-live-step", motion && "omp-work-motion")} data-state="running" data-pending>
			<div className="omp-work-head">
				<WorkStatus state="running" label={t("subagent.status.started")} motion={motion} />
				<div className="omp-work-head-text">
					<div className="omp-work-narrative">{t("chat.thinking.live")}</div>
					<div className="omp-work-sub-shell" data-open="true">
						<div className="omp-work-sub" aria-hidden>
							{"\u00a0"}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

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
	runStartedAt,
	headline,
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
	/** When the run began; the head's clock counts the whole run from here (default: its first step). */
	runStartedAt?: number;
	/** A finished card's title (goal, todo, task); the neutral state label otherwise. Never the reply. */
	headline?: string;
}) {
	const turnIsLive = state === "running";
	const t = useT();
	const runtime = useSessionRuntime();
	const tools = toolsOverride ?? (runtime?.stores.get("tools") as StoreApi<ToolsStore> | undefined) ?? useToolsStore;
	const messages = (runtime?.stores.get("messages") as StoreApi<MessagesStore> | undefined) ?? useMessagesStore;
	const subagents = (runtime?.stores.get("subagents") as StoreApi<SubagentsStore> | undefined) ?? useSubagentsStore;
	const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
	const focused = useTabsStore(s => !runtime || s.activeTabId === runtime.tabId);
	const laneStripSlot = useContext(LaneStripSlot);
	const outgoingFrame = useWorkFrameOutgoing();
	const boxRef = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(true);
	const [catchUp, setCatchUp] = useState(0);
	const [catchUpReplay, setCatchUpReplay] = useState<string[]>([]);
	const [focusStep, setFocusStep] = useState<string | null>(null);
	const hydrationVersion = useFrameSelector(tools, s => s.hydrationVersion);
	// Not steps of their own: stock's internal skipped waits, and in an agent lane the
	// agent's `yield` submission (its result already reads as the lane's conclusion).
	const hidden = (entry: ToolEntry | undefined) => isSkippedWork(entry) || (nested && entry?.toolName === "yield");
	// Calls still streaming their first argument are not steps yet (see stepReady).
	const shown = (entry: ToolEntry | undefined) => (entry && !hidden(entry) && stepReady(entry) ? entry : undefined);
	const stepKey = useFrameSelector(tools, s => {
		const step = selectLiveStep(
			nested ? byStart(toolCallIds, s) : toolCallIds,
			{ get: id => shown(selectToolEntry(s, id)) },
			thinkingLive,
		);
		return step?.kind === "tool" ? step.id : step?.kind === "thinking" ? "thinking" : "";
	});
	const stripKey = useFrameSelector(tools, s =>
		toolCallIds
			.map(id => {
				const entry = shown(selectToolEntry(s, id));
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
		headline ||
		t(
			state === "failed"
				? "chat.work.failed"
				: state === "interrupted"
					? "chat.work.interrupted"
					: "chat.work.completed",
		);
	// stripKey deliberately contains only status/kind, not any tool output.
	void stripKey;
	const steps = collapseWaitSteps(nested ? byStart(toolCallIds, tools.getState()) : toolCallIds, {
		get: id => shown(selectToolEntry(tools.getState(), id)),
	});
	const following = validReplay === null;
	// Between steps the model thinks: the surface and narrative keep the step that just finished
	// instead of collapsing and growing back, so one step flows into the next.
	const thinkingBetween = selected === "thinking" && following && !nested && steps.length > 0;
	// A task spawned beside a command that still runs never takes the stage from it: its agents
	// have their lanes above, the command's output stays in view, and the parallel list names both.
	const companion =
		following && !nested && turnIsLive && selectToolEntry(tools.getState(), selected)?.toolName === "task"
			? steps.findLast(step => {
					const item = selectToolEntry(tools.getState(), step.id);
					return item?.toolName !== "task" && (item?.status === "running" || item?.status === "pending");
				})?.id
			: undefined;
	const surfaceKey = thinkingBetween ? (steps.at(-1)?.id ?? selected) : (companion ?? selected);
	// Only the shown entry/result is subscribed: unrelated partial results are ignored.
	const entry = useFrameSelector(tools, s => (surfaceKey ? selectToolEntry(s, surfaceKey) : undefined));
	const partial = useFrameSelector(tools, s => (surfaceKey ? s.partialResults.get(surfaceKey) : undefined));
	const reasoning = useFrameSelector(messages, s => (selected === "thinking" ? s.streamingThinking.slice(-600) : ""));
	const scrollRef = useRef<HTMLDivElement>(null);
	// The fading-out frame repeats the previous surface: following must stay on the incoming one,
	// and the outgoing frame's unmount must not clear a ref the incoming frame still holds.
	const attachScroll = useCallback((element: HTMLDivElement | null) => {
		if (!element || element.closest("[data-outgoing]")) return;
		scrollRef.current = element;
		return () => {
			if (scrollRef.current === element) scrollRef.current = null;
		};
	}, []);
	const stripRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);
	/** The shown surface marks a focus; programmatic scrolls toward it must not read as the reader's. */
	const focusFollowRef = useRef(false);
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
	const overlapping = concurrent.length > 1;
	const [picksOpen, setPicksOpen] = useState(overlapping);
	useEffect(() => {
		if (overlapping === picksOpen) return;
		const timer = setTimeout(() => setPicksOpen(overlapping), overlapping ? PICKS_APPEAR_MS : PICKS_LINGER_MS);
		return () => clearTimeout(timer);
	}, [overlapping, picksOpen]);
	const lastPicks = useRef<WorkStripStep[]>([]);
	if (overlapping) lastPicks.current = concurrent;
	// Brief gaps between overlapping calls keep the same row: it neither blinks nor reflows the stage.
	const picks = picksOpen && turnIsLive ? (overlapping ? concurrent : lastPicks.current) : [];
	const pinnedLive = validReplay !== null && concurrent.some(step => step.ids.includes(validReplay));
	const live = (following || pinnedLive) && turnIsLive;
	useLayoutEffect(() => {
		if (!pinnedFromParallel.current || pinnedLive) return;
		pinnedFromParallel.current = false;
		setReplay(null);
	}, [pinnedLive]);
	const startTime = selectedStep?.startedAt ?? entry?.startTime ?? 0;
	const running = live && (entry?.status === "running" || entry?.status === "pending");
	const now = useNowTick(turnIsLive && visible);
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
			.map(
				node =>
					`${node.id}:${node.status}:${node.lastUpdate}:${node.progress?.currentTool}:${agentHasOutput(node, s)}`,
			)
			.join("|"),
	);
	const canAutoFollow =
		!nested && turnIsLive && following && expandedAgent === null && (kind === "task" || kind === "wait");
	const chooseAgent = useCallback(
		(previous: string | null) => {
			let latest: { id: string; lastUpdate: number } | null = null;
			let active: { id: string; lastUpdate: number } | null = null;
			const store = subagents.getState();
			for (const node of store.subagents.values()) {
				if (
					!node.parentToolCallId ||
					!toolCallIds.includes(tools.getState().entryKeyForCallId(node.parentToolCallId))
				)
					continue;
				// A lane with nothing to show yet would fill the stage with an empty placeholder.
				if (!agentHasOutput(node, store)) continue;
				if (!latest || node.lastUpdate > latest.lastUpdate) latest = node;
				if (
					(node.status === "running" || node.status === "pending") &&
					(!active || node.lastUpdate > active.lastUpdate)
				)
					active = node;
			}
			// A rehydrated live wait may have only finished workers: restore its last real output,
			// not an empty stage. A running worker always takes precedence.
			return active?.id ?? (previous && store.subagents.has(previous) ? previous : latest?.id) ?? null;
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
		const delay = autoAgent ? Math.max(0, AGENT_SWITCH_MS - (Date.now() - lastFollow.current)) : 0;
		if (!delay) {
			follow();
			return;
		}
		const timer = setTimeout(follow, delay);
		return () => clearTimeout(timer);
	}, [activityKey, canAutoFollow, autoAgent, chooseAgent]);
	// While agents still run, a quick main step does not pull the stage off an agent that has
	// only just appeared: the agent dwells first, and a step that ends sooner never shows there.
	const autoShownRef = useRef<{ id: string | null; at: number }>({ id: null, at: 0 });
	const canHold = !nested && turnIsLive && following && expandedAgent === null && waitingFor !== "";
	const holdLeft =
		!canAutoFollow && canHold && autoShownRef.current.id
			? AGENT_DWELL_MS - (Date.now() - autoShownRef.current.at)
			: 0;
	const autoShown = canAutoFollow ? autoAgent : holdLeft > 0 ? autoShownRef.current.id : null;
	if (autoShown !== autoShownRef.current.id) autoShownRef.current = { id: autoShown, at: Date.now() };
	const [, releaseHold] = useReducer((count: number) => count + 1, 0);
	useEffect(() => {
		if (holdLeft <= 0) return;
		const timer = setTimeout(releaseHold, holdLeft);
		return () => clearTimeout(timer);
	}, [holdLeft]);
	const shownAgent = expandedAgent ?? autoShown;
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
		// A surface that marks its change (an edit's newest hunk, a write's tail, a read's range) is
		// followed to that mark until the reader scrolls the stage themselves.
		const focus = liveFocusTarget(element);
		focusFollowRef.current = focus !== null;
		if (focus) {
			if (stickRef.current) revealLiveFocus(element, focus, reducedMotion ? "instant" : "smooth");
			return;
		}
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
			// Between steps nothing is pressed: the newest step stays in view.
			const current =
				strip.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ??
				(validReplay === null ? strip.lastElementChild : null);
			if (!current) return;
			const viewport = strip.getBoundingClientRect();
			const chip = current.getBoundingClientRect();
			if (chip.right > viewport.right) strip.scrollLeft += chip.right - viewport.right;
			else if (chip.left < viewport.left) strip.scrollLeft -= viewport.left - chip.left;
		};
		if (typeof ResizeObserver === "undefined") {
			revealCurrent();
			return;
		}
		// A new observer reports the strip once, after this frame's layout and before
		// its paint: revealing then reads geometry the frame lays out anyway.
		const observer = new ResizeObserver(revealCurrent);
		observer.observe(strip);
		return () => observer.disconnect();
	}, [selected, stripKey, laneStripSlot]);
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
			: entry && surfaceKey !== "thinking"
				? workNarrative(entry.toolName, settledArgs(entry), t, undefined, entry.intent)
				: t("chat.thinking.live");
	const waitingNames = waitingFor ? waitingFor.split(", ") : [];
	const liveSub =
		!following && !pinnedLive
			? ""
			: // The run is blocked on the person, not working: say so where the progress line stands.
				kind === "ask" && running
				? t("chat.work.waitingForAnswer")
				: waitingFor && (kind === "wait" || kind === "task" || selected === "thinking")
					? // A narrative that already names every agent ("Running Scout, Review", a wait's own
						// "Waiting for Sleeper") gets their count below it, not the same names again.
						waitingNames.every(name => narrative.includes(name))
						? t("chat.process.statusAgents", {
								count: waitingNames.length,
								plural: waitingNames.length === 1 ? "" : "s",
							})
						: t("chat.work.waitingFor", { names: waitingFor })
					: selected === "thinking" && turnIsLive
						? lastReasoningSentence(reasoning) || (thinkingBetween ? t("chat.thinking.live") : "")
						: picks.length > 1 && overlapping
							? t("chat.work.parallel", { count: concurrent.length })
							: calmWait && live
								? t("chat.work.waiting")
								: "";
	// The line is reserved all run long: with nothing live to say it names the shown step's own target
	// or latest output rather than sitting as an empty gap.
	const sub =
		liveSub ||
		(turnIsLive && !nested && entry && surfaceKey !== "thinking" ? stepDetail(header, narrative, partial) : "");
	const headState: WorkState = state === "interrupted" ? "stopped" : state;
	// The step's own clock, or the no-output warning for a silent command that has not exited yet.
	const exited = typeof resultDetails(partial)?.exitCode === "number";
	const stalled = running && !exited && (kind === "bash" || kind === "eval") && silentSeconds > 10;
	const stepClock = running
		? stalled
			? t("chat.work.stalled", { seconds: silentSeconds })
			: formatElapsed(now - startTime)
		: "";
	// The head counts the whole run, never restarting per step.
	const runStart =
		runStartedAt ?? steps.reduce((first, step) => Math.min(first, step.startedAt), Number.POSITIVE_INFINITY);
	const runClock = !nested && turnIsLive && Number.isFinite(runStart) ? formatElapsed(now - runStart) : "";
	// Reserved from the first live frame so the head never changes height while the run goes on;
	// once the run ends it folds away together with the stage.
	const wasLive = useRef(false);
	if (turnIsLive) wasLive.current = true;
	const reserveSub = !nested && wasLive.current;
	// A calm wait's own clock: ticking while live, the exact span once it ended.
	const waited = !calmWait
		? ""
		: live
			? formatElapsed(now - startTime)
			: formatDuration(Math.max(0, (entry?.endTime ?? now) - startTime));
	// Once real output opens the stage, thinking never collapses it between steps.
	const openedStage = useRef(false);
	if (showSurface || shownAgent !== null) openedStage.current = true;
	const stageOpen = !nested && (shownAgent !== null || (!outcomeMode && openedStage.current));
	const [stagePresent, setStagePresent] = useState(stageOpen);
	const retainedSurface = useRef<ReactNode>(null);
	const retainedFrame = useRef<{ identity: string; agent: string | null; tool: string | null } | null>(null);
	const [laneSlot, setLaneSlot] = useState<HTMLElement | null>(null);
	useLayoutEffect(() => {
		if (stageOpen) setStagePresent(true);
		else if (!motion) setStagePresent(false);
		// Only a present stage has a fade to wait out. Reading the motion token
		// (getComputedStyle) forced a style and layout pass for every finished card
		// a scroll mounted, whose stage never opened.
		else if (stagePresent) {
			const timer = setTimeout(() => setStagePresent(false), workMotionDuration(boxRef.current));
			return () => clearTimeout(timer);
		}
	}, [stageOpen, motion, stagePresent]);
	const settled =
		thinkingBetween ||
		(!nested && following && turnIsLive && !!entry && !running && !shownAgent) ||
		(!shownAgent && !showSurface) ||
		(canAutoFollow && !!shownAgent && !waitingFor);
	return (
		<div
			// Entrance motion (chips popping in, lanes fading in, the outcome unfolding) is for
			// work that arrives while the reader watches. A card that mounts finished, as
			// history does on every scroll, appears as it is: its animations restyled and
			// re-laid out the transcript every frame while a scroll mounted cards.
			className={cx("omp-live-step", motion && wasLive.current && "omp-work-motion")}
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
										? "tools.status.interrupted"
										: "subagent.status.completed",
						)}
						motion={motion}
					/>
					<div className="omp-work-head-text">
						{/* Keyed by what is shown, never by state or output: one fade per step. */}
						<WorkCrossfade identity={outcomeMode ? "outcome" : surfaceKey} motion={motion}>
							<div className="omp-work-narrative" title={narrative}>
								{narrative}
							</div>
						</WorkCrossfade>
						{reserveSub ? (
							<div className="omp-work-sub-shell" data-open={turnIsLive}>
								<div className="omp-work-sub" title={sub || undefined} aria-hidden={!sub || undefined}>
									{sub || "\u00a0"}
								</div>
							</div>
						) : null}
					</div>
					{summaryRow || runClock ? (
						<div className="omp-work-head-side">
							{runClock ? <span className="omp-work-head-clock">{runClock}</span> : null}
							{summaryRow}
						</div>
					) : null}
				</div>
			) : null}
			{/* A silent command's stall, and how a run the reader watched ended: the head's mark and
			    narrative state it visually, and neither is a live region. */}
			<span className="sr-only" role="status">
				{stalled
					? t("chat.work.stalled", { seconds: 10 })
					: !nested && wasLive.current && !turnIsLive
						? narrative
						: ""}
			</span>
			{!nested ? <WorkContext live={carriesContext} snapshot={todoSnapshots?.at(-1)} /> : null}
			{!nested && notes?.length ? <WorkNotes messages={notes} live={turnIsLive} /> : null}
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
					<div className="omp-work-stage-clip">
						<div
							className="omp-work-stage"
							role="region"
							aria-label={t("chat.work.surface")}
							data-settled={settled || undefined}
						>
							<LaneStripSlot.Provider
								value={shownAgent ? (expandedAgent !== null ? laneSlot : null) : undefined}
							>
								{stageOpen ? renderStage() : retainedSurface.current}
							</LaneStripSlot.Provider>
						</div>
					</div>
				</div>
			) : null}
			{nested ? (
				<>
					{renderPicks()}
					<WorkCrossfade identity={surfaceKey} motion={motion}>
						{renderSurface()}
					</WorkCrossfade>
				</>
			) : null}
			{outcomeMode ? (
				<div className="omp-work-outcome-shell">
					<div className="omp-work-outcome-content">
						<WorkOutcome toolCallIds={toolCallIds} stoppedAt={stoppedAt} />
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
				{shownAgent ? null : renderPicks()}
				{surface}
			</>
		);
		retainedSurface.current = stage;
		return stage;
	}
	function renderPicks() {
		return picks.length > 1 ? (
			<ul className="omp-work-parallel" aria-label={t("chat.work.parallel", { count: picks.length })}>
				{picks.map(step => {
					const item = selectToolEntry(tools.getState(), step.id);
					if (!item) return null;
					const meta = getToolHeader(item.toolName, item.args);
					const StepIcon = meta.icon;
					const current = step.ids.includes(surfaceKey);
					const active = item.status === "running" || item.status === "pending";
					const failed = item.status === "error" || (item.isError && item.status !== "aborted");
					const label = workNarrative(item.toolName, settledArgs(item), t, undefined, item.intent);
					return (
						<li key={step.ids[0]}>
							<button
								type="button"
								className="omp-work-parallel-row"
								aria-current={current || undefined}
								title={label}
								onClick={() => {
									pinnedFromParallel.current = !(current && following);
									setReplay(current && following ? null : step.id);
									setExpandedAgent(null);
								}}
							>
								<WorkStatus
									state={active ? "running" : failed ? "failed" : "complete"}
									label={t(
										active
											? "subagent.status.started"
											: failed
												? "subagent.status.failed"
												: "subagent.status.completed",
									)}
									motion={motion}
								/>
								<StepIcon aria-hidden className="omp-live-step-icon" />
								<span className="omp-work-parallel-label">{label}</span>
								<span className="omp-work-card-progress">
									{active ? formatElapsed(now - step.startedAt) : ""}
								</span>
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
					) : stepClock && id === surfaceKey ? (
						// The head counts the run; the step line keeps this step's clock and no-output warning.
						<span className="omp-live-work-mode omp-work-clock" data-stalled={stalled}>
							{stepClock}
						</span>
					) : null}
				</div>
				<div
					className="omp-live-step-scroll"
					ref={attachScroll}
					// Scrollable by keyboard; the stage around it is the card's one landmark.
					tabIndex={0}
					role="group"
					aria-label={t("chat.work.surface")}
					data-settled={thinkingBetween || undefined}
					onScroll={event => {
						if (focusFollowRef.current) return;
						const element = event.currentTarget;
						stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
					}}
					// A focus follow ends with the reader's own scroll gesture; the next step resumes it.
					onWheel={event => {
						if (focusFollowRef.current && event.deltaY !== 0) stickRef.current = false;
					}}
					onTouchMove={() => {
						if (focusFollowRef.current) stickRef.current = false;
					}}
					onKeyDown={event => {
						if (focusFollowRef.current && STAGE_SCROLL_KEYS[event.key]) stickRef.current = false;
					}}
					onPointerDown={event => {
						// Only a press on a scroller's scrollbar (past its client box) is a scroll gesture.
						const node = event.target;
						if (
							focusFollowRef.current &&
							node instanceof HTMLElement &&
							node.scrollHeight > node.clientHeight &&
							event.nativeEvent.offsetX > node.clientWidth
						)
							stickRef.current = false;
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
	/** Roving focus: the strip is one tab stop, arrows and Home/End move between its steps. */
	function moveChipFocus(event: KeyboardEvent<HTMLDivElement>) {
		const chips = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-step-id]")];
		const index = chips.indexOf(event.target as HTMLElement);
		if (index < 0) return;
		const next =
			event.key === "ArrowRight" || event.key === "ArrowDown"
				? index + 1
				: event.key === "ArrowLeft" || event.key === "ArrowUp"
					? index - 1
					: event.key === "Home"
						? 0
						: event.key === "End"
							? chips.length - 1
							: null;
		if (next === null) return;
		event.preventDefault();
		const target = chips[Math.max(0, Math.min(chips.length - 1, next))];
		if (!target) return;
		setFocusStep(target.dataset.stepId ?? null);
		target.focus();
	}
	function renderStrip() {
		// A lane the reader opened lends the strip row to that agent's steps.
		if (!nested && expandedAgent !== null) {
			return (
				<div
					className="omp-live-work-strip"
					role="group"
					aria-label={`${shownAgent} · ${t("chat.work.steps")}`}
					data-lane
				>
					<span className="omp-live-work-strip-label">{shownAgent}</span>
					<div className="omp-live-work-strip-lane" ref={setLaneSlot} />
					{renderCatchUp()}
					{expandedAgent === null ? null : (
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
							{t(turnIsLive ? "chat.work.backToCurrent" : "chat.work.backToOutcome")}
						</button>
					)}
				</div>
			);
		}
		if (nested && laneStripSlot !== undefined) {
			// A fading-out lane is a picture of the past: only the incoming lane fills the row.
			return outgoingFrame || !laneStripSlot || steps.length === 0
				? null
				: createPortal(renderStripContent(), laneStripSlot);
		}
		return steps.length === 0 || stepsListed || (nested && following && steps.length <= 1) ? null : (
			<div className="omp-live-work-strip" role="group" aria-label={t("chat.work.steps")}>
				{renderStripContent()}
			</div>
		);
	}
	function renderStripContent() {
		const currentStep = steps.find(step => step.ids.includes(selected))?.id;
		const tabStop = steps.some(step => step.id === focusStep) ? focusStep : (currentStep ?? steps.at(-1)?.id);
		return (
			<>
				<div
					className="omp-live-work-chips"
					ref={stripRef}
					onKeyDown={moveChipFocus}
					onBlur={event => {
						if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusStep(null);
					}}
				>
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
								tabIndex={step.id === tabStop ? 0 : -1}
								data-step-id={step.id}
								onClick={() => {
									pinnedFromParallel.current = false;
									setFocusStep(null);
									setReplay(step.id);
									setExpandedAgent(null);
								}}
							>
								<StepIcon aria-hidden className="omp-live-step-icon" />
							</button>
						);
					})}
				</div>
				{renderCatchUp()}
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
			</>
		);
	}
	function renderCatchUp() {
		// Steps that advanced while the reader was away matter only while the run goes on:
		// a finished card states its outcome instead.
		return catchUp > 0 && turnIsLive ? (
			<button
				type="button"
				className="omp-live-work-chip omp-work-catch-up"
				onClick={() => {
					setCatchUpReplay(steps.slice(-catchUp).map(step => step.id));
					setCatchUp(0);
					setExpandedAgent(null);
				}}
			>
				{t("chat.work.catchUp", { count: catchUp, plural: catchUp === 1 ? "" : "s" })}
			</button>
		) : null;
	}
}
