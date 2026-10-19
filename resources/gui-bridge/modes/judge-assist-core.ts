/**
 * Pure rules of the judge-model assists (judge-assist-contracts.ts): the questions as measured, the state each one
 * reads, and how an answer becomes a decision. No stock import: the engine (judge-assist-engine.ts) asks stock's judge.
 * Every decision function returns `undefined` for an answer it cannot read, so the caller keeps its code rule.
 */
import { NEEDS_USER_MIN, PREVIEW_BLANK_MIN, PREVIEW_ERROR_MIN, type PreviewProblem } from "./judge-assist-contracts";

/** The reply's end is where it asks: the judge reads at most this much of it (the measurement used the same tail). */
export const REPLY_TAIL_CHARS = 1500;

export function replyTail(text: string): string {
	const trimmed = text.trim();
	return trimmed.length <= REPLY_TAIL_CHARS ? trimmed : `…${trimmed.slice(-REPLY_TAIL_CHARS)}`;
}

export const NEEDS_USER_QUESTION = {
	type: "noul",
	instructions:
		"Does this reply from a coding assistant end by waiting for the user: it asks them a question, asks them to choose or confirm before it goes on, or asks for information only they have? A report of finished work, a status update, or a plan the assistant is already carrying out does not count, even when it mentions what is left.",
	criteria: { true: "The user must answer or decide something", false: "Nothing waits on the user" },
} as const;

/** One request per reply text, so the notification and the suggestion engine share stock's answer cache. */
export function needsUserRequest(reply: string) {
	return { state: { reply: replyTail(reply) }, questions: { needs: NEEDS_USER_QUESTION } };
}

/** `value[key]` when `value` is an object holding it; stock's answers are read only through this. */
function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined;
}

function noul(answer: unknown): number | undefined {
	const value = field(answer, "noul");
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function needsUserFrom(answers: unknown): boolean | undefined {
	const p = noul(field(answers, "needs"));
	return p === undefined ? undefined : p >= NEEDS_USER_MIN;
}

/** Recent turns the title check reads: the last four exchanges, each side clipped as measured. */
export const TITLE_TURNS = 4;
const TITLE_TURN_CHARS = 300;

export interface TitleTurn {
	user: string;
	assistant: string;
}

export const TITLE_FIT_QUESTION = {
	type: "choice",
	instructions:
		"Which title describes the work in the recent turns better? Pick same when both fit about equally well or both miss.",
	criteria: {
		A: "titleA fits clearly better",
		B: "titleB fits clearly better",
		same: "About the same",
	},
} as const;

export function titleFitRequest(current: string, next: string, turns: readonly TitleTurn[]) {
	return {
		state: {
			recentTurns: turns.slice(-TITLE_TURNS).map(turn => ({
				user: turn.user.slice(-TITLE_TURN_CHARS),
				assistant: turn.assistant.slice(0, TITLE_TURN_CHARS),
			})),
			titleA: current,
			titleB: next,
		},
		questions: { better: TITLE_FIT_QUESTION },
	};
}

/** Apply the new title only when the judge picked it (B); "same" or the old one keeps the current title. */
export function newTitleFitsFrom(answers: unknown): boolean | undefined {
	const choice = field(field(answers, "better"), "choice");
	return choice === "A" || choice === "B" || choice === "same" ? choice === "B" : undefined;
}

/** The preview questions, worded as in the UI-QA bench that measured them (error 100 %, empty 98 % at 0.8). */
export const PREVIEW_QUESTIONS = {
	error: {
		type: "noul",
		instructions:
			"Does this app screenshot show an error state: a crash message, a failure banner, or a red error notice saying the app, a panel, a form or a connection failed? Log lines or chat text that merely contain the word ERROR do not count.",
		criteria: { true: "An error message from the app is visible", false: "No app error message is visible" },
	},
	empty: {
		type: "noul",
		instructions:
			"Is the screen's main content area mostly empty: only an empty-state message, an error, a spinner, or a blank surface, with no real content?",
	},
} as const;

export const PREVIEW_STATE = {
	app: "a page a coding agent made and opened in a preview",
	task: "check that the page rendered",
} as const;

export function previewProblemFrom(answers: unknown): PreviewProblem | null | undefined {
	const error = noul(field(answers, "error"));
	const empty = noul(field(answers, "empty"));
	if (error === undefined || empty === undefined) return undefined;
	if (error >= PREVIEW_ERROR_MIN) return "error";
	return empty >= PREVIEW_BLANK_MIN ? "blank" : null;
}

/** Memory recall: the prompt and each snippet are clipped so one judgment stays a few hundred tokens. */
const RECALL_PROMPT_CHARS = 1500;
const RECALL_SNIPPET_CHARS = 600;

export interface RecallSnippet {
	title: string;
	kind: string;
	text: string;
}

function recallQuestion(id: string) {
	return {
		type: "noul",
		instructions: `Snippet ${id} in state.snippets comes from this person's earlier work with a coding assistant. Does it hold a prior decision, result or fact the assistant needs to answer state.prompt well? A snippet that only shares words with the prompt, or is about other work, does not count.`,
		criteria: { true: "The assistant needs this snippet for the prompt", false: "Not needed for this prompt" },
	} as const;
}

/** One judgment for all candidates of a prompt: one `noul` question per snippet, keyed `s0`, `s1`, …. */
export function recallRequest(prompt: string, snippets: readonly RecallSnippet[]) {
	const ids = snippets.map((_, index) => `s${index}`);
	return {
		state: {
			prompt: prompt.trim().slice(0, RECALL_PROMPT_CHARS),
			snippets: Object.fromEntries(
				snippets.map((snippet, index) => [
					ids[index],
					{ title: snippet.title, kind: snippet.kind, text: snippet.text.slice(0, RECALL_SNIPPET_CHARS) },
				]),
			),
		},
		questions: Object.fromEntries(ids.map(id => [id, recallQuestion(id)])),
	};
}

/** The probability per snippet, in order; undefined when the judge answered none of them. */
export function recallRelevanceFrom(answers: unknown, count: number): (number | undefined)[] | undefined {
	const probabilities = Array.from({ length: count }, (_, index) => noul(field(answers, `s${index}`)));
	return probabilities.some(p => p !== undefined) ? probabilities : undefined;
}
