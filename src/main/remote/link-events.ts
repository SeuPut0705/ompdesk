/**
 * What a host sends a device for `events` and `subagentFrame` when the device's hello said `slimEvents` and
 * `slimProgress`, and how the device turns it back into what a local sidecar delivers to its pool.
 *
 * Stock's `message_update` carries the whole accumulated message twice, so a reply of K tokens costs O(K²) bytes on
 * the link (`link-traffic-report.test.ts`). The encoder (host, one per tab and connection) applies the slimming the
 * local pool does on its way to a window ({@link createMessageUpdateSlimmer}: the first update of each message whole,
 * the rest reduced; {@link slimSubagentFrame}: a subagent's every update reduced) and drops a `usage` that repeats the
 * last one of its message. The decoder (device, one per tab) puts the usage back and, for the tab's own stream,
 * rebuilds the snapshot the pool's per-window slimmer needs for a window that attaches mid-message: the text and
 * thinking blocks accumulated from the deltas and the tool call a `toolcall_delta` names. What it hands the pool
 * therefore slims to exactly what a local tab's window receives, and a host that sends whole updates (an older one)
 * passes through untouched.
 *
 * With `slimProgress` a subagent's `AgentProgress` snapshot, which reaches the host in a `subagent_progress` frame
 * and in the parent's task `tool_execution_update`, crosses once and after that as a delta
 * ({@link createProgressEncoder}), and the subagent frames of one flush cross in one tab event
 * ({@link createLinkEventSender}). The decoder rebuilds the very frames and updates stock emitted.
 */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
	AgentSessionEvent,
	MessageContent,
	SubagentFrame,
	SubagentProgressFrame,
	SubagentProgressPayload,
} from "../../shared/rpc-types";
import { BATCH_INTERVAL_MS } from "../event-batcher";
import { createMessageUpdateSlimmer } from "../message-update-slim";
import { slimSubagentFrame } from "../subagent-frames";

type MessageUpdate = Extract<AgentSessionEvent, { type: "message_update" }>;

/** The stream events carry fields the declared `AssistantMessageEvent` union leaves out. */
interface WireIncrement {
	type: string;
	contentIndex: number;
	delta?: string;
	partial?: { role: MessageUpdate["message"]["role"]; content?: Array<MessageContent | null> };
}

/** A `subagent_progress` frame as it crosses the link: its payload and its snapshot may be deltas (`slimProgress`). */
export interface WireProgressFrame {
	type: "subagent_progress";
	payload: unknown;
}

export type WireSubagentFrame = SubagentFrame | WireProgressFrame;

export interface LinkEventEncoderOptions {
	/** The device rebuilds snapshots from deltas (`slimProgress`). */
	progress?: boolean;
}

export interface LinkEventEncoder {
	events(batch: AgentSessionEvent[]): AgentSessionEvent[];
	subagentFrame(frame: SubagentFrame): WireSubagentFrame;
}

export interface LinkEventDecoder {
	events(batch: AgentSessionEvent[]): AgentSessionEvent[];
	/** The frame a local sidecar delivers; null when it is a delta of a snapshot this decoder never held. */
	subagentFrame(frame: WireSubagentFrame): SubagentFrame | null;
}

/** Drops `message.usage` from an update that repeats the last one of its stream, keyed by `key`. */
function usageDropper(): (key: string, update: MessageUpdate) => MessageUpdate {
	const sent = new Map<string, { timestamp: unknown; json: string }>();
	return (key, update) => {
		const { usage, timestamp } = update.message;
		if (usage === undefined || timestamp === undefined) return update;
		const json = JSON.stringify(usage);
		const last = sent.get(key);
		if (last?.timestamp === timestamp && last.json === json) {
			const { usage: _usage, ...message } = update.message;
			return { ...update, message };
		}
		sent.set(key, { timestamp, json });
		return update;
	};
}

/** The inverse of {@link usageDropper}: an update without `usage` gets the last one of its stream and message. */
function usageRestorer(): (key: string, update: MessageUpdate) => MessageUpdate {
	const known = new Map<string, { timestamp: unknown; usage: MessageUpdate["message"]["usage"] }>();
	return (key, update) => {
		const { usage, timestamp } = update.message;
		if (timestamp === undefined) return update;
		if (usage !== undefined) {
			known.set(key, { timestamp, usage });
			return update;
		}
		const last = known.get(key);
		return last?.timestamp === timestamp ? { ...update, message: { ...update.message, usage: last.usage } } : update;
	};
}

type ToolUpdate = Extract<AgentSessionEvent, { type: "tool_execution_update" }>;

const DELTA = "~delta";

/**
 * A record as the link carries it after the last one of the same subagent: only the fields that are different now
 * (`set`) and the keys that are gone (`unset`). A whole record has no `~delta`, which no stock field is called.
 */
const FieldDelta = z
	.object({ "~delta": z.string(), set: z.record(z.unknown()).optional(), unset: z.array(z.string()).optional() })
	.passthrough();
type FieldDelta = z.infer<typeof FieldDelta>;

function asDelta(value: unknown): FieldDelta | null {
	const parsed = FieldDelta.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/** The subagent a snapshot or its delta belongs to. */
function idOf(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	if (DELTA in value && typeof value[DELTA] === "string") return value[DELTA];
	return "id" in value && typeof value.id === "string" ? value.id : undefined;
}

function diff(id: string, base: object, next: object): FieldDelta {
	const set = Object.fromEntries(
		Object.entries(next).filter(
			([key, value]) => !Object.hasOwn(base, key) || !isDeepStrictEqual(Reflect.get(base, key), value),
		),
	);
	const unset = Object.keys(base).filter(key => !Object.hasOwn(next, key));
	const delta: FieldDelta = { [DELTA]: id };
	if (Object.keys(set).length > 0) delta.set = set;
	if (unset.length > 0) delta.unset = unset;
	return delta;
}

function patch(base: object, delta: FieldDelta): object {
	const next: Record<string, unknown> = { ...base, ...delta.set };
	for (const key of delta.unset ?? []) delete next[key];
	return next;
}

/** What the decoder gives for a delta against a record it never held. */
const UNREBUILT = Symbol("unrebuilt");

/**
 * `event` with `map` applied to each snapshot of its `details.progress` (the task tool's running subagents, whole
 * list on every update); null when `map` gave up on one. `map` sees every snapshot, in order, either way.
 */
function mapSnapshots(event: ToolUpdate, map: (snapshot: unknown) => unknown): ToolUpdate | null {
	const { partialResult } = event;
	if (typeof partialResult !== "object" || partialResult === null || !("details" in partialResult)) return event;
	const { details } = partialResult;
	if (typeof details !== "object" || details === null || !("progress" in details)) return event;
	const { progress } = details;
	if (!Array.isArray(progress)) return event;
	const snapshots: unknown[] = progress;
	let mapped: unknown[] | null = null;
	let gaveUp = false;
	for (const [index, snapshot] of snapshots.entries()) {
		const next = map(snapshot);
		if (next === UNREBUILT) gaveUp = true;
		else if (next !== snapshot) {
			mapped ??= snapshots.slice();
			mapped[index] = next;
		}
	}
	if (gaveUp) return null;
	if (!mapped) return event;
	return { ...event, partialResult: { ...partialResult, details: { ...details, progress: mapped } } };
}

interface ProgressEncoder {
	update(event: ToolUpdate): ToolUpdate;
	frame(frame: SubagentProgressFrame): WireSubagentFrame;
}

/**
 * A subagent's `AgentProgress` reaches the host twice, as `subagent_progress` frames and inside the parent's task
 * update, about 3 KB each every 150 ms, and hardly changes between two. The link carries each subagent's snapshot
 * whole the first time and after that what changed from the last one of that id, whichever of the two brought it.
 * A frame's fields beside the snapshot (stock repeats the assignment there) go the same way.
 */
function createProgressEncoder(): ProgressEncoder {
	const snapshots = new Map<string, object>();
	const payloads = new Map<string, object>();
	const encode = (snapshot: unknown): unknown => {
		const id = idOf(snapshot);
		if (id === undefined || typeof snapshot !== "object" || snapshot === null) return snapshot;
		const base = snapshots.get(id);
		snapshots.set(id, snapshot);
		return base ? diff(id, base, snapshot) : snapshot;
	};
	return {
		// `encode` never gives up on a snapshot.
		update: event => mapSnapshots(event, encode) ?? event,
		frame(frame) {
			const { progress, ...beside } = frame.payload;
			const id = idOf(progress);
			if (id === undefined) return frame;
			const wireProgress = encode(progress);
			const base = payloads.get(id);
			payloads.set(id, beside);
			return { type: frame.type, payload: { ...(base ? diff(id, base, beside) : beside), progress: wireProgress } };
		},
	};
}

interface ProgressDecoder {
	update(event: ToolUpdate): ToolUpdate | null;
	frame(frame: WireProgressFrame): SubagentProgressFrame | null;
}

/** The inverse of {@link createProgressEncoder}; what it holds no earlier record for (a delta) is never delivered. */
function createProgressDecoder(): ProgressDecoder {
	const snapshots = new Map<string, object>();
	const payloads = new Map<string, object>();
	const decode = (wire: unknown): unknown => {
		const delta = asDelta(wire);
		if (delta) {
			const base = snapshots.get(delta[DELTA]);
			if (!base) return UNREBUILT;
			const next = patch(base, delta);
			snapshots.set(delta[DELTA], next);
			return next;
		}
		const id = idOf(wire);
		if (id !== undefined && typeof wire === "object" && wire !== null) snapshots.set(id, wire);
		return wire;
	};
	return {
		update: event => mapSnapshots(event, decode),
		frame(frame) {
			// Stock's own frame as long as neither the payload nor its snapshot is a delta.
			const whole = frame as SubagentProgressFrame;
			const { payload } = frame;
			if (typeof payload !== "object" || payload === null || !("progress" in payload)) return whole;
			const id = idOf(payload.progress);
			if (id === undefined) return whole;
			const progress = decode(payload.progress);
			const delta = asDelta(payload);
			let beside: object | undefined;
			if (delta) {
				const base = payloads.get(id);
				if (base) beside = patch(base, delta);
			} else {
				const { progress: _progress, ...rest } = payload;
				beside = rest;
			}
			if (beside) payloads.set(id, beside);
			if (progress === UNREBUILT || !beside) return null;
			if (!delta && progress === payload.progress) return whole;
			// The fields stock sent, rebuilt.
			return { type: frame.type, payload: { ...beside, progress } as unknown as SubagentProgressPayload };
		},
	};
}

export function createLinkEventEncoder(options: LinkEventEncoderOptions = {}): LinkEventEncoder {
	const slim = createMessageUpdateSlimmer();
	const drop = usageDropper();
	const progress = options.progress ? createProgressEncoder() : null;
	return {
		events(batch) {
			const slimmed = slim(batch);
			let out: AgentSessionEvent[] | null = null;
			for (const [index, event] of slimmed.entries()) {
				let next: AgentSessionEvent = event;
				if (event.type === "message_update") next = drop("", event);
				else if (event.type === "tool_execution_update" && progress) next = progress.update(event);
				if (next === event) continue;
				out ??= slimmed.slice();
				out[index] = next;
			}
			return out ?? slimmed;
		},
		subagentFrame(frame) {
			const slimmed = slimSubagentFrame(frame);
			if (slimmed.type === "subagent_progress") return progress ? progress.frame(slimmed) : slimmed;
			if (slimmed.type !== "subagent_event") return slimmed;
			const { event } = slimmed.payload;
			let next: AgentSessionEvent = event;
			if (event.type === "message_update") next = drop(slimmed.payload.id, event);
			else if (event.type === "tool_execution_update" && progress) next = progress.update(event);
			return next === event ? slimmed : { type: slimmed.type, payload: { ...slimmed.payload, event: next } };
		},
	};
}

/** The blocks of the message being streamed, rebuilt from the deltas after its first whole update. */
interface Rebuilt {
	timestamp: unknown;
	blocks: Array<MessageContent | undefined>;
}

function advance(blocks: Rebuilt["blocks"], increment: WireIncrement): void {
	const { contentIndex: index } = increment;
	const current = blocks[index];
	switch (increment.type) {
		case "text_start":
			blocks[index] = { type: "text", text: "" };
			break;
		case "thinking_start":
			blocks[index] = { type: "thinking", thinking: "" };
			break;
		case "text_delta":
			blocks[index] = {
				type: "text",
				text: (current?.type === "text" ? current.text : "") + (increment.delta ?? ""),
			};
			break;
		case "thinking_delta":
			blocks[index] = {
				type: "thinking",
				thinking: (current?.type === "thinking" ? current.thinking : "") + (increment.delta ?? ""),
			};
			break;
		case "toolcall_delta": {
			const block = increment.partial?.content?.[index];
			if (block?.type === "toolCall") blocks[index] = block;
			break;
		}
	}
}

export function createLinkEventDecoder(): LinkEventDecoder {
	let rebuilt: Rebuilt | null = null;
	const restore = usageRestorer();
	const decode = (event: AgentSessionEvent): AgentSessionEvent => {
		if (event.type === "message_end" || event.type === "agent_end") {
			rebuilt = null;
			return event;
		}
		if (event.type !== "message_update") return event;
		const { content, timestamp } = event.message;
		if (Array.isArray(content)) {
			rebuilt = { timestamp, blocks: content.slice() };
			restore("", event);
			return event;
		}
		const update = restore("", event);
		const previous = rebuilt;
		const stream: Rebuilt = previous && previous.timestamp === timestamp ? previous : { timestamp, blocks: [] };
		rebuilt = stream;
		const increment = update.assistantMessageEvent as unknown as WireIncrement;
		advance(stream.blocks, increment);
		let { assistantMessageEvent } = update;
		const block = increment.partial?.content?.[increment.contentIndex];
		if (increment.type === "toolcall_delta" && block && increment.partial) {
			// What the local slimmer sends: the block alone, in a sparse array (JSON turned the holes into null).
			const sparse: MessageContent[] = [];
			sparse[increment.contentIndex] = block;
			assistantMessageEvent = {
				...assistantMessageEvent,
				partial: { role: increment.partial.role, content: sparse },
			} as typeof assistantMessageEvent;
		}
		return {
			...update,
			message: { ...update.message, content: stream.blocks.filter(block => block !== undefined) },
			assistantMessageEvent,
		};
	};
	const restoreSubagent = usageRestorer();
	const progress = createProgressDecoder();
	return {
		events(batch) {
			let out: AgentSessionEvent[] | null = null;
			for (const [index, event] of batch.entries()) {
				const next = event.type === "tool_execution_update" ? progress.update(event) : decode(event);
				if (next === event) {
					out?.push(event);
					continue;
				}
				out ??= batch.slice(0, index);
				if (next) out.push(next);
			}
			return out ?? batch;
		},
		subagentFrame(frame) {
			if (frame.type === "subagent_progress") return progress.frame(frame);
			if (frame.type !== "subagent_event") return frame;
			const { event } = frame.payload;
			let next: AgentSessionEvent | null = event;
			if (event.type === "tool_execution_update") next = progress.update(event);
			else if (event.type === "message_update") next = restoreSubagent(frame.payload.id, event);
			if (next === null) return null;
			return next === event ? frame : { type: frame.type, payload: { ...frame.payload, event: next } };
		},
	};
}

export interface LinkEventSender {
	/** An omp `events` batch; the subagent frames held back go first, as they came. */
	events(batch: AgentSessionEvent[]): void;
	subagentFrame(frame: SubagentFrame): void;
	/** Sends the frames held back now: before any other tab event, and before a response the omp is about to give. */
	flush(): void;
	/** The connection is gone: what is held back is not sent. */
	dispose(): void;
}

export interface LinkEventSenderOptions {
	/** The device sent `slimProgress`: frames leave in batches, one tab event a flush, and snapshots as deltas. */
	progress: boolean;
	/** Sends one tab event; false when it did not go out (an event over the frame cap). */
	send(name: "events" | "subagentFrame", arg: unknown): boolean;
}

/**
 * What the host sends one device for one tab: {@link createLinkEventEncoder}'s output, and for a device that asked for
 * `slimProgress` the subagent frames of one {@link BATCH_INTERVAL_MS} in one `subagentFrame` tab event (an array)
 * instead of one tab event, and so one envelope, each. Frames are encoded when they leave, so the encoder sees them in
 * wire order, and events and frames never swap places.
 */
export function createLinkEventSender(options: LinkEventSenderOptions): LinkEventSender {
	const { progress, send } = options;
	let encoder = createLinkEventEncoder({ progress });
	let held: SubagentFrame[] = [];
	let timer: NodeJS.Timeout | undefined;
	const deliver = (name: "events" | "subagentFrame", arg: unknown): void => {
		// The device never got it, so the next snapshot of each subagent must go whole, not as a delta against this one.
		if (!send(name, arg)) encoder = createLinkEventEncoder({ progress });
	};
	const flush = (): void => {
		clearTimeout(timer);
		timer = undefined;
		if (held.length === 0) return;
		const frames = held;
		held = [];
		deliver(
			"subagentFrame",
			frames.map(frame => encoder.subagentFrame(frame)),
		);
	};
	return {
		events(batch) {
			flush();
			deliver("events", encoder.events(batch));
		},
		subagentFrame(frame) {
			if (!progress) {
				deliver("subagentFrame", encoder.subagentFrame(frame));
				return;
			}
			held.push(frame);
			timer ??= setTimeout(flush, BATCH_INTERVAL_MS);
		},
		flush,
		dispose() {
			clearTimeout(timer);
			timer = undefined;
			held = [];
		},
	};
}
