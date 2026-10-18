/**
 * The one keyboard model of the composer's two listboxes (the completion menu and the history search): ↑/↓ step
 * and wrap, Home/End jump to the ends, PageUp/PageDown move a page. Both surfaces ask it for the next row.
 */

/** Rows PageUp/PageDown move. */
export const LISTBOX_PAGE = 5;

/** The row a navigation key moves to from `index` in a list of `count` rows, or null for any other key. */
export function listboxTarget(key: string, index: number, count: number): number | null {
	if (count <= 0) return null;
	switch (key) {
		case "ArrowDown":
			return (index + 1) % count;
		case "ArrowUp":
			return (index - 1 + count) % count;
		case "Home":
			return 0;
		case "End":
			return count - 1;
		case "PageUp":
			return Math.max(0, index - LISTBOX_PAGE);
		case "PageDown":
			return Math.min(count - 1, index + LISTBOX_PAGE);
		default:
			return null;
	}
}
