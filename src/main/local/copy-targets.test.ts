import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../shared/rpc-types";
import { buildCopyTargets, extractBlocks } from "./copy-targets";

const assistant = (text: string, toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = []) =>
	({
		role: "assistant",
		content: [
			{ type: "text", text },
			...toolCalls.map((call, index) => ({ type: "toolCall" as const, id: `t${index}`, ...call })),
		],
	}) satisfies AgentMessage;

describe("extractBlocks", () => {
	it("splits fenced code and quotes in order, masking quote markers inside fences", () => {
		const text = "intro\n> quoted\n>tight\n```ts\nconst a = 1;\n> not a quote\n```\nafter";
		expect(extractBlocks(text)).toEqual([
			{ kind: "quote", text: "quoted\ntight" },
			{ kind: "code", lang: "ts", code: "const a = 1;\n> not a quote" },
		]);
	});

	it("treats an unclosed fence as text", () => {
		expect(extractBlocks("```js\nnever closed")).toEqual([]);
	});
});

describe("buildCopyTargets", () => {
	it("ranks messages newest first with code children and the commands each turn ran", () => {
		const messages: AgentMessage[] = [
			assistant("older answer"),
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "x", name: "bash", arguments: { command: "ls -la" } }],
			},
			assistant("```sh\necho 1\n```\n```py\nprint(2)\n```", [
				{ name: "eval", arguments: { cells: [{ code: "1+1", language: "js" }] } },
			]),
		];
		const targets = buildCopyTargets(messages);
		expect(targets.map(target => target.id)).toEqual(["msg:1", "cmd:1", "msg:2", "cmd:2"]);
		expect(targets[0]?.hint).toBe("6 lines · 2 code");
		expect(targets[0]?.children?.map(child => child.id)).toEqual(["msg:1:code:0", "msg:1:code:1", "msg:1:all"]);
		expect(targets[0]?.children?.[2]?.content).toBe("echo 1\n\nprint(2)");
		expect(targets[1]).toMatchObject({ content: "1+1", language: "javascript", hint: "eval · 1 line" });
		expect(targets[2]).toMatchObject({ label: "older answer", copyMessage: "Copied message to clipboard" });
		// The bash call from the text-less turn is held until the next (older) text-bearing message.
		expect(targets[3]).toMatchObject({ content: "ls -la", language: "bash" });
	});

	it("falls back to the displayed handoff when no assistant text exists", () => {
		const targets = buildCopyTargets([
			{ role: "custom", customType: "handoff", display: true, content: [{ type: "text", text: "ctx\nmore" }] },
			{ role: "assistant", content: [{ type: "toolCall", id: "x", name: "bash", arguments: { command: "pwd" } }] },
		]);
		expect(targets.map(target => target.id)).toEqual(["handoff", "cmd:1"]);
		expect(targets[0]?.hint).toBe("2 lines");
	});
});
