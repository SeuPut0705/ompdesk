import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentSessionEvent } from "../../shared/rpc-types";
import { createToolsStore } from "./tools";

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

describe("tools store history rebuild", () => {
	it("ends an unanswered call from a finished turn instead of spinning forever", () => {
		const store = createToolsStore();
		// A turn interrupted before the tool returned leaves the call in the
		// transcript with no result row. Reloading such a session used to render
		// every one of those cards as still running, with a live duration clock.
		store.getState().hydrateMessages([call("read:0")]);

		expect(store.getState().activeTools.get("read:0")).toMatchObject({
			status: "aborted",
			endTime: null,
		});
	});

	it("keeps only the trailing unanswered call live while the turn is streaming", () => {
		const store = createToolsStore();
		const messages = [call("first"), result("first"), call("last")];
		store.getState().hydrateMessages(messages, { turnIsLive: true });

		expect(store.getState().activeTools.get("first")).toMatchObject({ status: "done" });
		expect(store.getState().activeTools.get("last")).toMatchObject({ status: "running" });
	});

	it("aborts the trailing unanswered call once the session reports it is idle", () => {
		const store = createToolsStore();
		store.getState().hydrateMessages([call("first"), result("first"), call("last")], { turnIsLive: false });

		expect(store.getState().activeTools.get("last")).toMatchObject({ status: "aborted" });
	});

	it("promotes the aborted placeholder when a late execution event arrives", () => {
		const store = createToolsStore();
		store.getState().hydrateMessages([call("read:0")]);
		// Mid-run attach: hydrate saw no result yet, then the live events resume
		// for the same call. The card must switch to running, not duplicate.
		store.getState().applyEvents([start("read:0")]);

		expect(store.getState().activeTools.size).toBe(1);
		expect(store.getState().activeTools.get("read:0")).toMatchObject({ status: "running" });

		store.getState().applyEvents([
			{
				type: "tool_execution_end",
				toolCallId: "read:0",
				toolName: "read",
				result: { content: [] },
				isError: false,
			},
		]);
		expect(store.getState().activeTools.get("read:0")).toMatchObject({ status: "done" });
	});

	it("does not resurrect an already answered call", () => {
		const store = createToolsStore();
		store.getState().hydrateMessages([call("read:0"), result("read:0")]);
		store.getState().applyEvents([start("read:0")]);

		// The finished call keeps its result; the new event opens its own card.
		expect(store.getState().activeTools.size).toBe(2);
		expect(store.getState().activeTools.get("read:0")).toMatchObject({ status: "done" });
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

		const names = [...store.getState().activeTools.values()].map(entry => entry.toolName);
		expect(names).toEqual(["first", "second"]);
	});

	it("rebuilds stale cards from the transcript while keeping calls that changed during the fetch", () => {
		const store = createToolsStore();
		// Seen live before the tab was hidden; its end event was missed.
		store.getState().applyEvents([start("stale")]);
		const beforeFetch = store.getState().activeTools;
		// Live again while the transcript fetch is in flight.
		store.getState().applyEvents([start("fresh")]);

		store.getState().hydrateMessages([call("stale"), result("stale")], {
			turnIsLive: true,
			keepChangedSince: beforeFetch,
		});
		expect(store.getState().activeTools.get("stale")).toMatchObject({ status: "done" });
		expect(store.getState().activeTools.get("fresh")).toMatchObject({ status: "running" });

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
		expect(store.getState().activeTools.get("fresh")).toMatchObject({ status: "done" });
		expect(store.getState().activeTools.size).toBe(2);
	});
});
