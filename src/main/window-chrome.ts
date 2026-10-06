/**
 * Frameless window chrome: the renderer draws its own 48px top bar (sidebar
 * header, title bar, side-panel header) and the OS controls sit inside it.
 *
 * - macOS: `hiddenInset` keeps the traffic lights, positioned to center in the
 *   top bar; the renderer reserves their width (`html[data-platform=darwin]`).
 * - Windows: `hidden` + `titleBarOverlay` keeps the native caption buttons
 *   (snap layouts, accessibility) over the top-right corner; their colors
 *   follow the theme through {@link sanitizeChromeColors} pushes from the
 *   renderer.
 */

import type { BrowserWindowConstructorOptions } from "electron";
import type { WindowChromeColors } from "../shared/ipc-types";

/** Height of the renderer's top bar (Tailwind h-12). */
export const TOP_BAR_HEIGHT = 48;

/** Light/dark canvas + text colors (design tokens --sc-bg / --sc-text) used before the renderer reports. */
const DEFAULT_COLORS: Record<"light" | "dark", WindowChromeColors> = {
	light: { color: "#ffffff", symbolColor: "#1b1b1f" },
	dark: { color: "#19191c", symbolColor: "#ededf0" },
};

export function windowChromeOptions(
	platform: NodeJS.Platform,
	dark: boolean,
): Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "trafficLightPosition" | "titleBarOverlay"> {
	if (platform === "darwin") {
		return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 17 } };
	}
	if (platform === "win32") {
		return {
			titleBarStyle: "hidden",
			titleBarOverlay: { ...DEFAULT_COLORS[dark ? "dark" : "light"], height: TOP_BAR_HEIGHT },
		};
	}
	return {};
}

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;

/** Renderer input is untrusted: accept only plain hex / rgb() colors. */
export function sanitizeChromeColors(value: unknown): WindowChromeColors | null {
	if (typeof value !== "object" || value === null) return null;
	const { color, symbolColor } = value as Record<string, unknown>;
	if (typeof color !== "string" || typeof symbolColor !== "string") return null;
	const c = color.trim();
	const s = symbolColor.trim();
	return COLOR.test(c) && COLOR.test(s) ? { color: c, symbolColor: s } : null;
}
