/**
 * gui-bridge context inspector rules (resources/gui-bridge/context-inspect-core.ts):
 * splitting a system prompt block around the instruction files and skills stock
 * located in it, the provider text an entry previews and its cap. The
 * project-prompt sample follows stock `prompts/system/project-prompt.md`;
 * src/main/bridge-input-history.test.ts runs the bridge methods on real omp.
 */
import { describe, expect, it } from "vitest";
import {
	capPreview,
	llmMessagesText,
	PREVIEW_MAX_CHARS,
	snippet,
	splitBlock,
} from "../../resources/gui-bridge/context-inspect-core";

const projectPrompt = `<project-context>
<workstation>
- OS: darwin
</workstation>

<repo-rules>
MUST follow these context files for all tasks:
<file path="/repo/AGENTS.md">
# Rules
Use tabs.
</file>
<file path="/repo/pkg/CLAUDE.md">
Nested rules.
</file>
</repo-rules>
</project-context>`;

/** A source over `text` in `block`, as stock's `buildSystemPrompt` records one. */
function sourceOf(block: string, text: string) {
	const start = block.indexOf(text);
	return { kind: "instruction-files" as const, start, end: start + text.length };
}

describe("context inspector rules", () => {
	it("splits each source stock located out of its block and keeps the rest", () => {
		const agents = '<file path="/repo/AGENTS.md">\n# Rules\nUse tabs.\n</file>\n';
		const claude = '<file path="/repo/pkg/CLAUDE.md">\nNested rules.\n</file>\n';
		const { sources, rest } = splitBlock(projectPrompt, [
			sourceOf(projectPrompt, agents),
			sourceOf(projectPrompt, claude),
		]);
		expect(sources.map(split => split.text)).toEqual([agents, claude]);
		expect(rest).toBe(projectPrompt.replace(agents, "").replace(claude, ""));
		expect(rest).toContain("MUST follow these context files for all tasks:\n</repo-rules>");
		expect(splitBlock(projectPrompt, [])).toEqual({ sources: [], rest: projectPrompt });
	});

	it("prints provider messages with tool calls, images and tool results", () => {
		const text = llmMessagesText([
			{
				role: "user",
				content: [
					{ type: "text", text: "Look" },
					{ type: "image", mimeType: "image/png" },
				],
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "plan" },
					{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
				],
			},
			{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "ok" }] },
		]);
		expect(text).toContain("[user]\nLook\n\n[image image/png]");
		expect(text).toContain("[thinking]\nplan");
		expect(text).toContain('[tool call] read {\n  "path": "a.ts"\n}');
		expect(text).toContain("[toolResult · read]\nok");
		expect(snippet(text)).toBe("Look");
		expect(snippet(projectPrompt)).toBe("- OS: darwin");
	});

	it("caps a preview at 32k characters and reports the full length", () => {
		expect(capPreview("short")).toEqual({ text: "short", totalChars: 5, truncated: false });
		const long = capPreview("x".repeat(PREVIEW_MAX_CHARS + 10));
		expect(long.text).toHaveLength(32_000);
		expect(long).toMatchObject({ totalChars: 32_010, truncated: true });
	});
});
