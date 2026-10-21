import type { StoreApi } from "zustand";
import type { AutopilotStatus } from "../../../resources/gui-bridge/modes/autopilot-contracts";
import type { CheckoutPeers } from "../../../resources/gui-bridge/modes/checkout-peers-contracts";
import type { NextPromptState } from "../../../resources/gui-bridge/modes/next-prompt-contracts";
import type {
	AgentMessage,
	MessagesPage,
	ModelInfo,
	RpcGoalState,
	RpcResponse,
	RpcSessionState,
} from "../../shared/rpc-types";
import { workTurnStartedAt } from "../components/chat/work/work-turn";
import { MODEL_WRITE_DELAY_MS, seedModelStore, writeModelSnapshot } from "../lib/model-snapshot";
import {
	reuseSeededRows,
	seedTranscript,
	TRANSCRIPT_WRITE_DELAY_MS,
	transcriptKey,
	writeTranscriptSnapshot,
} from "../lib/transcript-snapshot";
import { useAutopilotStore } from "../stores/autopilot";
import { type MessagesStore, mergeFetchedTranscript, useMessagesStore } from "../stores/messages";
import {
	type ModelSelection,
	type ModelStore,
	sameModelSelection,
	snapshotModelSelection,
	useModelStore,
} from "../stores/model";
import type { PendingPlanProposal, PlanApprovalStore } from "../stores/plan-approval";
import { type QueueStore, useQueueStore } from "../stores/queue";
import { type SessionStore, snapshotModeState, useSessionStore } from "../stores/session";
import {
	activeTabCommand,
	focusedSessionRuntime,
	type SessionRuntime,
	sessionRuntime,
	sessionRuntimeStore,
	type TabCommand,
	withSessionRuntime,
} from "../stores/session-runtime-context";
import { type SettingsStore, useSettingsStore } from "../stores/settings";
import { useSubagentGraphStore } from "../stores/subagent-graph";
import { type SubagentsStore, useSubagentsStore } from "../stores/subagents";
import { ensureTabRuntime } from "../stores/tab-runtime";
import { isTabClosed, type SessionTab, useTabsStore } from "../stores/tabs";
import { useTodoStore } from "../stores/todo";
import { type ToolsStore, useToolsStore } from "../stores/tools";

/**
 * Tabs with an auto-retry outstanding. `AgentSession` defers/coalesces the
 * wire-level `agent_end` while a prompt is in flight, so a whole retry saga
 * usually settles with ONE `agent_end` — but any that do arrive mid-saga are
 * intermediate attempts, not the final outcome (mirrors the TUI's gate in
 * event-controller.ts). Set by auto_retry_start, cleared by auto_retry_end and
 * by any proof the tab is idle (TAB_STATUS, an idle get_state on hydrate),
 * since a background tab never sees the end event.
 */
export const retryPendingTabs = new Set<string>();

/**
 * Clear the auto-retry gate. Gates are per-tab: with no explicit target, clear
 * the FOCUSED tab's gate (the tab abortActiveTurn just acted on) — never every
 * tab's, or an Escape in one pane would re-enable error toasts/notifications
 * for a retry saga still running in the other pane.
 */
export function resetRetryPending(tabId?: string): void {
	retryPendingTabs.delete(tabId ?? useTabsStore.getState().activeTabId ?? "");
}

/** Apply the usage half of a snapshot; caller must already be runtime-scoped. */
function writeUsage(state: RpcSessionState): void {
	// A snapshot without usage proves nothing — the ring renders from this field,
	// so overwriting a good reading with null would make it vanish.
	if (!state.contextUsage) return;
	useSessionStore.setState(session => ({
		contextUsage: state.contextUsage ?? null,
		statsPulse: session.statsPulse + 1,
	}));
}

/**
 * Apply what a snapshot reports that no session event carries (usage and the
 * composer modes), for a snapshot that events outdated while it was in flight.
 * Dropping these with the rest left them stale with nothing to re-sync them:
 * any frame landing mid-hydration kept plan mode off until the next turn.
 * The model selection lands too unless something wrote it meanwhile
 * (`thinking_level_changed`, a config frame, a pick): dropped, a relaunch
 * into a busy session showed "Choose model" and thinking off for good.
 * Caller must already be runtime-scoped.
 */
function writeEventlessState(state: RpcSessionState, selectionUntouched: boolean): void {
	writeUsage(state);
	useSessionStore.setState(snapshotModeState(state));
	if (selectionUntouched) useModelStore.setState(snapshotModelSelection(state));
}

/**
 * Land the context-usage reading from a `get_state` snapshot.
 *
 * No session event carries usage, so unlike the rest of a snapshot it is not
 * invalidated by events that arrived while the round trip was in flight.
 */
export function applyUsageSnapshot(state: RpcSessionState, tabId: string): void {
	withSessionRuntime(tabId, () => writeUsage(state));
}

/** Apply a get_state snapshot to every state-derived store. */
export function applySessionState(state: RpcSessionState, fallbackName?: string, turnStartedAt?: number): void {
	const runtime = focusedSessionRuntime();
	if (runtime) runtime.recovering = false;
	if (useSessionStore.getState().sessionId !== state.sessionId) useSubagentGraphStore.getState().reset();
	useModelStore.getState().setFromState(state);
	useSessionStore.getState().setFromState(state);
	writeUsage(state);
	if (!state.sessionName && fallbackName) {
		useSessionStore.setState({ sessionName: fallbackName });
	}
	useSettingsStore.getState().setFromState(state);
	// Turn first: a mid-run attach missed agent_start, and setPhases reads it.
	const todo = useTodoStore.getState();
	todo.setTurnActive(state.isStreaming, todo.turnSourceKnown ? undefined : turnStartedAt);
	useTodoStore.getState().setPhases(state.todoPhases);
}

/**
 * Light re-sync of session state (no transcript/subagent fetch). Used for
 * agent_start: server-side plan-mode exits (plan_approval accept) emit no
 * event, so turn start is the sync point that keeps planModeEnabled honest.
 * Model switches go through refreshModelState instead.
 */
export async function refreshSessionState(tabId = useTabsStore.getState().activeTabId): Promise<void> {
	if (!tabId) return;
	// Closed tabs keep their tombstone: never resurrect a runtime for them.
	// Live tabs may legitimately lack one yet (boot race) — create on demand.
	const runtime = isTabClosed(tabId) ? sessionRuntime(tabId) : ensureTabRuntime(tabId);
	if (!runtime) return;
	const sessionId = sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId;
	const eventVersion = sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().eventVersion;
	const selection = sessionRuntimeStore<ModelStore>(tabId, "model")?.getState();
	const restarts = restartGenerations.get(runtime);
	try {
		const res = await runtime.command({ type: "get_state", brief: true });
		if (
			sessionRuntime(tabId) !== runtime ||
			restartGenerations.get(runtime) !== restarts ||
			sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId !== sessionId ||
			!res.success ||
			res.data == null
		)
			return;
		const state = res.data as RpcSessionState;
		// Events that landed during the round trip already updated the stores, so
		// this snapshot is behind on everything they carry. Usage and the composer
		// modes have no event carrier, so they stay the freshest reading either way;
		// the model selection too, unless something wrote it meanwhile.
		const churned = sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().eventVersion !== eventVersion;
		const current = sessionRuntimeStore<ModelStore>(tabId, "model")?.getState();
		withSessionRuntime(tabId, () => {
			if (churned)
				writeEventlessState(
					state,
					selection !== undefined && current !== undefined && sameModelSelection(selection, current),
				);
			else applySessionState(state);
		});
	} catch {
		// Transient — the next heartbeat or hydration retries.
	}
}

/**
 * Another window that shows the tab toggled a composer mode (plan, prewalk, the agents pause,
 * goal, fast/slow). Most have no event of their own, so the host says so with a
 * `config_update {modes: true}` frame (main/sidecar-pool.ts `noteModeChanged`) and this window re-reads them.
 */
export async function refreshSessionModes(tabId: string): Promise<void> {
	const runtime = sessionRuntime(tabId);
	if (!runtime) return;
	const current: HydrationGuard = () => sessionRuntime(tabId) === runtime;
	await Promise.all([refreshSessionState(tabId), refreshModelState(tabId), syncGoal(tabId, runtime.command, current)]);
}

/** Re-sync the model-derived stores after a model switch, ignoring event churn. */
export async function refreshModelState(tabId = useTabsStore.getState().activeTabId): Promise<void> {
	if (!tabId) return;
	const runtime = isTabClosed(tabId) ? sessionRuntime(tabId) : ensureTabRuntime(tabId);
	if (!runtime) return;
	const sessionId = sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId;
	try {
		const res = await runtime.command({ type: "get_state", brief: true });
		if (
			sessionRuntime(tabId) !== runtime ||
			sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId !== sessionId ||
			!res.success ||
			res.data == null
		)
			return;
		const state = res.data as RpcSessionState;
		withSessionRuntime(tabId, () => {
			useModelStore.getState().setFromState(state);
			// Another model means another context window, so the usage ring has to
			// follow the switch even though the token count did not change.
			writeUsage(state);
		});
	} catch {
		// Transient — the next hydration retries.
	}
}

function asModelInfo(value: unknown): ModelInfo | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as ModelInfo;
	return typeof candidate.provider === "string" && typeof candidate.id === "string" ? candidate : undefined;
}

/**
 * Apply an out-of-band authoritative model: the `set_model` response and
 * `config_update` frames both carry the sidecar's live model. This is the only
 * channel for a switch that emits no `model_changed` at all — re-selecting the
 * current provider+id is a no-op server-side, so without it a stale label can
 * never be corrected.
 */
export function applyModelInfo(model: unknown, tabId: string | null): void {
	const info = asModelInfo(model);
	if (!info || !tabId) return;
	withSessionRuntime(tabId, () => useModelStore.setState({ model: info }));
}

type HydrationGuard = () => boolean;

/** Fetch the live goal state (get_goal) into the session store; clears when no goal is active. */
export async function syncGoal(tabId: string, command: TabCommand, isCurrent: HydrationGuard): Promise<void> {
	const before = withSessionRuntime(tabId, () => useSessionStore.getState());
	try {
		const res = await command({ type: "get_goal" });
		if (!isCurrent() || !res.success) return;
		const current = withSessionRuntime(tabId, () => useSessionStore.getState());
		if (
			current.eventVersion !== before.eventVersion ||
			current.goal !== before.goal ||
			current.goalState !== before.goalState
		)
			return;
		// get_goal wire payload is RpcGoalState; `data` crosses the bridge as unknown.
		const data = res.data as RpcGoalState | undefined;
		withSessionRuntime(tabId, () => {
			if (data?.enabled !== true) {
				useSessionStore.setState({ goal: null, goalState: null });
				return;
			}
			useSessionStore.setState({
				goal: typeof data.objective === "string" ? { objective: data.objective } : null,
				goalState: { status: data.status },
			});
		});
	} catch {
		// Transient — the next goal_updated event or hydration retries.
	}
}

/**
 * Fetch the tab's Autopilot run (`get_autopilot`) into its store; a session that is no run answers `{active: false}`.
 * `autopilot_update` frames keep it current afterwards, and one that lands while this read is in flight wins.
 */
export async function syncAutopilot(tabId: string, command: TabCommand, isCurrent: HydrationGuard): Promise<void> {
	const startedAt = withSessionRuntime(tabId, () => useAutopilotStore.getState().version);
	try {
		const res = await command({ type: "get_autopilot" });
		if (!isCurrent() || !res.success) return;
		const status = res.data as AutopilotStatus | undefined;
		if (!status || typeof status.active !== "boolean") return;
		withSessionRuntime(tabId, () => useAutopilotStore.getState().hydrateIfCurrent(startedAt, status));
	} catch {
		// Transient — the next autopilot_update frame or hydration retries.
	}
}

/**
 * Fetch the other sessions sharing the tab's checkout (`get_checkout_peers`); `checkout_peers` frames keep the value
 * current afterwards, and one that lands while this read is in flight wins. An omp without the method leaves it null.
 */
export async function syncCheckoutPeers(tabId: string, command: TabCommand, isCurrent: HydrationGuard): Promise<void> {
	const before = withSessionRuntime(tabId, () => useSessionStore.getState().checkoutPeers);
	try {
		const res = await command({ type: "get_checkout_peers" });
		if (!isCurrent() || !res.success) return;
		const peers = (res.data as { peers?: CheckoutPeers | null } | undefined)?.peers;
		if (peers === undefined) return;
		withSessionRuntime(tabId, () => {
			if (useSessionStore.getState().checkoutPeers !== before) return;
			useSessionStore.setState({ checkoutPeers: peers });
		});
	} catch {
		// unsupported_omp or transient: the next checkout_peers frame carries the value.
	}
}

/** The session-store fields a next-prompt state (get_next_prompt / next_prompt_config) sets. */
export function nextPromptPatch(state: NextPromptState): Pick<SessionStore, "nextPrompt" | "nextPromptUnavailable"> {
	return {
		nextPrompt: state,
		nextPromptUnavailable: state.unavailable ? { reason: state.unavailable, detail: state.detail } : null,
	};
}

/** Fetch the built-in prompt suggestions' state (get_next_prompt) into the session store; an omp without
 * the feature answers unsupported_omp and the field stays null (legacy widget path). next_prompt_config follows. */
export async function syncNextPrompt(tabId: string, command: TabCommand, isCurrent: HydrationGuard): Promise<void> {
	const before = withSessionRuntime(tabId, () => useSessionStore.getState().nextPrompt);
	try {
		const res = await command({ type: "get_next_prompt" });
		if (!isCurrent() || !res.success || !res.data) return;
		// A next_prompt_config frame that landed meanwhile is fresher than this reply.
		if (withSessionRuntime(tabId, () => useSessionStore.getState().nextPrompt) !== before) return;
		// get_next_prompt wire payload is NextPromptState; `data` crosses the bridge as unknown.
		withSessionRuntime(tabId, () => {
			useSessionStore.setState(nextPromptPatch(res.data as NextPromptState));
		});
	} catch {
		// unsupported_omp or transient — next_prompt_config or the next hydration retries.
	}
}

function isPlanProposal(value: unknown): value is PendingPlanProposal {
	return (
		typeof value === "object" &&
		value !== null &&
		"planFilePath" in value &&
		typeof value.planFilePath === "string" &&
		"planContent" in value &&
		typeof value.planContent === "string" &&
		"options" in value &&
		Array.isArray(value.options) &&
		value.options.every(option => typeof option === "string")
	);
}

/**
 * Re-show the plan proposal the bridge holds awaiting approval
 * (get_plan_mode → `proposal`). Main routes every `plan_proposal` frame to its
 * tab, shown or hidden, but a frame emitted before this renderer subscribed
 * (a reload, a restored window) is gone while the agent still waits on it.
 * A proposal already on screen is left alone, keeping its feedback and
 * submit state.
 */
export async function syncPlanProposal(tabId: string, command: TabCommand, isCurrent: HydrationGuard): Promise<void> {
	try {
		const res = await command({ type: "get_plan_mode" });
		if (!isCurrent() || !res.success) return;
		const proposal = (res.data as { proposal?: unknown } | undefined)?.proposal;
		const plan = sessionRuntimeStore<PlanApprovalStore>(tabId, "planApproval");
		if (!plan || !isPlanProposal(proposal)) return;
		const shown = plan.getState().pending;
		if (shown?.planFilePath === proposal.planFilePath && shown.planContent === proposal.planContent) return;
		plan.getState().showProposal(proposal);
	} catch {
		// Transient — the next hydration retries.
	}
}

// 200 messages bounds the initial IPC/renderer work while retaining several
// recent turns. The bridge extends a page to the start of its first turn.
export const TRANSCRIPT_TAIL_LIMIT = 200;

async function fetchTranscriptTail(command: TabCommand): Promise<RpcResponse> {
	const request = { type: "get_transcript_page" as const, fromEnd: true, limit: TRANSCRIPT_TAIL_LIMIT };
	const response = await command(request);
	// A live commit between the metadata and tail reads invalidates that
	// snapshot, not the session. Re-read its newest page, never the full history.
	return !response.success && response.code === "stale_cursor" ? command(request) : response;
}

/**
 * Resolves in a task of its own right after the next frame paints. A history page
 * received (IPC, deserializing a few MB) and rendered in one task made the longest
 * task of a history scroll, and the frame that painted it the longest frame.
 */
function afterNextPaint(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	requestAnimationFrame(() => setTimeout(resolve, 0));
	return promise;
}

function retainLoadedHistory(fetched: AgentMessage[], current: AgentMessage[]): AgentMessage[] {
	const firstId = fetched[0]?.entryId;
	const overlap = firstId ? current.findIndex(message => message.entryId === firstId) : -1;
	return overlap > 0 ? [...current.slice(0, overlap), ...fetched] : fetched;
}

/**
 * Load the history page before the loaded transcript. The page is received, then
 * `prepare`'s jobs run one task each after that frame paints (work the commit
 * would otherwise do itself), then the page is committed in a task of its own
 * after the next paint, `beforePrepend` first.
 */
export async function loadOlderTranscript(
	tabId?: string,
	beforePrepend?: () => void,
	prepare?: (page: MessagesPage) => (() => void)[],
): Promise<boolean> {
	const runtime = tabId ? sessionRuntime(tabId) : focusedSessionRuntime();
	const store = tabId ? sessionRuntimeStore<MessagesStore>(tabId, "messages") : useMessagesStore;
	if (!store?.getState().prevCursor || store.getState().isLoadingPage) return false;
	const command = runtime?.command ?? activeTabCommand;
	const cursor = store.getState().prevCursor;
	const before = store.getState().messages;
	const tools = tabId ? sessionRuntimeStore<ToolsStore>(tabId, "tools") : useToolsStore;
	const beforeTools = tools?.getState().revision;
	store.setState({ isLoadingPage: true, pageError: null });
	try {
		let response = await command({ type: "get_transcript_page", cursor, limit: TRANSCRIPT_TAIL_LIMIT });
		// A live commit invalidates the snapshot-bound cursor. Refresh its tail,
		// then walk back to the old leading entry rather than lose loaded history.
		if (!response.success && response.code === "stale_cursor") {
			response = await command({ type: "get_transcript_page", fromEnd: true, limit: TRANSCRIPT_TAIL_LIMIT });
			const target = before[0]?.entryId;
			while (response.success) {
				const page = response.data as MessagesPage;
				if (!page.prevCursor || page.messages.some(message => message.entryId === target)) break;
				response = await command({
					type: "get_transcript_page",
					cursor: page.prevCursor,
					limit: TRANSCRIPT_TAIL_LIMIT,
				});
			}
			// The page holding the old leading entry may also hold older rows in front of
			// it: prepend that page itself (prependPage drops the rows already loaded).
			// Only when the entry opens its page is the page before it the next one.
			const found = response.success ? (response.data as MessagesPage) : undefined;
			const opensPage = found?.messages[0]?.entryId === target;
			if (found?.prevCursor && opensPage) {
				response = await command({
					type: "get_transcript_page",
					cursor: found.prevCursor,
					limit: TRANSCRIPT_TAIL_LIMIT,
				});
			}
		}
		if (!response.success) throw new Error(response.error ?? "Transcript page could not be loaded");
		const jobs = prepare?.(response.data as MessagesPage) ?? [];
		if (jobs.length > 0) await afterNextPaint();
		for (const job of jobs) {
			job();
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		}
		await afterNextPaint();
		if ((tabId && sessionRuntime(tabId) !== runtime) || store.getState().messages[0] !== before[0]) return false;
		beforePrepend?.();
		const loaded = store.getState().messages;
		store.getState().prependPage(response.data as MessagesPage);
		const messages = store.getState().messages;
		const session = tabId ? sessionRuntimeStore<SessionStore>(tabId, "session") : useSessionStore;
		tools?.getState().prependMessages(messages.slice(0, messages.length - loaded.length), loaded, {
			turnIsLive: session?.getState().isStreaming === true,
			keepChangedSince: beforeTools,
		});
		return true;
	} catch (error) {
		store.setState({ pageError: error instanceof Error ? error.message : String(error) });
		return false;
	} finally {
		store.setState({ isLoadingPage: false });
	}
}

const hydrationVersions = new WeakMap<SessionRuntime, number>();
/** Bumped by `supersedeTabHydration`: a read answered by the process before it may not land. */
const restartGenerations = new WeakMap<SessionRuntime, number>();
let legacyHydrationVersion = 0;

/** The stores one hydration writes: a tab runtime's own, or the focus-following hooks on the legacy path. */
interface HydrationStores {
	messages: StoreApi<MessagesStore> | null;
	session: StoreApi<SessionStore> | null;
	tools: StoreApi<ToolsStore> | null;
	model: StoreApi<ModelStore> | null;
}

/**
 * Captured before the fetch: committed agent_end rows arriving while the
 * transcript RPC is in flight must survive the merge in `commitHydration`.
 */
interface HydrationBaseline {
	messages: AgentMessage[];
	liveMessages: AgentMessage[];
	eventVersion: number | undefined;
	toolsRevision: number | undefined;
	selection: ModelSelection | undefined;
}

function captureHydrationBaseline({ messages, session, tools, model }: HydrationStores): HydrationBaseline {
	const transcript = messages?.getState();
	return {
		messages: transcript?.messages ?? [],
		liveMessages: transcript?.liveMessages ?? [],
		eventVersion: session?.getState().eventVersion,
		toolsRevision: tools?.getState().revision,
		selection: model?.getState(),
	};
}

interface HydrationCommit {
	stores: HydrationStores;
	before: HydrationBaseline;
	stateResult: PromiseSettledResult<RpcResponse>;
	messagesResult: PromiseSettledResult<RpcResponse>;
	/** False when the snapshot was fetched for a pane the user switched away from meanwhile. */
	focusUnchanged: boolean;
	command: TabCommand;
	applyState: (wire: RpcSessionState, turnStartedAt?: number) => void;
	/** Lands the event-free part of a snapshot that events outdated in flight. */
	applyEventlessState: (wire: RpcSessionState, selectionUntouched: boolean) => void;
}

/** Land a `get_state` + transcript-tail pair: the one commit path for tab and legacy hydration. */
function commitHydration({
	stores: { messages, session, tools, model },
	before,
	stateResult,
	messagesResult,
	focusUnchanged,
	command,
	applyState,
	applyEventlessState,
}: HydrationCommit): void {
	const eventsUnchanged = session?.getState().eventVersion === before.eventVersion;
	// `get_state` is the only witness to a live turn. A failed read counts as not
	// live: a card left spinning never resolves, while a wrongly aborted card is
	// repaired by the next execution event.
	const wire =
		stateResult.status === "fulfilled" && stateResult.value.success
			? (stateResult.value.data as RpcSessionState | null)
			: null;
	const stateIsStreaming = wire?.isStreaming === true;
	const stateIsIdle = wire != null && !stateIsStreaming;
	const page =
		messagesResult.status === "fulfilled" && messagesResult.value.success
			? (messagesResult.value.data as MessagesPage | undefined)
			: undefined;
	const turnStartedAt = page ? workTurnStartedAt(page.messages) : undefined;

	if (eventsUnchanged && focusUnchanged && wire != null) {
		applyState(wire, turnStartedAt);
		// Mid-run attach (launch/reconnect/session switch while the agent is
		// streaming) missed the agent_start that arms the status row — re-arm
		// it like the TUI's ensureLoadingAnimation on guest attach, unless a
		// live marker already carries a more accurate start time. When content
		// is actively streaming the row stays hidden behind StreamingRows.
		if (wire.isStreaming && session?.getState().awaitingModelSince === null) {
			session.setState({ awaitingModelSince: Date.now() });
		}
		// Zombie settle: the run finished while this tab sat in the
		// background, so its message_end/agent_end never forwarded and the
		// restored bundle still paints partial assistant content. Clear only
		// those stream buffers here; the transcript merge below separately
		// removes delivered live rows while preserving an unsent local prompt.
		if (!wire.isStreaming) messages?.getState().clearStreaming();
		// Per-tab subagent subscription (F-HYDRATE), re-asserted on every
		// successful hydrate: the command channel routes to THIS tab's
		// sidecar. Tabs that report ready while active also subscribe via the
		// status handlers — this covers tabs that booted or settled in the
		// background, whose frames would otherwise stay silent on return.
		// Idempotent server-side.
		void command({ type: "set_subagent_subscription", level: "progress" });
	} else if (focusUnchanged && wire != null) {
		const selection = model?.getState();
		applyEventlessState(
			wire,
			before.selection !== undefined && selection !== undefined && sameModelSelection(before.selection, selection),
		);
	}

	if (!focusUnchanged) return;
	// The rows a snapshot seeded are a guess, not loaded history: the live page replaces them (rows with the
	// same content keep their objects) whatever happened to the read, so the "updating" hint never outlives it.
	const restored = messages?.getState().restoredAt != null;
	if (messagesResult.status !== "fulfilled" || !messagesResult.value.success) {
		if (restored) messages?.setState({ restoredAt: null });
		// Nothing of the transcript is on screen: the failure is shown with Retry, never an empty session.
		if (messages && messages.getState().messages.length === 0) {
			const failed = messagesResult.status === "fulfilled" ? messagesResult.value : null;
			const reason =
				messagesResult.status === "rejected"
					? messagesResult.reason instanceof Error
						? messagesResult.reason.message
						: String(messagesResult.reason)
					: (failed && !failed.success && failed.error) || "Transcript page could not be loaded";
			messages.setState({ pageError: reason });
		}
		return;
	}
	const fetched = page?.messages ?? [];
	const current = messages?.getState().messages ?? [];
	const merged = mergeFetchedTranscript(fetched, before.messages, current);
	const retained = restored ? reuseSeededRows(merged, before.messages) : retainLoadedHistory(merged, current);
	const prevCursor = !restored && retained.length > merged.length ? messages?.getState().prevCursor : page?.prevCursor;
	messages?.getState().reconcileFetched(retained);
	messages?.setState({ prevCursor, pageError: null, restoredAt: null });
	if (eventsUnchanged && stateIsIdle && messages?.getState().liveMessages === before.liveMessages) {
		messages.getState().clearDeliveredLiveMessages();
	}
	// Always rebuild: a tab that returns mid-run has live events flowing,
	// but cards whose end events it missed in the background would spin
	// forever. Entries live events wrote during the fetch survive it.
	tools?.getState().hydrateMessages(messages?.getState().messages ?? [], {
		turnIsLive: eventsUnchanged ? stateIsStreaming : session?.getState().isStreaming === true,
		keepChangedSince: before.toolsRevision,
	});
}

export async function hydrateLegacySession(fallbackName?: string, initialState?: RpcResponse): Promise<void> {
	const version = ++legacyHydrationVersion;
	const isCurrent = () => version === legacyHydrationVersion;
	// This path has no tab runtime to scope to, so its stores are resolved by
	// focus at apply time. Remember who we fetched for and refuse to write that
	// snapshot into a pane the user switched to while the RPC was in flight.
	const originRuntime = focusedSessionRuntime();
	const stores: HydrationStores = {
		messages: useMessagesStore,
		session: useSessionStore,
		tools: useToolsStore,
		model: useModelStore,
	};
	const before = captureHydrationBaseline(stores);
	const core = Promise.allSettled([
		initialState ? Promise.resolve(initialState) : activeTabCommand({ type: "get_state", brief: true }),
		fetchTranscriptTail(activeTabCommand),
	]);
	const subagents = useSubagentsStore.getState().refresh({ expect: isCurrent });
	const secondary = Promise.allSettled([
		syncGoal("", activeTabCommand, isCurrent),
		syncAutopilot("", activeTabCommand, isCurrent),
		syncCheckoutPeers("", activeTabCommand, isCurrent),
		syncNextPrompt("", activeTabCommand, isCurrent),
		useQueueStore.getState().refresh(),
		useSettingsStore.getState().syncDisplaySettings(),
		useSettingsStore.getState().syncApproval(),
	]);
	const [stateResult, messagesResult] = await core;
	if (!isCurrent()) return;
	commitHydration({
		stores,
		before,
		stateResult,
		messagesResult,
		focusUnchanged: !originRuntime || focusedSessionRuntime() === originRuntime,
		command: activeTabCommand,
		applyState: (wire, startedAt) => applySessionState(wire, fallbackName, startedAt),
		applyEventlessState: writeEventlessState,
	});
	await subagents;
	await secondary;
}

/** Reload every renderer store that belongs to the active sidecar session. */
export async function hydrateSession(fallbackName?: string): Promise<void> {
	const tabId = useTabsStore.getState().activeTabId;
	if (!tabId || !sessionRuntime(tabId)) return hydrateLegacySession(fallbackName);
	return hydrateTabSession(tabId, fallbackName);
}

/** The session a tab hydration was started for; undefined fields are not yet known. */
interface HydrationTarget {
	sessionId?: string;
	sessionPath?: string;
}

const inFlightHydrations = new WeakMap<SessionRuntime, { target: HydrationTarget; promise: Promise<void> }>();

function hydrationTarget(tabId: string): HydrationTarget {
	const tab = useTabsStore.getState().tabs.find(entry => entry.id === tabId);
	return { sessionId: tab?.sessionId, sessionPath: tab?.sessionPath };
}

/**
 * Hydrate a tab whose sidecar just became visible or ready, joining a
 * hydration of the same tab and session that is already in flight. Boot,
 * ⌘T, and tab switches raise several such signals at once (TAB_STATUS ready,
 * the full status channel, the GET_TABS fallback, the post-route check); each
 * would otherwise page the whole transcript again. Callers that just changed
 * the session's content (prompt, fork, tree navigation, compaction) must use
 * `hydrateTabSession`, whose fetch starts after their change.
 */
export function attachTabSession(tabId: string): Promise<void> {
	if (isTabClosed(tabId)) return Promise.resolve();
	const inFlight = inFlightHydrations.get(ensureTabRuntime(tabId));
	const target = hydrationTarget(tabId);
	// Same rule as `applyTabStatus`: a field only proves a session change once both sides know it.
	const sameSession =
		inFlight !== undefined &&
		(inFlight.target.sessionId === undefined ||
			target.sessionId === undefined ||
			inFlight.target.sessionId === target.sessionId) &&
		(inFlight.target.sessionPath === undefined ||
			target.sessionPath === undefined ||
			inFlight.target.sessionPath === target.sessionPath);
	return sameSession ? inFlight.promise : hydrateTabSession(tabId);
}

/**
 * Reload every renderer store belonging to one visible tab. Always starts a
 * fresh fetch, superseding any in-flight one; concurrent `attachTabSession`
 * calls join it.
 */
export function hydrateTabSession(tabId: string, fallbackName?: string): Promise<void> {
	if (isTabClosed(tabId)) return Promise.resolve();
	const runtime = ensureTabRuntime(tabId);
	const entry = { target: hydrationTarget(tabId), promise: loadTabSession(tabId, runtime, fallbackName) };
	inFlightHydrations.set(runtime, entry);
	const release = () => {
		if (inFlightHydrations.get(runtime) === entry) inFlightHydrations.delete(runtime);
	};
	entry.promise.then(release, release);
	return entry.promise;
}

/**
 * The tab's omp process is going away (restart, crash, respawn on a session): every read already in
 * flight — a hydration, the agent_start re-sync, the runtime-less legacy hydration of the active tab —
 * answers from that process, so none may land and no hydration may be joined. Landing, its `get_state`
 * would end the restart's recovery (`applySessionState`) before the new process reports the fresh id of
 * an unsaved session, and the runtime replaced for that id would drop the composer's unsent draft.
 */
export function supersedeTabHydration(tabId: string): void {
	// The legacy path reads whichever tab main routes the window to: the active one.
	const activeTabId = useTabsStore.getState().activeTabId;
	if (activeTabId === null || activeTabId === tabId) legacyHydrationVersion++;
	const runtime = sessionRuntime(tabId);
	if (!runtime) return;
	hydrationVersions.set(runtime, (hydrationVersions.get(runtime) ?? 0) + 1);
	restartGenerations.set(runtime, (restartGenerations.get(runtime) ?? 0) + 1);
	inFlightHydrations.delete(runtime);
}

/** The stores a tab's runtime owns that a hydration (or a snapshot seed) writes. */
function runtimeStores(tabId: string): HydrationStores {
	return {
		messages: sessionRuntimeStore<MessagesStore>(tabId, "messages"),
		session: sessionRuntimeStore<SessionStore>(tabId, "session"),
		tools: sessionRuntimeStore<ToolsStore>(tabId, "tools"),
		model: sessionRuntimeStore<ModelStore>(tabId, "model"),
	};
}

/** What names a tab's transcript in the snapshot cache: its file, a file it is about to open, or its id. */
function snapshotIdentity(tab: SessionTab) {
	return { sessionPath: tab.sessionPath ?? tab.pendingSessionPath, sessionId: tab.sessionId, device: tab.device };
}

/** The tab's last known page paints before the live read answers (a restored or re-opened session, a cold start). */
function seedFromSnapshot(tabId: string, { messages, session, tools, model }: HydrationStores): void {
	const tab = useTabsStore.getState().tabs.find(entry => entry.id === tabId);
	if (!tab) return;
	// The tab knows its folder before its omp reports one: the title bar's project and the sidebar's rows (and the
	// selected one) read it, so without it the first frame showed "Chats" and an empty list, a frame later the project.
	if (session && !session.getState().cwd && tab.cwd) session.setState({ cwd: tab.cwd });
	if (model) seedModelStore(model, tab.device, transcriptKey(snapshotIdentity(tab)));
	if (!messages) return;
	const rows = seedTranscript(messages, snapshotIdentity(tab));
	// The tool cards derive from the rows: rebuilt, none of them waits for a result that is already in the rows.
	if (rows) tools?.getState().hydrateMessages(rows, { turnIsLive: false });
}

/**
 * Seed every tab the store lists as soon as it (or its session file) is known, not when its omp is ready: a tab
 * a relaunch restored, a session opened from the sidebar and a web page's tabs show their last rows at once.
 * Returns the unsubscribe.
 */
export function installTranscriptSeeding(): () => void {
	const done = new Map<string, string>();
	const run = (tabs: readonly SessionTab[]) => {
		for (const tab of tabs) {
			const key = transcriptKey(snapshotIdentity(tab));
			if (!key || done.get(tab.id) === key || isTabClosed(tab.id)) continue;
			done.set(tab.id, key);
			ensureTabRuntime(tab.id);
			seedFromSnapshot(tab.id, runtimeStores(tab.id));
		}
	};
	run(useTabsStore.getState().tabs);
	return useTabsStore.subscribe(state => run(state.tabs));
}

const watchedTranscripts = new WeakSet<SessionRuntime>();

/** Keep the tab's snapshot following its committed rows: one idle write per quiet moment, keyed by what the tab shows then. */
function watchTranscript(tabId: string, runtime: SessionRuntime, { messages, model }: HydrationStores): void {
	if (!messages || watchedTranscripts.has(runtime)) return;
	watchedTranscripts.add(runtime);
	let modelTimer: ReturnType<typeof setTimeout> | undefined;
	model?.subscribe((state, previous) => {
		if (state.availableModels === previous.availableModels && state.model === previous.model) return;
		clearTimeout(modelTimer);
		modelTimer = setTimeout(() => {
			const tab = useTabsStore.getState().tabs.find(entry => entry.id === tabId);
			if (tab && sessionRuntime(tabId) === runtime)
				writeModelSnapshot(tab.device, transcriptKey(snapshotIdentity(tab)), model.getState());
		}, MODEL_WRITE_DELAY_MS);
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	messages.subscribe((state, previous) => {
		if (state.messages === previous.messages || state.messages.length === 0) return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			const tab = useTabsStore.getState().tabs.find(entry => entry.id === tabId);
			if (tab && sessionRuntime(tabId) === runtime)
				writeTranscriptSnapshot(snapshotIdentity(tab), messages.getState().messages);
		}, TRANSCRIPT_WRITE_DELAY_MS);
	});
}

async function loadTabSession(tabId: string, runtime: SessionRuntime, fallbackName?: string): Promise<void> {
	const version = (hydrationVersions.get(runtime) ?? 0) + 1;
	hydrationVersions.set(runtime, version);
	const isCurrent = (): boolean => hydrationVersions.get(runtime) === version && sessionRuntime(tabId) === runtime;
	const stores = runtimeStores(tabId);
	seedFromSnapshot(tabId, stores);
	watchTranscript(tabId, runtime, stores);
	const before = captureHydrationBaseline(stores);

	const coreResult = Promise.allSettled([
		runtime.command({ type: "get_state", brief: true }),
		fetchTranscriptTail(runtime.command),
	]);
	const subagentsResult = sessionRuntimeStore<SubagentsStore>(tabId, "subagents")
		?.getState()
		.refresh({ expect: isCurrent });
	const queue = sessionRuntimeStore<QueueStore>(tabId, "queue")?.getState();
	const settings = sessionRuntimeStore<SettingsStore>(tabId, "settings")?.getState();
	const secondaryResult = Promise.allSettled([
		// Goal state isn't on the get_state wire — fetch alongside so the
		// composer chip reflects an active goal after boot/session switches,
		// not only on goal_updated events.
		syncGoal(tabId, runtime.command, isCurrent),
		syncAutopilot(tabId, runtime.command, isCurrent),
		syncCheckoutPeers(tabId, runtime.command, isCurrent),
		syncNextPrompt(tabId, runtime.command, isCurrent),
		// Queue snapshot: queue_update frames keep it fresh afterwards;
		// get_queue is only the hydrate fallback (boot/reconnect/session
		// switch all land here). refresh() swallows its own failures.
		queue?.refresh(),
		// Project-scoped agent settings can differ between tab workspaces. The
		// settings store is per-tab (each runtime owns one bound to its own
		// command channel), so re-read this tab's sidecar on every hydrate; both
		// methods already reject stale out-of-order replies.
		settings?.syncDisplaySettings(),
		settings?.syncApproval(),
	]);
	const [stateResult, messagesResult] = await coreResult;
	if (!isCurrent()) return;
	commitHydration({
		stores,
		before,
		stateResult,
		messagesResult,
		focusUnchanged: true,
		command: runtime.command,
		applyState: (wire, startedAt) => {
			withSessionRuntime(tabId, () => applySessionState(wire, fallbackName, startedAt));
			// An idle session has no retry outstanding, whatever end event was missed.
			if (!wire.isStreaming) retryPendingTabs.delete(tabId);
		},
		applyEventlessState: (wire, selectionUntouched) =>
			withSessionRuntime(tabId, () => writeEventlessState(wire, selectionUntouched)),
	});

	// Subagents and secondary chips do not hold the transcript hostage. Their
	// requests still begin in parallel, but the core session can paint first.
	// A proposal can only be pending while plan mode is on.
	const wire =
		stateResult.status === "fulfilled" && stateResult.value.success
			? (stateResult.value.data as RpcSessionState | null)
			: null;
	if (wire?.planModeEnabled) await syncPlanProposal(tabId, runtime.command, isCurrent);
	await subagentsResult;
	await secondaryResult;
}
