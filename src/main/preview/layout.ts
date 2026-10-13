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
