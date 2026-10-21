/**
 * The one keyboard model of a listbox driven from a field: ↑/↓ step, Home/End jump to the ends, PageUp/PageDown move
 * a page. The composer's two listboxes (the completion menu and the history search) wrap at the ends; the search
 * pickers (model, session, branch) stop there.
 */

/** Rows PageUp/PageDown move. */
export const LISTBOX_PAGE = 5;

/**
 * The row a navigation key moves to from `index` in a list of `count` rows, or null for any other key and for an
 * empty list. ↑/↓ wrap at the ends unless `wrap` is false.
 */
export function listboxTarget(
	key: string,
	index: number,
	count: number,
	{ wrap = true }: { wrap?: boolean } = {},
): number | null {
	if (count <= 0) return null;
	switch (key) {
		case "ArrowDown":
			return wrap ? (index + 1) % count : Math.min(index + 1, count - 1);
		case "ArrowUp":
			return wrap ? (index - 1 + count) % count : Math.max(index - 1, 0);
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
