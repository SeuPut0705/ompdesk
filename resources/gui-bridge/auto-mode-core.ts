/**
 * Rules of the automatic mode choice, dependency-free so the renderer, main and the bridge share them
 * (contracts in auto-mode-contracts.ts, behaviour in modes/auto-mode.ts).
 */
import type { AutoModeActive, AutoModeDecision, AutoModeKind, AutoModeReason } from "./auto-mode-contracts";

/** Under this many characters a message is chat ("ok", "thanks", "why?"): no model is asked. */
export const MIN_CLASSIFIED_CHARS = 12;
/** A model answer below this probability counts as ambiguous. */
export const MIN_PROBABILITY = 0.6;
/** Longest goal objective (characters). */
export const OBJECTIVE_MAX_CHARS = 300;

export interface AutoModeGuardInput {
	text: string;
	enabled: boolean;
	/** A turn runs (the message would steer or queue). */
	streaming: boolean;
	active: AutoModeActive;
	/** The user undid an automatic decision in this session. */
	suppressed: boolean;
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
	const { plan, goal, loop, vibe } = input.active;
	if (plan || goal || loop || vibe) return "mode_active";
	if ([...text].length < MIN_CLASSIFIED_CHARS) return "short";
	return null;
}

/**
 * The one question the model answers. Shaped as stock's `ChoiceQuestion` (`judgeQuestions` output): a choice over
 * the criteria's keys. Plan is only offered while the session may enter it again.
 */
export const AUTO_MODE_INSTRUCTIONS =
	"The state is a user's message to a coding agent that is about to start work. Decide whether a special working mode helps. Choose none when unsure.\n\nExamples:\n<request>why does the build fail on CI?</request>\nnone\n\n<request>rename the variable foo to count in utils.ts</request>\nnone\n\n<request>migrate the whole app from REST to GraphQL across all services</request>\nplan\n\n<request>keep going until all the tests pass</request>\ngoal";

export function autoModeCriteria(
	planAllowed: boolean,
): Record<AutoModeKind | "none", string> | Record<"goal" | "none", string> {
	const criteria = {
		none: "A question, an explanation, chat, or a small, clear, local edit that needs no plan.",
		goal: "An objective with a completion condition (until the tests pass, keep going until X) or long-running work the agent should drive on its own.",
	};
	if (!planAllowed) return criteria;
	return {
		plan: "A large or risky change across several files: a refactor, migration, or new feature where reviewing a plan before any edit helps.",
		...criteria,
	};
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
	if (typeof probabilities === "object" && probabilities !== null) {
		const value = (probabilities as Record<string, unknown>)[choice];
		if (typeof value === "number" && value < MIN_PROBABILITY) return { mode: "none", reason: "ambiguous" };
	}
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
