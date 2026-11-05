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

export const REPLY_PRESENTATION_SECTION_ID = "reply-presentation";

/**
 * How a reply shows a visual result. OMPdesk renders a reply's Markdown, a local picture included (markdown.tsx reads
 * `![…](/abs/path.png)` through fs.readImage, a paired device's and the phone's view through the host), but nothing told
 * the agent: asked to show a changed look, it described the screenshots and left them as small tool-card thumbnails
 * (owner, 5 Nov 2026; this machine's 283 longer replies named a picture's path 21 times and embedded one once). A
 * paragraph of pictures only renders as a figure row (`FigureRow`): side by side, alt text as caption.
 * Static text: the prompt cache holds across turns.
 */
export const REPLY_PRESENTATION_SECTION = `<reply-presentation>
The person reads your reply rendered as Markdown. A visual result (a screenshot, a page, a generated image, a before/after) goes in the reply itself as \`![caption](/absolute/path.png)\`, never only described or named by path. Pictures on consecutive lines of one paragraph show side by side, each large with its alt text as caption: a before/after is \`![Before: …](…)\` then \`![After: …](…)\` on the next line; several screenshots form a gallery the same way. Prose adds only what the pictures do not show.
</reply-presentation>`;
