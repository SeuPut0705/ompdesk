/**
 * The device pills at the top of Settings: this computer and each paired computer listed with their link's state, the
 * shown device highlighted, a click focusing a tab on it through the tab store (Settings follows the focused tab's
 * device), and a device that is not online refusing with its reason instead of opening anything.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostView, RemoteLinkState, RemoteState } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { useRemoteStore } from "../../stores/remote";
import { setFocusedSessionRuntime } from "../../stores/session-runtime-context";
import { type SessionTab, useTabsStore } from "../../stores/tabs";
import { useToastStore } from "../../stores/toast";
import { SettingsDeviceSwitch } from "./SettingsDeviceSwitch";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const STUDIO = "host-studio";
const LAPTOP = "host-laptop-with-a-very-long-name";

function hostsState(hosts: HostView[]): RemoteState {
	return {
		tailnet: "ready",
		host: {
			enabled: false,
			name: "mini",
			port: null,
			addresses: [],
			listenError: null,
			peers: [],
			keepAwake: true,
			keepingAwake: false,
			usedBy: [],
		},
		hosts,
		forgotten: [],
	};
}

const host = (deviceId: string, name: string, state: RemoteLinkState): HostView => ({ deviceId, name, state });

const tab = (id: string, device?: string): SessionTab => ({
	id,
	cwd: "/Users/kim/app",
	status: "ready",
	kind: "agent",
	unreadDone: false,
	device,
});

const switchTab = vi.fn(async (_id: string) => {});
const openTab = vi.fn(async (_args?: unknown) => null);
const original = { switchTab: useTabsStore.getState().switchTab, openTab: useTabsStore.getState().openTab };

/** The focused tab is `focused`; Settings then shows that tab's device. */
function focus(tabs: SessionTab[], focused: string): void {
	useTabsStore.setState({ tabs, activeTabId: focused, switchTab, openTab });
	setFocusedSessionRuntime(focused);
}

let root: Root | null = null;

/** The page reads the focused tab once per mount (an app provider re-renders it), so a new focus remounts. */
async function refocus(tabs: SessionTab[], focused: string): Promise<void> {
	await act(async () => {
		root?.unmount();
	});
	focus(tabs, focused);
	await mount();
}

async function mount(): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<SettingsDeviceSwitch />
			</I18nProvider>,
		);
	});
}

const pill = (id: string) => document.querySelector(`[data-settings-device="${id}"]`) as unknown as HTMLElement | null;

async function click(id: string): Promise<void> {
	await act(async () => {
		pill(id)?.click();
	});
}

const shownIds = () =>
	[...document.querySelectorAll("[data-settings-device]")]
		.filter(node => node.getAttribute("aria-selected") === "true")
		.map(node => node.getAttribute("data-settings-device"));

beforeEach(() => {
	vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
		callback();
		return 0;
	});
	vi.stubGlobal("CSS", { escape: (value: string) => value });
	switchTab.mockClear();
	openTab.mockClear();
});

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	document.body.innerHTML = "";
	useTabsStore.setState(original);
	useTabsStore.getState().reset();
	useRemoteStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	setFocusedSessionRuntime(null);
	vi.unstubAllGlobals();
});

describe("Settings device pills", () => {
	it("lists this device and each paired device with its link state, and nothing without one", async () => {
		useRemoteStore.getState().apply(hostsState([]));
		focus([tab("a-local")], "a-local");
		await mount();
		expect(document.querySelector("[data-settings-device-switch]")).toBeNull();

		const paired = [host(STUDIO, "Studio", "online"), host(LAPTOP, "Laptop with a very long name", "offline")];
		await act(async () => {
			useRemoteStore.getState().apply(hostsState(paired));
		});
		const strip = document.querySelector("[data-settings-device-switch]");
		expect(strip?.textContent).toContain("Settings for");
		expect(
			[...document.querySelectorAll("[data-settings-device]")].map(node => [
				node.getAttribute("data-settings-device"),
				node.getAttribute("data-link-state"),
				node.textContent,
			]),
		).toEqual([
			["local", "online", "This device, Online"],
			[STUDIO, "online", "Studio, Online"],
			[LAPTOP, "offline", "Laptop with a very long name, Offline"],
		]);
		// The dot is decorative: the state is read as a word, and the strip is one named tab list.
		expect(strip?.querySelector("[role='tablist']")?.getAttribute("aria-label")).toBe("Settings for");
		// The cut name is whole in the pill's own box.
		expect(pill(LAPTOP)?.className).toContain("max-w-48");
		expect(pill(LAPTOP)?.querySelector(".truncate")?.textContent).toBe("Laptop with a very long name");
	});

	it("highlights the device the focused tab runs on", async () => {
		useRemoteStore.getState().apply(hostsState([host(STUDIO, "Studio", "online")]));
		focus([tab("b-local"), tab("b-studio", STUDIO)], "b-local");
		await mount();
		expect(shownIds()).toEqual(["local"]);

		await refocus([tab("b-local"), tab("b-studio", STUDIO)], "b-studio");
		expect(shownIds()).toEqual([STUDIO]);
	});

	it("shows the focused device's settings by focusing a tab on the pill's device", async () => {
		useRemoteStore.getState().apply(hostsState([host(STUDIO, "Studio", "online")]));
		focus([tab("c-local"), tab("c-studio", STUDIO)], "c-local");
		await mount();

		await click(STUDIO);
		expect(switchTab).toHaveBeenCalledExactlyOnceWith("c-studio");
		expect(openTab).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("comes back to the tab it left on a device", async () => {
		useRemoteStore.getState().apply(hostsState([host(STUDIO, "Studio", "online")]));
		const tabs = [tab("d-one"), tab("d-two"), tab("d-studio", STUDIO)];
		focus(tabs, "d-two");
		await mount();
		await click(STUDIO);
		expect(switchTab).toHaveBeenLastCalledWith("d-studio");

		await refocus(tabs, "d-studio");
		await click("local");
		expect(switchTab).toHaveBeenLastCalledWith("d-two");
	});

	it("opens a chat tab on a device that has none open", async () => {
		useRemoteStore.getState().apply(hostsState([host(STUDIO, "Studio", "online")]));
		focus([tab("e-local")], "e-local");
		await mount();
		await click(STUDIO);
		expect(openTab).toHaveBeenCalledExactlyOnceWith({ kind: "chat", device: STUDIO });
		expect(switchTab).not.toHaveBeenCalled();
	});

	it("does nothing for the pill that is already shown", async () => {
		useRemoteStore.getState().apply(hostsState([host(STUDIO, "Studio", "online")]));
		focus([tab("f-local")], "f-local");
		await mount();
		await click("local");
		expect(switchTab).not.toHaveBeenCalled();
		expect(openTab).not.toHaveBeenCalled();
	});

	it("refuses an offline device with the reason, and a connecting one with its own", async () => {
		useRemoteStore
			.getState()
			.apply(hostsState([host(STUDIO, "Studio", "offline"), host(LAPTOP, "Laptop", "connecting")]));
		focus([tab("g-local"), tab("g-studio", STUDIO)], "g-local");
		await mount();
		expect(pill(STUDIO)?.className).toContain("opacity-60");
		expect(pill("local")?.className).not.toContain("opacity-60");

		await click(STUDIO);
		await click(LAPTOP);
		expect(switchTab).not.toHaveBeenCalled();
		expect(openTab).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts.map(entry => entry.message)).toEqual([
			"Studio is offline, so its settings can't be opened now. They open again once it reconnects.",
			"Laptop is still connecting. Its settings open once the link is up.",
		]);
		expect(shownIds()).toEqual(["local"]);
	});

	it("moves focus with the arrow keys without showing the device it passes", async () => {
		useRemoteStore.getState().apply(hostsState([host(STUDIO, "Studio", "online")]));
		focus([tab("h-local"), tab("h-studio", STUDIO)], "h-local");
		await mount();
		const event = new Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "key", { value: "ArrowRight" });
		await act(async () => {
			document.querySelector("[role='tablist']")?.dispatchEvent(event);
		});
		expect(switchTab).not.toHaveBeenCalled();
		expect(openTab).not.toHaveBeenCalled();
		expect(shownIds()).toEqual(["local"]);
	});

	it("keeps a pill for the focused device after that computer was removed", async () => {
		useRemoteStore.getState().apply(hostsState([host(STUDIO, "Studio", "online")]));
		focus([tab("i-local"), tab("i-gone", "host-gone")], "i-gone");
		await mount();
		expect(shownIds()).toEqual(["host-gone"]);
		expect(pill("host-gone")?.textContent).toContain("Unknown device");
	});
});
