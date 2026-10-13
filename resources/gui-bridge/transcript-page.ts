/**
 * Renderer pages must include the whole first turn, including tool calls/results.
 * A stock `steering` user message is delivered inside a running turn, so it never starts one.
 */
export function transcriptTurnStart(
	messages: readonly { role: string; steering?: boolean }[],
	offset: number,
	end: number,
): number {
	let start = Math.min(offset, messages.length);
	if (start >= end) return start;
	while (start > 0 && (messages[start]?.role !== "user" || messages[start]?.steering === true)) start--;
	return start;
}
