/**
 * Where a renderer page may start: the whole run its first message belongs to, tool calls and results included, so no
 * page opens on an orphan result or a call group split from its step. A run starts at a typed prompt (a stock
 * `steering` user message joins the running one) or right after a run that ended (an assistant message that stopped on
 * anything but a tool call). The second matters for goal and Autopilot runs, which continue with custom messages and
 * never a typed prompt: snapping to the prompt made one page of a long run 1754 messages and 4.6 MB (21 Oct 2026), on
 * every hydrate and every reconnect of a paired device.
 */
export function transcriptTurnStart(
	messages: readonly { role: string; steering?: boolean; stopReason?: string }[],
	offset: number,
	end: number,
): number {
	let start = Math.min(offset, messages.length);
	if (start >= end) return start;
	while (start > 0 && !startsRun(messages, start)) start--;
	return start;
}

function startsRun(messages: readonly { role: string; steering?: boolean; stopReason?: string }[], index: number) {
	const message = messages[index];
	if (message?.role === "user") return message.steering !== true;
	const before = messages[index - 1];
	return (
		message?.role !== "toolResult" &&
		before?.role === "assistant" &&
		before.stopReason !== undefined &&
		before.stopReason !== "toolUse"
	);
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
