import { describe, expect, it } from "vitest";
import type { StoreApi } from "zustand/vanilla";
import type { AgentMessage, AgentSessionEvent } from "../../shared/rpc-types";
import { createToolsStore, selectToolEntry, type ToolsStore } from "./tools";

function call(id: string, timestamp = 1): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } }],
		timestamp,
	};
}

function result(id: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 2,
	};
}

const start = (toolCallId: string): AgentSessionEvent => ({
	type: "tool_execution_start",
	toolCallId,
	toolName: "read",
	args: { path: `${toolCallId}.ts` },
});

const entryOf = (store: StoreApi<ToolsStore>, key: string) => selectToolEntry(store.getState(), key);
const entryCount = (state: ToolsStore) => state.finishedTools.size + state.liveTools.size;

describe("stock read metadata ordering", () => {
	it.each([true, false])("joins bridge metadata before or after execution start: %s", before => {
		const store = createToolsStore();
		const metadata: AgentSessionEvent = {
			type: "read_group_metadata",
			toolCallId: "read-1",
			target: { path: "https://example.com" },
		};
		store.getState().applyEvents(before ? [metadata, start("read-1")] : [start("read-1"), metadata]);
		expect(entryOf(store, "read-1")?.args.__ompReadGroup).toEqual({ path: "https://example.com" });
	});
	it("joins metadata that arrives before the call's message ends", () => {
		const store = createToolsStore();
		store.getState().applyEvents([
			{ type: "read_group_metadata", toolCallId: "read-1", target: { path: "read-1.ts" } },
			{ type: "message_end", message: call("read-1", 3) },
		]);
		expect(entryOf(store, "read-1")?.args.__ompReadGroup).toEqual({ path: "read-1.ts" });
		store.getState().applyEvents([start("read-1")]);
		expect(entryOf(store, "read-1")?.args.__ompReadGroup).toEqual({ path: "read-1.ts" });
	});
	it("preserves transcript metadata when execution begins after hydration", () => {
		const store = createToolsStore();
		const message: AgentMessage = {
			role: "assistant",
			timestamp: 1,
			content: [
				{
					type: "toolCall",
					id: "read-1",
					name: "read",
					arguments: { path: "read-1.ts", __ompReadGroup: { path: "read-1.ts" } },
				},
			],
		};
		store.getState().hydrateMessages([message], { turnIsLive: true });
		store.getState().applyEvents([start("read-1")]);
		expect(entryOf(store, "read-1")?.args.__ompReadGroup).toEqual({ path: "read-1.ts" });
	});
});

describe("tools store history rebuild", () => {
	it("ends an unanswered call from a finished turn instead of spinning forever", () => {
		const store = createToolsStore();
		// A turn interrupted before the tool returned leaves the call in the
		// transcript with no result row. Reloading such a session used to render
		// every one of those cards as still running, with a live duration clock.
		store.getState().hydrateMessages([call("read:0")]);

		expect(entryOf(store, "read:0")).toMatchObject({
			status: "aborted",
			endTime: null,
		});
	});

	it("keeps only the trailing unanswered call live while the turn is streaming", () => {
		const store = createToolsStore();
		const messages = [call("first"), result("first"), call("last")];
		store.getState().hydrateMessages(messages, { turnIsLive: true });

		expect(entryOf(store, "first")).toMatchObject({ status: "done" });
		expect(entryOf(store, "last")).toMatchObject({ status: "running" });
	});

	it("aborts the trailing unanswered call once the session reports it is idle", () => {
		const store = createToolsStore();
		store.getState().hydrateMessages([call("first"), result("first"), call("last")], { turnIsLive: false });

		expect(entryOf(store, "last")).toMatchObject({ status: "aborted" });
	});

	it("promotes the aborted placeholder when a late execution event arrives", () => {
		const store = createToolsStore();
		store.getState().hydrateMessages([call("read:0")]);
		// Mid-run attach: hydrate saw no result yet, then the live events resume
		// for the same call. The card must switch to running, not duplicate.
		store.getState().applyEvents([start("read:0")]);

		expect(entryCount(store.getState())).toBe(1);
		expect(entryOf(store, "read:0")).toMatchObject({ status: "running" });

		store.getState().applyEvents([
			{
				type: "tool_execution_end",
				toolCallId: "read:0",
				toolName: "read",
				result: { content: [] },
				isError: false,
			},
		]);
		expect(entryOf(store, "read:0")).toMatchObject({ status: "done" });
	});

	it("does not resurrect an already answered call", () => {
		const store = createToolsStore();
		store.getState().hydrateMessages([call("read:0"), result("read:0")]);
		// A start with no message_end of its own is late behind the snapshot that holds the
		// result, or a replay: a new call with a reused id ends its message first.
		store.getState().applyEvents([
			start("read:0"),
			{
				type: "tool_execution_end",
				toolCallId: "read:0",
				toolName: "read",
				result: { content: [] },
				isError: false,
			},
		]);

		expect(entryCount(store.getState())).toBe(1);
		expect(store.getState().liveTools.size).toBe(0);
		expect(entryOf(store, "read:0")).toMatchObject({ status: "done", endTime: 2 });
	});

	it("opens a new card for a reused id once its own message ends", () => {
		const store = createToolsStore();
		store.getState().hydrateMessages([call("read:0"), result("read:0")]);
		store.getState().applyEvents([{ type: "message_end", message: call("read:0", 5) }, start("read:0")]);

		expect(entryCount(store.getState())).toBe(2);
		expect(entryOf(store, "read:0")).toMatchObject({ status: "done" });
		expect(store.getState().liveTools.size).toBe(1);
	});
});

describe("tools store behind a snapshot", () => {
	const end = (toolCallId: string): AgentSessionEvent => ({
		type: "tool_execution_end",
		toolCallId,
		toolName: "read",
		result: { content: [] },
		isError: false,
	});

	it("keeps one entry when the call's message_end arrives after a snapshot that holds it", () => {
		const store = createToolsStore();
		const message = call("wait", 5);
		// The snapshot holds the running call (the turn is live); the batch behind it then
		// delivers the same call's end and execution.
		store.getState().hydrateMessages([{ ...message, entryId: "e5" }], { turnIsLive: true, keepChangedSince: 0 });
		store.getState().applyEvents([{ type: "message_end", message }, start("wait")]);
		expect(entryCount(store.getState())).toBe(1);
		expect(entryOf(store, "wait")).toMatchObject({ status: "running" });

		store.getState().applyEvents([end("wait")]);
		expect(entryCount(store.getState())).toBe(1);
		expect(store.getState().liveTools.size).toBe(0);
		expect(entryOf(store, "wait")).toMatchObject({ status: "done" });
	});

	it("delivers a replayed call stream once", () => {
		const store = createToolsStore();
		const message = call("r1", 5);
		const run: AgentSessionEvent[] = [{ type: "message_end", message }, start("r1"), end("r1")];
		store.getState().applyEvents(run);
		const settled = entryOf(store, "r1");
		store.getState().applyEvents([...run, ...run]);

		expect(entryCount(store.getState())).toBe(1);
		expect(store.getState().liveTools.size).toBe(0);
		// The replay changes neither the result nor the timing.
		expect(entryOf(store, "r1")).toBe(settled);
	});

	it("joins read metadata to a call the snapshot does not hold yet", () => {
		const store = createToolsStore();
		store.getState().applyEvents([{ type: "read_group_metadata", toolCallId: "r2", target: { path: "r2.ts" } }]);
		// The snapshot was read before the call's message ended.
		store.getState().hydrateMessages([call("r1", 1), result("r1")], {
			turnIsLive: true,
			keepChangedSince: store.getState().revision,
		});
		store.getState().applyEvents([{ type: "message_end", message: call("r2", 3) }, start("r2")]);

		expect(entryOf(store, "r2")?.args.__ompReadGroup).toEqual({ path: "r2.ts" });
	});

	it("keeps a parallel call running while its sibling's result is already committed", () => {
		const store = createToolsStore();
		const parallel: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "a", name: "read", arguments: {} },
				{ type: "toolCall", id: "b", name: "bash", arguments: {} },
			],
			timestamp: 1,
		};
		store.getState().hydrateMessages([parallel, result("a")], { turnIsLive: true });

		expect(entryOf(store, "a")).toMatchObject({ status: "done" });
		// Not interrupted: it answers after its sibling.
		expect(entryOf(store, "b")).toMatchObject({ status: "running" });
	});

	it("keeps a result reported live when the snapshot does not hold its result message yet", () => {
		const store = createToolsStore();
		const message = call("w", 5);
		store.getState().applyEvents([{ type: "message_end", message }, start("w"), end("w")]);
		// Read between the end event and the result message stock persists right after it.
		store.getState().hydrateMessages([message], { turnIsLive: true, keepChangedSince: store.getState().revision });

		expect(entryOf(store, "w")).toMatchObject({ status: "done" });
		expect(store.getState().liveTools.size).toBe(0);
		// A replayed start of that call still changes nothing.
		store.getState().applyEvents([start("w")]);
		expect(entryCount(store.getState())).toBe(1);
		expect(entryOf(store, "w")).toMatchObject({ status: "done" });
	});
});

describe("tools store across a hidden stretch", () => {
	const toolcallDelta = (id: string, timestamp: number): AgentSessionEvent => {
		const partial: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id, name: id, arguments: {} }],
			timestamp,
		};
		return {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{", partial },
		};
	};

	it("opens a new card for the next message's call when its message_start was missed", () => {
		const store = createToolsStore();
		store
			.getState()
			.applyEvents([
				{ type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } },
				toolcallDelta("first", 1),
			]);
		// The tab went to the background: message_end of the first message and
		// message_start of the next never arrived. The next call streams at the
		// same content index.
		store.getState().applyEvents([toolcallDelta("second", 2)]);

		const names = [...store.getState().liveTools.values()].map(entry => entry.toolName);
		expect(names).toEqual(["first", "second"]);
	});

	it("rebuilds stale cards from the transcript while keeping calls that changed during the fetch", () => {
		const store = createToolsStore();
		// Seen live before the tab was hidden; its end event was missed.
		store.getState().applyEvents([start("stale")]);
		const beforeFetch = store.getState().revision;
		// Live again while the transcript fetch is in flight.
		store.getState().applyEvents([start("fresh")]);

		store.getState().hydrateMessages([call("stale"), result("stale")], {
			turnIsLive: true,
			keepChangedSince: beforeFetch,
		});
		expect(entryOf(store, "stale")).toMatchObject({ status: "done" });
		expect(entryOf(store, "fresh")).toMatchObject({ status: "running" });

		// The kept call still resolves through its live route.
		store.getState().applyEvents([
			{
				type: "tool_execution_end",
				toolCallId: "fresh",
				toolName: "read",
				result: { content: [] },
				isError: false,
			},
		]);
		expect(entryOf(store, "fresh")).toMatchObject({ status: "done" });
		expect(entryCount(store.getState())).toBe(2);
	});
});

describe("tools store layout", () => {
	const update = (toolCallId: string, text: string): AgentSessionEvent => ({
		type: "tool_execution_update",
		toolCallId,
		toolName: "read",
		args: {},
		partialResult: { content: [{ type: "text", text }] },
	});
	const end = (toolCallId: string, result: unknown, isError = false): AgentSessionEvent => ({
		type: "tool_execution_end",
		toolCallId,
		toolName: "read",
		result,
		isError,
	});
	const committed = (id: string, text: string): AgentMessage => ({
		...result(id),
		content: [{ type: "text", text }],
		details: { lines: 1 },
		entryId: `e-${id}-${text}`,
	});
	function envelope(value: unknown): { content: unknown; details: unknown } {
		if (value === null || typeof value !== "object" || !("content" in value) || !("details" in value)) {
			throw new Error("not a {content, details} result");
		}
		return { content: value.content, details: value.details };
	}

	it("keeps both entry maps and the finished version untouched by a tool update", () => {
		const store = createToolsStore();
		store.getState().hydrateMessages([call("old"), result("old")]);
		store.getState().applyEvents([start("run")]);
		const before = store.getState();

		store.getState().applyEvents([update("run", "one"), update("run", "two")]);

		const after = store.getState();
		expect(after.finishedTools).toBe(before.finishedTools);
		expect(after.finishedVersion).toBe(before.finishedVersion);
		expect(after.liveTools).toBe(before.liveTools);
		expect(after.partialResults.get("run")).toEqual({ content: [{ type: "text", text: "two" }] });
	});

	it("finishes a call into the same finished map instead of copying it", () => {
		const store = createToolsStore();
		store.getState().hydrateMessages([call("old"), result("old")]);
		store.getState().applyEvents([start("run")]);
		const before = store.getState();

		store.getState().applyEvents([end("run", { content: [] })]);

		const after = store.getState();
		expect(after.finishedTools).toBe(before.finishedTools);
		expect(after.finishedVersion).toBeGreaterThan(before.finishedVersion);
		expect(after.finishedTools.get("run")).toMatchObject({ status: "done" });
		expect(after.finishedTools.get("old")).toMatchObject({ status: "done" });
	});

	it("holds exactly the pending and running calls in the live set", () => {
		const store = createToolsStore();
		const liveKeys = () => [...store.getState().liveTools.keys()];
		const assistant: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "a", name: "read", arguments: { path: "a.ts" } }],
			timestamp: 1,
		};
		store.getState().applyEvents([
			{ type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } },
			{
				type: "message_update",
				message: assistant,
				assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{", partial: assistant },
			},
		]);
		expect(liveKeys()).toEqual(["a"]);
		expect(entryOf(store, "a")).toMatchObject({ status: "pending" });

		store.getState().applyEvents([{ type: "message_end", message: assistant }, start("a"), start("b")]);
		expect(liveKeys()).toEqual(["a", "b"]);
		expect(store.getState().finishedTools.size).toBe(0);

		store.getState().applyEvents([update("a", "partial")]);
		expect(liveKeys()).toEqual(["a", "b"]);

		store.getState().applyEvents([end("a", { content: [] }), end("b", { content: [] }, true)]);
		expect(liveKeys()).toEqual([]);
		expect(entryOf(store, "a")).toMatchObject({ status: "done" });
		expect(entryOf(store, "b")).toMatchObject({ status: "error" });

		// Abort: the run stops while a call is in flight, and the idle rebuild
		// settles it as interrupted.
		store.getState().applyEvents([start("c")]);
		expect(liveKeys()).toEqual(["c"]);
		store.getState().hydrateMessages([call("c")], { turnIsLive: false, keepChangedSince: store.getState().revision });
		expect(liveKeys()).toEqual([]);
		expect(store.getState().finishedTools.get("c")).toMatchObject({ status: "aborted" });

		// A late execution event moves the interrupted card back into the live set.
		store.getState().applyEvents([start("c")]);
		expect(liveKeys()).toEqual(["c"]);
		expect(store.getState().finishedTools.has("c")).toBe(false);
	});

	it("points finished entries at the committed result messages after agent_end", () => {
		const store = createToolsStore();
		const eventResult = { content: [{ type: "text", text: "big output" }], details: { lines: 1 } };
		store.getState().applyEvents([start("run"), update("run", "partial"), end("run", eventResult)]);
		expect(entryOf(store, "run")?.result).toBe(eventResult);

		const message = committed("run", "big output");
		store.getState().applyEvents([{ type: "agent_end", messages: [call("run"), message] }]);

		const swapped = entryOf(store, "run")?.result;
		expect(swapped).not.toBe(eventResult);
		expect(envelope(swapped).content).toBe(message.content);
		expect(envelope(swapped).details).toBe(message.details);
		expect(store.getState().partialResults.size).toBe(0);
	});

	it("matches committed results from the newest end backwards when early ends were missed", () => {
		const store = createToolsStore();
		// The tab was in the background for the run's first `read:0`; it saw only
		// the second occurrence of the provider's reused id.
		store.getState().applyEvents([start("read:0"), end("read:0", { content: [{ type: "text", text: "second" }] })]);

		const first = committed("read:0", "first");
		const second = committed("read:0", "second");
		store.getState().applyEvents([{ type: "agent_end", messages: [call("read:0"), first, call("read:0"), second] }]);

		expect(envelope(entryOf(store, "read:0")?.result).content).toBe(second.content);
	});

	it("keeps the event result when the run's result was never committed", () => {
		const store = createToolsStore();
		const eventResult = { content: [] };
		store.getState().applyEvents([start("run"), end("run", eventResult)]);

		store.getState().applyEvents([{ type: "agent_end", messages: [{ ...result("run"), entryId: undefined }] }]);

		expect(entryOf(store, "run")?.result).toBe(eventResult);
	});
});
