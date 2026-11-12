import { describe, expect, it } from "vitest";
import { isAgentPrompt, isJunkTitle, promptTitle, unwrapPrompt } from "../../resources/gui-bridge/memory-prompt";
import { journalFacts, methods, promptFacts } from "../../resources/gui-bridge/stock-helper/memory";
import { wrapAgentMessage } from "../shared/agent-control";

describe("memory.promptFacts", () => {
	it("answers what memory-prompt says of each prompt, in order", () => {
		const wrapped = wrapAgentMessage("Title: 일 하나\n\nbody text", "부모");
		const items = [
			{ text: wrapped },
			{ text: "  fix the build\nsecond line  ", sessionName: "Named session" },
			{ text: "fix the build" },
			{ text: "" },
			{ text: "Session 0a1b2c3d-1111-2222-3333-444455556666" },
		];
		const facts = promptFacts(items);
		expect(facts).toHaveLength(items.length);
		expect(facts[0]).toEqual({
			agent: true,
			// A page title that is the wrapper's own tag names no task.
			junk: true,
			title: "일 하나",
			explicit: "일 하나",
			body: unwrapPrompt(wrapped).body,
			firstLine: facts[0]?.firstLine,
		});
		// A session's own name wins over the prompt's first line, for the prompt that carries it.
		expect(facts[1]).toMatchObject({
			agent: false,
			title: "Named session",
			explicit: null,
			body: "fix the build\nsecond line",
		});
		expect(facts[1]?.firstLine).toBe("fix the build");
		expect(facts[3]).toEqual({ agent: false, junk: true, title: null, explicit: null, body: "", firstLine: null });
		expect(facts[4]?.junk).toBe(true);
		for (const [index, item] of items.entries()) {
			expect(facts[index]).toMatchObject({
				agent: isAgentPrompt(item.text),
				junk: isJunkTitle(item.text),
				title:
					promptTitle(item.text, { sessionName: "sessionName" in item ? item.sessionName : undefined }) ?? null,
			});
		}
	});

	it("is the stock worker's method, and refuses params that are no prompts", async () => {
		const handler = methods["memory.promptFacts"];
		expect(await handler?.({ items: [{ text: "a task" }] })).toEqual(promptFacts([{ text: "a task" }]));
		await expect(Promise.resolve().then(() => handler?.({ items: [{ text: 5 }] }))).rejects.toThrow(
			"Invalid prompt items",
		);
		await expect(Promise.resolve().then(() => handler?.({}))).rejects.toThrow("Invalid prompt items");
	});
});

describe("memory.journal", () => {
	const reply = (timestamp: unknown, text: string, stopReason = "stop") => ({
		role: "assistant",
		stopReason,
		timestamp,
		content: [{ type: "text", text }],
	});

	it("reads the first person prompt and the replies that stopped in words, nothing else", () => {
		const messages = [
			{ role: "user", content: "   " },
			{
				role: "user",
				content: [{ type: "text", text: "first" }, { type: "image" }, { type: "text", text: "task" }],
			},
			reply(1_700_000_000_123, "tool turn", "toolUse"),
			reply(1_700_000_000_456, "done: all green"),
			reply("1700000000789", "no time"),
			reply(Number.NaN, "not a number"),
			{
				role: "assistant",
				stopReason: "stop",
				timestamp: 1_700_000_001_000,
				content: [{ type: "thinking", thinking: "x" }],
			},
			null,
			{ role: "user", content: "second prompt" },
		];
		expect(journalFacts(messages)).toEqual({
			firstPrompt: "first\n\ntask",
			turns: [{ at: 1_700_000_000_456, body: "done: all green" }],
		});
	});

	it("has no first prompt in a journal without a person's words", () => {
		expect(journalFacts([])).toEqual({ firstPrompt: null, turns: [] });
		expect(journalFacts([{ role: "user", content: [{ type: "image" }] }]).firstPrompt).toBeNull();
	});

	it("takes only an absolute .jsonl path", async () => {
		const handler = methods["memory.journal"];
		await expect(Promise.resolve().then(() => handler?.({ sessionPath: "relative.jsonl" }))).rejects.toThrow(
			"Invalid session path",
		);
		await expect(Promise.resolve().then(() => handler?.({ sessionPath: "/s/a.txt" }))).rejects.toThrow(
			"Invalid session path",
		);
		await expect(Promise.resolve().then(() => handler?.({}))).rejects.toThrow("Invalid session path");
	});
});
