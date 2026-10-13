/**
 * Settings › Remote devices: the host role shows its addresses and pairing
 * code (copyable, with a countdown), an expired code refreshes on its own,
 * Remove revokes a paired device through main, and the keep-awake row shows
 * whether sleep is blocked now and toggles through setKeepAwake.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteState } from "../../../shared/ipc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useRemoteStore } from "../../stores/remote";
import { useToastStore } from "../../stores/toast";
import { RemoteSection } from "./RemoteSection";

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
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

function hostOn(overrides: Partial<RemoteState["host"]> = {}): RemoteState {
	return {
		host: {
			enabled: true,
			name: "studio",
			port: 47821,
			addresses: ["192.168.0.12:47821", "100.64.0.7:47821"],
			code: "K7QM-2XDP",
			expiresAt: Date.now() + 9 * 60_000 + 30_000,
			peers: [{ deviceId: "peer-laptop", name: "laptop", online: true, lastSeenAt: Date.now() - 60_000 }],
			keepAwake: true,
			keepingAwake: false,
			usedBy: [],
			...overrides,
		},
		hosts: [],
	};
}

const remote = {
	getState: vi.fn(async (): Promise<RemoteState> => hostOn()),
	setHostEnabled: vi.fn(async (enabled: boolean): Promise<RemoteState> => hostOn({ enabled })),
	setDeviceName: vi.fn(async (name: string): Promise<RemoteState> => hostOn({ name })),
	setKeepAwake: vi.fn(
		async (enabled: boolean): Promise<RemoteState> => hostOn({ keepAwake: enabled, keepingAwake: false, usedBy: [] }),
	),
	rotateCode: vi.fn(
		async (): Promise<RemoteState> => hostOn({ code: "NEW0-CODE", expiresAt: Date.now() + 10 * 60_000 }),
	),
	revokePeer: vi.fn(async (_deviceId: string): Promise<RemoteState> => hostOn({ peers: [] })),
	removeHost: vi.fn(async (_deviceId: string): Promise<RemoteState> => hostOn()),
	discover: vi.fn(async () => []),
	onDiscovered: vi.fn(() => () => {}),
	onState: vi.fn(() => () => {}),
	pair: vi.fn(),
	listDirs: vi.fn(),
};
Object.assign(window as unknown as Record<string, unknown>, { omp: { remote } });

const roots: Root[] = [];

async function mount(): Promise<void> {
	const root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<RemoteSection />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	roots.push(root);
}

function buttonLabeled(label: string): HTMLButtonElement | undefined {
	return (Array.from(document.body.querySelectorAll("button")) as HTMLButtonElement[]).find(
		button => button.getAttribute("aria-label") === label || (button.textContent ?? "").trim() === label,
	);
}

function keepAwakeRow(): Element | null {
	return document.body.querySelector("#settings-remote-keep-awake");
}

beforeEach(() => {
	remote.getState.mockImplementation(async () => hostOn());
});

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useToastStore.setState({ toasts: [] });
	useRemoteStore.getState().reset();
	vi.clearAllMocks();
});

describe("RemoteSection", () => {
	it("shows the addresses and the pairing code, each selectable and copyable, with a countdown", async () => {
		await mount();

		const text = document.body.textContent ?? "";
		expect(text).toContain(translate("remote.host.toggle"));
		for (const value of ["192.168.0.12:47821", "100.64.0.7:47821", "K7QM-2XDP"]) {
			const node = document.body.querySelector(`[data-copyable="${value}"]`);
			expect(node?.textContent).toBe(value);
			expect(node?.getAttribute("class")).toContain("select-all");
			expect(buttonLabeled(translate("remote.copy", { value }))).toBeDefined();
		}
		expect(document.body.querySelector("[data-remote-code-expiry]")?.textContent).toBe(
			translate("remote.host.expiresIn", { time: "9:30" }),
		);
		expect(document.body.querySelector('[data-remote-peer="peer-laptop"]')?.textContent).toContain("laptop");
		expect(remote.rotateCode).not.toHaveBeenCalled();
	});

	it("revokes a paired device through revokePeer", async () => {
		await mount();

		await act(async () => {
			buttonLabeled(translate("remote.removeLabel", { name: "laptop" }))?.click();
		});

		expect(remote.revokePeer).toHaveBeenCalledWith("peer-laptop");
		expect(document.body.querySelector("[data-remote-peer]")).toBeNull();
		expect(document.body.textContent).toContain(translate("remote.host.noPeers"));
	});

	it("replaces an expired code on its own, once", async () => {
		remote.getState.mockImplementation(async () => hostOn({ expiresAt: Date.now() - 1_000 }));
		await mount();
		await act(async () => {
			await Promise.resolve();
		});

		expect(remote.rotateCode).toHaveBeenCalledTimes(1);
		expect(document.body.querySelector('[data-copyable="NEW0-CODE"]')).not.toBeNull();
	});

	it("hides the host details while sharing is off", async () => {
		remote.getState.mockImplementation(async () =>
			hostOn({ enabled: false, code: null, expiresAt: null, port: null, addresses: [] }),
		);
		await mount();

		expect(document.body.textContent).toContain(translate("remote.host.toggle"));
		expect(document.body.querySelector("[data-remote-code]")).toBeNull();
		expect(document.body.querySelector("[data-remote-addresses]")).toBeNull();
		expect(keepAwakeRow()).toBeNull();
	});

	it("shows the keep-awake option on by default, with who keeps the computer awake now", async () => {
		remote.getState.mockImplementation(async () =>
			hostOn({ keepingAwake: true, usedBy: ["MacBook", "studio-mini"] }),
		);
		await mount();

		const row = keepAwakeRow();
		expect(row?.textContent).toContain(translate("remote.host.keepAwake"));
		expect(row?.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
		expect(row?.querySelector("[data-remote-keep-awake-state]")?.textContent).toBe(
			translate("remote.host.keepingAwakeFor", { names: "MacBook, studio-mini" }),
		);
	});

	it("explains the option while nothing keeps the computer awake, and turns it off through setKeepAwake", async () => {
		await mount();

		expect(keepAwakeRow()?.querySelector("[data-remote-keep-awake-state]")?.textContent).toBe(
			translate("remote.host.keepAwakeDesc"),
		);
		await act(async () => {
			(keepAwakeRow()?.querySelector('[role="switch"]') as HTMLButtonElement | null)?.click();
		});

		expect(remote.setKeepAwake).toHaveBeenCalledWith(false);
		expect(useRemoteStore.getState().state?.host.keepAwake).toBe(false);
		expect(keepAwakeRow()?.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
	});

	it("names a paired host's full folder on hover where the row truncates it", async () => {
		remote.getState.mockImplementation(async () => ({
			...hostOn(),
			hosts: [{ deviceId: "host-b", name: "Host B", state: "online", home: "/Users/someone-with-a-long-name" }],
		}));
		await mount();

		const home = document.querySelector('[data-remote-host="host-b"] [title="/Users/someone-with-a-long-name"]');
		expect(home?.textContent).toBe("/Users/someone-with-a-long-name");
	});
});
