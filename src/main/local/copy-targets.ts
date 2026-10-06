/**
 * Copy-picker targets for `get_copy_targets`, derived from the projected
 * transcript: recent assistant messages (with their fenced code and quote
 * blocks as children) and the bash/eval commands they ran. Port of omp's
 * RPC copy targets (pi-tui overlays/copy-targets.ts `buildCopyTargets`).
 */
import type { AgentMessage, CopyTarget, MessageContent } from "../../shared/rpc-types";

/** Assistant messages considered, newest first. */
const MAX_MESSAGES = 50;

const OPEN_FENCE_RE = /^```([^\n]*)$/;
const CLOSE_FENCE_RE = /^```/;
const QUOTE_LINE_RE = /^>(.*)$/;

interface CodeBlock {
	lang: string;
	code: string;
}

type MessageBlock = ({ kind: "code" } & CodeBlock) | { kind: "quote"; text: string };

interface RunnableCommand {
	kind: "bash" | "eval";
	code: string;
	language: string;
}

/**
 * Fenced code and `>`-quoted runs in document order. Fences mask their bodies;
 * an unclosed fence is ordinary text.
 */
export function extractBlocks(text: string): MessageBlock[] {
	const blocks: MessageBlock[] = [];
	const lines = text.split("\n");
	let quote: string[] | undefined;
	const flushQuote = () => {
		if (quote) {
			blocks.push({ kind: "quote", text: quote.join("\n") });
			quote = undefined;
		}
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const open = OPEN_FENCE_RE.exec(line);
		if (open) {
			let close = -1;
			for (let k = i + 1; k < lines.length; k++) {
				if (CLOSE_FENCE_RE.test(lines[k] ?? "")) {
					close = k;
					break;
				}
			}
			if (close !== -1) {
				flushQuote();
				blocks.push({ kind: "code", lang: (open[1] ?? "").trim(), code: lines.slice(i + 1, close).join("\n") });
				i = close;
				continue;
			}
		}
		const quoted = QUOTE_LINE_RE.exec(line);
		if (quoted) {
			const body = quoted[1] ?? "";
			quote ??= [];
			quote.push(body.startsWith(" ") ? body.slice(1) : body);
		} else {
			flushQuote();
		}
	}
	flushQuote();
	return blocks;
}

function contentBlocks(message: AgentMessage): MessageContent[] {
	return Array.isArray(message.content) ? message.content : [];
}

/** Concatenated visible text of an assistant message; undefined when blank. */
function assistantText(message: AgentMessage): string | undefined {
	if (message.role !== "assistant") return undefined;
	let text = "";
	for (const content of contentBlocks(message)) {
		if (content.type === "text") text += content.text;
	}
	return text.trim() ? text : undefined;
}

function evalCode(args: Record<string, unknown>): { code: string; language: string } | undefined {
	const cells = Array.isArray(args.cells) ? args.cells : typeof args.code === "string" ? [args] : undefined;
	if (!cells) return undefined;
	const codes: string[] = [];
	let language: string | undefined;
	for (const cell of cells) {
		if (!cell || typeof cell !== "object" || !("code" in cell)) continue;
		if (typeof cell.code !== "string" || cell.code.length === 0) continue;
		codes.push(cell.code);
		language ??= "language" in cell && cell.language === "js" ? "javascript" : "python";
	}
	return codes.length > 0 ? { code: codes.join("\n\n"), language: language ?? "python" } : undefined;
}

function commandFromToolCall(content: MessageContent): RunnableCommand | undefined {
	if (content.type !== "toolCall") return undefined;
	const args = content.arguments ?? {};
	if (content.name === "bash" && typeof args.command === "string") {
		return { kind: "bash", code: args.command, language: "bash" };
	}
	if (content.name === "eval") {
		const result = evalCode(args);
		if (result) return { kind: "eval", ...result };
	}
	return undefined;
}

function pluralLines(text: string): string {
	const count = text.length === 0 ? 0 : text.split("\n").length;
	return `${count} line${count === 1 ? "" : "s"}`;
}

function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return trimmed.replace(/\s+/g, " ");
	}
	return text.trim().replace(/\s+/g, " ");
}

function messageTarget(text: string, rank: number): CopyTarget {
	const id = `msg:${rank}`;
	const label = firstLine(text);
	const blocks = extractBlocks(text);
	const copyMessage = rank === 1 ? "Copied last message to clipboard" : "Copied message to clipboard";
	if (blocks.length === 0) return { id, label, hint: pluralLines(text), preview: text, content: text, copyMessage };

	const children: CopyTarget[] = [];
	const codes: string[] = [];
	const quotes: string[] = [];
	for (const block of blocks) {
		if (block.kind === "code") {
			const index = codes.length;
			codes.push(block.code);
			const lines = pluralLines(block.code);
			children.push({
				id: `${id}:code:${index}`,
				label: `Block ${index + 1}`,
				hint: block.lang ? `${block.lang} · ${lines}` : lines,
				preview: block.code,
				language: block.lang || undefined,
				content: block.code,
				copyMessage: `Copied code block ${index + 1} to clipboard`,
			});
		} else {
			const index = quotes.length;
			quotes.push(block.text);
			children.push({
				id: `${id}:quote:${index}`,
				label: `Quote ${index + 1}`,
				hint: pluralLines(block.text),
				preview: block.text,
				content: block.text,
				copyMessage: `Copied quote block ${index + 1} to clipboard`,
			});
		}
	}
	if (codes.length > 1) {
		const combined = codes.join("\n\n");
		children.push({
			id: `${id}:all`,
			label: `All ${codes.length} blocks`,
			hint: pluralLines(combined),
			preview: combined,
			content: combined,
			copyMessage: `Copied ${codes.length} code blocks to clipboard`,
		});
	}
	if (quotes.length > 1) {
		const combined = quotes.join("\n\n");
		children.push({
			id: `${id}:all-quotes`,
			label: `All ${quotes.length} quotes`,
			hint: pluralLines(combined),
			preview: combined,
			content: combined,
			copyMessage: `Copied ${quotes.length} quote blocks to clipboard`,
		});
	}
	const hint = [pluralLines(text)];
	if (codes.length > 0) hint.push(`${codes.length} code`);
	if (quotes.length > 0) hint.push(`${quotes.length} quote`);
	return { id, label, hint: hint.join(" · "), preview: text, content: text, copyMessage, children };
}

function commandTarget(command: RunnableCommand, rank: number): CopyTarget {
	return {
		id: `cmd:${rank}`,
		label: firstLine(command.code) || (command.kind === "bash" ? "Bash command" : "Eval code"),
		hint: `${command.kind} · ${pluralLines(command.code)}`,
		preview: command.code,
		language: command.language,
		content: command.code,
		copyMessage: `Copied ${command.kind === "bash" ? "bash command" : "eval code"} to clipboard`,
	};
}

/** Text of the latest displayed handoff custom message, if any. */
function lastHandoffText(messages: readonly AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "custom" || message.customType !== "handoff" || !message.display) continue;
		if (typeof message.content === "string") return message.content.trim() || undefined;
		let text = "";
		for (const content of contentBlocks(message)) {
			if (content.type === "text") text += content.text;
		}
		return text.trim() || undefined;
	}
	return undefined;
}

/** Recent assistant messages (newest first), each followed by the commands its turn ran. */
export function buildCopyTargets(messages: readonly AgentMessage[]): CopyTarget[] {
	const targets: CopyTarget[] = [];
	const pending: RunnableCommand[] = [];
	let messageRank = 0;
	let commandRank = 0;
	const appendCommands = (commands: readonly RunnableCommand[]) => {
		for (const command of commands) {
			commandRank += 1;
			targets.push(commandTarget(command, commandRank));
		}
	};

	for (let i = messages.length - 1; i >= 0 && messageRank < MAX_MESSAGES; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const commands: RunnableCommand[] = [];
		const content = contentBlocks(message);
		for (let j = content.length - 1; j >= 0; j--) {
			const block = content[j];
			const command = block && commandFromToolCall(block);
			if (command) commands.push(command);
		}
		const text = assistantText(message);
		if (!text) {
			pending.push(...commands);
			continue;
		}
		messageRank += 1;
		targets.push(messageTarget(text, messageRank));
		appendCommands(pending);
		appendCommands(commands);
		pending.length = 0;
	}

	if (messageRank === 0) {
		const handoff = lastHandoffText(messages);
		if (handoff) {
			targets.unshift({
				id: "handoff",
				label: "Handoff context",
				hint: pluralLines(handoff),
				preview: handoff,
				content: handoff,
				copyMessage: "Copied handoff context to clipboard",
			});
		}
		appendCommands(pending);
	}
	return targets;
}
