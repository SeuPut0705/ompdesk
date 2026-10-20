import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProgress, AgentSessionEvent, MessageContent, SubagentFrame } from "../../shared/rpc-types";
import { BATCH_INTERVAL_MS } from "../event-batcher";
import { createMessageUpdateSlimmer } from "../message-update-slim";
import { slimSubagentFrame } from "../subagent-frames";
import {
	createLinkEventDecoder,
	createLinkEventEncoder,
	createLinkEventSender,
	type LinkEventDecoder,
} from "./link-events";

type Update = Extract<AgentSessionEvent, { type: "message_update" }>;

const usageOf = (output: number) => ({
	input: 1200,
	output,
	cacheRead: 8000,
	totalTokens: 9200 + output,
	cost: { input: 0.003, output: 0.0004, total: 0.0034 },
});

/** One assistant message as stock streams it: thinking, text and a tool call, every update carrying the whole message. */
function stockStream(timestamp: number, deltas = 3): AgentSessionEvent[] {
	const content: MessageContent[] = [];
	const message = { role: "assistant" as const, content, usage: usageOf(0), timestamp };
	const events: AgentSessionEvent[] = [{ type: "message_start", message: { ...message, content: [] } }];
	const update = (assistantMessageEvent: object): void => {
		const snapshot = structuredClone(message);
		events.push({
			type: "message_update",
			message: snapshot,
			assistantMessageEvent: { ...assistantMessageEvent, partial: structuredClone(snapshot) },
		} as unknown as AgentSessionEvent);
	};
	const words = (label: string): string[] => Array.from({ length: deltas }, (_, i) => `${label}${i} `);
	for (const [type, parts] of [
		["thinking", words("think")],
		["text", words("say")],
	] as const) {
		const block = type === "thinking" ? { type, thinking: "" } : { type, text: "" };
		const contentIndex = content.push(block) - 1;
		update({ type: `${type}_start`, contentIndex });
		for (const delta of parts) {
			if (block.type === "thinking") block.thinking += delta;
			else block.text += delta;
			update({ type: `${type}_delta`, contentIndex, delta });
		}
		update({ type: `${type}_end`, contentIndex, content: type === "thinking" ? block.thinking : block.text });
	}
	const call = { type: "toolCall" as const, id: "call-1", name: "bash", arguments: {} };
	const contentIndex = content.push(call) - 1;
	update({ type: "toolcall_start", contentIndex });
	call.arguments = { command: "ls" };
	update({ type: "toolcall_delta", contentIndex, delta: '{"command":"ls"}' });
	message.usage = usageOf(42);
	update({ type: "toolcall_end", contentIndex, toolCall: call });
	events.push({ type: "message_end", message: structuredClone(message) });
	return events;
}

const overTheWire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The renderer binds a streaming call by its id and name; arguments arrive as deltas. */
const toolIdentity = (block: MessageContent | undefined): unknown =>
	block?.type === "toolCall" ? { id: block.id, name: block.name } : block;

/** What the renderer reads of a window's first update and of every later one (message-update-slim.ts). */
function rendererView(events: AgentSessionEvent[]): unknown {
	return events.map(event => {
		if (event.type !== "message_update") return event.type;
		const blocks = Array.isArray(event.message.content) ? event.message.content : [];
		const increment = event.assistantMessageEvent as unknown as {
			type: string;
			contentIndex: number;
			delta?: string;
			partial?: { content?: MessageContent[] };
		};
		return {
			role: event.message.role,
			timestamp: event.message.timestamp,
			usage: event.message.usage,
			text: blocks
				.flatMap(block =>
					block.type === "text" ? [block.text] : block.type === "thinking" ? [block.thinking] : [],
				)
				.join("|"),
			increment: { type: increment.type, contentIndex: increment.contentIndex, delta: increment.delta },
			call:
				increment.type === "toolcall_delta"
					? toolIdentity(increment.partial?.content?.[increment.contentIndex])
					: undefined,
		};
	});
}

function carried(raw: AgentSessionEvent[], batchSize: number): AgentSessionEvent[] {
	const encoder = createLinkEventEncoder();
	const decoder = createLinkEventDecoder();
	const out: AgentSessionEvent[] = [];
	for (let at = 0; at < raw.length; at += batchSize)
		out.push(...decoder.events(overTheWire(encoder.events(raw.slice(at, at + batchSize)))));
	return out;
}

describe("a slim events frame", () => {
	it("is far smaller than the whole updates and holds no repeated usage", () => {
		const raw = stockStream(1_760_000_000_001, 80);
		const encoded = createLinkEventEncoder().events(raw);
		expect(JSON.stringify(encoded).length * 10).toBeLessThan(JSON.stringify(raw).length);
		const updates = encoded.filter((event): event is Update => event.type === "message_update");
		expect(updates[0]?.message.usage).toEqual(usageOf(0));
		expect(updates.slice(1, -1).every(update => update.message.usage === undefined)).toBe(true);
		expect(updates.at(-1)?.message.usage).toEqual(usageOf(42));
	});

	it("reaches a window that watched from the start as the same events a local tab sends it", () => {
		const raw = stockStream(1_760_000_000_001);
		for (const batchSize of [1, 4, raw.length]) {
			const local = createMessageUpdateSlimmer()(raw);
			const remote = createMessageUpdateSlimmer()(carried(raw, batchSize));
			expect(remote).toEqual(local);
		}
	});

	it("gives a window that attaches mid-message the text, thinking and tool call it would get locally", () => {
		const raw = stockStream(1_760_000_000_001);
		const arrived = carried(raw, 3);
		for (let from = 1; from < raw.length - 1; from++) {
			const local = rendererView(createMessageUpdateSlimmer()(raw.slice(from)));
			const remote = rendererView(createMessageUpdateSlimmer()(arrived.slice(from)));
			expect(remote).toEqual(local);
		}
	});

	it("carries two messages one after the other, each starting whole", () => {
		const raw = [...stockStream(1_760_000_000_001), ...stockStream(1_760_000_000_002)];
		const local = createMessageUpdateSlimmer()(raw);
		expect(createMessageUpdateSlimmer()(carried(raw, 5))).toEqual(local);
	});

	it("passes whole updates from an older host through untouched", () => {
		const raw = overTheWire(stockStream(1_760_000_000_001));
		const decoder = createLinkEventDecoder();
		const out = decoder.events(raw);
		expect(out).toBe(raw);
	});
});

describe("a subagent's slim frames", () => {
	const frame = (id: string, update: Update): SubagentFrame => ({
		type: "subagent_event",
		payload: { id, event: update },
	});
	const updates = (timestamp: number) =>
		stockStream(timestamp).filter((event): event is Update => event.type === "message_update");

	it("arrive as the frames the local batcher slims them to", () => {
		const raw = [
			...updates(1).map(update => frame("a", update)),
			...updates(2).map(update => frame("b", update)),
			{ type: "subagent_lifecycle", payload: { id: "a", status: "started" } } as unknown as SubagentFrame,
		];
		const encoder = createLinkEventEncoder();
		const decoder = createLinkEventDecoder();
		const arrived = raw.map(item => decoder.subagentFrame(overTheWire(encoder.subagentFrame(item))));
		expect(arrived.map(slimSubagentFrame)).toEqual(raw.map(slimSubagentFrame));
		expect(JSON.stringify(raw.map(item => encoder.subagentFrame(item))).length * 3).toBeLessThan(
			JSON.stringify(raw).length,
		);
	});

	it("slim again to themselves, so the device's own batcher changes nothing", () => {
		for (const update of updates(1)) {
			const local = slimSubagentFrame(frame("a", update));
			expect(slimSubagentFrame(overTheWire(local))).toEqual(local);
		}
	});
});

const ASSIGNMENT =
	"Find every place the host pushes state to a device and report the file, the line and how often it fires. ".repeat(12);

/**
 * One stock `AgentProgress` snapshot of a running subagent after `step` coalesced emits. As in task/executor.ts, a
 * tool's start and end are stamped once; `durationMs` and the streamed output move on every emit.
 */
function snapshot(id: string, step: number): AgentProgress {
	const finished = Math.floor(step / 3);
	return {
		index: 0,
		id,
		agent: "explore",
		agentSource: "bundled",
		status: "running",
		task: `Complete assignment thoroughly:\n\n${ASSIGNMENT}`,
		assignment: ASSIGNMENT,
		description: "Map host pushes",
		lastIntent: "Reading the host's event forwarding",
		currentTool: "grep",
		currentToolArgs: `pattern=emit( path=src/main/remote round=${finished}`,
		currentToolStartMs: 1_760_000_000_000 + finished * 900,
		recentTools: Array.from({ length: Math.min(finished, 5) }, (_, i) => ({
			tool: i % 2 === 0 ? "read" : "grep",
			args: `src/main/remote/host-services.ts:${100 + i * 40}-${140 + i * 40}`,
			intent: "Reading the host's event forwarding",
			endMs: 1_760_000_000_000 + (finished - i) * 900 - 100,
		})),
		recentOutput: Array.from({ length: Math.min(step, 8) }, (_, i) => `line ${step - i} of what it said so far`),
		toolCount: finished,
		requests: finished + 1,
		tokens: 4000 + finished * 900,
		contextTokens: 22000,
		contextWindow: 200000,
		cost: 0.01 * finished,
		durationMs: step * 150,
	};
}

const progressFrame = (progress: AgentProgress): SubagentFrame => ({
	type: "subagent_progress",
	payload: {
		index: progress.index,
		agent: progress.agent,
		agentSource: progress.agentSource,
		task: progress.task,
		assignment: progress.assignment,
		parentToolCallId: "call-task",
		progress,
	},
});

const lifecycleFrame = (id: string, status: "started" | "completed"): SubagentFrame => ({
	type: "subagent_lifecycle",
	payload: { id, agent: "explore", agentSource: "bundled", status, index: 0, parentToolCallId: "call-task" },
});

const taskUpdate = (progress: AgentProgress[], toolCallId = "call-task"): AgentSessionEvent => ({
	type: "tool_execution_update",
	toolCallId,
	toolName: "task",
	args: { agent: "explore" },
	partialResult: {
		content: [{ type: "text", text: "Running 2 agents..." }],
		details: { results: [], totalDurationMs: 1_000, progress },
	},
});

type Item = { frames: SubagentFrame[] } | { events: AgentSessionEvent[] };

/**
 * A parent's task call running two subagents, in the order stock reports them: an emit's frame first, then the
 * parent's update holding the latest snapshot of each running subagent. The last items are one batch of two updates and
 * a grandchild's own task update, which reaches the device as a `subagent_event`.
 */
function parallelRun(steps: number): Item[] {
	const items: Item[] = [{ frames: [lifecycleFrame("0-A", "started"), lifecycleFrame("1-B", "started")] }];
	let a = snapshot("0-A", 0);
	let b = snapshot("1-B", 0);
	for (let step = 1; step <= steps; step++) {
		a = snapshot("0-A", step);
		items.push({ frames: [progressFrame(a)] }, { events: [taskUpdate([a, b])] });
		b = snapshot("1-B", step + 1);
		items.push({ frames: [progressFrame(b)] }, { events: [taskUpdate([a, b])] });
	}
	const nested = (step: number): SubagentFrame => ({
		type: "subagent_event",
		payload: { id: "0-A", event: taskUpdate([snapshot("0-A.0-C", step)], "call-nested") },
	});
	items.push({ events: [taskUpdate([a, b]), taskUpdate([a, b])] });
	items.push({ frames: [nested(1), nested(2), nested(3)] });
	items.push({ frames: [lifecycleFrame("0-A", "completed"), lifecycleFrame("1-B", "completed")] });
	return items;
}

const framesOf = (items: Item[]): SubagentFrame[] => items.flatMap(item => ("frames" in item ? item.frames : []));
const eventsOf = (items: Item[]): AgentSessionEvent[] => items.flatMap(item => ("events" in item ? item.events : []));

/** The items through an encoder, JSON and a decoder, in order: what the host sends and the device's sidecar delivers. */
function carriedItems(
	items: Item[],
	options: { progress: boolean; decoder?: LinkEventDecoder },
): { frames: SubagentFrame[]; events: AgentSessionEvent[]; bytes: number } {
	const encoder = createLinkEventEncoder({ progress: options.progress });
	const decoder = options.decoder ?? createLinkEventDecoder();
	const out = { frames: [] as SubagentFrame[], events: [] as AgentSessionEvent[], bytes: 0 };
	for (const item of items) {
		if ("frames" in item) {
			for (const frame of item.frames) {
				const wire = overTheWire(encoder.subagentFrame(frame));
				out.bytes += JSON.stringify(wire).length;
				const decoded = decoder.subagentFrame(wire);
				if (decoded) out.frames.push(decoded);
			}
		} else {
			const wire = overTheWire(encoder.events(item.events));
			out.bytes += JSON.stringify(wire).length;
			out.events.push(...decoder.events(wire));
		}
	}
	return out;
}

describe("a subagent's progress snapshots", () => {
	const run = parallelRun(14);
	const raw = { frames: overTheWire(framesOf(run)), events: overTheWire(eventsOf(run)) };
	/** What each item costs as the host sends it today: one tab event a frame, one an events batch. */
	const rawBytes = run.reduce(
		(sum, item) =>
			sum +
			("frames" in item
				? item.frames.reduce((bytes, frame) => bytes + JSON.stringify(frame).length, 0)
				: JSON.stringify(item.events).length),
		0,
	);

	it("reach the device as the frames and updates its local sidecar would deliver", () => {
		const carried = carriedItems(run, { progress: true });
		expect(carried.frames).toEqual(raw.frames);
		expect(carried.events).toEqual(raw.events);
	});

	it("cost a fifth of the bytes or less", () => {
		const { bytes } = carriedItems(run, { progress: true });
		expect(bytes * 5, `${bytes} B against ${rawBytes} B`).toBeLessThan(rawBytes);
	});

	it("add almost nothing in the parent's update once the frame carried the same snapshot", () => {
		const encoder = createLinkEventEncoder({ progress: true });
		const current = snapshot("0-A", 4);
		encoder.subagentFrame(progressFrame(snapshot("0-A", 3)));
		encoder.subagentFrame(progressFrame(current));
		const update = taskUpdate([current]);
		expect(JSON.stringify(encoder.events([update])).length * 5).toBeLessThan(JSON.stringify([update]).length);
	});

	it("stay whole for a device that did not ask for them", () => {
		const carried = carriedItems(run, { progress: false });
		expect(carried.frames).toEqual(raw.frames);
		expect(carried.events).toEqual(raw.events);
		expect(carried.bytes).toBe(rawBytes);
	});

	it("are rebuilt by a device that kept an earlier link's snapshots, from an encoder that starts over", () => {
		const decoder = createLinkEventDecoder();
		carriedItems(run.slice(0, 20), { progress: true, decoder });
		const rest = run.slice(10);
		const carried = carriedItems(rest, { progress: true, decoder });
		expect(carried.frames).toEqual(overTheWire(framesOf(rest)));
		expect(carried.events).toEqual(overTheWire(eventsOf(rest)));
	});

	it("are never delivered half rebuilt: what a device has no earlier snapshot for is dropped", () => {
		const encoder = createLinkEventEncoder({ progress: true });
		const decoder = createLinkEventDecoder();
		const frames: SubagentFrame[] = [];
		const events: AgentSessionEvent[] = [];
		for (const [index, item] of run.entries()) {
			if ("frames" in item) {
				const wire = item.frames.map(frame => overTheWire(encoder.subagentFrame(frame)));
				if (index >= 12) frames.push(...wire);
			} else {
				const wire = overTheWire(encoder.events(item.events));
				if (index >= 12) events.push(...wire);
			}
		}
		const decodedFrames = frames.map(frame => decoder.subagentFrame(frame)).filter(frame => frame !== null);
		const decodedEvents = decoder.events(events);
		expect(decodedFrames.length).toBeLessThan(frames.length);
		expect(decodedEvents.length).toBeLessThan(events.length);
		for (const frame of decodedFrames) expect(raw.frames).toContainEqual(frame);
		for (const event of decodedEvents) expect(raw.events).toContainEqual(event);
	});

	it("pass an older host's whole snapshots through untouched", () => {
		const decoder = createLinkEventDecoder();
		const events = overTheWire(eventsOf(run));
		expect(decoder.events(events)).toBe(events);
		for (const frame of overTheWire(framesOf(run))) expect(decoder.subagentFrame(frame)).toBe(frame);
	});
});

describe("a connection's event sender", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function connection(options: { progress: boolean; failing?: number }) {
		const sent: Array<{ name: string; arg: unknown }> = [];
		const sender = createLinkEventSender({
			progress: options.progress,
			send: (name, arg) => {
				sent.push({ name, arg: overTheWire(arg) });
				return sent.length !== options.failing;
			},
		});
		return { sender, sent };
	}

	const frames = [
		progressFrame(snapshot("0-A", 1)),
		lifecycleFrame("1-B", "started"),
		progressFrame(snapshot("0-A", 2)),
	];

	it("sends the frames of one flush as one tab event, in order, and a device rebuilds them", () => {
		const { sender, sent } = connection({ progress: true });
		for (const frame of frames) sender.subagentFrame(frame);
		expect(sent).toEqual([]);
		vi.advanceTimersByTime(BATCH_INTERVAL_MS);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.name).toBe("subagentFrame");
		const decoder = createLinkEventDecoder();
		const arrived = (sent[0]?.arg as SubagentFrame[]).map(frame => decoder.subagentFrame(frame));
		expect(arrived).toEqual(overTheWire(frames));
	});

	it("sends the frames that came first before an events batch", () => {
		const { sender, sent } = connection({ progress: true });
		sender.subagentFrame(frames[0] as SubagentFrame);
		sender.events([{ type: "turn_start" }]);
		expect(sent.map(entry => entry.name)).toEqual(["subagentFrame", "events"]);
		vi.advanceTimersByTime(BATCH_INTERVAL_MS * 4);
		expect(sent).toHaveLength(2);
	});

	it("sends what is pending when asked to, and nothing again when the timer runs out", () => {
		const { sender, sent } = connection({ progress: true });
		sender.subagentFrame(frames[0] as SubagentFrame);
		sender.flush();
		expect(sent).toHaveLength(1);
		vi.advanceTimersByTime(BATCH_INTERVAL_MS * 4);
		expect(sent).toHaveLength(1);
	});

	it("sends each frame alone, whole and at once to a device that did not ask for progress batches", () => {
		const { sender, sent } = connection({ progress: false });
		for (const frame of frames) sender.subagentFrame(frame);
		expect(sent.map(entry => entry.arg)).toEqual(overTheWire(frames));
	});

	it("starts over after a send that failed, so a device that missed it still rebuilds what follows", () => {
		const { sender, sent } = connection({ progress: true, failing: 1 });
		sender.subagentFrame(progressFrame(snapshot("0-A", 1)));
		sender.flush();
		const next = progressFrame(snapshot("0-A", 2));
		sender.subagentFrame(next);
		sender.flush();
		const decoder = createLinkEventDecoder();
		const [delivered] = (sent[1]?.arg as SubagentFrame[]).map(frame => decoder.subagentFrame(frame));
		expect(delivered).toEqual(overTheWire(next));
	});

	it("sends nothing it dropped on disposal", () => {
		const { sender, sent } = connection({ progress: true });
		sender.subagentFrame(frames[0] as SubagentFrame);
		sender.dispose();
		vi.advanceTimersByTime(BATCH_INTERVAL_MS * 4);
		expect(sent).toEqual([]);
	});
});
