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

/**
 * The stored project order after this computer's own projects took `local`'s order: every paired host's entries
 * (their `hostOrderKey`, which holds a newline no folder path has) stay as they were.
 */
export function withLocalProjectOrder(stored: readonly string[], local: readonly string[]): string[] {
	return [...local, ...stored.filter(key => key.includes("\n"))];
}
