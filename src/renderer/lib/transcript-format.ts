import type { AgentMessage, MessageContent, TodoPhase, TodoTask } from "../../shared/rpc-types";
import { messageText } from "./messages";

const TOOL_ARGS_CHAR_LIMIT = 600;
const TOOL_RESULT_CHAR_LIMIT = 1200;

function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`;
}

/** One-line JSON summary of tool arguments (compact, single-line, capped). */
function summarizeArgs(args: Record<string, unknown>): string {
	try {
		return truncate(JSON.stringify(args), TOOL_ARGS_CHAR_LIMIT);
	} catch {
		return "[unserializable arguments]";
	}
}

function fence(text: string, lang?: string): string {
	// Longer fences win when the payload itself contains triple backticks.
	const barrier = text.includes("```") ? "````" : "```";
	return `${barrier}${lang ?? ""}\n${text}\n${barrier}`;
}

const ROLE_HEADINGS: Partial<Record<AgentMessage["role"], string>> = {
	user: "User",
	assistant: "Assistant",
	system: "System",
	bashExecution: "Bash",
	pythonExecution: "Python",
	branchSummary: "Branch Summary",
	compactionSummary: "Compaction Summary",
};

function formatContentBlock(block: MessageContent, lines: string[]): void {
	switch (block.type) {
		case "text": {
			const text = block.text.trim();
			if (text) lines.push(text, "");
			return;
		}
		case "thinking": {
			const thinking = block.thinking.trim();
			if (thinking) {
				lines.push("> **Thinking**", ">");
				for (const line of thinking.split("\n")) lines.push(`> ${line}`);
				lines.push("");
			}
			return;
		}
		case "toolCall":
			lines.push(`- **Tool call:** \`${block.name}\` — ${summarizeArgs(block.arguments)}`, "");
			return;
		case "image":
			lines.push("- [image]", "");
			return;
	}
}

function formatMessage(message: AgentMessage, lines: string[]): void {
	const heading = ROLE_HEADINGS[message.role];
	if (heading !== undefined) {
		const text = messageText(message);
		// Assistant turns with only tool calls still earn a header; empty
		// headers for content-less messages are noise, so gate on content.
		const blocks = Array.isArray(message.content) ? message.content : [];
		if (!text && blocks.length === 0 && !message.code && !message.summary) return;
		lines.push(`## ${heading}`, "");
		if (Array.isArray(message.content)) {
			for (const block of message.content) formatContentBlock(block, lines);
		} else if (text) {
			lines.push(text, "");
		}
		if (message.code) lines.push(fence(message.code, "bash"), "");
		if (message.output) lines.push(fence(truncate(message.output, TOOL_RESULT_CHAR_LIMIT)), "");
		if (message.summary && !text) lines.push(message.summary, "");
		return;
	}
	if (message.role === "toolResult") {
		const label = message.toolName ? `\`${message.toolName}\`` : "tool";
		const errorMark = message.isError ? " (error)" : "";
		const output = truncate(messageText(message) || message.output || "", TOOL_RESULT_CHAR_LIMIT);
		if (!output) return;
		lines.push(`**Tool result** ${label}${errorMark}:`, "", fence(output), "");
		return;
	}
	// custom/hookMessage/fileMention and unmapped roles: keep the text if any.
	const text = messageText(message);
	if (text) lines.push(`## Message (${message.customType ?? message.command ?? message.role})`, "", text, "");
}

/**
 * Render the full display transcript as readable markdown: role headers per
 * message, thinking folded into blockquotes, tool calls as one-line summaries
 * with capped JSON args, tool results as fenced blocks.
 */
export function formatTranscriptMarkdown(messages: AgentMessage[]): string {
	const lines: string[] = ["# Session Transcript", ""];
	for (const message of messages) formatMessage(message, lines);
	return lines.join("\n").trimEnd();
}

const TODO_STATUS_SUFFIX: Record<TodoTask["status"], string> = {
	pending: "",
	in_progress: " _(in progress)_",
	completed: "",
	abandoned: " _(abandoned)_",
	blocked: " _(blocked)_",
};

/** Render todo phases as a GFM task list (`- [x]` completed, `- [ ]` open). */
export function formatTodoMarkdown(phases: TodoPhase[]): string {
	const lines: string[] = ["# Todos", ""];
	for (const phase of phases) {
		lines.push(`## ${phase.name}`, "");
		for (const task of phase.tasks) {
			const box = task.status === "completed" ? "[x]" : "[ ]";
			const content = task.status === "abandoned" ? `~~${task.content}~~` : task.content;
			lines.push(`- ${box} ${content}${TODO_STATUS_SUFFIX[task.status] ?? ""}`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
