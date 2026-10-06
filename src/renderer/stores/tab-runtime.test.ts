import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentMessage, RpcCommand, RpcResponse } from "../../shared/rpc-types";
import { type ComposerStore, useComposerStore } from "./composer";
import { type MessagesStore, useMessagesStore } from "./messages";
import type { SessionStore } from "./session";
import {
	deleteSessionRuntime,
	sessionRuntimeStore,
	setFocusedSessionRuntime,
	withSessionRuntime,
} from "./session-runtime-context";
import { createTabRuntime, replaceTabRuntime } from "./tab-runtime";
import type { ToolsStore } from "./tools";

beforeAll(() => {
	(globalThis as { window?: unknown }).window = {
		omp: {
			rpc: {
				commandForTab: vi.fn(
					async (_tabId: string, command: RpcCommand): Promise<RpcResponse> => ({
						type: "response",
						command: command.type,
						success: true,
						data: {},
					}),
				),
			},
		},
	};
});

afterEach(() => {
	vi.restoreAllMocks();
	deleteSessionRuntime("tab-a");
	deleteSessionRuntime("tab-b");
	setFocusedSessionRuntime(null);
});

function toolMessages(path: string, result: string): AgentMessage[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "shared-id", name: "read", arguments: { path } }],
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolCallId: "shared-id",
			toolName: "read",
			content: [{ type: "text", text: result }],
			isError: false,
			timestamp: 2,
		},
	];
}

describe("tab session runtimes", () => {
	it("keeps drafts, transcripts, and overlapping tool-call ids isolated per visible session", () => {
		createTabRuntime("tab-a");
		createTabRuntime("tab-b");
		const composerA = sessionRuntimeStore<ComposerStore>("tab-a", "composer")!;
		const composerB = sessionRuntimeStore<ComposerStore>("tab-b", "composer")!;
		const messagesA = sessionRuntimeStore<MessagesStore>("tab-a", "messages")!;
		const messagesB = sessionRuntimeStore<MessagesStore>("tab-b", "messages")!;
		const toolsA = sessionRuntimeStore<ToolsStore>("tab-a", "tools")!;
		const toolsB = sessionRuntimeStore<ToolsStore>("tab-b", "tools")!;

		composerA.getState().setDraft("draft A");
		composerB.getState().setDraft("draft B");
		messagesA.getState().appendMessage({ role: "user", content: "message A", timestamp: 1 });
		messagesB.getState().appendMessage({ role: "user", content: "message B", timestamp: 1 });
		toolsA.getState().hydrateMessages(toolMessages("/a", "result A"));
		toolsB.getState().hydrateMessages(toolMessages("/b", "result B"));

		expect(withSessionRuntime("tab-a", () => useComposerStore.getState().draft)).toBe("draft A");
		expect(withSessionRuntime("tab-b", () => useComposerStore.getState().draft)).toBe("draft B");
		expect(messagesA.getState().messages[0]?.content).toBe("message A");
		expect(messagesB.getState().messages[0]?.content).toBe("message B");
		expect(toolsA.getState().activeTools.get("shared-id")).toMatchObject({
			args: { path: "/a" },
			result: { content: [{ type: "text", text: "result A" }] },
		});
		expect(toolsB.getState().activeTools.get("shared-id")).toMatchObject({
			args: { path: "/b" },
			result: { content: [{ type: "text", text: "result B" }] },
		});
	});
});

describe("scoped store subscribe", () => {
	it("follows focus switches silently — no synthetic cross-store call, no stale-store leak", () => {
		createTabRuntime("tab-a");
		createTabRuntime("tab-b");
		setFocusedSessionRuntime("tab-a");
		const seen: string[] = [];
		const unsubscribe = useMessagesStore.subscribe(state => {
			const last = state.lastAppended[0];
			if (last) seen.push(String(last.content));
		});

		// A focus switch must NOT synthesize a (newState, oldState) listener
		// call — diffing subscribers (voice auto-speak) would read the newly
		// focused tab's history as a fresh transition.
		setFocusedSessionRuntime("tab-b");
		expect(seen).toEqual([]);

		// Updates from the newly focused store flow...
		sessionRuntimeStore<MessagesStore>("tab-b", "messages")!
			.getState()
			.appendMessage({ role: "user", content: "b-1", timestamp: 1 });
		expect(seen).toEqual(["b-1"]);

		// ...while the abandoned store no longer reaches the listener.
		sessionRuntimeStore<MessagesStore>("tab-a", "messages")!
			.getState()
			.appendMessage({ role: "user", content: "a-1", timestamp: 2 });
		expect(seen).toEqual(["b-1"]);

		// Cleanup detaches from whichever store is currently followed.
		unsubscribe();
		sessionRuntimeStore<MessagesStore>("tab-b", "messages")!
			.getState()
			.appendMessage({ role: "user", content: "b-2", timestamp: 3 });
		expect(seen).toEqual(["b-1"]);
	});
});

it("rejects late snapshots after an in-place session replacement and tab closure", async () => {
	const runtime = createTabRuntime("tab-a");
	const state = sessionRuntimeStore<SessionStore>("tab-a", "session")!;
	state.setState({ sessionId: "old-session" });
	const first = Promise.withResolvers<RpcResponse>();
	const second = Promise.withResolvers<RpcResponse>();
	const spy = vi
		.spyOn(window.omp.rpc, "commandForTab")
		.mockReturnValueOnce(first.promise)
		.mockReturnValueOnce(second.promise);
	try {
		const old = runtime.command({ type: "get_settings" });
		state.setState({ sessionId: "replacement" });
		first.resolve({ type: "response", command: "get_settings", success: true, data: { values: { old: true } } });
		expect(await old).toMatchObject({ success: false });
		const closing = runtime.command({ type: "get_state" });
		deleteSessionRuntime("tab-a");
		second.resolve({ type: "response", command: "get_state", success: true, data: {} });
		expect(await closing).toMatchObject({ success: false });
		expect(state.getState().sessionId).toBe("replacement");
	} finally {
		spy.mockRestore();
	}
});

it("does not deliver an old view's command to the replacement session", async () => {
	const old = createTabRuntime("tab-a");
	const replacement = replaceTabRuntime("tab-a");
	let enabled = false;
	vi.spyOn(window.omp.rpc, "commandForTab").mockImplementation(async (_tabId, command) => {
		if (command.type === "set_setting") enabled = command.value === true;
		return { type: "response", command: command.type, success: true, data: {} };
	});

	expect(await old.command({ type: "set_setting", path: "compaction.enabled", value: true })).toMatchObject({
		success: false,
	});
	expect(enabled).toBe(false);
	expect(await replacement.command({ type: "set_setting", path: "compaction.enabled", value: true })).toMatchObject({
		success: true,
	});
	expect(enabled).toBe(true);
});

it("preserves a committed session change acknowledgement when its metadata arrives before the response", async () => {
	const runtime = createTabRuntime("tab-a");
	vi.spyOn(window.omp.rpc, "commandForTab").mockImplementation(async (_tabId, command) => {
		if (command.type === "new_session") {
			replaceTabRuntime("tab-a");
			sessionRuntimeStore<SessionStore>("tab-a", "session")?.setState({ sessionId: "committed-session" });
		}
		return { type: "response", command: command.type, success: true, data: { cancelled: false } };
	});

	expect(await runtime.command({ type: "new_session" })).toMatchObject({ success: true, data: { cancelled: false } });
	expect(sessionRuntimeStore<SessionStore>("tab-a", "session")?.getState().sessionId).toBe("committed-session");
});
