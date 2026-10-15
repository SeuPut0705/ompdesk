import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "../stores/toast";
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
const stop = vi.fn(async () => {});
interface Notice {
	count: number;
	message: string;
	stop: string;
}
const takeNotice = vi.fn(async (): Promise<Notice | null> => null);

function Effects() {
	useInterruptedWork();
	return null;
}

beforeEach(() => {
	Reflect.set(window, "omp", { resume: { reportOnline, stop, takeNotice } });
	useToastStore.setState({ toasts: [] });
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

	it("shows the notice main worded, with a Stop that stops what the launch resumed", async () => {
		takeNotice.mockResolvedValueOnce({ count: 2, message: "중단된 작업 2개를 이어서 하고 있어요", stop: "중단" });
		await mount();
		const toast = useToastStore.getState().toasts[0];
		expect(toast?.message).toBe("중단된 작업 2개를 이어서 하고 있어요");
		expect(toast?.action?.label).toBe("중단");
		toast?.action?.run();
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("shows nothing when no turn was interrupted", async () => {
		await mount();
		expect(useToastStore.getState().toasts).toEqual([]);
	});
});
