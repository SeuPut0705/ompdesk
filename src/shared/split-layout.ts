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

/** Cap on remembered splits per window (a split holds at least two of the window's tabs). */
const MAX_REMEMBERED_SPLITS = 16;

/**
 * Take `tabId` out of `split`; a split left with one session dissolves (null).
 * Sizes of the surviving panes keep their ratios.
 */
export function withoutSplitTab(split: SplitLayout, tabId: string): SplitLayout | null {
	return asSplitLayout(mapSplitLeaves(split, id => (id === tabId ? null : { tabId: id })));
}

/** The remembered split `tabId` belongs to (a session is in at most one). */
export function rememberedSplitOf(splits: readonly SplitLayout[], tabId: string): SplitLayout | undefined {
	return splits.find(split => splitTabIds(split).includes(tabId));
}

/** Drop `tabId` from its remembered split (closed tab, deleted session, a pane taken elsewhere). */
export function forgetSplitTab(splits: readonly SplitLayout[], tabId: string): SplitLayout[] {
	const owner = rememberedSplitOf(splits, tabId);
	if (!owner) return [...splits];
	const rest = withoutSplitTab(owner, tabId);
	return splits.flatMap(split => (split !== owner ? [split] : rest ? [rest] : []));
}

/** Remember `split` as the home of its sessions: they leave any other remembered split first. */
export function rememberSplit(splits: readonly SplitLayout[], split: SplitLayout): SplitLayout[] {
	let next = [...splits];
	for (const tabId of splitTabIds(split)) next = forgetSplitTab(next, tabId);
	return [...next, split];
}

/** Take the remembered split `tabId` belongs to out of `splits` for display. */
export function recallSplit(
	splits: readonly SplitLayout[],
	tabId: string,
): { split: SplitLayout | null; rest: SplitLayout[] } {
	const split = rememberedSplitOf(splits, tabId) ?? null;
	return { split, rest: splits.filter(candidate => candidate !== split) };
}

/**
 * Boundary validation of remembered splits. `resolve` maps a stored leaf to
 * the tab id it stands for (null = the tab is gone); `claimed` holds the
 * sessions already placed (the visible split) and grows with every kept
 * split, so a session ends up in at most one.
 */
export function readRememberedSplits(
	value: unknown,
	resolve: (tabId: string) => string | null,
	claimed: Set<string>,
): SplitLayout[] {
	if (!Array.isArray(value)) return [];
	const kept: SplitLayout[] = [];
	for (const candidate of value) {
		if (kept.length >= MAX_REMEMBERED_SPLITS) break;
		const parsed = readSplitNode(candidate);
		if (!parsed) continue;
		const split = asSplitLayout(
			mapSplitLeaves(parsed, source => {
				const id = resolve(source);
				return id !== null && !claimed.has(id) ? { tabId: id } : null;
			}),
		);
		if (!split) continue;
		const ids = splitTabIds(split);
		if (new Set(ids).size !== ids.length) continue;
		for (const id of ids) claimed.add(id);
		kept.push(split);
	}
	return kept;
}

export interface SplitView {
	/** The split on screen (null = one session shown alone). */
	split: SplitLayout | null;
	/** Splits remembered but off screen. */
	remembered: SplitLayout[];
}

/**
 * What the window shows once `tabId` is picked from outside the panes (sidebar
 * row, ⌘-number, tab overview, ⌃⇥ switcher, session picker):
 * - a pane of the visible split: only the focus moves, the split stays;
 * - a member of a remembered split: that split comes back as it was and the
 *   split that was on screen is remembered in turn;
 * - anything else: the visible split is remembered and `tabId` shows alone.
 * A pick never replaces a pane's session.
 */
export function viewAfterPick(view: SplitView, tabId: string): SplitView {
	if (view.split && splitTabIds(view.split).includes(tabId)) return view;
	const { split, rest } = recallSplit(view.remembered, tabId);
	return { split, remembered: view.split ? rememberSplit(rest, view.split) : rest };
}
