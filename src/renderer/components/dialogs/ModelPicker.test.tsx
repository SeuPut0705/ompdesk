import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
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
const setModelRole = vi.fn(async () => ok({}));
const setThinkingLevel = vi.fn(async (level: string) => ok({ thinkingLevel: level, thinkingConfigured: level }));
Reflect.set(window, "omp", {
	rpc: {
		getLoginProviders: vi.fn(async () => ok({ providers: [] })),
		getRecentModels: vi.fn(async () => ok(recent)),
		getSettings: vi.fn(async () => ok({ values: {} })),
		setModel,
		setModelRole,
		setThinkingLevel,
	},
	events: { onConfigUpdate: vi.fn(() => () => {}) },
});

// Loaded after the linkedom globals exist: react-dom reads `window`/`document` at import.
const { createRoot } = await import("react-dom/client");
const { ModelPicker } = await import("./ModelPicker");

const MODELS = [
	{ provider: "anthropic", id: "claude", name: "Claude", description: "Careful writer" },
	{ provider: "openai", id: "gpt-5", name: "GPT-5" },
	{ provider: "openai", id: "gpt-mini", name: "GPT mini" },
] as ModelInfo[];

let container: HTMLElement;
let root: Root;

async function mount(models: ModelInfo[] = MODELS): Promise<void> {
	useSessionStore.setState({ status: "ready" });
	useModelStore.setState({
		availableModels: models,
		refreshAvailableModels: async () => ({
			models,
			discoveryStates: [],
			refreshPending: false,
			generation: 1,
		}),
	});
	useUiStore.setState({ modelPickerOpen: true });
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
	setModelRole.mockClear();
	useModelStore.getState().reset();
	useSessionStore.getState().reset();
	useUiStore.setState({ modelPickerOpen: false });
});

describe("ModelPicker while a fallback answers", () => {
	it("checks the person's model, never the stand-in that answers", async () => {
		useModelStore.setState({ model: MODELS[1], chosenModel: MODELS[0] });
		await mount();
		const checked = Array.from(document.querySelectorAll('[data-model-group] [role="option"]'))
			.filter(option => option.querySelector(`[aria-label="${translate("modelPicker.current")}"]`))
			.map(option => String(option.textContent));
		expect(checked.length).toBeGreaterThan(0);
		expect(checked.every(text => text.includes("Claude") && !text.includes("GPT-5"))).toBe(true);
	});
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

describe("ModelPicker pick", () => {
	// The owner's rule (14 Nov 2026): switching one session's model never changes the default model new sessions open
	// on; only Settings › Models & accounts › Model roles writes `modelRoles.default`.
	it("switches this session only and writes no model role", async () => {
		await mount();
		// A rendered option row (linkedom's element, typed as the DOM's).
		const option = document.querySelector('[data-model-group="openai"] [role="option"]') as unknown as HTMLElement;
		await act(async () => option.click());
		expect(setModel).toHaveBeenCalledWith("openai", "gpt-5");
		expect(setModelRole).not.toHaveBeenCalled();
	});
});

describe("ModelPicker compact layout", () => {
	it("renders one-line rows: provider mark and name, secondary info off the row", async () => {
		await mount();
		const option = document.querySelector('[data-model-group="openai"] [role="option"]') as unknown as HTMLElement;
		expect(option.querySelector("[data-provider-mark]")).not.toBeNull();
		expect(option.textContent).toBe("GPT-5");
		// No second line: the option holds the mark and one label span only.
		expect(option.querySelectorAll("span").length).toBeLessThanOrEqual(3);
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

describe("ModelPicker highlighted row's details", () => {
	it("says the highlighted model's facts as the field's description, following the arrow keys", async () => {
		await mount();
		const input = document.querySelector("input") as unknown as HTMLInputElement;
		const detail = () => {
			const id = input.getAttribute("aria-describedby");
			return id ? document.getElementById(id)?.textContent : undefined;
		};
		expect(detail()).toContain("GPT-5");
		const record = input as unknown as Record<string, unknown>;
		const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
		const props = record[propsKey ?? ""] as { onKeyDown(event: object): void };
		await act(async () =>
			props.onKeyDown({ key: "ArrowDown", preventDefault() {}, nativeEvent: { isComposing: false, keyCode: 40 } }),
		);
		expect(detail()).toContain("Careful writer");
	});
});

describe("ModelPicker thinking row", () => {
	const radios = () => Array.from(document.querySelectorAll("[data-model-picker-thinking] [role=radio]"));

	it("offers the segmented effort row for a model that reasons: model and effort in one place", async () => {
		useModelStore.setState({
			availableThinkingLevels: ["low", "medium", "high"],
			thinkingLevel: "medium",
			thinkingConfigured: "medium",
		});
		await mount();
		expect(radios().map(radio => radio.textContent)).toEqual(["Off", "Auto", "Low", "Medium", "High"]);
		const checked = radios().filter(radio => radio.getAttribute("aria-checked") === "true");
		expect(checked.map(radio => radio.textContent)).toEqual(["Medium"]);

		await act(async () => (radios()[4] as unknown as { click(): void }).click());
		expect(setThinkingLevel).toHaveBeenCalledWith("high");
		expect(useModelStore.getState().thinkingConfigured).toBe("high");
		// The effort pick is not a model pick: the dialog stays and no model switched.
		expect(setModel).not.toHaveBeenCalled();
	});

	it("leaves the row out for a model that does not reason", async () => {
		useModelStore.setState({ availableThinkingLevels: [] });
		await mount();
		expect(document.querySelector("[data-model-picker-thinking]")).toBeNull();
	});
});

describe("ModelPicker OpenRouter group", () => {
	const routerModels: ModelInfo[] = [
		{ provider: "openrouter", id: "unknown-a", name: "Unknown A" },
		{ provider: "openrouter", id: "old", name: "Old", releasedAt: 100 },
		{ provider: "openrouter", id: "new-a", name: "New A", releasedAt: 200 },
		{ provider: "openrouter", id: "unknown-b", name: "Unknown B", releasedAt: NaN },
		{ provider: "openrouter", id: "new-b", name: "New B", releasedAt: 200 },
	];
	const disclosure = () =>
		document.querySelector('[data-model-group="openrouter"] button[aria-expanded]') as unknown as HTMLElement;
	const inputProps = () => {
		const input = document.querySelector("input") as unknown as HTMLInputElement;
		const record = input as unknown as Record<string, unknown>;
		const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$")) ?? "";
		return { input, props: record[key] as { onChange(event: object): void; onKeyDown(event: object): void } };
	};
	const key = async (name: string) => {
		await act(async () =>
			inputProps().props.onKeyDown({
				key: name,
				preventDefault() {},
				nativeEvent: { isComposing: false, keyCode: name === "Enter" ? 13 : 40 },
			}),
		);
	};

	it("folds initially, sorts only OpenRouter, and resets on reopening", async () => {
		recent = { selectors: [] };
		await mount([...MODELS, ...routerModels]);
		expect(disclosure().getAttribute("aria-expanded")).toBe("false");
		expect(disclosure().textContent).toContain("5");
		expect(rows("openrouter")).toEqual([]);
		await act(async () => disclosure().click());
		expect(disclosure().getAttribute("aria-expanded")).toBe("true");
		expect(rows("openrouter")).toEqual(["New A", "New B", "Old", "Unknown A", "Unknown B"]);
		expect(rows("openai")).toEqual(["GPT-5", "GPT mini"]);
		await act(async () => disclosure().click());
		expect(rows("openrouter")).toEqual([]);
		await act(async () => disclosure().click());
		await act(async () => useUiStore.setState({ modelPickerOpen: false }));
		await act(async () => useUiStore.setState({ modelPickerOpen: true }));
		expect(disclosure().getAttribute("aria-expanded")).toBe("false");
		expect(rows("openrouter")).toEqual([]);
	});

	it("reveals search results and Enter switches only this session", async () => {
		await mount([...MODELS, ...routerModels]);
		const { input, props } = inputProps();
		input.value = "new b";
		await act(async () => props.onChange({ target: input, currentTarget: input }));
		expect(disclosure()).toBeNull();
		expect(rows("openrouter")).toEqual(["New B"]);
		await key("Enter");
		expect(setModel).toHaveBeenCalledWith("openrouter", "new-b");
		expect(setModelRole).not.toHaveBeenCalled();
	});

	it("restores the previous fold state when search is cleared", async () => {
		await mount([...MODELS, ...routerModels]);
		const search = async (value: string) => {
			const { input, props } = inputProps();
			input.value = value;
			await act(async () => props.onChange({ target: input, currentTarget: input }));
		};
		await search("new");
		expect(rows("openrouter")).toEqual(["New A", "New B"]);
		await search("");
		expect(disclosure().getAttribute("aria-expanded")).toBe("false");
		expect(rows("openrouter")).toEqual([]);
		await act(async () => disclosure().click());
		await search("new");
		await search("");
		expect(disclosure().getAttribute("aria-expanded")).toBe("true");
		expect(rows("openrouter")).toHaveLength(5);
	});

	it("leaves Enter and arrows to an active IME composition", async () => {
		await mount([...MODELS, ...routerModels]);
		const { input, props } = inputProps();
		input.value = "new b";
		await act(async () => props.onChange({ target: input, currentTarget: input }));
		const active = input.getAttribute("aria-activedescendant");
		for (const name of ["ArrowDown", "Enter"]) {
			await act(async () =>
				inputProps().props.onKeyDown({
					key: name,
					preventDefault() {
						throw new Error("IME key was intercepted");
					},
					nativeEvent: { isComposing: true },
				}),
			);
		}
		expect(input.getAttribute("aria-activedescendant")).toBe(active);
		expect(setModel).not.toHaveBeenCalled();
		expect(setModelRole).not.toHaveBeenCalled();
	});

	it("keeps current and recent rows selectable while arrows skip folded rows", async () => {
		recent = { selectors: ["openrouter/old"] };
		useModelStore.setState({ chosenModel: routerModels[2], model: routerModels[2] });
		await mount([...MODELS, ...routerModels]);
		expect(groupNames()[0]).toBe(translate("modelPicker.current"));
		expect(rows("current")).toEqual(["New A"]);
		expect(rows("recent")).toEqual(["Old"]);
		expect(rows("openrouter")).toEqual([]);
		await key("ArrowDown");
		await key("Enter");
		expect(setModel).toHaveBeenCalledWith("openrouter", "old");
		expect(setModelRole).not.toHaveBeenCalled();
	});

	it("keeps arrow navigation within visible rows when the provider is folded", async () => {
		recent = { selectors: [] };
		await mount([...MODELS, ...routerModels]);
		const visible = Array.from(document.querySelectorAll('[role="option"]'));
		for (let i = 0; i < 10; i++) await key("ArrowDown");
		expect(inputProps().input.getAttribute("aria-activedescendant")).toBe(visible.at(-1)?.getAttribute("id"));
		expect(visible).toHaveLength(MODELS.length);
	});

	it("allows picking the current OpenRouter model while folded", async () => {
		useModelStore.setState({ chosenModel: routerModels[2], model: routerModels[2] });
		await mount([...MODELS, ...routerModels]);
		const option = document.querySelector('[data-model-group="current"] [role="option"]') as unknown as HTMLElement;
		await act(async () => option.click());
		expect(setModel).toHaveBeenCalledWith("openrouter", "new-a");
		expect(setModelRole).not.toHaveBeenCalled();
	});

	it("does not add Current for an unavailable OpenRouter model", async () => {
		useModelStore.setState({ chosenModel: routerModels[2], model: routerModels[2] });
		await mount(MODELS);
		expect(groupNames()).not.toContain(translate("modelPicker.current"));
	});
});
