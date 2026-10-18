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
 * - Windows 11 (build 22621+): the Mica backdrop (`backgroundMaterial`); the
 *   renderer, loaded with `?mica=1`, lets it show through the sidebar.
 * - Every window: `nativeTheme.themeSource` follows the app's saved theme
 *   ({@link nativeThemeSource}), so what the OS draws (the Mica tint, the
 *   caption buttons' first colors) and pre-paint's OS fallback match the
 *   scheme the renderer applies, whatever the OS is set to.
 */

import type { BrowserWindowConstructorOptions } from "electron";
import type { WindowChromeColors } from "../shared/ipc-types";
import { migrateThemeName, schemeOfTheme } from "../shared/theme-names";

/** Height of the renderer's top bar (Tailwind h-12). */
export const TOP_BAR_HEIGHT = 48;

/** Light/dark canvas + text colors (design tokens --sc-bg / --sc-text) used before the renderer reports. */
const DEFAULT_COLORS: Record<"light" | "dark", WindowChromeColors> = {
	light: { color: "#ffffff", symbolColor: "#1b1b1f" },
	dark: { color: "#19191c", symbolColor: "#ededf0" },
};

/** Windows 11 22H2 (build 22621) is the first build Electron's Mica material draws on. */
export function micaSupported(platform: NodeJS.Platform, release: string): boolean {
	return platform === "win32" && Number(release.split(".")[2] ?? 0) >= 22621;
}

/**
 * `nativeTheme.themeSource` for the saved theme: prefs `themeName` read as a theme (a retired id
 * through its successor, shared/theme-names.ts) gives that theme's scheme, "system" follows the OS;
 * when `themeName` is unset or unknown, the legacy `theme` (`dark` / `light` / `system`) decides.
 * Anything else follows the OS.
 */
export function nativeThemeSource(themeName: unknown, theme: unknown): "system" | "light" | "dark" {
	for (const value of [themeName, theme]) {
		const selection = migrateThemeName(value);
		if (selection === "system") return "system";
		if (selection !== null) return schemeOfTheme(selection);
	}
	return "system";
}

export function windowChromeOptions(
	platform: NodeJS.Platform,
	dark: boolean,
	mica = false,
): Pick<
	BrowserWindowConstructorOptions,
	"titleBarStyle" | "trafficLightPosition" | "titleBarOverlay" | "backgroundMaterial"
> {
	if (platform === "darwin") {
		return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 17 } };
	}
	if (platform === "win32") {
		return {
			titleBarStyle: "hidden",
			titleBarOverlay: { ...DEFAULT_COLORS[dark ? "dark" : "light"], height: TOP_BAR_HEIGHT },
			...(mica ? { backgroundMaterial: "mica" as const } : {}),
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
