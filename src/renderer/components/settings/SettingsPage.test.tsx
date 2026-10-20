/**
 * Settings page contracts: deep-link resolution, the store routing that
 * opens the page, GUI visibility, schema-tab rendering (Advanced) including
 * translations, row semantics, and search routing.
 */

import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { SettingEntry } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { en } from "../../locales/en";
import { ko } from "../../locales/ko";
import { useUiStore } from "../../stores/ui";
import { AgentSection } from "./AgentSection";
import { AppearanceSection } from "./AppearanceSection";
import { GeneralSection } from "./GeneralSection";
import { OwnedSchemaSettings } from "./OwnedSchemaSettings";
import { SchemaSettingRow } from "./SchemaSettingRow";
import { SettingsConnectionBanner } from "./SettingsPage";
import {
	CURATED_SCHEMA_ROWS,
	CUSTOM_SCHEMA_EDITORS,
	resolveSettingsTarget,
	SETTINGS_NAV,
	SETTINGS_SECTION_IDS,
	schemaSettingsOwner,
} from "./settings-catalog";
import { type SettingsData, SettingsDataProvider } from "./settings-data";
import { SettingsNavigationProvider } from "./settings-navigation";
import { isSettingVisibleInGui } from "./settings-schema-utils";
import { searchSettings } from "./settings-search";

function entry(partial: Partial<SettingEntry> & { path: string }): SettingEntry {
	return { type: "boolean", value: false, default: false, ...partial };
}

function withData(entries: SettingEntry[], values: Record<string, unknown>, children: ReactNode) {
	const data: SettingsData = {
		schema: { entries, tabs: [] },
		values,
		loadState: "ready",
		loadError: null,
		sidecarReady: true,
		sidecarBusy: false,
		advisorActive: undefined,
		onCommitted: () => {},
		retry: () => {},
	};
	return (
		<I18nProvider>
			<SettingsNavigationProvider value={() => {}}>
				<SettingsDataProvider value={data}>{children}</SettingsDataProvider>
			</SettingsNavigationProvider>
		</I18nProvider>
	);
}

function renderSchemaTab(
	entries: SettingEntry[],
	tabId: string,
	_groups: string[],
	values: Record<string, unknown> = {},
): string {
	return renderToStaticMarkup(
		withData(
			entries.filter(item => item.tab === tabId),
			values,
			<>
				{SETTINGS_SECTION_IDS.map(section => (
					<OwnedSchemaSettings key={section} section={section} />
				))}
				{entries
					.filter(item => item.tab === tabId && CURATED_SCHEMA_ROWS[item.path])
					.map(item => (
						<SchemaSettingRow key={item.path} entry={item} value={values[item.path]} onCommitted={() => {}} />
					))}
			</>,
		),
	);
}

afterEach(() => {
	useUiStore.setState({ destination: "session", settingsTab: "general" });
});

describe("resolveSettingsTarget", () => {
	it("maps section and section:sub targets", () => {
		expect(resolveSettingsTarget(undefined)).toEqual({ section: "general" });
		expect(resolveSettingsTarget("keyboard")).toEqual({ section: "keyboard", sub: undefined });
		expect(resolveSettingsTarget("tools:mcp")).toEqual({ section: "tools", sub: "mcp" });
		expect(resolveSettingsTarget("tools:marketplaces")).toEqual({ section: "tools", sub: "marketplaces" });
		expect(resolveSettingsTarget("agent:context")).toEqual({ section: "agent", sub: "context" });
	});

	it("rejects obsolete aliases instead of retaining a second route convention", () => {
		expect(resolveSettingsTarget("context")).toEqual({ section: "general" });
		expect(resolveSettingsTarget("providers")).toEqual({ section: "general" });
		expect(resolveSettingsTarget("nonsense")).toEqual({ section: "general" });
	});
});

describe("Settings › Memory", () => {
	const STOCK_MEMORY_ROWS = [
		["memory.backend", "memory"],
		["memories.enabled", "memory"],
		["mnemopi.bank", "memory"],
		["hindsight.apiUrl", "memory"],
		["sharpshooter.model", "memory"],
		["autolearn.enabled", "memory"],
	] as const;
	const stockEntries = STOCK_MEMORY_ROWS.map(([path, tab]) =>
		entry({ path, tab, group: "Memory", label: `Stock ${path}`, type: "string" }),
	);

	it("is one section under Agent, named in English and Korean, and deep-linkable", () => {
		const agent = SETTINGS_NAV.find(group => group.id === "agent");
		expect(agent?.items).toContain("memory");
		expect(SETTINGS_SECTION_IDS).toContain("memory");
		expect(resolveSettingsTarget("memory")).toEqual({ section: "memory", sub: undefined });
		expect(en["settings.section.memory"]).toBe("Memory");
		expect(ko["settings.section.memory"]).toBe("메모리");
	});

	it("lists no stock memory row in any section, Advanced included", () => {
		expect(stockEntries.filter(item => isSettingVisibleInGui(item, {}))).toEqual([]);
		const html = renderToStaticMarkup(
			withData(
				stockEntries,
				{},
				SETTINGS_SECTION_IDS.map(section => <OwnedSchemaSettings key={section} section={section} />),
			),
		);
		for (const item of stockEntries) expect(html).not.toContain(item.label ?? "?");
	});

	it("is found by search as a section, while a stock memory row is not", () => {
		const results = searchSettings({
			query: "memory",
			t: key => translate(key),
			entries: stockEntries,
			values: {},
			schemaTabLabel: id => id,
			schemaLabel: item => item.label ?? item.path,
		});
		expect(results.some(result => result.target === "memory")).toBe(true);
		expect(results.filter(result => result.path !== undefined)).toEqual([]);
	});
});

describe("openSettings routing", () => {
	it("deep-links a section and keeps it when ⌘, lands on the open page", () => {
		useUiStore.getState().openSettings("tools:skills");
		expect(useUiStore.getState()).toMatchObject({ destination: "settings", settingsTab: "tools:skills" });
		useUiStore.getState().openSettings();
		expect(useUiStore.getState().settingsTab).toBe("tools:skills");
		useUiStore.getState().setSettingsSection("appearance");
		expect(useUiStore.getState()).toMatchObject({ destination: "settings", settingsTab: "appearance" });
	});

	it("starts a cold open on General", () => {
		useUiStore.setState({ destination: "session", settingsTab: "ssh" });
		useUiStore.getState().openSettings();
		expect(useUiStore.getState()).toMatchObject({ destination: "settings", settingsTab: "general" });
	});
});

describe("GUI settings visibility", () => {
	const sharedEntry = entry({
		path: "compaction.enabled",
		tab: "appearance",
		group: "Theme",
		label: "Auto Compaction",
	});
	const terminalEntry = entry({
		path: "statusLine.separator",
		tab: "appearance",
		group: "Status Line",
		label: "Status Line Separator",
		tuiOnly: true,
	});

	it("rejects settings whose only consumer is TUI chrome", () => {
		expect(isSettingVisibleInGui(sharedEntry, {})).toBe(true);
		expect(isSettingVisibleInGui(terminalEntry, {})).toBe(false);
		const unsupported = [
			"tui.resizeScrollback",
			"statusLine.preset",
			"display.showTurnTime",
			"theme.dark",
			"theme.light",
			"tui.tight",
			"colorBlindMode",
			"display.showTokenUsage",
			"terminal.showProgress",
			"spelling.typoDetection",
			"spelling.autocomplete",
			"spelling.autocorrect",
			"tui.vimModeDisplay",
			"tui.mouse",
			"tui.maxInlineImageColumns",
			"tui.maxInlineImageRows",
			"tui.maxInlineImages",
			"statusLine.leftSegments",
			"statusLine.rightSegments",
			"statusLine.segmentOptions",
		].map(path => entry({ path, tab: "terminal-display" }));
		expect(unsupported.filter(item => isSettingVisibleInGui(item, {}))).toEqual([]);
	});

	it("omits TUI-only rows and groups from a schema tab", () => {
		const html = renderSchemaTab([sharedEntry, terminalEntry], "appearance", ["Theme", "Status Line"]);
		expect(html).toContain("Auto Compaction");
		expect(html).not.toContain("Status Line Separator");
		expect(html).not.toContain(">Status Line</h3>");
	});

	it("keeps conditional Vim and Plan autosave rows aligned with their enabling settings", () => {
		const vim = entry({ path: "tui.vimModeIndicator", condition: "vimModeEnabled", tab: "experience" });
		const autosave = entry({ path: "plan.autosaveDir", condition: "planAutosaveEnabled", tab: "tasks" });
		expect(isSettingVisibleInGui(vim, { "tui.vimMode": false })).toBe(false);
		expect(isSettingVisibleInGui(vim, { "tui.vimMode": true })).toBe(true);
		expect(isSettingVisibleInGui(autosave, { "plan.enabled": true, "plan.autosave": false })).toBe(false);
		expect(isSettingVisibleInGui(autosave, { "plan.enabled": true, "plan.autosave": true })).toBe(true);
	});

	it("renders fixed ordered arrays as choices instead of an arbitrary text field", () => {
		const methodOrder = entry({
			path: "compaction.methodOrder",
			type: "array",
			value: ["remote", "soft"],
			default: ["remote", "soft"],
			tab: "context",
			group: "Compaction",
			ordered: true,
			options: [
				{ value: "remote", label: "OpenAI server compaction" },
				{ value: "soft", label: "Soft compaction" },
				{ value: "shake", label: "Shake" },
			],
		});
		const html = renderSchemaTab([methodOrder], "context", ["Compaction"], {
			"compaction.methodOrder": ["remote", "soft"],
		});
		expect(html).toContain("<select");
		expect(html).toContain('value="shake"');
		expect(html).toContain(">OpenAI server compaction<");
		expect(html).toContain(">Soft compaction<");
		expect(html).not.toContain('value="remote"');
		expect(html).not.toContain('value="soft"');
		expect(html).not.toContain("<input");
	});

	it("keeps empty image broker maps on the nested JSON editor", () => {
		const options = entry({
			path: "images.urls.options",
			type: "record",
			value: {},
			default: {},
			tab: "model",
			group: "Vision",
		});
		const html = renderSchemaTab([options], "model", ["Vision"], { "images.urls.options": {} });
		expect(html).toContain("<textarea");
		expect(html).toContain("{}");
		expect(html).not.toContain("<input");
	});
});

describe("schema tab translations", () => {
	const entries: SettingEntry[] = [
		entry({
			path: "compaction.enabled",
			tab: "appearance",
			group: "Theme",
			label: "Auto Compaction",
			description: "Compact when context grows",
		}),
		entry({
			path: "zz.mystery",
			tab: "appearance",
			group: "Undeclared",
			label: "Mystery Setting",
			description: "An English-only setting",
		}),
	];

	function inLanguage(language: string, run: () => void) {
		const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
		Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language } });
		try {
			run();
		} finally {
			if (original) Object.defineProperty(globalThis, "navigator", original);
		}
	}

	it("renders group titles and setting text in Korean when lang is ko, with English fallback", () => {
		inLanguage("ko-KR", () => {
			const html = renderSchemaTab(entries, "appearance", ["Theme"]);
			expect(html).toContain("자동 압축");
			expect(html).toContain(">Undeclared</h3>");
			expect(html).toContain("Mystery Setting");
			expect(html).not.toContain("Auto Compaction");
		});
	});

	it("renders the schema's English text when lang is en", () => {
		const html = renderSchemaTab(entries, "appearance", ["Theme"]);
		expect(html).toContain("Auto Compaction");
		expect(html).toContain("Compact when context grows");
	});
});

describe("SchemaSettingRow", () => {
	const configured = entry({
		path: "compaction.enabled",
		label: "Auto Compaction",
		provenance: { layers: ["global"], globalValue: true, globalPath: "/home/u/.omp/agent/config.yml" },
	});

	function render(row: SettingEntry, showSource: boolean) {
		return renderToStaticMarkup(
			<I18nProvider>
				<SchemaSettingRow entry={row} onCommitted={() => {}} showSource={showSource} value={true} />
			</I18nProvider>,
		);
	}

	it("renders a boolean as one labelled switch without save text", () => {
		const html = render(configured, false);
		expect(html.match(/role="switch"/g)).toHaveLength(1);
		expect(html).toContain('aria-checked="true"');
		expect(html).not.toContain("Saved");
	});

	it("shows where a value comes from only in Advanced, and only when a layer sets it", () => {
		expect(render(configured, false)).not.toContain("<details");
		expect(render(configured, true)).toContain("<details");
		expect(render({ ...configured, provenance: { layers: [], globalValue: undefined } }, true)).not.toContain(
			"<details",
		);
	});

	it("opens the source with the app's chevron disclosure, not the native marker", () => {
		const { document: doc } = parseHTML(render(configured, true));
		const summary = doc.querySelector("details > summary");
		expect(summary?.className).toContain("list-none");
		expect(summary?.className).toContain("focus-visible:outline-(--sc-focus-ring)");
		expect(summary?.querySelector("svg[aria-hidden]")).not.toBeNull();
	});
});

describe("GeneralSection", () => {
	it("keeps host settings out of this device's section", () => {
		const html = renderToStaticMarkup(withData([entry({ path: "compaction.enabled" })], {}, <GeneralSection />));
		expect(html).not.toContain('id="setting-compaction.enabled"');
		expect(html).toContain('id="setting-gui-proxy"');
		expect(html).toContain('id="setting-gui-titleState"');
	});

	it("offers every sidebar shortcut and folds the proxy under Advanced", () => {
		const html = renderToStaticMarkup(withData([], {}, <GeneralSection />));
		for (const pin of ["usage", "terminal", "diff", "preview", "files", "jobs", "schedules"])
			expect(html).toContain(`id="setting-gui-railPin-${pin}"`);
		const advanced = html.indexOf("data-settings-advanced");
		expect(advanced).toBeGreaterThan(html.indexOf('id="setting-gui-railPins"'));
		expect(html.indexOf('id="setting-gui-proxy"')).toBeGreaterThan(advanced);
		// The machine setup list moved to Updates & about.
		expect(html).not.toContain('id="setting-machine-setup"');
	});
});

describe("SettingsConnectionBanner", () => {
	it("explains a missing omp connection and offers a retry", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<SettingsConnectionBanner busy={false} error="connection lost" onRetry={() => {}} status="error" />
			</I18nProvider>,
		);
		expect(html).toContain('data-settings-connection-notice="true"');
		expect(html).toContain(translate("settings.connection.unavailable"));
		expect(html).toContain("connection lost");
		expect(html).toContain("Retry");
	});
});

describe("searchSettings", () => {
	const entries: SettingEntry[] = [
		entry({ path: "compaction.enabled", tab: "context", group: "Compaction", label: "Auto-Compact" }),
		entry({ path: "compaction.midTurnEnabled", tab: "context", group: "Compaction", label: "Mid-Turn Compaction" }),
		entry({ path: "mystery.flag", label: "Mystery Flag", advanced: true }),
	];
	const search = (query: string) =>
		searchSettings({
			query,
			t: key => translate(key),
			entries,
			values: {},
			schemaTabLabel: id => id,
			schemaLabel: e => e.label ?? e.path,
		});

	it("returns one canonical result per key and preserves the future-schema fallback", () => {
		const results = search("compaction.enabled").filter(result => result.path === "compaction.enabled");
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ target: "agent", rowId: "setting-compaction.enabled" });
		expect(search("mystery")[0]).toMatchObject({ target: "advanced", rowId: "setting-mystery.flag" });
	});

	it("gives structured editors a canonical route and precise anchor", () => {
		for (const [path, editor] of Object.entries(CUSTOM_SCHEMA_EDITORS)) {
			const results = searchSettings({
				query: path,
				t: key => translate(key),
				entries: [entry({ path })],
				values: {},
				schemaTabLabel: id => id,
				schemaLabel: item => item.path,
			});
			expect(results.filter(result => result.path === path)).toEqual([
				expect.objectContaining({ target: `${editor.section}:${editor.sub}`, rowId: editor.rowId }),
			]);
			expect(schemaSettingsOwner({ path })).toBe(editor.section);
		}
	});

	it("finds renderer preferences and sections in any UI language, title prefix first", () => {
		expect(search("테마")[0]).toMatchObject({ target: "appearance" });
		expect(search("proxy").some(result => result.target === "general")).toBe(true);
		expect(search("mcp").some(result => result.key === "section:tools")).toBe(true);
		expect(search("")).toEqual([]);
	});
});

describe("rows folded under Advanced", () => {
	const afterAdvanced = (html: string, id: string) => {
		const advanced = html.indexOf("data-settings-advanced");
		expect(advanced, "an Advanced disclosure").toBeGreaterThan(-1);
		expect(html.indexOf(`id="${id}"`), id).toBeGreaterThan(advanced);
	};

	it("General keeps the side panel and terminal shell under Advanced, and shows no Dock row", () => {
		const html = renderToStaticMarkup(withData([], {}, <GeneralSection />));
		for (const id of ["setting-gui-panelDefault", "setting-gui-panelSide", "setting-gui-terminalShell"])
			afterAdvanced(html, id);
		expect(html).not.toContain("setting-gui-closeToDock");
	});

	it("Agent behavior renders Advanced always, with the auto panels in it", () => {
		const html = renderToStaticMarkup(withData([], {}, <AgentSection />));
		afterAdvanced(html, "setting-gui-autoPreviewDevServer");
		afterAdvanced(html, "setting-gui-autoOpenChanges");
		expect(html).toContain('id="settings-agent-automation-more"');
	});

	it("Appearance folds the agent-theme switch and the paste threshold under Advanced", () => {
		const html = renderToStaticMarkup(withData([], {}, <AppearanceSection />));
		afterAdvanced(html, "setting-gui-followAgentTheme");
		afterAdvanced(html, "setting-gui-pasteMenuThreshold");
	});

	it.each([
		["panelSide", "general"],
		["autoOpenChanges", "agent"],
		["pasteMenuThreshold", "appearance"],
	])("search for %s lands on its row in %s", (query, section) => {
		const [hit] = searchSettings({
			query,
			t: key => translate(key),
			entries: [],
			values: {},
			schemaTabLabel: id => id,
			schemaLabel: entry => entry.path,
		});
		expect(hit).toMatchObject({ target: section, rowId: `setting-gui-${query}` });
	});
});
