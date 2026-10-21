/**
 * Reply language: the GUI resolves the user's setting (Settings › General;
 * default: the device language) and passes its English name in
 * `OMP_GUI_REPLY_LANGUAGE` at spawn (src/shared/reply-language.ts), then
 * `reply_language_set` whenever the setting changes, so open sessions follow
 * from their next turn without a restart. Stock omp has no such setting, so
 * the public `before_agent_start` hook appends one soft instruction to the
 * system prompt, every prompt.
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
 * Session titles follow the same language (auto-title-engine.ts reads
 * {@link currentReplyLanguage} and hears {@link onReplyLanguageChange}). So do
 * the labels a person sees in the interface (the section's second line). Stock's
 * task tool has no `description` field and its tiny-model label of the
 * assignment (`generateTaskLabel`, task/label.ts, a module-constant prompt
 * nothing can extend) is always English, so the agent writes a `Title:` first
 * line (subagent-title-contracts.ts) that the GUI shows instead; thinking and
 * the rest of the assignment stay as written.
 *
 * No omp imports (not even types): the GUI's vitest installs it on a fake `pi`
 * (src/main/bridge-reply-language.test.ts).
 */

import { type PromptSectionHost, registerPromptSection } from "../prompt-sections";
import { ASSIGNMENT_TITLE_PREFIX } from "./subagent-title-contracts";

/** The slice of omp's ExtensionAPI this module needs. */
export type ReplyLanguageHost = PromptSectionHost;

/** Longer than any `Intl.DisplayNames` language name; anything bigger is not one. */
const MAX_LANGUAGE_NAME = 64;

/** Could `name` (trimmed) be a language name: non-empty, short, no control characters. */
function isLanguageName(name: string): boolean {
	return name.length > 0 && name.length <= MAX_LANGUAGE_NAME && !/\p{Cc}/u.test(name);
}

/** The language OMPdesk steers toward; undefined for missing, malformed or English (stock's own language). */
export function steeredReplyLanguage(language: string | undefined): string | undefined {
	const name = language?.trim() ?? "";
	if (!isLanguageName(name) || name.toLowerCase() === "english") return undefined;
	return name;
}

/** The system-prompt line for `language`; undefined for missing, malformed or English. */
export function replyLanguageInstruction(language: string | undefined): string | undefined {
	const name = steeredReplyLanguage(language);
	if (!name) return undefined;
	return [
		"<reply-language>",
		`By default, write your replies, plans, summaries and questions to the user in ${name}. If the user writes in a different language, answer in the user's language instead. Keep code, identifiers, commit messages and file contents in whatever language the project already uses.`,
		`Only the labels a person sees in the interface follow that language: todo items and phase names, and the first line of each task assignment, written as "${ASSIGNMENT_TITLE_PREFIX} <a short ${name} sentence>" (the interface shows it as the subagent's title; the rest of the assignment stays as you would write it), and in an Autopilot run the \`title\`, \`summary\` and \`followups\` you give the autopilot tool (its timeline shows them). Your thinking, the rest of every assignment and prompt, tool arguments, code, identifiers and file contents stay as they are.`,
		"</reply-language>",
	].join("\n");
}

/** The current language (see {@link steeredReplyLanguage}); undefined = none. */
let language = steeredReplyLanguage(process.env.OMP_GUI_REPLY_LANGUAGE);
/** The instruction every hooked prompt gets; undefined = none. */
let instruction = replyLanguageInstruction(language);

type ReplyLanguageListener = () => void | Promise<void>;
const listeners = new Set<ReplyLanguageListener>();

/** The language OMPdesk steers toward right now; undefined when off, unset or English. */
export function currentReplyLanguage(): string | undefined {
	return language;
}

/** `listener` runs after every `reply_language_set`; the method waits for it. */
export function onReplyLanguageChange(listener: ReplyLanguageListener): void {
	listeners.add(listener);
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ReplyLanguageHost): void {
	registerPromptSection(pi, "reply-language", () => instruction);
}

/**
 * `{language: string | null}`: the English language name, or null for none.
 * A non-language string (too long, control characters) is refused rather than
 * silently dropping the instruction.
 */
export function setReplyLanguage(params: unknown): { language: string | null } {
	const value = typeof params === "object" && params !== null && "language" in params ? params.language : undefined;
	if (value === null) {
		language = undefined;
		instruction = undefined;
		return { language: null };
	}
	if (typeof value !== "string") throw new Error("reply_language_set needs {language: string | null}");
	const name = value.trim();
	if (name && !isLanguageName(name)) throw new Error(`Not a language name: ${JSON.stringify(name.slice(0, 80))}`);
	language = steeredReplyLanguage(name);
	instruction = replyLanguageInstruction(language);
	return { language: name || null };
}

export const methods = {
	/** Main sends this to every live local sidecar when the setting changes, and on bridge connect. */
	reply_language_set: async (params: unknown) => {
		const result = setReplyLanguage(params);
		for (const listener of listeners) await listener();
		return result;
	},
};
