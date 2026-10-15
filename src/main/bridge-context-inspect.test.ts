/**
 * gui-bridge context inspector rules (resources/gui-bridge/context-inspect-core.ts):
 * reading context files back out of stock's rendered project prompt, the
 * skills stock lists, the provider text an entry previews and its cap. The
 * project-prompt sample follows stock `prompts/system/project-prompt.md`;
 * src/main/bridge-input-history.test.ts runs the bridge methods on real omp.
 */
import { describe, expect, it } from "vitest";
import {
	capPreview,
	llmMessagesText,
	PREVIEW_MAX_CHARS,
	promptSkills,
	repoRulesFiles,
	snippet,
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

describe("context inspector rules", () => {
	it("reads each context file stock rendered into <repo-rules>", () => {
		const files = repoRulesFiles(projectPrompt);
		expect(files.map(file => file.path)).toEqual(["/repo/AGENTS.md", "/repo/pkg/CLAUDE.md"]);
		expect(files[0]?.content).toBe("# Rules\nUse tabs.");
		expect(files[0]?.block.startsWith('<file path="/repo/AGENTS.md">')).toBe(true);
		expect(repoRulesFiles("<project-context>\n</project-context>")).toEqual([]);
	});

	it("lists skills only with the read tool and never a hidden one (stock renderedSkills)", () => {
		const skills = [{ name: "a" }, { name: "b", hide: true }];
		expect(promptSkills(skills, ["bash"])).toEqual([]);
		expect(promptSkills(skills, ["read", "bash"])).toEqual([{ name: "a" }]);
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
