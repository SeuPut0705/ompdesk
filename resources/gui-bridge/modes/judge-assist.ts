/**
 * Judge-model assists: the guarded bridge methods (behaviour in ./judge-assist-engine.ts). A missing stock internal
 * refuses these methods with `unsupported_omp` (capabilities.ts `judgeAssist`) and leaves the engine without its stock
 * loader, so the suggestion and title engines keep their code rules.
 */
import { guard } from "../health";
import type { BridgeMethods } from "../types";
import { JUDGE_ASSIST_NEEDS_USER, JUDGE_ASSIST_PREVIEW_CHECK, JUDGE_ASSIST_SET } from "./judge-assist-contracts";
import {
	judgeAssistState,
	lastReplyText,
	previewProblem,
	replyNeedsUser,
	setJudgeAssistEnabled,
	setJudgeAssistStockLoader,
} from "./judge-assist-engine";
import { attach, record } from "./shared";

// Dynamic, after `guard` checked the feature: a stock export that vanished must fail this feature, not link time.
setJudgeAssistStockLoader(async () => {
	const judgment = await import("@oh-my-pi/pi-coding-agent/judgment");
	return {
		hasNativeJudge: judgment.hasNativeJudge,
		resolveJudge: judgment.resolveJudge,
		sharedJudgmentCache: judgment.sharedJudgmentCache,
		journalJudgmentUsage: judgment.journalJudgmentUsage,
	} as never;
});

export const methods: BridgeMethods = guard("judgeAssist", {
	/** Main sends the switch to every live local sidecar when the pref changes, and on bridge connect. */
	[JUDGE_ASSIST_SET]: async params => {
		const value = record(params).enabled;
		if (typeof value !== "boolean") throw new Error(`${JUDGE_ASSIST_SET} needs {enabled: boolean}`);
		setJudgeAssistEnabled(value);
		return judgeAssistState();
	},
	/** Does the session's last reply wait for the person? `null`: the judge did not decide (notify as before). */
	[JUDGE_ASSIST_NEEDS_USER]: async (_params, env) => {
		const session = attach(env);
		return { needsUser: (await replyNeedsUser(session, lastReplyText(session.messages))) ?? null };
	},
	/** A capture of a page the agent opened in the Preview: an error or a blank page? */
	[JUDGE_ASSIST_PREVIEW_CHECK]: async (params, env) => {
		const image = record(record(params).image);
		if (typeof image.data !== "string" || typeof image.mimeType !== "string" || !image.data) {
			throw new Error(`${JUDGE_ASSIST_PREVIEW_CHECK} needs {image: {data, mimeType}}`);
		}
		return previewProblem(attach(env), { data: image.data, mimeType: image.mimeType });
	},
});
