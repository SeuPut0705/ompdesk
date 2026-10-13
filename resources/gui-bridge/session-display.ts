/** Stock owns transcript replay; this module only associates GUI entry ids and flattens its indexed tree. */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry, SessionManager, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { sameMessageContent, sessionMessagePersistenceKey } from "@oh-my-pi/pi-coding-agent/session/turn-persistence";

type DisplayMessage = AgentMessage & { entryId?: string };

export function attachEntryIds(
	messages: readonly DisplayMessage[],
	entries: readonly SessionEntry[],
): DisplayMessage[] {
	const byKey = new Map<string, Array<{ id: string; message: AgentMessage }>>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const key = sessionMessagePersistenceKey(entry.message);
		if (!key) continue;
		const keyed = byKey.get(key);
		if (keyed) keyed.push(entry);
		else byKey.set(key, [entry]);
	}
	return messages.map(message => {
		if (message.entryId) return message;
		const key = sessionMessagePersistenceKey(message);
		const keyed = key ? byKey.get(key) : undefined;
		const entry =
			keyed?.length === 1 ? keyed[0] : keyed?.find(candidate => sameMessageContent(candidate.message, message));
		return entry ? { ...message, entryId: entry.id } : message;
	});
}

/** Match generated rows in reverse journal order, so a same-timestamp frame rescue belongs to its replacement. */
export function buildTranscript(manager: Pick<SessionManager, "getEntries" | "getLeafId" | "getBranch">) {
	const entries = manager.getEntries();
	const leafId = manager.getLeafId();
	const branch = leafId === null ? [] : manager.getBranch(leafId);
	// Stamp source messages before replay: stock preserves the id even when it rewrites dangling calls.
	// This also keeps two journal entries with identical persistence keys independently addressable.
	const branchIds = new Set(branch.map(entry => entry.id));
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type === "message" && branchIds.has(entry.id)) {
			entries[index] = { ...entry, message: { ...entry.message, entryId: entry.id } as DisplayMessage };
		}
	}
	// No collapseCompactedHistory: pre-compaction and pre-clear journal messages remain visible.
	// Preserve stock snapcompact blocks; the GUI renders the summary, while richer stock metadata is not discarded.
	const messages = buildSessionContext(entries, leafId, undefined, { transcript: true }).messages as DisplayMessage[];
	let cursor = branch.length - 1;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.entryId) {
			while (cursor >= 0 && branch[cursor].id !== message.entryId) cursor--;
			cursor--;
			continue;
		}
		for (; cursor >= 0; cursor--) {
			const entry = branch[cursor];
			const role =
				entry.type === "custom_message"
					? "custom"
					: entry.type === "branch_summary"
						? "branchSummary"
						: entry.type === "compaction"
							? "compactionSummary"
							: undefined;
			if (role !== message.role || Date.parse(entry.timestamp) !== message.timestamp) continue;
			messages[index] = { ...message, entryId: entry.id };
			cursor--;
			break;
		}
	}
	return { leafId, messages };
}

interface TreeNode {
	entryId: string;
	parentId: string | null;
	role: "user" | "assistant";
	textPreview: string;
	timestamp: number;
	onActiveBranch: boolean;
	isLeaf: boolean;
	label?: string;
}

export function flattenSessionTree(
	roots: readonly SessionTreeNode[],
	branch: readonly SessionEntry[],
	getLabel?: (entryId: string) => string | undefined,
) {
	const active = new Set(branch.map(entry => entry.id));
	const tree: TreeNode[] = [];
	const hasChild = new Set<string>();
	const visibleIds = new Set<string>();
	const appendNode = (entry: SessionEntry, parentId: string | null, label?: string): string | null => {
		if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant"))
			return parentId;
		const content = entry.message.content;
		const text = (
			typeof content === "string"
				? content
				: content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join(" ")
		)
			.replace(/\s+/g, " ")
			.trim();
		if (parentId) hasChild.add(parentId);
		visibleIds.add(entry.id);
		tree.push({
			entryId: entry.id,
			parentId,
			role: entry.message.role,
			textPreview: text.length > 200 ? `${text.slice(0, 199)}…` : text,
			timestamp: Date.parse(entry.timestamp) || 0,
			onActiveBranch: active.has(entry.id),
			isLeaf: true,
			...(label ? { label } : {}),
		});
		return entry.id;
	};
	const stack = roots.map(node => ({ node, parentId: null as string | null }));
	while (stack.length > 0) {
		const item = stack.pop();
		if (!item) break;
		const { node } = item;
		const parentId = appendNode(node.entry, item.parentId, node.label);
		for (let index = node.children.length - 1; index >= 0; index--)
			stack.push({ node: node.children[index], parentId });
	}
	// Stock's indexed tree has no root for a corrupt parent cycle. Its getBranch()
	// still returns the bounded active path; keep that selection visible in the GUI.
	let activeLeafId: string | null = null;
	for (const entry of branch) {
		if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) continue;
		if (!visibleIds.has(entry.id)) appendNode(entry, activeLeafId, getLabel?.(entry.id));
		activeLeafId = entry.id;
	}
	for (const node of tree) node.isLeaf = !hasChild.has(node.entryId);
	tree.sort((left, right) => left.timestamp - right.timestamp);
	return { tree, activeLeafId };
}
