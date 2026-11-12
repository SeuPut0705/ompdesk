/**
 * Settings › Models & accounts › Fallback models: stock's `retry.fallbackChains` record shown row by row as stock
 * reads it, edited one key of the global layer at a time (every other key written back byte for byte), the "when"
 * choice writing `retry.fallbackOn`, the off state of `retry.modelFallback`, and entries that are signed out or not
 * among the models marked. The precedence copy is pinned to stock in `fallback-chains.test.ts`.
 * linkedom harness per AGENTS.md; stores reset in afterEach (never mock.module).
 */
import { parseHTML } from "linkedom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRoleEntry, ProviderInfo, SettingEntry, SettingProvenance } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { en } from "../../locales/en";
import { ko } from "../../locales/ko";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useToastStore } from "../../stores/toast";
import { asChainRecord, type ChainRecord } from "./fallback-chains";
import { CURATED_SCHEMA_ROWS, schemaSettingsOwner } from "./settings-catalog";
import { type SettingsData, SettingsDataProvider } from "./settings-data";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	requestAnimationFrame: (callback: () => void) => {
		callback();
		return 0;
	},
	IS_REACT_ACT_ENVIRONMENT: true,
});

// Imported after linkedom's globals exist: React DOM reads `document` when it loads.
const { createRoot } = await import("react-dom/client");
const { FallbackModelsSection } = await import("./FallbackModelsSection");

const CHAINS = "retry.fallbackChains";
const ON = "retry.fallbackOn";
const SWITCH = "retry.modelFallback";
const FABLE = "anthropic/claude-fable-5-2";
const OPUS = "anthropic/claude-opus-5-5";
const SOL = "openai-codex/gpt-6.1-sol";
/** The owner's config.yml on 12 Nov 2026. */
const OWNER = { "anthropic/*": [SOL], "openai-codex/*": [FABLE] };

const PROVIDERS: ProviderInfo[] = [
	{
		id: "anthropic",
		name: "Anthropic (Claude Pro/Max)",
		authenticated: true,
		loginAvailable: true,
		disabled: false,
		modelCount: 2,
	},
	{
		id: "openai-codex",
		name: "ChatGPT Plus/Pro (Codex Subscription)",
		authenticated: true,
		loginAvailable: true,
		disabled: false,
		modelCount: 1,
	},
	{
		id: "google-gemini-cli",
		name: "Google Gemini CLI",
		authenticated: false,
		loginAvailable: true,
		disabled: false,
		modelCount: 0,
	},
];
const MODELS = [
	{ provider: "anthropic", id: "claude-fable-5-2", name: "Claude Fable 5.2" },
	{ provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
	{ provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT-6.1 SOL" },
];
const ROLES: ModelRoleEntry[] = [
	{
		id: "default",
		name: "Default",
		section: "chat",
		source: "settings",
		model: FABLE,
		effective: { model: FABLE, source: "configured" },
		candidates: [],
	},
	{
		id: "task",
		name: "Task",
		section: "chat",
		source: "settings",
		model: OPUS,
		effective: { model: OPUS, source: "configured" },
		candidates: [],
	},
	{ id: "web", name: "Web search", section: "kind", source: "default", candidates: [] },
];

let root: Root | undefined;
/** What the fake omp holds per path, read back as stock answers set_setting. */
let stored: Record<string, unknown> = {};

function entry(path: string, value: unknown, provenance?: SettingProvenance): SettingEntry {
	return {
		path,
		type: path === CHAINS ? "record" : path === ON ? "enum" : "boolean",
		value,
		default: path === CHAINS ? {} : path === ON ? "any" : true,
		provenance: provenance ?? (value === undefined ? { layers: [] } : { layers: ["global"], globalValue: value }),
	};
}

function installRpc() {
	const rpc = {
		getModelRoles: vi.fn(async () => ({ success: true, data: { roles: ROLES } })),
		setSetting: vi.fn(async (path: string, value: unknown) => {
			if (value === undefined) delete stored[path];
			else stored[path] = value;
			return {
				success: true,
				data: {
					path,
					value,
					savedValue: value,
					provenance: value === undefined ? { layers: [] } : { layers: ["global"], globalValue: value },
				},
			};
		}),
	};
	(window as unknown as { omp?: unknown }).omp = { rpc, events: { onConfigUpdate: () => () => {} } };
	return rpc;
}

/** The Settings page's data: `onCommitted` updates the values the section reads, as SettingsPage does. */
function Page({ entries }: { entries: SettingEntry[] }) {
	const [values, setValues] = useState<Record<string, unknown>>(() =>
		Object.fromEntries(entries.map(item => [item.path, item.value])),
	);
	const data: SettingsData = {
		schema: { entries, tabs: [] },
		values,
		loadState: "ready",
		loadError: null,
		sidecarReady: true,
		sidecarBusy: false,
		advisorActive: undefined,
		onCommitted: (path, value) => setValues(current => ({ ...current, [path]: value })),
		retry: () => {},
	};
	return (
		<SettingsDataProvider value={data}>
			<FallbackModelsSection />
		</SettingsDataProvider>
	);
}

async function mount(entries: SettingEntry[]): Promise<void> {
	stored = Object.fromEntries(entries.filter(item => item.value !== undefined).map(item => [item.path, item.value]));
	useSessionStore.getState().setStatus("ready", "/repo");
	useModelStore.setState({ providers: PROVIDERS, availableModels: MODELS });
	root = createRoot(document.body as unknown as Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<Page entries={entries} />
			</I18nProvider>,
		);
	});
	await act(async () => {});
}

function owner(chains: Record<string, unknown> = OWNER, extra: SettingEntry[] = []): SettingEntry[] {
	return [entry(CHAINS, chains), entry(ON, "usage-limit"), entry(SWITCH, true), ...extra];
}

/** The button named `label`, inside `scope` (a row: the same model's buttons repeat in every row that lists it). */
function button(label: string, scope: Pick<Element, "querySelectorAll"> = document.body): HTMLButtonElement {
	const found = [...scope.querySelectorAll("button")].find(
		candidate => candidate.getAttribute("aria-label") === label,
	);
	expect(found, label).toBeDefined();
	return found as unknown as HTMLButtonElement;
}

function rowKeys(): string[] {
	return [...document.body.querySelectorAll("[data-fallback-row]")].map(
		row => row.getAttribute("data-fallback-row") ?? "",
	);
}

function row(key: string): Element {
	const found = [...document.body.querySelectorAll("[data-fallback-row]")].find(
		candidate => candidate.getAttribute("data-fallback-row") === key,
	);
	expect(found, key).toBeDefined();
	return found as Element;
}

function entries(key: string): string[] {
	return [...row(key).querySelectorAll("[data-fallback-entry]")].map(
		item => item.getAttribute("data-fallback-entry") ?? "",
	);
}

/** Opens the picker named `label` and picks the model whose tooltip ends in its selector. */
async function pick(label: string, selector: string): Promise<void> {
	await act(async () => button(label).click());
	await act(async () => {});
	const option = [...document.body.querySelectorAll('[role="option"]')].find(candidate =>
		(candidate.getAttribute("title") ?? "").endsWith(` · ${selector}`),
	);
	expect(option, selector).toBeDefined();
	await act(async () => option?.dispatchEvent(new Event("click", { bubbles: true })));
	await act(async () => {});
}

async function press(label: string, key?: string): Promise<void> {
	await act(async () => button(label, key === undefined ? document.body : row(key)).click());
	await act(async () => {});
}

/** The record the last write left in the fake omp. */
const written = () => asChainRecord(stored[CHAINS]);

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	delete (window as unknown as { omp?: unknown }).omp;
	useSessionStore.getState().reset();
	useModelStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	vi.restoreAllMocks();
});

describe("FallbackModelsSection", () => {
	it("renders nothing on an omp whose live schema lacks retry.fallbackChains", async () => {
		installRpc();
		await mount([entry(ON, "any")]);
		expect(document.body.querySelector("#settings-models-fallback")).toBeNull();
	});

	it("shows the owner's record as its two rows, each naming the models it applies to now", async () => {
		installRpc();
		await mount(owner());
		expect(rowKeys()).toEqual(["anthropic/*", "openai-codex/*"]);
		expect(row("anthropic/*").textContent).toContain(translate("fallback.key.provider", { provider: "Claude" }));
		expect(row("openai-codex/*").textContent).toContain(translate("fallback.key.provider", { provider: "ChatGPT" }));
		expect(entries("anthropic/*")).toEqual([SOL]);
		expect(entries("openai-codex/*")).toEqual([FABLE]);
		expect(row("anthropic/*").querySelector("[data-fallback-entry]")?.textContent).toContain("GPT-6.1 SOL");
		expect(row("anthropic/*").querySelector("[data-fallback-applies]")?.textContent).toBe(
			translate("fallback.appliesTo", { models: "Fable 5.2 (Default), Opus 5.5 (Task)" }),
		);
		expect(row("openai-codex/*").querySelector("[data-fallback-applies]")).toBeNull();
		const usageOnly = document.body.querySelector('[data-fallback-trigger="usage-limit"]');
		expect(usageOnly?.getAttribute("aria-checked")).toBe("true");
		expect(document.body.querySelector("[data-fallback-problem]")).toBeNull();
	});

	it("adds Fable → Opus 5.5 → GPT-6.1 SOL beside the untouched wildcard rows", async () => {
		const rpc = installRpc();
		await mount(owner());

		await pick(translate("fallback.addRow"), FABLE);
		expect(rpc.setSetting).not.toHaveBeenCalled();
		expect(row(FABLE).textContent).toContain(translate("fallback.draft"));

		await pick(translate("fallback.addEntryFor", { row: "Fable 5.2" }), OPUS);
		expect(JSON.stringify(written())).toBe(JSON.stringify({ ...OWNER, [FABLE]: [OPUS] }));
		await pick(translate("fallback.addEntryFor", { row: "Fable 5.2" }), SOL);
		expect(JSON.stringify(written())).toBe(JSON.stringify({ ...OWNER, [FABLE]: [OPUS, SOL] }));

		expect(rowKeys()).toEqual(["anthropic/*", "openai-codex/*", FABLE]);
		expect(entries(FABLE)).toEqual([OPUS, SOL]);
		// Fable now walks its own row; the Claude row keeps Opus and says Fable left it.
		expect(row(FABLE).querySelector("[data-fallback-applies]")?.textContent).toBe(
			translate("fallback.appliesTo", { models: "Fable 5.2 (Default)" }),
		);
		expect(row("anthropic/*").querySelector("[data-fallback-applies]")?.textContent).toBe(
			translate("fallback.appliesTo", { models: "Opus 5.5 (Task)" }),
		);
		expect(row("anthropic/*").querySelector(`[data-fallback-follows="${FABLE}"]`)?.textContent).toBe(
			translate("fallback.followsOwn", { model: "Fable 5.2" }),
		);
	});

	it("reorders and removes, writing every key it does not edit back byte for byte", async () => {
		installRpc();
		const record = {
			"openrouter/google/*": ["google/*", `${OPUS}:low`],
			...OWNER,
			[FABLE]: [OPUS, SOL],
			odd: { keep: [1, null] },
		};
		const untouched = (after: ChainRecord) => {
			const { [FABLE]: _edited, ...rest } = after;
			const { [FABLE]: _before, ...expected } = record;
			return JSON.stringify(rest) === JSON.stringify(expected);
		};
		await mount(owner(record));
		expect(rowKeys()).toEqual(["openrouter/google/*", "anthropic/*", "openai-codex/*", FABLE, "odd"]);
		expect(row("openrouter/google/*").textContent).toContain("openrouter/google/*");
		expect(entries("openrouter/google/*")).toEqual(["google/*", `${OPUS}:low`]);
		expect(row("odd").textContent).toContain(translate("fallback.unreadable"));

		await press(translate("fallback.moveUp", { model: "GPT-6.1 SOL" }), FABLE);
		expect(written()[FABLE]).toEqual([SOL, OPUS]);
		expect(untouched(written())).toBe(true);

		await press(translate("fallback.removeEntry", { model: "Opus 5.5" }), FABLE);
		expect(written()[FABLE]).toEqual([SOL]);
		expect(untouched(written())).toBe(true);
		expect(Object.keys(written())).toEqual(Object.keys(record));

		await press(translate("fallback.removeRow", { row: "Fable 5.2" }));
		expect(JSON.stringify(written())).toBe(
			JSON.stringify({ "openrouter/google/*": record["openrouter/google/*"], ...OWNER, odd: record.odd }),
		);
		expect(rowKeys()).toEqual(["openrouter/google/*", "anthropic/*", "openai-codex/*", "odd"]);
	});

	it("never copies a key a project config sets into the global layer, and shows where it comes from", async () => {
		installRpc();
		const project = { task: [SOL] };
		await mount([
			entry(CHAINS, { ...OWNER, ...project }, { layers: ["global", "project"], globalValue: OWNER }),
			entry(ON, "usage-limit"),
			entry(SWITCH, true),
		]);
		expect(row("task").textContent).toContain(translate("fallback.key.role", { role: "Task" }));
		expect(row("task").querySelector("[data-fallback-source]")?.textContent).toBe(
			translate("fallback.otherLayer", { source: translate("settings.source.project") }),
		);
		expect(row("task").querySelector("[data-fallback-actions]")).toBeNull();
		await press(translate("fallback.removeEntry", { model: "GPT-6.1 SOL" }), "anthropic/*");
		expect(written()).toEqual({ ...OWNER, "anthropic/*": [] });
	});

	it("writes the choice of when to switch to retry.fallbackOn", async () => {
		const rpc = installRpc();
		await mount(owner());
		const any = document.body.querySelector('[data-fallback-trigger="any"]');
		await act(async () => any?.dispatchEvent(new Event("click", { bubbles: true })));
		await act(async () => {});
		expect(rpc.setSetting).toHaveBeenCalledWith(ON, "any");
		expect(document.body.querySelector('[data-fallback-trigger="any"]')?.getAttribute("aria-checked")).toBe("true");
	});

	it("marks a signed-out model and one that is not among the models, and keeps both", async () => {
		installRpc();
		await mount(owner({ ...OWNER, [OPUS]: ["google-gemini-cli/gemini-3-pro", "acme/model-x"] }));
		expect(entries(OPUS)).toEqual(["google-gemini-cli/gemini-3-pro", "acme/model-x"]);
		const problems = [...row(OPUS).querySelectorAll("[data-fallback-problem]")].map(badge => badge.textContent);
		expect(problems).toEqual([translate("modelRoles.account.signedOut"), translate("fallback.entry.missing")]);
	});

	it("says fallback is off instead of showing rows, and turns it on", async () => {
		const rpc = installRpc();
		await mount([entry(CHAINS, OWNER), entry(ON, "usage-limit"), entry(SWITCH, false)]);
		expect(document.body.querySelector("[data-fallback-rows]")).toBeNull();
		expect(document.body.textContent).toContain(translate("fallback.off"));
		await act(async () => document.body.querySelector<HTMLButtonElement>("[data-fallback-turn-on]")?.click());
		await act(async () => {});
		expect(rpc.setSetting).toHaveBeenCalledWith(SWITCH, true);
		expect(rowKeys()).toEqual(["anthropic/*", "openai-codex/*"]);
	});

	it("says retries are off, keeps the rows (a model with no credential still switches), and turns retries on", async () => {
		const rpc = installRpc();
		await mount(owner(OWNER, [entry("retry.enabled", false)]));
		const notice = document.body.querySelector('[data-inline-notice="warning"]');
		expect(notice?.textContent).toContain(translate("fallback.retryOff"));
		expect(rowKeys()).toEqual(["anthropic/*", "openai-codex/*"]);
		await act(async () => document.body.querySelector<HTMLButtonElement>("[data-fallback-retry-on]")?.click());
		await act(async () => {});
		expect(rpc.setSetting).toHaveBeenCalledWith("retry.enabled", true);
		expect(document.body.querySelector("[data-fallback-retry-on]")).toBeNull();
	});

	it("says nothing about retries while they are on", async () => {
		installRpc();
		await mount(owner(OWNER, [entry("retry.enabled", true)]));
		expect(document.body.textContent).not.toContain(translate("fallback.retryOff"));
	});
});

describe("routing and copy", () => {
	it("owns the three settings in Models & accounts, out of the generic and Agent lists", () => {
		for (const path of [CHAINS, ON, SWITCH]) {
			expect(schemaSettingsOwner({ path, tab: "model", group: "Retry & Fallback" })).toBe("models");
			expect(CURATED_SCHEMA_ROWS[path]).toBeUndefined();
		}
	});

	it("has every fallback string in both languages", () => {
		const keys = (dictionary: Record<string, string>) =>
			Object.keys(dictionary)
				.filter(key => key.startsWith("fallback."))
				.sort();
		expect(keys(ko)).toEqual(keys(en));
		expect(keys(en).length).toBeGreaterThan(30);
	});
});
