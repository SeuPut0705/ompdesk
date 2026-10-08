/**
 * Remote tabs: the title bar names the host with a device chip, and while the
 * link is down the tab reads "Reconnecting" (title bar + pane banner) instead
 * of a failed agent. Local tabs show neither.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostView, RemoteState } from "../../../shared/ipc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useRemoteStore } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { setFocusedSessionRuntime } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { TitleBar } from "../layout/TitleBar";
import { RemoteTabBanner } from "./RemoteTabBanner";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(window as unknown as Record<string, number>, { innerHeight: 768, innerWidth: 1024 });
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		sessions: { list: vi.fn(async () => []), delete: vi.fn(async () => {}), rename: vi.fn(async () => {}) },
		events: { onSessionsChanged: vi.fn(() => () => {}) },
		rpc: {
			getSessionStats: vi.fn(async () => ({ type: "response", command: "get_session_stats", success: false })),
			setSessionName: vi.fn(async () => ({ type: "response", command: "set_session_name", success: true })),
		},
	},
});

function remoteState(hosts: HostView[]): RemoteState {
	return {
		host: { enabled: false, name: "laptop", port: null, addresses: [], code: null, expiresAt: null, peers: [] },
		hosts,
	};
}

function seedTab(device?: string): void {
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/Users/kim/code/app", status: "ready", kind: "agent", unreadDone: false, device }],
		activeTabId: "t1",
	});
	setFocusedSessionRuntime("t1");
	useSessionStore.setState({ status: "ready", cwd: "/Users/kim/code/app" });
}

let root: Root | null = null;

async function mount(element: ReactElement): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(<I18nProvider>{element}</I18nProvider>);
	});
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
});

describe("remote tab chip", () => {
	it("names the host in the title bar of a remote tab", async () => {
		useRemoteStore.getState().apply(remoteState([{ deviceId: "dev-studio", name: "studio", state: "online" }]));
		seedTab("dev-studio");
		await mount(<TitleBar />);

		const chip = document.body.querySelector('[data-device-chip="dev-studio"]');
		expect(chip?.textContent).toContain("studio");
		expect(chip?.getAttribute("data-link-state")).toBe("online");
		expect(chip?.getAttribute("title")).toBe(translate("remote.tab.chip", { name: "studio" }));
		expect(document.body.querySelector('[role="status"]')?.textContent).toContain(translate("titlebar.status.ready"));
	});

	it("reads Reconnecting while the host's link is down", async () => {
		useRemoteStore.getState().apply(remoteState([{ deviceId: "dev-studio", name: "studio", state: "offline" }]));
		seedTab("dev-studio");
		useSessionStore.setState({ status: "error" });
		await mount(<TitleBar />);

		expect(document.body.querySelector('[data-device-chip="dev-studio"]')?.getAttribute("data-link-state")).toBe(
			"offline",
		);
		expect(document.body.querySelector('[role="status"]')?.textContent).toContain(
			translate("remote.tab.statusReconnecting"),
		);
	});

	it("shows no chip on a local tab", async () => {
		useRemoteStore.getState().apply(remoteState([{ deviceId: "dev-studio", name: "studio", state: "online" }]));
		seedTab();
		await mount(<TitleBar />);

		expect(document.body.querySelector("[data-device-chip]")).toBeNull();
	});
});

describe("RemoteTabBanner", () => {
	it("says the tab is reconnecting while the host is offline, and clears once it is back", async () => {
		useRemoteStore.getState().apply(remoteState([{ deviceId: "dev-studio", name: "studio", state: "offline" }]));
		await mount(<RemoteTabBanner deviceId="dev-studio" />);

		expect(document.body.textContent).toContain(translate("remote.tab.reconnecting", { name: "studio" }));

		await act(async () => {
			useRemoteStore.getState().apply(remoteState([{ deviceId: "dev-studio", name: "studio", state: "online" }]));
		});
		expect(document.body.textContent).toBe("");
	});

	it("points at Settings when the host was removed", async () => {
		useRemoteStore.getState().apply(remoteState([]));
		await mount(<RemoteTabBanner deviceId="dev-studio" />);

		expect(document.body.textContent).toContain(translate("remote.tab.removed"));
	});
});
