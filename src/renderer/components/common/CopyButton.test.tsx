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

	it("starts writing text still being read inside the click, so WebKit keeps the gesture", async () => {
		const items: Array<Record<string, Promise<Blob>>> = [];
		class FakeClipboardItem {
			constructor(readonly parts: Record<string, Promise<Blob>>) {
				items.push(parts);
			}
		}
		const write = vi.fn(async (list: FakeClipboardItem[]) => {
			await Promise.all(list.flatMap(item => Object.values(item.parts)));
		});
		const clipboard = { writeText, write };
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
		(globalThis as Record<string, unknown>).ClipboardItem = FakeClipboardItem;
		try {
			const { promise, resolve } = Promise.withResolvers<string>();
			const host = await mount(<CopyButton label="Copy log" text={() => promise} />);
			const button = host.querySelector("button[aria-label='Copy log']");
			act(() => {
				button?.dispatchEvent(new Event("click", { bubbles: true }));
			});
			// The write began in the click itself, before the text arrived.
			expect(write).toHaveBeenCalledTimes(1);
			await act(async () => {
				resolve("the whole log");
				await promise;
			});
			await act(async () => {
				await Promise.resolve();
			});
			expect(await (await items[0]?.["text/plain"])?.text()).toBe("the whole log");
			expect(writeText).not.toHaveBeenCalled();
			expect(button?.getAttribute("data-copied")).toBe("true");
		} finally {
			delete (globalThis as Record<string, unknown>).ClipboardItem;
			Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		}
	});
});
