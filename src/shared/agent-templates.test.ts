import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ROLE_ORDER } from "../../resources/gui-bridge/model-role-contracts";
import { OMPDESK_ROLE_IDS } from "../../resources/gui-bridge/ompdesk-role-contracts";
import { AGENT_THINKING_LEVELS, agentNameError, serializeAgentMarkdown, splitFrontmatter } from "./agent-definition";
import { AGENT_TEMPLATES, templateDraft } from "./agent-templates";

/** omp 18.7 `BUILTIN_TOOL_NAMES` (tools/builtin-names.ts); templates must only name real tools. */
const OMP_BUILTIN_TOOLS = new Set([
	"read",
	"bash",
	"edit",
	"ast_grep",
	"ast_edit",
	"ask",
	"debug",
	"ida",
	"eval",
	"github",
	"glob",
	"grep",
	"find",
	"lsp",
	"checkpoint",
	"rewind",
	"context_notes",
	"new_context",
	"security_scan",
	"task",
	"wait",
	"todo",
	"web_search",
	"write",
	"memory_edit",
	"retain",
	"recall",
	"reflect",
	"learn",
	"manage_skill",
]);

/** Bundled omp agents: a template with one of these names would silently replace it. */
const BUNDLED_AGENTS = ["scout", "reviewer", "security-reviewer", "task", "sonic"];

describe("AGENT_TEMPLATES", () => {
	it("are uniquely and validly named without shadowing bundled agents", () => {
		const names = AGENT_TEMPLATES.map(template => template.name);
		expect(new Set(names).size).toBe(names.length);
		for (const name of names) {
			expect(agentNameError(name), name).toBeUndefined();
			expect(BUNDLED_AGENTS).not.toContain(name);
		}
	});

	it("only reference real tools, role aliases and thinking levels", () => {
		for (const template of AGENT_TEMPLATES) {
			for (const tool of template.tools) expect(OMP_BUILTIN_TOOLS.has(tool), `${template.name}: ${tool}`).toBe(true);
			for (const selector of template.model) expect(selector, template.name).toMatch(/^@[a-z_]+$/);
			expect(AGENT_THINKING_LEVELS).toContain(template.thinkingLevel);
			for (const spawn of template.spawns ?? []) expect(BUNDLED_AGENTS).toContain(spawn);
		}
	});

	it("name roles Settings lists (stock's and OMPdesk's own), never another custom role", () => {
		const known = [...ROLE_ORDER, ...OMPDESK_ROLE_IDS];
		for (const template of AGENT_TEMPLATES) {
			for (const selector of template.model) expect(known, template.name).toContain(selector.slice(1));
		}
	});

	it("carry localized gallery copy and English model-facing text", () => {
		for (const template of AGENT_TEMPLATES) {
			for (const lang of ["en", "ko"] as const) {
				expect(template.title[lang].trim(), `${template.name} title.${lang}`).not.toBe("");
				expect(template.summary[lang].trim(), `${template.name} summary.${lang}`).not.toBe("");
			}
			// The model reads description and instructions: no Hangul or CJK in them.
			for (const text of [template.description, template.instructions]) {
				expect(text, template.name).not.toMatch(/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af\u4e00-\u9fff]/);
			}
			expect(template.instructions.length).toBeGreaterThan(200);
		}
	});

	it("serializes the template name, description, tools and instructions", () => {
		for (const template of AGENT_TEMPLATES) {
			const draft = templateDraft(template);
			const { frontmatter, body } = splitFrontmatter(serializeAgentMarkdown(draft));
			expect(parse(frontmatter ?? "")).toMatchObject({
				name: draft.name,
				description: draft.description,
				tools: draft.tools,
			});
			expect(body.trim()).toBe(draft.instructions.trim());
		}
	});
});
