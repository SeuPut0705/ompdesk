/**
 * Session modes answered GUI-side. Goal create/pause/resume/drop/get translate
 * to stock's `goal` command; everything else stock RPC lacks (plan mode and
 * approval, vibe, guided goal, goal objective/budget edits, loop mode, `/btw`,
 * `/tan`, `/omfg`, the agent pause gate) runs in the gui-bridge, next to the
 * live session (`resources/gui-bridge/modes/*`), which also pushes the
 * `plan_proposal`, `loop_mode_update`, `btw_delta` and `btw_record` frames.
 */
import type { RpcGoalState } from "../../shared/rpc-types";
import type { LocalCommandContext, LocalHandler } from "./types";

/** Stock `goal` response data (`RpcGoalResult`), as far as the GUI reads it. */
export interface StockGoalResult {
	goal: unknown;
	state: {
		enabled: boolean;
		mode?: string;
		goal: {
			status: string;
			objective: string;
			tokenBudget?: number | null;
			tokensUsed?: number;
			timeUsedSeconds?: number;
		};
	} | null;
}

/** Stock goal state → the GUI's flat `RpcGoalState`. */
export function projectGoal(result: StockGoalResult): RpcGoalState {
	const state = result.state;
	if (!state?.goal) return { enabled: false };
	return {
		enabled: state.enabled,
		status: state.goal.status,
		objective: state.goal.objective,
		tokenBudget: state.goal.tokenBudget,
		tokensUsed: state.goal.tokensUsed,
		timeUsedSeconds: state.goal.timeUsedSeconds,
		mode: state.mode,
	};
}

/** Forward the command's own fields to bridge method `modes.<type>`. */
const viaBridge: LocalHandler = async ({ type, id: _id, ...params }, ctx) =>
	ctx.bridge.request(`modes.${type}`, params);

/** Like the TUI, a new objective starts working at once; while streaming the goal context was steered in instead. */
async function startObjectiveTurn(ctx: LocalCommandContext, objective: string): Promise<void> {
	const state = await ctx.send<{ isStreaming?: boolean }>({ type: "get_state" });
	if (!state.isStreaming) await ctx.send({ type: "prompt", message: objective, streamingBehavior: "followUp" });
}

async function setGoal(command: { [k: string]: unknown }, ctx: LocalCommandContext): Promise<RpcGoalState> {
	if (command.action === "pause" || command.action === "resume" || command.action === "drop") {
		return projectGoal(await ctx.send<StockGoalResult>({ type: "goal", op: command.action }));
	}
	const objective = typeof command.objective === "string" ? command.objective.trim() : "";
	const tokenBudget = typeof command.tokenBudget === "number" ? command.tokenBudget : undefined;
	if (objective) {
		const current = await ctx.send<StockGoalResult>({ type: "goal", op: "get" });
		if (current.state?.enabled) {
			const replaced = await ctx.bridge.request<StockGoalResult>("modes.goal_replace", { objective, tokenBudget });
			await startObjectiveTurn(ctx, objective);
			return projectGoal(replaced);
		}
		if (current.state?.goal.status === "paused") {
			throw new Error("Resume the current goal first, or drop it before setting a new objective.");
		}
		const created = await ctx.send<StockGoalResult>({
			type: "goal",
			op: "create",
			objective,
			...(tokenBudget === undefined ? {} : { token_budget: tokenBudget }),
		});
		await startObjectiveTurn(ctx, objective);
		return projectGoal(created);
	}
	if (command.tokenBudget !== undefined) {
		return projectGoal(
			await ctx.bridge.request<StockGoalResult>("modes.goal_set_budget", { tokenBudget: command.tokenBudget }),
		);
	}
	throw new Error("set_goal requires an objective, a tokenBudget, or an action.");
}

export const handlers: Record<string, LocalHandler> = {
	get_plan_mode: viaBridge,
	set_plan_mode: viaBridge,
	plan_approval: viaBridge,
	get_vibe_mode: viaBridge,
	set_vibe_mode: viaBridge,
	get_goal: async (_command, ctx) => projectGoal(await ctx.send<StockGoalResult>({ type: "goal", op: "get" })),
	set_goal: setGoal,
	guided_goal: viaBridge,
	get_loop_mode: viaBridge,
	set_loop_mode: viaBridge,
	set_agents_paused: viaBridge,
	btw: viaBridge,
	btw_cancel: viaBridge,
	get_btw_history: viaBridge,
	tan: viaBridge,
	omfg: viaBridge,
};
