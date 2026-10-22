/**
 * The tab a key moves to in a row of `count` tabs from `at` (a tablist's roving tab stop: ←/→ wrap at the ends,
 * Home and End go to them), or null for any other key and for an empty row. `at` below 0 counts as the first tab.
 */
export function rovingIndex(key: string, at: number, count: number): number | null {
	if (count === 0) return null;
	if (key === "Home") return 0;
	if (key === "End") return count - 1;
	const from = Math.max(at, 0);
	if (key === "ArrowRight") return (from + 1) % count;
	if (key === "ArrowLeft") return (from - 1 + count) % count;
	return null;
}
