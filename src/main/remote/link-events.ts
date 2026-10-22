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
 *
 * With `slimAutopilot` an Autopilot run's `autopilot_update`, whose status carries every cycle of the run (about
 * 100 KB after 90 cycles, sent several times a cycle), crosses whole once and after that as what changed from the
 * last one: the top-level fields that differ, and of a list (the cycles) only its length and the items that differ
 * ({@link createStatusEncoder}). The decoder rebuilds the status the host's pool delivered.
 *
 * With `slimEnds` a message crosses whole once: a `message_end` whose message equals its `message_start` (a prompt, a
 * tool result, a custom message), and each `agent_end` message equal, but for its journal `entryId`, to the one its
 * `message_end` carried, cross as a reference to it ({@link createEndsEncoder}). Stock otherwise sends a tool result
 * three times and a reply twice (measured on a paired host, 22 Oct 2026: `message_start`, `message_end` and
 * `agent_end` were 36 % of a slim link's event bytes). With `slimReadGroups` a reply whose read calls the bridge
 * decorated for `agent_end` crosses as a reference too, its read groups beside it (measured once both computers ran
 * 0.54.0: `message_end` 56 → 12 KB a minute, `agent_end` only 55 → 38, nearly all of it such replies). With
 * `slimEndFields` a reference also carries the top-level fields stock changed after the message crossed (`set`,
 * `unset`): stock stamps every reply's `completedAt` only after its `message_end`, so without them no reply of an
 * `agent_end` matched and each crossed whole again (`link-events-stock.test.ts`, on the installed omp).
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
import type { LinkSlim } from "./protocol";

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

/** What the device reads beyond whole frames (its hello's `slim*` flags, `protocol.ts`); unset reads as false. */
export type LinkEventEncoderOptions = Partial<Omit<LinkSlim, "events">>;

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

/** The `~delta` id of an Autopilot status: one run per tab, so one status per encoder. */
const STATUS = "autopilot";
const ITEMS = "~items";

/** A list field after the last one: its length now and the items at an index that differ (or are new). */
const ItemsDelta = z.object({ "~items": z.number().int().nonnegative(), at: z.record(z.unknown()) });
type ItemsDelta = z.infer<typeof ItemsDelta>;

function diffItems(base: readonly unknown[], next: readonly unknown[]): ItemsDelta {
	const at: Record<string, unknown> = {};
	for (const [index, item] of next.entries()) {
		if (index >= base.length || !isDeepStrictEqual(base[index], item)) at[index] = item;
	}
	return { [ITEMS]: next.length, at };
}

/** The list {@link diffItems} describes; {@link UNREBUILT} when it names an item `base` never had. */
function patchItems(base: unknown, delta: ItemsDelta): unknown[] | typeof UNREBUILT {
	const before: readonly unknown[] = Array.isArray(base) ? base : [];
	const next: unknown[] = [];
	for (let index = 0; index < delta[ITEMS]; index++) {
		if (Object.hasOwn(delta.at, index)) next.push(delta.at[index]);
		else if (index < before.length) next.push(before[index]);
		else return UNREBUILT;
	}
	return next;
}

/**
 * An Autopilot status after the last one sent: whole the first time, then the top-level fields that changed, a list
 * among them as {@link diffItems}. Only the newest cycle, the run's state and its ship state move between two.
 */
function createStatusEncoder(): (status: unknown) => unknown {
	let last: object | null = null;
	return status => {
		if (typeof status !== "object" || status === null || Array.isArray(status)) {
			last = null;
			return status;
		}
		const base = last;
		last = status;
		if (!base) return status;
		const delta = diff(STATUS, base, status);
		for (const [key, value] of Object.entries(delta.set ?? {})) {
			const before: unknown = Reflect.get(base, key);
			if (delta.set && Array.isArray(value) && Array.isArray(before)) delta.set[key] = diffItems(before, value);
		}
		return delta;
	};
}

/** The inverse of {@link createStatusEncoder}; a delta it holds no earlier status for gives {@link UNREBUILT}. */
function createStatusDecoder(): (wire: unknown) => unknown {
	let last: object | null = null;
	return wire => {
		const delta = asDelta(wire);
		if (!delta || delta[DELTA] !== STATUS) {
			if (typeof wire === "object" && wire !== null && !Array.isArray(wire)) last = wire;
			return wire;
		}
		const base = last;
		if (!base) return UNREBUILT;
		const set: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(delta.set ?? {})) {
			const items = ItemsDelta.safeParse(value);
			const next = items.success ? patchItems(Reflect.get(base, key), items.data) : value;
			if (next === UNREBUILT) return UNREBUILT;
			set[key] = next;
		}
		const status = patch(base, { [DELTA]: STATUS, set, ...(delta.unset ? { unset: delta.unset } : {}) });
		last = status;
		return status;
	};
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

const SENT = "~sent";
/** The messages a connection keeps for references; the oldest go first, the same on both ends. */
const ENDS_KEPT = 256;

type AgentMessageOf<T extends AgentSessionEvent["type"]> =
	Extract<AgentSessionEvent, { type: T }> extends {
		message: infer M;
	}
		? M
		: never;
type WireMessage = AgentMessageOf<"message_end">;

const READ_GROUP = "__ompReadGroup";

const SentRef = z
	.object({
		"~sent": z.string(),
		entryId: z.string().optional(),
		reads: z.record(z.unknown()).optional(),
		set: z.record(z.unknown()).optional(),
		unset: z.array(z.string()).optional(),
	})
	.strict();

/**
 * What a message's top-level fields became since `before` crossed (`set`, `unset`), when that is small beside the
 * message itself; null when the message must cross whole (no copy crossed, or its content changed).
 */
function fieldPatch(
	before: string | undefined,
	message: WireMessage,
): { set?: Record<string, unknown>; unset?: string[] } | null {
	if (before === undefined) return null;
	const old = JSON.parse(before) as Record<string, unknown>;
	const now = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
	const set: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(now)) if (!isDeepStrictEqual(old[key], value)) set[key] = value;
	const unset = Object.keys(old).filter(key => !Object.hasOwn(now, key));
	if (JSON.stringify(set).length * 4 > before.length) return null;
	return {
		...(Object.keys(set).length > 0 ? { set } : {}),
		...(unset.length > 0 ? { unset } : {}),
	};
}

/**
 * A committed message without the read groups the bridge adds to its read calls (`decorateMessages`, which the live
 * `message_end` never has), and those groups by content index; `reads` is absent when there are none.
 */
function withoutReadGroups(message: WireMessage): { message: WireMessage; reads?: Record<string, unknown> } {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return { message };
	let reads: Record<string, unknown> | undefined;
	const plain = content.map((block: unknown, index) => {
		const args = (block as { type?: unknown; arguments?: unknown }).arguments;
		if (
			(block as { type?: unknown }).type !== "toolCall" ||
			!args ||
			typeof args !== "object" ||
			!(READ_GROUP in args)
		)
			return block;
		const { [READ_GROUP]: group, ...rest } = args as Record<string, unknown>;
		reads ??= {};
		reads[index] = group;
		return { ...(block as object), arguments: rest };
	});
	return reads ? { message: { ...message, content: plain } as WireMessage, reads } : { message };
}

/** The inverse of {@link withoutReadGroups}: each group back on its read call, last among its arguments. */
function withReadGroups(message: WireMessage, reads: Record<string, unknown>): WireMessage {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return message;
	return {
		...message,
		content: content.map((block: unknown, index) =>
			Object.hasOwn(reads, index)
				? {
						...(block as object),
						arguments: { ...(block as { arguments?: object }).arguments, [READ_GROUP]: reads[index] },
					}
				: block,
		),
	} as WireMessage;
}

function messageKey(message: WireMessage): string {
	const { role, timestamp } = message as { role?: unknown; timestamp?: unknown };
	const call = (message as { toolCallId?: unknown }).toolCallId;
	return `${String(role)}\u0000${String(timestamp)}${typeof call === "string" ? `\u0000${call}` : ""}`;
}

/** The messages one end of a connection holds for references, in the order both ends saw them. */
function sentMessages<T>(): { get(key: string): T | undefined; set(key: string, value: T): void; clear(): void } {
	const kept = new Map<string, T>();
	return {
		get: key => kept.get(key),
		set(key, value) {
			kept.delete(key);
			kept.set(key, value);
			if (kept.size > ENDS_KEPT) kept.delete(kept.keys().next().value as string);
		},
		clear: () => kept.clear(),
	};
}

function withoutEntryId(message: WireMessage): { message: WireMessage; entryId?: string } {
	const { entryId, ...rest } = message as WireMessage & { entryId?: unknown };
	return typeof entryId === "string" ? { message: rest as WireMessage, entryId } : { message };
}

/**
 * Sends a message whole the first time this connection carries it, and as `{"~sent": key}` (with the journal
 * `entryId` an `agent_end` adds) when a `message_end` or `agent_end` carries the same message again.
 */
function createEndsEncoder(readGroups: boolean, fields: boolean): (event: AgentSessionEvent) => AgentSessionEvent {
	const sent = sentMessages<string>();
	const remember = (message: WireMessage): string => {
		const json = JSON.stringify(message);
		sent.set(messageKey(message), json);
		return json;
	};
	return event => {
		if (event.type === "message_start") {
			remember(event.message);
			return event;
		}
		if (event.type === "message_end") {
			const key = messageKey(event.message);
			const before = sent.get(key);
			// Set again either way: the decoder keeps every message_end it resolves, and both ends evict in one order.
			if (remember(event.message) === before)
				return { ...event, message: { [SENT]: key } as unknown as WireMessage };
			return event;
		}
		if (event.type !== "agent_end" || !event.messages) return event;
		let changed = false;
		const messages = event.messages.map(message => {
			const { message: bare, entryId } = withoutEntryId(message);
			const { message: plain, reads } = readGroups ? withoutReadGroups(bare) : { message: bare };
			const key = messageKey(plain);
			const before = sent.get(key);
			const patch = before === JSON.stringify(plain) ? {} : fields ? fieldPatch(before, plain) : null;
			if (!patch) return message;
			changed = true;
			return {
				[SENT]: key,
				...(entryId === undefined ? {} : { entryId }),
				...(reads === undefined ? {} : { reads }),
				...patch,
			} as unknown as WireMessage;
		});
		if (event.isTerminal !== false) sent.clear();
		return changed ? { ...event, messages } : event;
	};
}

const TOOL = "~tool";

const ToolRef = z.object({ "~tool": z.string() }).passthrough();

/** What a tool result's `message_start` repeats of its `tool_execution_end`: stock builds both from one result. */
interface ToolOutput {
	content: unknown;
	details: unknown;
}

function toolOutputOf(event: AgentSessionEvent): { id: string; output: ToolOutput } | null {
	if (event.type !== "tool_execution_end") return null;
	const result = event.result as { content?: unknown; details?: unknown } | undefined;
	return { id: event.toolCallId, output: { content: result?.content, details: result?.details } };
}

/**
 * Sends a tool result's `message_start` as `{"~tool": toolCallId, ...the rest}` when its `content` and `details` are
 * what that call's `tool_execution_end`, already sent, carried. Runs after {@link createEndsEncoder}, which keeps the
 * message whole for the `message_end` and `agent_end` references.
 */
function createToolResultEncoder(): (event: AgentSessionEvent) => AgentSessionEvent {
	const outputs = sentMessages<string>();
	return event => {
		const end = toolOutputOf(event);
		if (end) {
			outputs.set(end.id, JSON.stringify(end.output));
			return event;
		}
		if (event.type === "agent_end" && event.isTerminal !== false) outputs.clear();
		if (event.type !== "message_start") return event;
		const message = event.message as WireMessage & { role?: unknown; toolCallId?: unknown };
		if (message.role !== "toolResult" || typeof message.toolCallId !== "string") return event;
		const { content, details, ...rest } = message as typeof message & ToolOutput;
		if (outputs.get(message.toolCallId) !== JSON.stringify({ content, details })) return event;
		return { ...event, message: { [TOOL]: message.toolCallId, ...rest } as unknown as WireMessage };
	};
}

/** The inverse of {@link createToolResultEncoder}; null for a reference to a call this decoder never saw end. */
function createToolResultDecoder(): (event: AgentSessionEvent) => AgentSessionEvent | null {
	const outputs = sentMessages<ToolOutput>();
	return event => {
		const end = toolOutputOf(event);
		if (end) {
			outputs.set(end.id, end.output);
			return event;
		}
		if (event.type === "agent_end" && event.isTerminal !== false) outputs.clear();
		if (event.type !== "message_start") return event;
		const ref = ToolRef.safeParse(event.message);
		if (!ref.success) return event;
		const { [TOOL]: id, ...rest } = ref.data;
		const output = outputs.get(id);
		if (!output) return null;
		const message = {
			...rest,
			content: output.content,
			...(output.details === undefined ? {} : { details: output.details }),
		};
		return { ...event, message: message as unknown as WireMessage };
	};
}

/** The inverse of {@link createEndsEncoder}; null for a reference to a message this decoder never held. */
function createEndsDecoder(): (event: AgentSessionEvent) => AgentSessionEvent | null {
	const kept = sentMessages<WireMessage>();
	const resolve = (message: WireMessage): WireMessage | null => {
		const ref = SentRef.safeParse(message);
		if (!ref.success) return message;
		const held = kept.get(ref.data[SENT]);
		if (!held) return null;
		let whole = held;
		if (ref.data.set || ref.data.unset) {
			const patched: Record<string, unknown> = { ...whole, ...ref.data.set };
			for (const key of ref.data.unset ?? []) delete patched[key];
			whole = patched as WireMessage;
		}
		const grouped = ref.data.reads ? withReadGroups(whole, ref.data.reads) : whole;
		return ref.data.entryId === undefined ? grouped : ({ ...grouped, entryId: ref.data.entryId } as WireMessage);
	};
	return event => {
		if (event.type === "message_start" || event.type === "message_end") {
			const message = resolve(event.message);
			if (!message) return null;
			kept.set(messageKey(message), message);
			return message === event.message ? event : { ...event, message };
		}
		if (event.type !== "agent_end" || !event.messages) return event;
		let changed = false;
		const messages: WireMessage[] = [];
		for (const message of event.messages) {
			const resolved = resolve(message);
			if (!resolved) return null;
			if (resolved !== message) changed = true;
			messages.push(resolved);
		}
		if (event.isTerminal !== false) kept.clear();
		return changed ? { ...event, messages } : event;
	};
}

export function createLinkEventEncoder(options: LinkEventEncoderOptions = {}): LinkEventEncoder {
	const slim = createMessageUpdateSlimmer();
	const drop = usageDropper();
	const progress = options.progress ? createProgressEncoder() : null;
	const status = options.autopilot ? createStatusEncoder() : null;
	const ends = options.ends ? createEndsEncoder(options.readGroups === true, options.endFields === true) : null;
	const tools = ends && options.toolResults ? createToolResultEncoder() : null;
	return {
		events(batch) {
			const slimmed = slim(batch);
			let out: AgentSessionEvent[] | null = null;
			for (const [index, event] of slimmed.entries()) {
				let next: AgentSessionEvent = event;
				if (event.type === "message_update") next = drop("", event);
				else if (
					ends &&
					(event.type === "message_start" || event.type === "message_end" || event.type === "agent_end")
				) {
					next = ends(event);
					if (tools) next = tools(next);
				} else if (event.type === "tool_execution_end" && tools) next = tools(event);
				else if (event.type === "tool_execution_update" && progress) next = progress.update(event);
				else if (event.type === "autopilot_update" && status)
					next = { ...event, status: status(event.status) } as unknown as AgentSessionEvent;
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
	const decodeStatus = createStatusDecoder();
	const ends = createEndsDecoder();
	const tools = createToolResultDecoder();
	const autopilot = (event: Extract<AgentSessionEvent, { type: "autopilot_update" }>): AgentSessionEvent | null => {
		const status = decodeStatus(event.status);
		if (status === UNREBUILT) return null;
		return status === event.status ? event : ({ ...event, status } as AgentSessionEvent);
	};
	return {
		events(batch) {
			let out: AgentSessionEvent[] | null = null;
			for (const [index, event] of batch.entries()) {
				const tool = tools(event);
				const resolved =
					tool === null
						? null
						: tool.type === "message_start" || tool.type === "message_end" || tool.type === "agent_end"
							? ends(tool)
							: tool;
				const next =
					resolved === null
						? null
						: resolved.type === "tool_execution_update"
							? progress.update(resolved)
							: resolved.type === "autopilot_update"
								? autopilot(resolved)
								: decode(resolved);
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
	/**
	 * What the device reads. With `progress` (`slimProgress`) frames leave in batches, one tab event a flush, and
	 * snapshots as deltas.
	 */
	slim: LinkEventEncoderOptions;
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
	const { slim, send } = options;
	const progress = slim.progress === true;
	let encoder = createLinkEventEncoder(slim);
	let held: SubagentFrame[] = [];
	let timer: NodeJS.Timeout | undefined;
	const deliver = (name: "events" | "subagentFrame", arg: unknown): void => {
		// The device never got it, so the next snapshot of each subagent must go whole, not as a delta against this one.
		if (!send(name, arg)) encoder = createLinkEventEncoder(slim);
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
