/**
 * The pure half of modes/visuals.ts: cut stock's Visuals section out of
 * `system/system-prompt.md` and render it for the current settings. No omp
 * imports (not even types), so the GUI's vitest and a Bun script against the
 * installed omp both exercise it (src/main/bridge-visuals.test.ts).
 */

const SECTION_OPEN = "{{#ifAny renderMermaid renderSvg autoGraph}}";
const SECTION_CLOSE = "{{/ifAny}}";

/** Stock's Visuals section (its `{{#ifAny …}}` block) cut out of the system prompt template. */
export function visualsTemplate(systemPromptTemplate: string): string {
	const start = systemPromptTemplate.indexOf(SECTION_OPEN);
	const end = start === -1 ? -1 : systemPromptTemplate.indexOf(SECTION_CLOSE, start);
	if (end === -1) throw new Error("system/system-prompt.md has no Visuals section");
	return systemPromptTemplate.slice(start, end + SECTION_CLOSE.length);
}

/** The two Settings switches stock reads for the section (`tui.renderMermaid`, `tui.renderSvg`). */
export interface VisualsFlags {
	renderMermaid: boolean;
	renderSvg: boolean;
}

/** Stock's template renderer (`prompt.render` from `@oh-my-pi/pi-utils`). */
export type PromptRender = (template: string, context: Record<string, unknown>) => string;

/**
 * The section for `flags`; undefined when it renders empty. `autoGraph` stays
 * off: OMPdesk draws no chart under numeric tables, and the section would tell
 * the model the UI does.
 */
export function visualsInstruction(render: PromptRender, template: string, flags: VisualsFlags): string | undefined {
	const text = render(template, { ...flags, autoGraph: false }).trim();
	return text || undefined;
}

/** `systemPrompt` with the instruction appended, or undefined when there is none or stock already carries it. */
export function withVisuals(systemPrompt: readonly string[], instruction: string | undefined): string[] | undefined {
	if (!instruction || systemPrompt.some(part => part.includes(instruction))) return undefined;
	return [...systemPrompt, instruction];
}
