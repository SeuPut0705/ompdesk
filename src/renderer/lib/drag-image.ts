/**
 * Drag sources whose drop target paints its own preview (the split ghost in
 * SplitWorkspace) hide the browser's snapshot of the dragged element. The
 * 1×1 transparent GIF decodes at module load, ahead of the first dragstart,
 * because setDragImage falls back to the default snapshot for an image that
 * is still loading.
 */
const TRANSPARENT_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const transparent = typeof Image === "function" ? Object.assign(new Image(1, 1), { src: TRANSPARENT_GIF }) : null;

export function hideNativeDragImage(dataTransfer: DataTransfer): void {
	if (transparent) dataTransfer.setDragImage(transparent, 0, 0);
}
