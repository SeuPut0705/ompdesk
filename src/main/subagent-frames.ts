/**
 * A visible tab's subagent frames, coalesced like its agent events.
 *
 * Stock writes a `subagent_event` for every streaming delta of every running
 * subagent (unfiltered: each `message_update` carries the whole reply so far,
 * twice) plus coalesced progress frames. Forwarded one IPC message per frame,
 * a run with a few subagents sent the renderer >100 messages a second, each
 * its own task and React commit. Here they leave at most once per
 * presentation frame, in order, and the renderer applies a batch in one task.
 *
 * Message updates are slimmed on the way: a subagent's events feed only its
 * tools-store surface (and the observed-usage count), which read the fields
 * {@link slimMessageUpdate} keeps — never the accumulated snapshot. Every
 * event also leaves without what no window reads (frame-bookkeeping.ts): the
 * request bookkeeping on its messages, and a `turn_end`'s message and tool
 * results, which its own `message_end` and `tool_execution_end` already carried.
 */
import type { SubagentFrame } from "../shared/rpc-types";
import { BATCH_INTERVAL_MS } from "./event-batcher";
import { withoutFrameBookkeeping } from "./frame-bookkeeping";
import { slimMessageUpdate } from "./message-update-slim";

export interface SubagentFrameBatcher {
	push(frame: SubagentFrame): void;
	/** Send what is pending now: before an agent-event batch (frames keep their order) and on detach. */
	flush(): void;
}

/** A subagent's event reduced to what the renderer reads; every other frame as it is. */
export function slimSubagentFrame(frame: SubagentFrame): SubagentFrame {
	if (frame.type !== "subagent_event") return frame;
	const source = frame.payload.event;
	const trimmed = withoutFrameBookkeeping(source);
	const event = trimmed.type === "message_update" ? slimMessageUpdate(trimmed) : trimmed;
	return event === source ? frame : { type: frame.type, payload: { ...frame.payload, event } };
}

export function createSubagentFrameBatcher(send: (frames: SubagentFrame[]) => void): SubagentFrameBatcher {
	let pending: SubagentFrame[] = [];
	let timer: NodeJS.Timeout | undefined;
	const flush = (): void => {
		clearTimeout(timer);
		timer = undefined;
		if (pending.length === 0) return;
		const batch = pending;
		pending = [];
		send(batch);
	};
	return {
		push(frame) {
			pending.push(slimSubagentFrame(frame));
			timer ??= setTimeout(flush, BATCH_INTERVAL_MS);
		},
		flush,
	};
}
