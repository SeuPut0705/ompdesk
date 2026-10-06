/**
 * The goal operations stock RPC's `goal` command lacks. Create, pause, resume
 * and drop stay on stock (its RpcGoalController owns the goal tool's place in
 * the tool set and continuation); these only touch state that controller does
 * not track: replacing an active goal's objective, changing its token budget,
 * and the TUI's guided-goal interview (`handleGuidedGoalCommand`).
 */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { guard } from "../health";
import type { BridgeMethods } from "../types";
import { assertToolSession, attach, emit, errorMessage, ompPrompt, record, submitTurn } from "./shared";

function activeGoal(session: AgentSession) {
	const state = session.getGoalModeState();
	if (!state?.enabled) throw new Error("No active goal.");
	return state;
}

async function guidedGoal(session: AgentSession, initial: string | undefined): Promise<{ started: true }> {
	if (session.getPlanModeState()?.enabled) throw new Error("Exit plan mode first.");
	if (session.getVibeModeState()?.enabled) throw new Error("Exit vibe mode first.");
	assertToolSession(session, "Goal mode");
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
});
