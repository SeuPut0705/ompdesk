/**
 * The goal operations stock RPC's `goal` command lacks. Create, pause, resume
 * and drop stay on stock (its RpcGoalController owns the goal tool's place in
 * the tool set and continuation); these only touch state that controller does
 * not track: replacing an active goal's objective, changing its token budget,
 * and the TUI's guided-goal interview (`handleGuidedGoalCommand`).
 * Kept: stock InteractiveMode.handleGuidedGoalCommand is TUI-bound and
 * RpcGoalController exposes no interview, objective-replace or budget API.
 *
 * Plus a time limit stock goals lack (rules in goal-time-core.ts): the GUI sets
 * minutes for the active goal, kept as a journal entry; once its used time
 * reaches the limit this module reports `goal_time_limit_reached` and main
 * pauses the goal through stock RPC `goal pause` (sidecar-factory.ts), stock's
 * own pause with the pre-goal tool set restored. A resume past the limit first
 * moves it one span on (`modes.goal_resume_time_limit`).
 */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { guard } from "../health";
import type { BridgeMethods } from "../types";
import {
	GOAL_TIME_ENTRY_TYPE,
	type GoalTimeLimitEntry,
	goalTimeExceeded,
	parseTimeLimitMinutes,
	resumedTimeLimit,
	timeLimitFromEntries,
	timeLimitSpanFromEntries,
} from "./goal-time-core";
import { attach, emit, errorMessage, ompPrompt, onSessionEvent, record, submitTurn } from "./shared";

/** How often a running goal with a limit is checked between stock's own accounting events. */
const TIME_CHECK_MS = 10_000;
/** How long a reported limit waits for main's pause before it is reported again. */
const PAUSE_WAIT_MS = 30_000;
let timeCheck: NodeJS.Timeout | undefined;
/** The goal whose limit was last reported, and when: one report per pause. */
let reported: { goalId: string; at: number } | undefined;

function currentTimeLimit(session: AgentSession): number | undefined {
	const goal = session.getGoalModeState()?.goal;
	return goal ? timeLimitFromEntries(session.sessionManager.getBranch(), goal.id) : undefined;
}

function enforceTimeLimit(session: AgentSession): void {
	const state = session.getGoalModeState();
	const limit = state?.enabled ? currentTimeLimit(session) : undefined;
	if (!state?.enabled || limit === undefined || state.goal.status !== "active") {
		clearInterval(timeCheck);
		timeCheck = undefined;
		reported = undefined;
		return;
	}
	if (session.isStreaming) {
		timeCheck ??= setInterval(() => checkTimeLimit(session), TIME_CHECK_MS);
		timeCheck.unref?.();
	} else {
		// Between turns stock's clock does not run; the next turn's events re-arm the check.
		clearInterval(timeCheck);
		timeCheck = undefined;
	}
	if (!goalTimeExceeded(state.goal, limit, session.isStreaming, Date.now())) return;
	const now = Date.now();
	if (reported?.goalId === state.goal.id && now - reported.at < PAUSE_WAIT_MS) return;
	reported = { goalId: state.goal.id, at: now };
	const span = timeLimitSpanFromEntries(session.sessionManager.getBranch(), state.goal.id) ?? limit;
	// Main answers with stock RPC `goal pause` (sidecar-factory.ts): no further goal turn starts, the
	// `goal` tool leaves the tool set as on any pause, and resume continues it.
	emit({ type: "goal_time_limit_reached", minutes: Math.round(span / 60) });
}

function checkTimeLimit(session: AgentSession): void {
	try {
		enforceTimeLimit(session);
	} catch (error) {
		emit({ type: "notice", level: "error", message: `Goal time limit failed: ${errorMessage(error)}` });
	}
}

onSessionEvent((event, session) => {
	if (
		event.type === "goal_updated" ||
		event.type === "tool_execution_end" ||
		event.type === "turn_end" ||
		event.type === "agent_start"
	) {
		checkTimeLimit(session);
	}
});

function timeLimitState(session: AgentSession): { timeLimitSeconds: number | null } {
	return { timeLimitSeconds: currentTimeLimit(session) ?? null };
}

function activeGoal(session: AgentSession) {
	const state = session.getGoalModeState();
	if (!state?.enabled) throw new Error("No active goal.");
	return state;
}

async function guidedGoal(session: AgentSession, initial: string | undefined): Promise<{ started: true }> {
	if (session.getPlanModeState()?.enabled) throw new Error("Exit plan mode first.");
	const { cfgGoalEnabled } = await import("@oh-my-pi/pi-coding-agent/goals/settings");
	if (!cfgGoalEnabled.get(session.settings)) {
		throw new Error("Goal mode is disabled. Enable it in settings (goal.enabled).");
	}
	const state = session.getGoalModeState();
	if (state?.enabled) throw new Error("Goal mode is already active.");
	if (state?.goal?.status === "paused") {
		throw new Error("Resume the current goal first, or drop it before starting a guided goal.");
	}
	const { prompt } = await import("@oh-my-pi/pi-utils");
	const kickoff = prompt.render(ompPrompt("goals/guided-goal-interview.md"), {
		initial: initial?.trim() || undefined,
	});
	// The interview ends with the agent's own `goal create`; expose the tool for it.
	// Stock's goal controller records the pre-goal tool set when that create lands.
	const enabled = session.getEnabledToolNames();
	const addedGoalTool = !enabled.includes("goal");
	if (addedGoalTool) await session.setActiveToolsByName([...enabled, "goal"]);
	// Not awaited: `prompt` settles with the whole turn, the command answers on dispatch.
	void submitTurn(session, kickoff, true).catch(async error => {
		if (addedGoalTool) await session.setActiveToolsByName(enabled).catch(() => {});
		emit({ type: "notice", level: "error", message: `Guided goal failed: ${errorMessage(error)}` });
	});
	return { started: true };
}

export const methods: BridgeMethods = guard("goalMode", {
	"modes.guided_goal": async (params, env) => {
		const initial = record(params).initial;
		return guidedGoal(attach(env), typeof initial === "string" ? initial : undefined);
	},
	/** TUI `#replaceGoalFromObjective`: keep the goal's accounting, swap its objective. */
	"modes.goal_replace": async (params, env) => {
		const session = attach(env);
		const { objective, tokenBudget } = record(params);
		if (typeof objective !== "string" || !objective.trim()) throw new Error("objective is required");
		activeGoal(session);
		const state = await session.goalRuntime.replaceGoal({
			objective: objective.trim(),
			tokenBudget: typeof tokenBudget === "number" ? tokenBudget : undefined,
		});
		session.setGoalModeState(state);
		if (session.isStreaming) await session.sendGoalModeContext({ deliverAs: "steer" });
		return { goal: state.goal, state };
	},
	/** TUI `#handleGoalBudgetCommand`; `null` clears the budget. */
	"modes.goal_set_budget": async (params, env) => {
		const session = attach(env);
		const { tokenBudget } = record(params);
		const state = activeGoal(session);
		if (state.goal.status === "complete") throw new Error("Goal is already complete.");
		if (tokenBudget !== null && (!Number.isInteger(tokenBudget) || (tokenBudget as number) <= 0)) {
			throw new Error("Goal budget must be a positive integer or null.");
		}
		await session.goalRuntime.onBudgetMutated(tokenBudget === null ? undefined : (tokenBudget as number));
		const next = session.getGoalModeState() ?? null;
		return { goal: next?.goal ?? null, state: next };
	},
	/** The current goal's OMPdesk time limit (attaches the watcher, e.g. after an omp restart). */
	"modes.goal_time_limit": async (_params, env) => timeLimitState(attach(env)),
	/** Before stock resumes a paused goal: one more span when it has used its time, so it does not pause at once. */
	"modes.goal_resume_time_limit": async (_params, env) => {
		const session = attach(env);
		const goal = session.getGoalModeState()?.goal;
		const entry = goal?.status === "paused" ? resumedTimeLimit(session.sessionManager.getBranch(), goal) : undefined;
		if (entry) session.sessionManager.appendCustomEntry(GOAL_TIME_ENTRY_TYPE, entry);
		return timeLimitState(session);
	},
	/** `{minutes: number | null}` for the current (active or paused) goal; `null`/0 clears it. */
	"modes.goal_set_time_limit": async (params, env) => {
		const session = attach(env);
		const goal = session.getGoalModeState()?.goal;
		if (!goal || goal.status === "complete" || goal.status === "dropped") throw new Error("No active goal.");
		const entry: GoalTimeLimitEntry = { goalId: goal.id, seconds: parseTimeLimitMinutes(record(params).minutes) };
		session.sessionManager.appendCustomEntry(GOAL_TIME_ENTRY_TYPE, entry);
		enforceTimeLimit(session);
		return timeLimitState(session);
	},
});
