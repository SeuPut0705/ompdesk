/**
 * Sidebar order of projects and of a list's sessions. Pinned items stay on top. Within each partition an item the
 * user placed (by dragging or Move up/down) keeps its place; items they never placed (new since the last move, or
 * before any) come first, newest first, so a freshly opened project or a new session is always in view.
 */
export function orderByManual<T>(
	items: readonly T[],
	key: (item: T) => string,
	options: { pinned: readonly string[]; manual: readonly string[]; recency: (item: T) => number },
): T[] {
	const manualIndex = new Map(options.manual.map((id, index) => [id, index]));
	const pinned = new Set(options.pinned);
	return items.toSorted((a, b) => {
		const aKey = key(a);
		const bKey = key(b);
		const aPinned = pinned.has(aKey) ? 0 : 1;
		const bPinned = pinned.has(bKey) ? 0 : 1;
		if (aPinned !== bPinned) return aPinned - bPinned;
		const aPlaced = manualIndex.get(aKey);
		const bPlaced = manualIndex.get(bKey);
		if (aPlaced !== undefined && bPlaced !== undefined) return aPlaced - bPlaced;
		if (aPlaced !== undefined) return 1;
		if (bPlaced !== undefined) return -1;
		return options.recency(b) - options.recency(a);
	});
}

export function orderProjects<T extends { cwd: string }>(
	groups: readonly T[],
	options: { pinned: readonly string[]; manual: readonly string[]; recency: (group: T) => number },
): T[] {
	return orderByManual(groups, group => group.cwd, options);
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

/** `visible` with `id` moved `delta` places (-1 up, 1 down); null at an end or when `id` is not listed. */
export function moveInOrder(visible: readonly string[], id: string, delta: number): string[] | null {
	const from = visible.indexOf(id);
	const to = from + delta;
	if (from === -1 || to < 0 || to >= visible.length) return null;
	return reorderProjects(visible, id, visible[to] as string);
}

/** The key a paired host's project or list is ordered under in this computer's sidebar prefs. */
export function hostOrderKey(deviceId: string, list: string): string {
	return `${deviceId}\n${list}`;
}

/** The key the sidebar orders a device's Chats section under (`local` for this computer). */
export const CHATS_ORDER_KEY = "\u0000chats";

/**
 * The stored project order after this computer's own projects took `local`'s order: every paired host's entries
 * (their `hostOrderKey`, which holds a newline no folder path has) stay as they were.
 */
export function withLocalProjectOrder(stored: readonly string[], local: readonly string[]): string[] {
	return [...local, ...stored.filter(key => key.includes("\n"))];
}
