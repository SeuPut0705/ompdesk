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
 * "append if missing" rule the hook uses. A turn stock's restore continues
 * gets them the same way (`keepSectionsOnRestore`), since no prompt runs the hook.
 *
 * No omp imports (not even types): the GUI's vitest installs it on a fake `pi`.
 */
import { noteSlowSpot } from "./turn-stages-core";

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
	/** The session's working folder (stock's `ExtensionContext.cwd`). */
	cwd?: string;
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
		const started = performance.now();
		const instruction = section(ctx);
		if (ctx.agent.kind === "main") noteSlowSpot("sectionsMs", performance.now() - started);
		const next = appendIfMissing(event.systemPrompt, instruction);
		return next === event.systemPrompt ? undefined : { systemPrompt: [...next] };
	});
}

/** The prompt a turn of this session sends: `parts` plus every registered section that applies and is not already in it. */
export function withTurnSections(parts: readonly string[], ctx: PromptSectionContext): readonly string[] {
	let next = parts;
	for (const section of sections.values()) next = appendIfMissing(next, section(ctx));
	return next;
}

/** The slice of a stock `AgentSession` a turn its restore continues gets the sections through. */
interface RestoringSession {
	readonly baseSystemPrompt: string[];
	/** The prompt the agent holds now (stock's getter over `agent.state.systemPrompt`). */
	readonly systemPrompt: string[];
	readonly agent: { setSystemPrompt(prompt: string[]): void };
	readonly extensionRunner?: { createContext(): PromptSectionContext };
}

const RESTORE_WRAPPED = Symbol.for("ompdesk.prompt-sections.restoreInterruptedTurn");

/**
 * Wraps `restoreInterruptedTurn` on stock's `AgentSession` prototype once (the session and every subagent stock's
 * restore revives share the class), so the turn it continues sends the sections a prompt of that session would.
 * Stock runs `before_agent_start` for a prompt only: its restore goes on with `agent.continue()` over the base prompt
 * (a revived subagent's replay of the hook, `reason: "revive"`, is discarded), so on 27 Oct 2026 every revived
 * subagent's first request lacked them and its prompt prefix changed. The prompt is set on the agent before the
 * continue, from the session's own extension context; a restore that continues nothing keeps the prompt it had.
 */
export function keepSectionsOnRestore(proto: object): void {
	const target = proto as Record<string | symbol, unknown>;
	const restore = target.restoreInterruptedTurn;
	if (target[RESTORE_WRAPPED] || typeof restore !== "function") return;
	target[RESTORE_WRAPPED] = restore;
	target.restoreInterruptedTurn = async function restoreInterruptedTurn(this: RestoringSession): Promise<boolean> {
		const ctx = this.extensionRunner?.createContext();
		const base = this.baseSystemPrompt;
		const parts = ctx ? withTurnSections(base, ctx) : base;
		if (parts === base) return restore.call(this);
		const held = this.systemPrompt;
		this.agent.setSystemPrompt([...parts]);
		const continued: boolean = await restore.call(this);
		if (!continued) this.agent.setSystemPrompt(held);
		return continued;
	};
}
