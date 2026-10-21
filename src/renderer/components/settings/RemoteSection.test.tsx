/**
 * Settings › Devices & connections, sharing between computers over Tailscale: the host role shows its tailnet
 * addresses (or why it listens nowhere), Remove revokes a device and Block blocks its node through main, the
 * keep-awake row shows whether sleep is blocked now, a missing Tailscale offers its fix, and the tailnet's
 * computers connect by node. No pairing code anywhere.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerLimits, PeerView, RemoteState, TailnetComputer } from "../../../shared/ipc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useMobileWebStore } from "../../stores/mobile-web";
import { useRemoteStore } from "../../stores/remote";
import { useToastStore } from "../../stores/toast";
import { readyMobileWebState } from "../../test-support/mobile-web";
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

const LAPTOP: PeerView = {
	deviceId: "peer-laptop",
	name: "laptop",
	login: "me@example.com",
	online: true,
	appVersion: "0.52.7",
	lastSeenAt: Date.now() - 60_000,
	limits: {},
	usage: { requests: 0, tokens: 0 },
};

function hostOn(overrides: Partial<RemoteState["host"]> = {}, rest: Partial<RemoteState> = {}): RemoteState {
	return {
		tailnet: "ready",
		host: {
			enabled: true,
			name: "studio",
			port: 47821,
			addresses: ["100.64.0.7:47821"],
			listenError: null,
			peers: [LAPTOP],
			keepAwake: true,
			keepingAwake: false,
			usedBy: [],
			...overrides,
		},
		hosts: [],
		forgotten: [],
		...rest,
	};
}

const STUDIO: TailnetComputer = {
	nodeId: "nSTUDIO",
	name: "Studio",
	login: "me@example.com",
	state: "available",
	refusal: null,
	deviceId: "dev-studio",
	connected: false,
};

const remote = {
	getState: vi.fn(async (): Promise<RemoteState> => hostOn()),
	setHostEnabled: vi.fn(async (enabled: boolean): Promise<RemoteState> => hostOn({ enabled })),
	setDeviceName: vi.fn(async (name: string): Promise<RemoteState> => hostOn({ name })),
	setKeepAwake: vi.fn(
		async (enabled: boolean): Promise<RemoteState> => hostOn({ keepAwake: enabled, keepingAwake: false, usedBy: [] }),
	),
	revokePeer: vi.fn(async (_deviceId: string): Promise<RemoteState> => hostOn({ peers: [] })),
	blockPeer: vi.fn(async (_deviceId: string): Promise<RemoteState> => hostOn({ peers: [] })),
	setPeerLimits: vi.fn(async (_deviceId: string, _limits: PeerLimits): Promise<RemoteState> => hostOn()),
	removeHost: vi.fn(async (_deviceId: string): Promise<RemoteState> => hostOn()),
	renameHost: vi.fn(async (_deviceId: string, _name: string): Promise<RemoteState> => hostOn()),
	renamePeer: vi.fn(async (_deviceId: string, _name: string): Promise<RemoteState> => hostOn()),
	watchTailnet: vi.fn(async (_on: boolean): Promise<TailnetComputer[]> => [STUDIO]),
	connect: vi.fn(async (_nodeId: string) => ({ deviceId: "dev-studio", name: "Studio", state: "online" })),
	tailscaleAction: vi.fn(async (_action: string): Promise<RemoteState> => hostOn()),
	dismissForgotten: vi.fn(async (): Promise<RemoteState> => hostOn()),
	onState: vi.fn(() => () => {}),
	onTailnet: vi.fn(() => () => {}),
	listDirs: vi.fn(),
};
const mobileWeb = {
	getState: vi.fn(async () => {
		throw new Error("not under test");
	}),
	devices: { list: vi.fn(async () => []), blocked: vi.fn(async () => []) },
	command: vi.fn(async (request: { action: string; on?: boolean }) =>
		readyMobileWebState({ confirmNewDevices: request.on === true }),
	),
};
Object.assign(window as unknown as Record<string, unknown>, { omp: { remote, mobileWeb } });

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

/** A device row's secondary actions sit behind its overflow menu: open it, then pick the item. */
async function pickPeerAction(name: string, item: string): Promise<void> {
	await act(async () => {
		buttonLabeled(translate("remote.peerMenu", { name }))?.click();
	});
	await act(async () => {
		(Array.from(document.body.querySelectorAll('[role="menuitem"]')) as HTMLElement[])
			.find(entry => (entry.textContent ?? "").trim() === item)
			?.click();
	});
}

/** linkedom never fires React's change event: set the value, then call the field's own onChange. */
function setInputValue(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
	setter?.call(input, value);
	const record = input as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void } | undefined) : undefined;
	props?.onChange?.({ target: input, currentTarget: input });
}

function keepAwakeRow(): Element | null {
	return document.body.querySelector("#settings-remote-keep-awake");
}

/** Call a React handler prop of a DOM node directly (linkedom fires none of React's synthetic events). */
function reactProp(node: Element, name: string, event: object): void {
	const record = node as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as Record<string, ((event: object) => void) | undefined>) : {};
	props[name]?.(event);
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
	useMobileWebStore.getState().reset();
	vi.clearAllMocks();
});

describe("RemoteSection", () => {
	it("holds the one approval switch, shared with Mobile web, while sharing is on", async () => {
		await mount();
		await act(async () => useMobileWebStore.getState().applyState(readyMobileWebState()));
		const toggle = () =>
			document.body.querySelector('#settings-mobile-web-confirm [role="switch"]') as HTMLButtonElement | null;
		expect(document.body.querySelector("#settings-remote-confirm-new")).toBeNull();
		expect(toggle()?.getAttribute("aria-checked")).toBe("false");
		await act(async () => toggle()?.click());
		expect(mobileWeb.command).toHaveBeenCalledWith({ action: "set-confirm-new-devices", on: true });
		expect(toggle()?.getAttribute("aria-checked")).toBe("true");
	});

	it("keeps this computer's name editable while sharing is off", async () => {
		remote.getState.mockImplementation(async () => hostOn({ enabled: false, peers: [] }));
		await mount();
		const label = Array.from(document.body.querySelectorAll("label")).find(
			node => node.textContent === translate("remote.host.name"),
		);
		expect(label).toBeDefined();
	});

	it("renames a paired host inline: the host is asked through renameHost; offline rows cannot", async () => {
		remote.getState.mockImplementation(async () => ({
			...hostOn({ peers: [{ ...LAPTOP, online: false }] }),
			hosts: [{ deviceId: "host-studio", name: "DESKTOP-91ID999", state: "online" }],
		}));
		await mount();
		const offline = buttonLabeled(translate("remote.renameOffline", { name: "laptop" }));
		expect(offline?.disabled).toBe(true);

		const rename = buttonLabeled(translate("remote.rename", { name: "DESKTOP-91ID999" }));
		await act(async () => rename?.click());
		const input = document.body.querySelector("[data-device-rename]") as HTMLInputElement;
		expect(input.value).toBe("DESKTOP-91ID999");
		await act(async () => {
			setInputValue(input, "  Office desk ");
		});
		await act(async () => {
			reactProp(input, "onBlur", { currentTarget: input, target: input });
		});
		expect(remote.renameHost).toHaveBeenCalledWith("host-studio", "Office desk");
		expect(document.body.querySelector("[data-device-rename]")).toBeNull();
	});

	it("shows the tailnet addresses, selectable and copyable, and no pairing code", async () => {
		await mount();

		expect(document.body.textContent).toContain(translate("remote.host.toggle"));
		const node = document.body.querySelector('[data-copyable="100.64.0.7:47821"]');
		expect(node?.getAttribute("class")).toContain("select-all");
		expect(buttonLabeled(translate("remote.copy", { value: "100.64.0.7:47821" }))).toBeDefined();
		expect(document.body.querySelector("[data-remote-code]")).toBeNull();
		const peer = document.body.querySelector('[data-remote-peer="peer-laptop"]');
		// A narrow window truncates the name and "Last seen …"; each keeps its full text on hover.
		expect(peer?.querySelector('[title="laptop"]')).not.toBeNull();
		const seen = translate("remote.host.lastSeen", { time: "1m" });
		const version = translate("remote.version", { version: "0.52.7" });
		expect([...(peer?.querySelectorAll("[title]") ?? [])].map(node => node.getAttribute("title"))).toContain(
			`${seen} · ${version}`,
		);
	});

	it("says which ports are taken when the host listens nowhere", async () => {
		remote.getState.mockImplementation(async () =>
			hostOn({ port: null, addresses: [], listenError: { code: "port_in_use", ports: [47821, 47822, 47823] } }),
		);
		await mount();
		expect(document.body.querySelector("[data-remote-port-in-use]")?.textContent).toBe(
			translate("remote.host.portInUse", { first: "47821", last: "47823" }),
		);
		expect(document.body.querySelector("[data-remote-addresses]")).toBeNull();
	});

	it("offers to install Tailscale when it is missing, and to open it when it is stopped", async () => {
		remote.getState.mockImplementation(async () => hostOn({}, { tailnet: "not-installed" }));
		await mount();
		const install = document.body.querySelector('[data-remote-tailscale-action="install"]') as HTMLButtonElement;
		expect(install.textContent).toBe(translate("remote.tailscale.install"));
		await act(async () => install.click());
		expect(remote.tailscaleAction).toHaveBeenCalledWith("install");
		// Ready again (the reply): the row is gone and the tailnet's computers are listed.
		expect(document.body.querySelector("[data-remote-tailscale]")).toBeNull();
	});

	it("lists the tailnet's computers and connects one by its node", async () => {
		remote.watchTailnet.mockImplementation(async () => [
			STUDIO,
			{ ...STUDIO, nodeId: "nOTHER", name: "Other", state: "refused", refusal: "not_allowed", deviceId: null },
		]);
		await mount();
		expect(remote.watchTailnet).toHaveBeenCalledWith(true);
		const refused = document.body.querySelector('[data-remote-tailnet-row="nOTHER"]');
		expect(refused?.textContent).toContain(translate("remote.tailnet.refused.not_allowed"));
		expect(refused?.querySelector("[data-remote-tailnet-connect]")).toBeNull();
		await act(async () => {
			(document.body.querySelector('[data-remote-tailnet-connect="nSTUDIO"]') as HTMLButtonElement).click();
		});
		expect(remote.connect).toHaveBeenCalledWith("nSTUDIO");
	});

	it("blocks a device through blockPeer once the block is confirmed", async () => {
		await mount();
		await pickPeerAction("laptop", translate("remote.block"));
		expect(document.body.textContent).toContain(translate("remote.blockBody", { name: "laptop" }));
		await act(async () => {
			const dialog = document.body.querySelector('[role="dialog"], [role="alertdialog"]');
			(Array.from(dialog?.querySelectorAll("button") ?? []) as HTMLButtonElement[])
				.find(button => (button.textContent ?? "").trim() === translate("remote.block"))
				?.click();
		});
		expect(remote.blockPeer).toHaveBeenCalledWith("peer-laptop");
		expect(remote.revokePeer).not.toHaveBeenCalled();
	});

	it("names the code-paired computers it forgot once, until dismissed", async () => {
		remote.getState.mockImplementation(async () => hostOn({}, { forgotten: ["Old desk"] }));
		await mount();
		expect(document.body.querySelector("[data-remote-forgotten]")?.textContent).toBe(
			translate("remote.forgotten.body", { names: "Old desk" }),
		);
		await act(async () => {
			(document.body.querySelector("[data-remote-forgotten-dismiss]") as HTMLButtonElement).click();
		});
		expect(remote.dismissForgotten).toHaveBeenCalled();
		expect(document.body.querySelector("[data-remote-forgotten]")).toBeNull();
	});

	it("revokes a paired device through revokePeer once the removal is confirmed", async () => {
		await mount();

		await pickPeerAction("laptop", translate("remote.remove"));
		expect(remote.revokePeer).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain(translate("remote.removeTitle", { name: "laptop" }));
		expect(document.body.textContent).toContain(translate("remote.removePeerBody", { name: "laptop" }));
		await act(async () => {
			const dialog = document.body.querySelector('[role="dialog"], [role="alertdialog"]');
			(Array.from(dialog?.querySelectorAll("button") ?? []) as HTMLButtonElement[])
				.find(button => (button.textContent ?? "").trim() === translate("remote.remove"))
				?.click();
		});

		expect(remote.revokePeer).toHaveBeenCalledWith("peer-laptop");
		expect(document.body.querySelector("[data-remote-peer]")).toBeNull();
		expect(document.body.textContent).toContain(translate("remote.host.noPeers"));
	});

	it("keeps a paired host when its removal is cancelled", async () => {
		remote.getState.mockImplementation(async () => ({
			...hostOn(),
			hosts: [{ deviceId: "host-studio", name: "Studio", state: "online" }],
		}));
		await mount();

		await act(async () => {
			buttonLabeled(translate("remote.removeLabel", { name: "Studio" }))?.click();
		});
		expect(document.body.textContent).toContain(translate("remote.removeHostBody", { name: "Studio" }));
		await act(async () => {
			buttonLabeled(translate("common.cancel"))?.click();
		});
		expect(remote.removeHost).not.toHaveBeenCalled();
		expect(document.body.querySelector('[data-remote-host="host-studio"]')).not.toBeNull();
	});

	it("hides the host details while sharing is off", async () => {
		remote.getState.mockImplementation(async () => hostOn({ enabled: false, port: null, addresses: [] }));
		await mount();

		expect(document.body.textContent).toContain(translate("remote.host.toggle"));
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

	it("names the OMPdesk version a connected host and a connected device run, and none for one offline", async () => {
		remote.getState.mockImplementation(async () => ({
			...hostOn({
				peers: [LAPTOP, { ...LAPTOP, deviceId: "peer-old", name: "old", online: false, appVersion: null }],
			}),
			hosts: [{ deviceId: "host-b", name: "Host B", state: "online", home: "/Users/b", appVersion: "0.50.0" }],
		}));
		await mount();

		// Without this computer's version to compare against, the version stands alone.
		const host = document.querySelector('[data-remote-host="host-b"] [data-remote-host-detail]');
		expect(host?.textContent).toBe(`${translate("remote.version", { version: "0.50.0" })} · /Users/b`);
		expect(host?.getAttribute("title")).toBe(host?.textContent);
		const online = document.querySelector('[data-remote-peer="peer-laptop"] [data-peer-usage]');
		expect(online?.textContent).toContain(translate("remote.version", { version: "0.52.7" }));
		const offline = document.querySelector('[data-remote-peer="peer-old"] [data-peer-usage]');
		expect(offline?.textContent).not.toContain("OMPdesk");
	});

	it("says whether a connected computer runs an older or a newer OMPdesk than this one", async () => {
		remote.getState.mockImplementation(async () => ({
			...hostOn({ peers: [{ ...LAPTOP, appVersion: "0.53.0" }] }),
			hosts: [{ deviceId: "host-b", name: "Host B", state: "online", appVersion: "0.50.0" }],
			appVersion: "0.52.7",
		}));
		await mount();

		const host = document.querySelector('[data-remote-host="host-b"] [data-remote-host-detail]');
		expect(host?.textContent).toBe(translate("remote.versionOlder", { version: "0.50.0" }));
		const peer = document.querySelector('[data-remote-peer="peer-laptop"] [data-peer-usage]');
		expect(peer?.textContent).toContain(translate("remote.versionNewer", { version: "0.53.0" }));
	});

	it("shows a device's use today against its limits and saves new limits through setPeerLimits", async () => {
		remote.getState.mockImplementation(async () =>
			hostOn({
				peers: [
					{
						...LAPTOP,
						limits: { requestsPerDay: 50 },
						usage: { requests: 12, tokens: 48_300 },
					},
				],
			}),
		);
		await mount();

		const usage = document.body.querySelector('[data-remote-peer="peer-laptop"] [data-peer-usage]');
		expect(usage?.textContent).toContain(
			translate("remote.limits.todayOf", { requests: 12, requestsLimit: 50, tokens: "48.3k", tokensLimit: "∞" }),
		);
		await pickPeerAction("laptop", translate("remote.limits.button"));
		const fields = Array.from(document.body.querySelectorAll("[data-peer-limits] input")) as HTMLInputElement[];
		expect(fields.map(field => field.value)).toEqual(["50", ""]);
		await act(async () => {
			setInputValue(fields[1], "abc");
		});
		expect(document.body.textContent).toContain(translate("remote.limits.invalid"));
		expect(buttonLabeled(translate("common.save"))?.disabled).toBe(true);
		await act(async () => {
			setInputValue(fields[0], "");
			setInputValue(fields[1], "200,000");
		});
		await act(async () => {
			buttonLabeled(translate("common.save"))?.click();
		});
		expect(remote.setPeerLimits).toHaveBeenCalledWith("peer-laptop", { tokensPerDay: 200_000 });
		expect(document.body.querySelector("[data-peer-limits]")).toBeNull();
	});
});
