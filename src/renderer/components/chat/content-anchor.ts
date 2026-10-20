/**
 * Where a reader who scrolled away from the live edge keeps reading when a commit changes rows on screen (a
 * re-read that adds a line to earlier prompts, a card that settles): the topmost row fully in view that the commit
 * left alone stays where it is, and a changed row above it grows upward instead of pushing it down. The virtualizer
 * compensates on its own only for rows entirely above the viewport (TanStack's re-measure rule), so a changed row
 * between the viewport's top and the reader's text moved that text by its growth.
 */

/** The held row: its key, its index in the commit's rows, and where its top sat under the viewport's top. */
export interface ContentAnchor {
	key: string;
	index: number;
	offset: number;
}

export interface AnchorItem {
	key: string | number | bigint;
	index: number;
	start: number;
	end: number;
}

/**
 * The anchor for a commit, or null when no row in view changed (nothing on screen can move) or every row fully in
 * view changed (nothing the reader was reading is left to hold). `changed(index)`: the commit replaced that row.
 */
export function contentAnchor(
	items: readonly AnchorItem[],
	scrollOffset: number,
	viewport: number,
	changed: (index: number) => boolean,
): ContentAnchor | null {
	const bottom = scrollOffset + viewport;
	const inView = items.filter(item => item.end > scrollOffset && item.start < bottom);
	if (!inView.some(item => changed(item.index))) return null;
	const held = inView.find(item => item.start >= scrollOffset && item.end <= bottom && !changed(item.index));
	return held ? { key: String(held.key), index: held.index, offset: held.start - scrollOffset } : null;
}
