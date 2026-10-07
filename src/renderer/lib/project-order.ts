/**
 * Sidebar project order. Pinned projects stay on top. Within each partition a
 * project the user placed by dragging keeps its place; projects they never
 * placed (new since the last drag, or before any drag) come first, newest
 * activity first, so a freshly opened project is always in view.
 */
export function orderProjects<T extends { cwd: string }>(
	groups: readonly T[],
	options: { pinned: readonly string[]; manual: readonly string[]; recency: (group: T) => number },
): T[] {
	const manualIndex = new Map(options.manual.map((cwd, index) => [cwd, index]));
	return groups.toSorted((a, b) => {
		const aPinned = options.pinned.includes(a.cwd) ? 0 : 1;
		const bPinned = options.pinned.includes(b.cwd) ? 0 : 1;
		if (aPinned !== bPinned) return aPinned - bPinned;
		const aPlaced = manualIndex.get(a.cwd);
		const bPlaced = manualIndex.get(b.cwd);
		if (aPlaced !== undefined && bPlaced !== undefined) return aPlaced - bPlaced;
		if (aPlaced !== undefined) return 1;
		if (bPlaced !== undefined) return -1;
		return options.recency(b) - options.recency(a);
	});
}

/** The full manual order after moving `active` to where `over` sits in `visible`. */
export function reorderProjects(visible: readonly string[], active: string, over: string): string[] {
	const from = visible.indexOf(active);
	const to = visible.indexOf(over);
	if (from === -1 || to === -1 || from === to) return [...visible];
	const next = [...visible];
	next.splice(from, 1);
	next.splice(to, 0, active);
	return next;
}
