/**
 * Pure rules of the context inspector (context-inspect.ts): how the live
 * session's provider-facing pieces split into the GUI's categories, and the
 * preview text one entry shows. No omp imports, so the unit test runs anywhere.
 */

/** The GUI's categories: stock's five (`getContextBreakdown`) with tools split by source and context files pulled out of system context. */
export type ContextCategory =
	| "systemPrompt"
	| "systemContext"
	| "memoryFiles"
	| "builtinTools"
	| "mcpTools"
	| "extensionTools"
	| "skills"
	| "messages";

export type ToolSource = "builtin" | "mcp" | "extension";

export const TOOL_CATEGORY: Record<ToolSource, ContextCategory> = {
	builtin: "builtinTools",
	mcp: "mcpTools",
	extension: "extensionTools",
};

/** Mixdog caps an entry's preview at 32k characters; so does the inspector. */
export const PREVIEW_MAX_CHARS = 32_000;

export interface Preview {
	text: string;
	/** Characters before the cap. */
	totalChars: number;
	truncated: boolean;
}

export function capPreview(text: string): Preview {
	return text.length > PREVIEW_MAX_CHARS
		? { text: text.slice(0, PREVIEW_MAX_CHARS), totalChars: text.length, truncated: true }
		: { text, totalChars: text.length, truncated: false };
}

export interface RepoRulesFile {
	path: string;
	/** The whole `<file …>…</file>` block, as the model reads it. */
	block: string;
	/** The file's content inside the block. */
	content: string;
}

const REPO_RULES = /<repo-rules>([\s\S]*?)<\/repo-rules>/;
const FILE_BLOCK = /<file path="([^"]*)">\n([\s\S]*?)\n<\/file>/g;

/**
 * The context files (AGENTS.md, CLAUDE.md, …) stock rendered into a system
 * prompt block. Stock's `prompts/system/project-prompt.md` writes each one as
 * `<file path="…">\n{content}\n</file>` inside `<repo-rules>`; the inspector
 * reads them back from the text the model actually gets, so a disabled or
 * deduplicated file never shows.
 */
export function repoRulesFiles(part: string): RepoRulesFile[] {
	const rules = REPO_RULES.exec(part)?.[1];
	if (!rules) return [];
	return Array.from(rules.matchAll(FILE_BLOCK), match => ({
		path: match[1] ?? "",
		block: match[0],
		content: match[2] ?? "",
	}));
}

export interface InspectSkill {
	readonly name: string;
	readonly description?: string;
	readonly hide?: boolean;
}

/**
 * Skills stock lists in the system prompt. Copy of the private
 * `renderedSkills` filter in stock `pi-tui/status-line/context-usage.ts`
 * (which mirrors `buildSystemPrompt`): none without the `read` tool, never a
 * hidden one. Stock does not export it.
 */
export function promptSkills<T extends InspectSkill>(skills: readonly T[], toolNames: readonly string[]): T[] {
	if (!toolNames.includes("read")) return [];
	return skills.filter(skill => skill.hide !== true);
}

/** One provider message block, loosely typed: the inspector prints any shape stock may add. */
interface Block {
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
	name?: unknown;
	arguments?: unknown;
	mimeType?: unknown;
}

export interface LlmMessageLike {
	role: string;
	content?: unknown;
	toolName?: unknown;
}

function blockText(block: Block): string {
	switch (block.type) {
		case "text":
			return typeof block.text === "string" ? block.text : "";
		case "thinking":
			return typeof block.thinking === "string" && block.thinking ? `[thinking]\n${block.thinking}` : "";
		case "toolCall":
			return `[tool call] ${String(block.name)} ${JSON.stringify(block.arguments ?? {}, null, 2)}`;
		case "image":
			return `[image${typeof block.mimeType === "string" ? ` ${block.mimeType}` : ""}]`;
		default:
			return `[${String(block.type)}]`;
	}
}

/**
 * The text of messages as stock's `convertToLlm` hands them to the provider:
 * text, thinking, tool calls with their arguments, a marker per image.
 */
export function llmMessagesText(messages: readonly LlmMessageLike[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		const content = message.content;
		const body =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.map(block => (typeof block === "object" && block !== null ? blockText(block) : ""))
							.filter(Boolean)
							.join("\n\n")
					: "";
		const head =
			message.role === "toolResult" ? `[${message.role} · ${String(message.toolName)}]` : `[${message.role}]`;
		parts.push(`${head}\n${body}`);
	}
	return parts.join("\n\n");
}

/** One line for a list row: the first line with words (not a bare `[marker]` or `<tag>`), cut at 120 characters. */
export function snippet(text: string): string {
	const line =
		text
			.split("\n")
			.map(part => part.trim())
			.find(part => part && !/^(\[[^\]]*\]|<\/?[\w-]+>)$/.test(part)) ?? "";
	return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
