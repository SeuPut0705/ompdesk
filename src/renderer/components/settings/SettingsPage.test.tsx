/**
 * Settings page contracts: deep-link resolution, the store routing that
 * opens the page, schema bucketing and GUI visibility, schema-tab rendering
 * (Advanced) including translations, row semantics, and search routing.
 */

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { SettingEntry } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { SchemaTabSettings } from "./AdvancedSection";
import { GeneralSection } from "./GeneralSection";
import { SchemaSettingRow } from "./SchemaSettingRow";
import { SettingsConnectionBanner } from "./SettingsPage";
import { resolveSettingsTarget } from "./settings-catalog";
import { type SettingsData, SettingsDataProvider } from "./settings-data";
import { groupSchemaEntries, isSettingVisibleInGui } from "./settings-schema-utils";
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
			<SettingsDataProvider value={data}>{children}</SettingsDataProvider>
		</I18nProvider>
	);
}

function renderSchemaTab(
	entries: SettingEntry[],
	tabId: string,
	groups: string[],
	values: Record<string, unknown> = {},
): string {
	return renderToStaticMarkup(withData(entries, values, <SchemaTabSettings groups={groups} tabId={tabId} />));
}

afterEach(() => {
	useUiStore.setState({ destination: "session", settingsTab: "general" });
});

describe("resolveSettingsTarget", () => {
	it("maps section and section:sub targets", () => {
		expect(resolveSettingsTarget(undefined)).toEqual({ section: "general" });
		expect(resolveSettingsTarget("keyboard")).toEqual({ section: "keyboard", sub: undefined });
		expect(resolveSettingsTarget("extensions:mcp")).toEqual({ section: "extensions", sub: "mcp" });
		expect(resolveSettingsTarget("plugins:marketplaces")).toEqual({ section: "plugins", sub: "marketplaces" });
		expect(resolveSettingsTarget("advanced:model")).toEqual({ section: "advanced", sub: "model" });
	});

	it("sends bare agent schema tabs to their Advanced category and providers to Models", () => {
		expect(resolveSettingsTarget("context")).toEqual({ section: "advanced", sub: "context" });
		expect(resolveSettingsTarget("providers")).toEqual({ section: "models" });
		expect(resolveSettingsTarget("nonsense")).toEqual({ section: "general" });
	});
});

describe("openSettings routing", () => {
	it("deep-links a section and keeps it when ⌘, lands on the open page", () => {
		useUiStore.getState().openSettings("extensions:skills");
		expect(useUiStore.getState()).toMatchObject({ destination: "settings", settingsTab: "extensions:skills" });
		useUiStore.getState().openSettings();
		expect(useUiStore.getState().settingsTab).toBe("extensions:skills");
		useUiStore.getState().setSettingsSection("appearance");
		expect(useUiStore.getState()).toMatchObject({ destination: "settings", settingsTab: "appearance" });
	});

	it("starts a cold open on General", () => {
		useUiStore.setState({ destination: "session", settingsTab: "ssh" });
		useUiStore.getState().openSettings();
		expect(useUiStore.getState()).toMatchObject({ destination: "settings", settingsTab: "general" });
	});
});

describe("groupSchemaEntries", () => {
	const entries: SettingEntry[] = [
		entry({ path: "a.loose", tab: "appearance" }),
		entry({ path: "a.theme", tab: "appearance", group: "Theme" }),
		entry({ path: "a.display", tab: "appearance", group: "Display" }),
		entry({ path: "a.status", tab: "appearance", group: "Status Line" }),
		entry({ path: "a.mystery", tab: "appearance", group: "Undeclared" }),
		entry({ path: "m.other", tab: "model", group: "Thinking" }),
	];

	it("filters to the requested tab only", () => {
		const { tabEntries } = groupSchemaEntries(entries, "appearance", []);
		expect(tabEntries.map(e => e.path)).not.toContain("m.other");
		expect(tabEntries).toHaveLength(5);
	});

	it("orders groups by the declared TAB_GROUPS order and appends undeclared groups", () => {
		const { orderedGroups } = groupSchemaEntries(entries, "appearance", [
			"Theme",
			"Status Line",
			"Display",
			"Images",
		]);
		expect(orderedGroups.map(group => group.name)).toEqual(["Theme", "Status Line", "Display", "Undeclared"]);
	});

	it("separates ungrouped entries and omits empty declared groups", () => {
		const { ungrouped, orderedGroups } = groupSchemaEntries(entries, "appearance", ["Images", "Theme"]);
		expect(ungrouped.map(e => e.path)).toEqual(["a.loose"]);
		expect(orderedGroups.map(group => group.name)).not.toContain("Images");
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
			expect(html).toContain(">테마</h3>");
			expect(html).toContain("자동 압축");
			expect(html).toContain(">Undeclared</h3>");
			expect(html).toContain("Mystery Setting");
			expect(html).not.toContain("Auto Compaction");
		});
	});

	it("renders the schema's English text when lang is en", () => {
		const html = renderSchemaTab(entries, "appearance", ["Theme"]);
		expect(html).toContain(">Theme</h3>");
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
});

describe("GeneralSection", () => {
	it("gives compaction its own heading and drops a heading whose rows this omp lacks", () => {
		const html = renderToStaticMarkup(withData([entry({ path: "compaction.enabled" })], {}, <GeneralSection />));
		expect(html).toContain(`>${translate("settings.general.context")}</h3>`);
		expect(html).toContain('id="setting-compaction.enabled"');
		expect(html).not.toContain(translate("settings.general.messages"));
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

	it("routes curated rows to their section and every schema entry to Advanced", () => {
		const results = search("compaction.enabled");
		expect(results.find(result => result.key === "curated:compaction.enabled")).toMatchObject({
			target: "general",
			rowId: "setting-compaction.enabled",
		});
		expect(results.find(result => result.key === "schema:compaction.enabled")).toMatchObject({
			target: "advanced:context",
		});
		expect(search("mystery")[0]).toMatchObject({ target: "advanced:other", rowId: "setting-mystery.flag" });
	});

	it("finds renderer preferences and sections in any UI language, title prefix first", () => {
		expect(search("테마")[0]).toMatchObject({ target: "appearance" });
		expect(search("proxy").some(result => result.target === "advanced:launch")).toBe(true);
		expect(search("mcp").some(result => result.key === "section:extensions")).toBe(true);
		expect(search("")).toEqual([]);
	});
});
