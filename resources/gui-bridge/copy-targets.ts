/**
 * GUI copy-picker ranking, tree labels and handoff adapter. Markdown/text/tool
 * extraction is supplied by stock pi-tui/overlays/copy-targets in the bridge.
 */
import type { AgentMessage, CopyTarget, MessageContent } from "../../src/shared/rpc-types";

export interface CopyExtractors {
	extractBlocks(text: string): Array<{ kind: "code"; lang: string; code: string } | { kind: "quote"; text: string }>;
	assistantText(message: AgentMessage): string | undefined;
	commandFromToolCall(content: Extract<MessageContent, { type: "toolCall" }>): RunnableCommand | undefined;
}

interface RunnableCommand {
	kind: "bash" | "eval";
	code: string;
	language: string;
}

/** Assistant messages considered, newest first. */
const MAX_MESSAGES = 50;

function contentBlocks(message: AgentMessage): MessageContent[] {
	return Array.isArray(message.content) ? message.content : [];
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

function messageTarget(text: string, rank: number, stock: CopyExtractors): CopyTarget {
	const id = `msg:${rank}`;
	const label = firstLine(text);
	const blocks = stock.extractBlocks(text);
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
export function buildCopyTargets(messages: readonly AgentMessage[], stock: CopyExtractors): CopyTarget[] {
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
			const command = block?.type === "toolCall" && stock.commandFromToolCall(block);
			if (command) commands.push(command);
		}
		const text = stock.assistantText(message);
		if (!text) {
			pending.push(...commands);
			continue;
		}
		messageRank += 1;
		targets.push(messageTarget(text, messageRank, stock));
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
