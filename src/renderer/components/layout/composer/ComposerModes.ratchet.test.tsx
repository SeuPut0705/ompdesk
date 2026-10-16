/** The Ratchet tab of the Mode popover: shown when the omp supports it, a manual switch, a note when its tools are missing. */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useSessionStore } from "../../../stores/session";
import { useUiStore } from "../../../stores/ui";
import { ComposerModes } from "./ComposerModes";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

interface TestElement {
	textContent: string | null;
	remove: () => void;
	appendChild: (child: TestElement) => void;
	click: () => void;
	getAttribute: (name: string) => string | null;
}

function success(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

let setRatchet: Mock<(enabled: boolean) => Promise<RpcResponse>>;

function installMockOmp(): void {
	setRatchet = vi.fn(async (enabled: boolean) => success({ enabled, missing: [] }));
	const events = new Proxy({}, { get: () => vi.fn(() => () => {}) });
	(window as unknown as { omp: unknown }).omp = {
		rpc: { getSettings: vi.fn(async () => success({ values: {} })), setRatchet },
		prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
		events,
	};
}

let container: TestElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	document.body.innerHTML = "";
	useSessionStore.getState().reset();
	useUiStore.setState({ modesOpen: false, modesTab: "vibe" });
});

const trigger = () => document.querySelector("button[data-composer-modes-trigger]") as unknown as TestElement;
const ratchetTab = () =>
	(Array.from(document.querySelectorAll('[role="tab"]')) as unknown as TestElement[]).find(el =>
		el.textContent?.startsWith("Ratchet"),
	);
const ratchetSwitch = () => document.querySelector("[data-ratchet-mode]") as unknown as TestElement | null;

async function openRatchet(): Promise<void> {
	await act(async () => trigger().click());
	await flush();
	await act(async () => ratchetTab()?.click());
	await flush();
}

describe("Ratchet in the Mode popover", () => {
	it("has no tab on an omp without it", async () => {
		installMockOmp();
		await mount(<ComposerModes />);
		await act(async () => trigger().click());
		await flush();
		expect(ratchetTab()).toBeUndefined();
	});

	it("turns stock's setting on and off from the switch and names itself on the chip while on", async () => {
		installMockOmp();
		useSessionStore.setState({ ratchet: { enabled: false, missing: [] } });
		await mount(<ComposerModes />);
		await openRatchet();
		expect(document.body.textContent).toContain(translate("input.modes.ratchetDesc"));
		expect(ratchetSwitch()?.getAttribute("aria-checked")).toBe("false");

		await act(async () => ratchetSwitch()?.click());
		await flush();
		expect(setRatchet).toHaveBeenCalledWith(true);
		expect(useSessionStore.getState().ratchet).toEqual({ enabled: true, missing: [] });
		expect(trigger().textContent).toBe(translate("input.modes.name.ratchet"));

		await act(async () => ratchetSwitch()?.click());
		await flush();
		expect(setRatchet).toHaveBeenLastCalledWith(false);
		expect(useSessionStore.getState().ratchet?.enabled).toBe(false);
	});

	it("says which tools are missing and keeps the switch off", async () => {
		installMockOmp();
		useSessionStore.setState({ ratchet: { enabled: false, missing: ["eval", "task"] } });
		await mount(<ComposerModes />);
		await openRatchet();
		const note = document.querySelector("[data-ratchet-missing]") as unknown as TestElement | null;
		expect(note?.textContent).toBe(translate("input.modes.ratchetMissing", { tools: "eval, task" }));
		await act(async () => ratchetSwitch()?.click());
		await flush();
		expect(setRatchet).not.toHaveBeenCalled();
	});
});
