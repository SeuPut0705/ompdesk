import { resultDetails } from "./format";
import { asNonEmptyString, asNumber, asRecord, asString } from "./wire-value";

/**
 * agent-desktop's MCP tools as the transcript reads them (`mcp__agent_desktop_desktop_<command>`; see
 * resources/gui-bridge/modes/computer-use-contracts.ts). Every call answers one JSON envelope,
 * `{ok, command, data?}` or `{ok: false, command, error}`, in the first text block and again, without image bytes, as
 * `structuredContent`. Nothing here throws on a shape it does not know: a renderer gets `undefined` and falls back.
 */

/** What a failed call says; `delivery` and `retry` come from the envelope's `disposition`. */
export interface AgentDesktopError {
	code: string;
	message: string;
	suggestion?: string;
	delivery?: string;
	retry?: string;
}

export interface AgentDesktopEnvelope {
	ok: boolean;
	command: string;
	data?: Record<string, unknown>;
	error?: AgentDesktopError;
}

function toEnvelope(value: unknown): AgentDesktopEnvelope | undefined {
	const record = asRecord(value);
	if (!record || typeof record.ok !== "boolean") return undefined;
	const envelope: AgentDesktopEnvelope = { ok: record.ok, command: asString(record.command) ?? "" };
	const data = asRecord(record.data);
	if (data) envelope.data = data;
	const error = asRecord(record.error);
	if (error) {
		const disposition = asRecord(error.disposition);
		envelope.error = {
			code: asString(error.code) ?? "ERROR",
			message: asString(error.message) ?? "",
			suggestion: asNonEmptyString(error.suggestion),
			delivery: asNonEmptyString(disposition?.delivery),
			retry: asNonEmptyString(disposition?.retry),
		};
	}
	return envelope;
}

/** The first text block of a result: the envelope's JSON text. */
function firstText(result: unknown): string | undefined {
	const content = asRecord(result)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		const record = asRecord(block);
		if (record?.type === "text" && typeof record.text === "string") return record.text;
	}
	return undefined;
}

/**
 * The envelope of a tool result: `details.structuredContent` when stock kept it, else the first text block parsed as
 * JSON. `undefined` for a result that is no envelope (a transport error's plain text, a half-streamed body).
 */
export function parseAgentDesktopResult(result: unknown): AgentDesktopEnvelope | undefined {
	const structured = toEnvelope(resultDetails(result)?.structuredContent);
	if (structured) return structured;
	const text = firstText(result)?.trim();
	if (!text?.startsWith("{")) return undefined;
	try {
		return toEnvelope(JSON.parse(text));
	} catch {
		return undefined;
	}
}

/** One element of a snapshot, a find match, a window or an app, as one tree row. */
export interface AgentDesktopNode {
	role: string;
	name?: string;
	ref?: string;
	children: AgentDesktopNode[];
}

/** Rows past this stay out of the tree: a whole-desktop snapshot holds thousands of refs. */
export const AGENT_DESKTOP_MAX_NODES = 400;
const MAX_DEPTH = 40;

const LIST_ROLES: Record<string, string> = { matches: "match", windows: "window", apps: "app" };

export interface AgentDesktopNodes {
	nodes: AgentDesktopNode[];
	/** Nodes in the result beyond {@link AGENT_DESKTOP_MAX_NODES}. */
	omitted: number;
}

function toNode(value: unknown, fallbackRole: string, budget: { left: number; omitted: number }, depth: number) {
	const record = asRecord(value);
	if (!record) return undefined;
	if (budget.left <= 0) {
		budget.omitted++;
		return undefined;
	}
	budget.left--;
	const ref = asNonEmptyString(record.ref_id) ?? asNonEmptyString(record.id) ?? asNumber(record.id)?.toString();
	const node: AgentDesktopNode = {
		role: asNonEmptyString(record.role) ?? fallbackRole,
		name: asNonEmptyString(record.name) ?? asNonEmptyString(record.title) ?? asNonEmptyString(record.app),
		ref,
		children: [],
	};
	if (depth < MAX_DEPTH && Array.isArray(record.children)) {
		for (const child of record.children) {
			const built = toNode(child, "node", budget, depth + 1);
			if (built) node.children.push(built);
		}
	}
	return node;
}

/**
 * The rows of a result that lists elements: a snapshot's `tree`, a find's `matches`, `list_windows`' `windows`,
 * `list_apps`' `apps`. `undefined` when the data holds none of them.
 */
export function agentDesktopNodes(data: Record<string, unknown> | undefined): AgentDesktopNodes | undefined {
	if (!data) return undefined;
	const budget = { left: AGENT_DESKTOP_MAX_NODES, omitted: 0 };
	const roots: AgentDesktopNode[] = [];
	const tree = asRecord(data.tree);
	if (tree) {
		const root = toNode(tree, "node", budget, 0);
		if (root) roots.push(root);
		return { nodes: roots, omitted: budget.omitted };
	}
	for (const [key, role] of Object.entries(LIST_ROLES)) {
		const list = data[key];
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			const built = toNode(item, role, budget, 0);
			if (built) roots.push(built);
		}
		return { nodes: roots, omitted: budget.omitted };
	}
	return undefined;
}
