/**
 * omp task-agent definition files (`~/.omp/agent/agents/*.md`,
 * `.omp/agents/*.md`): markdown with YAML frontmatter whose body is the
 * agent's system prompt. Parsing mirrors omp's `parseAgentFields`
 * (discovery/helpers.ts): kebab-case keys normalize to camelCase, `tools` /
 * `spawns` / `model` / `autoload-skills` accept CSV or arrays, `yield` is
 * implied by any explicit tool list, `main` / `sub` are reserved.
 *
 * Serialization edits the original frontmatter document in place (the `yaml`
 * Document API), so keys ompdesk does not know and YAML comments survive a
 * round trip; an existing key keeps the spelling the file already used
 * (`thinking` vs `thinking-level`).
 */

import { Document, isMap, isSeq, parse, parseDocument } from "yaml";
import type { AgentFileScope } from "./rpc-types";

/** Rule names omp reserves for the top-level session and anonymous subagents. */
export const RESERVED_AGENT_NAMES: readonly string[] = ["main", "sub"];

/** Names ompdesk writes: they double as the file name, so no separators, dots first or spaces. */
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** omp's configured thinking selectors (`auto` plus `parseThinkingLevel`'s levels). */
export const AGENT_THINKING_LEVELS: readonly string[] = [
	"auto",
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** Tools that only look: the read-only preset (bundled `scout` / `reviewer` minus bash). */
export const READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "glob", "find", "lsp", "ast_grep", "web_search"];

/** The form model behind the agent editor. Empty values mean "key absent". */
export interface AgentDraft {
	name: string;
	description: string;
	/** Markdown body: the agent's system prompt. */
	instructions: string;
	/** `null` = no `tools` key (omp's default tool set); a list = exactly these tools. */
	tools: string[] | null;
	/** `"*"` = may spawn any agent; `[]` = no `spawns` key. */
	spawns: "*" | string[];
	/** Prioritized selectors (`@role`, `provider/model`, patterns); `[]` = no `model` key. */
	model: string[];
	/** One of {@link AGENT_THINKING_LEVELS}, or `""` for no key. */
	thinkingLevel: string;
	/** `false` = no key, `true` = default target, string = explicit model pattern. */
	prewalk: boolean | string;
	/** `false` = no key, `true` = advisor role model, string = explicit model pattern. */
	advisor: boolean | string;
	blocking: boolean;
	/** omp's default is on; only `false` is written. */
	readSummarize: boolean;
	autoloadSkills: string[];
	/** Output schema as JSON text (`""` = no key). */
	output: string;
}

export function emptyAgentDraft(): AgentDraft {
	return {
		name: "",
		description: "",
		instructions: "",
		tools: null,
		spawns: [],
		model: [],
		thinkingLevel: "",
		prewalk: false,
		advisor: false,
		blocking: false,
		readSummarize: true,
		autoloadSkills: [],
		output: "",
	};
}

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** Split a definition file into its frontmatter source (`null` when absent) and body. */
export function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
	const match = FRONTMATTER.exec(raw);
	if (!match) return { frontmatter: null, body: raw };
	return { frontmatter: match[1], body: raw.slice(match[0].length) };
}

function listOf(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const items = value.filter((item): item is string => typeof item === "string").map(item => item.trim());
		return items.filter(Boolean);
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map(item => item.trim())
			.filter(Boolean);
	}
	return undefined;
}

function booleanOf(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const lower = value.trim().toLowerCase();
		if (lower === "true") return true;
		if (lower === "false") return false;
	}
	return undefined;
}

function toggleOrPattern(value: unknown): boolean | string {
	const flag = booleanOf(value);
	if (flag !== undefined) return flag;
	return typeof value === "string" ? value.trim() || false : false;
}

/** Build a draft from already-parsed frontmatter fields (camelCase keys) and a body. */
export function draftFromFields(fields: Record<string, unknown>, body: string): AgentDraft {
	const draft = emptyAgentDraft();
	if (typeof fields.name === "string") draft.name = fields.name.trim();
	if (typeof fields.description === "string") draft.description = fields.description.trim();
	draft.instructions = body.replace(/^\s*\n/, "").trimEnd();
	if (fields.tools !== undefined && fields.tools !== null) {
		// omp adds `yield` to every explicit list itself.
		draft.tools = (listOf(fields.tools) ?? []).filter(tool => tool !== "yield");
	}
	const spawns = fields.spawns;
	if (spawns === "*" || (typeof spawns === "string" && spawns.trim() === "*")) draft.spawns = "*";
	else draft.spawns = listOf(spawns) ?? [];
	draft.model = listOf(fields.model) ?? [];
	const thinking =
		typeof fields.thinkingLevel === "string"
			? fields.thinkingLevel
			: typeof fields.thinking === "string"
				? fields.thinking
				: "";
	draft.thinkingLevel = thinking.trim().toLowerCase();
	draft.prewalk = toggleOrPattern(fields.prewalk);
	draft.advisor = toggleOrPattern(fields.advisor);
	draft.blocking = booleanOf(fields.blocking) ?? false;
	draft.readSummarize = booleanOf(fields.readSummarize) !== false;
	draft.autoloadSkills = listOf(fields.autoloadSkills) ?? [];
	if (fields.output !== undefined && fields.output !== null) draft.output = JSON.stringify(fields.output, null, 2);
	return draft;
}

export interface ParsedAgentFile {
	draft: AgentDraft;
	/** Frontmatter YAML error, when the frontmatter could not be read. */
	error?: string;
}

/** Parse a definition file into the editor's draft. */
export function parseAgentMarkdown(raw: string): ParsedAgentFile {
	const { frontmatter, body } = splitFrontmatter(raw);
	if (frontmatter === null) return { draft: draftFromFields({}, body) };
	let data: unknown;
	try {
		data = parse(frontmatter);
	} catch (cause) {
		return { draft: draftFromFields({}, body), error: cause instanceof Error ? cause.message : String(cause) };
	}
	const fields: Record<string, unknown> = {};
	if (data && typeof data === "object" && !Array.isArray(data)) {
		for (const [key, value] of Object.entries(data)) {
			fields[key.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase())] = value;
		}
	}
	return { draft: draftFromFields(fields, body) };
}

/** Frontmatter keys in write order; the first spelling is used for new keys. */
const FIELD_KEYS = {
	name: ["name"],
	description: ["description"],
	tools: ["tools"],
	spawns: ["spawns"],
	model: ["model"],
	thinkingLevel: ["thinking-level", "thinkingLevel", "thinking"],
	prewalk: ["prewalk"],
	advisor: ["advisor"],
	blocking: ["blocking"],
	readSummarize: ["read-summarize", "readSummarize"],
	autoloadSkills: ["autoload-skills", "autoloadSkills"],
	output: ["output"],
} as const satisfies Record<string, readonly string[]>;

type FieldId = keyof typeof FIELD_KEYS;

/** Frontmatter value per field; `undefined` drops the key, string arrays render as flow sequences. */
function frontmatterValues(draft: AgentDraft): Record<FieldId, unknown> {
	const list = (items: readonly string[]) => (items.length === 0 ? undefined : [...items]);
	return {
		name: draft.name.trim(),
		description: draft.description.trim(),
		// omp adds `yield` to every explicit list itself.
		tools: draft.tools?.filter(tool => tool !== "yield"),
		spawns: draft.spawns === "*" ? "*" : list(draft.spawns),
		model: draft.model.length === 1 ? draft.model[0] : list(draft.model),
		thinkingLevel: draft.thinkingLevel || undefined,
		prewalk: draft.prewalk === false || draft.prewalk === "" ? undefined : draft.prewalk,
		advisor: draft.advisor === false || draft.advisor === "" ? undefined : draft.advisor,
		blocking: draft.blocking ? true : undefined,
		readSummarize: draft.readSummarize ? undefined : false,
		autoloadSkills: list(draft.autoloadSkills),
		output: draft.output.trim() ? JSON.parse(draft.output) : undefined,
	};
}

function frontmatterDocument(original: string | undefined): Document {
	const source = original === undefined ? null : splitFrontmatter(original).frontmatter;
	if (source?.trim()) {
		const doc = parseDocument(source);
		if (doc.errors.length === 0 && isMap(doc.contents)) return doc;
	}
	return new Document({});
}

/**
 * Render a draft as a definition file. With `original`, its frontmatter is
 * edited in place: unknown keys, key order and comments are kept, and an
 * existing alias spelling (`thinking`, `readSummarize`) is reused. Throws when
 * `draft.output` is not valid JSON.
 */
export function serializeAgentMarkdown(draft: AgentDraft, original?: string): string {
	const doc = frontmatterDocument(original);
	const values = frontmatterValues(draft);
	for (const id of Object.keys(FIELD_KEYS) as FieldId[]) {
		const aliases: readonly string[] = FIELD_KEYS[id];
		const present = aliases.filter(alias => doc.has(alias));
		const key = present[0] ?? aliases[0];
		for (const alias of present) if (alias !== key) doc.delete(alias);
		const value = values[id];
		if (value === undefined) {
			doc.delete(key);
			continue;
		}
		const node = doc.createNode(value);
		if (Array.isArray(value) && isSeq(node)) node.flow = true;
		doc.set(key, node);
	}
	const yaml = doc.toString({ lineWidth: 0 });
	const body = draft.instructions.replace(/^\s*\n/, "").trimEnd();
	return `---\n${yaml}---\n\n${body}\n`;
}

/** The file name ompdesk gives an agent. */
export function agentFileName(name: string): string {
	return `${name.trim()}.md`;
}

export type AgentNameError = "required" | "invalid" | "reserved" | "exists";

export function isReservedAgentName(name: string): boolean {
	return RESERVED_AGENT_NAMES.includes(name.trim().toLowerCase());
}

/** Syntax-only name check (shared by the editor and the main-process writer). */
export function agentNameError(name: string): Exclude<AgentNameError, "exists"> | undefined {
	const trimmed = name.trim();
	if (!trimmed) return "required";
	if (isReservedAgentName(trimmed)) return "reserved";
	if (!AGENT_NAME_PATTERN.test(trimmed)) return "invalid";
	return undefined;
}

/** A discovered definition as the name check sees it. */
export interface KnownAgent {
	name: string;
	source: string;
	scope?: AgentFileScope;
	filePath?: string;
}

/** How a new name relates to what omp already discovers (first-wins: project → user → extensions → bundled). */
export type AgentNameNotice =
	| { kind: "overridesBundled" }
	| { kind: "overridesUser" }
	| { kind: "overridesExtension" }
	| { kind: "shadowedByProject" };

export interface AgentNameCheck {
	error?: AgentNameError;
	notice?: AgentNameNotice;
}

/**
 * Validate a name for a file in `scope`. `selfPath` is the file being edited
 * (its own name never collides). Discovery only reports each name's winner,
 * so a same-scope file shadowed by a project agent is caught by the writer.
 */
export function checkAgentName(
	name: string,
	scope: AgentFileScope,
	known: readonly KnownAgent[],
	selfPath?: string,
): AgentNameCheck {
	const syntax = agentNameError(name);
	if (syntax) return { error: syntax };
	const trimmed = name.trim();
	const lower = trimmed.toLowerCase();
	const others = known.filter(agent => !selfPath || agent.filePath !== selfPath);
	// File names are case-insensitive on macOS and Windows: `Task.md` and `task.md` are one file.
	if (others.some(agent => agent.scope === scope && agent.name.toLowerCase() === lower)) return { error: "exists" };
	const winner = others.find(agent => agent.name === trimmed);
	if (!winner) return {};
	if (winner.source === "bundled") return { notice: { kind: "overridesBundled" } };
	if (winner.scope === "project") return scope === "user" ? { notice: { kind: "shadowedByProject" } } : {};
	if (winner.scope === "user") return scope === "project" ? { notice: { kind: "overridesUser" } } : {};
	return { notice: { kind: "overridesExtension" } };
}

/** `undefined` when the output schema text is empty or a JSON object; otherwise the parse problem. */
export function outputSchemaError(text: string): string | undefined {
	if (!text.trim()) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (cause) {
		return cause instanceof Error ? cause.message : String(cause);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "not-object";
	return undefined;
}

/** Field-level problems that block saving. */
export interface AgentDraftErrors {
	name?: AgentNameError;
	description?: "required";
	instructions?: "required";
	output?: string;
}

export function draftErrors(draft: AgentDraft, nameCheck: AgentNameCheck): AgentDraftErrors {
	const errors: AgentDraftErrors = {};
	if (nameCheck.error) errors.name = nameCheck.error;
	if (!draft.description.trim()) errors.description = "required";
	if (!draft.instructions.trim()) errors.instructions = "required";
	const output = outputSchemaError(draft.output);
	if (output) errors.output = output;
	return errors;
}
