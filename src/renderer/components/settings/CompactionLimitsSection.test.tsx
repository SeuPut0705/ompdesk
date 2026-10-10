/**
 * Settings › Models & providers › Compaction limits: renders only when the live
 * schema has `compaction.modelThresholds` (omp 18.8.5+), lists each limit with
 * where the model compacts, adds and removes entries by writing the global
 * layer through set_setting (never copying a project entry into it), and
 * refuses input stock would reject before writing.
 * linkedom harness per AGENTS.md; stores reset in afterEach (never mock.module).
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AvailableModelsResult, SettingEntry, SettingsSchemaResult } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useToastStore } from "../../stores/toast";
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

const { createRoot } = await import("react-dom/client");
const { CompactionLimitsSection } = await import("./CompactionLimitsSection");

const PATH = "compaction.modelThresholds";

interface TestElement {
	value: string;
}

let root: Root | undefined;

function entry(value: Record<string, unknown>, globalValue: Record<string, unknown> | undefined): SettingEntry {
	return {
		path: PATH,
		type: "record",
		value,
		default: {},
		advanced: true,
		provenance: globalValue
			? { layers: ["global", "project"], globalValue, globalPath: "/agent/config.yml" }
			: { layers: [] },
	};
}

function settingsData(entries: SettingEntry[], onCommitted = vi.fn()): SettingsData {
	const schema: SettingsSchemaResult = { entries, tabs: [] };
	return {
		schema,
		values: Object.fromEntries(entries.map(item => [item.path, item.value])),
		loadState: "ready",
		loadError: null,
		sidecarReady: true,
		sidecarBusy: false,
		advisorActive: undefined,
		onCommitted,
		retry: () => {},
	};
}

function installRpc(setResult: unknown = { path: PATH, value: {}, savedValue: {} }) {
	const rpc = {
		compactionLimits: vi.fn(async (params: { values?: Record<string, unknown>; key?: string; input?: string }) => {
			if (params.input !== undefined) {
				const text = params.input.trim();
				const value = ({ "120k": 120_000, "90k": 90_000, "75%": "75%" } as Record<string, number | string>)[text];
				const data = !params.key
					? { ok: false, modelError: "empty" }
					: params.key === "openai*x"
						? { ok: false, modelError: "star" }
						: params.key === "mistral-large"
							? { ok: false, modelError: "shape" }
							: value === undefined
								? { ok: false, limitError: text === "150%" ? "percent" : "invalid" }
								: { ok: true, value };
				return { success: true, data };
			}
			return {
				success: true,
				data: {
					rows: Object.entries(params.values ?? {})
						.filter(([, value]) => value !== null)
						.map(([key, value]) => ({
							key,
							value,
							text: value === 120_000 ? "120k" : value === 90_000 ? "90k" : String(value),
						})),
				},
			};
		}),
		setSetting: vi.fn(async (_path: string, _value: unknown) => ({ success: true, data: setResult })),
		getSettings: vi.fn(async () => ({ success: true, data: { values: { [PATH]: {} } } })),
		getCompactionPoints: vi.fn(async () => ({
			success: true,
			data: {
				models: [
					{
						selector: "openai/gpt-5",
						point: { tokens: 120_000, source: "openai/gpt-5", draft: "120k" },
					},
				],
				roles: [],
			},
		})),
	};
	(window as unknown as { omp?: unknown }).omp = { rpc, events: { onConfigUpdate: () => () => {} } };
	return rpc;
}

async function mount(data: SettingsData): Promise<void> {
	useSessionStore.getState().setStatus("ready", "/repo");
	root = createRoot(document.body as unknown as Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<SettingsDataProvider value={data}>
					<CompactionLimitsSection />
				</SettingsDataProvider>
			</I18nProvider>,
		);
	});
	await act(async () => {});
}

function buttons(): HTMLButtonElement[] {
	return [...document.body.querySelectorAll("button")] as unknown as HTMLButtonElement[];
}

function button(match: (button: HTMLButtonElement) => boolean): HTMLButtonElement {
	const found = buttons().find(match);
	expect(found).toBeDefined();
	return found as HTMLButtonElement;
}

const byText = (text: string) => (candidate: HTMLButtonElement) => (candidate.textContent ?? "").trim() === text;
const byLabel = (label: string) => (candidate: HTMLButtonElement) => candidate.getAttribute("aria-label") === label;

async function typeInto(element: TestElement, value: string): Promise<void> {
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
	descriptor?.set?.call(element, value);
	const record = element as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void } | undefined) : undefined;
	await act(async () => props?.onChange?.({ target: element, currentTarget: element }));
}

function limitInput(): TestElement {
	const input = document.body.querySelector(`input[aria-label="${translate("compactionLimits.limit")}"]`);
	expect(input).not.toBeNull();
	return input as unknown as TestElement;
}

async function pickModel(selector: string): Promise<void> {
	useModelStore.setState({
		refreshAvailableModels: async (): Promise<AvailableModelsResult> => ({
			models: [
				{ provider: "openai", id: "gpt-5", name: "GPT-5" },
				{ provider: "anthropic", id: "claude", name: "Claude" },
			],
			discoveryStates: [],
			refreshPending: false,
			generation: 1,
		}),
	});
	await act(async () => button(byLabel(translate("compactionLimits.model"))).click());
	await act(async () => {});
	const option = [...document.body.querySelectorAll('[role="option"]')].find(row =>
		(row.textContent ?? "").includes(selector),
	);
	expect(option).toBeDefined();
	await act(async () => option?.dispatchEvent(new Event("click", { bubbles: true })));
}

async function typeCustomModel(text: string): Promise<void> {
	await act(async () => button(byLabel(translate("compactionLimits.model"))).click());
	await act(async () => {});
	const search = document.body.querySelector('[role="listbox"]')?.parentElement?.querySelector("input");
	expect(search).toBeDefined();
	await typeInto(search as unknown as TestElement, text);
	await act(async () => button(candidate => (candidate.textContent ?? "").includes(text)).click());
}

function bodyText(): string {
	return document.body.textContent ?? "";
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	delete (window as unknown as { omp?: unknown }).omp;
	useSessionStore.getState().reset();
	useModelStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	vi.restoreAllMocks();
});

describe("CompactionLimitsSection", () => {
	it("renders nothing on an omp whose live schema lacks compaction.modelThresholds", async () => {
		const rpc = installRpc();
		await mount(settingsData([]));

		expect(document.body.querySelector("#settings-models-compaction-limits")).toBeNull();
		expect(rpc.getCompactionPoints).not.toHaveBeenCalled();
	});

	it("lists each limit with where the model compacts, and keeps a project entry read-only", async () => {
		installRpc();
		await mount(
			settingsData([
				entry(
					{ "openai/gpt-5": 120_000, "anthropic/*": "80%", "deepseek/chat": 50_000 },
					{
						"openai/gpt-5": 120_000,
						"anthropic/*": "80%",
					},
				),
			]),
		);

		expect(document.body.querySelector("h3")?.textContent).toBe(translate("compactionLimits.title"));
		expect(document.body.querySelector("#compaction-limit-openai\\/gpt-5")?.textContent).toContain("120k");
		expect(document.body.querySelector("#compaction-limit-anthropic\\/\\*")?.textContent).toContain("80%");
		const facts = [...document.body.querySelectorAll("[data-compacts-at]")].map(node => node.textContent);
		expect(facts).toEqual(["Compacts at 120.0k · openai/gpt-5"]);
		// The project-only entry has no remove control and says where to edit it.
		expect(buttons().some(byLabel(translate("compactionLimits.remove", { model: "deepseek/chat" })))).toBe(false);
		expect(document.body.querySelector("#compaction-limit-deepseek\\/chat")?.textContent).toContain(
			translate("compactionLimits.otherLayer"),
		);
	});

	it("adds a picked model's token limit to the global layer only", async () => {
		const rpc = installRpc({ path: PATH, value: { "anthropic/*": "80%", "openai/gpt-5": 120_000 } });
		const onCommitted = vi.fn();
		await mount(
			settingsData(
				[entry({ "anthropic/*": "80%", "deepseek/chat": 50_000 }, { "anthropic/*": "80%" })],
				onCommitted,
			),
		);

		await pickModel("openai/gpt-5");
		await typeInto(limitInput(), "120k");
		await act(async () => button(byText(translate("compactionLimits.add"))).click());

		expect(rpc.setSetting).toHaveBeenCalledTimes(1);
		expect(rpc.setSetting).toHaveBeenCalledWith(PATH, { "anthropic/*": "80%", "openai/gpt-5": 120_000 });
		expect(onCommitted).toHaveBeenCalledWith(PATH, { "anthropic/*": "80%", "openai/gpt-5": 120_000 });
		expect(limitInput().value).toBe("");
	});

	it("writes a percentage as stock's string form and accepts a provider prefix", async () => {
		const rpc = installRpc({ path: PATH, value: { "openai/*": "75%" } });
		await mount(settingsData([entry({}, undefined)]));

		await typeCustomModel("openai/*");
		await typeInto(limitInput(), " 75% ");
		await act(async () => button(byText(translate("compactionLimits.add"))).click());

		expect(rpc.setSetting).toHaveBeenCalledWith(PATH, { "openai/*": "75%" });
	});

	it("removes an entry, unsetting the key when it was the last one", async () => {
		const rpc = installRpc({ path: PATH, value: {} });
		await mount(settingsData([entry({ "openai/gpt-5": 120_000 }, { "openai/gpt-5": 120_000 })]));

		await act(async () => button(byLabel(translate("compactionLimits.remove", { model: "openai/gpt-5" }))).click());

		expect(rpc.setSetting).toHaveBeenCalledWith(PATH, undefined);
	});

	it("refuses input stock would reject, before writing", async () => {
		const rpc = installRpc();
		await mount(settingsData([entry({}, undefined)]));
		const add = () => act(async () => button(byText(translate("compactionLimits.add"))).click());

		await typeInto(limitInput(), "90k");
		await add();
		expect(bodyText()).toContain(translate("compactionLimits.err.model.empty"));

		await pickModel("openai/gpt-5");
		for (const [text, error] of [
			["150%", "compactionLimits.err.limit.percent"],
			["0", "compactionLimits.err.limit.invalid"],
			["ninety", "compactionLimits.err.limit.invalid"],
			["", "compactionLimits.err.limit.invalid"],
		] as const) {
			await typeInto(limitInput(), text);
			await add();
			expect(bodyText(), text).toContain(translate(error));
		}

		await typeCustomModel("openai*x");
		await typeInto(limitInput(), "90k");
		await add();
		expect(bodyText()).toContain(translate("compactionLimits.err.model.star"));

		await typeCustomModel("mistral-large");
		await add();
		expect(bodyText()).toContain(translate("compactionLimits.err.model.shape"));

		expect(rpc.setSetting).not.toHaveBeenCalled();
	});

	it("warns when a higher layer keeps the global write from taking effect", async () => {
		// The project config sets the same key; stock's effective value stays the project's.
		installRpc({ path: PATH, value: { "openai/gpt-5": 50_000 } });
		await mount(settingsData([entry({ "openai/gpt-5": 50_000 }, undefined)]));

		await pickModel("openai/gpt-5");
		await typeInto(limitInput(), "90k");
		await act(async () => button(byText(translate("compactionLimits.add"))).click());

		expect(useToastStore.getState().toasts.map(toast => toast.message)).toContain(
			translate("compactionLimits.overridden", { model: "openai/gpt-5" }),
		);
		// The draft stays so the user can see what did not apply.
		expect(limitInput().value).toBe("90k");
	});
});
