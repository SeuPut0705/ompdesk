/**
 * Judge-model assists: small decisions OMPdesk asks stock's judge (`judgment` `resolveJudge`, the `judge` role chain,
 * as auto mode does) only while that chain resolves first to a native decision model (`hasNativeJudge`: TypeSafe's Jev
 * through OpenRouter on a stock install). With a prompted fallback (Sonnet, a local model), no key, the switch off, an
 * error or a timeout, every feature keeps the code rule it had before: OMPdesk works fully without the judge and only
 * gets better with it. Dependency-free: main and the renderer import it.
 *
 * Kept after measurement on real data (numbers in AGENTS.md, "Judge-model assists"):
 * - Notification triage: a finished turn whose last reply waits for the person notifies as `ask` ("needs you").
 * - Decision signal for prompt suggestions: the same question feeds `awaitsDecision` (next-prompt-core.ts).
 * - Title check: an evolving title is applied only when the judge says it fits the recent work clearly better.
 * - Preview check: a visual the agent opened that renders an error or a blank page gets a notice and a tool hint.
 */

/** prefs key (electron-store `prefs`); default on: only a stored `false` turns it off. */
export const JUDGE_ASSIST_PREF = "judgeAssist";

/** Spawn env: `"0"` off, anything else (or unset) on. */
export const JUDGE_ASSIST_ENV = "OMP_GUI_JUDGE_ASSIST";

export function judgeAssistEnabled(pref: unknown): boolean {
	return pref !== false;
}

export function parseJudgeAssistEnv(raw: string | undefined): boolean {
	return raw !== "0";
}

/** One judgment waits at most this long; a later answer is dropped and the code rule decides. Measured p95 0.56 s. */
export const JUDGE_ASSIST_TIMEOUT_MS = 2000;

/**
 * Probability of "the reply waits for the person" from which a finished turn is a needs-you notification and the
 * suggestion engine treats a decision as pending. Measured on 60 real final replies (17 waiting): 0.7 caught 17/17
 * with 3 false alarms (95 %); 0.5 had 6 false alarms.
 */
export const NEEDS_USER_MIN = 0.7;

/** Preview check thresholds: 22 agent-made pages at 1000×700 were all classed right (error 7, blank 6, normal 9). */
export const PREVIEW_ERROR_MIN = 0.5;
export const PREVIEW_BLANK_MIN = 0.8;

export type PreviewProblem = "error" | "blank";

/** Bridge method names (modes/judge-assist.ts). */
export const JUDGE_ASSIST_SET = "judge_assist_set";
export const JUDGE_ASSIST_NEEDS_USER = "judge_assist.needs_user";
export const JUDGE_ASSIST_PREVIEW_CHECK = "judge_assist.preview_check";

/** `judge_assist.needs_user`: `null` when the judge did not decide (feature off, no native judge, error, timeout). */
export interface NeedsUserResult {
	needsUser: boolean | null;
}

/** `judge_assist.preview_check {image: {data, mimeType}}`: `judged` false when the judge did not decide. */
export interface PreviewCheckResult {
	problem: PreviewProblem | null;
	judged: boolean;
}
