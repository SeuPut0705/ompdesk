/**
 * Live agent frames without the provider request bookkeeping stock records on each assistant message
 * (`inputTransformations`, `requestControls`, `contextSnapshot`; transcript-page.ts). Nothing in main or the renderer
 * reads them, and in a long Anthropic session `inputTransformations` lists every earlier thinking block the API dropped:
 * about 21 KB of a 26 KB message on 21 Oct 2026, carried by `message_end`, `turn_end` and every message of `agent_end`
 * to each window and over the link to a paired device. Transcript pages already leave them out.
 */
import { withoutRequestBookkeeping } from "../../resources/gui-bridge/transcript-page";

type Frame = Record<string, unknown>;

function slim(value: unknown): unknown {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? withoutRequestBookkeeping(value)
		: value;
}

/** `frame` with the bookkeeping left out of the messages it carries; the same object when there is none. */
export function withoutFrameBookkeeping<T extends Frame>(frame: T): T {
	let out: Frame = frame;
	const set = (key: string, value: unknown) => {
		if (value === out[key]) return;
		if (out === frame) out = { ...frame };
		out[key] = value;
	};
	if ("message" in frame) set("message", slim(frame.message));
	if (Array.isArray(frame.messages)) {
		const messages = frame.messages.map(slim);
		if (messages.some((message, index) => message !== (frame.messages as unknown[])[index]))
			set("messages", messages);
	}
	const event = frame.assistantMessageEvent;
	if (typeof event === "object" && event !== null && "partial" in event) {
		const partial = slim((event as { partial: unknown }).partial);
		if (partial !== (event as { partial: unknown }).partial) set("assistantMessageEvent", { ...event, partial });
	}
	return out as T;
}
