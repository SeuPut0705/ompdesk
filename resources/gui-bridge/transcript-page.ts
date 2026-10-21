/**
 * Where a renderer page may start: the whole run its first message belongs to, tool calls and results included, so no
 * page opens on an orphan result or a call group split from its step. A run starts at a typed prompt (a stock
 * `steering` user message joins the running one) or right after a run that ended (an assistant message that stopped on
 * anything but a tool call). The second matters for goal and Autopilot runs, which continue with custom messages and
 * never a typed prompt: snapping to the prompt made one page of a long run 1754 messages and 4.6 MB (21 Oct 2026), on
 * every hydrate and every reconnect of a paired device.
 */
export function transcriptRunStart(
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

/** `message` without request bookkeeping (see REQUEST_BOOKKEEPING); the same object when it carries none. */
export function withoutRequestBookkeeping<T extends object>(message: T): T {
	if (!REQUEST_BOOKKEEPING.some(key => key in message)) return message;
	const copy = { ...message };
	for (const key of REQUEST_BOOKKEEPING) Reflect.deleteProperty(copy, key);
	return copy;
}

/**
 * A transcript page's messages without request bookkeeping (see REQUEST_BOOKKEEPING) and without a thinking block's
 * `thinkingSignature`: an opaque blob the provider checks when the conversation is sent again, which stock reads from
 * the journal, never from a page. It was about a fifth of a long session's tail page (21 Oct 2026). The renderer's
 * match of a live delivery to its page copy ignores it (message-identity.ts).
 */
export function transcriptPageMessages<T extends object>(messages: readonly T[]): T[] {
	return messages.map(message => {
		const content = (message as { content?: unknown }).content;
		const signed = Array.isArray(content) && content.some(block => isSigned(block));
		if (!signed) return withoutRequestBookkeeping(message);
		const page = withoutRequestBookkeeping({ ...message });
		(page as { content?: unknown }).content = (content as unknown[]).map(block => {
			if (!isSigned(block)) return block;
			const { thinkingSignature: _signature, ...rest } = block;
			return rest;
		});
		return page;
	});
}

function isSigned(block: unknown): block is { thinkingSignature: unknown } {
	return typeof block === "object" && block !== null && "thinkingSignature" in block;
}
