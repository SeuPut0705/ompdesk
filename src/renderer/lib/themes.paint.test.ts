/**
 * What a cold start paints before any script has read the preferences: applyThemeByName leaves the scheme and
 * each scheme's page background in localStorage, and public/pre-paint.js puts them on <html> and into the
 * page's theme-color metas (an installed phone page's status bar), whatever theme was saved.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyThemeByName, loadSystemThemePair, setSystemThemePair, THEMES, type ThemeSelection } from "./themes";

const { document } = parseHTML(
	"<html><head><meta name='theme-color' content='#000'><meta name='theme-color' content='#fff'></head><body></body></html>",
);
Object.assign(globalThis, { document });

const stored = new Map<string, string>();
const storage = {
	getItem: (key: string) => stored.get(key) ?? null,
	setItem: (key: string, value: string) => void stored.set(key, value),
};
let osDark = false;
const matchMedia = (query: string) => ({
	matches: query.includes("dark") ? osDark : !osDark,
	addEventListener: () => {},
	removeEventListener: () => {},
});

beforeEach(() => {
	stored.clear();
	osDark = false;
	vi.stubGlobal("window", { omp: { prefs: { set: async () => true, get: async () => undefined } }, matchMedia });
	vi.stubGlobal("localStorage", storage);
	loadSystemThemePair(undefined);
});
afterEach(() => vi.unstubAllGlobals());

const PRE_PAINT = readFileSync(join(import.meta.dirname, "../public/pre-paint.js"), "utf8");

/** Runs pre-paint.js against a fresh page under the stored values and the given OS scheme. */
function prePaint(os: "dark" | "light") {
	const page = parseHTML(
		"<html><head><meta name='theme-color' content='#000' media='(prefers-color-scheme: dark)'><meta name='theme-color' content='#fff' media='(prefers-color-scheme: light)'></head><body></body></html>",
	);
	const fakeWindow = {
		matchMedia: (query: string) => ({ matches: query.includes("dark") ? os === "dark" : os === "light" }),
	};
	new Function("document", "localStorage", "window", PRE_PAINT)(page.document, storage, fakeWindow);
	const root = page.document.documentElement;
	return {
		scheme: root.dataset.theme,
		background: root.style.backgroundColor,
		colorScheme: root.style.colorScheme,
		metas: Array.from(page.document.querySelectorAll('meta[name="theme-color"]')).map(meta =>
			meta.getAttribute("content"),
		),
	};
}

function save(selection: ThemeSelection): void {
	applyThemeByName(selection);
}

describe("pre-paint", () => {
	it.each([
		"nord",
		"sepia",
		"tokyo-night",
		"gruvbox-dark",
		"github-light",
		"hc-dark",
		"hc-light",
		"solarized-light",
	] as const)("paints a saved %s in its own background and scheme, whatever the OS says", name => {
		save(name);
		const theme = THEMES[name];
		for (const os of ["dark", "light"] as const) {
			const painted = prePaint(os);
			expect(painted.scheme, `${name} on ${os} OS`).toBe(theme.scheme);
			expect(painted.background).toBe(theme.tokens["--omp-bg-primary"]);
			expect(painted.colorScheme).toBe(theme.scheme);
			expect(painted.metas).toEqual([theme.tokens["--omp-bg-primary"], theme.tokens["--omp-bg-primary"]]);
		}
	});

	it("paints System as the pair's light theme under a light OS and its dark theme under a dark OS", () => {
		loadSystemThemePair({ systemLightTheme: "sepia", systemDarkTheme: "nord" });
		save("system");
		expect(prePaint("light")).toMatchObject({ scheme: "light", background: THEMES.sepia.tokens["--omp-bg-primary"] });
		expect(prePaint("dark")).toMatchObject({ scheme: "dark", background: THEMES.nord.tokens["--omp-bg-primary"] });
	});

	it("repaints the stored backgrounds when the System pair changes", () => {
		save("system");
		setSystemThemePair({ dark: "gruvbox-dark" }, { persist: false });
		// persist:false leaves the stored paint alone; a saved change refreshes it.
		expect(prePaint("dark").background).toBe(THEMES.dark.tokens["--omp-bg-primary"]);
		setSystemThemePair({ dark: "gruvbox-dark" });
		expect(prePaint("dark").background).toBe(THEMES["gruvbox-dark"].tokens["--omp-bg-primary"]);
	});

	it("falls back to the OMPdesk backgrounds with nothing stored, or with a damaged record", () => {
		expect(prePaint("dark")).toMatchObject({ scheme: "dark", background: "#19191c" });
		stored.set("omp.themeScheme", "light");
		stored.set("omp.themePaint", "{not json");
		expect(prePaint("dark")).toMatchObject({ scheme: "light", background: "#ffffff" });
		stored.set("omp.themePaint", JSON.stringify({ light: "red; background: url(x)" }));
		expect(prePaint("dark")).toMatchObject({ scheme: "light", background: "#ffffff" });
	});
});

describe("window and page chrome follow the theme", () => {
	it("keeps the title-bar surface and text colors on the --sc-* tokens every theme writes", () => {
		for (const [name, theme] of Object.entries(THEMES)) {
			applyThemeByName(name as keyof typeof THEMES, { persist: false });
			const style = document.documentElement.style;
			expect(style.getPropertyValue("--sc-bg"), name).toBe(theme.tokens["--omp-bg-primary"]);
			expect(style.getPropertyValue("--sc-surface-1"), name).toBe(theme.tokens["--omp-sidebar-bg"]);
			expect(style.getPropertyValue("--sc-text"), name).toBe(theme.tokens["--omp-text"]);
		}
	});
});
