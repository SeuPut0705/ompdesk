/**
 * The title line the reply-language section asks the main agent to put first in
 * every `task` assignment (`Title: <short sentence in the reply language>`).
 * Stock's task tool has no `description` field and its tiny-model label prompt
 * (`task/label.ts`) always yields an English sentence, so this line is the
 * person-visible title; the rest of the assignment stays as the model wrote it.
 *
 * Dependency-free: the bridge (reply-language.ts) and the renderer import it.
 */
export const ASSIGNMENT_TITLE_PREFIX = "Title:";

const TITLE_LINE = /^\s*Title:[ \t]*(\S[^\n]*?)[ \t]*(?:\n|$)/;
/** A title is one short sentence; anything longer is not a title line. */
const TITLE_MAX_CHARS = 120;

/** The assignment's own title line, or undefined when it has none. */
export function assignmentTitle(assignment: string | undefined): string | undefined {
	const title = assignment ? TITLE_LINE.exec(assignment)?.[1] : undefined;
	return title && title.length <= TITLE_MAX_CHARS ? title : undefined;
}

const TITLE_PREFIX = /^\s*Title:[ \t]*/i;

/** `text` without a leading `Title:` label (the label is a protocol line, never part of a name). */
export function stripTitlePrefix(text: string): string {
	return text.replace(TITLE_PREFIX, "");
}

/**
 * What a task message is about, for one line of a list: its `Title:` line, else its first non-empty line with any
 * `Title:` label removed (a title line longer than `TITLE_MAX_CHARS` is not a title line, but its words still are
 * the task). Undefined for an empty message.
 */
export function assignmentHeadline(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const title = assignmentTitle(text);
	if (title) return title;
	const first = text
		.split("\n")
		.map(line => stripTitlePrefix(line).trim())
		.find(line => line !== "");
	return first || undefined;
}

/**
 * Stock wraps every assignment in `prompts/system/subagent-user-prompt.md` ("Complete assignment thoroughly:" and a
 * blank line, then the assignment) to make a subagent's first user message, and reports that wrapped text as the
 * run's `task`. A later run of the same subagent (a follow-up message to an idle one, or the revival after a restart
 * that sends `session_init.task` again) reports its own message as `task` and NO `assignment`: a follow-up is plain
 * text, a revival is the wrapped original.
 */
const STOCK_PROMPT_WRAPPER = /^\s*Complete assignment thoroughly:[ \t]*\n+/;

/** The assignment inside stock's wrapped first message, or undefined when `task` is not that wrapped text. */
export function unwrapStockPrompt(task: string | undefined): string | undefined {
	const match = task ? STOCK_PROMPT_WRAPPER.exec(task) : null;
	return match && task ? task.slice(match[0].length) || undefined : undefined;
}
