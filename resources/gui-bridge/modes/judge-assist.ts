/**
 * Judge-model assists: the guarded bridge methods (behaviour in ./judge-assist-engine.ts). A missing stock internal
 * refuses these methods with `unsupported_omp` (capabilities.ts `judgeAssist`). The suggestion and title engines call
 * the engine directly and are not guarded: without a usable judge they get "did not decide" and keep their code rules.
 */
import { guard } from "../health";
import type { BridgeMethods } from "../types";
import {
	JUDGE_ASSIST_AVAILABLE,
	JUDGE_ASSIST_NEEDS_USER,
	JUDGE_ASSIST_PREVIEW_CHECK,
	JUDGE_ASSIST_SET,
} from "./judge-assist-contracts";
import {
	applyJudgeAssistSet,
	judgeAvailable,
	previewImageParam,
	previewProblem,
	sessionNeedsUser,
	setJudgeAssistStockLoader,
} from "./judge-assist-engine";
import { attach } from "./shared";

// Registered at import; `guard` wraps only the methods below. The engines never depend on it: every stock call is
// inside a try, so a stock internal that vanished means "the judge did not decide" and each feature keeps its rule.
setJudgeAssistStockLoader(async () => {
	const judgment = await import("@oh-my-pi/pi-coding-agent/judgment");
	const { nativeJudgmentImageBounds } = await import("@oh-my-pi/pi-ai");
	return {
		hasNativeJudge: judgment.hasNativeJudge,
		resolveJudge: judgment.resolveJudge,
		sharedJudgmentCache: judgment.sharedJudgmentCache,
		journalJudgmentUsage: judgment.journalJudgmentUsage,
		nativeJudgmentImageBounds,
	} as never;
});

export const methods: BridgeMethods = guard("judgeAssist", {
	/** Main sends the switch to every live local sidecar when the pref changes, and on bridge connect. */
	[JUDGE_ASSIST_SET]: async params => applyJudgeAssistSet(params),
	/** Would a native judge that takes images answer? No model request; only the Preview check asks it. */
	[JUDGE_ASSIST_AVAILABLE]: async (_params, env) => ({ available: await judgeAvailable(attach(env), true) }),
	/** Does the session's last reply wait for the person? `null`: the judge did not decide (notify as before). */
	[JUDGE_ASSIST_NEEDS_USER]: async (_params, env) => ({ needsUser: await sessionNeedsUser(attach(env)) }),
	/** A capture of a page the agent opened in the Preview: an error or a blank page? */
	[JUDGE_ASSIST_PREVIEW_CHECK]: async (params, env) => previewProblem(attach(env), previewImageParam(params)),
});
