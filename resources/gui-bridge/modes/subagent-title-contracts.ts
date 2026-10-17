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
