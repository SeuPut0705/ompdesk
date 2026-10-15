/**
 * Stress test for the event pipeline around snapshot loads: one stock run is
 * delivered with frames a transcript snapshot already holds arriving after it,
 * replayed frames, and the bridge's read metadata racing the stdout frames. In
 * every order the run must end as the run itself: one row per message, every
 * call settled, nothing left running.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentMessage, AgentSessionEvent, RpcCommand, RpcResponse } from "../../shared/rpc-types";
import { I18nProvider } from "../lib/i18n";
import { messageIdentity } from "../lib/message-identity";
import type { MessagesStore } from "../stores/messages";
import type { SessionStore } from "../stores/session";
import { sessionRuntimeStore, setFocusedSessionRuntime } from "../stores/session-runtime-context";
import { ensureTabRuntime } from "../stores/tab-runtime";
import { useTabsStore } from "../stores/tabs";
import { callIdOfEntryKey, selectToolEntry, type ToolsStore, toolEntryKey } from "../stores/tools";
import { hydrateTabSession, useRpcEvents } from "./use-rpc-events";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

type TabBatchHandler = (events: AgentSessionEvent[], tabId: string) => void;

// One run: a prompt, a read and a command in one assistant message, both results, the reply.
const user: AgentMessage = { role: "user", content: "go", timestamp: 100 };
const calls: AgentMessage = {
	role: "assistant",
	content: [
		{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
		{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } },
	],
	stopReason: "toolUse",
	usage: { output: 20 },
	timestamp: 101,
};
const readResult: AgentMessage = {
	role: "toolResult",
	toolCallId: "c1",
	toolName: "read",
	content: [{ type: "text", text: "a" }],
	isError: false,
	timestamp: 102,
};
const bashResult: AgentMessage = {
	role: "toolResult",
	toolCallId: "c2",
	toolName: "bash",
	content: [{ type: "text", text: "a.ts" }],
	isError: false,
	timestamp: 103,
};
const check: AgentMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "c3", name: "bash", arguments: { command: "wc -l a.ts" } }],
	stopReason: "toolUse",
	usage: { output: 8 },
	timestamp: 104,
};
const checkResult: AgentMessage = {
	role: "toolResult",
	toolCallId: "c3",
	toolName: "bash",
	content: [{ type: "text", text: "1 a.ts" }],
	isError: false,
	timestamp: 105,
};
const reply: AgentMessage = {
	role: "assistant",
	content: [{ type: "text", text: "done" }],
	stopReason: "stop",
	usage: { output: 4 },
	timestamp: 106,
};
const RUN = [user, calls, readResult, bashResult, check, checkResult, reply];

/** As the transcript and the enriched agent_end carry it: entry id, the bridge's read metadata. */
function committed(message: AgentMessage): AgentMessage {
	const content = Array.isArray(message.content)
		? message.content.map(block =>
				block.type === "toolCall" && block.name === "read"
					? { ...block, arguments: { ...block.arguments, __ompReadGroup: { path: "a.ts" } } }
					: block,
			)
		: message.content;
	return { ...message, content, entryId: `e${String(message.timestamp)}` };
}

function delivered(message: AgentMessage): AgentSessionEvent[] {
	return [
		{ type: "message_start", message: message.role === "assistant" ? { ...message, content: [] } : message },
		{ type: "message_end", message },
	];
}

function start(id: string, toolName: string, args: Record<string, unknown>): AgentSessionEvent {
	return { type: "tool_execution_start", toolCallId: id, toolName, args };
}

function progress(id: string, toolName: string, args: Record<string, unknown>): AgentSessionEvent {
	return { type: "tool_execution_update", toolCallId: id, toolName, args, partialResult: { content: [] } };
}

function end(result: AgentMessage): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId: result.toolCallId ?? "",
		toolName: result.toolName ?? "",
		result: { content: result.content },
		isError: false,
	};
}

function toolcallDelta(partial: AgentMessage, contentIndex: number, delta: string): AgentSessionEvent {
	return {
		type: "message_update",
		message: partial,
		assistantMessageEvent: { type: "toolcall_delta", contentIndex, delta, partial },
	};
}

const firstCall: AgentMessage = { ...calls, content: Array.isArray(calls.content) ? calls.content.slice(0, 1) : [] };
/** stdout, in stock's order: the two calls of the first turn run side by side. */
const STDOUT: AgentSessionEvent[] = [
	{ type: "agent_start" },
	...delivered(user),
	{ type: "turn_start" },
	{ type: "message_start", message: { ...calls, content: [] } },
	toolcallDelta(firstCall, 0, '{"path":'),
	toolcallDelta(calls, 1, '{"command":'),
	{ type: "message_end", message: calls },
	start("c1", "read", { path: "a.ts" }),
	start("c2", "bash", { command: "ls" }),
	progress("c1", "read", { path: "a.ts" }),
	end(readResult),
	...delivered(readResult),
	progress("c2", "bash", { command: "ls" }),
	end(bashResult),
	...delivered(bashResult),
	{ type: "turn_end" },
	{ type: "turn_start" },
	{ type: "message_start", message: { ...check, content: [] } },
	toolcallDelta(check, 0, '{"command":'),
	{ type: "message_end", message: check },
	start("c3", "bash", { command: "wc -l a.ts" }),
	progress("c3", "bash", { command: "wc -l a.ts" }),
	end(checkResult),
	...delivered(checkResult),
	{ type: "turn_end" },
	{ type: "turn_start" },
	{ type: "message_start", message: { ...reply, content: [] } },
	{
		type: "message_update",
		message: reply,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done", partial: reply },
	},
	{ type: "message_end", message: reply },
	{ type: "turn_end" },
	{ type: "agent_end", messages: RUN.map(committed) },
];
/** Lifecycle frames start or end runs; the pipeline never replays them. */
const REPLAYABLE: Partial<Record<AgentSessionEvent["type"], true>> = {
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	read_group_metadata: true,
	agent_end: true,
};

/** What omp reports after its first `cut` stdout frames: persisted messages and whether the run streams. */
function ompState(cut: number): { transcript: AgentMessage[]; isStreaming: boolean } {
	const sent = STDOUT.slice(0, cut);
	const transcript = RUN.filter(message =>
		sent.some(event => event.type === "message_end" && event.message === message),
	).map(committed);
	return {
		transcript,
		isStreaming: sent.some(event => event.type === "agent_start") && !sent.some(event => event.type === "agent_end"),
	};
}

function stateResponse(isStreaming: boolean): RpcResponse {
	return {
		type: "response",
		command: "get_state",
		success: true,
		data: {
			sessionId: "s1",
			sessionName: null,
			sessionFile: null,
			cwd: "/tmp",
			isStreaming,
			isCompacting: false,
			contextUsage: null,
			messageCount: 0,
			queuedMessageCount: 0,
			planModeEnabled: false,
			todoPhases: [],
		},
	};
}

function ok(command: string, data: unknown): RpcResponse {
	return { type: "response", command, success: true, data };
}

/** Small deterministic PRNG (mulberry32), so a failing seed reproduces. */
function random(seed: number): (below: number) => number {
	let state = seed >>> 0;
	return below => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * below);
	};
}

interface Delivery {
	event: AgentSessionEvent;
	/** The stdout frames omp had sent when this one went out. */
	sent: number;
}

/** The renderer's view: stdout in order, the bridge's metadata anywhere near its start, replays later. */
function schedule(next: (below: number) => number): Delivery[] {
	const deliveries: Delivery[] = STDOUT.map((event, index) => ({ event, sent: index + 1 }));
	const start = STDOUT.findIndex(event => event.type === "tool_execution_start" && event.toolCallId === "c1");
	const at = Math.max(1, start - 2 + next(6));
	deliveries.splice(at, 0, {
		event: { type: "read_group_metadata", toolCallId: "c1", target: { path: "a.ts" } },
		sent: deliveries[at - 1]?.sent ?? 0,
	});
	for (let replays = 1 + next(10); replays > 0; replays--) {
		const from = next(deliveries.length);
		const original = deliveries[from];
		if (!original || !REPLAYABLE[original.event.type]) continue;
		const to = from + 1 + next(deliveries.length - from);
		deliveries.splice(to, 0, { event: original.event, sent: deliveries[to - 1]?.sent ?? original.sent });
	}
	return deliveries;
}

let root: Root | undefined;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = undefined;
	useTabsStore.getState().reset();
	vi.restoreAllMocks();
});

function RpcEventsProbe() {
	useRpcEvents();
	return null;
}

it("ends every reordered and replayed delivery around snapshot loads as the run itself", async () => {
	let emit: TabBatchHandler = () => {};
	/** stdout frames omp has sent so far; the snapshot a held hydration reads. */
	let sent = 0;
	let hold: { cut: number; release: PromiseWithResolvers<void> } | null = null;
	const answer = async (command: RpcCommand): Promise<RpcResponse> => {
		const held = hold;
		const cut = held?.cut ?? sent;
		if (held && (command.type === "get_state" || command.type === "get_transcript_page")) {
			await held.release.promise;
		}
		const state = ompState(cut);
		switch (command.type) {
			case "get_state":
				return stateResponse(state.isStreaming);
			case "get_transcript_page":
				return ok(command.type, { messages: state.transcript, totalMessages: state.transcript.length });
			case "get_subagents":
				return ok(command.type, { subagents: [] });
			case "get_queue":
				return ok(command.type, { steering: [], followUp: [] });
			case "get_settings":
				return ok(command.type, { values: {} });
			default:
				return ok(command.type, { enabled: false });
		}
	};
	const noop = () => () => {};
	Reflect.set(window, "omp", {
		tabs: { list: async () => [], setActive: async () => true, setView: async () => true, close: async () => true },
		rpc: { commandForTab: (_tabId: string, command: RpcCommand) => answer(command) },
		events: {
			onTabBatch: (callback: TabBatchHandler) => {
				emit = callback;
				return () => {};
			},
			onTabSidecarStatus: noop,
			onTabSubagentFrame: noop,
			onTabModelCatalogUpdate: noop,
			onTabConfigUpdate: noop,
			onExtensionUi: noop,
			onSignInEnded: noop,
			onTabPromptResult: noop,
			onTabCommandOutput: noop,
			onTabSessionInfoUpdate: noop,
			onTabExtensionError: noop,
		},
		sidecar: { getStatus: async () => ({ status: "starting", cwd: "/tmp" }) },
		sessions: { consumePendingOpen: async () => null },
		system: { notify: () => {} },
		prefs: { get: async () => null, set: async () => {} },
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(<I18nProvider>{<RpcEventsProbe />}</I18nProvider>));

	for (let seed = 1; seed <= 400; seed++) {
		const next = random(seed);
		const tabId = `t-replay-${seed}`;
		useTabsStore.setState({
			tabs: [{ kind: "agent", id: tabId, cwd: "/tmp", status: "ready", unreadDone: false }],
			activeTabId: tabId,
		});
		ensureTabRuntime(tabId);
		setFocusedSessionRuntime(tabId);
		sessionRuntimeStore<SessionStore>(tabId, "session")?.setState({ sessionId: "s1", status: "ready" });
		sent = 0;

		const deliveries = schedule(next);
		const context = `seed ${seed}: ${deliveries.map(delivery => delivery.event.type).join(",")}`;
		const messagesStore = sessionRuntimeStore<MessagesStore>(tabId, "messages")!;
		const toolsStore = sessionRuntimeStore<ToolsStore>(tabId, "tools")!;
		/** Holds after every batch and every snapshot: one row and one entry per thing, none interrupted while the run lives. */
		const invariant = (step: string) => {
			const { messages, liveMessages } = messagesStore.getState();
			const identities = [...messages, ...liveMessages].map(messageIdentity);
			expect(new Set(identities).size, `${context} @${step}: rows ${identities.join(",")}`).toBe(identities.length);
			const { finishedTools, liveTools } = toolsStore.getState();
			const entries = [...finishedTools, ...liveTools];
			const callIds = entries.map(([key]) => callIdOfEntryKey(key));
			expect(new Set(callIds).size, `${context} @${step}: entries ${callIds.join(",")}`).toBe(callIds.length);
			if (ompState(sent).isStreaming) {
				const interrupted = entries.filter(([, entry]) => entry.status === "aborted").map(([key]) => key);
				expect(interrupted, `${context} @${step}: interrupted mid-run`).toEqual([]);
			}
		};
		let position = 0;
		const deliver = async (until: number) => {
			while (position < until) {
				const size = 1 + next(4);
				const batch = deliveries.slice(position, Math.min(until, position + size));
				position += batch.length;
				sent = Math.max(sent, ...batch.map(delivery => delivery.sent));
				await act(async () =>
					emit(
						batch.map(delivery => delivery.event),
						tabId,
					),
				);
				invariant(`batch ending ${position}`);
			}
		};
		// Up to three snapshot loads, each read by omp somewhere ahead of the renderer and
		// answered while more frames, and the frames it already holds, still arrive.
		for (let loads = 1 + next(3); loads > 0; loads--) {
			await deliver(position + next(deliveries.length - position + 1));
			// omp never reports less than it already did: this snapshot is at least as new as the last one.
			const cut = sent + next(STDOUT.length - sent + 1);
			sent = cut;
			hold = { cut, release: Promise.withResolvers<void>() };
			let hydration = Promise.resolve();
			await act(async () => {
				hydration = hydrateTabSession(tabId);
			});
			await deliver(position + next(deliveries.length - position + 1));
			hold.release.resolve();
			hold = null;
			await act(async () => hydration);
			invariant(`snapshot ${cut} at ${position}`);
		}
		await deliver(deliveries.length);

		const messages = messagesStore.getState();
		const tools = toolsStore.getState();
		// One row per message, all committed.
		const rows = [...messages.messages, ...messages.liveMessages];
		expect(rows.map(messageIdentity), context).toEqual(RUN.map(messageIdentity));
		expect(
			messages.messages.map(message => message.entryId),
			context,
		).toEqual(RUN.map(message => `e${String(message.timestamp)}`));
		expect(messages.streamingMessage, context).toBeNull();
		// Every call the transcript shows is settled; no entry is left running.
		expect(tools.liveTools.size, context).toBe(0);
		expect(tools.finishedTools.size, context).toBe(3);
		for (const message of messages.messages) {
			for (const block of Array.isArray(message.content) ? message.content : []) {
				if (block.type !== "toolCall") continue;
				const entry = selectToolEntry(tools, toolEntryKey(block));
				expect(entry?.status, `${context} ${block.id}`).toBe("done");
				if (block.id === "c1") expect(entry?.args.__ompReadGroup, context).toEqual({ path: "a.ts" });
			}
		}
	}
});
