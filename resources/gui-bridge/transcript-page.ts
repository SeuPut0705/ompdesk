/** Renderer pages must include the whole first turn, including tool calls/results. */
export function transcriptTurnStart(messages: readonly { role: string }[], offset: number, end: number): number {
	let start = Math.min(offset, messages.length);
	if (start >= end) return start;
	while (start > 0 && messages[start]?.role !== "user") start--;
	return start;
}
