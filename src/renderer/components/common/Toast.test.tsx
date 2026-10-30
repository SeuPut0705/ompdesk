import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { toast, useToastStore } from "../../stores/toast";

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

// After the DOM globals: react-dom reads `document`/`window` when it loads.
const { createRoot } = await import("react-dom/client");
const { ToastStack } = await import("./Toast");

let container: HTMLElement;
let root: Root;

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ToastStack />
			</I18nProvider>,
		);
	});
}

async function advance(ms: number): Promise<void> {
	await act(async () => {
		vi.advanceTimersByTime(ms);
	});
}

const cards = () => [...document.querySelectorAll('[role="status"]')];

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	vi.useRealTimers();
	useToastStore.setState({ toasts: [] });
});

describe("ToastStack", () => {
	it("holds every toast while the pointer rests on the stack, and lets them expire after it leaves", async () => {
		vi.useFakeTimers();
		await mount();
		await act(async () => {
			toast({ message: "Session exported" });
			toast({ message: "Copied" });
		});
		const stack = document.querySelector('[aria-live="polite"]');
		await act(async () => {
			stack?.firstElementChild?.dispatchEvent(new Event("mouseover", { bubbles: true }));
		});
		await advance(8_000);
		// Being read: nothing may slide away under the pointer.
		expect(cards()).toHaveLength(2);

		await act(async () => {
			const leave = new Event("mouseout", { bubbles: true });
			Object.defineProperty(leave, "relatedTarget", { value: document.body });
			stack?.firstElementChild?.dispatchEvent(leave);
		});
		await advance(8_000);
		expect(cards()).toHaveLength(0);
	});

	it("holds them while keyboard focus is on a toast's control", async () => {
		vi.useFakeTimers();
		await mount();
		await act(async () => {
			toast({ message: "Couldn't copy", variant: "warning" });
		});
		const close = document.querySelector('[aria-live="polite"] button');
		await act(async () => {
			close?.dispatchEvent(new Event("focusin", { bubbles: true }));
		});
		await advance(8_000);
		expect(cards()).toHaveLength(1);
	});

	it("on a phone starts under the work strip, never over its line", async () => {
		document.documentElement.dataset.shell = "phone";
		const chip = document.createElement("button");
		chip.setAttribute("data-work-chip", "");
		chip.getBoundingClientRect = () =>
			({ top: 87, bottom: 115, height: 28, left: 0, right: 390, width: 390 }) as DOMRect;
		document.body.appendChild(chip as never);
		try {
			await mount();
			await act(async () => {
				toast({ message: "Copied the link" });
			});
			const stack = document.querySelector("[data-toast-stack]") as HTMLElement | null;
			expect(stack?.style.getPropertyValue("--omp-toast-top")).toBe("123px");
		} finally {
			chip.remove();
			delete document.documentElement.dataset.shell;
		}
	});
});

describe("ToastStack Korean wrapping", () => {
	it("keeps words whole in the title as in the message, so a title never leaves one syllable on its own line", async () => {
		await mount();
		const title = "일부 OMPdesk 기능이 이 omp와 맞지 않아요";
		const message = "omp 18.12.0에 내부 기능이 없어요.";
		await act(async () => {
			toast({ title, message, variant: "warning" });
		});
		const divs = [...(cards()[0]?.querySelectorAll("div") ?? [])];
		for (const text of [title, message]) {
			const part = divs.find(node => node.textContent === text);
			expect(part?.getAttribute("class"), text).toContain("break-keep");
		}
	});
});

describe("ToastStack error detail", () => {
	const path = "/Users/dev/projects/ompdesk/src/renderer/components/layout/sidebar/Sidebar.tsx";

	it("says an error once: a detail that only repeats the message behind 'Error:' is left out", async () => {
		await mount();
		const message = `Could not read ${path}`;
		await act(async () => {
			toast({ variant: "error", title: "Read failed", message, detail: `Error: ${message}` });
			toast({
				variant: "error",
				title: "Write failed",
				message: "Could not save.",
				detail: "EACCES: permission denied",
			});
		});
		const details = [...document.querySelectorAll("[data-toast-detail]")].map(node => node.textContent);
		expect(details).toEqual(["EACCES: permission denied"]);
	});

	it("lets a long path in the message break only after its slashes", async () => {
		await mount();
		await act(async () => {
			toast({ message: `Copied ${path} to the clipboard.` });
		});
		const card = cards()[0];
		expect(card?.textContent).toContain(`Copied ${path} to the clipboard.`);
		// Every break opportunity follows a slash, so no folder name is cut ("compo / nents").
		const pieces = (card?.innerHTML ?? "").split(/<wbr\s*\/?>(?:<\/wbr>)?/);
		expect(pieces.length).toBeGreaterThan(1);
		for (const piece of pieces.slice(0, -1)) expect(piece.endsWith("/")).toBe(true);
	});
});
