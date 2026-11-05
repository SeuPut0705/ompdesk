import { AGENT_DESKTOP_TOOL_PREFIX } from "../../../resources/gui-bridge/modes/computer-use-contracts";
import { asNonEmptyString } from "./wire-value";
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

/**
 * The commands that only look (agent-desktop's observation, system and guide commands): one that comes up empty (a
 * find or wait with no match, a get of an element gone) is the answer, no failure, as a read or search that found
 * nothing is (`work-findings.ts` `stepOperations`).
 */
const LOOKS =
	/^desktop_(?:snapshot|find|get|is|wait|screenshot|list_\w+|status|permissions|version|skills_\w+|clipboard_get|session_list|trace_show)$/;

export function isAgentDesktopLookup(call: AgentDesktopCall): boolean {
	return LOOKS.test(call.command);
}

/**
 * What makes a later call the same desktop action (`work-checks.ts` `callKeys`): its command and the element it acts
 * on (the ref, else the app and window), not the rest of its arguments: typing other text into the same field after a
 * refused try is the retry.
 */
export function agentDesktopTargetKey(call: AgentDesktopCall): string {
	const field = (key: string) => asNonEmptyString(call.args[key]) ?? "";
	const ref = field("ref_id") || field("ref");
	return `desktop\0${call.command}\0${ref || `${field("app")}\0${field("window_id")}`}`;
}
