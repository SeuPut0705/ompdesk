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

/**
 * Provider request bookkeeping stock keeps on each assistant message (dropped
 * thinking, tool declarations, the context it was sent with). Nothing renders it,
 * and on a long session it is the bulk of a page: `inputTransformations` alone was
 * a third of a 40 MB session, and every page crossed the bridge socket, main and
 * the renderer's IPC with it. Content, which live delivery is matched against,
 * stays as stored.
 */
const REQUEST_BOOKKEEPING = ["inputTransformations", "requestControls", "contextSnapshot"];

/** A transcript page's messages without request bookkeeping (see REQUEST_BOOKKEEPING). */
export function transcriptPageMessages<T extends object>(messages: readonly T[]): T[] {
	return messages.map(message => {
		if (!REQUEST_BOOKKEEPING.some(key => key in message)) return message;
		const page = { ...message };
		for (const key of REQUEST_BOOKKEEPING) Reflect.deleteProperty(page, key);
		return page;
	});
}
