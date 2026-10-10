export type SplitAxis = "columns" | "rows";
export type SplitPlacement = "left" | "right" | "top" | "bottom";
export type SplitNode = { tabId: string } | SplitLayout;
export interface SplitLayout {
	axis: SplitAxis;
	ratio: number;
	first: SplitNode;
	second: SplitNode;
}

export function splitTabIds(node: SplitNode): string[] {
	return "tabId" in node ? [node.tabId] : [...splitTabIds(node.first), ...splitTabIds(node.second)];
}

export function mapSplitLeaves(node: SplitNode, map: (tabId: string) => SplitNode | null): SplitNode | null {
	if ("tabId" in node) return map(node.tabId);
	const first = mapSplitLeaves(node.first, map);
	const second = mapSplitLeaves(node.second, map);
	return first && second ? { ...node, first, second } : (first ?? second);
}

export function asSplitLayout(node: SplitNode | null): SplitLayout | null {
	return node && !("tabId" in node) ? node : null;
}

export function splitForPlacement(tabId: string, nextTabId: string, placement: SplitPlacement): SplitLayout {
	const before = placement === "left" || placement === "top";
	return {
		axis: placement === "left" || placement === "right" ? "columns" : "rows",
		ratio: 0.5,
		first: { tabId: before ? nextTabId : tabId },
		second: { tabId: before ? tabId : nextTabId },
	};
}

/** Read-only boundary validation; legacy two-pane records migrate here once. */
export function readSplitNode(value: unknown, depth = 0): SplitNode | null {
	if (!value || typeof value !== "object" || depth > 3) return null;
	if ("tabId" in value && typeof value.tabId === "string") return { tabId: value.tabId };
	if (!("axis" in value) || (value.axis !== "columns" && value.axis !== "rows")) return null;
	if (!("ratio" in value) || typeof value.ratio !== "number" || !Number.isFinite(value.ratio)) return null;
	const first =
		"firstTabId" in value && typeof value.firstTabId === "string"
			? { tabId: value.firstTabId }
			: "first" in value
				? readSplitNode(value.first, depth + 1)
				: null;
	const second =
		"secondTabId" in value && typeof value.secondTabId === "string"
			? { tabId: value.secondTabId }
			: "second" in value
				? readSplitNode(value.second, depth + 1)
				: null;
	if (!first || !second) return null;
	const node: SplitLayout = { axis: value.axis, ratio: Math.min(0.8, Math.max(0.2, value.ratio)), first, second };
	const ids = splitTabIds(node);
	return ids.length <= 4 && new Set(ids).size === ids.length ? node : null;
}

export function updateSplitRatio(node: SplitLayout, path: readonly ("first" | "second")[], ratio: number): SplitLayout {
	const [side, ...rest] = path;
	if (!side) return { ...node, ratio: Math.min(0.8, Math.max(0.2, ratio)) };
	const child = node[side];
	return "tabId" in child ? node : { ...node, [side]: updateSplitRatio(child, rest, ratio) };
}
