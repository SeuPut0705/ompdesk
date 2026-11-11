/**
 * Pure rules of the context inspector (context-inspect.ts): how the live
 * session's provider-facing pieces split into the GUI's categories, and the
 * preview text one entry shows. No omp imports, so the unit test runs anywhere.
 */

/** The GUI's categories: stock's six (`getContextBreakdown`) with tools split by source; `memoryFiles` is stock's instruction files. */
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

/** The fields of stock's `SystemPromptSource` (`pi-tui/status-line/context-usage.ts`) the inspector reads. */
export interface PromptSource {
	readonly kind: "instruction-files" | "skills";
	/** UTF-16 range of the source in its block. */
	readonly start: number;
	readonly end: number;
}

export const SOURCE_CATEGORY: Record<PromptSource["kind"], ContextCategory> = {
	"instruction-files": "memoryFiles",
	skills: "skills",
};

/**
 * `block` split around the sources stock's `claimPromptSources` attributed to it (sorted by start): each source's
 * own text, and the block's text without them. Stock's status line and `/context` count a block this way, so the
 * entries add up to its category totals.
 */
export function splitBlock<T extends PromptSource>(
	block: string,
	sources: readonly T[],
): { sources: Array<{ source: T; text: string }>; rest: string } {
	let rest = "";
	let cursor = 0;
	const split = sources.map(source => {
		rest += block.slice(cursor, source.start);
		cursor = source.end;
		return { source, text: block.slice(source.start, source.end) };
	});
	return { sources: split, rest: rest + block.slice(cursor) };
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
