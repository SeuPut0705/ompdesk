import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../shared/rpc-types";
import { formatTodoMarkdown, formatTranscriptMarkdown, parseTodoPhasesJson } from "./transcript-copy";

describe("formatTranscriptMarkdown", () => {
	it("renders role headers and plain text per message", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "fix the flaky test" },
			{ role: "assistant", content: [{ type: "text", text: "On it — reading the file first." }] },
		];
		const markdown = formatTranscriptMarkdown(messages);
		expect(markdown).toContain("# Session Transcript");
		expect(markdown).toContain("## User");
		expect(markdown).toContain("fix the flaky test");
		expect(markdown).toContain("## Assistant");
		expect(markdown).toContain("On it — reading the file first.");
	});

	it("summarizes tool calls on one line with JSON args", () => {
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "src/a.ts" } }],
			},
		];
		const markdown = formatTranscriptMarkdown(messages);
		expect(markdown).toContain('- **Tool call:** `read` — {"path":"src/a.ts"}');
	});

	it("folds thinking into a blockquote", () => {
		const messages: AgentMessage[] = [
			{ role: "assistant", content: [{ type: "thinking", thinking: "plan of attack" }] },
		];
		const markdown = formatTranscriptMarkdown(messages);
		expect(markdown).toContain("> **Thinking**");
		expect(markdown).toContain("> plan of attack");
	});

	it("renders tool results as fenced blocks with error marks", () => {
		const messages: AgentMessage[] = [{ role: "toolResult", toolName: "bash", content: "exit 1", isError: true }];
		const markdown = formatTranscriptMarkdown(messages);
		expect(markdown).toContain("**Tool result** `bash` (error):");
		expect(markdown).toContain("```\nexit 1\n```");
	});

	it("skips content-less messages", () => {
		const markdown = formatTranscriptMarkdown([{ role: "assistant" }]);
		expect(markdown).toBe("# Session Transcript");
	});
});

describe("formatTodoMarkdown", () => {
	it("renders phases as GFM task lists with status cues", () => {
		const markdown = formatTodoMarkdown([
			{
				name: "Phase A",
				tasks: [
					{ content: "done thing", status: "completed" },
					{ content: "open thing", status: "pending" },
					{ content: "active thing", status: "in_progress" },
					{ content: "dropped thing", status: "abandoned" },
				],
			},
		]);
		expect(markdown).toContain("## Phase A");
		expect(markdown).toContain("- [x] done thing");
		expect(markdown).toContain("- [ ] open thing");
		expect(markdown).toContain("- [ ] active thing _(in progress)_");
		expect(markdown).toContain("- [ ] ~~dropped thing~~ _(abandoned)_");
	});
});

describe("parseTodoPhasesJson", () => {
	it("parses a valid export and defaults missing status to pending", () => {
		const phases = parseTodoPhasesJson([
			{ name: "P", tasks: [{ content: "a", status: "blocked" }, { content: "b" }] },
		]);
		expect(phases).toEqual([
			{
				name: "P",
				tasks: [
					{ content: "a", status: "blocked" },
					{ content: "b", status: "pending" },
				],
			},
		]);
	});

	it("rejects non-array input", () => {
		expect(() => parseTodoPhasesJson({ phases: [] })).toThrow();
	});

	it("rejects phases without a name or tasks", () => {
		expect(() => parseTodoPhasesJson([{ tasks: [] }])).toThrow();
		expect(() => parseTodoPhasesJson([{ name: "P" }])).toThrow();
	});

	it("rejects tasks without content or with an unknown status", () => {
		expect(() => parseTodoPhasesJson([{ name: "P", tasks: [{ status: "pending" }] }])).toThrow();
		expect(() => parseTodoPhasesJson([{ name: "P", tasks: [{ content: "a", status: "weird" }] }])).toThrow();
	});
});
