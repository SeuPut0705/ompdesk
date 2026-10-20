/**
 * Rules of the automatic mode choice, dependency-free so the renderer, main and the bridge share them
 * (contracts in auto-mode-contracts.ts, behaviour in modes/auto-mode.ts).
 */
import {
	AUTO_MODE_IDLE_MS,
	type AutoModeActive,
	type AutoModeDecision,
	type AutoModeKind,
	type AutoModeReason,
} from "./auto-mode-contracts";

/** Under this many characters a message is chat ("ok", "thanks", "why?"): no model is asked. */
export const MIN_CLASSIFIED_CHARS = 12;
/** A model answer below this probability counts as ambiguous. */
export const MIN_PROBABILITY = 0.6;
/**
 * Plan takes over the whole next turn, so it needs a surer answer than Goal (and a stated probability). 0.7 measured
 * on Jev and Sonnet: no plan choice on a none- or goal-labelled prompt (bridge-auto-mode-core.test.ts).
 */
export const MIN_PLAN_PROBABILITY = 0.7;
/** Longest goal objective (characters). */
export const OBJECTIVE_MAX_CHARS = 300;
/** Longest excerpt of the previous exchange the judge sees (characters, each side). */
export const PREVIOUS_MAX_CHARS = 400;

/** What the session is doing, read from the live session by the bridge. */
export interface AutoModeWork {
	now: number;
	/** When the session's last message landed (any role); undefined for a session with none. */
	lastActivityAt?: number;
	/** Todo tasks still pending or in progress. */
	openTodos: number;
	/** Subagents and background jobs of the main agent running right now. */
	runningJobs: number;
}

export interface AutoModeGuardInput {
	text: string;
	enabled: boolean;
	/** A turn runs (the message would steer or queue). */
	streaming: boolean;
	active: AutoModeActive;
	/** The user undid an automatic decision in this session. */
	suppressed: boolean;
	/** The session's work; the renderer's early check has none, the bridge always passes it. */
	work?: AutoModeWork;
}

/** Whether the session is in the middle of work: anything running or open, or a turn within AUTO_MODE_IDLE_MS. */
export function sessionBusy(work: AutoModeWork): boolean {
	if (work.runningJobs > 0 || work.openTodos > 0) return true;
	return work.lastActivityAt !== undefined && work.now - work.lastActivityAt < AUTO_MODE_IDLE_MS;
}

/** The reason a prompt is never classified, or null when it may be. Pure and free: no model is called. */
export function autoModeSkip(input: AutoModeGuardInput): AutoModeReason | null {
	if (!input.enabled) return "off";
	if (input.suppressed) return "suppressed";
	if (input.streaming) return "streaming";
	const text = input.text.trim();
	if (!text) return "empty";
	if (text.startsWith("/")) return "slash";
	if (text.startsWith("!")) return "bash";
	const { plan, goal } = input.active;
	if (plan || goal) return "mode_active";
	if ([...text].length < MIN_CLASSIFIED_CHARS) return "short";
	if (input.work && sessionBusy(input.work)) return "busy";
	return null;
}

/**
 * The one question the model answers. Shaped as stock's `ChoiceQuestion` (`judgeQuestions` output): a choice over
 * the criteria's keys. Plan is only offered while the session may enter it again. The state carries the message
 * (`request`) and, when the session has one, the previous exchange (`previous`), so a follow-up or a correction of
 * earlier work can be told apart from new work.
 */
export const AUTO_MODE_INSTRUCTIONS =
	"The state is a user's message to a coding agent (request) and, when there is one, the exchange before it (previous). Decide whether the message starts new work that a special working mode helps with. A mode is used for this one request only. Choose none when unsure, and always none when the message continues, follows up on, answers or corrects the previous work.\n\nExamples:\n<request>why does the build fail on CI?</request>\nnone\n\n<request>rename the variable foo to count in utils.ts</request>\nnone\n\n<previous>assistant: I moved the settings store to zustand.</previous><request>now refactor the remaining modules the same way across all files</request>\nnone\n\n<request>migrate the whole app from REST to GraphQL across all services</request>\nplan\n\n<request>keep going until all the tests pass</request>\ngoal";

export function autoModeCriteria(
	planAllowed: boolean,
): Record<AutoModeKind | "none", string> | Record<"goal" | "none", string> {
	const criteria = {
		none: "A question, an explanation, chat, a small, clear, local edit that needs no plan, or anything that continues or corrects the previous work.",
		goal: "New work with a completion condition (until the tests pass, keep going until X) or long-running work the agent should drive on its own.",
	};
	if (!planAllowed) return criteria;
	return {
		plan: "New, large or risky work across several files: a refactor, migration, or new feature where reviewing a plan before any edit helps.",
		...criteria,
	};
}

/** The previous exchange for the judge's state: the last user message and the reply to it, each clipped. */
export function previousExchange(user: string | undefined, assistant: string | undefined): string | undefined {
	const clip = (text: string) => {
		const folded = text.replace(/\s+/g, " ").trim();
		const chars = [...folded];
		return chars.length <= PREVIOUS_MAX_CHARS ? folded : `${chars.slice(0, PREVIOUS_MAX_CHARS - 1).join("")}…`;
	};
	const lines = [
		...(user?.trim() ? [`user: ${clip(user)}`] : []),
		...(assistant?.trim() ? [`assistant: ${clip(assistant)}`] : []),
	];
	return lines.length > 0 ? lines.join("\n") : undefined;
}

/** A judge's choice answer as far as this module reads it (stock `ChoiceAnswer`). */
export interface ChoiceAnswerLike {
	choice?: unknown;
	probabilities?: unknown;
}

/** One model answer → a mode, or why none. Unknown, mis-typed or low-probability answers are none. */
export function modeFromAnswer(
	answer: ChoiceAnswerLike | null | undefined,
	allowed: { plan: boolean; goal: boolean },
): { mode: AutoModeKind | "none"; reason?: AutoModeReason } {
	const choice = typeof answer?.choice === "string" ? answer.choice.trim().toLowerCase() : "";
	if (choice === "none") return { mode: "none", reason: "classified_none" };
	if (choice !== "plan" && choice !== "goal") return { mode: "none", reason: "ambiguous" };
	if (!allowed[choice]) return { mode: "none", reason: choice === "plan" ? "plan_rejected" : "unavailable" };
	const probabilities = answer?.probabilities;
	const value =
		typeof probabilities === "object" && probabilities !== null
			? (probabilities as Record<string, unknown>)[choice]
			: undefined;
	if (choice === "plan" && (typeof value !== "number" || value < MIN_PLAN_PROBABILITY)) {
		return { mode: "none", reason: "ambiguous" };
	}
	if (typeof value === "number" && value < MIN_PROBABILITY) return { mode: "none", reason: "ambiguous" };
	return { mode: choice };
}

/** The objective for stock's `goal create`: the message's text, whitespace folded and cut. */
export function goalObjective(text: string): string {
	const folded = text.replace(/\s+/g, " ").trim();
	const chars = [...folded];
	return chars.length <= OBJECTIVE_MAX_CHARS
		? folded
		: `${chars
				.slice(0, OBJECTIVE_MAX_CHARS - 1)
				.join("")
				.trimEnd()}…`;
}

export function noDecision(reason: AutoModeReason, latencyMs = 0, model?: string): AutoModeDecision {
	return { mode: "none", reason, latencyMs, ...(model ? { model } : {}) };
}

/** The fixed request the once-per-session warm-up asks about (never cached, never journaled). */
export const AUTO_MODE_WARM_REQUEST = "warm up";
/** The warm-up gives up after this long; it holds nothing up, so it may take longer than a decision. */
export const AUTO_MODE_WARM_TIMEOUT_MS = 10_000;

/**
 * The one question asked while the user types. A new text withdraws the question still asked about an older one;
 * the same text joins it. The decision at Enter waits (`settle`) for a question about its own text, never for another.
 */
export class PrefetchSlot<T> {
	#current: { key: string; promise: Promise<T>; controller: AbortController } | undefined;

	run(key: string, ask: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.#current?.key === key) return this.#current.promise;
		this.clear();
		const controller = new AbortController();
		const promise = ask(controller.signal);
		const entry = { key, promise, controller };
		this.#current = entry;
		const done = () => {
			if (this.#current === entry) this.#current = undefined;
		};
		promise.then(done, done);
		return promise;
	}

	/** Resolves once the question about `key` still asked has settled (either way), at once when there is none. */
	async settle(key: string, signal?: AbortSignal): Promise<void> {
		const current = this.#current;
		if (current?.key !== key) return;
		const { promise: aborted, resolve } = Promise.withResolvers<void>();
		signal?.addEventListener("abort", () => resolve(), { once: true });
		await Promise.race([
			current.promise.then(
				() => undefined,
				() => undefined,
			),
			aborted,
		]);
	}

	/** Withdraw the question still asked. */
	clear(): void {
		this.#current?.controller.abort(new Error("auto mode prefetch superseded"));
		this.#current = undefined;
	}
}
