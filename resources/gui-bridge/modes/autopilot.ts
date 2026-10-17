/**
 * Autopilot's bridge half (rules in ./autopilot-core.ts and ./autopilot-guard-core.ts, protocol and
 * payloads in ./autopilot-contracts.ts, prompt text in ./autopilot-prompt.ts).
 *
 * Autopilot is a stock Goal with a marker: stock's RpcGoalController keeps continuing turns; this
 * module keeps the cycle ledger in the session journal, gives the agent the `autopilot` tool and a
 * static protocol section, enforces the hard limits on every tool call (`tool_call` guard, also for
 * subagents) and tells main what happened through frames:
 *
 * - `arm` installs everything BEFORE main sends `set_goal create|resume` (stock records the tool set
 *   it restores on pause when the goal starts, so the `autopilot` tool must already be active),
 * - the terminal `agent_end` of a turn finalizes the cycle (the agent's `end` report, or `unreported`),
 * - the stop rules and ceilings ask main for a pause (`autopilot_stop_requested`); main sends stock
 *   `set_goal pause`, journals the state through `set_state`, and settles/audits/ships.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { guard } from "../health";
import { registerPromptSection } from "../prompt-sections";
import type { BridgeMethods } from "../types";
import {
	AUTOPILOT_BACKLOG_ENTRY,
	AUTOPILOT_BRIDGE_METHODS,
	AUTOPILOT_CHILD_ENTRY,
	AUTOPILOT_CHILD_PROMPT_SECTION,
	AUTOPILOT_CYCLE_ENTRY,
	AUTOPILOT_END_REASONS,
	AUTOPILOT_NOTE_ENTRY,
	AUTOPILOT_PROMPT_SECTION,
	AUTOPILOT_SHIP_ACTION_ENTRY,
	AUTOPILOT_SHIP_REQUEST_ENTRY,
	AUTOPILOT_STATE_ENTRY,
	AUTOPILOT_TOOL,
	type AutopilotArmParams,
	type AutopilotBacklogEvent,
	type AutopilotBacklogParams,
	type AutopilotChildEntry,
	type AutopilotConfigureParams,
	type AutopilotCycleAmendParams,
	type AutopilotCycleArea,
	type AutopilotCycleRecord,
	type AutopilotEndReason,
	type AutopilotFrame,
	type AutopilotNote,
	type AutopilotSetStateParams,
	type AutopilotSettings,
	type AutopilotShipAction,
	type AutopilotShipRequest,
	type AutopilotStateEntry,
	type AutopilotStatus,
	type AutopilotStopRequest,
	DEFAULT_AUTOPILOT_SETTINGS,
	STALL_SECONDS,
} from "./autopilot-contracts";
import {
	backlogItems,
	buildBegin,
	buildStatus,
	classifyStall,
	cycleRecords,
	decideAfterCycle,
	dueForRelease,
	type EndReport,
	finalizeCycle,
	inFlightAfter,
	initialStateEntry,
	isDuplicateTitle,
	type JournalEntry,
	type LiveCycle,
	lastStateEntry,
	mergeSettings,
	nextStateEntry,
	parseEndReport,
	pendingNotes,
	pendingShipRequests,
	proposeReleaseCheck,
	shipLevelOf,
	totalsOf,
	type UsageTotals,
	usageDelta,
	userMessagesSinceLastCycle,
	verifyShipQuote,
} from "./autopilot-core";
import { evaluateToolCall } from "./autopilot-guard-core";
import { AUTOPILOT_CHILD_SECTION, AUTOPILOT_STOPPING_STEER, autopilotSection } from "./autopilot-prompt";
import { attach, emit, errorMessage, onSessionEvent, record } from "./shared";

/** Tools an autopilot session never has: `ask` (it decides itself), `eval`/`debug` (their subprocesses bypass the tool_call guard). */
const EXCLUDED_TOOLS = ["ask", "eval", "debug"] as const;

// ---------------------------------------------------------------------------------------------
// Module state (one omp process = one main session)
// ---------------------------------------------------------------------------------------------

/** What the `tool_call` guard enforces; follows the journal (restored on session start) and the cycle's own facts. */
interface GuardState {
	role: "parent" | "child";
	root: string;
	settings: AutopilotSettings;
	baseBranch: string;
	/** `begin` said a release is due (or `propose_release` was accepted): the release scope is open this cycle. */
	due: boolean;
	/** A verified "release now" request opened the release scope for this turn. */
	oneShotRelease: boolean;
}

interface LiveState extends LiveCycle {
	/** When the turn began; the cycle's duration is measured from it. */
	turnStartedAt: number;
	usageStart: UsageTotals;
	compactions: number;
	report?: EndReport;
	proposed: boolean;
}

let hostPi: ExtensionAPI | undefined;
let guardState: GuardState | undefined;
let live: LiveState | undefined;
let stallTimer: NodeJS.Timeout | undefined;
let agentStarts = 0;
let lastTurnErrored = false;
/** Settings scopes this module put the yolo override on, so disarm clears exactly those. */
const yoloHeld = new WeakSet<object>();
/** After disarm stock may still restore the pre-goal tool set (on `goal drop`): re-apply the restore then. */
let pendingToolRestore: { excluded: string[]; mounted: string[] } | undefined;

function now(): number {
	return Date.now();
}

function entriesOf(session: { sessionManager: { getBranch(): readonly JournalEntry[] } }): readonly JournalEntry[] {
	return session.sessionManager.getBranch();
}

function mainSession(): Session | undefined {
	const pi = hostPi?.pi;
	return pi?.AgentRegistry.global().get(pi.MAIN_AGENT_ID)?.session;
}

// ---------------------------------------------------------------------------------------------
// Journal and frames
// ---------------------------------------------------------------------------------------------

type Session = AgentSession;

function append(session: Session, customType: string, data: unknown): void {
	session.sessionManager.appendCustomEntry(customType, data);
}

function liveCycle(): LiveCycle | undefined {
	return live ? { n: live.n, area: live.area, startedAt: live.startedAt, beganAt: live.beganAt } : undefined;
}

function statusOf(session: Session): AutopilotStatus {
	return buildStatus(entriesOf(session), now(), liveCycle());
}

function sendFrame(frame: AutopilotFrame): void {
	emit(frame);
}

function publish(session: Session): AutopilotStatus {
	const status = statusOf(session);
	sendFrame({ type: "autopilot_update", status });
	return status;
}

function requireRun(session: Session): AutopilotStateEntry {
	const state = lastStateEntry(entriesOf(session));
	if (!state) throw new Error("This session is not an autopilot run.");
	return state;
}

/** Journals `patch` over the current state; the guard follows. */
function appendState(
	session: Session,
	patch: Partial<Omit<AutopilotStateEntry, "at" | "activeMs">>,
	prev: AutopilotStateEntry = requireRun(session),
): AutopilotStateEntry {
	const next = nextStateEntry(prev, patch, now());
	append(session, AUTOPILOT_STATE_ENTRY, next);
	followState(next);
	return next;
}

/** The guard and the timers follow the journal's last state. */
function followState(state: AutopilotStateEntry | undefined): void {
	if (!state || state.state === "ended") {
		guardState = undefined;
		clearStall();
		return;
	}
	guardState = {
		role: state.role ?? "parent",
		root: state.root,
		settings: state.settings,
		baseBranch: state.baseBranch,
		due: guardState?.due ?? false,
		oneShotRelease: guardState?.oneShotRelease ?? false,
	};
	if (state.state !== "running") clearStall();
}

/** A session (re)started or its branch changed: the guard reads the journal of the session now in front. */
function syncFromJournal(entries: readonly JournalEntry[]): void {
	live = undefined;
	clearStall();
	guardState = undefined;
	followState(lastStateEntry(entries));
}

function clearStall(): void {
	clearTimeout(stallTimer);
	stallTimer = undefined;
}

// ---------------------------------------------------------------------------------------------
// Tools, overrides
// ---------------------------------------------------------------------------------------------

interface OverridableSetting {
	override(scope: object, value: unknown): void;
	clearOverride(scope: object): void;
}

function approvalSetting(): OverridableSetting {
	const setting: unknown = lookup("tools.approvalMode");
	if (
		typeof setting !== "object" ||
		setting === null ||
		typeof (setting as Partial<OverridableSetting>).override !== "function" ||
		typeof (setting as Partial<OverridableSetting>).clearOverride !== "function"
	) {
		throw new Error("This omp has no tools.approvalMode setting, so autopilot cannot approve tools by itself.");
	}
	return setting as OverridableSetting;
}

/** The tool set an autopilot session runs with; returns the tools taken off. */
async function applyTools(session: Session, role: "parent" | "child"): Promise<string[]> {
	const enabled = session.getEnabledToolNames();
	const removed = EXCLUDED_TOOLS.filter(name => enabled.includes(name));
	const next = enabled.filter(name => !(EXCLUDED_TOOLS as readonly string[]).includes(name));
	if (role === "parent" && !next.includes(AUTOPILOT_TOOL)) next.push(AUTOPILOT_TOOL);
	if (role === "child") {
		const index = next.indexOf(AUTOPILOT_TOOL);
		if (index >= 0) next.splice(index, 1);
	}
	await session.setActiveToolsByName(next);
	return removed;
}

/** Tools presented as `xd://` devices rather than top level (stock `getMountedXdevToolNames`); [] on an omp without it. */
function mountedTools(session: Session): string[] {
	return typeof session.getMountedXdevToolNames === "function" ? session.getMountedXdevToolNames() : [];
}

/**
 * The session's tool set without the run: `autopilot` off, the excluded tools back. `getEnabledToolNames` lists the
 * `xd://` devices too, and stock's `setActiveToolsByName` keeps a device mounted only while it is mounted now, so a
 * device taken off at arm (`debug`) would come back top level. `setActiveToolPresentation` takes the partition
 * explicitly: what was a device at arm (`mounted`) or is one now stays one.
 */
async function restoreTools(session: Session, excluded: readonly string[], mounted: readonly string[]): Promise<void> {
	const enabled = session.getEnabledToolNames();
	const known = new Set(session.getAllToolNames());
	const next = enabled.filter(name => name !== AUTOPILOT_TOOL);
	for (const name of excluded) if (known.has(name) && !next.includes(name)) next.push(name);
	if (typeof session.setActiveToolPresentation !== "function") {
		await session.setActiveToolsByName(next);
		return;
	}
	const devices = new Set([...mountedTools(session), ...mounted]);
	await session.setActiveToolPresentation(
		next,
		next.filter(name => devices.has(name)),
	);
}

/**
 * Stock re-applies the pre-goal tool set it remembered when a reattached goal resumes (after a restart,
 * and on every `goal resume` of a goal it reattached): put the run's own tool set back before a turn starts.
 */
async function ensureTools(session: Session): Promise<void> {
	const state = lastStateEntry(entriesOf(session));
	if (!state || (state.state !== "running" && state.state !== "stopping")) return;
	const role = state.role ?? "parent";
	const enabled = session.getEnabledToolNames();
	const hasTool = enabled.includes(AUTOPILOT_TOOL);
	const intact = role === "parent" ? hasTool : !hasTool;
	if (!intact || EXCLUDED_TOOLS.some(name => enabled.includes(name))) await applyTools(session, role);
}

// ---------------------------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------------------------

function usageNow(session: Session): UsageTotals {
	try {
		const stats = session.getSessionStats() as { tokens?: { total?: unknown }; cost?: unknown };
		return {
			tokens: typeof stats.tokens?.total === "number" ? stats.tokens.total : 0,
			usd: typeof stats.cost === "number" ? stats.cost : 0,
		};
	} catch {
		return { tokens: 0, usd: 0 };
	}
}

function nextCycleNumber(entries: readonly JournalEntry[]): number {
	return (cycleRecords(entries).at(-1)?.n ?? 0) + 1;
}

function startLive(session: Session, entries: readonly JournalEntry[]): LiveState {
	const at = now();
	live = {
		n: nextCycleNumber(entries),
		startedAt: at,
		turnStartedAt: at,
		usageStart: usageNow(session),
		compactions: 0,
		proposed: false,
	};
	return live;
}

function lastAssistantFailed(messages: unknown): boolean {
	if (!Array.isArray(messages)) return false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = record(messages[i]);
		if (message.role !== "assistant") continue;
		return message.stopReason === "error" || message.stopReason === "aborted";
	}
	return false;
}

function requestStop(request: AutopilotStopRequest): void {
	clearStall();
	sendFrame({ type: "autopilot_stop_requested", ...request });
}

function onAgentStart(session: Session): void {
	agentStarts++;
	clearStall();
	const state = lastStateEntry(entriesOf(session));
	if (!state || (state.role ?? "parent") !== "parent" || live) return;
	if (state.state !== "running" && state.state !== "stopping") return;
	startLive(session, entriesOf(session));
	publish(session);
}

function onAgentEnd(session: Session, event: unknown): void {
	const finished = live;
	if (!finished) return;
	live = undefined;
	const failed = lastAssistantFailed(record(event).messages);
	if (failed && !finished.report) {
		// An errored or aborted turn is not a cycle: quota waits, retries and the stop buttons are main's.
		lastTurnErrored = true;
		publish(session);
		scheduleStall(session);
		return;
	}
	lastTurnErrored = false;
	const at = now();
	const cycle = finalizeCycle({
		n: finished.n,
		report: finished.report,
		startedAt: finished.startedAt,
		turnStartedAt: finished.turnStartedAt,
		now: at,
		usage: usageDelta(finished.usageStart, usageNow(session)),
		compactions: finished.compactions,
	});
	append(session, AUTOPILOT_CYCLE_ENTRY, cycle);
	let state = requireRun(session);
	if (state.inFlight?.kind === "release") state = appendState(session, { inFlight: undefined }, state);
	if (guardState) {
		guardState.due = false;
		guardState.oneShotRelease = false;
	}
	const entries = entriesOf(session);
	const records = cycleRecords(entries);
	const status = publish(session);
	sendFrame({ type: "autopilot_cycle_end", record: cycle });
	if (state.state === "stopping") {
		sendFrame({ type: "autopilot_settled", reason: state.reason ?? "user" });
		return;
	}
	if (state.state !== "running") return;
	if (session.getPlanModeState()?.enabled) {
		requestStop({ reason: "plan" });
		return;
	}
	const decision = decideAfterCycle({
		records,
		settings: state.settings,
		used: status.totals ?? totalsOf(records),
		activeMs: status.activeMs ?? state.activeMs,
	});
	if (decision) requestStop(decision);
	else scheduleStall(session);
}

/** No new turn within {@link STALL_SECONDS} of a terminal agent_end while the goal wants one: classify why and pause (or leave an error to main's retry path). */
function scheduleStall(session: Session): void {
	clearStall();
	const marker = agentStarts;
	stallTimer = setTimeout(() => {
		stallTimer = undefined;
		try {
			if (agentStarts !== marker || session.isStreaming) return;
			const state = lastStateEntry(entriesOf(session));
			if (!state || (state.role ?? "parent") !== "parent" || state.state !== "running") return;
			const goal = session.getGoalModeState();
			if (!goal?.enabled || goal.goal.status !== "active") return;
			const phases = session.getTodoPhases();
			const tasks = phases.flatMap(phase => phase.tasks);
			const verdict = classifyStall({
				lastTurnErrored,
				planMode: Boolean(session.getPlanModeState()?.enabled),
				todosAllBlocked:
					tasks.some(task => task.status === "blocked") &&
					!tasks.some(task => task.status === "pending" || task.status === "in_progress"),
			});
			if (verdict.kind === "pause") requestStop({ reason: verdict.reason, detail: "no new turn started" });
			else publish(session);
		} catch (error) {
			emit({ type: "notice", level: "error", message: `Autopilot stall check failed: ${errorMessage(error)}` });
		}
	}, STALL_SECONDS * 1000);
	stallTimer.unref?.();
}

onSessionEvent((event, session) => {
	try {
		if (event.type === "agent_start") onAgentStart(session);
		else if (event.type === "agent_end" && (event as { isTerminal?: boolean }).isTerminal !== false)
			onAgentEnd(session, event);
		else if (event.type === "goal_updated") onGoalUpdated(session, event);
	} catch (error) {
		emit({ type: "notice", level: "error", message: `Autopilot: ${errorMessage(error)}` });
	}
});

function onGoalUpdated(session: Session, event: unknown): void {
	const goal = record(record(event).goal);
	if (pendingToolRestore && (!goal.status || goal.status === "dropped" || goal.status === "complete")) {
		const { excluded, mounted } = pendingToolRestore;
		pendingToolRestore = undefined;
		void restoreTools(session, excluded, mounted).catch(() => {});
	}
	const state = lastStateEntry(entriesOf(session));
	if (goal.status === "complete" && state && (state.role ?? "parent") === "parent" && state.state !== "ended") {
		requestStop({ reason: "agent_done", end: true });
	}
}

// ---------------------------------------------------------------------------------------------
// The `autopilot` tool
// ---------------------------------------------------------------------------------------------

function endReportOrThrow(input: Record<string, unknown>): EndReport {
	const parsed = parseEndReport(input);
	if ("error" in parsed) throw new Error(`autopilot end: ${parsed.error}`);
	return parsed;
}

function toolText(value: unknown): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 1) }], details: {} };
}

function newId(prefix: string): string {
	return `${prefix}${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function gitClean(root: string): Promise<boolean> {
	try {
		const result = await hostPi?.exec("git", ["status", "--porcelain"], { cwd: root });
		return result !== undefined && result.code === 0 && result.stdout.trim() === "";
	} catch {
		return false;
	}
}

async function runTool(session: Session, params: Record<string, unknown>, kind: "main" | "sub"): Promise<unknown> {
	if (kind !== "main") throw new Error("Only the main agent runs autopilot cycles.");
	const state = requireRun(session);
	if ((state.role ?? "parent") !== "parent") throw new Error("A child session has no autopilot tool.");
	const entries = entriesOf(session);
	const records = cycleRecords(entries);
	const current = live ?? startLive(session, entries);
	switch (params.op) {
		case "begin": {
			const status = statusOf(session);
			const due = dueForRelease({
				policy: state.settings.ship,
				records,
				hasProcedure: Boolean(state.releaseProcedure),
				releaseInFlight: state.inFlight?.kind === "release",
				proposed: current.proposed,
			});
			const result = buildBegin({
				cycle: current.n,
				settings: state.settings,
				records,
				backlog: backlogItems(entries),
				notes: pendingNotes(entries, records, current.beganAt),
				stopping: state.state === "stopping",
				branch: state.branch,
				state,
				due,
				used: status.totals ?? totalsOf(records),
				activeMs: status.activeMs ?? state.activeMs,
			});
			if (current.beganAt === undefined) current.startedAt = now();
			current.beganAt = now();
			current.area = due ? "release" : result.rotation.suggested;
			if (guardState) guardState.due = due;
			if (due && state.inFlight?.kind !== "release") {
				appendState(session, { inFlight: { kind: "release", startedAt: now() } }, state);
			}
			publish(session);
			return toolText(result);
		}
		case "end": {
			const report = endReportOrThrow(params);
			const backlog = backlogItems(entries);
			const pinned = report.backlogId ? backlog.find(item => item.id === report.backlogId && !item.done) : undefined;
			const duplicate =
				!pinned && report.area !== "user" && report.area !== "release" && isDuplicateTitle(records, report.title);
			if (pinned) {
				const done: AutopilotBacklogEvent = { op: "done", id: pinned.id, cycle: current.n, at: now() };
				append(session, AUTOPILOT_BACKLOG_ENTRY, done);
			}
			current.report = report;
			current.area = report.area as AutopilotCycleArea;
			publish(session);
			return toolText({
				recorded: true,
				cycle: current.n,
				...(duplicate
					? { duplicate: true, note: "This title repeats a recent cycle: pick a different item next cycle." }
					: {}),
				next: "Stop now; the runtime starts the next cycle.",
			});
		}
		case "ship": {
			if (params.kind !== "push" && params.kind !== "release")
				throw new Error('ship needs kind "push" or "release".');
			if (typeof params.quote !== "string") throw new Error("ship needs the user's exact words as quote.");
			const verdict = verifyShipQuote(params.kind, params.quote, userMessagesSinceLastCycle(entries));
			if (!verdict.ok) throw new Error(`Ship request refused: ${verdict.reason}.`);
			if (params.kind === "release" && !state.releaseProcedure) {
				throw new Error(
					`Ship request refused: ${state.releaseBlocked ?? "the repository defines no release procedure"}.`,
				);
			}
			const request: AutopilotShipRequest = { kind: params.kind, quote: params.quote, cycle: current.n, at: now() };
			append(session, AUTOPILOT_SHIP_REQUEST_ENTRY, request);
			if (params.kind === "release") {
				if (guardState) guardState.oneShotRelease = true;
				if (state.inFlight?.kind !== "release") {
					appendState(session, { inFlight: { kind: "release", startedAt: now() } }, state);
				}
			}
			publish(session);
			return toolText(
				params.kind === "push"
					? {
							accepted: true,
							next: "The runtime pushes your autopilot branch at the end of this turn. Finish the item in progress and end the cycle.",
						}
					: {
							accepted: true,
							next: "The release scope is open for this turn only. Run the repository's release procedure, report it in end (area release, ship{version,runUrl}).",
						},
			);
		}
		case "propose_release": {
			const check = proposeReleaseCheck(records, {
				policyOn: state.settings.ship.autoRelease.on,
				hasProcedure: Boolean(state.releaseProcedure),
				releaseInFlight: state.inFlight?.kind === "release",
				clean: await gitClean(state.root),
			});
			if (!check.ok) return toolText({ due: false, reason: check.reason });
			current.proposed = true;
			if (guardState) guardState.due = true;
			current.area = "release";
			if (state.inFlight?.kind !== "release") {
				appendState(session, { inFlight: { kind: "release", startedAt: now() } }, state);
			}
			publish(session);
			return toolText({
				due: true,
				next: "Run the repository's release procedure as this cycle's item (area release) and report it in end.",
			});
		}
		default:
			throw new Error(`Unknown autopilot op: ${String(params.op)}`);
	}
}

function registerTool(pi: ExtensionAPI): void {
	const z = pi.pi.z;
	const outcome = z.enum(["merged", "unmerged", "failed", "abandoned"]);
	pi.registerTool({
		name: AUTOPILOT_TOOL,
		label: "Autopilot",
		description:
			"Autopilot cycle ledger. op=begin: start the cycle (returns focus, backlog, notes, rotation, recent cycles, follow-ups, ship state). op=end: report the finished cycle. op=ship: pass on the user's own push/release request (kind + their exact words as quote). op=propose_release: ask whether a release is due (auto release set to agent).",
		parameters: z.object({
			op: z.enum(["begin", "end", "ship", "propose_release"]),
			area: z
				.string()
				.optional()
				.describe("end: design | performance | features | refactoring | tests | bugs | docs | user | release"),
			title: z.string().optional().describe("end: the item, one line (used to avoid repeats)"),
			summary: z.string().optional().describe("end: what you did, assumptions you made"),
			verify: z.enum(["green", "red", "skipped"]).optional().describe("end: the repo's own check result"),
			commit: z.string().optional().describe("end: commit hash"),
			backlogId: z.string().optional().describe("end: the pinned backlog item this cycle did"),
			followups: z.array(z.string()).optional().describe("end: items found but not done"),
			ship: z
				.object({ kind: z.literal("release"), version: z.string(), runUrl: z.string().optional() })
				.optional()
				.describe("end: a release you made"),
			children: z
				.array(z.object({ session: z.string(), branch: z.string(), outcome, sha: z.string().optional() }))
				.optional()
				.describe("end: child sessions of this cycle"),
			kind: z.enum(["push", "release"]).optional().describe("ship: what the user asked for"),
			quote: z.string().optional().describe("ship: the user's exact words"),
		}),
		defaultInactive: true,
		loadMode: "essential",
		approval: "read",
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const session = mainSession();
			if (!session) throw new Error("No live omp session");
			return runTool(session, params, ctx.agent.kind);
		},
	});
}

// ---------------------------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------------------------

export function install(pi: ExtensionAPI): void {
	hostPi ??= pi;
	registerTool(pi);
	registerPromptSection(pi, AUTOPILOT_PROMPT_SECTION, ctx => {
		const state = runningState(ctx);
		return state && (state.role ?? "parent") === "parent" ? autopilotSection(state.settings.maxParallel) : undefined;
	});
	registerPromptSection(pi, AUTOPILOT_CHILD_PROMPT_SECTION, ctx => {
		const state = runningState(ctx);
		return state?.role === "child" ? AUTOPILOT_CHILD_SECTION : undefined;
	});
	pi.on("tool_call", (event, ctx) => {
		const g = guardState;
		if (!g) return undefined;
		if (event.toolName === AUTOPILOT_TOOL && ctx.agent.kind !== "main") {
			return { block: true, reason: "Blocked by autopilot: only the main agent runs autopilot cycles." };
		}
		const decision = evaluateToolCall({
			toolName: event.toolName,
			input: event.input,
			root: g.root,
			shipLevel: shipLevelOf(g.settings.ship, g.due),
			oneShotRelease: g.oneShotRelease,
			role: g.role,
			remote: g.settings.ship.remote,
			defaultBranch: g.baseBranch,
		});
		return decision.block ? { block: true, reason: decision.reason } : undefined;
	});
	pi.on("session_compact", (_event, ctx) => {
		if (ctx.agent.kind === "main" && live) live.compactions++;
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		const session = ctx.agent.kind === "main" ? mainSession() : undefined;
		if (session) await ensureTools(session).catch(() => {});
	});
	for (const name of ["session_start", "session_switch", "session_branch", "session_tree"] as const) {
		pi.on(name, (_event, ctx) => {
			if (ctx.agent.kind === "main") syncFromJournal(ctx.sessionManager.getBranch());
		});
	}
}

function runningState(ctx: {
	sessionManager: { getBranch(): readonly JournalEntry[] };
	agent: { kind: string };
}): AutopilotStateEntry | undefined {
	if (ctx.agent.kind !== "main") return undefined;
	const state = lastStateEntry(ctx.sessionManager.getBranch());
	return state && (state.state === "running" || state.state === "stopping") ? state : undefined;
}

// ---------------------------------------------------------------------------------------------
// Bridge methods
// ---------------------------------------------------------------------------------------------

const M = AUTOPILOT_BRIDGE_METHODS;

function parseArm(params: unknown): AutopilotArmParams {
	const p = record(params);
	if (p.role !== "parent" && p.role !== "child") throw new Error("arm needs role parent|child");
	for (const key of ["root", "run", "branch", "baseBranch"] as const) {
		if (typeof p[key] !== "string" || !p[key]) throw new Error(`arm needs ${key}`);
	}
	return p as unknown as AutopilotArmParams;
}

async function arm(session: Session, params: AutopilotArmParams): Promise<AutopilotStatus> {
	const previous = lastStateEntry(entriesOf(session));
	if (!params.resume && previous && previous.state !== "ended") {
		throw new Error("This session already has an autopilot run; resume or end it first.");
	}
	if (session.getPlanModeState()?.enabled) throw new Error("Exit plan mode first.");
	if (!params.resume && session.getGoalModeState()?.enabled)
		throw new Error("A goal is already active in this session.");
	const mountedAtArm = mountedTools(session);
	const removed = await applyTools(session, params.role);
	approvalSetting().override(session.settings as unknown as object, "yolo");
	yoloHeld.add(session.settings as unknown as object);
	pendingToolRestore = undefined;
	const resumed = params.resume && previous ? previous : undefined;
	const settings = resumed?.settings ?? mergeSettings(DEFAULT_AUTOPILOT_SETTINGS, params.settings ?? {});
	const excludedTools = [...new Set([...(resumed?.excludedTools ?? []), ...removed])];
	const mounted = [...new Set([...(resumed?.mountedTools ?? []), ...mountedAtArm])];
	const patch: Partial<Omit<AutopilotStateEntry, "at" | "activeMs">> = {
		excludedTools,
		mountedTools: mounted,
		settings,
		...(params.releaseProcedure ? { releaseProcedure: params.releaseProcedure } : {}),
		...(params.releaseBlocked ? { releaseBlocked: params.releaseBlocked } : {}),
	};
	if (resumed) appendState(session, { ...patch, state: "running" }, resumed);
	else {
		const entry: AutopilotStateEntry = {
			...initialStateEntry({
				run: params.run,
				root: params.root,
				branch: params.branch,
				baseBranch: params.baseBranch,
				settings,
				role: params.role,
				excludedTools,
				now: now(),
			}),
			...patch,
		};
		append(session, AUTOPILOT_STATE_ENTRY, entry);
		followState(entry);
	}
	if (params.role === "child") {
		const child: AutopilotChildEntry = {
			root: params.root,
			parentTab: params.parentTab ?? "",
			run: params.run,
			...(params.area ? { area: params.area } : {}),
		};
		append(session, AUTOPILOT_CHILD_ENTRY, child);
	}
	live = undefined;
	return publish(session);
}

async function disarm(session: Session): Promise<AutopilotStatus> {
	const state = lastStateEntry(entriesOf(session));
	if (!state) return { active: false };
	clearStall();
	live = undefined;
	if (state.state !== "ended") {
		const reason: AutopilotEndReason = AUTOPILOT_END_REASONS.find(item => item === state.reason) ?? "user";
		appendState(session, { state: "ended", reason }, state);
	}
	guardState = undefined;
	const scope = session.settings as unknown as object;
	if (yoloHeld.delete(scope)) approvalSetting().clearOverride(scope);
	const mounted = state.mountedTools ?? [];
	await restoreTools(session, state.excludedTools, mounted);
	pendingToolRestore = { excluded: [...state.excludedTools], mounted: [...mounted] };
	return publish(session);
}

function setStatePatch(
	params: AutopilotSetStateParams,
	prev: AutopilotStateEntry,
): Partial<Omit<AutopilotStateEntry, "at" | "activeMs">> {
	return {
		state: params.state,
		...(params.reason ? { reason: params.reason } : {}),
		...(params.detail ? { detail: params.detail } : {}),
		...(params.quotaResetAt ? { quotaResetAt: params.quotaResetAt } : {}),
		...(params.inFlight !== undefined ? { inFlight: inFlightAfter(prev.inFlight, params.inFlight) } : {}),
	};
}

function setState(session: Session, params: AutopilotSetStateParams): AutopilotStatus {
	const prev = requireRun(session);
	const next = appendState(session, setStatePatch(params, prev), prev);
	if (next.state === "stopping" && prev.state !== "stopping" && session.isStreaming) {
		hostPi?.sendMessage(
			{ customType: "autopilot-stop", content: AUTOPILOT_STOPPING_STEER, display: true },
			{ deliverAs: "steer" },
		);
	}
	if (next.state === "ended") live = undefined;
	return publish(session);
}

function configure(session: Session, params: AutopilotConfigureParams): AutopilotStatus {
	const prev = requireRun(session);
	const settings = mergeSettings(prev.settings, params);
	const patch: Partial<Omit<AutopilotStateEntry, "at" | "activeMs">> = { settings };
	if (params.releaseProcedure !== undefined) patch.releaseProcedure = params.releaseProcedure ?? undefined;
	if (params.releaseBlocked !== undefined) patch.releaseBlocked = params.releaseBlocked ?? undefined;
	if (params.release !== undefined) patch.release = params.release ?? undefined;
	appendState(session, patch, prev);
	return publish(session);
}

function note(session: Session, params: unknown): AutopilotStatus {
	requireRun(session);
	const text = record(params).text;
	if (typeof text !== "string" || !text.trim()) throw new Error("note needs text");
	const entry: AutopilotNote = { id: newId("n"), text: text.trim(), at: now() };
	append(session, AUTOPILOT_NOTE_ENTRY, entry);
	return publish(session);
}

function backlog(session: Session, params: AutopilotBacklogParams): AutopilotStatus {
	requireRun(session);
	let event: AutopilotBacklogEvent;
	if (params.op === "add") {
		if (typeof params.text !== "string" || !params.text.trim()) throw new Error("backlog add needs text");
		event = { op: "add", id: newId("b"), text: params.text.trim(), at: now() };
	} else if (params.op === "remove") {
		if (typeof params.id !== "string" || !params.id) throw new Error("backlog remove needs id");
		event = { op: "remove", id: params.id, at: now() };
	} else throw new Error("backlog op must be add or remove");
	append(session, AUTOPILOT_BACKLOG_ENTRY, event);
	return publish(session);
}

function replaceCycle(
	session: Session,
	n: unknown,
	change: (cycle: AutopilotCycleRecord) => AutopilotCycleRecord,
): AutopilotStatus {
	requireRun(session);
	if (typeof n !== "number") throw new Error("cycle number required");
	const found = cycleRecords(entriesOf(session)).find(cycle => cycle.n === n);
	if (!found) throw new Error(`No cycle ${n}`);
	append(session, AUTOPILOT_CYCLE_ENTRY, change(found));
	return publish(session);
}

function takeShipRequests(session: Session): { requests: AutopilotShipRequest[] } {
	const requests = pendingShipRequests(entriesOf(session));
	for (const request of requests) append(session, AUTOPILOT_SHIP_REQUEST_ENTRY, { ...request, consumedAt: now() });
	return { requests };
}

function methodsTable(): BridgeMethods {
	return {
		/** Never throws for a session that is no run: `{active:false}`; never arms anything. */
		[M.status]: async (_params, env) => {
			let session: Session;
			try {
				session = attach(env);
			} catch {
				return { active: false };
			}
			if (!guardState) followState(lastStateEntry(entriesOf(session)));
			return statusOf(session);
		},
		...guard("autopilot", {
			[M.arm]: async (params, env) => arm(attach(env), parseArm(params)),
			[M.configure]: async (params, env) => configure(attach(env), record(params) as AutopilotConfigureParams),
			[M.note]: async (params, env) => note(attach(env), params),
			[M.backlog]: async (params, env) => backlog(attach(env), record(params) as AutopilotBacklogParams),
			[M.setState]: async (params, env) => {
				const p = record(params);
				return setState(attach(env), p as unknown as AutopilotSetStateParams);
			},
			[M.shipAction]: async (params, env) => {
				const session = attach(env);
				requireRun(session);
				const p = record(params);
				if (typeof p.kind !== "string" || !Array.isArray(p.refs))
					throw new Error("ship_action needs kind and refs");
				const action: AutopilotShipAction = {
					kind: p.kind as AutopilotShipAction["kind"],
					refs: p.refs.filter((ref): ref is string => typeof ref === "string"),
					...(typeof p.sha === "string" ? { sha: p.sha } : {}),
					at: now(),
				};
				append(session, AUTOPILOT_SHIP_ACTION_ENTRY, action);
				return publish(session);
			},
			[M.markReverted]: async (params, env) =>
				replaceCycle(attach(env), record(params).cycle, cycle => ({ ...cycle, reverted: true })),
			[M.takeShipRequests]: async (_params, env) => takeShipRequests(attach(env)),
			[M.cycleAmend]: async (params, env) => {
				const p = record(params) as unknown as AutopilotCycleAmendParams;
				return replaceCycle(attach(env), p.n, cycle => ({
					...cycle,
					tokens: cycle.tokens + (typeof p.tokens === "number" ? Math.max(0, p.tokens) : 0),
					usd: cycle.usd + (typeof p.usd === "number" ? Math.max(0, p.usd) : 0),
					children: Array.isArray(p.children) ? p.children : cycle.children,
				}));
			},
			[M.disarm]: async (_params, env) => disarm(attach(env)),
		}),
	};
}

export const methods: BridgeMethods = methodsTable();
