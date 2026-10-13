import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../shared/rpc-types";
import { createToolsStore } from "./tools";

function call(id: string, timestamp: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } }],
		timestamp,
	};
}

function result(id: string, timestamp: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: `${id} ok` }],
		isError: false,
		timestamp,
	};
}

/** The store after a full rebuild from `messages`: what a prepend must equal. */
function rebuilt(messages: AgentMessage[]) {
	const store = createToolsStore();
	store.getState().hydrateMessages(messages);
	return store.getState();
}

describe("prepending an older history page to the tools store", () => {
	const older = [call("a", 1), result("a", 2), call("b", 3)];
	const loaded = [call("c", 10), result("c", 11), call("d", 12), result("d", 13)];

	it("adds the page's entries as a rebuild would and keeps every loaded entry object", () => {
		const store = createToolsStore();
		store.getState().hydrateMessages(loaded);
		const before = store.getState();
		const loadedEntries = new Map(before.finishedTools);

		store.getState().prependMessages(older, loaded);

		const after = store.getState();
		const expected = rebuilt([...older, ...loaded]);
		expect([...after.finishedTools]).toEqual([...expected.finishedTools]);
		// What is on screen already does not re-render for a page above it.
		for (const [key, entry] of loadedEntries) expect(after.finishedTools.get(key)).toBe(entry);
		expect(after.hydrationVersion).toBe(before.hydrationVersion);
		expect(after.finishedVersion).toBeGreaterThan(before.finishedVersion);
		// An unanswered call of an older turn is terminal, never running.
		expect(after.finishedTools.get("b")?.status).toBe("aborted");
	});

	it.each([
		["a call id the loaded transcript already has", [call("c", 1), result("c", 2)], loaded],
		["a call answered in the loaded transcript", [call("e", 1)], [...loaded, result("e", 14)]],
		["a result for a call outside the page", [result("c", 1), call("a", 2), result("a", 3)], loaded],
	])("rebuilds from the whole transcript for %s", (_case, page, transcript) => {
		const store = createToolsStore();
		store.getState().hydrateMessages(transcript);
		const hydration = store.getState().hydrationVersion;

		store.getState().prependMessages(page, transcript);

		const expected = rebuilt([...page, ...transcript]);
		expect([...store.getState().finishedTools]).toEqual([...expected.finishedTools]);
		expect(store.getState().hydrationVersion).toBe(hydration + 1);
	});
});
