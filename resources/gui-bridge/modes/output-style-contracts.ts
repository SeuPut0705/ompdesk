/**
 * Output styles the GUI offers, shared by the bridge (which appends the
 * instruction) and the renderer (which lists them). Dependency-free: it ships
 * in the packaged bridge and is imported by renderer code.
 */
export const OUTPUT_STYLE_IDS = ["default", "concise", "detailed", "minimal"] as const;
export type OutputStyleId = (typeof OUTPUT_STYLE_IDS)[number];

export function isOutputStyleId(value: unknown): value is OutputStyleId {
	return typeof value === "string" && (OUTPUT_STYLE_IDS as readonly string[]).includes(value);
}

const INSTRUCTIONS: Record<Exclude<OutputStyleId, "default">, string> = {
	concise:
		"Keep replies short. Lead with the answer or the result, give the reason and the key evidence in a few sentences, and leave out background, alternatives and examples unless asked.",
	detailed:
		"Give thorough replies. After the answer, explain the reasoning step by step, show the evidence you relied on, note alternatives you ruled out and why, and point out risks and follow-up work.",
	minimal:
		"Reply in as few words as the answer allows: the result, then only what the user must know to act on it. No preamble, no recap, no headings.",
};

/** The system-prompt section for `style`; undefined for `default` (stock prompt unchanged). */
export function outputStyleInstruction(style: OutputStyleId): string | undefined {
	if (style === "default") return undefined;
	return [
		"<output-style>",
		INSTRUCTIONS[style],
		"This governs the length and shape of your replies to the user only; it never limits the work you do, the code you write or the tools you call. An explicit request from the user for more or less detail wins.",
		"</output-style>",
	].join("\n");
}
