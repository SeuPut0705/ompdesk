/**
 * OMPdesk's session-control tools (`ompdesk_session_result`, `ompdesk_session_open`, …), called directly or as stock's
 * `xd://` device write. They coordinate the sessions this one opened: their arguments are plumbing (a JSON string of
 * ids and flags), never something the work card draws. The card says what the step does in words instead, here.
 * Only the session tools count: `ompdesk_app`, `ompdesk_notify`, `ompdesk_schedule`, `ompdesk_autopilot`,
 * `ompdesk_report`, `ompdesk_compare` and `ompdesk_merge` do real work and keep the normal stage.
 */
import { AGENT_CONTROL_TOOLS } from "../../../../shared/agent-control";
import { asRecord } from "../../../lib/wire-value";
import type { ToolEntry } from "../../../stores/tools";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const DEVICE_PREFIX = "xd://";

/** The tools that open, read, message, wait on, answer, focus or stop another session. */
const SESSION_TOOLS: ReadonlySet<string> = new Set([
	AGENT_CONTROL_TOOLS.list,
	AGENT_CONTROL_TOOLS.open,
	AGENT_CONTROL_TOOLS.send,
	AGENT_CONTROL_TOOLS.result,
	AGENT_CONTROL_TOOLS.read,
	AGENT_CONTROL_TOOLS.answer,
	AGENT_CONTROL_TOOLS.focus,
	AGENT_CONTROL_TOOLS.stop,
]);

/** The session tool a call runs: its own name, or the `xd://<tool>` a stock `write` addresses; `undefined` for any other call. */
function sessionTool(entry: Pick<ToolEntry, "toolName" | "args">): string | undefined {
	const path = entry.toolName === "write" ? entry.args.path : undefined;
	const name =
		typeof path === "string" && path.startsWith(DEVICE_PREFIX) ? path.slice(DEVICE_PREFIX.length) : entry.toolName;
	return SESSION_TOOLS.has(name) ? name : undefined;
}

/** A call of one of OMPdesk's session tools. */
export function isCoordination(entry: Pick<ToolEntry, "toolName" | "args"> | undefined): boolean {
	return entry !== undefined && sessionTool(entry) !== undefined;
}

/** The tool's own arguments: the call's, or the JSON a device write carries as its `content`. */
function sessionArgs(entry: Pick<ToolEntry, "toolName" | "args">): Record<string, unknown> {
	if (entry.toolName !== "write") return entry.args;
	const content = entry.args.content;
	if (typeof content !== "string") return {};
	try {
		return asRecord(JSON.parse(content)) ?? {};
	} catch {
		return {};
	}
}

/** The session ids a call names: `session` (one) or `sessions` (several); anything that is not a non-empty string is dropped. */
function sessionIds(args: Record<string, unknown>): string[] {
	const value = args.sessions ?? args.session;
	const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
	return list.flatMap(item => (typeof item === "string" && item.trim() ? [item.trim()] : []));
}

/**
 * What a session call is doing, in words, for the head's live line. A wait: "Continues when one of 2 sessions
 * reports", "…all 3 sessions report", "Waiting on <title>" for one session the card can name, else "Waiting on N
 * sessions" or "Waiting on your sessions". Any other session call: "Working with your sessions". `""` for a call that
 * is no session tool. The arguments are never part of the words, and a bare id is never shown: `titleOf` turns an id
 * into its child's title (the work board's rows), and an id it cannot resolve is only counted.
 */
export function coordinationWords(
	entry: ToolEntry | undefined,
	t: Translate,
	titleOf: (id: string) => string | undefined = () => undefined,
): string {
	if (!entry) return "";
	const tool = sessionTool(entry);
	if (!tool) return "";
	if (tool !== AGENT_CONTROL_TOOLS.result) return t("chat.work.coordinating");
	const args = sessionArgs(entry);
	if (args.wait !== true) return t("chat.work.coordinating");
	const ids = sessionIds(args);
	if (ids.length === 0) return t("chat.work.waits.generic");
	const [only] = ids;
	if (ids.length === 1 && only !== undefined) {
		const title = titleOf(only);
		return title ? t("chat.work.waits.one", { name: title }) : t("chat.work.waits.generic");
	}
	return t(
		args.until === "all"
			? "chat.work.waits.all"
			: args.until === "any"
				? "chat.work.waits.any"
				: "chat.work.waits.sessions",
		{ count: ids.length },
	);
}
