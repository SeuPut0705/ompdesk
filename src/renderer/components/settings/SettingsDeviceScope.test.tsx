/**
 * Settings while the focused tab runs on a paired host: a banner names the
 * host, app-scoped sections carry "This device" in the nav and inside mixed
 * sections, and an unreachable host's sections show its offline notice
 * instead of stale or local data. A local tab shows none of it.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostView, RemoteLinkState, RemoteState } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { useRemoteStore } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { setFocusedSessionRuntime } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { SettingsPage } from "./SettingsPage";

const { document, window, Event, CustomEvent, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	document,
	window,
	Event,
	CustomEvent,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const notConnected = { type: "response", command: "test", success: false, error: "not connected" };
Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
		system: { info: vi.fn(async () => ({ deviceLanguage: "en-US" })) },
		sidecar: { restart: vi.fn(async () => {}) },
		events: { onConfigUpdate: vi.fn(() => () => {}) },
		rpc: {
			getSettingsSchema: vi.fn(async () => notConnected),
			getSettings: vi.fn(async () => notConnected),
		},
	},
});

const HOST_ID = "host-studio";

function remoteState(state: RemoteLinkState): RemoteState {
	const hosts: HostView[] = [{ deviceId: HOST_ID, name: "Studio", state }];
	return {
		host: {
			enabled: false,
			name: "laptop",
			port: null,
			addresses: [],
			code: null,
			expiresAt: null,
			peers: [],
			keepAwake: true,
			keepingAwake: false,
			usedBy: [],
		},
		hosts,
	};
}

/** One focused tab, on the paired host or on this device. */
function focusTab(device: string | undefined, link: RemoteLinkState = "online"): void {
	useRemoteStore.getState().apply(remoteState(link));
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/Users/kim/app", status: "starting", kind: "agent", unreadDone: false, device }],
		activeTabId: "t1",
	});
	setFocusedSessionRuntime("t1");
	// Not ready: the schema loader stays idle, so only the scope decides what renders.
	useSessionStore.setState({ status: link === "online" ? "starting" : "error" });
}

let root: Root | null = null;

async function openSettings(section: string): Promise<void> {
	useUiStore.setState({ settingsTab: section });
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<SettingsPage />
			</I18nProvider>,
		);
	});
}

function query(selector: string) {
	return document.querySelector(selector);
}

function navTag(section: string): boolean {
	return query(`[data-settings-nav="${section}"] [data-this-device-tag]`) !== null;
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useTabsStore.getState().reset();
	useRemoteStore.getState().reset();
	useSessionStore.getState().reset();
	setFocusedSessionRuntime(null);
});

describe("Settings for a tab on a paired host", () => {
	it("names the host and tags this device's app sections in the nav", async () => {
		focusTab(HOST_ID);
		await openSettings("appearance");
		const banner = query(`[data-settings-device-banner="${HOST_ID}"]`);
		expect(banner?.textContent).toContain(
			"These are Studio's settings. App settings (appearance, shortcuts, language, updates) follow this device.",
		);
		expect(banner?.querySelector(`[data-device-chip="${HOST_ID}"]`)).not.toBeNull();
		expect(["general", "appearance", "keyboard"].map(navTag)).toEqual([true, true, true]);
		// The narrow nav keeps its labels whole: the tag there is the device icon, named for screen readers.
		expect(query('[data-settings-nav="appearance"] [data-this-device-tag]')?.getAttribute("aria-label")).toBe(
			"This device",
		);
		expect(
			["models", "agent", "tools", "permissions", "workspace", "connections", "updates", "advanced"].some(navTag),
		).toBe(false);
		expect(query('[data-settings-nav="models"]')?.getAttribute("data-settings-scope")).toBe("host");
		// The section header says whose settings these are only while a paired host's tab is focused.
		expect(query("[data-settings-section-scope]")?.getAttribute("data-settings-section-scope")).toBe("app");
		// An app section renders as usual, with no offline notice.
		expect(query("[data-host-offline]")).toBeNull();
	});

	it("shows an offline notice in place of the host's sections, without the omp connection banner", async () => {
		focusTab(HOST_ID, "offline");
		await openSettings("models");
		const notice = query("[data-host-offline]");
		expect(notice?.textContent).toContain("Studio is offline");
		expect(notice?.textContent).toContain("These settings live on Studio. They show again once it reconnects.");
		expect(query("[data-settings-connection-notice]")).toBeNull();
		expect(query("#settings-models-accounts")).toBeNull();
	});

	it("names the scope of each group in a mixed section", async () => {
		focusTab(HOST_ID);
		await openSettings("connections");
		expect(
			[...document.querySelectorAll("[data-settings-group-scope]")].map(node =>
				node.getAttribute("data-settings-group-scope"),
			),
		).toEqual(["app", "host"]);
	});

	it("keeps this device's settings available while the host is offline", async () => {
		focusTab(HOST_ID, "connecting");
		await openSettings("general");
		expect(query("#setting-gui-language")).not.toBeNull();
		expect(query("main [data-this-device-tag]")?.textContent).toBe("This device");
		expect(query("[data-reply-language-host]")?.textContent).toBe("Tabs on Studio follow that device's own setting.");
		expect(query("[data-host-offline]")).toBeNull();
		expect(query("#setting-steeringMode")).toBeNull();
	});

	it("shows none of it for a tab on this device", async () => {
		focusTab(undefined);
		await openSettings("general");
		expect(query("[data-settings-device-banner]")).toBeNull();
		expect(query("[data-this-device-tag]")).toBeNull();
		expect(query("[data-host-offline]")).toBeNull();
		expect(query("[data-reply-language-host]")).toBeNull();
		expect(query("#setting-steeringMode")).toBeNull();
		// No "This device" / "Selected host" lines anywhere for a local tab.
		expect(query("[data-settings-section-scope]")).toBeNull();
		expect(query("[data-settings-group-scope]")).toBeNull();
	});
});
