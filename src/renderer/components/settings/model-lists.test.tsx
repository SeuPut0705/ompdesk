/**
 * Every model list (Settings' fetched pickers, a role's picker, the composer's model picker) keeps a provider's
 * models together under that provider's name, providers in one order. Stock lists models in catalog order, where a
 * model a provider discovers later is appended after every other provider's (model-registry `#mergeResolvedModels`):
 * listed as given, a subscription's models and OpenRouter's, each beside a mark and a compact name, interleave.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo, ProviderInfo, ProvidersResult, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};

/** Stock's catalog order: each provider's bundled models, then the models Anthropic and Codex discovered later. */
const CATALOG = [
	{ provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
	{ provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4" },
	{ provider: "openrouter", id: "anthropic/claude-opus-4.7", name: "Claude Opus 4.7" },
	{ provider: "openrouter", id: "openai/gpt-5.4", name: "GPT-5.4" },
	{ provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
	{ provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" },
] as ModelInfo[];

const provider = (id: string, name: string): ProviderInfo => ({
	id,
	name,
	authenticated: true,
	loginAvailable: true,
	disabled: false,
	modelCount: 2,
});
const PROVIDERS = [
	provider("openrouter", "OpenRouter"),
	provider("anthropic", "Anthropic"),
	provider("openai-codex", "OpenAI Codex"),
];

/** Under its provider's header, each model reads as its mark and compact name. */
const GROUPED = [
	["Anthropic", ["Opus 4.7", "Opus 5"]],
	["OpenAI Codex", ["GPT-5.4", "GPT-5.5"]],
	["OpenRouter", ["Claude Opus 4.7", "GPT-5.4"]],
];

const ok = (data: unknown): RpcResponse => ({ type: "response", command: "x", success: true, data });
const catalog: ProvidersResult = {
	providers: PROVIDERS,
	models: CATALOG,
	discoveryStates: [],
	refreshPending: false,
	generation: 1,
};
Reflect.set(window, "omp", {
	rpc: {
		command: vi.fn(async () => ok(catalog)),
		getModelRoles: vi.fn(async () =>
			ok({
				roles: [
					{
						id: "default",
						name: "Default",
						section: "chat",
						source: "default",
						candidates: CATALOG.map(model => ({ ...model, kind: "chat" })),
					},
				],
			}),
		),
		setModelRole: vi.fn(async () => ok({})),
		getLoginProviders: vi.fn(async () => ok({ providers: [] })),
		getRecentModels: vi.fn(async () => ok({ selectors: [] })),
		getModelReleaseDates: vi.fn(async () => ok({ dates: {} })),
		getSettings: vi.fn(async () => ok({ values: {} })),
	},
	events: { onConfigUpdate: () => () => {} },
});

// Loaded after the linkedom globals exist: react-dom reads `window`/`document` at import.
const { createRoot } = await import("react-dom/client");
const { ModelValueSelect } = await import("./ModelValueSelect");
const { ModelRolesSection } = await import("./ModelRolesSection");
const { ModelPicker } = await import("../dialogs/ModelPicker");

let root: Root | null = null;

async function mount(element: ReactElement): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(<I18nProvider>{element}</I18nProvider>));
	await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
}

async function click(button: Element | null | undefined): Promise<void> {
	expect(button).toBeTruthy();
	await act(async () => (button as unknown as { click(): void }).click());
	await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
}

/** Each group's header and the text of its rows, in the order shown. */
function shownGroups(): [string, string[]][] {
	return [...document.body.querySelectorAll('[role="listbox"] [role="group"]')].map(group => [
		String(group.getAttribute("aria-label")),
		[...group.querySelectorAll('[role="option"]')].map(row => (row.textContent ?? "").trim()),
	]);
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useModelStore.getState().reset();
	useSessionStore.getState().reset();
	useUiStore.setState({ modelPickerOpen: false });
});

describe("every model list groups models by provider", () => {
	it("a model setting's picker", async () => {
		await mount(<ModelValueSelect kind="model" onCommit={() => {}} value="" />);
		await click(document.body.querySelector('button[aria-haspopup="listbox"]'));
		expect(shownGroups()).toEqual(GROUPED);
	});

	it("a model role's picker", async () => {
		useModelStore.setState({ providers: PROVIDERS });
		useSessionStore.getState().setStatus("ready", "/repo");
		await mount(<ModelRolesSection />);
		await click(document.body.querySelector('button[aria-label="Model for Default"]'));
		expect(shownGroups()).toEqual(GROUPED);
	});

	it("the composer's model picker", async () => {
		useSessionStore.setState({ status: "ready" });
		useModelStore.setState({ availableModels: CATALOG, providers: PROVIDERS });
		useUiStore.setState({ modelPickerOpen: true });
		await mount(<ModelPicker />);
		expect(shownGroups()).toEqual([...GROUPED.slice(0, 2), ["OpenRouter", []]]);
		await click(document.body.querySelector('[data-model-group="openrouter"] button[aria-expanded="false"]'));
		expect(shownGroups()).toEqual(GROUPED);
	});
});
