/**
 * Tests for the model/provider-referencing setting dropdown: path
 * classification (which string settings become dropdowns), the closed-state
 * trigger contract (current value shown, unset placeholder, listbox
 * semantics), and the open panel's rule that a provider the catalog reports as
 * disabled cannot be chosen.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo, ProvidersResult, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { ModelValueSelect, settingRefKind } from "./ModelValueSelect";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

function provider(id: string, disabled: boolean): ProviderInfo {
	return { id, name: id, authenticated: true, loginAvailable: false, disabled, modelCount: 1 };
}

const command = vi.fn(
	async (): Promise<RpcResponse> => ({
		type: "response",
		command: "get_providers",
		success: true,
		data: {
			providers: [provider("live-one", false), provider("off-one", true)],
			models: [],
			discoveryStates: [],
			refreshPending: false,
			generation: 1,
		} satisfies ProvidersResult,
	}),
);

Object.assign(window as unknown as Record<string, unknown>, { omp: { rpc: { command } } });

function optionRows(): HTMLButtonElement[] {
	return Array.from(document.body.querySelectorAll("button[role='option']")) as HTMLButtonElement[];
}

function rowFor(value: string): HTMLButtonElement {
	const row = optionRows().find(button => (button.textContent ?? "").includes(value));
	expect(row, `no row for ${value}`).toBeDefined();
	return row as HTMLButtonElement;
}

let root: Root | null = null;

/** Mount the dropdown and open its panel, letting the fetch-on-open settle. */
async function openDropdown(
	beforeOpen?: (trigger: HTMLButtonElement) => void,
	select: ReactElement = <ModelValueSelect kind="provider" onCommit={() => {}} value="" />,
): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(<I18nProvider>{select}</I18nProvider>);
	});
	await act(async () => {
		const trigger = container.querySelector("button") as HTMLButtonElement;
		beforeOpen?.(trigger);
		trigger.click();
	});
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0));
	});
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useModelStore.getState().reset();
	command.mockClear();
});

describe("settingRefKind", () => {
	it("classifies the string-typed model settings from the real schema", () => {
		expect(settingRefKind("sharpshooter.model")).toBe("model");
		expect(settingRefKind("mnemopi.llmModel")).toBe("model");
		expect(settingRefKind("mnemopi.embeddingModel")).toBe("model");
	});

	it("matches a bare .model suffix", () => {
		expect(settingRefKind("services.image.model")).toBe("model");
	});

	it("classifies provider id settings", () => {
		expect(settingRefKind("services.searchProvider")).toBe("provider");
	});

	it("leaves unrelated strings and namespaces alone", () => {
		// Plain strings that merely live near models/providers.
		expect(settingRefKind("theme.dark")).toBeNull();
		expect(settingRefKind("stt.language")).toBeNull();
		expect(settingRefKind("searxng.endpoint")).toBeNull();
		expect(settingRefKind("hindsight.bankId")).toBeNull();
		// Plural/nested segments must not match (model.loopGuard.* is a namespace).
		expect(settingRefKind("images.describeForTextModels")).toBeNull();
		expect(settingRefKind("model.loopGuard.enabled")).toBeNull();
		expect(settingRefKind("providers.maxInFlightRequests")).toBeNull();
		// "displayName" ends in Name, not Model.
		expect(settingRefKind("collab.displayName")).toBeNull();
	});
});

describe("ModelValueSelect", () => {
	it("renders the current value on a listbox trigger, not a text input", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<ModelValueSelect kind="model" onCommit={() => {}} value="google/gemini-2.5-flash" />
			</I18nProvider>,
		);
		expect(html).toContain("google/gemini-2.5-flash");
		expect(html).toContain('aria-haspopup="listbox"');
		expect(html).not.toContain("<input");
	});

	it("renders an unset placeholder when the value is empty", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<ModelValueSelect kind="provider" onCommit={() => {}} value="" />
			</I18nProvider>,
		);
		expect(html).toContain("(unset)");
	});

	it("renders the dropdown closed without touching window.omp", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<ModelValueSelect kind="model" onCommit={() => {}} value="" />
			</I18nProvider>,
		);
		expect(html).not.toContain('role="listbox"');
	});

	it("will not offer a provider the catalog reports as disabled", async () => {
		await openDropdown();

		expect(rowFor("live-one").hasAttribute("disabled")).toBe(false);
		// A disabled provider is listed for recognition only: committing it as a
		// `*Provider` setting value fails at call time, far from this row.
		expect(rowFor("off-one").hasAttribute("disabled")).toBe(true);
		expect(rowFor("off-one").textContent).toContain("(disabled)");
	});

	it("follows its trigger through a scroll and closes once the trigger leaves the scroller", async () => {
		Object.assign(window as unknown as Record<string, unknown>, { innerWidth: 1440, innerHeight: 900 });
		let top = 400;
		await openDropdown(trigger => {
			trigger.getBoundingClientRect = () => ({ top, left: 100, bottom: top + 30, right: 400 }) as DOMRect;
		});
		const scroller = document.createElement("div");
		scroller.getBoundingClientRect = () => ({ top: 0, bottom: 800 }) as DOMRect;
		document.body.appendChild(scroller);
		const scroll = async () => {
			await act(async () => {
				scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
			});
		};
		const panelStyle = () =>
			document.body.querySelector("[role='listbox']")?.parentElement?.getAttribute("style") ?? null;
		expect(panelStyle()).toMatch(/top:\s*434px/);

		// Opening refreshed the catalog; the provider list above the row grew and
		// the column's scroll anchoring shifted the row by 16px while the user typed.
		top = 416;
		await scroll();
		expect(panelStyle()).toMatch(/top:\s*450px/);

		top = 820;
		await scroll();
		expect(panelStyle()).toBeNull();
	});

	it("lists caller-owned options without a fetch, pins a custom value, and offers typed text only with allowCustom", async () => {
		const shells = [{ label: "", options: [{ value: "/bin/zsh" }, { value: "/bin/bash" }] }];
		const typeInto = async (custom: boolean) => {
			await openDropdown(
				undefined,
				<ModelValueSelect allowCustom={custom} groups={shells} onCommit={() => {}} value="/opt/sh" />,
			);
			// linkedom has no input events: drive the search field's React onChange directly.
			const input = document.body.querySelector("input") as unknown as Record<string, unknown>;
			const propsKey = Object.getOwnPropertyNames(input).find(name => name.startsWith("__reactProps$"));
			const props = propsKey ? (input[propsKey] as { onChange?: (event: unknown) => void }) : undefined;
			await act(async () => props?.onChange?.({ target: { value: "/usr/bin/fish" } }));
			const texts = optionRows().map(row => row.textContent);
			const offered = Array.from(document.body.querySelectorAll("[role='listbox'] button")).some(button =>
				(button.textContent ?? "").includes('Use "/usr/bin/fish"'),
			);
			await act(async () => {
				root?.unmount();
			});
			root = null;
			return { texts, offered };
		};

		const strict = await typeInto(false);
		expect(command).not.toHaveBeenCalled();
		expect(strict.texts).toContain("/opt/sh");
		expect(strict.offered).toBe(false);
		expect((await typeInto(true)).offered).toBe(true);
	});

	it("lets the arrow keys reach every row of the list and commits from the search field on Enter", async () => {
		const shells = [{ label: "", options: [{ value: "/bin/zsh" }, { value: "/bin/bash" }] }];
		const onCommit = vi.fn();
		await openDropdown(
			undefined,
			<ModelValueSelect allowCustom groups={shells} onCommit={onCommit} value="/bin/bash" />,
		);
		const input = document.body.querySelector("input") as unknown as Record<string, unknown>;
		const props = () => {
			const key = Object.getOwnPropertyNames(input).find(name => name.startsWith("__reactProps$"));
			return (key ? input[key] : {}) as {
				onChange?: (event: unknown) => void;
				onKeyDown?: (event: unknown) => void;
			};
		};
		const type = async (value: string) => act(async () => props().onChange?.({ target: { value } }));
		const enter = async () =>
			act(async () =>
				props().onKeyDown?.({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault() {} }),
			);

		await type("/usr/bin/fish");
		// "Use …" and "Clear" are rows of the list: the arrows walk only options, and a listbox holds nothing else.
		expect(document.body.querySelectorAll("[role='listbox'] button:not([role='option'])").length).toBe(0);
		expect(optionRows().some(row => (row.textContent ?? "").includes('Use "/usr/bin/fish"'))).toBe(true);

		await enter();
		expect(onCommit).toHaveBeenLastCalledWith("/usr/bin/fish");
	});

	it("commits the first match on Enter, and nothing for an empty search", async () => {
		const shells = [{ label: "", options: [{ value: "/bin/zsh" }, { value: "/bin/bash" }] }];
		const onCommit = vi.fn();
		await openDropdown(undefined, <ModelValueSelect groups={shells} onCommit={onCommit} value="/bin/zsh" />);
		const input = document.body.querySelector("input") as unknown as Record<string, unknown>;
		const props = () => {
			const key = Object.getOwnPropertyNames(input).find(name => name.startsWith("__reactProps$"));
			return (key ? input[key] : {}) as {
				onChange?: (event: unknown) => void;
				onKeyDown?: (event: unknown) => void;
			};
		};
		const enter = async () =>
			act(async () =>
				props().onKeyDown?.({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault() {} }),
			);

		await enter();
		expect(onCommit).not.toHaveBeenCalled();
		await act(async () => props().onChange?.({ target: { value: "bash" } }));
		await enter();
		expect(onCommit).toHaveBeenCalledWith("/bin/bash");
	});
});
