/**
 * Judge-model assists (gui-bridge modes/judge-assist.ts; contracts in resources/gui-bridge/modes/judge-assist-contracts.ts).
 * The tab's own omp decides (a paired host's tab: on the host, with its quota; the model commands are listed in
 * remote/quota-commands.ts). Any failure, an omp without the feature included, answers "the judge did not decide",
 * so the caller keeps the behaviour it had before.
 */
import {
	JUDGE_ASSIST_AVAILABLE,
	JUDGE_ASSIST_PREVIEW_CHECK,
	type JudgeAvailableResult,
	type PreviewCheckResult,
} from "../../../resources/gui-bridge/modes/judge-assist-contracts";
import type { LocalHandler } from "./types";

export const handlers: Record<string, LocalHandler> = {
	/** The notification triage asks the bridge directly from main (notify-triage.ts), so no RPC command exists for it. */
	judge_preview_check: async (command, ctx): Promise<PreviewCheckResult> => {
		try {
			const result = await ctx.bridge.request<PreviewCheckResult>(JUDGE_ASSIST_PREVIEW_CHECK, {
				image: command.image,
			});
			const problem = result?.problem === "error" || result?.problem === "blank" ? result.problem : null;
			return { problem, judged: result?.judged === true };
		} catch {
			return { problem: null, judged: false };
		}
	},
	judge_available: async (_command, ctx): Promise<JudgeAvailableResult> => {
		try {
			const result = await ctx.bridge.request<Partial<JudgeAvailableResult>>(JUDGE_ASSIST_AVAILABLE, {});
			return { available: result?.available === true };
		} catch {
			return { available: false };
		}
	},
};
