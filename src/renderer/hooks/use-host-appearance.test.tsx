/**
 * B16: with "Use the host computer's theme and language" on, focusing a tab on
 * an online paired host shows the host's theme and UI language without saving
 * either; focusing this computer's tab brings the user's own back, and with
 * the switch off the host is never asked.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostDesktopState, HostView, RemoteState } from "../../shared/ipc-types";
import { I18nProvider, setLanguageOverride, useT } from "../lib/i18n";
import { THEMES } from "../lib/themes";
import { useRemoteStore } from "../stores/remote";
import { setFocusedSessionRuntime } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";
import { HOST_APPEARANCE_PREF, useHostAppearance, useHostAppearanceStore } from "./use-host-appearance";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

const prefs: Record<string, unknown> = {};
const omp = {
	prefs: {
		get: vi.fn(async (key?: string) => (key === undefined ? prefs : prefs[key])),
		set: vi.fn(async (key: string, value: unknown) => {
			prefs[key] = value;
		}),
	},
	hostDesktop: {
		get: vi.fn(
			async (_device?: string): Promise<HostDesktopState> => ({
				version: "1.2.3",
				update: { state: "idle" },
				appearance: { themeName: "matcha", language: "ko" },
			}),
		),
		update: vi.fn(),
	},
};
Object.assign(window as unknown as Record<string, unknown>, { omp });

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
			confirmNewDevices: false,
		},
		hosts,
		forgotten: [],
	};
}

function focusTab(device?: string): void {
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/Users/kim/code/app", status: "ready", kind: "agent", unreadDone: false, device }],
		activeTabId: "t1",
	});
	setFocusedSessionRuntime("t1");
}

function Probe() {
	useHostAppearance();
	const t = useT();
	return <span data-probe>{t("common.cancel")}</span>;
}

let root: Root | null = null;

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

async function mount(): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<Probe />
			</I18nProvider>,
		);
	});
	await settle();
}

const probeText = () => document.body.querySelector("[data-probe]")?.textContent;
const shownAccent = () => document.documentElement.style.getPropertyValue("--omp-accent");

beforeEach(() => {
	for (const key of Object.keys(prefs)) delete prefs[key];
	Object.assign(prefs, { language: "en", themeName: "nord" });
	window.localStorage?.setItem("omp.lang", "en");
	omp.hostDesktop.get.mockClear();
	omp.prefs.set.mockClear();
	useRemoteStore.getState().apply(remoteState([{ deviceId: "dev-studio", name: "studio", state: "online" }]));
});

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	setLanguageOverride(null);
	useTabsStore.getState().reset();
	useRemoteStore.getState().reset();
	useHostAppearanceStore.setState({ enabled: false, loaded: false });
});

describe("useHostAppearance", () => {
	it("shows the focused host's theme and language without saving them, and restores the user's own", async () => {
		prefs[HOST_APPEARANCE_PREF] = true;
		focusTab("dev-studio");
		await mount();

		expect(omp.hostDesktop.get).toHaveBeenCalledWith("dev-studio");
		expect(probeText()).toBe("취소");
		// A host still on a retired id (matcha) shows as its successor.
		expect(shownAccent()).toBe(THEMES["solarized-light"].tokens["--omp-accent"]);
		expect(omp.prefs.set).not.toHaveBeenCalled();

		await act(async () => focusTab());
		await settle();
		expect(probeText()).toBe("Cancel");
		expect(shownAccent()).toBe(THEMES.nord.tokens["--omp-accent"]);
		expect(omp.prefs.set).not.toHaveBeenCalled();
	});

	it("leaves the user's own appearance for an offline host or with the switch off", async () => {
		focusTab("dev-studio");
		await mount();
		expect(omp.hostDesktop.get).not.toHaveBeenCalled();
		expect(probeText()).toBe("Cancel");

		await act(async () => {
			useRemoteStore.getState().apply(remoteState([{ deviceId: "dev-studio", name: "studio", state: "offline" }]));
			await useHostAppearanceStore.getState().setEnabled(true);
		});
		await settle();
		expect(prefs[HOST_APPEARANCE_PREF]).toBe(true);
		expect(omp.hostDesktop.get).not.toHaveBeenCalled();
		expect(probeText()).toBe("Cancel");
	});
});
