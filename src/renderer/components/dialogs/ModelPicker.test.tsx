import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};

const ok = (data: unknown) => ({ type: "response", command: "x", success: true, data });
let recent: unknown = { selectors: ["openai/gpt-5", "gone/model", "anthropic/claude"] };
const setModel = vi.fn(async () => ok({}));
Reflect.set(window, "omp", {
	rpc: {
		getLoginProviders: vi.fn(async () => ok({ providers: [] })),
		getRecentModels: vi.fn(async () => ok(recent)),
		getSettings: vi.fn(async () => ok({ values: {} })),
		setModel,
	},
	events: { onConfigUpdate: vi.fn(() => () => {}) },
});

// Loaded after the linkedom globals exist: react-dom reads `window`/`document` at import.
const { createRoot } = await import("react-dom/client");
const { ModelPicker } = await import("./ModelPicker");

const MODELS = [
	{ provider: "anthropic", id: "claude", name: "Claude" },
	{ provider: "openai", id: "gpt-5", name: "GPT-5" },
	{ provider: "openai", id: "gpt-mini", name: "GPT mini" },
] as ModelInfo[];

let container: HTMLElement;
let root: Root;

async function mount(): Promise<void> {
	useSessionStore.setState({ status: "ready" });
	useModelStore.setState({
		availableModels: MODELS,
		refreshAvailableModels: async () => ({
			models: MODELS,
			discoveryStates: [],
			refreshPending: false,
			generation: 1,
		}),
	});
	useUiStore.setState({ modelPickerOpen: true, modelPickerPurpose: "session" });
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ModelPicker />
			</I18nProvider>,
		);
	});
	await act(async () => {});
}

function groupNames(): string[] {
	return Array.from(document.querySelectorAll("[data-model-group]")).map(group =>
		String(group.getAttribute("aria-label")),
	);
}

function rows(groupId: string): string[] {
	return Array.from(document.querySelectorAll(`[data-model-group="${groupId}"] [role="option"]`)).map(option =>
		String(option.textContent),
	);
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	recent = { selectors: ["openai/gpt-5", "gone/model", "anthropic/claude"] };
	setModel.mockClear();
	useModelStore.getState().reset();
	useSessionStore.getState().reset();
	useUiStore.setState({ modelPickerOpen: false });
});

describe("ModelPicker Recent group", () => {
	it("puts stock's recently used models on top, skipping ones no longer available", async () => {
		await mount();
		expect(groupNames()[0]).toBe("Recent");
		expect(rows("recent")).toEqual([expect.stringContaining("GPT-5"), expect.stringContaining("Claude")]);
		// Each model still sits under its provider too.
		expect(rows("openai")).toHaveLength(2);

		const options = Array.from(document.querySelectorAll('[data-model-group="recent"] [role="option"]'));
		await act(async () => (options[1] as unknown as { click(): void }).click());
		expect(setModel).toHaveBeenCalledWith("anthropic", "claude");
	});

	it("shows no Recent group without a usage history", async () => {
		recent = { selectors: [] };
		await mount();
		expect(groupNames()).not.toContain("Recent");
	});
});

describe("ModelPicker compact layout", () => {
	it("renders one-line rows: provider mark and name, secondary info only in the tooltip", async () => {
		await mount();
		const option = document.querySelector('[data-model-group="openai"] [role="option"]') as unknown as HTMLElement;
		expect(option.querySelector("[data-provider-mark]")).not.toBeNull();
		expect(option.textContent).toBe("GPT-5");
		// No second line: the option holds the mark and one label span only.
		expect(option.querySelectorAll("span").length).toBeLessThanOrEqual(3);
	});

	it("uses the compact picker size and small-caps group headers", async () => {
		await mount();
		expect(document.querySelector(".omp-dialog-size-picker-compact")).not.toBeNull();
		const header = document.querySelector('[data-model-group="recent"] span') as unknown as HTMLElement;
		expect(header.className).toContain("uppercase");
	});

	it("filters while typing and Enter picks the highlighted row", async () => {
		await mount();
		const input = document.querySelector("input") as unknown as HTMLInputElement;
		const record = input as unknown as Record<string, unknown>;
		const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
		const props = record[propsKey ?? ""] as {
			onChange(event: object): void;
			onKeyDown(event: object): void;
		};
		input.value = "mini";
		await act(async () => props.onChange({ target: input, currentTarget: input }));
		expect(groupNames()).toEqual(["openai"]);
		expect(rows("openai")).toEqual(["GPT mini"]);
		const fresh = record[propsKey ?? ""] as typeof props;
		await act(async () =>
			fresh.onKeyDown({ key: "Enter", preventDefault() {}, nativeEvent: { isComposing: false, keyCode: 13 } }),
		);
		expect(setModel).toHaveBeenCalledWith("openai", "gpt-mini");
	});
});
