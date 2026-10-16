/**
 * Session modes answered GUI-side. Goal create/pause/resume/drop/get translate
 * to stock's `goal` command; everything else stock RPC lacks (plan mode and
 * approval, vibe, guided goal, goal objective/budget edits, loop mode,
 * `/tan`, `/omfg`, the agent pause gate) runs in the gui-bridge, next to
 * the live session (`resources/gui-bridge/modes/*`), which also pushes the
 * `plan_proposal` and `loop_mode_update` frames. `/btw`
 * (`btw`, `btw_cancel`, `get_btw_history` and the `btw_delta` / `btw_record`
 * frames) is stock RPC and has no handler here.
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

/**
 * Adds the bridge's OMPdesk time limit (modes/goal.ts) to a goal state. Best
 * effort: an omp without the bridge feature still shows its stock goal. The
 * read also attaches the bridge's limit watcher after an omp restart.
 */
async function withTimeLimit(ctx: LocalCommandContext, state: RpcGoalState): Promise<RpcGoalState> {
	if (!state.status || state.status === "complete" || state.status === "dropped") return state;
	try {
		const { timeLimitSeconds } = await ctx.bridge.request<{ timeLimitSeconds: number | null }>(
			"modes.goal_time_limit",
		);
		return { ...state, timeLimitSeconds };
	} catch {
		return state;
	}
}

async function setTimeLimit(ctx: LocalCommandContext, minutes: number | null): Promise<void> {
	await ctx.bridge.request("modes.goal_set_time_limit", { minutes });
}

async function setGoal(command: { [k: string]: unknown }, ctx: LocalCommandContext): Promise<RpcGoalState> {
	if (command.action === "pause" || command.action === "resume" || command.action === "drop") {
		// A goal paused at its OMPdesk time limit gets another span of it first; resumed as is, the bridge's
		// limit check would pause it again on the resume itself. Best effort: an omp without it resumes as stock.
		if (command.action === "resume") await ctx.bridge.request("modes.goal_resume_time_limit").catch(() => undefined);
		return withTimeLimit(ctx, projectGoal(await ctx.send<StockGoalResult>({ type: "goal", op: command.action })));
	}
	const objective = typeof command.objective === "string" ? command.objective.trim() : "";
	const tokenBudget = typeof command.tokenBudget === "number" ? command.tokenBudget : undefined;
	const timeLimit =
		typeof command.timeLimitMinutes === "number" || command.timeLimitMinutes === null
			? command.timeLimitMinutes
			: undefined;
	if (objective) {
		const current = await ctx.send<StockGoalResult>({ type: "goal", op: "get" });
		if (current.state?.enabled) {
			const replaced = await ctx.bridge.request<StockGoalResult>("modes.goal_replace", { objective, tokenBudget });
			if (timeLimit !== undefined) await setTimeLimit(ctx, timeLimit);
			await startObjectiveTurn(ctx, objective);
			return withTimeLimit(ctx, projectGoal(replaced));
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
		// Before the first turn, so the whole run counts against the limit.
		if (timeLimit !== undefined && timeLimit !== null) await setTimeLimit(ctx, timeLimit);
		await startObjectiveTurn(ctx, objective);
		return withTimeLimit(ctx, projectGoal(created));
	}
	if (command.tokenBudget !== undefined || timeLimit !== undefined) {
		let state: RpcGoalState | undefined;
		if (command.tokenBudget !== undefined) {
			state = projectGoal(
				await ctx.bridge.request<StockGoalResult>("modes.goal_set_budget", { tokenBudget: command.tokenBudget }),
			);
		}
		if (timeLimit !== undefined) await setTimeLimit(ctx, timeLimit);
		return withTimeLimit(ctx, state ?? projectGoal(await ctx.send<StockGoalResult>({ type: "goal", op: "get" })));
	}
	throw new Error("set_goal requires an objective, a tokenBudget, a timeLimitMinutes, or an action.");
}

export const handlers: Record<string, LocalHandler> = {
	get_plan_mode: viaBridge,
	set_plan_mode: viaBridge,
	plan_approval: viaBridge,
	get_vibe_mode: viaBridge,
	set_vibe_mode: viaBridge,
	get_goal: async (_command, ctx) =>
		withTimeLimit(ctx, projectGoal(await ctx.send<StockGoalResult>({ type: "goal", op: "get" }))),
	set_goal: setGoal,
	guided_goal: viaBridge,
	get_loop_mode: viaBridge,
	set_loop_mode: viaBridge,
	get_ratchet: viaBridge,
	set_ratchet: viaBridge,
	set_agents_paused: viaBridge,
	get_delegation: viaBridge,
	set_delegation: viaBridge,
	tan: viaBridge,
	omfg: viaBridge,
};
