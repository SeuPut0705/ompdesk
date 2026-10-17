import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInterruptedWork } from "./use-interrupted-work";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
const reportOnline = vi.fn();
function Effects() {
	useInterruptedWork();
	return null;
}

beforeEach(() => {
	Reflect.set(window, "omp", { resume: { reportOnline } });
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.clearAllMocks();
});

async function mount(): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => root.render(<Effects />));
}

describe("useInterruptedWork", () => {
	it("tells main when the window goes offline and online again, and stops listening on unmount", async () => {
		await mount();
		window.dispatchEvent(new Event("offline"));
		window.dispatchEvent(new Event("online"));
		expect(reportOnline.mock.calls).toEqual([[false], [true]]);

		await act(async () => root.unmount());
		window.dispatchEvent(new Event("offline"));
		expect(reportOnline).toHaveBeenCalledTimes(2);
		root = createRoot(container);
	});
});
