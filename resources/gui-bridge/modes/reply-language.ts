/**
 * Reply language: the GUI resolves the user's setting (Settings › General;
 * default: the device language) and passes its English name in
 * `OMP_GUI_REPLY_LANGUAGE` at spawn (src/shared/reply-language.ts), then
 * `reply_language_set` whenever the setting changes, so open sessions follow
 * from their next turn without a restart. Stock omp has no such setting, so
 * the public `before_agent_start` hook appends one soft instruction to the
 * system prompt, every prompt, like modes/pool.ts.
 *
 * - No language, off or English: the hook returns nothing, so the prompt stays
 *   byte-identical to stock and the provider prompt cache is untouched.
 * - Not `--append-system-prompt`: that collides with the user's launch profile
 *   flag and turns off omp's fork prompt-cache key.
 * - The value is module state, read by the hook on every prompt. Subagents
 *   rebind this extension (task executor `preloadedPreparedExtensions`), which
 *   re-runs `install` in the same process and module instance, so their
 *   sessions get the same, current line. Their "user" is the parent agent,
 *   whose language wins by the instruction's own rule; any question they
 *   surface to the person follows the setting.
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

/** The instruction every hooked prompt gets; undefined = none. */
let instruction = replyLanguageInstruction(process.env.OMP_GUI_REPLY_LANGUAGE);

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ReplyLanguageHost): void {
	pi.on("before_agent_start", event => (instruction ? { systemPrompt: [...event.systemPrompt, instruction] } : undefined));
}

/**
 * `{language: string | null}`: the English language name, or null for none.
 * A non-language string (too long, control characters) is refused rather than
 * silently dropping the instruction.
 */
export function setReplyLanguage(params: unknown): { language: string | null } {
	const language = typeof params === "object" && params !== null && "language" in params ? params.language : undefined;
	if (language === null) {
		instruction = undefined;
		return { language: null };
	}
	if (typeof language !== "string") throw new Error("reply_language_set needs {language: string | null}");
	const name = language.trim();
	const next = replyLanguageInstruction(name);
	if (!next && name && name.toLowerCase() !== "english") throw new Error(`Not a language name: ${JSON.stringify(name.slice(0, 80))}`);
	instruction = next;
	return { language: name || null };
}

export const methods = {
	/** Main sends this to every live local sidecar when the setting changes, and on bridge connect. */
	reply_language_set: async (params: unknown) => setReplyLanguage(params),
};
