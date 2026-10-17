/**
 * The fake omp's end of Autopilot: the gui-bridge `modes.autopilot_*` methods, the four frames and the stock Goal
 * continuation they ride on (rpc-goal.ts), emulated over the fixture's journal so a SIGKILL relaunch restores the run
 * from the fake session file (`OMP_GUI_TEST_SESSION_FILES=1`). What stock does around a restart is emulated as stock
 * 18.11 does it (src/main/bridge-autopilot-stock.test.ts pins it): its RPC client closing stdin mid-turn journals the
 * turn aborted and nothing more (no `session_exit`); the next process pauses an active goal when it loads the session
 * (a `goal_paused` mode change) and remembers the tool set of that moment, which its `goal resume` puts back and its
 * `goal pause` restores and forgets.
 *
 * The rules are the bridge's own: the pure functions of `modes/autopilot-core.ts` (status, begin, finalize, stop rules,
 * ship quotes) and `modes/autopilot-guard-core.ts` (the tool guard) are imported, not copied, so what this fake does
 * with a cycle is what the packaged bridge does with it. What is emulated is only the agent: a cycle is a turn that
 * runs the scripted tool calls (through the real guard), commits for real in the worktree, and reports with `end`.
 *
 * `OMP_GUI_TEST_AUTOPILOT` (JSON, every key optional):
 * - `cycleMs` (400): how long a cycle's turn runs; `gapMs` (0): idle time before stock's continuation starts the next one.
 * - `verify`: the `end` verify per cycle (index n-1, the last repeats): "green" | "red" | "skipped" | "none" (no `end`).
 * - `cycle`: defaults for every cycle; `cycles`: `{ "<n>": ... }` overrides. A cycle script: `commit` (default true:
 *   a real commit in the worktree), `title`, `area`, `tools` (`{tool, input, raw?}` run through the guard unless `raw`,
 *   which stands for an obfuscated command the guard cannot see), `children` (sessions opened through the host tools),
 *   `compactions`, `tokens`, `usd`, `holdMs` (extra time at the end of the turn), `quota` (the turn ends on the usage
 *   limit, `quotaResetMs` later), `error` (a failed turn), `complete` (the agent calls `goal complete`),
 *   `noContinue` (stock stops continuing: the stall timer runs), `card` (an approval card raised mid-turn),
 *   `forgeQuote` (the agent calls `ship push` with words the user never said), `release` (what a due release cycle
 *   does: `{tools, version, runUrl, verify}`).
 * - `childMs` (800) / `childTokens` / `childUsd`: a child session's turn (a session armed with role child).
 *
 * The agent's tool calls and their outcome are recorded in `OMP_GUI_TEST_RECORD` as `fixture_autopilot_tool`,
 * approval cards as `fixture_autopilot_card`, what arm and disarm did to the session as `fixture_autopilot_session`.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import {
	AUTOPILOT_BACKLOG_ENTRY,
	AUTOPILOT_CHILD_ENTRY,
	AUTOPILOT_CYCLE_ENTRY,
	AUTOPILOT_NOTE_ENTRY,
	AUTOPILOT_OBJECTIVE,
	AUTOPILOT_SHIP_ACTION_ENTRY,
	AUTOPILOT_SHIP_REQUEST_ENTRY,
	AUTOPILOT_STATE_ENTRY,
	type AutopilotArmParams,
	type AutopilotBacklogEvent,
	type AutopilotBacklogParams,
	type AutopilotConfigureParams,
	type AutopilotCycleAmendParams,
	type AutopilotCycleArea,
	type AutopilotCycleRecord,
	type AutopilotNote,
	type AutopilotSetStateParams,
	type AutopilotShipAction,
	type AutopilotShipRequest,
	type AutopilotStateEntry,
	type AutopilotStatus,
	type AutopilotStopRequest,
	DEFAULT_AUTOPILOT_SETTINGS,
	AUTOPILOT_BRIDGE_METHODS as M,
	STALL_SECONDS,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
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
	initialStateEntry,
	type JournalEntry,
	type LiveCycle,
	lastStateEntry,
	mergeSettings,
	nextStateEntry,
	parseEndReport,
	pendingNotes,
	pendingShipRequests,
	shipLevelOf,
	totalsOf,
	usageDelta,
	userMessagesSinceLastCycle,
	verifyShipQuote,
} from "../../resources/gui-bridge/modes/autopilot-core";
import { evaluateToolCall } from "../../resources/gui-bridge/modes/autopilot-guard-core";
import { goalActiveAtExit, type JournalEntry as RestartJournalEntry } from "../../resources/gui-bridge/restart-core";
import type { AgentMessage } from "../../src/shared/rpc-types";

/** The fake's own journal entry for the stock Goal's objective and status (stock journals them as `mode_change`). */
const GOAL_ENTRY = "ompdesk.fixture-goal";
/** Tools an armed run never has (the bridge's `EXCLUDED_TOOLS`). */
const EXCLUDED_TOOLS = ["ask", "eval", "debug"];

interface ToolStep {
	tool: string;
	input: Record<string, unknown>;
	/** Skip the guard: an obfuscated command the regex rules cannot see (the audit's case). */
	raw?: boolean;
}

interface CycleScript {
	commit?: boolean;
	title?: string;
	area?: AutopilotCycleArea;
	tools?: ToolStep[];
	children?: number;
	compactions?: number;
	tokens?: number;
	usd?: number;
	holdMs?: number;
	/** This cycle's turn length (default: the script's `cycleMs`). */
	ms?: number;
	quota?: boolean;
	quotaResetMs?: number;
	error?: string;
	complete?: boolean;
	noContinue?: boolean;
	card?: { title: string };
	forgeQuote?: string;
	verify?: "green" | "red" | "skipped" | "none";
	release?: { tools?: ToolStep[]; version?: string; runUrl?: string; verify?: "green" | "red"; holdMs?: number };
}

interface Script {
	cycleMs?: number;
	gapMs?: number;
	verify?: Array<NonNullable<CycleScript["verify"]>>;
	cycle?: CycleScript;
	cycles?: Record<string, CycleScript>;
	childMs?: number;
	childTokens?: number;
	childUsd?: number;
}

type Params = Record<string, unknown>;
type Reply = (result: unknown) => void;

export interface AutopilotFakeHost {
	write(frame: object): void;
	pushBridgeEvent(event: object): void;
	record(frame: object): void;
	entries(): readonly JournalEntry[];
	appendCustom(customType: string, data: unknown): void;
	/** Stock's `mode_change` entry (`goal`, `goal_paused`, `none`). */
	appendModeChange(mode: string): void;
	/** The journal's `mode_change` entries with their times, as restart-core reads them. */
	modeChanges(): RestartJournalEntry[];
	appendMessage(message: AgentMessage): void;
	isStreaming(): boolean;
	setStreaming(streaming: boolean): void;
	endTurn(messages: AgentMessage[]): void;
	getGoal(): Record<string, unknown> | undefined;
	setGoal(goal: Record<string, unknown> | undefined): void;
	/** The queued steers, taken as stock's loop takes them. */
	takeSteers(): string[];
	stats: { tokens: { total: number }; cost: number };
	model: { provider: string; id: string };
	/** The provider's usage limit resets at this time (the fixture's usage report). */
	setUsageLimitResetAt(at: number | undefined): void;
	/** Whether the fake has a turn the last `retry` would replay. */
	cwd(): string;
}

class Aborted extends Error {}

interface Ctl {
	aborted: boolean;
	wake: (() => void) | null;
}

export function createAutopilotFake(host: AutopilotFakeHost) {
	const script: Script = (() => {
		try {
			return process.env.OMP_GUI_TEST_AUTOPILOT ? (JSON.parse(process.env.OMP_GUI_TEST_AUTOPILOT) as Script) : {};
		} catch {
			return {};
		}
	})();
	const now = () => Date.now();

	// ---- Module state (one omp process = one main session) -----------------------------------
	interface Guard {
		role: "parent" | "child";
		root: string;
		settings: AutopilotStateEntry["settings"];
		baseBranch: string;
		due: boolean;
		oneShotRelease: boolean;
	}
	interface Live extends LiveCycle {
		turnStartedAt: number;
		usageStart: { tokens: number; usd: number };
		compactions: number;
		report?: EndReport;
		proposed: boolean;
	}
	let guardState: Guard | undefined;
	let live: Live | undefined;
	let stallTimer: NodeJS.Timeout | undefined;
	let agentStarts = 0;
	let lastTurnErrored = false;
	let turn: Ctl | undefined;
	let childTurn: { ctl: Ctl; timer: NodeJS.Timeout } | undefined;
	let goal: { objective: string; status: string; tokenBudget?: number } | undefined;
	/** The session's active tools as stock lists them (`get_state.dumpTools`). */
	let tools = ["ask", "bash", "debug", "edit", "eval", "read", "write"];
	/** Stock RpcGoalController's `#previousTools`: the set it took when it added `goal`; `goal pause` puts it back. */
	let previousTools: string[] | undefined;
	const quotaDone = new Set<number>();
	let continuation: NodeJS.Timeout | undefined;
	/** Retry of a failed cycle turn: the same cycle runs again. */
	let failedTurn = false;
	let toolSeq = 0;
	const hostTools = new Map<string, (result: { text: string; isError: boolean }) => void>();
	const cards = new Map<string, (answer: string) => void>();

	// ---- Journal -----------------------------------------------------------------------------
	const entries = () => host.entries();
	const state = () => lastStateEntry(entries());
	const stopped = () => state()?.state === "ended" || state() === undefined;
	const active = () => state() !== undefined && state()?.state !== "ended";

	function followState(next: AutopilotStateEntry | undefined): void {
		if (!next || next.state === "ended") {
			guardState = undefined;
			clearStall();
			return;
		}
		guardState = {
			role: next.role ?? "parent",
			root: next.root,
			settings: next.settings,
			baseBranch: next.baseBranch,
			due: guardState?.due ?? false,
			oneShotRelease: guardState?.oneShotRelease ?? false,
		};
		if (next.state !== "running") clearStall();
	}
	function appendState(
		patch: Partial<Omit<AutopilotStateEntry, "at" | "activeMs">>,
		prev: AutopilotStateEntry = requireRun(),
	): AutopilotStateEntry {
		const next = nextStateEntry(prev, patch, now());
		host.appendCustom(AUTOPILOT_STATE_ENTRY, next);
		followState(next);
		return next;
	}
	function requireRun(): AutopilotStateEntry {
		const current = state();
		if (!current) throw new Error("This session is not an autopilot run.");
		return current;
	}
	function usageNow() {
		return { tokens: host.stats.tokens.total, usd: host.stats.cost };
	}
	function statusNow(): AutopilotStatus {
		const l = live ? { n: live.n, area: live.area, startedAt: live.startedAt, beganAt: live.beganAt } : undefined;
		return buildStatus(entries(), now(), l);
	}
	function publish(): AutopilotStatus {
		const status = statusNow();
		host.pushBridgeEvent({ type: "autopilot_update", status });
		return status;
	}
	function frame(body: object): void {
		host.pushBridgeEvent(body);
	}
	function clearStall(): void {
		clearTimeout(stallTimer);
		stallTimer = undefined;
	}
	function requestStop(request: AutopilotStopRequest): void {
		clearStall();
		frame({ type: "autopilot_stop_requested", ...request });
	}

	// ---- Goal (stock RpcGoalController) ------------------------------------------------------
	function goalState() {
		return goal
			? { goal, state: { enabled: goal.status === "active", mode: "goal", goal } }
			: { goal: null, state: null };
	}
	function setGoalStatus(status: string): void {
		if (!goal) return;
		goal = { ...goal, status };
		host.setGoal(goal);
		host.appendCustom(GOAL_ENTRY, { objective: goal.objective, status });
		host.appendModeChange(status === "active" ? "goal" : status === "paused" ? "goal_paused" : "none");
		host.write({
			type: "goal_updated",
			goal,
			state: { enabled: status === "active", goal, ...(status === "complete" ? { mode: "exiting" } : {}) },
		});
	}
	/** Stock `#enter`: the tool set before the goal is taken once (a reattached goal already holds one), plus `goal`. */
	function enterGoalTools(): void {
		const before = previousTools ?? tools;
		previousTools = before;
		tools = [...new Set([...before, "goal"])];
	}
	/** Stock `#exit` (every `goal pause` and `drop`): the set taken at `#enter` comes back and is forgotten. */
	function exitGoalTools(): void {
		if (previousTools) tools = previousTools;
		previousTools = undefined;
	}
	/** Whether this `goal` command is an Autopilot run's (any other goal stays the fixture's own board goal). */
	function claimsGoal(command: Params): boolean {
		return active() || command.objective === AUTOPILOT_OBJECTIVE || goal !== undefined;
	}
	function goalCommand(command: Params): unknown {
		const op = command.op;
		if (op === "create" && typeof command.objective === "string") {
			goal = { objective: command.objective, status: "active" };
			host.setGoal(goal);
			host.appendCustom(GOAL_ENTRY, { objective: goal.objective, status: "active" });
			host.appendModeChange("goal");
			enterGoalTools();
			host.write({ type: "goal_updated", goal, state: { enabled: true, goal } });
			setImmediate(maybeContinue);
		} else if (op === "pause") {
			if (goal?.status === "active") setGoalStatus("paused");
			exitGoalTools();
		} else if (op === "resume") {
			if (goal?.status === "paused") {
				setGoalStatus("active");
				enterGoalTools();
				setImmediate(maybeContinue);
			}
		} else if (op === "drop") {
			goal = undefined;
			host.setGoal(undefined);
			host.appendCustom(GOAL_ENTRY, { objective: "", status: "dropped" });
			host.appendModeChange("none");
			exitGoalTools();
			host.write({ type: "goal_updated", goal: null, state: { enabled: false } });
		}
		return goalState();
	}

	// ---- The cycle ---------------------------------------------------------------------------
	function cycleScript(n: number): CycleScript {
		const verify = script.verify?.length ? script.verify[Math.min(n, script.verify.length) - 1] : "green";
		return { verify, commit: true, ...(script.cycle ?? {}), ...(script.cycles?.[String(n)] ?? {}) };
	}
	function sleep(ms: number, ctl: Ctl): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			ctl.wake = null;
			if (ctl.aborted) reject(new Aborted());
			else resolve();
		}
		ctl.wake = done;
		return promise;
	}
	function startLive(): Live {
		const at = now();
		const records = cycleRecords(entries());
		live = {
			n: (records.at(-1)?.n ?? 0) + 1,
			startedAt: at,
			turnStartedAt: at,
			usageStart: usageNow(),
			compactions: 0,
			proposed: false,
		};
		return live;
	}
	function onAgentStart(): void {
		agentStarts++;
		clearStall();
		const current = state();
		if (!current || (current.role ?? "parent") !== "parent" || live) return;
		if (current.state !== "running" && current.state !== "stopping") return;
		startLive();
		publish();
	}
	function lastAssistantFailed(messages: AgentMessage[]): boolean {
		const last = [...messages].reverse().find(message => message.role === "assistant");
		return last?.stopReason === "error" || last?.stopReason === "aborted";
	}
	function onAgentEnd(messages: AgentMessage[]): void {
		const finished = live;
		if (!finished) return;
		live = undefined;
		if (lastAssistantFailed(messages) && !finished.report) {
			lastTurnErrored = true;
			publish();
			scheduleStall();
			return;
		}
		lastTurnErrored = false;
		const record = finalizeCycle({
			n: finished.n,
			report: finished.report,
			startedAt: finished.startedAt,
			turnStartedAt: finished.turnStartedAt,
			now: now(),
			usage: usageDelta(finished.usageStart, usageNow()),
			compactions: finished.compactions,
		});
		host.appendCustom(AUTOPILOT_CYCLE_ENTRY, record);
		let current = requireRun();
		if (current.inFlight?.kind === "release") current = appendState({ inFlight: undefined }, current);
		if (guardState) {
			guardState.due = false;
			guardState.oneShotRelease = false;
		}
		const records = cycleRecords(entries());
		const status = publish();
		frame({ type: "autopilot_cycle_end", record });
		if (current.state === "stopping") {
			frame({ type: "autopilot_settled", reason: current.reason ?? "user" });
			return;
		}
		if (current.state !== "running") return;
		const decision = decideAfterCycle({
			records,
			settings: current.settings,
			used: status.totals ?? totalsOf(records),
			activeMs: status.activeMs ?? current.activeMs,
		});
		if (decision) requestStop(decision);
		else scheduleStall();
	}
	/** No new turn within STALL_SECONDS of a terminal agent_end while the goal wants one: classify and pause. */
	function scheduleStall(): void {
		clearStall();
		const marker = agentStarts;
		stallTimer = setTimeout(() => {
			stallTimer = undefined;
			if (agentStarts !== marker || host.isStreaming()) return;
			const current = state();
			if (!current || (current.role ?? "parent") !== "parent" || current.state !== "running") return;
			if (goal?.status !== "active") return;
			const verdict = classifyStall({ lastTurnErrored, planMode: false, todosAllBlocked: false });
			if (verdict.kind === "pause") requestStop({ reason: verdict.reason, detail: "no new turn started" });
			else publish();
		}, STALL_SECONDS * 1000);
		stallTimer.unref?.();
	}

	// ---- The `autopilot` tool (the agent's calls) -------------------------------------------------
	function toolRecord(extra: object): void {
		host.record({ type: "fixture_autopilot_tool", seq: ++toolSeq, cycle: live?.n, ...extra });
	}
	function runOp(params: Params): { text: unknown; error?: string } {
		const current = requireRun();
		const records = cycleRecords(entries());
		const cur = live ?? startLive();
		switch (params.op) {
			case "begin": {
				const status = statusNow();
				const due = dueForRelease({
					policy: current.settings.ship,
					records,
					hasProcedure: Boolean(current.releaseProcedure),
					inFlight: Boolean(current.inFlight),
					proposed: cur.proposed,
				});
				const result = buildBegin({
					cycle: cur.n,
					settings: current.settings,
					records,
					backlog: backlogItems(entries()),
					notes: pendingNotes(entries(), records, cur.beganAt),
					stopping: current.state === "stopping",
					branch: current.branch,
					state: current,
					due,
					used: status.totals ?? totalsOf(records),
					activeMs: status.activeMs ?? current.activeMs,
				});
				if (cur.beganAt === undefined) cur.startedAt = now();
				cur.beganAt = now();
				cur.area = due ? "release" : result.rotation.suggested;
				if (guardState) guardState.due = due;
				if (due && !current.inFlight) appendState({ inFlight: { kind: "release", startedAt: now() } }, current);
				publish();
				return { text: result };
			}
			case "end": {
				const report = parseEndReport(params);
				if ("error" in report) return { text: null, error: `autopilot end: ${report.error}` };
				const pinned = report.backlogId
					? backlogItems(entries()).find(item => item.id === report.backlogId && !item.done)
					: undefined;
				if (pinned) {
					const done: AutopilotBacklogEvent = { op: "done", id: pinned.id, cycle: cur.n, at: now() };
					host.appendCustom(AUTOPILOT_BACKLOG_ENTRY, done);
				}
				cur.report = report;
				cur.area = report.area;
				publish();
				return { text: { recorded: true, cycle: cur.n } };
			}
			case "ship": {
				if (params.kind !== "push" && params.kind !== "release") return { text: null, error: "ship needs kind" };
				const verdict = verifyShipQuote(
					params.kind,
					String(params.quote ?? ""),
					userMessagesSinceLastCycle(entries()),
				);
				if (!verdict.ok) return { text: null, error: `Ship request refused: ${verdict.reason}.` };
				if (params.kind === "release" && !current.releaseProcedure) {
					return {
						text: null,
						error: `Ship request refused: ${current.releaseBlocked ?? "the repository defines no release procedure"}.`,
					};
				}
				const request: AutopilotShipRequest = {
					kind: params.kind,
					quote: String(params.quote),
					cycle: cur.n,
					at: now(),
				};
				host.appendCustom(AUTOPILOT_SHIP_REQUEST_ENTRY, request);
				if (params.kind === "release") {
					if (guardState) guardState.oneShotRelease = true;
					if (!current.inFlight) appendState({ inFlight: { kind: "release", startedAt: now() } }, current);
				}
				publish();
				return { text: { accepted: true } };
			}
			default:
				return { text: null, error: `Unknown autopilot op: ${String(params.op)}` };
		}
	}
	function callOp(params: Params): { text: unknown; error?: string } {
		let outcome: { text: unknown; error?: string };
		try {
			outcome = runOp(params);
		} catch (error) {
			outcome = { text: null, error: error instanceof Error ? error.message : String(error) };
		}
		toolRecord({
			tool: "autopilot",
			op: params.op,
			...(outcome.error ? { error: outcome.error } : { result: outcome.text }),
		});
		return outcome;
	}
	function runStep(step: ToolStep): { ok: boolean; blocked?: string; code?: number } {
		const g = guardState;
		if (!step.raw && g) {
			const decision = evaluateToolCall({
				toolName: step.tool,
				input: step.input,
				root: g.root,
				shipLevel: shipLevelOf(g.settings.ship, g.due),
				oneShotRelease: g.oneShotRelease,
				role: g.role,
				remote: g.settings.ship.remote,
				defaultBranch: g.baseBranch,
			});
			if (decision.block) {
				toolRecord({ tool: step.tool, input: step.input, blocked: decision.reason ?? "blocked" });
				return { ok: false, blocked: decision.reason ?? "blocked" };
			}
		}
		const cwd = g?.root ?? host.cwd();
		let code = 0;
		if (step.tool === "bash") {
			try {
				execFileSync("sh", ["-c", String(step.input.command ?? "true")], {
					cwd,
					stdio: "ignore",
					timeout: 60_000,
					env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
				});
			} catch (error) {
				code = (error as { status?: number }).status ?? 1;
			}
		} else {
			const file = nodePath.resolve(cwd, String(step.input.path ?? step.input.file_path ?? "fixture.txt"));
			fs.mkdirSync(nodePath.dirname(file), { recursive: true });
			fs.writeFileSync(file, String(step.input.content ?? "fixture\n"));
		}
		toolRecord({ tool: step.tool, input: step.input, raw: step.raw === true, code });
		return { ok: code === 0, code };
	}
	function git(cwd: string, ...args: string[]): string {
		return execFileSync(
			"git",
			["-c", "user.name=Autopilot Fixture", "-c", "user.email=autopilot@example.invalid", ...args],
			{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
	}
	function commitCycle(n: number, root: string): string | undefined {
		try {
			fs.writeFileSync(nodePath.join(root, `autopilot-cycle-${n}.txt`), `cycle ${n}\n`);
			git(root, "add", `autopilot-cycle-${n}.txt`);
			git(root, "commit", "-q", "-m", `autopilot: cycle ${n}`);
			return git(root, "rev-parse", "HEAD");
		} catch (error) {
			toolRecord({ tool: "commit", error: String(error) });
			return undefined;
		}
	}
	function hostTool(name: string, args: object): Promise<{ text: string; isError: boolean }> {
		const id = `autopilot-host-${++toolSeq}-${now()}`;
		const { promise, resolve } = Promise.withResolvers<{ text: string; isError: boolean }>();
		hostTools.set(id, resolve);
		host.write({ type: "host_tool_call", id, toolCallId: id, toolName: name, arguments: args });
		return promise;
	}
	async function openChildren(count: number, n: number, ctl: Ctl): Promise<void> {
		const run = requireRun().run;
		const areas = ["tests", "docs", "bugs", "design"];
		const opened = await hostTool("ompdesk_session_open", {
			sessions: Array.from({ length: count }, (_, index) => ({
				message: `Autopilot child ${index + 1} of cycle ${n}: one small item.`,
				worktree: { branch: `autopilot/${run}-c${n}-${areas[index % areas.length] ?? "work"}` },
			})),
			show: "background",
		});
		if (ctl.aborted) throw new Aborted();
		const ids = [...opened.text.matchAll(/Opened session (\w+)/g)].map(match => match[1] as string);
		toolRecord({
			tool: "ompdesk_session_open",
			isError: opened.isError,
			sessions: ids,
			text: opened.text.slice(0, 400),
		});
		if (ids.length === 0) return;
		const result = await hostTool("ompdesk_session_result", { sessions: ids, wait: true, timeout_seconds: 120 });
		if (ctl.aborted) throw new Aborted();
		toolRecord({ tool: "ompdesk_session_result", isError: result.isError, sessions: ids });
	}
	async function raiseCard(title: string, ctl: Ctl): Promise<void> {
		const id = `autopilot-card-${++toolSeq}`;
		const { promise, resolve } = Promise.withResolvers<string>();
		cards.set(id, resolve);
		host.write({ type: "extension_ui_request", id, method: "select", title, options: ["Approve", "Deny"] });
		setTimeout(() => resolve("timeout"), 15_000).unref?.();
		const answer = await promise;
		cards.delete(id);
		if (ctl.aborted) throw new Aborted();
		host.record({ type: "fixture_autopilot_card", id, title, answer });
	}
	function takeSteersIntoJournal(messages: AgentMessage[]): void {
		for (const text of host.takeSteers()) {
			const message: AgentMessage = {
				role: "user",
				content: [{ type: "text", text }],
				steering: true,
				timestamp: now(),
			};
			host.appendMessage(message);
			host.write({ type: "message_start", message });
			host.write({ type: "message_end", message });
			messages.push(message);
			// The agent reads a "push now" / "release now" in chat and passes it on with the user's own words.
			if (/release|deploy|배포|릴리스|릴리즈/i.test(text)) callOp({ op: "ship", kind: "release", quote: text });
			else if (/push|푸시|올려/i.test(text)) callOp({ op: "ship", kind: "push", quote: text });
		}
	}
	function assistant(text: string, extra: Partial<AgentMessage> = {}): AgentMessage {
		return {
			role: "assistant",
			content: text ? [{ type: "text", text }] : [],
			timestamp: now(),
			provider: host.model.provider,
			model: host.model.id,
			stopReason: "stop",
			...extra,
		};
	}

	/** One cycle: a Goal-continuation turn that runs the script of cycle `n`. */
	async function runTurn(): Promise<void> {
		if (host.isStreaming() || goal?.status !== "active") return;
		const current = state();
		if (!current || (current.role ?? "parent") !== "parent") return;
		if (current.state !== "running" && current.state !== "stopping") return;
		const ctl: Ctl = { aborted: false, wake: null };
		turn = ctl;
		failedTurn = false;
		// The bridge's `ensureTools` (before_agent_start): stock's goal resume may have put back the set it remembered.
		if (!tools.includes("autopilot") || EXCLUDED_TOOLS.some(name => tools.includes(name))) armTools("parent");
		host.setStreaming(true);
		host.write({ type: "agent_start" });
		onAgentStart();
		const n = live?.n ?? 1;
		const cs = cycleScript(n);
		const cycleMs = cs.ms ?? script.cycleMs ?? 400;
		const messages: AgentMessage[] = [];
		let reply = assistant(`Autopilot cycle ${n}`);
		try {
			await sleep(Math.round(cycleMs * 0.3), ctl);
			takeSteersIntoJournal(messages);
			if (cs.quota && !quotaDone.has(n)) {
				quotaDone.add(n);
				host.setUsageLimitResetAt(now() + (cs.quotaResetMs ?? 8_000));
				reply = assistant("", { stopReason: "error", errorMessage: "429 usage limit reached for this account" });
				failedTurn = true;
			} else if (cs.error) {
				reply = assistant("", { stopReason: "error", errorMessage: cs.error });
				failedTurn = true;
			} else {
				const begun = callOp({ op: "begin" });
				const due = Boolean(
					(begun.text as { ship?: { due?: boolean } } | null)?.ship?.due || guardState?.oneShotRelease,
				);
				const rotation = (begun.text as { rotation?: { suggested?: string } } | null)?.rotation?.suggested;
				const releasing = due && cs.release !== undefined;
				for (const step of (releasing ? cs.release?.tools : cs.tools) ?? []) {
					runStep(step);
					await sleep(20, ctl);
				}
				if (cs.forgeQuote) callOp({ op: "ship", kind: "push", quote: cs.forgeQuote });
				if (cs.compactions && live) live.compactions = cs.compactions;
				if (cs.card) await raiseCard(cs.card.title, ctl);
				if ((cs.children ?? 0) > 0) await openChildren(cs.children as number, n, ctl);
				await sleep(Math.round(cycleMs * 0.4), ctl);
				takeSteersIntoJournal(messages);
				let commit: string | undefined;
				const verify = releasing ? (cs.release?.verify ?? "green") : (cs.verify ?? "green");
				if (cs.commit !== false && verify !== "none" && guardState) commit = commitCycle(n, guardState.root);
				host.stats.tokens.total += cs.tokens ?? 1_200;
				host.stats.cost += cs.usd ?? 0.01;
				const holdMs = (releasing ? cs.release?.holdMs : cs.holdMs) ?? 0;
				if (holdMs > 0) await sleep(holdMs, ctl);
				if (verify !== "none") {
					const area = (releasing ? "release" : (cs.area ?? rotation ?? "tests")) as AutopilotCycleArea;
					callOp({
						op: "end",
						area,
						title:
							cs.title ??
							(releasing ? `Release ${cs.release?.version ?? "v0.0.1"}` : `Cycle ${n}: ${area} polish`),
						summary: releasing ? "Ran the release procedure." : `Fixture cycle ${n}.`,
						verify,
						...(commit ? { commit } : {}),
						...(releasing && cs.release?.version
							? {
									ship: {
										kind: "release",
										version: cs.release.version,
										...(cs.release.runUrl ? { runUrl: cs.release.runUrl } : {}),
									},
								}
							: {}),
					});
				}
				reply = assistant(
					process.env.OMP_GUI_README_SCENE
						? `Cycle ${n} (${cs.title ?? "done"}): audited the area, fixed the top finding, tests green, committed.`
						: `Autopilot cycle ${n}: ${cs.title ?? "done"}`,
				);
			}
			await sleep(Math.round(cycleMs * 0.3), ctl);
		} catch (error) {
			if (error instanceof Aborted) return;
			throw error;
		}
		turn = undefined;
		host.appendMessage(reply);
		host.write({ type: "message_end", message: reply });
		messages.push(reply);
		if (cs.complete && goal) {
			setGoalStatus("complete");
			goal = undefined;
			host.setGoal(undefined);
		}
		onAgentEnd(messages);
		host.endTurn(messages);
		if (cs.noContinue) return;
		scheduleContinuation();
	}
	function scheduleContinuation(): void {
		clearTimeout(continuation);
		if (failedTurn || goal?.status !== "active") return;
		continuation = setTimeout(maybeContinue, script.gapMs ?? 0);
	}
	function maybeContinue(): void {
		if (host.isStreaming() || goal?.status !== "active") return;
		void runTurn().catch(error => host.record({ type: "fixture_autopilot_error", error: String(error) }));
	}

	// ---- Bridge methods ----------------------------------------------------------------------
	/** The bridge's `applyTools`: the excluded tools off, `autopilot` on for a parent (off for a child). */
	function armTools(role: "parent" | "child"): void {
		const next = tools.filter(name => !EXCLUDED_TOOLS.includes(name) && name !== "autopilot");
		tools = role === "parent" ? [...next, "autopilot"] : next;
	}
	function arm(params: AutopilotArmParams): AutopilotStatus {
		for (const key of ["root", "run", "branch", "baseBranch"] as const) {
			if (typeof params[key] !== "string" || !params[key]) throw new Error(`arm needs ${key}`);
		}
		const previous = state();
		if (!params.resume && previous && previous.state !== "ended") {
			throw new Error("This session already has an autopilot run; resume or end it first.");
		}
		if (!params.resume && goal?.status === "active") throw new Error("A goal is already active in this session.");
		const removed = EXCLUDED_TOOLS.filter(name => tools.includes(name));
		armTools(params.role);
		const resumed = params.resume && previous ? previous : undefined;
		const settings = resumed?.settings ?? mergeSettings(DEFAULT_AUTOPILOT_SETTINGS, params.settings ?? {});
		const patch: Partial<Omit<AutopilotStateEntry, "at" | "activeMs">> = {
			excludedTools: [...new Set([...(resumed?.excludedTools ?? []), ...removed])],
			settings,
			...(params.releaseProcedure ? { releaseProcedure: params.releaseProcedure } : {}),
			...(params.releaseBlocked ? { releaseBlocked: params.releaseBlocked } : {}),
		};
		if (resumed) appendState({ ...patch, state: "running" }, resumed);
		else {
			const entry: AutopilotStateEntry = {
				...initialStateEntry({
					run: params.run,
					root: params.root,
					branch: params.branch,
					baseBranch: params.baseBranch,
					settings,
					role: params.role,
					excludedTools: patch.excludedTools ?? [],
					now: now(),
				}),
				...patch,
			};
			host.appendCustom(AUTOPILOT_STATE_ENTRY, entry);
			followState(entry);
		}
		if (params.role === "child") {
			host.appendCustom(AUTOPILOT_CHILD_ENTRY, {
				root: params.root,
				parentTab: params.parentTab ?? "",
				run: params.run,
				...(params.area ? { area: params.area } : {}),
			});
		}
		live = undefined;
		host.record({
			type: "fixture_autopilot_session",
			action: "arm",
			role: params.role,
			overrides: { "tools.approvalMode": "yolo" },
			removedTools: removed,
			resume: params.resume === true,
		});
		return publish();
	}
	function disarm(): AutopilotStatus {
		const current = state();
		if (!current) return { active: false };
		clearStall();
		live = undefined;
		if (current.state !== "ended") {
			const reason = (["user", "agent_done", "tab_closed"] as const).find(item => item === current.reason) ?? "user";
			appendState({ state: "ended", reason }, current);
		}
		guardState = undefined;
		tools = [...new Set([...tools.filter(name => name !== "autopilot"), ...current.excludedTools])];
		host.record({ type: "fixture_autopilot_session", action: "disarm", restoredTools: current.excludedTools });
		return publish();
	}
	function setStateMethod(params: AutopilotSetStateParams): AutopilotStatus {
		const prev = requireRun();
		const next = appendState(
			{
				state: params.state,
				...(params.reason ? { reason: params.reason } : {}),
				...(params.detail ? { detail: params.detail } : {}),
				...(params.quotaResetAt ? { quotaResetAt: params.quotaResetAt } : {}),
				...(params.inFlight === null
					? { inFlight: undefined }
					: params.inFlight
						? { inFlight: params.inFlight }
						: {}),
			},
			prev,
		);
		if (next.state === "stopping" && prev.state !== "stopping" && host.isStreaming()) {
			host.record({ type: "fixture_autopilot_steer", customType: "autopilot-stop" });
		}
		if (next.state === "ended") live = undefined;
		return publish();
	}
	function replaceCycle(n: unknown, change: (cycle: AutopilotCycleRecord) => AutopilotCycleRecord): AutopilotStatus {
		requireRun();
		if (typeof n !== "number") throw new Error("cycle number required");
		const found = cycleRecords(entries()).find(cycle => cycle.n === n);
		if (!found) throw new Error(`No cycle ${n}`);
		host.appendCustom(AUTOPILOT_CYCLE_ENTRY, change(found));
		return publish();
	}
	function newId(prefix: string): string {
		return `${prefix}${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	}

	const bridgeMethods: Record<string, (params: Params, reply: Reply) => unknown> = {
		[M.status]: () => {
			if (!guardState) followState(state());
			return statusNow();
		},
		[M.arm]: params => arm(params as unknown as AutopilotArmParams),
		[M.configure]: params => {
			const prev = requireRun();
			const p = params as AutopilotConfigureParams;
			const patch: Partial<Omit<AutopilotStateEntry, "at" | "activeMs">> = {
				settings: mergeSettings(prev.settings, p),
			};
			if (p.releaseProcedure !== undefined) patch.releaseProcedure = p.releaseProcedure ?? undefined;
			if (p.releaseBlocked !== undefined) patch.releaseBlocked = p.releaseBlocked ?? undefined;
			if (p.release !== undefined) patch.release = p.release ?? undefined;
			appendState(patch, prev);
			return publish();
		},
		[M.note]: params => {
			requireRun();
			const text = params.text;
			if (typeof text !== "string" || !text.trim()) throw new Error("note needs text");
			const entry: AutopilotNote = { id: newId("n"), text: text.trim(), at: now() };
			host.appendCustom(AUTOPILOT_NOTE_ENTRY, entry);
			return publish();
		},
		[M.backlog]: params => {
			requireRun();
			const p = params as unknown as AutopilotBacklogParams;
			let event: AutopilotBacklogEvent;
			if (p.op === "add") {
				if (typeof p.text !== "string" || !p.text.trim()) throw new Error("backlog add needs text");
				event = { op: "add", id: newId("b"), text: p.text.trim(), at: now() };
			} else if (p.op === "remove") {
				if (typeof p.id !== "string" || !p.id) throw new Error("backlog remove needs id");
				event = { op: "remove", id: p.id, at: now() };
			} else throw new Error("backlog op must be add or remove");
			host.appendCustom(AUTOPILOT_BACKLOG_ENTRY, event);
			return publish();
		},
		[M.setState]: params => setStateMethod(params as unknown as AutopilotSetStateParams),
		[M.shipAction]: params => {
			requireRun();
			if (typeof params.kind !== "string" || !Array.isArray(params.refs))
				throw new Error("ship_action needs kind and refs");
			const action: AutopilotShipAction = {
				kind: params.kind as AutopilotShipAction["kind"],
				refs: params.refs.filter((ref): ref is string => typeof ref === "string"),
				...(typeof params.sha === "string" ? { sha: params.sha } : {}),
				at: now(),
			};
			host.appendCustom(AUTOPILOT_SHIP_ACTION_ENTRY, action);
			return publish();
		},
		[M.markReverted]: params => replaceCycle(params.cycle, cycle => ({ ...cycle, reverted: true })),
		[M.takeShipRequests]: () => {
			const requests = pendingShipRequests(entries());
			for (const request of requests)
				host.appendCustom(AUTOPILOT_SHIP_REQUEST_ENTRY, { ...request, consumedAt: now() });
			return { requests };
		},
		[M.cycleAmend]: params => {
			const p = params as unknown as AutopilotCycleAmendParams;
			return replaceCycle(p.n, cycle => ({
				...cycle,
				tokens: cycle.tokens + (typeof p.tokens === "number" ? Math.max(0, p.tokens) : 0),
				usd: cycle.usd + (typeof p.usd === "number" ? Math.max(0, p.usd) : 0),
				children: Array.isArray(p.children) ? p.children : cycle.children,
			}));
		},
		[M.disarm]: () => disarm(),
	};

	// ---- Hooks the fixture's command switch calls --------------------------------------------
	function load(): void {
		// The journal came from a session file (`--session`): the guard follows it, stock paused the goal at startup.
		followState(state());
		const saved = [...entries()].reverse().find(entry => entry.type === "custom" && entry.customType === GOAL_ENTRY)
			?.data as { objective: string; status: string } | undefined;
		if (saved && (saved.status === "active" || saved.status === "paused")) {
			goal = { objective: saved.objective, status: "paused" };
			host.setGoal(goal);
			// Stock's startup reconcile: an active goal is paused and journaled, and the goal is reattached with the
			// tool set of this moment remembered (the one its `goal resume` puts back).
			if (saved.status === "active") {
				host.appendCustom(GOAL_ENTRY, { objective: saved.objective, status: "paused" });
				host.appendModeChange("goal_paused");
			}
			enterGoalTools();
		}
	}
	return {
		bridgeMethods,
		load,
		/** Stock's `goal` command for an Autopilot run; undefined = not ours (the fixture's board goal). */
		goal(command: Params): unknown {
			return claimsGoal(command) ? goalCommand(command) : undefined;
		},
		/** `abort`: stock's `stopForHostAbort` pauses the goal, the turn ends aborted. True when the fake handled it. */
		abort(respond: () => void): boolean {
			if (childTurn) {
				clearTimeout(childTurn.timer);
				childTurn.ctl.aborted = true;
				childTurn = undefined;
				respond();
				const aborted = assistant("", { stopReason: "aborted" });
				host.appendMessage(aborted);
				host.endTurn([aborted]);
				return true;
			}
			if (!turn && !goal) return false;
			clearTimeout(continuation);
			if (goal?.status === "active") setGoalStatus("paused");
			respond();
			if (!turn) return true;
			turn.aborted = true;
			turn.wake?.();
			turn = undefined;
			const aborted = assistant("", { stopReason: "aborted" });
			host.appendMessage(aborted);
			host.write({ type: "message_end", message: aborted });
			onAgentEnd([aborted]);
			host.endTurn([aborted]);
			return true;
		},
		/** A child session's first prompt: the turn takes `childMs`. True when the fake handled it. */
		childPrompt(message: string, respond: () => void): boolean {
			if (state()?.role !== "child" || state()?.state === "ended") return false;
			respond();
			host.setStreaming(true);
			const user: AgentMessage = { role: "user", content: [{ type: "text", text: message }], timestamp: now() };
			host.appendMessage(user);
			host.write({ type: "agent_start" });
			host.write({ type: "message_end", message: user });
			const ctl: Ctl = { aborted: false, wake: null };
			const timer = setTimeout(() => {
				childTurn = undefined;
				host.stats.tokens.total += script.childTokens ?? 500;
				host.stats.cost += script.childUsd ?? 0.005;
				const done = assistant("Child item done.");
				host.appendMessage(done);
				host.write({ type: "message_end", message: done });
				host.endTurn([user, done]);
			}, script.childMs ?? 800);
			childTurn = { ctl, timer };
			return true;
		},
		/** `/retry` after a failed cycle turn (quota, error): stock's retry re-arms the continuation. True when handled. */
		retry(respond: (data: unknown) => void): boolean {
			if (!failedTurn || !active() || goal?.status !== "active") return false;
			host.setUsageLimitResetAt(undefined);
			respond({ agentInvoked: true });
			failedTurn = false;
			setImmediate(maybeContinue);
			return true;
		},
		/** Stock `restoreSession` plus the bridge's `goalPausedByExit` (restart-core's rule over this journal). */
		restore(): { turn: false; subagents: []; goalPausedByExit: true } | undefined {
			if (goal?.status !== "paused" || !goalActiveAtExit(host.modeChanges(), performance.timeOrigin))
				return undefined;
			return { turn: false, subagents: [], goalPausedByExit: true };
		},
		/** Stock when its RPC client closes stdin: the turn in flight is journaled aborted; the process then ends. */
		hangUp(): void {
			if (!turn && !childTurn) return;
			host.appendMessage(assistant("", { stopReason: "aborted", errorMessage: "Request was aborted" }));
		},
		/** The active tools for `get_state`; undefined when this session never was an Autopilot run. */
		dumpTools(): Array<{ name: string }> | undefined {
			return state() ? tools.map(name => ({ name })) : undefined;
		},
		hostToolResult(command: { id?: unknown; result?: unknown; isError?: unknown }): boolean {
			const waiter = typeof command.id === "string" ? hostTools.get(command.id) : undefined;
			if (!waiter) return false;
			hostTools.delete(command.id as string);
			const content = (command.result as { content?: Array<{ text?: string }> } | undefined)?.content;
			waiter({ text: content?.[0]?.text ?? "", isError: command.isError === true });
			return true;
		},
		uiResponse(command: { id?: unknown; value?: unknown }): boolean {
			const answer = typeof command.id === "string" ? cards.get(command.id) : undefined;
			if (!answer) return false;
			answer(typeof command.value === "string" ? command.value : "cancelled");
			return true;
		},
		stopped,
	};
}
