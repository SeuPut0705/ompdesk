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
import { LINK_NOTICE_GRACE_MS } from "../../../shared/link-notice";
import { autoDeviceColor } from "../../lib/device-color";
import { I18nProvider, translate } from "../../lib/i18n";
import { useRemoteStore } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { setFocusedSessionRuntime } from "../../stores/session-runtime-context";
import { useSidebarFolds } from "../../stores/sidebar-folds";
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
		tailnet: "ready",
		host: {
			enabled: false,
			name: "laptop",
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
	useSidebarFolds.getState().reset();
	vi.useRealTimers();
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

	it("does not read Reconnecting before the device list has loaded", async () => {
		seedTab("dev-studio");
		await mount(<TitleBar />);

		expect(document.body.querySelector('[role="status"]')?.textContent).toContain(translate("titlebar.status.ready"));
		expect(document.body.querySelector('[role="status"]')?.textContent).not.toContain(
			translate("remote.tab.statusReconnecting"),
		);
	});

	it("wears the device's color, the automatic one or the one chosen on its sidebar header", async () => {
		useRemoteStore.getState().apply(remoteState([{ deviceId: "dev-studio", name: "studio", state: "online" }]));
		seedTab("dev-studio");
		await mount(<TitleBar />);
		const chip = () => document.body.querySelector('[data-device-chip="dev-studio"]');
		expect(chip()?.getAttribute("data-device-color")).toBe(autoDeviceColor("dev-studio"));
		await act(async () => useSidebarFolds.getState().setDeviceColor("dev-studio", "pink"));
		expect(chip()?.getAttribute("data-device-color")).toBe("pink");
		await act(async () => useSidebarFolds.getState().setDeviceColor("dev-studio", "none"));
		expect(chip()?.hasAttribute("data-device-color")).toBe(false);
	});

	it("shows no chip on a local tab", async () => {
		useRemoteStore.getState().apply(remoteState([{ deviceId: "dev-studio", name: "studio", state: "online" }]));
		seedTab();
		await mount(<TitleBar />);

		expect(document.body.querySelector("[data-device-chip]")).toBeNull();
	});
});

describe("RemoteTabBanner", () => {
	const offline = () => remoteState([{ deviceId: "dev-studio", name: "studio", state: "offline" }]);
	const online = () => remoteState([{ deviceId: "dev-studio", name: "studio", state: "online" }]);
	const apply = (state: RemoteState) =>
		act(async () => {
			useRemoteStore.getState().apply(state);
		});
	const pass = (ms: number) =>
		act(async () => {
			vi.advanceTimersByTime(ms);
		});
	const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

	it("shows nothing while the remote state has not loaded, however long it takes", async () => {
		fakeClock();
		await mount(<RemoteTabBanner deviceId="dev-studio" />);
		await pass(LINK_NOTICE_GRACE_MS * 4);

		expect(document.body.textContent).toBe("");
	});

	it("shows nothing for a link that is back inside the grace", async () => {
		fakeClock();
		await apply(online());
		await mount(<RemoteTabBanner deviceId="dev-studio" />);

		await apply(offline());
		await pass(LINK_NOTICE_GRACE_MS - 1);
		expect(document.body.textContent).toBe("");
		await apply(online());
		await pass(LINK_NOTICE_GRACE_MS * 4);
		expect(document.body.textContent).toBe("");
	});

	it("says the tab is reconnecting once the link has stayed down past the grace, and clears once it is back", async () => {
		fakeClock();
		await apply(online());
		await mount(<RemoteTabBanner deviceId="dev-studio" />);

		await apply(offline());
		expect(document.body.textContent).toBe("");
		await pass(LINK_NOTICE_GRACE_MS);
		expect(document.body.textContent).toContain(translate("remote.tab.reconnecting", { name: "studio" }));
		await pass(60_000);
		expect(document.body.textContent).toContain(translate("remote.tab.reconnecting", { name: "studio" }));

		await apply(online());
		expect(document.body.textContent).toBe("");
	});

	it("counts the grace from when the link went down, through offline and connecting alike", async () => {
		fakeClock();
		await apply(online());
		await mount(<RemoteTabBanner deviceId="dev-studio" />);

		await apply(offline());
		await pass(LINK_NOTICE_GRACE_MS - 1000);
		await apply(remoteState([{ deviceId: "dev-studio", name: "studio", state: "connecting" }]));
		expect(document.body.textContent).toBe("");
		await pass(1000);
		expect(document.body.textContent).toContain(translate("remote.tab.reconnecting", { name: "studio" }));
	});

	it("shows at once on a tab opened while the link has been down for a while", async () => {
		fakeClock();
		await apply(offline());
		await pass(60_000);
		await mount(<RemoteTabBanner deviceId="dev-studio" />);

		expect(document.body.textContent).toContain(translate("remote.tab.reconnecting", { name: "studio" }));
	});

	it("points at Settings when the host was removed, with no wait", async () => {
		fakeClock();
		await apply(remoteState([]));
		await mount(<RemoteTabBanner deviceId="dev-studio" />);

		expect(document.body.textContent).toContain(translate("remote.tab.removed"));
	});
});
