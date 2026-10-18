/**
 * Session tree layout: hand-rolled layered tidy-tree (depth rows top→bottom,
 * parents centered horizontally on their children) — no graph dependency.
 * Pure data + geometry only: the panel applies cosmetic drag offsets,
 * viewport culling, and pan/zoom at render time.
 *
 * Data source is the `get_session_tree` RPC (nodes carry parentId, role,
 * timestamp, active-branch and leaf markers).
 */

/** Synthetic node anchoring every root (or unresolved-parent) message. */
export const SESSION_ROOT_ID = "__session_root__";

export const TREE_NODE_WIDTH = 232;
export const TREE_NODE_HEIGHT = 72;
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

	// A parent cycle re-attaches the node that closes it to the root: walk up once per chain, marking as we go, so
	// the pass stays linear on a long unbranched session (one walk per entry was quadratic).
	const settled = new Set<string>([SESSION_ROOT_ID]);
	for (const entry of entries) {
		const path: string[] = [];
		const onPath = new Set<string>();
		let cursor = entry.entryId;
		while (!settled.has(cursor)) {
			if (onPath.has(cursor)) {
				// `cursor` closes a cycle: hang it off the root, which settles the whole path.
				parentOf.set(cursor, SESSION_ROOT_ID);
				break;
			}
			onPath.add(cursor);
			path.push(cursor);
			cursor = parentOf.get(cursor) ?? SESSION_ROOT_ID;
		}
		for (const id of path) settled.add(id);
	}

	const childrenOf = new Map<string, string[]>();
	for (const entry of entries) {
		const parent = parentOf.get(entry.entryId) ?? SESSION_ROOT_ID;
		const siblings = childrenOf.get(parent);
		if (siblings) siblings.push(entry.entryId);
		else childrenOf.set(parent, [entry.entryId]);
	}

	// Depth top-down, then tidy columns bottom-up: leaves take successive x slots in wire order and internal nodes
	// centre on their children. Both passes use an explicit stack: a session thousands of entries deep is one chain,
	// and a recursive walk ran out of call stack on it (v0.36.1, a phone's "Maximum call stack size exceeded").
	const depthOf = new Map<string, number>([[SESSION_ROOT_ID, 0]]);
	const order: string[] = [];
	const pending = [SESSION_ROOT_ID];
	while (pending.length > 0) {
		const id = pending.pop() as string;
		order.push(id);
		const kids = childrenOf.get(id) ?? [];
		const depth = (depthOf.get(id) ?? 0) + 1;
		// Reversed, so the first child is visited first and leaves are met in wire order.
		for (let index = kids.length - 1; index >= 0; index--) {
			const kid = kids[index] as string;
			depthOf.set(kid, depth);
			pending.push(kid);
		}
	}
	let leafCount = 0;
	const slotOf = new Map<string, number>();
	for (const id of order) {
		if (!childrenOf.has(id)) slotOf.set(id, leafCount++);
	}
	for (let index = order.length - 1; index >= 0; index--) {
		const id = order[index] as string;
		const kids = childrenOf.get(id);
		if (!kids) continue;
		const first = slotOf.get(kids[0] as string) ?? 0;
		const last = slotOf.get(kids.at(-1) as string) ?? 0;
		slotOf.set(id, (first + last) / 2);
	}

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

/** Vertical cubic edge from parent bottom-center to child top-center. */
export function sessionTreeEdgePath(x1: number, y1: number, x2: number, y2: number): string {
	const bend = Math.max(20, (y2 - y1) / 2);
	return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
}
