/**
 * Theme ids, their schemes and the migration from retired ids. Dependency-free
 * so the main process (`nativeTheme.themeSource`), the renderer's registry
 * (lib/themes.ts) and the tests read one list.
 *
 * Stored preferences (`themeName` on the desktop and in a paired device's
 * uiPrefs, `systemLightTheme` / `systemDarkTheme`) hold these ids. An id the
 * app no longer ships is migrated by {@link migrateThemeName} to the nearest new
 * theme of the same scheme, never to nothing.
 */

export type ThemeScheme = "light" | "dark";

/** Picker order: the light group, then the dark group; the first of each is the OMPdesk default. */
export const LIGHT_THEME_NAMES = ["light", "github-light", "solarized-light", "sepia", "hc-light"] as const;

export const DARK_THEME_NAMES = ["dark", "nord", "tokyo-night", "gruvbox-dark", "hc-dark"] as const;

export type LightThemeName = (typeof LIGHT_THEME_NAMES)[number];
export type DarkThemeName = (typeof DARK_THEME_NAMES)[number];
export type ThemeName = LightThemeName | DarkThemeName;

export const THEME_NAMES: readonly ThemeName[] = [...LIGHT_THEME_NAMES, ...DARK_THEME_NAMES];

export type ThemeSelection = ThemeName | "system";

/** What System pairs: the theme shown while the OS is light, and the one while it is dark. */
export interface SystemThemePair {
	light: LightThemeName;
	dark: DarkThemeName;
}

export const DEFAULT_SYSTEM_THEMES: SystemThemePair = { light: "light", dark: "dark" };

export function isThemeName(value: unknown): value is ThemeName {
	return typeof value === "string" && (THEME_NAMES as readonly string[]).includes(value);
}

export function isLightThemeName(value: unknown): value is LightThemeName {
	return typeof value === "string" && (LIGHT_THEME_NAMES as readonly string[]).includes(value);
}

export function isDarkThemeName(value: unknown): value is DarkThemeName {
	return typeof value === "string" && (DARK_THEME_NAMES as readonly string[]).includes(value);
}

export function schemeOfTheme(name: ThemeName): ThemeScheme {
	return isLightThemeName(name) ? "light" : "dark";
}

/**
 * Ids of the eleven themes the app shipped before the curated set, each with the nearest theme of
 * the same scheme (CIE Lab distance of the page background and the accent; where two are within a
 * few ΔE of each other the warmer or cooler one that matches the old palette's feel). Graphite and
 * Porcelain kept their ids: they are OMPdesk Dark and OMPdesk Light. themes.migration.test.ts checks
 * every entry exists, keeps the scheme and stays near the best match.
 */
export const LEGACY_THEME_NAMES: Readonly<Record<string, ThemeName>> = {
	titanium: "nord", // Slate: silver-blue charcoal
	nord: "nord", // Deep Sea: petrol blue (the id now names the published Nord palette)
	latte: "gruvbox-dark", // Espresso: roasted brown with caramel
	gruvbox: "gruvbox-dark", // Ember: warm charcoal with copper
	paper: "sepia", // Ivory: warm pages, copper accent
	solarized: "sepia", // Sand: pale sand, ochre accent
	dawn: "sepia", // Rose Quartz: warm off-white, dusty accent
	frost: "solarized-light", // Glacier: pale page, steel-blue accent
	matcha: "solarized-light", // Sage: pale page, muted green accent
};

/**
 * A stored theme value read as a selection: a current id or "system" as is, a retired id mapped to its
 * successor, anything else null. The legacy `theme` pref (`dark` / `light` / `system`) reads the same way.
 */
export function migrateThemeName(value: unknown): ThemeSelection | null {
	if (value === "system") return "system";
	if (isThemeName(value)) return value;
	if (typeof value === "string" && Object.hasOwn(LEGACY_THEME_NAMES, value)) return LEGACY_THEME_NAMES[value] ?? null;
	return null;
}

/** The theme a stored System pair entry names for `scheme`: it must exist and match the scheme, else the OMPdesk default. */
export function systemThemeFor(scheme: "light", value: unknown): LightThemeName;
export function systemThemeFor(scheme: "dark", value: unknown): DarkThemeName;
export function systemThemeFor(scheme: ThemeScheme, value: unknown): ThemeName {
	const name = migrateThemeName(value);
	if (name !== null && name !== "system" && schemeOfTheme(name) === scheme) return name;
	return DEFAULT_SYSTEM_THEMES[scheme];
}
