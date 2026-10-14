import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useToastStore } from "../../stores/toast";
import { CopyButton } from "./CopyButton";

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

const writeText = vi.fn(async (_text: string) => {});
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

const roots: Root[] = [];

async function mount(node: React.ReactNode): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => root.render(<I18nProvider>{node}</I18nProvider>));
	return host as unknown as HTMLElement;
}

async function click(button: Element | null) {
	await act(async () => {
		button?.dispatchEvent(new Event("click", { bubbles: true }));
		await Promise.resolve();
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) act(() => root.unmount());
	document.body.innerHTML = "";
	writeText.mockReset();
	useToastStore.setState({ toasts: [] });
});

describe("CopyButton", () => {
	it("copies the text built on click, then shows and announces the check", async () => {
		const build = vi.fn(() => "built value");
		const host = await mount(<CopyButton label="Copy value" text={build} />);
		const button = host.querySelector("button[aria-label='Copy value']");
		expect(build).not.toHaveBeenCalled();
		expect(button?.hasAttribute("data-copied")).toBe(false);

		await click(button);

		expect(writeText).toHaveBeenCalledWith("built value");
		expect(button?.getAttribute("data-copied")).toBe("true");
		expect(host.querySelector("[role='status']")?.textContent).toBe("Copied");
		expect(useToastStore.getState().toasts).toHaveLength(0);
	});

	it("raises an error toast when the clipboard refuses", async () => {
		writeText.mockRejectedValueOnce(new Error("denied"));
		const host = await mount(<CopyButton failedMessage="Couldn't copy the log" label="Copy log" text="log" />);
		const button = host.querySelector("button[aria-label='Copy log']");

		await click(button);

		expect(button?.hasAttribute("data-copied")).toBe(false);
		expect(useToastStore.getState().toasts.map(toast => [toast.variant, toast.message])).toEqual([
			["error", "Couldn't copy the log"],
		]);
	});
});
