/**
 * Automatic mode choice (Plan or Goal, never Loop, Vibe or the other manual modes): before a prompt the user typed runs,
 * the composer asks `auto_mode_decide`, which classifies the prompt with stock's own judge machinery and answers
 * `plan`, `goal` or `none`. It changes nothing itself: main applies a decision through the same commands the Mode
 * popover uses (`set_plan_mode`, stock `goal create`), so the decision stays a plain, undoable mode switch.
 *
 * Stock has no prompt→mode classifier (`plan.defaultOnStartup` is unconditional; `auto-thinking/classifier.ts`
 * picks a thinking effort), so this copies that classifier's approach and calls its pieces: `resolveJudge` over the
 * `judge` role chain (`@tiny`, `@smol`, then `@default`; the same cheap models the titles use), one choice question
 * answered in a few tokens, `preprocessTinyMessage` for the input, the judgment cache, and the session ledger
 * (`journalJudgmentUsage`, purpose `auto-mode`) so session totals count the request. A request that does not
 * answer within AUTO_MODE_TIMEOUT_MS, fails, or is ambiguous means `none`: the prompt is never held up.
 *
 * Guards (auto-mode-core.ts `autoModeSkip`, per-session memory in auto-mode-state.ts): never while a mode the user
 * picked is active, mid-run, for slash commands or `!` bash, after the user rejected a plan in this session (no
 * plan again) or undid an automatic decision (nothing again).
 */

import { AUTO_MODE_TIMEOUT_MS, type AutoModeDecision } from "../auto-mode-contracts";
import {
	AUTO_MODE_INSTRUCTIONS,
	autoModeCriteria,
	autoModeSkip,
	goalObjective,
	modeFromAnswer,
	noDecision,
} from "../auto-mode-core";
import { autoModeFlags, markSuppressed } from "../auto-mode-state";
import { guard } from "../health";
import type { BridgeEnv, BridgeMethods } from "../types";
import { exitPlanMode } from "./plan";
import { ratchetEnabled } from "./ratchet";
import { attach, errorMessage, record } from "./shared";

/** Stock `ChoiceAnswer`, as far as this module reads it. */
interface Answer {
	choice?: unknown;
	probabilities?: unknown;
}

/**
 * Load the stock modules the first decision needs when the bridge starts (index.ts calls `install`), so the first
 * prompt of a session does not pay their import time inside its 2 s deadline. A module that is missing fails
 * later, in `decide`, with the capability guard's coded error.
 */
export function install(): void {
	void Promise.allSettled([
		import("@oh-my-pi/pi-coding-agent/judgment"),
		import("@oh-my-pi/pi-coding-agent/tiny/message-preproc"),
		import("@oh-my-pi/pi-coding-agent/plan-mode/settings"),
		import("@oh-my-pi/pi-coding-agent/goals/settings"),
	]);
}

async function enabledByStock(session: ReturnType<typeof attach>): Promise<{ plan: boolean; goal: boolean }> {
	const [{ cfgPlanEnabled }, { cfgGoalEnabled }] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent/plan-mode/settings"),
		import("@oh-my-pi/pi-coding-agent/goals/settings"),
	]);
	return { plan: cfgPlanEnabled.get(session.settings), goal: cfgGoalEnabled.get(session.settings) };
}

/** Ask the judge role's cheapest available model; throws when none answers. */
async function ask(
	session: ReturnType<typeof attach>,
	text: string,
	allowPlan: boolean,
	signal: AbortSignal,
): Promise<{ answer: Answer; model: string; tokens: { input: number; output: number }; costUsd?: number }> {
	const [{ resolveJudge, sharedJudgmentCache, journalJudgmentUsage }, { preprocessTinyMessage }] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent/judgment"),
		import("@oh-my-pi/pi-coding-agent/tiny/message-preproc"),
	]);
	const judge = resolveJudge({
		settings: session.settings,
		registry: session.modelRegistry,
		sessionModel: session.model,
		sessionId: session.sessionId,
		metadataResolver: provider => session.agent.metadataForProvider(provider),
		purpose: "auto-mode",
		onUsage: journalJudgmentUsage(session.sessionManager),
		telemetry: session.agent.telemetry,
		cache: sharedJudgmentCache(),
	});
	const mode = {
		type: "choice" as const,
		instructions: AUTO_MODE_INSTRUCTIONS,
		criteria: autoModeCriteria(allowPlan),
	};
	const result = await judge.judge(
		{ state: { request: preprocessTinyMessage(text) }, questions: { mode } },
		{ signal },
	);
	const { usage } = result;
	return {
		answer: result.answers.mode as Answer,
		model: `${result.provider}/${result.model}`,
		tokens: { input: usage.input + usage.cacheRead + usage.cacheWrite, output: usage.output },
		costUsd: usage.cost?.total,
	};
}

async function decide(env: BridgeEnv, params: unknown): Promise<AutoModeDecision> {
	const started = Date.now();
	const session = attach(env);
	const text = typeof record(params).message === "string" ? (record(params).message as string) : "";
	const flags = autoModeFlags(session.sessionManager.getSessionId());
	const goal = session.getGoalModeState();
	const ratchet = await ratchetEnabled(session).catch(() => false);
	const skip = autoModeSkip({
		text,
		enabled: true,
		streaming: session.isStreaming,
		active: {
			plan: session.getPlanModeState()?.enabled === true,
			goal: goal?.enabled === true || goal?.goal?.status === "paused",
			loop: record(params).loop === true,
			vibe: session.getVibeModeState()?.enabled === true,
			ratchet,
		},
		suppressed: flags.suppressed,
	});
	const log = (decision: AutoModeDecision): AutoModeDecision => {
		env.pi.logger.debug("gui-bridge: auto mode", {
			mode: decision.mode,
			reason: decision.reason,
			latencyMs: decision.latencyMs,
			model: decision.model,
			tokens: decision.tokens,
			costUsd: decision.costUsd,
		});
		return decision;
	};
	if (skip) return log(noDecision(skip));
	try {
		const allowed = await enabledByStock(session);
		const planAllowed = allowed.plan && !flags.planRejected;
		if (!planAllowed && !allowed.goal) return log(noDecision("unavailable"));
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(new Error(`auto mode timed out after ${AUTO_MODE_TIMEOUT_MS} ms`)),
			AUTO_MODE_TIMEOUT_MS,
		);
		let asked: Awaited<ReturnType<typeof ask>>;
		try {
			asked = await ask(session, text, planAllowed, controller.signal);
		} catch (error) {
			if (controller.signal.aborted) return log(noDecision("timeout", Date.now() - started));
			throw error;
		} finally {
			clearTimeout(timer);
		}
		const latencyMs = Date.now() - started;
		const picked = modeFromAnswer(asked.answer, { plan: planAllowed, goal: allowed.goal });
		const spent = { model: asked.model, tokens: asked.tokens, costUsd: asked.costUsd };
		if (picked.mode === "none") {
			return log({ ...noDecision(picked.reason ?? "classified_none", latencyMs), ...spent });
		}
		return log({
			mode: picked.mode,
			...(picked.mode === "goal" ? { objective: goalObjective(text) } : {}),
			latencyMs,
			...spent,
		});
	} catch (error) {
		env.pi.logger.debug("gui-bridge: auto mode failed", { error: errorMessage(error) });
		return log(noDecision("error", Date.now() - started));
	}
}

export const methods: BridgeMethods = guard("autoMode", {
	"modes.auto_mode_decide": (params, env) => decide(env, params),
	/** The user undid an automatic decision: leave plan mode if it is the mode, and stop deciding for this session. */
	"modes.auto_mode_undo": async (params, env) => {
		const session = attach(env);
		markSuppressed(session.sessionManager.getSessionId());
		if (record(params).mode === "plan" && session.getPlanModeState()?.enabled) await exitPlanMode(session);
		return { suppressed: true };
	},
});
