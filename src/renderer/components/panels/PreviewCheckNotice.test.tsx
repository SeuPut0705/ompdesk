import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";

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
// react-dom reads `document` when it loads, so these come after the linkedom globals above (the harness of BashRenderer.test.tsx).
const { createRoot } = await import("react-dom/client");
const { PreviewCheckNotice } = await import("./PreviewCheckNotice");

let container: HTMLElement;
let root: Root;
const realLocalStorage = (globalThis as Record<string, unknown>).localStorage;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

/** Force the persisted language the provider seeds itself from. */
function setLanguage(lang: "en" | "ko"): void {
	(globalThis as Record<string, unknown>).localStorage = {
		getItem: (key: string) => (key === "omp.lang" ? lang : null),
		setItem: () => {},
	};
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	(globalThis as Record<string, unknown>).localStorage = realLocalStorage;
});

describe("PreviewCheckNotice", () => {
	it.each([
		["en", "error", "This page shows an error"],
		["en", "blank", "This page looks blank"],
		["ko", "error", "이 페이지에 오류가 보여요"],
		["ko", "blank", "이 페이지가 비어 보여요"],
	] as const)("says one line in %s for a %s page", async (lang, problem, text) => {
		setLanguage(lang);
		await mount(<PreviewCheckNotice problem={problem} onDismiss={() => {}} />);
		expect(container.querySelector(`[data-preview-check="${problem}"]`)?.textContent).toBe(text);
		expect(container.textContent).toBe(text);
	});

	it("can be dismissed", async () => {
		setLanguage("en");
		const onDismiss = vi.fn();
		await mount(<PreviewCheckNotice problem="blank" onDismiss={onDismiss} />);
		const button = container.querySelector("button");
		expect(button).not.toBeNull();
		await act(async () => {
			button?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});
});
