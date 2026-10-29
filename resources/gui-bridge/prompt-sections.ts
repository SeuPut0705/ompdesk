/**
 * OMPdesk's own per-turn system-prompt sections (reply language, profile, reply style, visuals, pstack, ECC, the
 * checkout and Autopilot rules, …). Stock keeps what `before_agent_start` added only while a turn runs (its per-turn
 * override is dropped when the turn ends, and a rebuild of the base prompt replaces it), so `session.systemPrompt`
 * lacks them before the first turn and again after a rebuild.
 *
 * Every mode registers its section here, and one function, `withTurnSections`, applies them all, in install order,
 * with one "append if missing" rule, for every way a turn's prompt is built: a prompt (the one `before_agent_start`
 * hook each session's extension gets), a turn stock's restore continues (`keepSectionsOnRestore`, no prompt runs the
 * hook there) and the context inspector (context-inspect.ts). The sections read the session through stock's own
 * extension context (`sectionContext`), the one a prompt's hook gets. On 27 Oct 2026 a restored turn built its prompt
 * another way than a prompt did, and every revived subagent lost the sections and its prompt cache.
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

/** The instruction to append for this session, or undefined for none. `prompt` is the request this turn starts with (a person's text or a subagent's assignment); absent for the inspector and a restored turn. */
export type PromptSection = (ctx: PromptSectionContext, prompt?: string) => string | undefined;

/** A session whose sections are read: stock's `AgentSession` (its extension context, else its own journal). */
export interface SectionSession {
	readonly sessionManager: PromptSectionContext["sessionManager"];
	readonly extensionRunner?: { createContext(): PromptSectionContext };
}

/** The slice of omp's ExtensionAPI a section registers on. */
export interface PromptSectionHost {
	on(
		event: "before_agent_start",
		handler: (
			event: { systemPrompt: string[]; prompt?: string },
			ctx: PromptSectionContext,
		) => { systemPrompt: string[] } | undefined,
	): void;
}

/** By id, in first-install order: a subagent rebinding re-runs `install` and replaces its own entry in place. */
const sections = new Map<string, PromptSection>();
/** The hosts (each session's extension `pi`) the one `before_agent_start` hook is on. */
const hooked = new WeakSet<PromptSectionHost>();

/** `parts` with `instruction` appended; the same array when there is none or a part already carries it (stock or an omp whose own prompt has it). */
export function appendIfMissing(parts: readonly string[], instruction: string | undefined): readonly string[] {
	if (!instruction || parts.some(part => part.includes(instruction))) return parts;
	return [...parts, instruction];
}

/** Registers `section` under `id`, and the hook that applies every section to `host`'s prompts. Called by each mode's `install`. */
export function registerPromptSection(host: PromptSectionHost, id: string, section: PromptSection): void {
	sections.set(id, section);
	if (hooked.has(host)) return;
	hooked.add(host);
	host.on("before_agent_start", (event, ctx) => {
		const started = performance.now();
		const next = withTurnSections(
			event.systemPrompt,
			ctx,
			typeof event.prompt === "string" ? event.prompt : undefined,
		);
		if (ctx.agent.kind === "main") noteSlowSpot("sectionsMs", performance.now() - started);
		return next === event.systemPrompt ? undefined : { systemPrompt: [...next] };
	});
}

/**
 * The prompt a turn of this session sends: `parts` plus every registered section that applies and is not already in
 * it. A section that throws is left out of this turn, as stock leaves out a failing handler's result.
 */
export function withTurnSections(
	parts: readonly string[],
	ctx: PromptSectionContext,
	prompt?: string,
): readonly string[] {
	let next = parts;
	for (const section of sections.values()) {
		let instruction: string | undefined;
		try {
			instruction = section(ctx, prompt);
		} catch {
			instruction = undefined;
		}
		next = appendIfMissing(next, instruction);
	}
	return next;
}

/** What `session`'s sections read: stock's extension context (its folder, its agent), the one a prompt's hook gets. */
export function sectionContext(session: SectionSession): PromptSectionContext {
	return (
		session.extensionRunner?.createContext() ?? { sessionManager: session.sessionManager, agent: { kind: "main" } }
	);
}

/** The slice of a stock `AgentSession` a turn its restore continues gets the sections through. */
interface RestoringSession extends SectionSession {
	readonly baseSystemPrompt: string[];
	/** The prompt the agent holds now (stock's getter over `agent.state.systemPrompt`). */
	readonly systemPrompt: string[];
	readonly agent: { setSystemPrompt(prompt: string[]): void };
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
		const base = this.baseSystemPrompt;
		const parts = withTurnSections(base, sectionContext(this));
		if (parts === base) return restore.call(this);
		const held = this.systemPrompt;
		this.agent.setSystemPrompt([...parts]);
		const continued: boolean = await restore.call(this);
		if (!continued) this.agent.setSystemPrompt(held);
		return continued;
	};
}
