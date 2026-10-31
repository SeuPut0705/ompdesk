/**
 * What the bot's tabs do, as activity log entries (`shared/bot-activity.ts`): each tool call one of them starts (the
 * pool's `observeToolCalls`) becomes one line with its kind and, for a read, the file or page it read (`target`, which
 * `ompdesk_bot visited` and the log's "Read" filter list). Calls whose effect the log hears elsewhere are left out:
 * `ompdesk_bot` (the desk logs its own changes), `ompdesk_notify` (the notice router logs where it went) and `todo`.
 */
import type { BotActivityDraft, BotActivityKind, BotActivityTarget } from "../../shared/bot-activity";

/** Tool name → kind; a tool not listed is `tool`. */
const KIND_BY_TOOL: Record<string, BotActivityKind> = {
	read: "read",
	grep: "read",
	glob: "read",
	find: "read",
	ast_grep: "read",
	lsp: "read",
	web_search: "read",
	fetch: "read",
	browser: "read",
	edit: "change",
	write: "change",
	ast_edit: "change",
	notebook: "change",
	bash: "run",
	eval: "run",
	python: "run",
	task: "sessions",
	ompdesk_session_answer: "approval",
};
const SKIPPED: Record<string, true> = { ompdesk_bot: true, ompdesk_notify: true, todo: true, todo_write: true };

function field(args: unknown, key: string): string | undefined {
	if (!args || typeof args !== "object" || !(key in args)) return undefined;
	const value: unknown = Reflect.get(args, key);
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstLine(text: string): string {
	return text.split("\n", 1)[0] ?? "";
}

/** The files an `edit` patch names in its `[path#TAG]` headers. */
function editedPaths(input: string): string[] {
	return [...input.matchAll(/^\[([^\]#\n]+)#[0-9A-Fa-f]{4}\]/gm)].flatMap(match => (match[1] ? [match[1]] : []));
}

function targetOf(toolName: string, args: unknown): BotActivityTarget | undefined {
	if (toolName === "web_search") {
		const query = field(args, "query");
		return query ? { type: "query", value: query } : undefined;
	}
	const url = field(args, "url");
	if (url) return { type: "url", value: url };
	const path = field(args, "path") ?? field(args, "file") ?? field(args, "file_path");
	if (path) return /^https?:\/\//.test(path) ? { type: "url", value: path } : { type: "file", value: path };
	const session = field(args, "session");
	if (session) return { type: "session", value: session };
	if (toolName === "edit") {
		const [first] = editedPaths(field(args, "input") ?? "");
		if (first) return { type: "file", value: first };
	}
	return undefined;
}

/** One tool call of a bot tab as an activity entry, or null for a call the log does not keep. */
export function botToolActivity(toolName: string, args: unknown): BotActivityDraft | null {
	if (SKIPPED[toolName]) return null;
	const kind: BotActivityKind = KIND_BY_TOOL[toolName] ?? (toolName.startsWith("ompdesk_") ? "sessions" : "tool");
	const target = targetOf(toolName, args);
	const command = field(args, "command") ?? field(args, "code");
	const subject =
		toolName === "edit"
			? editedPaths(field(args, "input") ?? "").join(", ")
			: command
				? firstLine(command)
				: (target?.value ?? field(args, "action") ?? field(args, "message") ?? "");
	return {
		kind,
		action: "tool",
		by: "bot",
		tool: toolName.slice(0, 80),
		text: subject ? `${toolName} ${subject}` : toolName,
		...(target ? { target } : {}),
	};
}
