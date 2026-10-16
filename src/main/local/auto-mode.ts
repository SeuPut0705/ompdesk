/**
 * Automatic mode choice (gui-bridge modes/auto-mode.ts, rules in resources/gui-bridge/auto-mode-core.ts). The
 * decision is made by the tab's own omp (a paired host's tab: on the host, so the model call and its quota are
 * the host's; `auto_mode_decide` is a model command in remote/quota-commands.ts) and applied here through the
 * commands the Mode popover already uses: `modes.set_plan_mode` for Plan, stock's `goal create` for Goal (the
 * objective is the prompt's own text; the prompt itself then runs as the first turn). Any failure means "none":
 * the prompt must never be held up by this.
 */
import type { AutoModeDecision } from "../../../resources/gui-bridge/auto-mode-contracts";
import { noDecision } from "../../../resources/gui-bridge/auto-mode-core";
import type { LocalHandler } from "./types";

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export const handlers: Record<string, LocalHandler> = {
	auto_mode_decide: async (command, ctx): Promise<AutoModeDecision> => {
		let decision: AutoModeDecision;
		try {
			decision = await ctx.bridge.request<AutoModeDecision>("modes.auto_mode_decide", {
				message: text(command.message),
				loop: command.loop === true,
			});
		} catch {
			return noDecision("unavailable");
		}
		try {
			if (decision.mode === "plan") await ctx.bridge.request("modes.set_plan_mode", { enabled: true });
			else if (decision.mode === "goal" && decision.objective) {
				await ctx.send({ type: "goal", op: "create", objective: decision.objective });
			}
		} catch {
			return noDecision("error", decision.latencyMs, decision.model);
		}
		return decision;
	},
	/** The chip's undo: leaves the mode the app entered and stops deciding for this session. */
	auto_mode_undo: async (command, ctx) => {
		const mode = command.mode === "goal" ? "goal" : "plan";
		await ctx.bridge.request("modes.auto_mode_undo", { mode });
		if (mode === "goal") await ctx.send({ type: "goal", op: "drop" });
		return { mode };
	},
};
