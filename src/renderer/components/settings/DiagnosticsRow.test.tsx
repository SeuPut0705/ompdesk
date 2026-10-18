/**
 * Settings › Updates & about › Copy diagnostics: the row shows no report until Preview opens it, the
 * preview holds the redacted text main built (read again on every open), Copy puts exactly that text
 * on the clipboard, and a failed build says so with a Retry.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useToastStore } from "../../stores/toast";
import { DiagnosticsRow } from "./DiagnosticsRow";

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

const diagnostics = vi.fn(async (): Promise<string> => "OMPdesk diagnostics\nOMPdesk: 0.35.1\nemail <email>");
Object.assign(window as unknown as Record<string, unknown>, { omp: { runtime: { diagnostics } } });
const writeText = vi.fn(async (_text: string) => {});
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

let root: Root | null = null;
async function settle(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}
async function mount(): Promise<void> {
	root = createRoot(document.body as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<DiagnosticsRow />
			</I18nProvider>,
		),
	);
}
async function click(selector: string): Promise<void> {
	const element = document.body.querySelector(selector);
	if (!element) throw new Error(`no ${selector}`);
	await act(async () => {
		element.dispatchEvent(new Event("click", { bubbles: true }));
	});
	await settle();
}
const text = () => document.body.querySelector("[data-diagnostics-text]")?.textContent ?? null;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	diagnostics.mockClear();
	writeText.mockReset();
	useToastStore.setState({ toasts: [] });
});

describe("DiagnosticsRow", () => {
	it("builds nothing until the preview opens, then shows the report and closes again", async () => {
		await mount();
		expect(document.body.querySelector("#setting-about-diagnostics")).not.toBeNull();
		expect(diagnostics).not.toHaveBeenCalled();
		expect(text()).toBeNull();

		await click("[data-diagnostics-toggle]");
		expect(diagnostics).toHaveBeenCalledTimes(1);
		expect(text()).toBe("OMPdesk diagnostics\nOMPdesk: 0.35.1\nemail <email>");
		expect(document.body.querySelector("[data-diagnostics-toggle]")?.getAttribute("aria-expanded")).toBe("true");

		await click("[data-diagnostics-toggle]");
		expect(text()).toBeNull();
	});

	it("reads the report again on every open", async () => {
		await mount();
		await click("[data-diagnostics-toggle]");
		await click("[data-diagnostics-toggle]");
		diagnostics.mockResolvedValueOnce("second report");
		await click("[data-diagnostics-toggle]");
		expect(diagnostics).toHaveBeenCalledTimes(2);
		expect(text()).toBe("second report");
	});

	it("copies exactly the previewed text and confirms", async () => {
		await mount();
		await click("[data-diagnostics-toggle]");
		await click("[data-diagnostics-copy]");
		expect(writeText).toHaveBeenCalledWith("OMPdesk diagnostics\nOMPdesk: 0.35.1\nemail <email>");
		expect(document.body.querySelector("[data-diagnostics-copy]")?.getAttribute("data-copied")).toBe("true");
		expect(useToastStore.getState().toasts).toHaveLength(0);
	});

	it("raises an error toast when the clipboard refuses", async () => {
		writeText.mockRejectedValueOnce(new Error("denied"));
		await mount();
		await click("[data-diagnostics-toggle]");
		await click("[data-diagnostics-copy]");
		expect(document.body.querySelector("[data-diagnostics-copy]")?.hasAttribute("data-copied")).toBe(false);
		expect(useToastStore.getState().toasts.map(toast => toast.variant)).toEqual(["error"]);
	});

	it("says it failed and retries", async () => {
		diagnostics.mockRejectedValueOnce(new Error("log unreadable"));
		await mount();
		await click("[data-diagnostics-toggle]");
		expect(text()).toBeNull();
		expect(document.body.textContent).toContain("Couldn't collect diagnostics");
		expect(document.body.textContent).toContain("log unreadable");

		const retry = [...document.body.querySelectorAll("button")].find(button => button.textContent === "Retry");
		await act(async () => {
			retry?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		await settle();
		expect(diagnostics).toHaveBeenCalledTimes(2);
		expect(text()).toBe("OMPdesk diagnostics\nOMPdesk: 0.35.1\nemail <email>");
	});
});
