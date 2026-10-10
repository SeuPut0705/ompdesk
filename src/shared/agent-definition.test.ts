import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	checkAgentName,
	draftErrors,
	draftFromFields,
	emptyAgentDraft,
	type KnownAgent,
	outputSchemaError,
	serializeAgentMarkdown,
	splitFrontmatter,
} from "./agent-definition";

function frontmatterOf(markdown: string): Record<string, unknown> {
	const { frontmatter } = splitFrontmatter(markdown);
	return parse(frontmatter ?? "") as Record<string, unknown>;
}

describe("serializeAgentMarkdown", () => {
	it("writes a new file omp can parse, omitting empty keys", () => {
		const markdown = serializeAgentMarkdown({
			...emptyAgentDraft(),
			name: "docs-writer",
			description: "Writes docs: guides and READMEs",
			instructions: "\n\nWrite docs.\n\n",
			tools: ["read", "write"],
			model: ["@smol"],
			thinkingLevel: "low",
		});
		expect(markdown).toBe(
			'---\nname: docs-writer\ndescription: "Writes docs: guides and READMEs"\ntools: [ read, write ]\nmodel: "@smol"\nthinking-level: low\n---\n\nWrite docs.\n',
		);
		expect(frontmatterOf(markdown).description).toBe("Writes docs: guides and READMEs");
	});

	it("writes every configured field", () => {
		const draft = {
			...emptyAgentDraft(),
			name: "x",
			description: "y",
			instructions: "# Heading\n\n- item",
			tools: ["read"],
			spawns: "*" as const,
			model: ["@slow", "@task"],
			thinkingLevel: "xhigh",
			prewalk: true,
			advisor: "@smol:high",
			blocking: true,
			readSummarize: false,
			autoloadSkills: ["s1"],
			output: JSON.stringify({ properties: { a: { type: "string" } } }, null, 2),
		};
		const markdown = serializeAgentMarkdown(draft);
		expect(frontmatterOf(markdown)).toMatchObject({
			name: draft.name,
			description: draft.description,
			tools: draft.tools,
			spawns: draft.spawns,
			model: draft.model,
			"thinking-level": draft.thinkingLevel,
			prewalk: draft.prewalk,
			advisor: draft.advisor,
			blocking: draft.blocking,
			"read-summarize": draft.readSummarize,
			"autoload-skills": draft.autoloadSkills,
			output: JSON.parse(draft.output),
		});
		expect(splitFrontmatter(markdown).body.trim()).toBe(draft.instructions);
	});

	it("keeps unknown keys, comments, key order and the file's own key spelling", () => {
		const original = `---
# Owned by the platform team
name: old
x-team: platform # who to ask
thinking: low
description: Old description
readSummarize: false
---
Old body
`;
		const next = serializeAgentMarkdown(
			{
				...emptyAgentDraft(),
				name: "new",
				description: "New description",
				thinkingLevel: "high",
				readSummarize: true,
			},
			original,
		);
		expect(next).toContain("# Owned by the platform team");
		expect(next).toContain("x-team: platform # who to ask");
		expect(next).toContain("thinking: high");
		expect(next).not.toContain("thinking-level");
		expect(next).not.toContain("readSummarize");
		const fields = frontmatterOf(next);
		expect(Object.keys(fields)).toEqual(["name", "x-team", "thinking", "description"]);
		expect(fields.name).toBe("new");
	});

	it("drops a duplicate alias so omp cannot read a stale value", () => {
		const original = "---\nname: a\ndescription: b\nthinking: low\nthinkingLevel: medium\n---\nx";
		const next = serializeAgentMarkdown(
			{ ...emptyAgentDraft(), name: "a", description: "b", instructions: "x", thinkingLevel: "max" },
			original,
		);
		const fields = frontmatterOf(next);
		expect(fields.thinkingLevel).toBe("max");
		expect(fields.thinking).toBeUndefined();
	});

	it("never writes yield and rejects invalid output JSON", () => {
		const draft = { ...emptyAgentDraft(), name: "a", description: "b", instructions: "c", tools: ["read", "yield"] };
		expect(frontmatterOf(serializeAgentMarkdown(draft)).tools).toEqual(["read"]);
		expect(() => serializeAgentMarkdown({ ...draft, output: "{" })).toThrow();
	});
});

describe("draftFromFields", () => {
	it("maps a discovered (bundled) definition into a draft", () => {
		const draft = draftFromFields(
			{
				name: "scout",
				description: "Explore",
				tools: ["read", "grep", "yield"],
				model: ["@smol"],
				thinkingLevel: "medium",
				readSummarize: false,
				output: { properties: { summary: { type: "string" } } },
			},
			"Body",
		);
		expect(draft.tools).toEqual(["read", "grep"]);
		expect(draft.readSummarize).toBe(false);
		expect(JSON.parse(draft.output)).toEqual({ properties: { summary: { type: "string" } } });
	});
});

describe("checkAgentName", () => {
	const known: KnownAgent[] = [
		{ name: "task", source: "bundled", filePath: "embedded:task.md" },
		{ name: "mine", source: "user", scope: "user", filePath: "/u/mine.md" },
		{ name: "local", source: "project", scope: "project", filePath: "/p/local.md" },
		{ name: "plug", source: "user", filePath: "/plugins/x/agents/plug.md" },
	];

	it("rejects empty, malformed and reserved names", () => {
		expect(checkAgentName("  ", "user", known).error).toBe("required");
		expect(checkAgentName("../evil", "user", known).error).toBe("invalid");
		expect(checkAgentName("has space", "user", known).error).toBe("invalid");
		expect(checkAgentName(".hidden", "user", known).error).toBe("invalid");
		expect(checkAgentName("Main", "user", known).error).toBe("reserved");
		expect(checkAgentName(" sub ", "project", known).error).toBe("reserved");
	});

	it("rejects a name taken in the same folder, case-insensitively, except by the file being edited", () => {
		expect(checkAgentName("MINE", "user", known).error).toBe("exists");
		expect(checkAgentName("mine", "user", known, "/u/mine.md")).toEqual({});
	});

	it("explains first-wins precedence", () => {
		expect(checkAgentName("task", "user", known).notice).toEqual({ kind: "overridesBundled" });
		expect(checkAgentName("mine", "project", known).notice).toEqual({ kind: "overridesUser" });
		expect(checkAgentName("local", "user", known).notice).toEqual({ kind: "shadowedByProject" });
		expect(checkAgentName("plug", "project", known).notice).toEqual({ kind: "overridesExtension" });
		expect(checkAgentName("fresh", "project", known)).toEqual({});
	});
});

describe("draft validation", () => {
	it("requires description and instructions and a JSON object schema", () => {
		const draft = { ...emptyAgentDraft(), name: "a" };
		expect(draftErrors(draft, {})).toEqual({ description: "required", instructions: "required" });
		expect(outputSchemaError("")).toBeUndefined();
		expect(outputSchemaError("[]")).toBe("not-object");
		expect(outputSchemaError("{nope")).toBeTruthy();
		expect(outputSchemaError('{"type":"object"}')).toBeUndefined();
	});
});
