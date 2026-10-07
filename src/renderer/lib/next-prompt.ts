import { sanitizeToolText } from "./format";

/**
 * The `next-prompt` omp extension (~/.omp/agent/extensions/next-prompt.ts)
 * publishes its predicted next message as a `belowEditor` widget whose single
 * line is `\x1b[2m↹ Tab  <text>\x1b[22m`, and accepts it on Tab via
 * `onTerminalInput` — which never fires over RPC. The composer therefore
 * consumes this widget itself: shown as the textarea's gray placeholder, Tab
 * on an empty composer fills it in.
 */
export const NEXT_PROMPT_WIDGET = "next-prompt";

const TAB_HINT = /^↹\s*Tab\s+/;

/** Suggestion text from the widget lines, or undefined when absent/empty. */
export function parseNextPrompt(lines: readonly string[] | undefined): string | undefined {
	const line = lines?.[0];
	if (line === undefined) return undefined;
	const text = sanitizeToolText(line).replace(TAB_HINT, "").trim();
	return text === "" ? undefined : text;
}
