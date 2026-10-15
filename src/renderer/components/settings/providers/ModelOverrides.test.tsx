/**
 * B43: Settings › Models & providers › Model overrides lists models.yml
 * `modelOverrides` of every provider (built-in ones included), writes a new
 * one for a picked model with its levels and wire values, and Reset removes it.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomProviderView, ModelOverrideInput } from "../../../../shared/ipc-types";
import type { ModelInfo } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useModelStore } from "../../../stores/model";
import { ModelOverrides } from "./ModelOverrides";
import type { ProviderCatalog } from "./ProviderList";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const setModelOverride = vi.fn(
	async (_provider: string, _modelId: string, _override: ModelOverrideInput | null, _device?: string) => {},
);
Object.assign(window as unknown as Record<string, unknown>, { omp: { models: { setModelOverride } } });

const ANTHROPIC: CustomProviderView = {
	id: "anthropic",
	api: "anthropic-messages",
	baseUrl: "",
	hasApiKey: false,
	models: [],
	builtin: true,
	modelOverrides: { "claude-x": { contextWindow: 64_000, replayReasoning: true } },
};

const load = vi.fn(async () => undefined);
const catalog: ProviderCatalog = {
	providers: [],
	customConfigs: [ANTHROPIC],
	options: {
		apis: ["anthropic-messages", "openai-completions"],
		auth: [],
		discovery: [],
		thinkingModes: ["effort", "budget"],
		efforts: ["low", "medium", "high"],
	},
	loading: false,
	error: null,
	configError: null,
	refreshPending: false,
	sidecarReady: true,
	load,
};

const MODELS: ModelInfo[] = [
	{ provider: "anthropic", id: "claude-x", contextWindow: 64_000 },
	{ provider: "openai", id: "gpt-y", contextWindow: 128_000, maxTokens: 16_000 },
];

let root: Root | null = null;

async function flush(): Promise<void> {
	for (let i = 0; i < 4; i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

async function mount(): Promise<void> {
	useModelStore.setState({ availableModels: MODELS, refreshProviders: vi.fn(async () => ({})) as never });
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<ModelOverrides catalog={catalog} />
			</I18nProvider>,
		);
	});
}

function button(label: string): HTMLButtonElement | undefined {
	return (Array.from(document.body.querySelectorAll("button")) as HTMLButtonElement[]).find(
		candidate => candidate.getAttribute("aria-label") === label || (candidate.textContent ?? "").trim() === label,
	);
}

/** linkedom never fires React's change event (and its select value is read-only): call the control's own onChange. */
function change(element: Element | null | undefined, value?: string): void {
	if (!element) throw new Error("control not found");
	const record = element as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void }) : undefined;
	const target = value === undefined ? element : { value };
	props?.onChange?.({ target, currentTarget: target });
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	setModelOverride.mockClear();
	useModelStore.getState().reset();
});

describe("ModelOverrides", () => {
	it("lists a built-in model's override and resets it", async () => {
		await mount();
		const row = document.body.querySelector('[data-model-override="anthropic/claude-x"]');
		expect(row?.textContent).toContain(translate("modelOverrides.summary.replayOn"));
		expect(row?.textContent).toContain("64");

		await act(async () => button(translate("modelOverrides.resetLabel", { model: "anthropic/claude-x" }))?.click());
		await act(async () => button(translate("modelOverrides.resetConfirm"))?.click());
		await flush();
		expect(setModelOverride).toHaveBeenCalledWith("anthropic", "claude-x", null, undefined);
	});

	it("overrides a picked model's context window, levels and their wire values", async () => {
		await mount();
		await act(async () => button(translate("modelOverrides.add"))?.click());
		await act(async () => change(document.body.querySelector("select[data-model-override-model]"), "openai/gpt-y"));
		const context = document.body.querySelector("input[data-model-override-context]");
		await act(async () => change(context, "200000"));
		await act(async () => change(document.body.querySelector("select[data-model-override-mode]"), "effort"));
		await act(async () => change(document.body.querySelector('[data-model-override-effort="high"]')));
		await act(async () => change(document.body.querySelector('[data-model-override-effort="low"]')));
		const wire = document.body.querySelector(
			`input[aria-label="${translate("modelOverrides.wireValue", { level: "high" })}"]`,
		);
		await act(async () => change(wire, "max"));

		await act(async () =>
			(document.body.querySelector("[data-model-override-save]") as HTMLButtonElement | null)?.click(),
		);
		await flush();
		expect(setModelOverride).toHaveBeenCalledWith(
			"openai",
			"gpt-y",
			{ contextWindow: 200_000, thinking: { mode: "effort", efforts: ["low", "high"], effortMap: { high: "max" } } },
			undefined,
		);
	});

	it("refuses a token count that is not a whole number", async () => {
		await mount();
		await act(async () => button(translate("modelOverrides.edit", { model: "anthropic/claude-x" }))?.click());
		await act(async () => change(document.body.querySelector("input[data-model-override-context]"), "64k"));
		await act(async () =>
			(document.body.querySelector("[data-model-override-save]") as HTMLButtonElement | null)?.click(),
		);
		expect(document.body.textContent).toContain(translate("modelOverrides.problem.number"));
		expect(setModelOverride).not.toHaveBeenCalled();
	});
});
