import { beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage, AgentSessionEvent } from "../../shared/rpc-types";
import { createMessagesStore, mergeFetchedTranscript, useMessagesStore } from "./messages";

const streamingMessage: AgentMessage = {
	role: "assistant",
	content: [],
	timestamp: 1,
};

function delta(text: string): AgentSessionEvent {
	return {
		type: "message_update",
		message: streamingMessage,
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: text,
			partial: streamingMessage,
		},
	};
}

function userMessage(entryId: string): AgentMessage {
	return { role: "user", content: entryId, timestamp: Number(entryId.length), entryId };
}

beforeEach(() => useMessagesStore.getState().reset());

describe("older transcript pages", () => {
	it("prepends in transcript order and dedupes entry ids without a live-arrival signal", () => {
		const store = createMessagesStore();
		const newest = userMessage("newest");
		store.setState({ messages: [userMessage("middle"), newest], prevCursor: "older" });
		store.getState().prependPage({
			messages: [userMessage("first"), userMessage("first"), userMessage("second"), userMessage("middle")],
			totalMessages: 4,
		});
		expect(store.getState().messages.map(message => message.entryId)).toEqual([
			"first",
			"second",
			"middle",
			"newest",
		]);
		expect(store.getState().messages.at(-1)).toBe(newest);
		expect(store.getState().prevCursor).toBeUndefined();
		expect(store.getState().lastAppended).toEqual([]);
		store.getState().appendMessage(userMessage("live"));
		expect(store.getState().messages.at(-1)?.entryId).toBe("live");
	});
});

describe("messages streaming snapshots", () => {
	it("preserves the next reply and follow-up regardless of event batch boundaries", () => {
		const previous: AgentMessage = { role: "assistant", content: "previous", timestamp: 0, entryId: "previous" };
		const followUp: AgentMessage = { role: "user", content: "next request", timestamp: 2 };
		const events: AgentSessionEvent[] = [
			{ type: "message_end", message: previous },
			{ type: "agent_end", messages: [previous], isTerminal: false },
			{ type: "message_start", message: followUp },
			{ type: "message_end", message: followUp },
			{ type: "message_start", message: streamingMessage },
			delta("new reply"),
		];
		for (let cuts = 0; cuts < 2 ** (events.length - 1); cuts++) {
			const store = createMessagesStore();
			let start = 0;
			for (let end = 1; end <= events.length; end++) {
				if (end < events.length && !(cuts & (1 << (end - 1)))) continue;
				store.getState().applyEvents(events.slice(start, end));
				start = end;
			}
			expect(store.getState()).toMatchObject({
				messages: [previous],
				liveMessages: [followUp],
				streamingMessage,
				streamingText: "new reply",
			});
		}
	});

	it("starts a new stream from an empty buffer even when the start and delta share a batch", () => {
		useMessagesStore.setState({ streamingText: "old stream" });

		useMessagesStore.getState().applyEvents([{ type: "message_start", message: streamingMessage }, delta("new")]);

		expect(useMessagesStore.getState().streamingText).toBe("new");
	});

	it("keeps the assistant stream when an atomic background message arrives", () => {
		const notice: AgentMessage = {
			role: "custom",
			customType: "background",
			content: "Background task completed",
			timestamp: 2,
		};
		useMessagesStore
			.getState()
			.applyEvents([
				{ type: "message_start", message: streamingMessage },
				delta("Before "),
				{ type: "message_start", message: notice },
				{ type: "message_end", message: notice },
				delta("after"),
			]);
		expect(useMessagesStore.getState()).toMatchObject({
			streamingMessage,
			streamingText: "Before after",
			liveMessages: [notice],
		});
	});

	it("clears partial assistant buffers without deleting an optimistic user prompt", () => {
		const optimistic: AgentMessage = { role: "user", content: "send now", timestamp: 2, optimistic: true };
		useMessagesStore.getState().appendLiveMessage(optimistic);
		useMessagesStore.setState({
			streamingMessage,
			streamingText: "partial",
			streamingThinking: "thinking",
		});

		useMessagesStore.getState().clearStreaming();

		expect(useMessagesStore.getState().liveMessages).toEqual([optimistic]);
		expect(useMessagesStore.getState().streamingMessage).toBeNull();
	});
});

describe("attaching to a message already streaming", () => {
	// A background tab's frames are not forwarded, so after the user switches to
	// it mid-reply the first event it sees is a message_update, not message_start.
	function partialUpdate(timestamp: number, text: string, delta: string): AgentSessionEvent {
		const partial: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "plan" },
				{ type: "text", text },
			],
			timestamp,
		};
		return {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta, partial },
		};
	}

	it("adopts the in-flight message from the update's snapshot without doubling its delta", () => {
		const store = createMessagesStore();
		store.getState().applyEvents([partialUpdate(5, "Hello", "lo")]);
		expect(store.getState()).toMatchObject({
			streamingMessage: { role: "assistant", content: [], timestamp: 5 },
			streamingText: "Hello",
			streamingThinking: "plan",
		});

		store.getState().applyEvents([partialUpdate(5, "Hello!", "!")]);
		expect(store.getState().streamingText).toBe("Hello!");
	});

	it("replaces a stale stream left from a message that ended while the tab was away", () => {
		const store = createMessagesStore();
		store.getState().applyEvents([{ type: "message_start", message: streamingMessage }, delta("old reply")]);
		store.getState().applyEvents([partialUpdate(5, "New", "New")]);
		expect(store.getState()).toMatchObject({ streamingMessage: { timestamp: 5 }, streamingText: "New" });
	});
});

describe("committed transcript ownership", () => {
	it("keeps the original prompt when steering and follow-up deliveries join the same run", () => {
		const original: AgentMessage = { role: "user", content: [{ type: "text", text: "original" }], timestamp: 10 };
		useMessagesStore.getState().appendLiveMessage({ ...original, optimistic: true, optimisticAfterEntryId: null });
		useMessagesStore.getState().applyEvents([
			{ type: "message_end", message: { ...original, content: "expanded original", timestamp: 11 } },
			{ type: "message_end", message: { role: "user", content: "correction", steering: true, timestamp: 12 } },
			{ type: "message_end", message: { role: "user", content: "follow-up", timestamp: 13 } },
		]);
		expect(useMessagesStore.getState().liveMessages.map(message => message.content)).toEqual([
			"expanded original",
			"correction",
			"follow-up",
		]);
	});

	it("reconciles delivered messages without dropping another delivery sharing its timestamp", () => {
		const first: AgentMessage = { role: "assistant", content: "saved reply", timestamp: 20 };
		const next: AgentMessage = { ...first, content: "next reply" };
		useMessagesStore.getState().applyEvents([
			{ type: "message_end", message: first },
			{ type: "message_end", message: next },
		]);
		useMessagesStore.getState().reconcileFetched([{ ...first, entryId: "saved" }]);
		expect(useMessagesStore.getState().messages).toEqual([{ ...first, entryId: "saved" }]);
		expect(useMessagesStore.getState().liveMessages).toEqual([next]);
	});
	it("keeps message_end deliveries temporary and commits the turn once by entry id", () => {
		const optimistic: AgentMessage = {
			role: "user",
			content: "question",
			timestamp: 10,
			optimistic: true,
			optimisticAfterEntryId: null,
		};
		const user: AgentMessage = { role: "user", content: "question", timestamp: 10 };
		const assistant: AgentMessage = { role: "assistant", content: "answer", timestamp: 11 };
		useMessagesStore.getState().appendLiveMessage(optimistic);

		useMessagesStore.getState().applyEvents([{ type: "message_end", message: user }]);
		useMessagesStore.getState().applyEvents([{ type: "message_end", message: assistant }]);
		expect(useMessagesStore.getState().messages).toEqual([]);
		expect(useMessagesStore.getState().liveMessages).toEqual([
			{ ...user, optimistic: true, optimisticDelivered: true, optimisticAfterEntryId: null },
			assistant,
		]);

		useMessagesStore.getState().applyEvents([
			{
				type: "agent_end",
				messages: [
					{ ...user, entryId: "user-entry" },
					{ ...assistant, entryId: "assistant-entry" },
				],
			},
		]);

		expect(useMessagesStore.getState().messages).toEqual([
			{ ...user, entryId: "user-entry" },
			{ ...assistant, entryId: "assistant-entry" },
		]);
		expect(useMessagesStore.getState().liveMessages).toEqual([]);
	});

	it("upserts repeated or maintenance-rewritten settlements by entry id", () => {
		const first = userMessage("entry-1");
		useMessagesStore.getState().applyEvents([{ type: "agent_end", messages: [first] }]);
		const rewritten = { ...first, content: "rewritten" };
		useMessagesStore.getState().applyEvents([{ type: "agent_end", messages: [rewritten] }]);

		expect(useMessagesStore.getState().messages).toEqual([rewritten]);
	});

	it("does not erase a live response without a persisted replacement", () => {
		const transient: AgentMessage = { role: "custom", customType: "notice", content: "temporary", timestamp: 1 };
		useMessagesStore.getState().applyEvents([{ type: "message_end", message: transient }]);
		useMessagesStore.getState().applyEvents([{ type: "agent_end", messages: [transient] }]);

		expect(useMessagesStore.getState().messages).toEqual([]);
		expect(useMessagesStore.getState().liveMessages).toEqual([transient]);
	});
});

describe("late and replayed deliveries", () => {
	const read: AgentMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } }],
		timestamp: 30,
		usage: { output: 12 },
	};
	// The transcript and agent_end carry the bridge's read metadata; live message_end does not.
	const committedRead: AgentMessage = {
		...read,
		content: [
			{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts", __ompReadGroup: { path: "a.ts" } } },
		],
		entryId: "read-entry",
	};

	it("drops a message_end for a message the snapshot already holds", () => {
		const store = createMessagesStore();
		store.getState().reconcileFetched([committedRead]);
		const meter = store.getState().turnMeter;
		store.getState().applyEvents([
			{ type: "message_start", message: { ...read, content: [] } },
			{ type: "message_end", message: read },
		]);

		expect(store.getState().messages).toEqual([committedRead]);
		expect(store.getState().liveMessages).toEqual([]);
		expect(store.getState().streamingMessage).toBeNull();
		// Its tokens were counted once, when it first ended.
		expect(store.getState().turnMeter).toBe(meter);
	});

	it("delivers a replayed message_end once", () => {
		const store = createMessagesStore();
		store.getState().applyEvents([{ type: "message_end", message: read }]);
		store.getState().applyEvents([
			{ type: "message_end", message: read },
			{ type: "message_end", message: read },
		]);

		expect(store.getState().liveMessages).toEqual([read]);
	});

	it("never reopens the stream of a message that already ended", () => {
		const store = createMessagesStore();
		store.getState().applyEvents([{ type: "message_end", message: read }]);
		store.getState().applyEvents([
			{
				type: "message_update",
				message: read,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "late", partial: read },
			},
		]);

		expect(store.getState().streamingMessage).toBeNull();
		expect(store.getState().streamingText).toBe("");
	});

	it("still delivers a different message that shares the timestamp", () => {
		const store = createMessagesStore();
		const other: AgentMessage = { ...read, content: [{ type: "text", text: "other" }] };
		store.getState().applyEvents([
			{ type: "message_end", message: read },
			{ type: "message_end", message: other },
		]);

		expect(store.getState().liveMessages).toEqual([read, other]);
	});

	it("keeps the bridge's read metadata for the running turn until its messages commit", () => {
		const store = createMessagesStore();
		const metadata: Extract<AgentSessionEvent, { type: "read_group_metadata" }> = {
			type: "read_group_metadata",
			toolCallId: "r1",
			target: { path: "a.ts" },
		};
		store.getState().applyEvents([{ type: "message_end", message: read }, metadata]);
		expect(store.getState().readTargets.get("r1")).toEqual({ path: "a.ts" });
		const targets = store.getState().readTargets;
		store.getState().applyEvents([{ ...metadata, target: { path: "a.ts" } }]);
		expect(store.getState().readTargets).toBe(targets);

		store.getState().applyEvents([{ type: "agent_end", messages: [committedRead] }]);
		expect(store.getState().readTargets.size).toBe(0);
	});
});

describe("transcript hydration", () => {
	it("preserves a committed tail that arrived while the snapshot was in flight", () => {
		const a = userMessage("a");
		const before = [a];
		const b = userMessage("b");
		const current = [a, b];

		useMessagesStore.getState().reconcileFetched(mergeFetchedTranscript([a], before, current));
		expect(useMessagesStore.getState().messages).toEqual([a, b]);
	});

	it("preserves the tail when an existing committed row was replaced by the same entry id", () => {
		const a = userMessage("a");
		const b = userMessage("b");
		const refreshedA = { ...a, content: "refreshed" };
		const fetchedA = { ...a, content: "fetched" };

		expect(mergeFetchedTranscript([fetchedA], [a], [refreshedA, b])).toEqual([fetchedA, b]);
	});

	it("clears delivered live rows after idle hydration but preserves local echo", () => {
		const optimistic: AgentMessage = { role: "user", content: "pending", timestamp: 1, optimistic: true };
		const delivered: AgentMessage = { role: "assistant", content: "stale", timestamp: 2 };
		useMessagesStore.setState({ liveMessages: [optimistic, delivered] });

		useMessagesStore.getState().clearDeliveredLiveMessages();

		expect(useMessagesStore.getState().liveMessages).toEqual([optimistic]);
	});

	it("retires the live user echo when streaming hydration persists that turn", () => {
		const previous = userMessage("previous-entry");
		const optimistic: AgentMessage = {
			role: "user",
			content: "new question",
			timestamp: 2,
			optimistic: true,
			optimisticAfterEntryId: previous.entryId ?? null,
		};
		const delivered: AgentMessage = { role: "user", content: "new question", timestamp: 3 };
		const persisted = { ...delivered, entryId: "current-entry" };
		useMessagesStore.setState({ messages: [previous] });
		useMessagesStore.getState().appendLiveMessage(optimistic);
		useMessagesStore.getState().applyEvents([{ type: "message_end", message: delivered }]);

		useMessagesStore.getState().reconcileFetched([previous, persisted]);

		expect(useMessagesStore.getState().messages).toEqual([previous, persisted]);
		expect(useMessagesStore.getState().liveMessages).toEqual([]);
	});

	it("replaces a different persisted branch instead of guessing by content or timestamp", () => {
		const a = userMessage("a");
		useMessagesStore.setState({ messages: [a] });
		const next = userMessage("other");
		useMessagesStore.getState().reconcileFetched([next]);
		expect(useMessagesStore.getState().messages).toEqual([next]);
	});
});
