import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUOTA_RESUME_GRACE_MS, useQuotaResumeStore } from "../stores/quota-resume";
import { deleteSessionRuntime, registerSessionRuntime } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";
import { useQuotaResume } from "./use-quota-resume";

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
const command = vi.fn(async () => ({ success: true, data: { retried: true } }));
let saved: unknown;

function Effects() {
	useQuotaResume();
	return null;
}

beforeEach(async () => {
	saved = undefined;
	Reflect.set(window, "omp", {
		prefs: {
			get: vi.fn(async () => saved),
			set: vi.fn(async (_key: string, value: unknown) => {
				saved = value;
			}),
		},
	});
	registerSessionRuntime({ tabId: "tab-1", command: command as never, stores: new Map() });
	useTabsStore.setState({ tabs: [{ id: "tab-1", sessionId: "s-1", status: "ready" }] as never, activeTabId: "tab-1" });
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	deleteSessionRuntime("tab-1");
	useTabsStore.setState({ tabs: [], activeTabId: null });
	useQuotaResumeStore.getState().reset();
	vi.clearAllMocks();
});

async function mount(): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => root.render(<Effects />));
}

describe("useQuotaResume", () => {
	it("retries a due booking from prefs on its idle tab once, and drops it", async () => {
		saved = { "s-1": Date.now() - 1000, "s-later": Date.now() + 60_000 };
		await mount();
		expect(command).toHaveBeenCalledTimes(1);
		expect(command).toHaveBeenCalledWith({ type: "retry" }, undefined);
		expect(useQuotaResumeStore.getState().reservations).toEqual({ "s-later": expect.any(Number) });
		expect(saved).toEqual({ "s-later": expect.any(Number) });
	});

	it("waits for a busy tab and drops a booking a day past its time", async () => {
		useTabsStore.setState({ tabs: [{ id: "tab-1", sessionId: "s-1", status: "running" }] as never });
		saved = { "s-1": Date.now() - 1000, "s-gone": Date.now() - QUOTA_RESUME_GRACE_MS - 1000 };
		await mount();
		expect(command).not.toHaveBeenCalled();
		expect(Object.keys(useQuotaResumeStore.getState().reservations)).toEqual(["s-1"]);

		await act(async () =>
			useTabsStore.setState({ tabs: [{ id: "tab-1", sessionId: "s-1", status: "ready" }] as never }),
		);
		expect(command).toHaveBeenCalledTimes(1);
		expect(useQuotaResumeStore.getState().reservations).toEqual({});
	});
});
