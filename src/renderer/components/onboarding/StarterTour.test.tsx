/**
 * Spotlight tour: dims the window around the real control a step names, puts
 * a card beside it, ends on Got it / Escape / a click outside, and closes on
 * its own when the step completes. A control that is not on screen gets a
 * centered card instead of a hole over nothing.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { useStarterGuideStore } from "../../stores/starter-guide";
import { StarterTour } from "./StarterTour";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML(
	"<html><body><div id='app'></div></body></html>",
);
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
Object.assign(window as unknown as Record<string, unknown>, {
	innerWidth: 1200,
	innerHeight: 800,
	omp: { prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) } },
});
// The tour follows its control on animation frames; here a frame is a macrotask.
Object.assign(globalThis as Record<string, unknown>, {
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});

let root: Root | undefined;

function addTarget(html: string, rect: { left: number; top: number; width: number; height: number }): HTMLElement {
	const host = document.createElement("div");
	host.innerHTML = html;
	const target = host.firstElementChild as HTMLElement;
	Object.defineProperty(target, "getBoundingClientRect", {
		value: () => ({
			...rect,
			right: rect.left + rect.width,
			bottom: rect.top + rect.height,
			x: rect.left,
			y: rect.top,
		}),
	});
	document.body.appendChild(target);
	return target;
}

async function mount(): Promise<void> {
	root = createRoot(document.getElementById("app") as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<StarterTour />
			</I18nProvider>,
		);
	});
}

const card = () => document.querySelector("[data-starter-tour]") as HTMLElement | null;
const button = (label: string) =>
	[...document.querySelectorAll("button")].find(node => node.textContent?.trim() === label) as HTMLElement | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "<div id='app'></div>";
	useStarterGuideStore.getState().reset();
});

describe("StarterTour", () => {
	it("spotlights the step's real control and names it in a labelled dialog", async () => {
		addTarget("<div class='omp-composer-input'></div>", { left: 400, top: 640, width: 600, height: 60 });
		useStarterGuideStore.getState().startTour("prompt");
		await mount();
		expect(card()?.getAttribute("role")).toBe("dialog");
		expect(card()?.textContent).toContain(translate("starter.step.prompt.title"));
		expect(card()?.textContent).toContain(translate("starter.step.prompt.tour"));
		expect(document.querySelector("[data-starter-tour-root]")?.getAttribute("data-target-found")).toBe("true");
		// left, top, width, height of the hole: the control's box plus 6px around it.
		expect(document.querySelector("[data-tour-hole]")?.getAttribute("data-tour-hole")).toBe("394,634,612,72");
	});

	it("centers the card when the control is not on screen", async () => {
		useStarterGuideStore.getState().startTour("split");
		await mount();
		expect(card()).not.toBeNull();
		expect(document.querySelector("[data-tour-hole]")).toBeNull();
		expect(document.querySelector("[data-starter-tour-root]")?.getAttribute("data-target-found")).toBe("false");
	});

	it("ends on Got it, on Escape and on a click outside", async () => {
		addTarget("<button data-model-chip>Model</button>", { left: 400, top: 700, width: 120, height: 28 });
		useStarterGuideStore.getState().startTour("model");
		await mount();
		await act(async () => button(translate("starter.gotIt"))?.click());
		expect(useStarterGuideStore.getState().tour).toBeNull();
		expect(card()).toBeNull();

		await act(async () => useStarterGuideStore.getState().startTour("model"));
		await act(async () => {
			const keydown = new Event("keydown", { bubbles: true });
			Object.assign(keydown, { key: "Escape" });
			card()?.dispatchEvent(keydown);
		});
		expect(useStarterGuideStore.getState().tour).toBeNull();

		await act(async () => useStarterGuideStore.getState().startTour("model"));
		await act(async () => (document.querySelector("[data-tour-shield]") as HTMLElement | null)?.click());
		expect(useStarterGuideStore.getState().tour).toBeNull();
	});

	it("closes on its own when the step completes", async () => {
		useStarterGuideStore.getState().startTour("panel");
		await mount();
		expect(card()).not.toBeNull();
		await act(async () => useStarterGuideStore.getState().complete(["panel"]));
		expect(card()).toBeNull();
	});
});
