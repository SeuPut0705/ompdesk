import {
	applyModelInfo,
	applySessionState,
	applyUsageSnapshot,
	attachTabSession,
	hydrateLegacySession,
	hydrateSession,
	hydrateTabSession,
	nextPromptPatch,
	refreshModelState,
	refreshSessionModes,
	refreshSessionState,
	retryPendingTabs,
	syncAutopilot,
	syncCheckoutPeers,
	syncGoal,
	syncPendingMail,
} from "./session-hydration";

export * from "./session-hydration";

import { useEffect } from "react";
import type { IpcSidecarStatusPayload } from "../../shared/ipc-types";
import { notificationSummary } from "../../shared/notification-summary";
import {
	type AgentSessionEvent,
	type CommandOutputFrame,
	type ConfigUpdateFrame,
	type ExtensionErrorFrame,
	isThinkingLevel,
	type ModelCatalogUpdateFrame,
	type PromptResultFrame,
	type RpcSessionState,
	type SessionInfoUpdateFrame,
	type SubagentFrame,
	type TodoPhase,
} from "../../shared/rpc-types";
import { messageSourceTimestamp } from "../components/chat/work/work-turn";
import { compactionActionKey } from "../lib/compaction-action";
import { errorDetail } from "../lib/error-detail";
import { formatClock } from "../lib/format";
import { translate } from "../lib/i18n";
import { describeTurnError, messageText, turnErrorToast } from "../lib/messages";
import { playNotificationSound } from "../lib/notification-sound";
import { handleAutoOpenEvents } from "../lib/panel-auto-open";
import { useUsageSignal } from "../lib/usage-reports";
import { useAutopilotStore } from "../stores/autopilot";
import { useDesktopSlotStore } from "../stores/desktop-slot";
import {
	claimsLoginRequest,
	type ExtensionUiStore,
	isUserBlockingRequest,
	useExtensionUiStore,
} from "../stores/extension-ui";
import { useMessagesStore } from "../stores/messages";
import { useModelStore } from "../stores/model";
import { useNextPromptStore } from "../stores/next-prompt";
import { usePlanApprovalStore } from "../stores/plan-approval";
import { useQueueStore } from "../stores/queue";
import { type SessionStore, useSessionStore } from "../stores/session";
import {
	activeTabCommand,
	focusedSessionRuntime,
	sessionRuntime,
	sessionRuntimeStore,
	type TabCommand,
	withSessionRuntime,
} from "../stores/session-runtime-context";
import { useSettingsStore } from "../stores/settings";
import { useSubagentsStore } from "../stores/subagents";
import { ensureTabRuntime } from "../stores/tab-runtime";
import { isTabClosed, useTabsStore, visibleTabIds } from "../stores/tabs";
import { toastError, useToastStore } from "../stores/toast";
import { useTodoStore } from "../stores/todo";
import { useToolsStore } from "../stores/tools";
import { useUiStore } from "../stores/ui";

/**
 * Routine informational notice sources suppressed from the toast stack — they
 * fire on every model switch (tool mount/unmount reconciliation) and need no
 * user action. Only their info-level notices are dropped; warnings/errors and
 * notices from any other source still surface as toasts.
 */
const QUIET_NOTICE_SOURCES = new Set(["vision", "xdev"]);

/**
 * Frames that change nothing a `get_state` or transcript snapshot reports, so
 * they never outdate one in flight. The bridge sends a `token_rate` the moment
 * it connects, right as the boot hydration fetches: counted as churn, it threw
 * away that whole snapshot (model, plan mode, todos) with nothing to re-sync it
 * until the next turn. `read_group_metadata` likewise: the transcript carries the
 * same metadata for every committed call, and the tools store joins it to a call
 * the transcript does not hold yet across the rebuild.
 */
const SNAPSHOT_NEUTRAL_EVENTS: Partial<Record<AgentSessionEvent["type"], true>> = {
	token_rate: true,
	read_group_metadata: true,
	// Suggestion frames change nothing get_state reports.
	next_prompt_config: true,
	next_prompt_update: true,
	// The Autopilot status is a feed of its own (get_autopilot), not something a get_state snapshot reports.
	autopilot_update: true,
	// The desktop slot is app-wide state main owns, not something a get_state snapshot reports.
	desktop_slot_update: true,
	// Held reports are the bridge's own feed (get_pending_mail), not something a get_state snapshot reports.
	mail_pending: true,
	// The checkout's peers are the bridge's own feed (get_checkout_peers), not something a get_state snapshot reports.
	checkout_peers: true,
};

/** Schema defaults for the agent's notify settings (settings-schema.ts). */
const NOTIFY_DEFAULTS = { completion: "on", error: "off", ask: "on" } as const;

/** A tab with no runtime has no sign-in in flight. */
const NO_SIGN_IN = { loginRequestIds: {}, inlineLogins: 0 } as const;

function isTodoStatus(value: unknown): value is TodoPhase["tasks"][number]["status"] {
	return (
		value === "pending" ||
		value === "in_progress" ||
		value === "completed" ||
		value === "abandoned" ||
		value === "blocked"
	);
}

function isTodoTask(value: unknown): value is TodoPhase["tasks"][number] {
	return (
		typeof value === "object" &&
		value !== null &&
		"content" in value &&
		typeof value.content === "string" &&
		"status" in value &&
		isTodoStatus(value.status) &&
		(!("blocker" in value) || value.blocker === undefined || typeof value.blocker === "string")
	);
}

function isTodoPhase(value: unknown): value is TodoPhase {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		typeof value.name === "string" &&
		"tasks" in value &&
		Array.isArray(value.tasks) &&
		value.tasks.every(isTodoTask)
	);
}

function todoPhasesFromToolResult(result: unknown): TodoPhase[] | undefined {
	if (typeof result !== "object" || result === null || !("details" in result)) return undefined;
	const details = result.details;
	if (typeof details !== "object" || details === null || !("phases" in details)) return undefined;
	return Array.isArray(details.phases) && details.phases.every(isTodoPhase) ? details.phases : undefined;
}
type NotifyKind = keyof typeof NOTIFY_DEFAULTS;

/**
 * Late frames for a tab the user already closed must be dropped: its runtime
 * is gone, and withSessionRuntime would otherwise fall back to the FOCUSED
 * runtime — polluting a live session's transcript, or (a closed tab's
 * in-flight "starting" frame) resetting the focused tab's stores wholesale.
 * An empty tabId (legacy bridge before boot reconciliation) always passes.
 */
function closedTabFrame(tabId: string): boolean {
	return tabId !== "" && isTabClosed(tabId);
}

/**
 * Desktop-notification gate, mirroring the TUI's notify policy: the GUI master
 * pref (Settings → GUI, default on), then the agent's `<kind>.notify` setting
 * (read live via get_settings so edits from either the TUI or the GUI's
 * Interaction tab apply immediately), and finally window focus — never notify
 * while the user is watching.
 */
async function maybeNotify(
	kind: NotifyKind,
	tabId: string,
	title: string,
	body: string,
	command: TabCommand = (rpcCommand, timeoutMs) => window.omp.rpc.command(rpcCommand, timeoutMs),
): Promise<void> {
	try {
		if (document.hasFocus()) return;
		if (!useUiStore.getState().notifications) return;
		const key = `${kind}.notify`;
		const res = await command({ type: "get_settings", paths: [key] });
		const values = res.success ? (res.data as { values?: Record<string, unknown> } | undefined)?.values : undefined;
		const setting = values?.[key];
		const effective = typeof setting === "string" ? setting : NOTIFY_DEFAULTS[kind];
		if (effective === "off") return;
		// The tab rides along so a click on the banner brings that tab forward.
		window.omp.system.notify(title, body, tabId, kind);
		playNotificationSound();
	} catch {
		// Best-effort: a failed notification must never break event dispatch.
	}
}

/** Notification title for one tab: its own title (never the focused tab's), then the app name. */
function notificationTitle(tabId: string): string {
	return (
		useTabsStore.getState().tabs.find(tab => tab.id === tabId)?.title ||
		sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionName ||
		"OMPdesk"
	);
}

/**
 * Main holds the tab's failed turn until the connection is back (turn-resume.ts): not a
 * failure, so nothing announces it as one. Main sets it before the run's end reaches here.
 */
function awaitingConnection(tabId: string): boolean {
	return useTabsStore.getState().tabs.some(tab => tab.id === tabId && tab.awaitingConnection === true);
}

/**
 * Notify a finished run: completion or error, mutually exclusive for one
 * settled run. Aborted runs are user-initiated and stay quiet, as do the
 * intermediate settles of a live auto-retry saga and a turn waiting for the connection.
 */
export function notifyRunEnd(
	tabId: string,
	outcome: { stopReason?: string; errorMessage?: unknown; reply?: string },
): void {
	if (retryPendingTabs.has(tabId) || awaitingConnection(tabId)) return;
	if (outcome.stopReason === "aborted") return;
	// A settle arriving after the tab closed has no runtime to query settings
	// with — skip rather than resurrect a ghost runtime and notify a dead tab.
	const runtime = sessionRuntime(tabId);
	if (!runtime) return;
	const title = notificationTitle(tabId);
	if (outcome.stopReason === "error") {
		const message =
			typeof outcome.errorMessage === "string" && outcome.errorMessage
				? translate("events.notificationErrorDetail", {
						error: outcome.errorMessage.replace(/\s+/g, " ").slice(0, 120),
					})
				: translate("events.notificationError");
		void maybeNotify("error", tabId, title, message, runtime.command);
		return;
	}
	// The banner reads the reply's opening prose; a reply with none says "Complete".
	const summary = outcome.reply ? notificationSummary(outcome.reply) : "";
	void maybeNotify("completion", tabId, title, summary || translate("events.notificationComplete"), runtime.command);
}

/**
 * Notify on a settled turn, reading the outcome from the event's own messages
 * (the mutable stores can already have raced ahead — the TUI reads
 * `agent_end.messages` for the same reason).
 */
function notifyOnAgentEnd(tabId: string, event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
	// `isTerminal === false` marks a deferred mid-run settle, not the final one.
	if (event.isTerminal === false) return;
	const last = event.messages?.findLast(message => message.role === "assistant");
	notifyRunEnd(tabId, {
		stopReason: last?.stopReason,
		errorMessage: last?.errorMessage,
		reply: last ? messageText(last) : undefined,
	});
}

/**
 * Toast a failed turn in-app regardless of the desktop-notification policy
 * (error notifications default off). The chat bubble carries the message, but
 * a failure with no visible output — e.g. the provider rejects the first
 * request right after a model switch — otherwise looks like a silent no-op.
 * Same guards as notifyOnAgentEnd: deferred mid-run settles and live
 * auto-retries stay quiet (the retry row and its final-failure toast cover
 * those), and aborted turns are user-initiated. The copy is the humanized
 * title + guidance shared with the transcript error card, never raw
 * provider English.
 */
function toastOnAgentError(tabId: string, event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
	if (event.isTerminal === false) return;
	if (retryPendingTabs.has(tabId) || awaitingConnection(tabId)) return;
	const last = event.messages?.findLast(message => message.role === "assistant");
	if (last?.stopReason !== "error") return;
	const { kind, title, message } = turnErrorToast(
		typeof last.errorMessage === "string" ? last.errorMessage : undefined,
		last.stopReason,
	);
	if (kind === "aborted") return;
	useToastStore.getState().push({ variant: "error", title, message });
}

/** Goal statuses past which no live goal remains — the composer chip must clear. */
const TERMINAL_GOAL_STATUSES: Record<string, true> = { dropped: true, complete: true };

/** Narrow an untyped goal payload to the fields the session store tracks. */
function goalFields(value: unknown): { objective?: string; status?: string } | null {
	if (!value || typeof value !== "object") return null;
	const objective = "objective" in value && typeof value.objective === "string" ? value.objective : undefined;
	const status = "status" in value && typeof value.status === "string" ? value.status : undefined;
	return { objective, status };
}

/**
 * Normalize a goal_updated frame into a session-store patch. A drop/complete
 * emits the TERMINAL goal object (status "dropped"/"complete") alongside
 * state.enabled=false — storing it verbatim leaves the composer chip stuck
 * ON (`!!goal`), so terminal/disabled frames clear the store instead.
 */
function goalPatchFromEvent(
	goal: unknown,
	state: unknown,
): { goal: { objective?: string } | null; goalState: { status?: string } | null } {
	const goalInfo = goalFields(goal);
	const stateGoal = state && typeof state === "object" && "goal" in state ? goalFields(state.goal) : null;
	const enabled =
		state && typeof state === "object" && "enabled" in state && typeof state.enabled === "boolean"
			? state.enabled
			: undefined;
	const status = stateGoal?.status ?? goalInfo?.status;
	const terminal = status !== undefined && TERMINAL_GOAL_STATUSES[status] === true;
	if (terminal || enabled === false || !goalInfo) return { goal: null, goalState: null };
	return { goal: { objective: goalInfo.objective }, goalState: { status } };
}

/** Failed liveness probes in a row, with no frame between them, before a tab's omp is called unresponsive. */
const WEDGE_PROBES = 2;

/**
 * Subscribes to batched RPC events from the sidecar and dispatches
 * them to the appropriate stores. Call once in App.tsx.
 * Also handles sidecar-ready initialization (get_state, subagent subscription).
 *
 * `heartbeatMs` is the liveness-probe cadence; tests shorten it to observe the
 * idle refresh it also drives.
 */
export function useRpcEvents(heartbeatMs = 15_000): void {
	useEffect(() => {
		const focusedTabId = () => useTabsStore.getState().activeTabId ?? "";
		let disposed = false;
		let statusVersion = 0;
		/** When each tab's omp last sent a frame, and how many liveness probes in a row it has missed since. */
		const lastEventAt = new Map<string, number>();
		const missedProbes = new Map<string, number>();
		const unsubscribe = window.omp.events.onTabBatch(reduceEvents);
		function reduceEvents(events: AgentSessionEvent[], tabId: string): void {
			// Any frame from the tab's omp proves its loop runs: a probe that timed out meanwhile was slow, not wedged, and a
			// banner the probes raised comes down. Any other error (an exit, a failed start) stays.
			lastEventAt.set(tabId, performance.now());
			missedProbes.delete(tabId);
			const live = sessionRuntimeStore<SessionStore>(tabId, "session");
			if (live?.getState().sidecarError === translate("events.sidecarNoResponse"))
				live.getState().clearSidecarError();
			// Incoming session events belong to the target sidecar. Drop them
			// during an in-place session switch, but never suppress the other pane.
			if (sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().switchPending) return;
			if (closedTabFrame(tabId)) return;
			withSessionRuntime(tabId, () => {
				useMessagesStore.getState().applyEvents(events);
				useToolsStore.getState().applyEvents(events);
				handleAutoOpenEvents(tabId, events);

				// eventVersion lets an async snapshot (get_state, hydrate) tell whether
				// events landed after it was taken. One bump per batch covers every
				// snapshot started before it; a snapshot started by an event inside
				// the batch needs one more bump if any event follows it. Frames no
				// snapshot reports never bump.
				let bumpVersion = true;
				for (const event of events) {
					if (bumpVersion && !SNAPSHOT_NEUTRAL_EVENTS[event.type]) {
						useSessionStore.setState(state => ({ eventVersion: state.eventVersion + 1 }));
						bumpVersion = false;
					}
					switch (event.type) {
						case "agent_start": {
							useSessionStore.setState({ isStreaming: true, awaitingModelSince: Date.now() });
							useTodoStore.getState().setTurnActive(true);
							// Server-side mode changes (plan_approval accept exits plan
							// mode, then dispatches the execution turn) carry no event —
							// re-sync state-derived stores at turn start so the composer
							// chip / titlebar reflect the server.
							void refreshSessionState(tabId);
							bumpVersion = true;
							break;
						}
						case "turn_start": {
							// Model request dispatched; the chat renders a pending-model
							// indicator from this timestamp until message_start (or a
							// running tool card) takes over. Without it a stalled provider
							// (slow first event, transport retry) looks like dead air.
							useSessionStore.setState({ awaitingModelSince: Date.now() });
							break;
						}
						case "message_start":
						case "message_end": {
							const todo = useTodoStore.getState();
							if (todo.turnActive && (event.message.role === "assistant" || event.message.role === "user")) {
								todo.setTurnActive(true, messageSourceTimestamp(event.message));
							}
							// The finalized assistant message replaces the pending
							// indicator — tools run next and their cards carry the
							// activity signal. message_start is NOT the clear point: it
							// fires with an empty shell before the first token streams,
							// and clearing there would reopen the dead-air window.
							if (event.type === "message_end" && event.message.role === "assistant") {
								useSessionStore.setState({ awaitingModelSince: null });
							}
							break;
						}
						case "turn_end": {
							// Tool execution follows; running tool cards carry the
							// activity signal until the next turn_start.
							useSessionStore.setState({ awaitingModelSince: null });
							break;
						}
						case "tool_execution_end": {
							if (event.toolName !== "todo" || event.isError) break;
							const phases = todoPhasesFromToolResult(event.result);
							if (phases) useTodoStore.getState().setPhases(phases);
							break;
						}
						case "agent_end": {
							useSessionStore.setState({ isStreaming: false, awaitingModelSince: null });
							// Releases a todo list this turn finished — the dock card goes away.
							useTodoStore.getState().setTurnActive(false);
							// Its responses' rate-limit headers just moved the account's quota.
							useUsageSignal.getState().turnEnded();
							notifyOnAgentEnd(tabId, event);
							toastOnAgentError(tabId, event);
							// Re-fetch state so agent-side todo updates mid-turn reach the panel.
							void refreshSessionState(tabId);
							bumpVersion = true;
							break;
						}
						case "auto_compaction_start": {
							// TUI parity: swap the status row to the maintenance loader
							// ("Context overflow detected, Auto context-full maintenance…")
							// for the whole compaction window, not just a flag.
							useSessionStore.setState({
								isCompacting: true,
								compactionInfo: { reason: event.reason, action: event.action },
							});
							break;
						}
						case "auto_compaction_end": {
							useSessionStore.setState({ isCompacting: false, compactionInfo: null });
							if (!event.aborted) {
								void (tabId && sessionRuntime(tabId) ? hydrateTabSession(tabId) : hydrateSession());
								bumpVersion = true;
							}
							// Outcomes as stock's event-controller words them; a benign skip and a
							// compaction result say nothing (the transcript shows the result).
							const action = translate(compactionActionKey(event.action));
							const push = useToastStore.getState().push;
							if (event.aborted)
								push({ variant: "info", message: translate("events.maintenanceCancelled", { action }) });
							else if (event.action === "shake") {
								if (event.errorMessage)
									push({ variant: "warning", title: action, message: event.errorMessage });
								else if (!event.skipped)
									push({ variant: "info", message: translate("events.maintenanceCompleted", { action }) });
							} else if (event.result) {
								// The compacted transcript is the outcome.
							} else if (event.errorMessage)
								push({
									variant: "warning",
									message: translate("events.maintenanceFailed", { action }),
									detail: event.errorMessage,
								});
							else if (event.action === "handoff")
								push({ variant: "info", message: translate("events.maintenanceCompleted", { action }) });
							else if (!event.skipped)
								push({ variant: "warning", message: translate("events.maintenanceFailed", { action }) });
							break;
						}
						case "auto_retry_start": {
							retryPendingTabs.add(tabId);
							// TUI parity: inline retry loader for the delay+attempt window.
							// Not a model wait, so the pending-model marker stays clear until
							// auto_retry_end re-arms it.
							useSessionStore.setState({
								retryInfo: {
									attempt: event.attempt,
									maxAttempts: event.maxAttempts,
									delayMs: event.delayMs,
									errorMessage: event.errorMessage,
									startedAt: Date.now(),
								},
								awaitingModelSince: null,
							});
							if (!awaitingConnection(tabId)) {
								useToastStore.getState().push({
									variant: "warning",
									message: translate(
										event.delayMs >= 60_000 ? "events.retryScheduledAt" : "events.retryScheduled",
										{
											attempt: event.attempt,
											max: event.maxAttempts,
											seconds: Math.round(event.delayMs / 1000),
											time: formatClock(Date.now() + event.delayMs),
											// The reason in the user's words; the raw text stays on the status row.
											error: translate(describeTurnError(event.errorMessage).titleKey),
										},
									),
								});
							}
							break;
						}
						case "auto_retry_end": {
							retryPendingTabs.delete(tabId);
							// Mirror the TUI's #ensureWorkingLoaderWhileStreaming: a succeeded
							// retry re-dispatches the turn, so the wait for first content is
							// visible again even if no fresh turn_start arrives.
							useSessionStore.setState({
								retryInfo: null,
								...(event.success && useSessionStore.getState().isStreaming
									? { awaitingModelSince: Date.now() }
									: {}),
							});
							if (event.success) {
								useToastStore
									.getState()
									.push({ variant: "success", message: translate("events.retrySucceeded") });
							} else if (!awaitingConnection(tabId)) {
								const failure = turnErrorToast(event.finalError);
								useToastStore.getState().push({
									variant: "error",
									title: translate("turnError.retryFailed"),
									message: failure.message,
									detail: errorDetail(event.finalError),
								});
							}
							break;
						}
						case "retry_fallback_applied": {
							useToastStore.getState().push({
								variant: "warning",
								message: translate("events.fallbackApplied", { from: event.from, to: event.to }),
								...(event.reason ? { detail: event.reason } : {}),
							});
							break;
						}
						case "retry_fallback_succeeded": {
							useToastStore.getState().push({
								variant: "success",
								message: translate("events.fallbackSucceeded", { model: event.model }),
							});
							break;
						}
						case "todo_reminder": {
							useTodoStore.getState().showReminder(event.todos);
							// Stock records the reminder as a developer message without message events
							// (session/todo-tracker.ts): fetch it, so the card shows the reminder line live
							// exactly as it will after a reload.
							void (tabId && sessionRuntime(tabId) ? hydrateTabSession(tabId) : hydrateSession());
							bumpVersion = true;
							break;
						}
						case "todo_auto_clear": {
							// Automatic cleanup is not a second user-visible todo change:
							// keep the completed snapshot and only clear the live state.
							useTodoStore.getState().autoClearCompleted();
							break;
						}
						case "thinking_level_changed": {
							const configured =
								typeof event.configured === "string" &&
								(event.configured === "auto" || isThinkingLevel(event.configured))
									? event.configured
									: event.thinkingLevel;
							// Explicit changes omit `configured` because it equals the effective
							// level. Treat that omission as data, not as "keep the old selector";
							// otherwise cycle/hotkey changes leave a stale checked menu item.
							useModelStore.setState({
								thinkingLevel: event.thinkingLevel,
								thinkingConfigured: configured,
								// Stock's auto classification names the effort it picked for this turn.
								thinkingAutoResolved:
									configured === "auto" && isThinkingLevel(event.resolved) ? event.resolved : undefined,
							});
							break;
						}
						case "model_changed": {
							void refreshModelState(tabId);
							break;
						}
						case "notice": {
							// Suppress routine informational churn from chatty sources — vision/xdev
							// mount/unmount notices fire on every model switch and need no action,
							// flooding the toast stack. Warnings/errors and other sources still toast.
							if (event.level === "info" && event.source && QUIET_NOTICE_SOURCES.has(event.source)) break;
							const variant = event.level === "error" ? "error" : event.level === "warning" ? "warning" : "info";
							if (event.source === "compaction" && variant !== "info") {
								// A compaction failure reads like a failed turn: humanized title and
								// guidance; anything unrecognized keeps its text under a localized title.
								const failure = turnErrorToast(event.message);
								const known = failure.kind !== "unknown";
								useToastStore.getState().push({
									variant,
									title: known ? failure.title : translate("events.compactionNotice"),
									message: known ? failure.message : translate("toast.failedRetry"),
									detail: errorDetail(event.message),
								});
								break;
							}
							useToastStore.getState().push({ variant, message: event.message, title: event.source });
							break;
						}
						case "ttsr_triggered": {
							const rules = event.rules.filter(rule => typeof rule?.name === "string");
							const detail = rules
								.map(rule => (rule.description ? `${rule.name}: ${rule.description}` : rule.name))
								.join("\n");
							useToastStore.getState().push({
								variant: "info",
								message: translate("events.ttsrRules", { rules: rules.map(rule => rule.name).join(", ") }),
								...(detail ? { detail } : {}),
							});
							break;
						}
						case "goal_updated": {
							// Goal state is passive display — store in session store for the
							// sidebar card / composer chip. Normalized: drop/complete frames
							// carry the terminal goal object, which must CLEAR the store.
							useSessionStore.setState(goalPatchFromEvent(event.goal, event.state));
							break;
						}
						case "autopilot_update": {
							useAutopilotStore.getState().apply(event.status);
							break;
						}
						case "desktop_slot_update": {
							useDesktopSlotStore.getState().apply(event.state);
							break;
						}
						case "mail_pending": {
							useSessionStore.setState({ pendingMail: event.items });
							break;
						}
						case "checkout_peers": {
							useSessionStore.setState({ checkoutPeers: event.peers });
							break;
						}
						case "goal_time_limit_reached": {
							useToastStore.getState().push({
								variant: "info",
								message: translate("events.goalTimeLimit", { minutes: event.minutes }),
							});
							break;
						}
						case "next_prompt_config": {
							// The built-in suggestions' switches, model and availability for this tab's bridge.
							useSessionStore.setState(nextPromptPatch(event));
							break;
						}
						case "next_prompt_update": {
							const session = useSessionStore.getState();
							const key = event.sessionFile || event.sessionId || session.sessionFile || session.sessionId;
							if (key) useNextPromptStore.getState().recordUpdate(key, event);
							if (event.status === "unavailable" && event.reason) {
								useSessionStore.setState({
									nextPromptUnavailable: { reason: event.reason, detail: event.detail },
								});
							} else if (event.status === "ready") {
								useSessionStore.setState({ nextPromptUnavailable: null });
							}
							break;
						}
						case "queue_update": {
							// Authoritative queue snapshot — fires on every queue mutation
							// (enqueue, drain/consume, remove, move, clear), so the composer's
							// queue tray and the queue panel never poll mid-run.
							useQueueStore.getState().setFromFrame({ steering: event.steering, followUp: event.followUp });
							break;
						}
						default:
							break;
					}
				}
			});
		}

		// Heartbeat: a wedged command queue (e.g. a stalled discovery await on
		// the serial server queue) leaves status "ready" but blocks every
		// command, including a lightweight get_state. A periodic probe detects
		// that post-boot brick and surfaces the SidecarBanner (with Restart),
		// which the one-shot boot health check cannot catch. A hidden window has
		// no banner to show, so it skips the probe until it is back in view.
		// A wedge is persistent: one get_state that missed its deadline while omp's loop was busy (a large session's
		// transcript work, a phone's dropped socket) is not one, and the banner showed on a live, working session. So a
		// tab is called unresponsive only after WEDGE_PROBES failed probes in a row with no frame from it in between.
		let heartbeat: ReturnType<typeof setInterval> | null = null;
		const probing = new Set<string>();
		const startHeartbeat = () => {
			if (heartbeat) return;
			heartbeat = setInterval(() => {
				if (document.visibilityState === "hidden") return;
				const ids = visibleTabIds(useTabsStore.getState());
				if (ids.length === 0) ids.push("");
				for (const probeTabId of ids) {
					const runtime = sessionRuntime(probeTabId);
					const session = sessionRuntimeStore<SessionStore>(probeTabId, "session") ?? useSessionStore;
					if (probing.has(probeTabId) || session.getState().status !== "ready" || session.getState().switchPending)
						continue;
					probing.add(probeTabId);
					const command = runtime?.command ?? activeTabCommand;
					const current = () => !disposed && !closedTabFrame(probeTabId) && sessionRuntime(probeTabId) === runtime;
					const sentAt = performance.now();
					const missed = () => {
						if (!current()) return;
						if ((lastEventAt.get(probeTabId) ?? 0) > sentAt) return;
						const misses = (missedProbes.get(probeTabId) ?? 0) + 1;
						missedProbes.set(probeTabId, misses);
						if (misses >= WEDGE_PROBES) session.getState().setSidecarError(translate("events.sidecarNoResponse"));
					};
					void command({ type: "get_state" })
						.then(res => {
							if (!res.success) {
								missed();
								return;
							}
							if (!current()) return;
							missedProbes.delete(probeTabId);
							session.getState().clearSidecarError();
							if (res.data != null) applyUsageSnapshot(res.data as RpcSessionState, probeTabId);
						})
						.catch(missed)
						.finally(() => probing.delete(probeTabId));
				}
			}, heartbeatMs);
		};
		const stopHeartbeat = () => {
			if (heartbeat) {
				clearInterval(heartbeat);
				heartbeat = null;
			}
		};

		/** Tabs whose `starting` was a paired host's re-attach (`reconnecting`): the page was kept, and the next `ready` catches up. */
		const reattaching = new Set<string>();
		const handleStatus = (payload: IpcSidecarStatusPayload, statusTabId: string) => {
			if (disposed || closedTabFrame(statusTabId)) return;
			// A tab whose runtime does not exist yet (a page that just loaded still shows the last load's ghosts) gets its
			// own here: `withSessionRuntime` falls back to the focused runtime, so its status, and the `get_state` main
			// answers for its active tab, would land in whichever pane is focused by then, under another tab's session.
			if (statusTabId !== "") ensureTabRuntime(statusTabId);
			statusVersion++;
			const isFocused = () => useTabsStore.getState().activeTabId === statusTabId;
			if (payload.status === "starting") {
				retryPendingTabs.delete(statusTabId);
				// A paired host may still run the omp the page shows: transcript, cards and state stay on screen, and
				// its `ready` reads only what was missed. A plain `starting` (any new omp) clears them.
				if (payload.reconnecting && statusTabId !== "") reattaching.add(statusTabId);
				else {
					reattaching.delete(statusTabId);
					withSessionRuntime(statusTabId, () => {
						useMessagesStore.getState().reset();
						useModelStore.getState().reset();
						useSessionStore.getState().reset();
						useSettingsStore.getState().reset();
						useSubagentsStore.getState().reset();
						useTodoStore.getState().reset();
						useToolsStore.getState().reset();
						useExtensionUiStore.getState().clearAll();
						usePlanApprovalStore.getState().clearProposal();
					});
				}
				withSessionRuntime(statusTabId, () => useSessionStore.getState().clearSidecarError());
			}
			withSessionRuntime(statusTabId, () => useSessionStore.getState().setStatus(payload.status, payload.cwd));

			if (payload.status === "ready" && reattaching.delete(statusTabId)) {
				// The same omp, still running on the host: one merge of what changed meanwhile (state, transcript tail,
				// queue, subagents, goal, plan), as a web page's resync does; the boot checks below ran when it came up.
				startHeartbeat();
				void hydrateTabSession(statusTabId);
				return;
			}
			if (payload.status === "ready") {
				startHeartbeat();
				if (payload.modelFallback) {
					useToastStore.getState().push({
						variant: "warning",
						message: translate("modelRestore.bootFallback", { model: payload.modelFallback }),
					});
				}
				// One-shot boot health check: verify the command loop is live.
				void (async () => {
					const runtime = sessionRuntime(statusTabId);
					const command = runtime?.command ?? activeTabCommand;
					// Every write below goes to this tab's runtime, or (no tab id) to whichever runtime has focus: write
					// nothing once the tab's runtime was replaced or closed, or a tabless check's focus moved meanwhile.
					const focusedAtStart = runtime ? null : focusedSessionRuntime();
					const isCurrent = () =>
						!disposed &&
						(runtime ? sessionRuntime(statusTabId) === runtime : focusedSessionRuntime() === focusedAtStart);
					try {
						// A window opened "in new window" for a specific session
						// switches to it BEFORE hydrating, so the first transcript
						// it pulls is the target session, not the fresh empty one.
						const pending = isFocused() ? await window.omp.sessions.consumePendingOpen() : null;
						if (pending) {
							const sw = await command({ type: "switch_session", sessionPath: pending });
							if (!sw.success) toastError({ title: translate("events.sessionOpenFailed"), error: sw });
						}
						const res = await command({ type: "get_state" });
						if (!isCurrent()) return;
						if (!res.success) {
							withSessionRuntime(statusTabId, () =>
								useSessionStore.getState().setSidecarError(translate("events.sidecarNoResponse")),
							);
						} else {
							withSessionRuntime(statusTabId, () => useSessionStore.getState().clearSidecarError());
							if (runtime) {
								// A pending open just switched sessions: never join a fetch started before it.
								void (pending ? hydrateTabSession(statusTabId) : attachTabSession(statusTabId));
							} else {
								const wire = res.data as RpcSessionState;
								applySessionState(wire);
								if (wire.isStreaming && useSessionStore.getState().awaitingModelSince === null) {
									useSessionStore.setState({ awaitingModelSince: Date.now() });
								}
								if (!wire.isStreaming) useMessagesStore.getState().clearStreaming();
								await Promise.allSettled([
									syncGoal("", activeTabCommand, isCurrent),
									syncAutopilot("", activeTabCommand, isCurrent),
									syncPendingMail("", activeTabCommand, isCurrent),
									syncCheckoutPeers("", activeTabCommand, isCurrent),
									useQueueStore.getState().refresh(),
									useSettingsStore.getState().syncDisplaySettings(),
									useSettingsStore.getState().syncApproval(),
								]);
							}
							void command({ type: "set_subagent_subscription", level: "progress" });
						}
					} catch {
						if (!isCurrent()) return;
						withSessionRuntime(statusTabId, () =>
							useSessionStore.getState().setSidecarError(translate("events.sidecarHealthFailed")),
						);
					}
				})();
			} else if (payload.status === "error" || payload.status === "exited" || payload.status === "restarting") {
				withSessionRuntime(statusTabId, () =>
					useSessionStore
						.getState()
						.setSidecarError(
							payload.message ?? translate("events.sidecarProcessFailed"),
							payload.restart ?? null,
						),
				);
			}
		};

		const unsubStatus = window.omp.events.onTabSidecarStatus(handleStatus);
		const snapshotTabId = focusedTabId();
		const snapshotRuntime = sessionRuntime(snapshotTabId);
		const snapshotVersion = statusVersion;
		void window.omp.sidecar
			.getStatus()
			.then(status => {
				// A boot snapshot cannot roll back a newer push, or reset a task
				// selected/replaced while the active-tab request was in flight.
				if (
					disposed ||
					statusVersion !== snapshotVersion ||
					focusedTabId() !== snapshotTabId ||
					sessionRuntime(snapshotTabId) !== snapshotRuntime
				)
					return;
				handleStatus(status, snapshotTabId);
			})
			.catch(() => {
				// Status pushes and GET_TABS remain authoritative when this read fails.
			});

		const handleSubagent = (frame: SubagentFrame, tabId: string) => {
			if (closedTabFrame(tabId)) return;
			withSessionRuntime(tabId, () => useSubagentsStore.getState().applyFrame(frame));
		};
		const unsubSubagent = window.omp.events.onTabSubagentFrame(handleSubagent);

		const handleModelCatalog = (frame: ModelCatalogUpdateFrame, tabId: string) => {
			if (closedTabFrame(tabId)) return;
			withSessionRuntime(tabId, () => useModelStore.getState().applyCatalogUpdate(frame));
		};
		const unsubModelCatalog = window.omp.events.onTabModelCatalogUpdate(handleModelCatalog);

		// Agent config edits (set_setting from any client, slash-command config
		// changes) push config_update — re-read the thinking-display settings so
		// ThinkingBlock re-renders with the live hide/prose-only policy. The frame
		// also carries the sidecar's live model, which is applied directly: unlike
		// a get_state round trip it cannot lose a race with the event batch.
		const handleConfig = (frame: ConfigUpdateFrame, tabId: string) => {
			if (closedTabFrame(tabId)) return;
			withSessionRuntime(tabId, () => {
				applyModelInfo(frame.model, tabId);
				void useSettingsStore.getState().syncDisplaySettings();
				void useSettingsStore.getState().syncApproval();
			});
			// Another window toggled a composer mode: main says so with `modes: true` (no stock event exists).
			if (frame.modes === true) void refreshSessionModes(tabId);
		};
		const unsubConfig = window.omp.events.onTabConfigUpdate(handleConfig);
		// Extension slash commands can settle locally after the prompt response
		// has already resolved; prompt_result carries the deferred rehydrate signal.
		const handlePromptResult = (frame: PromptResultFrame, tabId: string) => {
			if (closedTabFrame(tabId)) return;
			if (!frame.agentInvoked) void (sessionRuntime(tabId) ? hydrateTabSession(tabId) : hydrateLegacySession());
		};
		const unsubPromptResult = window.omp.events.onTabPromptResult(handlePromptResult);
		// Text-mode slash commands write outside the transcript. Surface their
		// output as local custom messages instead of silently dropping the frame.
		const handleCommandOutput = (frame: CommandOutputFrame, tabId: string) => {
			if (!frame.text || closedTabFrame(tabId)) return;
			withSessionRuntime(tabId, () => {
				useMessagesStore.getState().appendMessage({
					role: "custom",
					customType: "command",
					content: [{ type: "text", text: frame.text }],
					timestamp: Date.now(),
				});
			});
		};
		const unsubCommandOutput = window.omp.events.onTabCommandOutput(handleCommandOutput);

		const handleSessionInfo = (frame: SessionInfoUpdateFrame, tabId: string) => {
			if (closedTabFrame(tabId)) return;
			withSessionRuntime(tabId, () => {
				useSessionStore.setState(state => ({
					sessionName: frame.title === undefined ? state.sessionName : frame.title,
					sessionId: frame.sessionId ?? state.sessionId,
				}));
			});
		};
		const unsubSessionInfo = window.omp.events.onTabSessionInfoUpdate(handleSessionInfo);

		const handleExtensionError = (frame: ExtensionErrorFrame) => {
			useToastStore.getState().push({
				variant: "error",
				title: translate("events.extensionError"),
				message: `${frame.extensionPath} (${frame.event})`,
				detail: errorDetail(frame.error),
			});
		};
		const unsubExtensionError = window.omp.events.onTabExtensionError(handleExtensionError);

		// Ask/extension-UI requests that block for input (ask tool, approvals,
		// confirms, …) from any tab, background ones included — notify when the
		// window is unfocused. One a paired host's re-attach sends again was
		// notified when it first arrived (`resent`), so a link blip stays quiet.
		const unsubExtensionUi = window.omp.events.onExtensionUi((request, sourceTabId, markedSignIn, resent) => {
			const tabId = sourceTabId ?? focusedTabId();
			// A provider sign-in's own requests belong to its login panel: main marks them, and
			// this listener runs before the store records them, so claim by kind too.
			if (markedSignIn || resent) return;
			const signIn = sessionRuntimeStore<ExtensionUiStore>(tabId, "extensionUi")?.getState() ?? NO_SIGN_IN;
			if (claimsLoginRequest(signIn, request) || !isUserBlockingRequest(signIn, request)) return;
			const body =
				"title" in request && typeof request.title === "string" && request.title
					? request.title
					: translate("events.notificationAsk");
			void maybeNotify(
				"ask",
				tabId,
				notificationTitle(tabId),
				body,
				sessionRuntime(tabId)?.command ?? activeTabCommand,
			);
		});

		return () => {
			disposed = true;
			stopHeartbeat();
			unsubscribe();
			unsubStatus();
			unsubSubagent();
			unsubModelCatalog();
			unsubConfig();
			unsubPromptResult();
			unsubExtensionUi();
			unsubCommandOutput();
			unsubSessionInfo();
			unsubExtensionError();
		};
	}, [heartbeatMs]);
}
