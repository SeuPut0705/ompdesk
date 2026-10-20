/**
 * Automatic mode choice (Plan or Goal, never the other manual modes): before a prompt the user typed runs,
 * the composer asks `auto_mode_decide`, which classifies the prompt with stock's own judge machinery and answers
 * `plan`, `goal` or `none`. It changes nothing itself: main uses a decision for that one request through stock's own
 * commands (`set_plan_mode` with `auto`, stock `goal create`), and it is never the session's mode: an automatic plan
 * ends when that plan is approved or rejected or the user sends something else (plan.ts, the composer), an
 * automatic goal ends with the goal.
 *
 * Stock has no prompt→mode classifier (`plan.defaultOnStartup` is unconditional; `auto-thinking/classifier.ts`
 * picks a thinking effort), so this copies that classifier's approach and calls its pieces: `resolveJudge` over the
 * `judge` role chain (`@tiny`, `@smol`, then `@default`; the same cheap models the titles use), one choice question
 * answered in a few tokens, `preprocessTinyMessage` for the input, the judgment cache, and the session ledger
 * (`journalJudgmentUsage`, purpose `auto-mode`) so session totals count the request. A request that does not
 * answer within AUTO_MODE_TIMEOUT_MS, fails, or is ambiguous means `none`: the prompt is never held up.
 *
 * Guards (auto-mode-core.ts `autoModeSkip`, per-session memory in auto-mode-state.ts): never while a mode the user
 * picked is active, mid-run, for slash commands or `!` bash, in a busy session (a turn within AUTO_MODE_IDLE_MS,
 * open todos, running subagents or background jobs), after the user rejected a plan in this session (no plan again)
 * or undid an automatic decision (nothing again). The judge also sees the previous exchange, so a follow-up or a
 * correction of earlier work answers none.
 */

import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { guard } from "../health";
import type { BridgeEnv, BridgeMethods } from "../types";
import { AUTO_MODE_TIMEOUT_MS, type AutoModeDecision, type AutoModeReason } from "./auto-mode-contracts";
import {
	AUTO_MODE_INSTRUCTIONS,
	AUTO_MODE_WARM_REQUEST,
	AUTO_MODE_WARM_TIMEOUT_MS,
	type AutoModeWork,
	autoModeCriteria,
	autoModeSkip,
	goalObjective,
	modeFromAnswer,
	noDecision,
	PrefetchSlot,
	previousExchange,
} from "./auto-mode-core";
import { autoModeFlags, markSuppressed } from "./auto-mode-state";
import { exitPlanMode } from "./plan";
import { attach, boundEnv, errorMessage, record } from "./shared";

/** A transcript message's plain text (string content or its text parts). */
function messageText(message: unknown): string {
	const content = record(message).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (record(part).type === "text" && typeof record(part).text === "string" ? record(part).text : ""))
		.join(" ");
}

/** What the session is doing and said last, read from the live session. */
function sessionWork(session: AgentSession): { work: AutoModeWork; previous?: string } {
	const messages: readonly unknown[] = session.messages;
	let lastActivityAt: number | undefined;
	let user: string | undefined;
	let assistant: string | undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = record(messages[index]);
		if (lastActivityAt === undefined && typeof message.timestamp === "number") lastActivityAt = message.timestamp;
		if (assistant === undefined && message.role === "assistant") assistant = messageText(message);
		if (user === undefined && message.role === "user") user = messageText(message);
		if (user !== undefined && lastActivityAt !== undefined) break;
	}
	const openTodos = session
		.getTodoPhases()
		.flatMap(phase => phase.tasks)
		.filter(task => task.status === "pending" || task.status === "in_progress").length;
	return {
		work: {
			now: Date.now(),
			lastActivityAt,
			openTodos,
			// The session's own jobs and every subagent's: a subagent's shell keeps the session busy too.
			runningJobs: session.getAsyncJobTree()?.running.length ?? 0,
		},
		previous: previousExchange(user, assistant),
	};
}

/** Stock `ChoiceAnswer`, as far as this module reads it. */
interface Answer {
	choice?: unknown;
	probabilities?: unknown;
}

/**
 * Load the stock modules the first decision needs when the bridge starts (index.ts calls `install`), so the first
 * prompt of a session does not pay their import time inside its 2 s deadline, and warm the judge as the main session
 * starts (`warmJudge`). A module that is missing fails later, in `decide`, with the capability guard's coded error.
 */
export function install(pi: BridgeEnv["pi"]): void {
	void Promise.allSettled([
		import("@oh-my-pi/pi-coding-agent/judgment"),
		import("@oh-my-pi/pi-coding-agent/tiny/message-preproc"),
		import("@oh-my-pi/pi-coding-agent/plan-mode/settings"),
		import("@oh-my-pi/pi-coding-agent/config/registry"),
	]);
	pi.on("session_start", (_event, ctx) => {
		const env = boundEnv();
		if (ctx.agent.kind === "main" && env) void warmJudge(env);
	});
}

/** `goal.enabled` comes through stock's registry: omp's bundle has no `goals/settings` (an import is a copy). */
async function enabledByStock(session: AgentSession): Promise<{ plan: boolean; goal: boolean }> {
	const [{ cfgPlanEnabled }, { lookup }] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent/plan-mode/settings"),
		import("@oh-my-pi/pi-coding-agent/config/registry"),
	]);
	return { plan: cfgPlanEnabled.get(session.settings), goal: lookup("goal.enabled")?.get(session.settings) === true };
}

/** Stock's judge for this session, on the `judge` role chain. `billed` journals usage and uses the answer cache. */
async function judgeFor(session: AgentSession, billed: boolean) {
	const { resolveJudge, sharedJudgmentCache, journalJudgmentUsage } = await import(
		"@oh-my-pi/pi-coding-agent/judgment"
	);
	return resolveJudge({
		settings: session.settings,
		registry: session.modelRegistry,
		sessionModel: session.model,
		sessionId: session.sessionId,
		metadataResolver: provider => session.agent.metadataForProvider(provider),
		purpose: "auto-mode",
		...(billed ? { onUsage: journalJudgmentUsage(session.sessionManager), cache: sharedJudgmentCache() } : {}),
		telemetry: session.agent.telemetry,
	});
}

/** Ask the judge role's cheapest available model; throws when none answers. */
async function ask(
	session: AgentSession,
	text: string,
	previous: string | undefined,
	allowPlan: boolean,
	signal: AbortSignal,
): Promise<Asked> {
	const [judge, { preprocessTinyMessage }] = await Promise.all([
		judgeFor(session, true),
		import("@oh-my-pi/pi-coding-agent/tiny/message-preproc"),
	]);
	const mode = {
		type: "choice" as const,
		instructions: AUTO_MODE_INSTRUCTIONS,
		criteria: autoModeCriteria(allowPlan),
	};
	const state = { request: preprocessTinyMessage(text), ...(previous ? { previous } : {}) };
	const result = await judge.judge({ state, questions: { mode } }, { signal });
	const { usage } = result;
	return {
		answer: result.answers.mode as Answer,
		model: `${result.provider}/${result.model}`,
		tokens: { input: usage.input + usage.cacheRead + usage.cacheWrite, output: usage.output },
		costUsd: usage.cost?.total,
	};
}

interface Asked {
	answer: Answer;
	model: string;
	tokens: { input: number; output: number };
	costUsd?: number;
}

/** What a decision for `text` asks, or why nothing is asked: the guards decide and prefetch share. */
async function prepare(
	env: BridgeEnv,
	text: string,
): Promise<
	| { skip: AutoModeReason }
	| { skip: null; session: AgentSession; previous?: string; planAllowed: boolean; goalAllowed: boolean }
> {
	const session = attach(env);
	const flags = autoModeFlags(session.sessionManager.getSessionId());
	const goal = session.getGoalModeState();
	const { work, previous } = sessionWork(session);
	const skip = autoModeSkip({
		text,
		enabled: true,
		streaming: session.isStreaming,
		active: {
			plan: session.getPlanModeState()?.enabled === true,
			goal: goal?.enabled === true || goal?.goal?.status === "paused",
		},
		suppressed: flags.suppressed,
		work,
	});
	if (skip) return { skip };
	const allowed = await enabledByStock(session);
	const planAllowed = allowed.plan && !flags.planRejected;
	if (!planAllowed && !allowed.goal) return { skip: "unavailable" };
	return { skip: null, session, previous, planAllowed, goalAllowed: allowed.goal };
}

/**
 * The question asked while the user types (`modes.auto_mode_prefetch`). The answer lands in stock's judgment cache,
 * so the decision at Enter for the same text is answered from it; a decision that arrives while it is still asked
 * waits for it instead of asking a second time. The mode is still set before the prompt is sent: the prefetch only
 * moves the judge's round trip into the typing pause.
 */
const prefetched = new PrefetchSlot<Asked>();
/** The warm-up of this omp, once: the judge's connection belongs to the process. */
let warming: Promise<boolean> | undefined;

/**
 * One unbilled judgment of a fixed state, outside the answer cache so it always reaches the provider, as the omp's
 * main session starts. Measured (20 Oct 2026, stock's model discovery running as an omp starts): the first request to
 * the judge's host took 1.5 s and more under load (DNS, TLS, the discovery's own downloads to the same host), the
 * next ones 0.4 s. A decision's 2 s deadline lost it on every first message, and stock's own auto-thinking classifier
 * (OMPdesk's held `defaultThinkingLevel: auto`) waits its 4 s on the same host. Only a native judge is warmed: a
 * prompted one would cost a chat request on every omp start.
 */
export function warmJudge(env: BridgeEnv): Promise<boolean> {
	warming ??= (async () => {
		try {
			const session = attach(env);
			const { hasNativeJudge } = await import("@oh-my-pi/pi-coding-agent/judgment");
			if (!hasNativeJudge(session.settings, session.modelRegistry)) return false;
			const judge = await judgeFor(session, false);
			await judge.judge(
				{
					state: { request: AUTO_MODE_WARM_REQUEST },
					questions: {
						mode: { type: "choice", instructions: AUTO_MODE_INSTRUCTIONS, criteria: autoModeCriteria(true) },
					},
				},
				{ signal: AbortSignal.timeout(AUTO_MODE_WARM_TIMEOUT_MS) },
			);
			return true;
		} catch (error) {
			env.pi.logger.debug("gui-bridge: auto mode warm-up failed", { error: errorMessage(error) });
			return false;
		}
	})();
	return warming;
}

/** Wait (within `signal`) for a warm-up still under way: a request then reuses its connection instead of opening one. */
async function warmed(signal: AbortSignal): Promise<void> {
	if (!warming) return;
	const { promise: aborted, resolve } = Promise.withResolvers<void>();
	signal.addEventListener("abort", () => resolve(), { once: true });
	await Promise.race([warming, aborted]);
}

async function prefetch(env: BridgeEnv, params: unknown): Promise<{ prefetched: boolean; reason?: AutoModeReason }> {
	const message = typeof record(params).message === "string" ? (record(params).message as string) : "";
	try {
		const prepared = await prepare(env, message);
		if (prepared.skip) {
			prefetched.clear();
			return { prefetched: false, reason: prepared.skip };
		}
		const { session, previous, planAllowed } = prepared;
		await prefetched.run(message, async signal => {
			await warmed(signal);
			return ask(session, message, previous, planAllowed, signal);
		});
		return { prefetched: true };
	} catch (error) {
		env.pi.logger.debug("gui-bridge: auto mode prefetch failed", { error: errorMessage(error) });
		return { prefetched: false, reason: "error" };
	}
}

async function decide(env: BridgeEnv, params: unknown): Promise<AutoModeDecision> {
	const started = Date.now();
	const text = typeof record(params).message === "string" ? (record(params).message as string) : "";
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
	try {
		const prepared = await prepare(env, text);
		if (prepared.skip) return log(noDecision(prepared.skip));
		const { session, previous, planAllowed, goalAllowed } = prepared;
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(new Error(`auto mode timed out after ${AUTO_MODE_TIMEOUT_MS} ms`)),
			AUTO_MODE_TIMEOUT_MS,
		);
		let asked: Asked;
		try {
			// A prefetch of this text still in flight is joined, not asked again; its answer, or the cache it filled,
			// answers the question below. A warm-up still under way is joined too: its connection is reused.
			await prefetched.settle(text, controller.signal);
			await warmed(controller.signal);
			asked = await ask(session, text, previous, planAllowed, controller.signal);
		} catch (error) {
			if (controller.signal.aborted) return log(noDecision("timeout", Date.now() - started));
			throw error;
		} finally {
			clearTimeout(timer);
		}
		const latencyMs = Date.now() - started;
		const picked = modeFromAnswer(asked.answer, { plan: planAllowed, goal: goalAllowed });
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
	/**
	 * While the user types: asks the question the decision at Enter will ask for `{message}` (its answer is cached).
	 * Changes nothing; answers whether a request was made.
	 */
	"modes.auto_mode_prefetch": (params, env) => prefetch(env, params),
	/** The user undid an automatic decision: leave plan mode if it is the mode, and stop deciding for this session. */
	"modes.auto_mode_undo": async (params, env) => {
		const session = attach(env);
		markSuppressed(session.sessionManager.getSessionId());
		if (record(params).mode === "plan" && session.getPlanModeState()?.enabled) await exitPlanMode(session);
		return { suppressed: true };
	},
});
