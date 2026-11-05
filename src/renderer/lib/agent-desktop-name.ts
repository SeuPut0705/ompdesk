import { AGENT_DESKTOP_TOOL_PREFIX } from "../../../resources/gui-bridge/modes/computer-use-contracts";
import { asNonEmptyString } from "./wire-value";

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
