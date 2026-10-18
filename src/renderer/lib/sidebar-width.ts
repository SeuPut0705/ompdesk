/**
 * The docked sidebar's width, remembered where the first paint can read it. The `sidebarWidth` pref arrives over IPC
 * after the first frame, so the shell would paint the default and jump; this mirror (localStorage, written wherever
 * the pref is read or changed) lets the sidebar start at its width and pre-paint.js set `--boot-sidebar-w` for the
 * boot shell (src/shared/boot-shell-geometry.ts).
 */
import { SIDEBAR_WIDTH, SIDEBAR_WIDTH_STORAGE_KEY } from "../../shared/boot-shell-geometry";

export const clampSidebarWidth = (value: number): number =>
	Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, value));

export function readSidebarWidth(): number {
	try {
		const value = Number.parseFloat(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) ?? "");
		return Number.isFinite(value) ? clampSidebarWidth(value) : SIDEBAR_WIDTH.default;
	} catch {
		return SIDEBAR_WIDTH.default;
	}
}

export function writeSidebarWidth(width: number): void {
	try {
		localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(width)));
	} catch {
		// No storage: the next start paints the default width.
	}
}
