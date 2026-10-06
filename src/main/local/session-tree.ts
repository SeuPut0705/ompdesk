/**
 * `get_session_tree` projection: the session's flat entry list (stock
 * `get_entries`) as the GUI session tree panel's branch graph.
 *
 * Rules (the omp-gui fork's `buildRpcSessionTree`):
 * - Only `message` entries with role user/assistant become nodes; tool results,
 *   model/thinking changes, labels etc. are walked through.
 * - A node's `parentId` is its nearest ancestor that is itself a node, so the
 *   GUI can always draw an edge; a missing parent degrades to the root.
 * - `textPreview` is whitespace-collapsed and truncated; `onActiveBranch` marks
 *   the root→leaf path; `label` is the entry's label in effect.
 *
 * Stock `get_tree` carries the same data, but as a nesting as deep as the
 * session is long; the flat list resolves labels the way omp's index does
 * (each `label` entry sets or clears its target, in file order).
 */
import type { RpcSessionTreeNode, RpcSessionTreeResult } from "../../shared/rpc-types";
import type { SessionEntry } from "./sessions";

const PREVIEW_LEN = 200;

function nodeRole(entry: SessionEntry): RpcSessionTreeNode["role"] | null {
	if (entry.type !== "message") return null;
	const role = entry.message?.role;
	return role === "user" || role === "assistant" ? role : null;
}

function blockText(block: unknown): string | undefined {
	if (typeof block !== "object" || block === null || !("type" in block) || block.type !== "text") return undefined;
	return "text" in block && typeof block.text === "string" ? block.text : undefined;
}

function previewText(message: unknown): string {
	const content =
		typeof message === "object" && message !== null && "content" in message ? message.content : undefined;
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			const part = blockText(block);
			if (part !== undefined) parts.push(part);
		}
		text = parts.join(" ");
	}
	text = text.replace(/\s+/g, " ").trim();
	return text.length > PREVIEW_LEN ? `${text.slice(0, PREVIEW_LEN - 1)}…` : text;
}

export function projectSessionTree(entries: readonly SessionEntry[], leafId: string | null): RpcSessionTreeResult {
	const byId = new Map<string, SessionEntry>();
	const labels = new Map<string, string>();
	for (const entry of entries) {
		byId.set(entry.id, entry);
		if (entry.type === "label" && typeof entry.targetId === "string") {
			if (typeof entry.label === "string" && entry.label) labels.set(entry.targetId, entry.label);
			else labels.delete(entry.targetId);
		}
	}

	// A parent cycle in a corrupt file stops every walk at the entry count.
	const nearestNode = (id: string | null): string | null => {
		let current = id;
		for (let steps = 0; current !== null && steps <= entries.length; steps++) {
			const entry = byId.get(current);
			if (!entry) return null;
			if (nodeRole(entry)) return current;
			current = entry.parentId;
		}
		return null;
	};

	const onBranch = new Set<string>();
	let current = leafId;
	for (let steps = 0; current !== null && steps <= entries.length; steps++) {
		const entry = byId.get(current);
		if (!entry) break;
		onBranch.add(current);
		current = entry.parentId;
	}

	const tree: RpcSessionTreeNode[] = [];
	const hasChild = new Set<string>();
	for (const entry of entries) {
		const role = nodeRole(entry);
		if (!role) continue;
		const parentId = nearestNode(entry.parentId);
		if (parentId) hasChild.add(parentId);
		const node: RpcSessionTreeNode = {
			entryId: entry.id,
			parentId,
			role,
			textPreview: previewText(entry.message),
			timestamp: Date.parse(entry.timestamp) || 0,
			onActiveBranch: onBranch.has(entry.id),
			isLeaf: true,
		};
		const label = labels.get(entry.id);
		if (label) node.label = label;
		tree.push(node);
	}
	for (const node of tree) node.isLeaf = !hasChild.has(node.entryId);
	tree.sort((a, b) => a.timestamp - b.timestamp);
	return { tree, activeLeafId: nearestNode(leafId) };
}
