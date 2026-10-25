import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AskDockSlot } from "./ask-dock";

const { document, window, Element, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.Element = Element;
globals.document = document;
globals.window = window;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.MutationObserver = window.MutationObserver;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
globals.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
globals.getComputedStyle = () => ({ flexGrow: "0", position: "static", marginTop: "0px", marginBottom: "0px" });
// linkedom has no layout: every box is empty, so the slot's room is all floor and the dock's cards get none.
Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", { value: () => ({ height: 0 }) });
Object.defineProperty(HTMLElement.prototype, "clientHeight", { get: () => 0 });

/** The layout engine's side: what the slot watches, and a way to report that something resized. */
const watched = new Set<unknown>();
let resized: (() => void) | null = null;
globals.ResizeObserver = class {
	constructor(callback: () => void) {
		resized = callback;
	}
	observe(target: unknown) {
		watched.add(target);
	}
	unobserve(target: unknown) {
		watched.delete(target);
	}
	disconnect() {
		watched.clear();
	}
};

// After the globals above: react-dom-client reads the DOM it runs in when it loads.
const { createRoot } = await import("react-dom/client");

let root: Root | null = null;

async function nextFrame(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(
			<section className="omp-session-pane">
				<div>
					<div className="omp-transcript-editorial" />
					<div className="omp-composer-region">
						<div data-workspace-dock="">
							<div data-testid="workspace-dock" />
						</div>
					</div>
				</div>
				<div className="omp-composer-region">
					<AskDockSlot />
					<div className="omp-composer-box" />
				</div>
			</section>,
		);
	});
}

const dock = () => document.querySelector("[data-workspace-dock]") as unknown as HTMLElement;
const askDock = () => document.querySelector(".omp-ask-dock") as unknown as HTMLElement;

async function showCard(): Promise<void> {
	const card = document.createElement("section");
	card.setAttribute("data-prompt-card", "");
	askDock().appendChild(card as never);
	resized?.();
	await nextFrame();
}

async function closeCard(): Promise<void> {
	askDock().querySelector("[data-prompt-card]")?.remove();
	resized?.();
	await nextFrame();
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("AskDockSlot", () => {
	it("caps the dock's cards only while a card waits", async () => {
		await mount();
		expect(askDock().style.getPropertyValue("--omp-prompt-room")).not.toBe("");
		expect(dock().style.getPropertyValue("--omp-dock-room")).toBe("");

		await showCard();
		expect(dock().style.getPropertyValue("--omp-dock-room")).toBe("0px");
		expect(dock().hasAttribute("data-dock-yielded")).toBe(true);

		await closeCard();
		expect(dock().style.getPropertyValue("--omp-dock-room")).toBe("");
		expect(dock().hasAttribute("data-dock-yielded")).toBe(false);
	});

	it("releases the dock when it unmounts with a card on screen", async () => {
		await mount();
		await showCard();
		const element = dock();
		await act(async () => root?.unmount());
		root = null;
		expect(element.style.getPropertyValue("--omp-dock-room")).toBe("");
		expect(element.hasAttribute("data-dock-yielded")).toBe(false);
	});

	it("watches a row the transcript column gains after it mounted", async () => {
		await mount();
		const column = dock().closest(".omp-composer-region")?.parentElement;
		const transcript = document.createElement("div");
		column?.replaceChild(transcript, column.firstElementChild as never);
		await nextFrame();
		expect(watched.has(transcript)).toBe(true);
	});
});
