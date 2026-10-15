import { describe, expect, it } from "vitest";
import { serializeAgentMarkdown } from "./agent-definition";
import { LEGACY_TEMPLATE_MODELS, replaceModelLine, templateModelOffer } from "./agent-template-migration";
import { AGENT_TEMPLATES, templateDraft } from "./agent-templates";

function template(name: string) {
	const found = AGENT_TEMPLATES.find(entry => entry.name === name);
	if (!found) throw new Error(`no template ${name}`);
	return found;
}

/** A file as v0.29 wrote it: the current template's frontmatter with the old model line. */
function legacyFile(name: string): string {
	const current = serializeAgentMarkdown(templateDraft(template(name)));
	const old = LEGACY_TEMPLATE_MODELS[name];
	if (!old) throw new Error(`no legacy model for ${name}`);
	return replaceModelLine(current, old)?.content ?? "";
}

describe("templateModelOffer", () => {
	const base = { scope: "user" as const, filePath: "/agents/debugger.md" };

	it("offers a role-based model to a template agent whose model line is the pre-role one", () => {
		const offer = templateModelOffer({ ...base, name: "debugger", model: ["@slow", "@task"] });
		expect(offer).toMatchObject({ legacy: true, to: template("debugger").model });
	});

	it("marks a model line the user wrote themselves as edited", () => {
		const offer = templateModelOffer({ ...base, name: "debugger", model: ["anthropic/claude-opus-4-5"] });
		expect(offer?.legacy).toBe(false);
	});

	it("offers nothing for current, unrelated, bundled, session-model or renamed-file agents", () => {
		expect(templateModelOffer({ ...base, name: "debugger", model: [...template("debugger").model] })).toBeUndefined();
		expect(
			templateModelOffer({ ...base, name: "my-agent", filePath: "/agents/my-agent.md", model: ["@task"] }),
		).toBeUndefined();
		expect(templateModelOffer({ name: "debugger", filePath: "/x/debugger.md", model: ["@task"] })).toBeUndefined();
		expect(templateModelOffer({ ...base, name: "debugger" })).toBeUndefined();
		expect(templateModelOffer({ ...base, name: "debugger", model: [] })).toBeUndefined();
		expect(
			templateModelOffer({ ...base, name: "debugger", filePath: "/agents/other.md", model: ["@task"] }),
		).toBeUndefined();
	});

	it("covers every template whose model line changed since v0.29", () => {
		for (const [name, old] of Object.entries(LEGACY_TEMPLATE_MODELS)) {
			expect(old, name).not.toEqual(template(name).model);
		}
	});
});

describe("replaceModelLine", () => {
	it("changes exactly the model line and nothing else", () => {
		const before = legacyFile("debugger");
		const edit = replaceModelLine(before, template("debugger").model);
		expect(edit?.before).toBe('model: [ "@slow", "@task" ]');
		expect(edit?.after).toBe(
			`model: [ ${template("debugger")
				.model.map(item => `"${item}"`)
				.join(", ")} ]`,
		);
		const beforeLines = before.split("\n");
		const afterLines = (edit?.content ?? "").split("\n");
		expect(afterLines).toHaveLength(beforeLines.length);
		const changed = beforeLines.flatMap((line, index) => (line === afterLines[index] ? [] : [index]));
		expect(changed).toHaveLength(1);
		expect(afterLines[changed[0] ?? 0]).toBe(edit?.after);
	});

	it("keeps user comments, key order and CRLF line endings", () => {
		const content =
			"---\r\n# my notes\r\nname: debugger\r\ndescription: mine\r\nmodel: '@slow'\r\ntools: [read]\r\n---\r\n\r\nBody\r\n";
		const edit = replaceModelLine(content, ["@debug", "@slow"]);
		expect(edit?.content).toBe(
			'---\r\n# my notes\r\nname: debugger\r\ndescription: mine\r\nmodel: [ "@debug", "@slow" ]\r\ntools: [read]\r\n---\r\n\r\nBody\r\n',
		);
	});

	it("replaces a block-sequence model as one edit", () => {
		const content = "---\nname: a\nmodel:\n  - '@slow'\n  - '@task'\ntools: [read]\n---\nBody\n";
		const edit = replaceModelLine(content, ["@debug"]);
		expect(edit?.content).toBe('---\nname: a\nmodel: "@debug"\ntools: [read]\n---\nBody\n');
		expect(edit?.before).toBe("model:\n  - '@slow'\n  - '@task'");
	});

	it("never touches a `model:` line in the body, and finds none without one in the frontmatter", () => {
		const content = "---\nname: a\ndescription: x\n---\n\nmodel: nothing\n";
		expect(replaceModelLine(content, ["@task"])).toBeUndefined();
		expect(replaceModelLine("no frontmatter\nmodel: x\n", ["@task"])).toBeUndefined();
	});
});
