/**
 * Agents installed from a template before v0.30 carry the model line the
 * template had then (`@task`, `@slow, @task`, …). The current templates list
 * a preset custom role first (`@debug, @slow, @task`), so an old file never
 * runs on the role the user sets in Settings › Models & accounts. The
 * Definitions page offers, per agent, to replace that one line; the file is
 * never rewritten otherwise and never without the user confirming the diff.
 */

import { emptyAgentDraft, serializeAgentMarkdown } from "./agent-definition";
import { AGENT_TEMPLATES, type AgentTemplate } from "./agent-templates";
import type { AgentFileScope } from "./rpc-types";

/** Model lines v0.29 wrote for the templates whose model changed in v0.30. */
export const LEGACY_TEMPLATE_MODELS: Readonly<Record<string, readonly string[]>> = {
	"test-writer": ["@task"],
	debugger: ["@slow", "@task"],
	"docs-writer": ["@smol", "@task"],
	"code-reviewer": ["@slow", "@task"],
	"ui-polisher": ["@task"],
};

export interface TemplateModelOffer {
	template: AgentTemplate;
	/** The model line the file has now, as discovery parsed it. */
	from: readonly string[];
	to: readonly string[];
	/** The file still has the model line an earlier ompdesk wrote; `false` = the user wrote another one. */
	legacy: boolean;
}

export interface OfferableAgent {
	name: string;
	scope?: AgentFileScope;
	filePath?: string;
	model?: readonly string[];
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * An offer for an agent file in the user/project agents folder that is named
 * after a template, sits in `<name>.md` (so saving it in place is not a
 * rename) and has a model line that differs from the current template's.
 * An agent without a model line uses the session model on purpose.
 */
export function templateModelOffer(agent: OfferableAgent): TemplateModelOffer | undefined {
	if (!agent.scope || !agent.filePath || !agent.model || agent.model.length === 0) return undefined;
	if (
		agent.filePath.slice(Math.max(agent.filePath.lastIndexOf("/"), agent.filePath.lastIndexOf("\\")) + 1) !==
		`${agent.name}.md`
	)
		return undefined;
	const template = AGENT_TEMPLATES.find(entry => entry.name === agent.name);
	if (!template || sameList(agent.model, template.model)) return undefined;
	const legacy = LEGACY_TEMPLATE_MODELS[template.name];
	return {
		template,
		from: agent.model,
		to: template.model,
		legacy: legacy !== undefined && sameList(agent.model, legacy),
	};
}

export interface ModelLineEdit {
	content: string;
	/** The replaced text (several lines for a block list), without line endings. */
	before: string;
	after: string;
}

/** Frontmatter lines `[start, end)` of `lines`, or undefined when the file has none. */
function frontmatterSpan(lines: readonly string[]): [number, number] | undefined {
	if (lines[0]?.replace(/\r$/, "") !== "---") return undefined;
	for (let index = 1; index < lines.length; index++) {
		if (lines[index]?.replace(/\r$/, "") === "---") return [1, index];
	}
	return undefined;
}

/** The `model` key's lines (top-level `model:` plus a block list that follows) inside the frontmatter. */
function modelSpan(lines: readonly string[]): [number, number] | undefined {
	const span = frontmatterSpan(lines);
	if (!span) return undefined;
	for (let start = span[0]; start < span[1]; start++) {
		if (!/^model[ \t]*:/.test(lines[start] ?? "")) continue;
		let end = start + 1;
		while (end < span[1]) {
			const line = lines[end] ?? "";
			if (/^[ \t]*#/.test(line)) break;
			if (!/^([ \t]+\S|-([ \t]|\r?$))/.test(line)) break;
			end++;
		}
		return [start, end];
	}
	return undefined;
}

/** How ompdesk's own serializer writes a model value, so the line matches the template files. */
function renderModelLine(model: readonly string[]): string {
	const lines = serializeAgentMarkdown({ ...emptyAgentDraft(), model: [...model] }).split("\n");
	const span = modelSpan(lines);
	if (!span) throw new Error("serializer wrote no model line");
	return lines.slice(span[0], span[1]).join("\n");
}

/**
 * `content` with its frontmatter `model` key replaced by `model`; every other
 * byte (comments, key order, quoting, line endings, body) stays. Undefined
 * when the frontmatter has no `model` key.
 */
export function replaceModelLine(content: string, model: readonly string[]): ModelLineEdit | undefined {
	const lines = content.split("\n");
	const span = modelSpan(lines);
	if (!span) return undefined;
	const crlf = lines[span[0]]?.endsWith("\r") === true;
	const after = renderModelLine(model);
	const before = lines
		.slice(span[0], span[1])
		.map(line => line.replace(/\r$/, ""))
		.join("\n");
	const replacement = after.split("\n").map(line => (crlf ? `${line}\r` : line));
	lines.splice(span[0], span[1] - span[0], ...replacement);
	return { content: lines.join("\n"), before, after };
}
