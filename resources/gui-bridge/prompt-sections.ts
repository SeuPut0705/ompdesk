/**
 * OMPdesk's own per-turn system-prompt sections (reply language, profile,
 * reply style, visuals). Each one is appended through the public
 * `before_agent_start` hook, and stock keeps what that hook added only while a
 * turn runs (its per-turn override is dropped when the turn ends, and a rebuild
 * of the base prompt replaces it), so `session.systemPrompt` lacks them before
 * the first turn and again after a rebuild.
 * Every such mode registers its section here, which is how the context
 * inspector (context-inspect.ts) shows the sections the model really gets:
 * it applies the registered sections, in install order, with the same
 * "append if missing" rule the hook uses.
 *
 * No omp imports (not even types): the GUI's vitest installs it on a fake `pi`.
 */
/** One journal entry as a section reads it. */
export interface JournalEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

/** The slice of omp's extension context a section may read. */
export interface PromptSectionContext {
	sessionManager: { getBranch(): readonly JournalEntry[] };
	agent: { kind: string };
}

/** The instruction to append for this session, or undefined for none. */
export type PromptSection = (ctx: PromptSectionContext) => string | undefined;

/** The slice of omp's ExtensionAPI a section registers on. */
export interface PromptSectionHost {
	on(
		event: "before_agent_start",
		handler: (event: { systemPrompt: string[] }, ctx: PromptSectionContext) => { systemPrompt: string[] } | undefined,
	): void;
}

/** By id, in first-install order: a subagent rebinding re-runs `install` and replaces its own entry in place. */
const sections = new Map<string, PromptSection>();

/** `parts` with `instruction` appended; the same array when there is none or a part already carries it (stock or an omp whose own prompt has it). */
export function appendIfMissing(parts: readonly string[], instruction: string | undefined): readonly string[] {
	if (!instruction || parts.some(part => part.includes(instruction))) return parts;
	return [...parts, instruction];
}

/** Registers `section` under `id` and hooks it into every prompt. Called by each mode's `install`. */
export function registerPromptSection(host: PromptSectionHost, id: string, section: PromptSection): void {
	sections.set(id, section);
	host.on("before_agent_start", (event, ctx) => {
		const next = appendIfMissing(event.systemPrompt, section(ctx));
		return next === event.systemPrompt ? undefined : { systemPrompt: [...next] };
	});
}

/** The prompt a turn of this session sends: `parts` plus every registered section that applies and is not already in it. */
export function withTurnSections(parts: readonly string[], ctx: PromptSectionContext): readonly string[] {
	let next = parts;
	for (const section of sections.values()) next = appendIfMissing(next, section(ctx));
	return next;
}
