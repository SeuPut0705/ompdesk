import { AGENT_DESKTOP_TOOL_PREFIX } from "../../../resources/gui-bridge/modes/computer-use-contracts";
import { resultText } from "./format";
import { asNonEmptyString, asRecord } from "./wire-value";
import { decodeXdevPayload, xdevWriteTarget } from "./xdev";

/**
 * agent-desktop's tool names and argument summary, apart from its result parser (`agent-desktop.ts`): the tool row's
 * header needs only these, and the parser rides the renderer's lazy chunk (the phone's first-screen budget).
 */

/** Whether a tool name is one of agent-desktop's (directly, or as the device of an `xd://` write). */
export function isAgentDesktopTool(name: string): boolean {
	return name.startsWith(AGENT_DESKTOP_TOOL_PREFIX);
}

/** `mcp__agent_desktop_desktop_list_windows` → `list windows`; the words a header and the first summary use. */
export function agentDesktopCommand(tool: string): string {
	const bare = isAgentDesktopTool(tool) ? tool.slice(AGENT_DESKTOP_TOOL_PREFIX.length) : tool;
	return (bare.startsWith("desktop_") ? bare.slice("desktop_".length) : bare).replaceAll("_", " ");
}

const SUMMARY_TEXT_CHARS = 40;

/**
 * The collapsed row's target, from the call's arguments alone (the result may not exist yet): the app, the element
 * (`@e12`), the text typed or set, the key combo, the guide asked for and the window.
 */
export function agentDesktopSummary(args: Record<string, unknown>): string {
	const field = (...keys: string[]) => keys.map(key => asNonEmptyString(args[key])).find(Boolean);
	const ref = field("ref_id", "ref");
	const typed = field("text", "value")?.replace(/\s+/g, " ").trim();
	const keys = field("combo", "keys", "key");
	return [
		field("app"),
		ref && (ref.startsWith("@") ? ref : `@${ref}`),
		typed && `“${typed.length > SUMMARY_TEXT_CHARS ? `${typed.slice(0, SUMMARY_TEXT_CHARS)}…` : typed}”`,
		keys,
		field("name"),
		field("window_id"),
	]
		.filter(Boolean)
		.join(" ");
}

/** One agent-desktop call, whether the model called its tool directly or wrote it as an `xd://` device. */
export interface AgentDesktopCall {
	/** The tool's own name without the server prefix (`desktop_click`). */
	command: string;
	args: Record<string, unknown>;
}

export function agentDesktopCall(toolName: string, args: Record<string, unknown>): AgentDesktopCall | undefined {
	if (isAgentDesktopTool(toolName)) return { command: toolName.slice(AGENT_DESKTOP_TOOL_PREFIX.length), args };
	const device = toolName === "write" ? xdevWriteTarget(args) : null;
	if (!device || !isAgentDesktopTool(device)) return undefined;
	return { command: device.slice(AGENT_DESKTOP_TOOL_PREFIX.length), args: decodeXdevPayload(args.content) };
}

/** agent-desktop's observation, system and guide commands: they read the desktop and change nothing on it. */
const LOOKS =
	/^desktop_(?:snapshot|find|get|is|wait|screenshot|list_\w+|status|permissions|version|skills_\w+|clipboard_get|session_list|trace_show)$/;

/** A failed call's `error.code`; null when the result holds no agent-desktop envelope (a transport or MCP failure). */
export function agentDesktopErrorCode(result: unknown): string | null {
	// Stock prefixes an MCP error result's text with `Error: `.
	const text = resultText(result)
		.trim()
		.replace(/^Error:\s*/, "");
	if (!text.startsWith("{")) return null;
	try {
		const parsed: unknown = JSON.parse(text);
		const error = asRecord(asRecord(parsed)?.error);
		return asNonEmptyString(error?.code) ?? null;
	} catch {
		return null;
	}
}

/**
 * The failures that only say the look found nothing: a find, get or is of an element that is not there, a wait whose
 * condition never came, a notification gone. agent-desktop answers a find with no match `ok` and no matches; these
 * are its error-shaped answers of the same kind. The step's row reads "Nothing matched", not Failed.
 */
export function isAgentDesktopNoMatch(call: AgentDesktopCall, code: string | null): boolean {
	if (code === "NOTIFICATION_NOT_FOUND") return true;
	if (code === "ELEMENT_NOT_FOUND") return /^desktop_(?:find|get|is)$/.test(call.command);
	return code === "TIMEOUT" && call.command === "desktop_wait";
}

/** Failures that say computer use cannot work here at all: never a look that merely asked the wrong question. */
const UNUSABLE: Record<string, true> = {
	PERM_DENIED: true,
	PLATFORM_NOT_SUPPORTED: true,
	POLICY_DENIED: true,
	INTERNAL: true,
};

/**
 * Whether a failed call is a look whose failure decides nothing (`work-findings.ts` `stepOperations`), as a read's or
 * a search's does not: a no match, or a look that asked wrongly (`INVALID_ARGS`, a stale ref, an incomplete read). A
 * denied permission, an unusable platform or policy, an internal error, and a failure with no envelope at all (the
 * server or its transport failed) still count: they say computer use did not work.
 */
export function isAgentDesktopLookupMiss(call: AgentDesktopCall, result: unknown): boolean {
	if (!LOOKS.test(call.command)) return false;
	const code = agentDesktopErrorCode(result);
	return code !== null && !UNUSABLE[code];
}

/** Arguments that carry what is typed or set, not what is acted on, plus the model's own intent line. */
const NOT_TARGET: Record<string, true> = { text: true, value: true, i: true, intent: true };

/**
 * What makes a later call the same desktop action (`work-checks.ts` `callKeys`): its command and every argument that
 * says what it acts on (the ref, the app and window, a shortcut's keys, a point, a menu path, a name), with keys in a
 * stable order. What is typed or set stays out, so typing other text into the same field after a refused try is the
 * retry, while a cmd+c never stands for a failed cmd+s, nor a click at one point for a click at another.
 */
export function agentDesktopTargetKey(call: AgentDesktopCall): string {
	// `ref` is the name a model guesses for `ref_id` (stock refuses it: "ref_id is required"): the same element.
	const named = (key: string) => (key === "ref" ? "ref_id" : key);
	const target = Object.keys(call.args)
		.filter(key => !NOT_TARGET[key] && call.args[key] !== undefined)
		.map(key => [named(key), call.args[key]] as const)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `desktop\0${call.command}\0${JSON.stringify(target)}`;
}
