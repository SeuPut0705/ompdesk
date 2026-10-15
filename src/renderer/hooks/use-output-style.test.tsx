import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOutputStyleStore } from "../stores/output-style";
import { deleteSessionRuntime, registerSessionRuntime } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";
import { useOutputStyle } from "./use-output-style";

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

let container: HTMLElement;
let root: Root;
let saved: unknown;
const command = vi.fn(async (_command: unknown) => ({ success: true, data: { style: "concise" } }));

function Effects() {
	useOutputStyle();
	return null;
}

function tab(status: string, sessionId = "s-1") {
	return [{ id: "tab-1", sessionId, status }] as never;
}

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => root.render(<Effects />));
	await act(async () => {});
}

function sent(): unknown[] {
	return command.mock.calls.map(call => call[0]);
}

beforeEach(() => {
	saved = undefined;
	command.mockClear();
	Reflect.set(window, "omp", {
		prefs: {
			get: vi.fn(async () => saved),
			set: vi.fn(async (_key: string, value: unknown) => {
				saved = value;
			}),
		},
	});
	registerSessionRuntime({ tabId: "tab-1", command: command as never, stores: new Map() });
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	deleteSessionRuntime("tab-1");
	useTabsStore.setState({ tabs: [], activeTabId: null });
	useOutputStyleStore.getState().reset();
});

describe("useOutputStyle", () => {
	it("sends nothing while the style is the default", async () => {
		useTabsStore.setState({ tabs: tab("ready"), activeTabId: "tab-1" });
		await mount();
		expect(sent()).toEqual([]);
	});

	it("sends the saved style once a tab is ready, again after a restart and on a change", async () => {
		saved = "concise";
		useTabsStore.setState({ tabs: tab("starting"), activeTabId: "tab-1" });
		await mount();
		expect(sent()).toEqual([]);
		await act(async () => useTabsStore.setState({ tabs: tab("ready") }));
		expect(sent()).toEqual([{ type: "set_output_style", style: "concise" }]);
		// Same session, same style: nothing new.
		await act(async () => useTabsStore.setState({ tabs: tab("ready") }));
		expect(sent()).toHaveLength(1);
		// omp restarted: its bridge forgot the style.
		await act(async () => useTabsStore.setState({ tabs: tab("starting") }));
		await act(async () => useTabsStore.setState({ tabs: tab("ready") }));
		expect(sent()).toHaveLength(2);
		await act(async () => useOutputStyleStore.getState().setStyle("default"));
		expect(sent().at(-1)).toEqual({ type: "set_output_style", style: "default" });
		expect(saved).toBeUndefined();
	});
});
