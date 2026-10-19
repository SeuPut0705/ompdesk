/**
 * Judge-model assists (gui-bridge modes/judge-assist.ts; contracts in resources/gui-bridge/modes/judge-assist-contracts.ts).
 * The tab's own omp decides (a paired host's tab: on the host, with its quota; both are model commands in
 * remote/quota-commands.ts). Any failure, an omp without the feature included, answers "the judge did not decide",
 * so the caller keeps the behaviour it had before.
 */
import {
	JUDGE_ASSIST_NEEDS_USER,
	JUDGE_ASSIST_PREVIEW_CHECK,
	type NeedsUserResult,
	type PreviewCheckResult,
} from "../../../resources/gui-bridge/modes/judge-assist-contracts";
import type { LocalHandler } from "./types";

export const handlers: Record<string, LocalHandler> = {
	judge_needs_user: async (_command, ctx): Promise<NeedsUserResult> => {
		try {
			const result = await ctx.bridge.request<NeedsUserResult>(JUDGE_ASSIST_NEEDS_USER, {});
			return { needsUser: typeof result?.needsUser === "boolean" ? result.needsUser : null };
		} catch {
			return { needsUser: null };
		}
	},
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
};
