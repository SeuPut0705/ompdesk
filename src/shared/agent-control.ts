/**
 * OMPdesk control tools (agent-control): host tools every tab's omp gets through stock RPC `set_host_tools`
 * (like `gui_terminal_read`), executed in main by `src/main/agent-control/`. They let the main agent open
 * sessions, message them, read their results, show them and notify the user. Stock registers host tools on
 * the RPC session only; subagents are separate sessions built without them, so only the main agent has them.
 *
 * Dependency-free: main, the renderer and their tests import it.
 */

/** Prefs key; on unless stored `false`. Off: the tools are unregistered from every live local session. */
export const AGENT_CONTROL_PREF = "agentControl";

/**
 * Session files (`.jsonl` paths) the user kept other agents away from (Sidebar session menu › Hide from other
 * agents), stored in the `sidebar` prefs blob as `agentHidden`. Such a session is listed as hidden and refuses
 * read, send, wait, answer, show and stop; the session's own agent still uses the tools. Sessions on this computer.
 */
export const AGENT_HIDDEN_PREFS_KEY = "sidebar";

export function agentHiddenPaths(sidebarBlob: unknown): Set<string> {
	const list =
		sidebarBlob && typeof sidebarBlob === "object" && "agentHidden" in sidebarBlob ? sidebarBlob.agentHidden : [];
	return new Set(Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : []);
}

/** Prefs key, default OFF: an orchestrating agent may approve another session's pending tool approval. */
export const AGENT_CONTROL_APPROVE_PREF = "agentControlApprove";

/** Prefs key, default OFF: an orchestrating agent may stop, close or delete sessions it did not open (else one confirmation card each). */
export const AGENT_CONTROL_MANAGE_PREF = "agentControlManage";

/** Title prefix of every confirmation card the control tools raise; `ompdesk_session_answer` never answers one. */
export const AGENT_CARD_PREFIX = "[OMPdesk] ";

/** Stock's tool approval: a `select` titled "Allow tool: …" with exactly Approve and Deny (mirrors the renderer's `isApprovalRequest`). */
export const APPROVAL_TITLE_PREFIX = "Allow tool: ";

export function isApprovalSelect(request: { method: string; title?: unknown; options?: unknown }): boolean {
	return (
		request.method === "select" &&
		typeof request.title === "string" &&
		request.title.startsWith(APPROVAL_TITLE_PREFIX) &&
		Array.isArray(request.options) &&
		request.options.length === 2 &&
		request.options[0] === "Approve" &&
		request.options[1] === "Deny"
	);
}

export function agentControlEnabled(value: unknown): boolean {
	return value !== false;
}

/** Tool names (stock mounts each as `xd://<name>`). */
export const AGENT_CONTROL_TOOLS = {
	list: "ompdesk_sessions",
	open: "ompdesk_session_open",
	send: "ompdesk_session_send",
	result: "ompdesk_session_result",
	read: "ompdesk_session_read",
	answer: "ompdesk_session_answer",
	focus: "ompdesk_tab_focus",
	notify: "ompdesk_notify",
	stop: "ompdesk_session_stop",
} as const;

export type AgentControlToolName = (typeof AGENT_CONTROL_TOOLS)[keyof typeof AGENT_CONTROL_TOOLS];

export function isAgentControlTool(name: string): name is AgentControlToolName {
	return (Object.values(AGENT_CONTROL_TOOLS) as string[]).includes(name);
}

/** Sessions one session may hold open that it opened itself; a further open is refused until one closes. */
export const MAX_AGENT_SESSIONS = 6;
/** Sessions one session may open within one of its turns (a fan-out is one call of up to this many). */
export const MAX_OPENS_PER_TURN = 4;
/** Sessions one session may open within a rolling hour. */
export const MAX_OPENS_PER_HOUR = 12;
/** A message chain A→B→C… started by an agent's send may be at most this many hops deep; the next send is refused. */
export const MAX_RELAY_HOPS = 3;
/** Agent messages from one session to one other session within a minute. */
export const MAX_PAIR_MESSAGES_PER_MINUTE = 6;
/** Messages one session's agent may send within one of its turns, and within a rolling hour (opens count too). */
export const MAX_MESSAGES_PER_TURN = 20;
export const MAX_MESSAGES_PER_HOUR = 60;

/** How a session is shown in the calling session's window. */
export type AgentControlPlacement = "focus" | "split-right" | "split-down";

/**
 * main → window (`AGENT_CONTROL_VIEW`): show `tabId` the way a user's pick (`focus`) or split does, or `close` it
 * the way the user's close does (after the person approved `ompdesk_session_stop` with `close`), so unsaved Files
 * edits, split membership and the closed-tab history follow the same rules.
 */
export const AGENT_CONTROL_VIEW = "agent-control:view";

export interface AgentControlViewEvent {
	tabId: string;
	how: AgentControlPlacement | "close";
}

/**
 * A message one session's agent sends another session arrives as an ordinary stock prompt, steer or follow-up
 * wrapped in this tag, so the receiving model knows another agent wrote it and every surface that renders
 * the transcript (live, reloaded, a paired host's tab) shows it as "sent by an agent".
 */
export const AGENT_MESSAGE_TAG = "ompdesk-agent-message";

const WRAPPED = new RegExp(`^<${AGENT_MESSAGE_TAG} from="([^"]*)">\\n([\\s\\S]*)\\n</${AGENT_MESSAGE_TAG}>$`);

/** The text a session receives: `body` from the session titled `from` (empty when it has no title yet). */
export function wrapAgentMessage(body: string, from: string): string {
	const attribute = from
		.replaceAll(/\s+/g, " ")
		.trim()
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
	// A body cannot carry its own wrapper (an agent forging another sender, or closing this one early).
	const safe = body
		.replaceAll(`<${AGENT_MESSAGE_TAG}`, `<\u200b${AGENT_MESSAGE_TAG}`)
		.replaceAll(`</${AGENT_MESSAGE_TAG}`, `</\u200b${AGENT_MESSAGE_TAG}`);
	return `<${AGENT_MESSAGE_TAG} from="${attribute}">\n${safe}\n</${AGENT_MESSAGE_TAG}>`;
}

export interface AgentMessage {
	/** The sending session's title; "" when it had none. */
	from: string;
	body: string;
}

/** The parts of a wrapped message; null for anything else (a person's own prompt). */
export function parseAgentMessage(text: string): AgentMessage | null {
	const match = WRAPPED.exec(text);
	if (!match) return null;
	const from = (match[1] ?? "")
		.replaceAll("&quot;", '"')
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
	return { from, body: match[2] ?? "" };
}
