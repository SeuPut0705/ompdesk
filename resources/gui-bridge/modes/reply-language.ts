/**
 * Default reply language: the GUI resolves the device language at spawn and
 * passes its English name in `OMP_GUI_REPLY_LANGUAGE` (src/shared/reply-language.ts).
 * Stock omp has no such setting, so the public `before_agent_start` hook appends
 * one soft instruction to the system prompt, every prompt, like modes/pool.ts.
 *
 * - Missing env or English: no handler at all, so the prompt stays byte-identical
 *   to stock and the provider prompt cache is untouched.
 * - Not `--append-system-prompt`: that collides with the user's launch profile
 *   flag and turns off omp's fork prompt-cache key.
 * - Subagents rebind this extension (task executor `preloadedPreparedExtensions`),
 *   so their sessions get the same line. Their "user" is the parent agent, whose
 *   language wins by the instruction's own rule; any question they surface to
 *   the person follows the device language.
 *
 * No omp imports (not even types): the GUI's vitest installs it on a fake `pi`
 * (src/main/bridge-reply-language.test.ts).
 */

/** The slice of omp's ExtensionAPI this module needs. */
export interface ReplyLanguageHost {
	on(
		event: "before_agent_start",
		handler: (event: { systemPrompt: string[] }) => { systemPrompt: string[] } | undefined,
	): void;
}

/** Longer than any `Intl.DisplayNames` language name; anything bigger is not one. */
const MAX_LANGUAGE_NAME = 64;

/** The system-prompt line for `language`; undefined for missing, malformed or English. */
export function replyLanguageInstruction(language: string | undefined): string | undefined {
	const name = language?.trim() ?? "";
	if (!name || name.length > MAX_LANGUAGE_NAME || /\p{Cc}/u.test(name)) return undefined;
	if (name.toLowerCase() === "english") return undefined;
	return [
		"<reply-language>",
		`By default, write your replies, plans, summaries and questions to the user in ${name}. If the user writes in a different language, answer in the user's language instead. Keep code, identifiers, commit messages and file contents in whatever language the project already uses.`,
		"</reply-language>",
	].join("\n");
}

export function install(pi: ReplyLanguageHost, language = process.env.OMP_GUI_REPLY_LANGUAGE): void {
	const instruction = replyLanguageInstruction(language);
	if (!instruction) return;
	pi.on("before_agent_start", event => ({ systemPrompt: [...event.systemPrompt, instruction] }));
}

/** Hook-only area. */
export const methods = {};
