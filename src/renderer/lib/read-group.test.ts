/**
 * Contract tests for read-tool grouping (plan/17 §7.4): the collapse
 * predicate, break rules, cross-message accretion, selector split, and
 * same-file merge. These pin the TUI read-tool-group semantics the GUI port
 * must replicate, independent of the render layer.
 */
import { describe, expect, it } from "vitest";
import type { AgentMessage, MessageContent } from "../../shared/rpc-types";
import { useToolsStore } from "../stores/tools";
import { collapsibleReadTarget, groupReadRows, mergeReadGroupEntries } from "./read-group";

function assistant(...blocks: MessageContent[]): AgentMessage {
	return { role: "assistant", content: blocks, timestamp: 1 };
}
function readCall(id: string, path: string) {
	return { type: "toolCall" as const, id, name: "read", arguments: { path } };
}
function bashCall(id: string) {
	return { type: "toolCall" as const, id, name: "bash", arguments: { command: "ls" } };
}
function text(value: string) {
	return { type: "text" as const, text: value };
}
function thinking(value: string) {
	return { type: "thinking" as const, thinking: value };
}

describe("collapsibleReadTarget", () => {
	it("collapses plain fs paths and xd:// targets", () => {
		expect(collapsibleReadTarget({ path: "src/a.ts" })).toEqual({ path: "src/a.ts" });
		expect(collapsibleReadTarget({ path: "xd://lsp" })).toEqual({ path: "xd://lsp" });
	});

	it("does not collapse scheme URLs the router handles", () => {
		expect(collapsibleReadTarget({ path: "skill://agent-reach" })).toBeNull();
		expect(collapsibleReadTarget({ path: "agent://abc" })).toBeNull();
		expect(collapsibleReadTarget({ path: "memory://m" })).toBeNull();
	});

	it("splits numeric selector suffixes", () => {
		expect(collapsibleReadTarget({ path: "src/a.ts:50" })).toEqual({ path: "src/a.ts", selector: "50" });
		expect(collapsibleReadTarget({ path: "src/a.ts:5-16,960-973" })).toEqual({
			path: "src/a.ts",
			selector: "5-16,960-973",
		});
		expect(collapsibleReadTarget({ path: "src/a.ts:50+150" })).toEqual({ path: "src/a.ts", selector: "50+150" });
	});

	it("keeps scheme colons out of the selector split", () => {
		expect(collapsibleReadTarget({ path: "xd://lsp" })).toEqual({ path: "xd://lsp" });
	});

	it("tolerates the legacy file_path alias and rejects missing paths", () => {
		expect(collapsibleReadTarget({ file_path: "src/b.ts" })).toEqual({ path: "src/b.ts" });
		expect(collapsibleReadTarget({})).toBeNull();
		expect(collapsibleReadTarget(null)).toBeNull();
	});
});

describe("groupReadRows", () => {
	it("groups consecutive reads across assistant messages", () => {
		const rows = [
			{ kind: "message" as const, message: assistant(readCall("r1", "a.ts"), readCall("r2", "b.ts")) },
			{ kind: "message" as const, message: assistant(readCall("r3", "c.ts")) },
		];
		const grouped = groupReadRows(rows);
		expect(grouped).toHaveLength(1);
		expect(grouped[0]?.kind).toBe("readGroup");
		if (grouped[0]?.kind === "readGroup") {
			expect(grouped[0].entries.map(entry => entry.callId)).toEqual(["r1", "r2", "r3"]);
		}
	});

	it("keeps remaining visible content in the trimmed message", () => {
		const rows = [{ kind: "message" as const, message: assistant(readCall("r1", "a.ts"), text("explanation")) }];
		const grouped = groupReadRows(rows);
		expect(grouped.map(row => row.kind)).toEqual(["readGroup", "message"]);
		const message = grouped[1]?.kind === "message" ? grouped[1].message : undefined;
		expect(Array.isArray(message?.content) && message.content).toHaveLength(1);
	});

	it("breaks the run on visible text between reads", () => {
		const rows = [
			{ kind: "message" as const, message: assistant(readCall("r1", "a.ts")) },
			{ kind: "message" as const, message: assistant(text("note")) },
			{ kind: "message" as const, message: assistant(readCall("r2", "b.ts")) },
		];
		const grouped = groupReadRows(rows);
		expect(grouped.map(row => row.kind)).toEqual(["readGroup", "message", "readGroup"]);
	});

	it("breaks the run on a non-read tool card", () => {
		const rows = [
			{
				kind: "message" as const,
				message: assistant(readCall("r1", "a.ts"), bashCall("b1"), readCall("r2", "b.ts")),
			},
		];
		const grouped = groupReadRows(rows);
		// bash seals the first run; r2 starts a NEW group after the bash card —
		// it does not stay inline in the trimmed message.
		expect(grouped.map(row => row.kind)).toEqual(["readGroup", "message", "readGroup"]);
		if (grouped[0]?.kind === "readGroup") expect(grouped[0].entries.map(entry => entry.callId)).toEqual(["r1"]);
		if (grouped[2]?.kind === "readGroup") expect(grouped[2].entries.map(entry => entry.callId)).toEqual(["r2"]);
		const content = grouped[1]?.kind === "message" ? grouped[1].message.content : [];
		expect(
			Array.isArray(content) &&
				content.every(block => typeof block !== "object" || !("name" in block) || block.name !== "read"),
		).toBe(true);
	});

	it("breaks on visible thinking but not punctuation-only provider filler", () => {
		const withThinking = groupReadRows([
			{
				kind: "message" as const,
				message: assistant(readCall("r1", "a.ts"), thinking("reasoning"), readCall("r2", "b.ts")),
			},
		]);
		expect(withThinking.map(row => row.kind)).toEqual(["readGroup", "message", "readGroup"]);

		const withFiller = groupReadRows([
			{ kind: "message" as const, message: assistant(readCall("r1", "a.ts")) },
			{
				kind: "message" as const,
				message: assistant(thinking("."), text("."), readCall("r2", "b.ts")),
			},
		]);
		expect(withFiller).toHaveLength(1);
		expect(withFiller[0]?.kind).toBe("readGroup");
	});

	it("passes non-assistant rows through and seals the run", () => {
		const rows = [
			{ kind: "message" as const, message: assistant(readCall("r1", "a.ts")) },
			{ kind: "message" as const, message: { role: "user" as const, content: "hi", timestamp: 2 } },
		];
		const grouped = groupReadRows(rows);
		expect(grouped.map(row => row.kind)).toEqual(["readGroup", "message"]);
	});

	it("carries usage from a fully-consumed pure-read message onto the group", () => {
		const msg = assistant(readCall("c1", "a.ts"));
		msg.usage = { input: 10, output: 5 };
		msg.model = "gpt-x";
		msg.duration = 900;
		const rows = groupReadRows([{ kind: "message", message: msg }]);
		expect(rows).toHaveLength(1);
		const group = rows[0] as { kind: string; usage?: unknown[] };
		expect(group.kind).toBe("readGroup");
		expect(group.usage).toEqual([
			{
				role: "assistant",
				usage: { input: 10, output: 5 },
				model: "gpt-x",
				duration: 900,
				ttft: undefined,
				timestamp: 1,
			},
		]);
	});

	it("does not carry usage when visible content remains in the message", () => {
		const msg = assistant(readCall("c1", "a.ts"), text("explained"));
		msg.usage = { input: 10, output: 5 };
		const rows = groupReadRows([{ kind: "message", message: msg }]);
		// The read call groups; the visible text renders as its own message row.
		expect(rows).toHaveLength(2);
		const group = rows[0] as { usage?: unknown };
		expect(group.usage).toBeUndefined();
		const kept = rows[1] as { kind: string; message?: { usage?: unknown } };
		expect(kept.kind).toBe("message");
		// Usage stays on the message (its bubble renders a UsageRow), not the group.
		expect(kept.message?.usage).toEqual({ input: 10, output: 5 });
	});

	it("keeps occurrence-specific keys when a provider reuses a call id", () => {
		const first = assistant(readCall("provider-read:0", "first.ts"));
		const second = assistant(readCall("provider-read:0", "second.ts"));
		const result = (text: string): AgentMessage => ({
			role: "toolResult",
			toolCallId: "provider-read:0",
			toolName: "read",
			content: [{ type: "text", text }],
			timestamp: 2,
		});
		useToolsStore.getState().hydrateMessages([first, result("first"), second, result("second")]);
		try {
			const grouped = groupReadRows([
				{ kind: "message" as const, message: first },
				{ kind: "message" as const, message: second },
			]);
			if (grouped[0]?.kind !== "readGroup") throw new Error("expected one read group");
			expect(grouped[0].entries.map(entry => entry.toolKey)).toHaveLength(2);
			expect(new Set(grouped[0].entries.map(entry => entry.toolKey)).size).toBe(2);
		} finally {
			useToolsStore.getState().reset();
		}
	});
});

describe("mergeReadGroupEntries", () => {
	it("merges selectors for consecutive same-file reads", () => {
		const rows = mergeReadGroupEntries([
			{ callId: "r1", toolKey: "r1", path: "a.ts", selector: "1-5", args: {} },
			{ callId: "r2", toolKey: "r2", path: "a.ts", selector: "7", args: {} },
			{ callId: "r3", toolKey: "r3", path: "b.ts", args: {} },
			{ callId: "r4", toolKey: "r4", path: "a.ts", selector: "20-25", args: {} },
		]);
		expect(rows).toEqual([
			{ path: "a.ts", selector: "1-5,7", callIds: ["r1", "r2"], toolKeys: ["r1", "r2"] },
			{ path: "b.ts", selector: undefined, callIds: ["r3"], toolKeys: ["r3"] },
			{ path: "a.ts", selector: "20-25", callIds: ["r4"], toolKeys: ["r4"] },
		]);
	});
});
