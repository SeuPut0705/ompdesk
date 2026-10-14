import type { PreviewBounds } from "../../shared/preview";

export interface PreviewSurface {
	setBounds(bounds: PreviewBounds): void;
	setVisible(visible: boolean): void;
}
/** Native child views must stay inside the window and disappear beneath shell overlays. */
export function applyPreviewLayout(
	surface: PreviewSurface,
	bounds: PreviewBounds,
	visible: boolean,
	viewport: { width: number; height: number },
): void {
	const values = [bounds.x, bounds.y, bounds.width, bounds.height];
	if (!values.every(Number.isFinite)) {
		surface.setVisible(false);
		return;
	}
	const x = Math.max(0, Math.min(viewport.width, Math.round(bounds.x)));
	const y = Math.max(0, Math.min(viewport.height, Math.round(bounds.y)));
	const width = Math.max(0, Math.min(Math.round(bounds.width), viewport.width - x));
	const height = Math.max(0, Math.min(Math.round(bounds.height), viewport.height - y));
	surface.setBounds({ x, y, width, height });
	surface.setVisible(visible && width > 0 && height > 0);
}
/** Chromium's smallest zoom factor; a frame scaled further would render wider than its box. */
export const MIN_FRAME_SCALE = 0.25;
/**
 * A responsive frame of `frame` CSS px inside the panel's `bounds`: centred horizontally, top-aligned and scaled down
 * (never up) to fit, so the page still lays out at the frame's width. `scale` multiplies the page zoom.
 */
export function fitPreviewFrame(
	bounds: PreviewBounds,
	frame: { width: number; height: number } | null,
): { bounds: PreviewBounds; scale: number } {
	if (!frame || !(bounds.width > 0 && bounds.height > 0)) return { bounds, scale: 1 };
	const fit = Math.max(MIN_FRAME_SCALE, Math.min(1, bounds.width / frame.width, bounds.height / frame.height));
	// Whole pixels first, then the exact scale they imply, so the page lays out at the frame's full width.
	const width = Math.min(Math.round(bounds.width), Math.round(frame.width * fit));
	const height = Math.min(Math.round(bounds.height), Math.round(frame.height * fit));
	return {
		bounds: { x: Math.round(bounds.x + (bounds.width - width) / 2), y: bounds.y, width, height },
		scale: Math.max(MIN_FRAME_SCALE, width / frame.width),
	};
}
