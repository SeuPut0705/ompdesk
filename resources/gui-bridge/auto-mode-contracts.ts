/**
 * Dependency-free contracts of the automatic mode choice (Plan or Goal, never anything else), shared by main, the
 * renderer and the packaged bridge (modes/auto-mode.ts, rules in auto-mode-core.ts).
 *
 * Stock omp has no prompt classifier for modes: `plan.defaultOnStartup` enters plan mode unconditionally at a new
 * session, and `auto-thinking/classifier.ts` only picks a thinking effort. The bridge reuses the machinery of the
 * latter (stock `judgment`: `resolveJudge` over the `judge` role chain, which starts with the `tiny` and `smol`
 * roles) to ask one three-way question about the prompt.
 */

/** prefs key (electron-store `prefs`); default on, only `false` turns it off. */
export const AUTO_MODE_PREF = "autoMode";

/** A decision that is not made within this many milliseconds is "none": the prompt never waits longer. */
export const AUTO_MODE_TIMEOUT_MS = 1500;

/** The only two modes the app ever enables by itself. Loop, Vibe and the other manual modes stay manual. */
export type AutoModeKind = "plan" | "goal";

/** Why a prompt got no automatic mode (debug log and tests; the UI shows nothing for these). */
export type AutoModeReason =
	| "off"
	| "empty"
	| "short"
	| "slash"
	| "bash"
	| "streaming"
	| "mode_active"
	| "plan_rejected"
	| "suppressed"
	| "unavailable"
	| "timeout"
	| "error"
	| "ambiguous"
	| "classified_none";

export interface AutoModeDecision {
	mode: AutoModeKind | "none";
	/** Goal only: the objective for stock's `goal create`, derived from the prompt. */
	objective?: string;
	/** Set when `mode` is "none". */
	reason?: AutoModeReason;
	/** Milliseconds the decision took (0 when no model was asked). */
	latencyMs: number;
	/** `provider/model` that answered, when a model was asked. */
	model?: string;
	/** What the judge request used (input counts cached tokens), when a model answered. */
	tokens?: { input: number; output: number };
	/** The request's price in USD as stock's catalog computes it, when known. */
	costUsd?: number;
}

/** The session modes the composer shows as active; any of them is a mode the user picked. */
export interface AutoModeActive {
	plan: boolean;
	goal: boolean;
	loop: boolean;
	vibe: boolean;
}

/** The stored pref (anything not a boolean reads as the default, on) → whether the choice runs. */
export function autoModeFromPref(value: unknown): boolean {
	return value !== false;
}
