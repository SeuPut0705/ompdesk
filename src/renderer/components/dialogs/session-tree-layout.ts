/**
 * Session tree layout: hand-rolled layered tidy-tree (depth rows top→bottom,
 * parents centered horizontally on their children), ported from the subagent
 * DAG layout (panels/subagent-graph.ts) with the axes swapped — no graph
 * dependency. Pure data + geometry only: the dialog applies cosmetic drag
 * offsets, viewport culling, and pan/zoom at render time.
 *
 * Data source is the `get_session_tree` RPC (nodes carry parentId, role,
 * timestamp, active-branch and leaf markers). A flat `get_branch_messages`
 * fallback is adapted into a single chain via {@link chainEntriesFromBranchMessages}.
 */

/** Synthetic node anchoring every root (or unresolved-parent) message. */
export const SESSION_ROOT_ID = "__session_root__";

export const TREE_NODE_WIDTH = 232;
export const TREE_NODE_HEIGHT = 62;
export const TREE_ROOT_HEIGHT = 30;
const TREE_GAP_X = 28;
const TREE_GAP_Y = 48;
const TREE_PAD = 20;

export type SessionTreeRole = "user" | "assistant" | "system";

/** Wire shape of one node in the `get_session_tree` RPC result. */
export interface SessionTreeEntry {
	entryId: string;
	/** Nearest ancestor that is itself present in the tree array; null for the first message. */
	parentId: string | null;
	role: SessionTreeRole;
	textPreview: string;
	/** Epoch ms; 0 when unknown (flat-chain fallback). */
	timestamp: number;
	label?: string;
	onActiveBranch: boolean;
	isLeaf: boolean;
}

/** Wire shape of the `get_session_tree` RPC result data. */
export interface SessionTreeResult {
	tree: SessionTreeEntry[];
	activeLeafId: string | null;
}

export interface SessionTreeLayoutNode {
	id: string;
	/** Null only for the synthetic session-start node. */
	entry: SessionTreeEntry | null;
	depth: number;
	x: number;
	y: number;
}

export interface SessionTreeLayoutEdge {
	id: string;
	parentId: string;
	childId: string;
}

export interface SessionTreeLayout {
	nodes: SessionTreeLayoutNode[];
	edges: SessionTreeLayoutEdge[];
	width: number;
	height: number;
	/** Entries with more than one child (real fork points). */
	forkCount: number;
	/** Non-root node count. */
	nodeCount: number;
}

/**
 * Layered tidy-tree layout: depth rows top→bottom, siblings in wire order
 * left→right, parents centered on children. Every entry hangs off the
 * synthetic session-start node unless its `parentId` resolves to another
 * entry, so the result is always a single tree.
 */
export function buildSessionTreeLayout(entries: SessionTreeEntry[]): SessionTreeLayout {
	const byId = new Map<string, SessionTreeEntry>();
	for (const entry of entries) byId.set(entry.entryId, entry);

	const parentOf = new Map<string, string>();
	for (const entry of entries) {
		const parent = entry.parentId;
		parentOf.set(
			entry.entryId,
			parent !== null && parent !== entry.entryId && byId.has(parent) ? parent : SESSION_ROOT_ID,
		);
	}

	// Depth via walk-up with cycle protection; a cycle re-attaches the node to the root.
	const depthOf = new Map<string, number>([[SESSION_ROOT_ID, 0]]);
	for (const entry of entries) {
		const seen = new Set<string>([entry.entryId]);
		let cursor = entry.entryId;
		let hops = 0;
		let cycled = false;
		while (cursor !== SESSION_ROOT_ID) {
			const parent = parentOf.get(cursor) ?? SESSION_ROOT_ID;
			if (parent !== SESSION_ROOT_ID) {
				if (seen.has(parent)) {
					cycled = true;
					break;
				}
				seen.add(parent);
			}
			cursor = parent;
			hops++;
		}
		if (cycled) parentOf.set(entry.entryId, SESSION_ROOT_ID);
		depthOf.set(entry.entryId, cycled ? 1 : hops);
	}

	const childrenOf = new Map<string, string[]>();
	for (const entry of entries) {
		const parent = parentOf.get(entry.entryId) ?? SESSION_ROOT_ID;
		const siblings = childrenOf.get(parent);
		if (siblings) siblings.push(entry.entryId);
		else childrenOf.set(parent, [entry.entryId]);
	}

	// Tidy columns: leaves take successive x slots; internal nodes center on children.
	let leafCount = 0;
	const slotOf = new Map<string, number>();
	const place = (id: string): number => {
		const kids = childrenOf.get(id) ?? [];
		if (kids.length === 0) {
			const slot = leafCount++;
			slotOf.set(id, slot);
			return slot;
		}
		let first = Number.POSITIVE_INFINITY;
		let last = Number.NEGATIVE_INFINITY;
		for (const kid of kids) {
			const slot = place(kid);
			first = Math.min(first, slot);
			last = Math.max(last, slot);
		}
		const slot = (first + last) / 2;
		slotOf.set(id, slot);
		return slot;
	};
	place(SESSION_ROOT_ID);

	const colPitch = TREE_NODE_WIDTH + TREE_GAP_X;
	const rowPitch = TREE_NODE_HEIGHT + TREE_GAP_Y;
	const nodes: SessionTreeLayoutNode[] = [
		{
			id: SESSION_ROOT_ID,
			entry: null,
			depth: 0,
			x: TREE_PAD + (slotOf.get(SESSION_ROOT_ID) ?? 0) * colPitch,
			y: TREE_PAD,
		},
	];
	let maxDepth = 0;
	let forkCount = 0;
	for (const entry of entries) {
		const depth = depthOf.get(entry.entryId) ?? 1;
		maxDepth = Math.max(maxDepth, depth);
		if ((childrenOf.get(entry.entryId)?.length ?? 0) > 1) forkCount++;
		nodes.push({
			id: entry.entryId,
			entry,
			depth,
			x: TREE_PAD + (slotOf.get(entry.entryId) ?? 0) * colPitch,
			y: TREE_PAD + depth * rowPitch,
		});
	}

	const edges: SessionTreeLayoutEdge[] = [];
	for (const entry of entries) {
		const parentId = parentOf.get(entry.entryId) ?? SESSION_ROOT_ID;
		edges.push({ id: `${parentId}->${entry.entryId}`, parentId, childId: entry.entryId });
	}

	return {
		nodes,
		edges,
		width: TREE_PAD * 2 + Math.max(1, leafCount) * colPitch - TREE_GAP_X,
		height: TREE_PAD * 2 + maxDepth * rowPitch + TREE_NODE_HEIGHT,
		forkCount,
		nodeCount: entries.length,
	};
}

/**
 * Adapt the flat `get_branch_messages` result (user messages in session
 * order) into a single chain: each message parents to the previous one and
 * the last is HEAD. Same lineage semantics as the pre-visual dialog.
 */
export function chainEntriesFromBranchMessages(messages: Array<{ entryId: string; text: string }>): SessionTreeEntry[] {
	return messages.map((message, index) => ({
		entryId: message.entryId,
		parentId: index === 0 ? null : (messages[index - 1]?.entryId ?? null),
		role: "user",
		textPreview: message.text,
		timestamp: 0,
		onActiveBranch: true,
		isLeaf: index === messages.length - 1,
	}));
}

/** Vertical cubic edge from parent bottom-center to child top-center. */
export function sessionTreeEdgePath(x1: number, y1: number, x2: number, y2: number): string {
	const bend = Math.max(20, (y2 - y1) / 2);
	return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
}
