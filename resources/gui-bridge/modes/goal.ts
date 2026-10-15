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
 * minutes for the active goal, kept as a journal entry, and this module pauses
 * the goal through stock `pauseGoal()` once its used time reaches the limit.
 */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { guard } from "../health";
import type { BridgeMethods } from "../types";
import {
	GOAL_TIME_ENTRY_TYPE,
	type GoalTimeLimitEntry,
	goalTimeExceeded,
	parseTimeLimitMinutes,
	timeLimitFromEntries,
} from "./goal-time-core";
import { attach, emit, errorMessage, ompPrompt, onSessionEvent, record, submitTurn } from "./shared";

/** How often a running goal with a limit is checked between stock's own accounting events. */
const TIME_CHECK_MS = 10_000;
let timeCheck: NodeJS.Timeout | undefined;
let pausing = false;

function currentTimeLimit(session: AgentSession): number | undefined {
	const goal = session.getGoalModeState()?.goal;
	return goal ? timeLimitFromEntries(session.sessionManager.getBranch(), goal.id) : undefined;
}

async function enforceTimeLimit(session: AgentSession): Promise<void> {
	const state = session.getGoalModeState();
	const limit = state?.enabled ? currentTimeLimit(session) : undefined;
	if (!state?.enabled || limit === undefined || state.goal.status !== "active") {
		clearInterval(timeCheck);
		timeCheck = undefined;
		return;
	}
	if (session.isStreaming) {
		timeCheck ??= setInterval(() => void enforceTimeLimit(session).catch(() => {}), TIME_CHECK_MS);
		timeCheck.unref?.();
	} else {
		// Between turns stock's clock does not run; the next turn's events re-arm the check.
		clearInterval(timeCheck);
		timeCheck = undefined;
	}
	if (pausing || !goalTimeExceeded(state.goal, limit, session.isStreaming, Date.now())) return;
	pausing = true;
	try {
		// Stock's own runtime pause (as on a host abort): no further goal turn starts; resume continues it.
		await session.goalRuntime.pauseGoal();
		emit({ type: "goal_time_limit_reached", minutes: Math.round(limit / 60) });
	} finally {
		pausing = false;
	}
}

onSessionEvent((event, session) => {
	if (
		event.type === "goal_updated" ||
		event.type === "tool_execution_end" ||
		event.type === "turn_end" ||
		event.type === "agent_start"
	) {
		void enforceTimeLimit(session).catch(error =>
			emit({ type: "notice", level: "error", message: `Goal time limit failed: ${errorMessage(error)}` }),
		);
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
	if (session.getVibeModeState()?.enabled) throw new Error("Exit vibe mode first.");
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
	/** `{minutes: number | null}` for the current (active or paused) goal; `null`/0 clears it. */
	"modes.goal_set_time_limit": async (params, env) => {
		const session = attach(env);
		const goal = session.getGoalModeState()?.goal;
		if (!goal || goal.status === "complete" || goal.status === "dropped") throw new Error("No active goal.");
		const entry: GoalTimeLimitEntry = { goalId: goal.id, seconds: parseTimeLimitMinutes(record(params).minutes) };
		session.sessionManager.appendCustomEntry(GOAL_TIME_ENTRY_TYPE, entry);
		await enforceTimeLimit(session);
		return timeLimitState(session);
	},
});
