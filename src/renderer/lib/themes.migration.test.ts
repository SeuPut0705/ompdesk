/**
 * Stored theme names from before the curated set keep working: every retired id reads as the nearest
 * new theme of the same scheme, stored prefs (desktop and a device's uiPrefs) are rewritten once,
 * and nothing ever resolves to a missing theme.
 */

import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SYSTEM_THEMES, LEGACY_THEME_NAMES, migrateThemeName, systemThemeFor } from "../../shared/theme-names";
import { deltaE } from "./theme-color";
import { getPersistedThemeSelection, THEMES, type ThemeName } from "./themes";

const { document } = parseHTML("<html><body></body></html>");
(globalThis as unknown as Record<string, unknown>).document = document;

/** Page background and accent of the eleven themes before the curated set (git: src/renderer/lib/themes.ts at v0.33). */
const OLD_THEMES: Record<string, { scheme: "light" | "dark"; bg: string; accent: string }> = {
	dark: { scheme: "dark", bg: "#19191c", accent: "#8b8df8" },
	titanium: { scheme: "dark", bg: "#24282c", accent: "#accad6" },
	nord: { scheme: "dark", bg: "#14232b", accent: "#8bc4c5" },
	latte: { scheme: "dark", bg: "#25211e", accent: "#d6b18a" },
	gruvbox: { scheme: "dark", bg: "#241e20", accent: "#dea28d" },
	light: { scheme: "light", bg: "#ffffff", accent: "#5b5bd6" },
	paper: { scheme: "light", bg: "#fdfbf7", accent: "#94513e" },
	solarized: { scheme: "light", bg: "#faf8f3", accent: "#825d2a" },
	dawn: { scheme: "light", bg: "#fcf9f9", accent: "#8d5064" },
	frost: { scheme: "light", bg: "#f7fafb", accent: "#356987" },
	matcha: { scheme: "light", bg: "#f8faf7", accent: "#466d51" },
};

const names = Object.keys(THEMES) as ThemeName[];
const distance = (old: (typeof OLD_THEMES)[string], name: ThemeName): number =>
	(deltaE(old.bg, THEMES[name].tokens["--omp-bg-primary"]) + deltaE(old.accent, THEMES[name].tokens["--omp-accent"])) /
	2;

describe("migrateThemeName", () => {
	it("maps every retired id to a theme that exists, of the same scheme", () => {
		for (const id of Object.keys(LEGACY_THEME_NAMES)) {
			const target = migrateThemeName(id);
			expect(target, id).not.toBeNull();
			expect(target, id).not.toBe("system");
			expect(names, id).toContain(target);
			expect(THEMES[target as ThemeName].scheme, `${id} → ${target}`).toBe(OLD_THEMES[id]?.scheme);
		}
	});

	it("keeps every retired id's mapping within a few ΔE of the nearest theme of its scheme", () => {
		for (const [id, old] of Object.entries(OLD_THEMES)) {
			const candidates = names.filter(name => THEMES[name].scheme === old.scheme);
			const best = Math.min(...candidates.map(name => distance(old, name)));
			const chosen = migrateThemeName(id) as ThemeName;
			expect(distance(old, chosen), `${id} → ${chosen}`).toBeLessThanOrEqual(best + 5);
		}
	});

	it("covers exactly the retired ids and leaves the surviving ids alone", () => {
		expect(Object.keys(LEGACY_THEME_NAMES).sort()).toEqual(
			["dawn", "frost", "gruvbox", "latte", "matcha", "nord", "paper", "solarized", "titanium"].sort(),
		);
		for (const id of ["light", "dark", "nord", "system", "sepia", "hc-dark"]) {
			expect(migrateThemeName(id)).toBe(id);
		}
	});

	it("is null for anything that was never a theme, so a caller falls back instead of showing a blank theme", () => {
		for (const value of [undefined, null, 3, {}, "", "Graphite", "__proto__", "toString", "constructor"]) {
			expect(migrateThemeName(value), String(value)).toBeNull();
		}
	});
});

describe("systemThemeFor", () => {
	it("takes a stored System entry of the right scheme, migrated, and the OMPdesk default otherwise", () => {
		expect(systemThemeFor("dark", "tokyo-night")).toBe("tokyo-night");
		expect(systemThemeFor("light", "frost")).toBe("solarized-light");
		expect(systemThemeFor("dark", "gruvbox")).toBe("gruvbox-dark");
		expect(systemThemeFor("dark", "sepia")).toBe(DEFAULT_SYSTEM_THEMES.dark);
		expect(systemThemeFor("light", "nord")).toBe(DEFAULT_SYSTEM_THEMES.light);
		expect(systemThemeFor("light", "system")).toBe(DEFAULT_SYSTEM_THEMES.light);
		expect(systemThemeFor("dark", undefined)).toBe(DEFAULT_SYSTEM_THEMES.dark);
	});
});

describe("getPersistedThemeSelection", () => {
	const set = vi.fn(async () => true);
	const prefs: Record<string, unknown> = {};

	beforeEach(() => {
		for (const key of Object.keys(prefs)) delete prefs[key];
		set.mockClear();
		vi.stubGlobal("window", {
			omp: {
				prefs: {
					get: async (key: string) => prefs[key],
					set,
				},
			},
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it("reads a retired themeName from a prefs record as its successor and stores the successor once", async () => {
		expect(await getPersistedThemeSelection({ themeName: "matcha", theme: "light" })).toBe("solarized-light");
		expect(set).toHaveBeenCalledWith("themeName", "solarized-light");
		set.mockClear();
		expect(await getPersistedThemeSelection({ themeName: "nord" })).toBe("nord");
		expect(set).not.toHaveBeenCalled();
	});

	it("reads a retired themeName through the prefs IPC the same way", async () => {
		prefs.themeName = "latte";
		expect(await getPersistedThemeSelection()).toBe("gruvbox-dark");
		expect(set).toHaveBeenCalledWith("themeName", "gruvbox-dark");
	});

	it("falls back to the legacy scheme pref, then to System, never to nothing", async () => {
		expect(await getPersistedThemeSelection({ theme: "dark" })).toBe("dark");
		expect(await getPersistedThemeSelection({ themeName: "Graphite", theme: "light" })).toBe("light");
		expect(await getPersistedThemeSelection({ themeName: 7 })).toBe("system");
		expect(await getPersistedThemeSelection({})).toBe("system");
		expect(await getPersistedThemeSelection()).toBe("system");
	});

	it("never persists a write for a value that was already current", async () => {
		prefs.themeName = "tokyo-night";
		expect(await getPersistedThemeSelection()).toBe("tokyo-night");
		expect(set).not.toHaveBeenCalled();
	});
});
