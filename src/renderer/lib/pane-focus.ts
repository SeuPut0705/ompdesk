/**
 * ⌥⌘↑ ↓ ← →: the split pane next to the focused one in that direction, read
 * from the panes' on-screen boxes (`.omp-session-pane[data-tab-id]`), since the
 * split tree nests columns in rows and the reverse. Among panes that lie in that
 * direction, the nearest wins; ties go to the one overlapping the focused pane most.
 */

export type PaneDirection = "up" | "down" | "left" | "right";

export interface PaneBox {
	tabId: string;
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export function paneInDirection(boxes: readonly PaneBox[], fromTabId: string, direction: PaneDirection): string | null {
	const from = boxes.find(box => box.tabId === fromTabId);
	if (!from) return null;
	const vertical = direction === "up" || direction === "down";
	let best: { tabId: string; gap: number; overlap: number } | null = null;
	for (const box of boxes) {
		if (box.tabId === fromTabId) continue;
		const gap =
			direction === "up"
				? from.top - box.bottom
				: direction === "down"
					? box.top - from.bottom
					: direction === "left"
						? from.left - box.right
						: box.left - from.right;
		// A pane counts only past the focused one's edge (dividers leave a hairline gap).
		if (gap < -2) continue;
		const overlap = vertical
			? Math.min(from.right, box.right) - Math.max(from.left, box.left)
			: Math.min(from.bottom, box.bottom) - Math.max(from.top, box.top);
		if (overlap <= 0) continue;
		if (!best || gap < best.gap - 1 || (Math.abs(gap - best.gap) <= 1 && overlap > best.overlap)) {
			best = { tabId: box.tabId, gap, overlap };
		}
	}
	return best?.tabId ?? null;
}

/** The rendered panes' boxes in this document. */
export function renderedPaneBoxes(): PaneBox[] {
	return [...document.querySelectorAll<HTMLElement>(".omp-session-pane[data-tab-id]")].flatMap(element => {
		const tabId = element.dataset.tabId;
		if (!tabId) return [];
		const rect = element.getBoundingClientRect();
		return [{ tabId, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }];
	});
}
