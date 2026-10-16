/**
 * Output style: how long and how structured the agent's replies are. The GUI
 * keeps the choice in prefs `outputStyle` and sends `output_style_set` to a
 * tab's bridge when the tab's session is ready and whenever the choice
 * changes (src/renderer/hooks/use-output-style.ts). Stock omp has no such
 * setting, so the public `before_agent_start` hook appends one instruction to
 * the system prompt from the next turn, like modes/reply-language.ts.
 *
 * - `default`: the hook returns nothing; the prompt stays byte-identical to
 *   stock and the provider prompt cache is untouched.
 * - Module state, read by the hook on every prompt; subagents rebind this
 *   extension in the same module instance and follow too.
 *
 * Contracts live in output-style-contracts.ts (no omp imports) so the renderer
 * lists the same styles.
 */

import { type PromptSectionHost, registerPromptSection } from "../prompt-sections";
import { OUTPUT_STYLE_IDS, type OutputStyleId, outputStyleInstruction } from "./output-style-contracts";

/** The slice of omp's ExtensionAPI this module needs. */
export type OutputStyleHost = PromptSectionHost;

let style: OutputStyleId = "default";

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: OutputStyleHost): void {
	registerPromptSection(pi, "output-style", () => outputStyleInstruction(style));
}

/** `{style}`: one of {@link OUTPUT_STYLE_IDS}; anything else is refused. */
export function setOutputStyle(params: unknown): { style: OutputStyleId } {
	const next = typeof params === "object" && params !== null && "style" in params ? params.style : undefined;
	if (typeof next !== "string" || !(OUTPUT_STYLE_IDS as readonly string[]).includes(next))
		throw new Error(`output_style_set needs {style: ${OUTPUT_STYLE_IDS.join(" | ")}}`);
	style = next as OutputStyleId;
	return { style };
}

export const methods = {
	output_style_set: async (params: unknown) => setOutputStyle(params),
	output_style_get: async () => ({ style }),
};
