/**
 * Settings › Appearance › Theme: System first, the light group, the dark group, each card previewing its
 * own colors; a choice applies and saves at once; System pairs a light and a dark theme the user picks.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DARK_THEME_NAMES, LIGHT_THEME_NAMES } from "../../../shared/theme-names";
import { I18nProvider, translate } from "../../lib/i18n";
import { applyThemeByName, loadSystemThemePair, THEMES } from "../../lib/themes";
import { useUiStore } from "../../stores/ui";
import { ThemePicker } from "./ThemePicker";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

const prefs: Record<string, unknown> = {};
const set = vi.fn(async (key: string, value: unknown) => {
	prefs[key] = value;
	return true;
});
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { prefs: { get: async (key: string) => prefs[key], set } },
	matchMedia: (query: string) => ({
		matches: query.includes("dark") ? osDark : !osDark,
		addEventListener: () => {},
		removeEventListener: () => {},
	}),
});
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => {} } });
let osDark = false;

let root: Root | null = null;

async function settle(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}

/** linkedom's `select.value` has no setter: mark the option the way a pick does. */
function selectOption(select: HTMLSelectElement, value: string): void {
	for (const item of Array.from(select.querySelectorAll("option")) as HTMLOptionElement[]) {
		if (item.value === value) item.setAttribute("selected", "");
		else item.removeAttribute("selected");
	}
}

async function mount(): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<ThemePicker />
			</I18nProvider>,
		);
	});
	await settle();
}

const options = () => Array.from(document.body.querySelectorAll("[data-theme-option]")) as HTMLButtonElement[];
const option = (name: string) => document.body.querySelector(`[data-theme-option="${name}"]`) as HTMLButtonElement;
const root_ = () => document.documentElement;

async function choose(name: string): Promise<void> {
	await act(async () => {
		option(name).click();
	});
	await settle();
}

beforeEach(() => {
	for (const key of Object.keys(prefs)) delete prefs[key];
	set.mockClear();
	osDark = false;
	loadSystemThemePair(undefined);
	applyThemeByName("system", { persist: false });
});

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useUiStore.getState().setTheme("system");
});

describe("ThemePicker", () => {
	it("lists System, then the light themes, then the dark themes, with System selected by default", async () => {
		await mount();
		expect(options().map(button => button.getAttribute("data-theme-option"))).toEqual([
			"system",
			...LIGHT_THEME_NAMES,
			...DARK_THEME_NAMES,
		]);
		const inGroup = (scheme: string) =>
			Array.from(document.body.querySelectorAll(`[data-theme-group="${scheme}"] [data-theme-option]`)).map(button =>
				button.getAttribute("data-theme-option"),
			);
		expect(inGroup("light")).toEqual([...LIGHT_THEME_NAMES]);
		expect(inGroup("dark")).toEqual([...DARK_THEME_NAMES]);
		expect(option("system").getAttribute("aria-checked")).toBe("true");
		expect(options().filter(button => button.getAttribute("aria-checked") === "true")).toHaveLength(1);
	});

	it("labels each card with its theme name and previews its own surface and accent", async () => {
		await mount();
		for (const name of [...LIGHT_THEME_NAMES, ...DARK_THEME_NAMES]) {
			expect(option(name).textContent, name).toContain(translate(`themePicker.theme.${name}.label`));
			const preview = option(name).querySelector("[data-theme-preview]") as HTMLElement | null;
			expect(preview, name).not.toBeNull();
			expect(preview?.getAttribute("style") ?? "", name).toContain(THEMES[name].tokens["--omp-bg-primary"]);
			// A line of code in the theme's syntax colors sits in the preview.
			expect(preview?.innerHTML ?? "", name).toContain(THEMES[name].tokens["--omp-syntax-keyword"]);
		}
	});

	it("applies and saves a chosen theme, and moves the selection to it", async () => {
		await mount();
		await choose("nord");
		expect(root_().getAttribute("data-theme")).toBe("dark");
		expect(root_().getAttribute("data-theme-name")).toBe("nord");
		expect(root_().style.getPropertyValue("--omp-bg-primary")).toBe(THEMES.nord.tokens["--omp-bg-primary"]);
		expect(root_().style.getPropertyValue("--omp-ansi-red")).toBe(THEMES.nord.ansi[1]);
		expect(set).toHaveBeenCalledWith("themeName", "nord");
		expect(set).toHaveBeenCalledWith("theme", "dark");
		expect(useUiStore.getState().theme).toBe("dark");
		expect(option("nord").getAttribute("aria-checked")).toBe("true");
		expect(option("system").getAttribute("aria-checked")).toBe("false");
	});

	it("moves with the arrow keys across the groups and applies each stop", async () => {
		await mount();
		await choose("hc-light");
		const press = async (key: string) => {
			const event = new Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(event, { key });
			await act(async () => {
				option("hc-light").dispatchEvent(event);
			});
			await settle();
		};
		await press("ArrowRight");
		expect(root_().getAttribute("data-theme-name")).toBe("dark");
		await press("ArrowLeft");
		expect(root_().getAttribute("data-theme-name")).toBe("hc-light");
	});

	it("System pairs a chosen light and a chosen dark theme: each select lists only its scheme", async () => {
		await mount();
		const lightSelect = document.body.querySelector("#setting-gui-systemLightTheme select") as HTMLSelectElement;
		const darkSelect = document.body.querySelector("#setting-gui-systemDarkTheme select") as HTMLSelectElement;
		const values = (select: HTMLSelectElement) =>
			Array.from(select.querySelectorAll("option")).map(item => (item as HTMLOptionElement).value);
		expect(values(lightSelect)).toEqual([...LIGHT_THEME_NAMES]);
		expect(values(darkSelect)).toEqual([...DARK_THEME_NAMES]);
		expect(lightSelect.value).toBe("light");
		expect(darkSelect.value).toBe("dark");
	});

	it("shows the chosen dark theme under System while the OS is dark, and the chosen light one while it is light", async () => {
		osDark = true;
		await mount();
		const darkSelect = document.body.querySelector("#setting-gui-systemDarkTheme select") as HTMLSelectElement;
		selectOption(darkSelect, "tokyo-night");
		await act(async () => {
			darkSelect.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await settle();
		expect(set).toHaveBeenCalledWith("systemDarkTheme", "tokyo-night");
		expect(root_().getAttribute("data-theme-name")).toBe("tokyo-night");
		expect(root_().style.getPropertyValue("--omp-accent")).toBe(THEMES["tokyo-night"].tokens["--omp-accent"]);

		const lightSelect = document.body.querySelector("#setting-gui-systemLightTheme select") as HTMLSelectElement;
		selectOption(lightSelect, "sepia");
		await act(async () => {
			lightSelect.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await settle();
		expect(set).toHaveBeenCalledWith("systemLightTheme", "sepia");
		// The OS is dark: the dark half still shows; the light half waits for the OS to flip.
		expect(root_().getAttribute("data-theme-name")).toBe("tokyo-night");
		osDark = false;
		applyThemeByName("system", { persist: false });
		expect(root_().getAttribute("data-theme-name")).toBe("sepia");
		expect(root_().getAttribute("data-theme")).toBe("light");
	});

	it("previews both halves of the pair on the System card", async () => {
		await mount();
		const previews = Array.from(option("system").querySelectorAll("[data-theme-preview]")).map(node =>
			node.getAttribute("data-theme-preview"),
		);
		expect(previews).toEqual([THEMES.light.label, THEMES.dark.label]);
	});

	it("shows the light/dark pair only while System is the theme", async () => {
		await mount();
		expect(document.body.querySelector("#setting-gui-systemLightTheme")).not.toBeNull();
		await choose("nord");
		expect(document.body.querySelector("#setting-gui-systemLightTheme")).toBeNull();
		expect(document.body.querySelector("#setting-gui-systemDarkTheme")).toBeNull();
		await choose("system");
		expect(document.body.querySelector("#setting-gui-systemDarkTheme")).not.toBeNull();
	});
});
