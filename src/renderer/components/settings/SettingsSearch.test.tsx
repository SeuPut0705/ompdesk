/**
 * Settings search: the built-in REA MCP row is findable from the page search
 * (its own result, routed to Tools › MCP servers and anchored on the row),
 * and while results replace the section no nav row claims to be the page.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { SettingsPage } from "./SettingsPage";
import { searchSettings } from "./settings-search";

const { document, window, Event, CustomEvent, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	document,
	window,
	Event,
	CustomEvent,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});

// A result scrolls its row into view; linkedom draws nothing.
Object.assign(HTMLElement.prototype, { scrollIntoView: () => {} });

const notConnected = { type: "response", command: "test", success: false, error: "not connected" };
Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
		system: { info: vi.fn(async () => ({ deviceLanguage: "en-US" })) },
		sidecar: { restart: vi.fn(async () => {}) },
		// What a search result opens reads it: the REA row on Tools › MCP servers.
		builtinRea: { get: vi.fn(() => new Promise(() => {})) },
		events: { onConfigUpdate: vi.fn(() => () => {}) },
		rpc: {
			getSettingsSchema: vi.fn(async () => notConnected),
			getSettings: vi.fn(async () => notConnected),
		},
	},
});

const search = (query: string) =>
	searchSettings({
		query,
		t: key => translate(key),
		entries: [],
		values: {},
		schemaTabLabel: id => id,
		schemaLabel: entry => entry.path,
	});

let root: Root | null = null;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useSessionStore.getState().reset();
});

describe("settings search", () => {
	it("finds the built-in REA MCP row by name, wire words and Korean, first for its own name", () => {
		const rea = expect.objectContaining({
			key: "gui:builtinRea",
			title: translate("mcp.rea.title"),
			target: "tools:mcp",
			rowId: "setting-gui-builtinRea",
		});
		expect(search("rea")[0]).toEqual(rea);
		expect(search("reverse engineering")).toContainEqual(rea);
		expect(search("리버스")).toContainEqual(rea);
		expect(search("mcp")).toContainEqual(rea);
	});

	it("offers no section the page does not list (an empty Other settings)", () => {
		const keys = (hiddenSections?: readonly "advanced"[]) =>
			searchSettings({
				query: "other settings",
				t: key => translate(key),
				entries: [],
				values: {},
				schemaTabLabel: id => id,
				schemaLabel: entry => entry.path,
				hiddenSections,
			}).map(result => result.key);
		expect(keys()).toContain("section:advanced");
		expect(keys(["advanced"])).not.toContain("section:advanced");
	});

	it("selects no nav row while results replace the section", async () => {
		useSessionStore.setState({ status: "starting" });
		useUiStore.setState({ settingsTab: "advanced" });
		root = createRoot(document.body as unknown as globalThis.Element);
		await act(async () => {
			root?.render(
				<I18nProvider>
					<SettingsPage />
				</I18nProvider>,
			);
		});
		const current = () => document.querySelector('[data-settings-section][aria-current="true"]');
		expect(current()?.getAttribute("data-settings-section")).toBe("advanced");

		const field = document.querySelector('input[type="search"]');
		if (!field) throw new Error("no settings search field");
		const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value");
		descriptor?.set?.call(field, "rea");
		const record = field as unknown as Record<string, unknown>;
		const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
		const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void }) : undefined;
		await act(async () => props?.onChange?.({ target: field, currentTarget: field }));

		expect(document.querySelector('[data-search-key="gui:builtinRea"]')).not.toBeNull();
		expect(current()).toBeNull();
	});

	it("opens the first result on Enter in the search field, and goes to the results on ↓", async () => {
		useSessionStore.setState({ status: "starting" });
		useUiStore.setState({ settingsTab: "advanced" });
		root = createRoot(document.body as unknown as globalThis.Element);
		await act(async () => {
			root?.render(
				<I18nProvider>
					<SettingsPage />
				</I18nProvider>,
			);
		});
		const field = document.querySelector('input[type="search"]') as unknown as Record<string, unknown>;
		const propsKey = Object.getOwnPropertyNames(field).find(key => key.startsWith("__reactProps$")) ?? "";
		const props = () =>
			field[propsKey] as {
				onChange: (event: object) => void;
				onKeyDown: (event: object) => void;
			};
		const type = async (value: string) => {
			const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value");
			descriptor?.set?.call(field, value);
			await act(async () => props().onChange({ target: field, currentTarget: field }));
		};
		const press = async (key: string) => {
			const preventDefault = vi.fn();
			await act(async () => props().onKeyDown({ key, nativeEvent: { isComposing: false }, preventDefault }));
			return preventDefault;
		};

		await type("rea");
		const first = document.querySelector('[data-search-key="gui:builtinRea"] button') as unknown as {
			focus: () => void;
		};
		const focus = vi.fn();
		first.focus = focus;
		expect(await press("ArrowDown")).toHaveBeenCalled();
		expect(focus).toHaveBeenCalled();

		expect(await press("Enter")).toHaveBeenCalled();
		expect(useUiStore.getState().settingsTab).toBe("tools:mcp");
		expect(document.querySelector("[data-settings-search-results]")).toBeNull();
	});

	it("names the keyboard section's own search briefly enough to fit the field", async () => {
		useSessionStore.setState({ status: "starting" });
		useUiStore.setState({ settingsTab: "keyboard" });
		root = createRoot(document.body as unknown as globalThis.Element);
		await act(async () => {
			root?.render(
				<I18nProvider>
					<SettingsPage />
				</I18nProvider>,
			);
		});
		// "Search Keyboard shortcuts…" ran under the ⌘F hint in the nav-width field.
		expect(document.querySelector('input[type="search"]')?.getAttribute("placeholder")).toBe("Search shortcuts");
	});
});
