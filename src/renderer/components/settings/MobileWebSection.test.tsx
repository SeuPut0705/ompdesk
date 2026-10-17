/**
 * Settings › Mobile web: the switch sends enable/disable, each phase shows its one next step and sends the
 * right request, the page tells main it is open (`watch`) and nothing else on unmount, the ready state shows the
 * link with a big Copy button and one QR of it (no pairing code anywhere), the approval switch sends its request,
 * the connected devices rename, change their access tier and permissions, set limits and are blocked (the confirm
 * says when a whole login is blocked), the blocked ones are listed and unblocked, and the allowed users add and
 * remove.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileWebState } from "../../../shared/mobile-web";
import { DEFAULT_WEB_GRANTS } from "../../../shared/web-protocol";
import { I18nProvider, translate } from "../../lib/i18n";
import { useMobileWebStore } from "../../stores/mobile-web";
import { useToastStore } from "../../stores/toast";
import {
	blockedDevice,
	fakeMobileWeb,
	mobileWebState,
	readyMobileWebState,
	webDevice,
} from "../../test-support/mobile-web";
import { qrPath } from "../common/QrCode";
import { MobileWebSection } from "./MobileWebSection";

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

const openExternal = vi.fn(async (_url: string) => {});
let fake = fakeMobileWeb();
const roots: Root[] = [];

function install(next: typeof fake): void {
	fake = next;
	Object.assign(window as unknown as Record<string, unknown>, {
		omp: { mobileWeb: fake.api, system: { openExternal } },
	});
}

async function mount(): Promise<void> {
	const root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<MobileWebSection />
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

async function click(label: string): Promise<void> {
	const button = buttonLabeled(label);
	expect(button, `button "${label}"`).toBeDefined();
	await act(async () => {
		button?.click();
	});
}

type Handler = (event: object) => void;
type ReactProps = Partial<Record<"onChange" | "onBlur" | "onKeyDown" | "onSubmit", Handler>>;

/** React's own props of a rendered element: linkedom never fires events, so a test calls the handler. */
function reactProps(element: Element): ReactProps {
	const record = element as unknown as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	return key ? (record[key] as ReactProps) : {};
}

/** Set the value, then call the field's own onChange. */
function setInputValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
	setter?.call(input, value);
	reactProps(input).onChange?.({ target: input, currentTarget: input });
}

const requests = () => fake.api.command.mock.calls.map(call => call[0]);

beforeEach(() => {
	install(fakeMobileWeb());
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
	useMobileWebStore.getState().reset();
	vi.clearAllMocks();
});

describe("MobileWebSection switch and watch", () => {
	it("sends enable and disable from the switch", async () => {
		await mount();
		const toggle = () =>
			document.body.querySelector('#settings-mobile-web-toggle [role="switch"]') as HTMLButtonElement | null;
		expect(toggle()?.getAttribute("aria-checked")).toBe("false");
		fake.set(mobileWebState({ enabled: true, phase: "detecting" }));
		await act(async () => {
			toggle()?.click();
		});
		expect(requests()).toContainEqual({ action: "enable" });
		expect(toggle()?.getAttribute("aria-checked")).toBe("true");
		expect(document.body.querySelector('[data-mobile-web-phase="detecting"]')).not.toBeNull();
		fake.set(mobileWebState());
		await act(async () => {
			toggle()?.click();
		});
		expect(requests()).toContainEqual({ action: "disable" });
	});

	it("watches while mounted and, on unmount, only stops watching", async () => {
		await mount();
		expect(requests()).toEqual([{ action: "watch", on: true }]);
		fake.api.command.mockClear();
		fake.api.getState.mockClear();
		fake.api.devices.list.mockClear();
		fake.api.devices.blocked.mockClear();
		const root = roots.pop();
		await act(async () => {
			root?.unmount();
		});
		expect(requests()).toEqual([{ action: "watch", on: false }]);
		expect(fake.api.getState).not.toHaveBeenCalled();
		expect(fake.api.devices.list).not.toHaveBeenCalled();
		expect(fake.api.devices.blocked).not.toHaveBeenCalled();
	});

	it("follows a state push", async () => {
		await mount();
		await act(async () => {
			fake.pushState(mobileWebState({ enabled: true, phase: "starting" }));
		});
		expect(document.body.querySelector('[data-mobile-web-phase="starting"]')).not.toBeNull();
		expect(document.body.textContent).toContain(translate("mobileWeb.phase.starting"));
	});
});

describe("MobileWebSection phases", () => {
	const phaseCases: {
		name: string;
		state: Partial<MobileWebState>;
		button: string;
		request: object;
	}[] = [
		{
			name: "not-installed",
			state: {
				phase: "not-installed",
				install: { progress: null, failure: null, manualUrl: "https://tailscale.com/download" },
			},
			button: "mobileWeb.install",
			request: { action: "install" },
		},
		{
			name: "app-not-running",
			state: { phase: "app-not-running" },
			button: "mobileWeb.startApp",
			request: { action: "start-app" },
		},
		{
			name: "needs-os-approval",
			state: {
				phase: "needs-os-approval",
				tailscale: {
					variant: "mac-standalone",
					path: "/Applications/Tailscale.app",
					version: "1.104.1",
					updateAvailable: false,
				},
			},
			button: "mobileWeb.openSystemSettings",
			request: { action: "open-system-settings" },
		},
		{
			name: "needs-login",
			state: { phase: "needs-login", loginUrl: "https://login.tailscale.com/a/x" },
			button: "mobileWeb.signIn",
			request: { action: "login" },
		},
		{
			name: "logging-in",
			state: { phase: "logging-in" },
			button: "mobileWeb.reopenLogin",
			request: { action: "login" },
		},
		{
			name: "serve-blocked",
			state: { phase: "serve-blocked", detail: "serve is blocked by policy" },
			button: "common.retry",
			request: { action: "retry" },
		},
		{
			name: "error",
			state: { phase: "error", detail: "boom" },
			button: "common.retry",
			request: { action: "retry" },
		},
	];

	it.each(phaseCases)("$name shows its one next step and sends it", async ({ state, button, request }) => {
		fake.set(mobileWebState({ enabled: true, ...state }));
		await mount();
		fake.api.command.mockClear();
		await click(translate(button));
		expect(requests()).toEqual([request]);
	});

	it("shows the macOS guidance for the OS approval and none of it on Windows", async () => {
		fake.set(
			mobileWebState({
				enabled: true,
				phase: "needs-os-approval",
				tailscale: { variant: "mac-standalone", path: "p", version: null, updateAvailable: false },
			}),
		);
		await mount();
		expect(document.body.textContent).toContain(translate("mobileWeb.phase.needsOsApprovalMac"));
		await act(async () => {
			fake.pushState(
				mobileWebState({
					enabled: true,
					phase: "needs-os-approval",
					tailscale: { variant: "windows", path: "p", version: null, updateAvailable: false },
				}),
			);
		});
		expect(document.body.textContent).toContain(translate("mobileWeb.phase.needsOsApprovalWindows"));
		expect(buttonLabeled(translate("mobileWeb.openSystemSettings"))).toBeUndefined();
	});

	it("lets the sign-in wait be cancelled by turning Mobile web off", async () => {
		fake.set(mobileWebState({ enabled: true, phase: "logging-in" }));
		await mount();
		fake.api.command.mockClear();
		await click(translate("common.cancel"));
		expect(requests()).toEqual([{ action: "disable" }]);
	});

	it("shows the install's progress with Cancel while Tailscale installs", async () => {
		fake.set(
			mobileWebState({
				enabled: true,
				phase: "installing",
				install: {
					progress: {
						step: 1,
						steps: 1,
						startedAt: Date.now() - 5_000,
						download: { received: 1_048_576, total: 2_097_152 },
					},
					failure: null,
					manualUrl: "https://tailscale.com/download",
				},
			}),
		);
		await mount();
		const bar = document.body.querySelector('[data-mobile-web-install-progress] [role="progressbar"]');
		expect(bar?.getAttribute("aria-valuenow")).toBe("0.5");
		fake.api.command.mockClear();
		await click(translate("common.cancel"));
		expect(requests()).toEqual([{ action: "cancel-install" }]);
	});

	it("keeps an install failure's reason with Install again", async () => {
		fake.set(
			mobileWebState({
				enabled: true,
				phase: "not-installed",
				install: { progress: null, failure: { reason: "checksum" }, manualUrl: "https://tailscale.com/download" },
			}),
		);
		await mount();
		expect(document.body.textContent).toContain(translate("mobileWeb.installFailed"));
		expect(document.body.textContent).toContain(translate("machineSetup.reason.checksum"));
		await click(translate("mobileWeb.installManual"));
		expect(openExternal).toHaveBeenCalledWith("https://tailscale.com/download");
	});

	it("opens the admin page for a machine approval", async () => {
		fake.set(
			mobileWebState({
				enabled: true,
				phase: "needs-machine-approval",
				guideUrl: "https://login.tailscale.com/admin/machines",
			}),
		);
		await mount();
		expect(document.body.textContent).toContain(translate("mobileWeb.phase.needsMachineApprovalDesc"));
		await click(translate("mobileWeb.openAdmin"));
		expect(openExternal).toHaveBeenCalledWith("https://login.tailscale.com/admin/machines");
	});

	it("explains the certificate log for HTTPS, opens the admin page and offers the admin message", async () => {
		fake.set(
			mobileWebState({ enabled: true, phase: "https-disabled", guideUrl: "https://login.tailscale.com/admin/dns" }),
		);
		await mount();
		expect(document.body.textContent).toContain(translate("mobileWeb.phase.httpsDisabledDesc"));
		expect(document.body.querySelector("[data-mobile-web-admin-message]")?.textContent).toContain(
			translate("mobileWeb.adminMessage"),
		);
		expect(buttonLabeled(translate("mobileWeb.adminMessageCopy"))).toBeDefined();
		await click(translate("mobileWeb.enableHttps"));
		expect(openExternal).toHaveBeenCalledWith("https://login.tailscale.com/admin/dns");
	});

	it("keeps the tool's own words behind Details for a failure", async () => {
		fake.set(mobileWebState({ enabled: true, phase: "serve-blocked", detail: "serve is blocked by policy" }));
		await mount();
		const details = document.body.querySelector("[data-mobile-web-details]");
		expect(details?.tagName).toBe("DETAILS");
		expect(details?.textContent).toContain("serve is blocked by policy");
		expect(details?.hasAttribute("open")).toBe(false);
	});

	it("shows a red banner while the port is exposed by Funnel", async () => {
		fake.set(mobileWebState({ enabled: true, phase: "error", funnelExposed: true, detail: "x" }));
		await mount();
		const alert = Array.from(document.body.querySelectorAll('[role="alert"]')).find(node =>
			(node.textContent ?? "").includes(translate("mobileWeb.funnel.title")),
		);
		expect(alert).toBeDefined();
	});

	it("shows a Spinner and no button while it looks for Tailscale", async () => {
		fake.set(mobileWebState({ enabled: true, phase: "detecting" }));
		await mount();
		const panel = document.body.querySelector('[data-mobile-web-phase="detecting"]');
		expect(panel?.querySelector('[role="status"]')?.textContent).toContain(translate("mobileWeb.phase.detecting"));
		expect(panel?.querySelector("button")).toBeNull();
	});
});

describe("MobileWebSection ready", () => {
	it("shows the link and Tailscale steps, the connected phone and this account", async () => {
		fake.set(readyMobileWebState({ phones: ["Kim's iPhone"] }));
		await mount();
		const link = "https://studio.tail1234.ts.net:47831";
		expect(document.body.querySelector(`[data-copyable="${link}"]`)?.textContent).toBe(link);
		expect(document.body.textContent).toContain(translate("mobileWeb.step2", { user: "kim@example.com" }));
		expect(document.body.textContent).toContain(translate("mobileWeb.phoneConnected", { name: "Kim's iPhone" }));
		expect(document.body.textContent).toContain(translate("mobileWeb.step3"));
		const stores = Array.from(document.body.querySelectorAll("[data-mobile-web-store]")).map(node =>
			node.getAttribute("data-mobile-web-store"),
		);
		expect(stores).toEqual([
			"https://apps.apple.com/app/tailscale/id1470499037",
			"https://play.google.com/store/apps/details?id=com.tailscale.ipn",
		]);
		await click(translate("mobileWeb.download"));
		expect(openExternal).toHaveBeenCalledWith("https://tailscale.com/download");
	});

	it("waits for the phone to join Tailscale until one is connected", async () => {
		fake.set(readyMobileWebState());
		await mount();
		expect(document.body.textContent).toContain(translate("mobileWeb.phoneWaiting"));
		expect(document.body.querySelector("[data-mobile-web-phones]")).toBeNull();
	});

	it("copies the link with the big Copy button and says so for a moment", async () => {
		const writeText = vi.fn(async (_text: string) => {});
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		try {
			fake.set(readyMobileWebState());
			await mount();
			const button = document.body.querySelector("[data-mobile-web-copy]") as HTMLButtonElement | null;
			expect(button?.textContent).toContain(translate("mobileWeb.copyLink"));
			await act(async () => {
				button?.click();
			});
			expect(writeText).toHaveBeenCalledWith("https://studio.tail1234.ts.net:47831");
			expect(button?.getAttribute("data-copied")).not.toBeNull();
			expect(button?.textContent).toContain(translate("mobileWeb.linkCopied"));
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("shows one QR of the link and no pairing code, button or countdown", async () => {
		fake.set(readyMobileWebState());
		await mount();
		const codes = document.body.querySelectorAll("svg[data-qr-code]");
		// The link's QR, then the two Tailscale store QRs of step 1.
		expect(codes).toHaveLength(3);
		const qr = document.body.querySelector("[data-mobile-web-link] svg[data-qr-code]");
		expect(qr?.getAttribute("aria-label")).toBe(translate("mobileWeb.qr"));
		const expected = qrPath("https://studio.tail1234.ts.net:47831");
		expect(qr?.querySelector("path")?.getAttribute("d")).toBe(expected.path);
		expect(qr?.getAttribute("viewBox")).toBe(`0 0 ${expected.size} ${expected.size}`);
		expect(document.body.querySelector("[data-mobile-web-pairing]")).toBeNull();
		expect(document.body.querySelector("[data-mobile-web-pair]")).toBeNull();
		expect(document.body.querySelector("[data-mobile-web-code-expiry]")).toBeNull();
		expect(fake.api.pairing.respond).not.toHaveBeenCalled();
	});

	it("shows the approval switch off by default and sends its request", async () => {
		fake.set(readyMobileWebState());
		await mount();
		const toggle = () =>
			document.body.querySelector('#settings-mobile-web-confirm [role="switch"]') as HTMLButtonElement | null;
		expect(document.body.textContent).toContain(translate("mobileWeb.confirmNew"));
		expect(toggle()?.getAttribute("aria-checked")).toBe("false");
		fake.api.command.mockClear();
		fake.set(readyMobileWebState({ confirmNewDevices: true }));
		await act(async () => {
			toggle()?.click();
		});
		expect(requests()).toEqual([{ action: "set-confirm-new-devices", on: true }]);
		expect(toggle()?.getAttribute("aria-checked")).toBe("true");
		fake.set(readyMobileWebState({ confirmNewDevices: false }));
		await act(async () => {
			toggle()?.click();
		});
		expect(requests().at(-1)).toEqual({ action: "set-confirm-new-devices", on: false });
	});

	it("shows no approval switch while Mobile web is off", async () => {
		await mount();
		expect(document.body.querySelector("#settings-mobile-web-confirm")).toBeNull();
	});
});

describe("QR code", () => {
	it("draws a square quiet-zoned matrix whose size grows with the data", () => {
		const short = qrPath("https://a.ts.net:47831");
		const long = qrPath(`https://a.ts.net:47831/${"x".repeat(120)}`);
		expect(short.path.startsWith("M4 4")).toBe(true);
		expect(long.size).toBeGreaterThan(short.size);
	});
});

describe("MobileWebSection devices", () => {
	beforeEach(() => {
		fake.set(readyMobileWebState());
		fake.setDevices([
			webDevice(),
			webDevice({
				id: "device-ipad",
				name: "iPad",
				connected: false,
				lastSeenAt: null,
				tailscaleLogin: null,
				usage: { requests: 3, tokens: 1200 },
			}),
		]);
	});

	it("lists each device with its state, last seen, user and tier", async () => {
		await mount();
		const row = document.body.querySelector('[data-web-device="device-iphone"]');
		expect(row?.textContent).toContain("iPhone");
		expect(row?.textContent).toContain(translate("remote.state.online"));
		expect(row?.textContent).toContain(translate("mobileWeb.tier.full"));
		expect(row?.querySelector("[data-device-line]")?.textContent).toContain(
			translate("remote.host.lastSeen", { time: "2m" }),
		);
		expect(row?.querySelector("[data-device-line]")?.textContent).toContain(
			translate("mobileWeb.devices.user", { user: "kim@example.com" }),
		);
		const ipad = document.body.querySelector('[data-web-device="device-ipad"]');
		expect(ipad?.textContent).toContain(translate("remote.state.offline"));
		expect(ipad?.querySelector("[data-device-line]")?.textContent).toContain(translate("remote.host.neverSeen"));
		expect(ipad?.querySelector("[data-device-line]")?.textContent).toContain("3");
	});

	it("shows an empty note while nothing is connected", async () => {
		fake.setDevices([]);
		await mount();
		expect(document.body.textContent).toContain(translate("mobileWeb.devices.empty"));
	});

	it("changes the access tier to a preset through setGrants", async () => {
		await mount();
		const select = document.body.querySelector(
			'[data-web-device="device-iphone"] select[data-web-device-tier]',
		) as HTMLSelectElement;
		await act(async () => {
			reactProps(select).onChange?.({ target: { value: "chat-view" } });
		});
		expect(fake.api.devices.setGrants).toHaveBeenCalledWith("device-iphone", ["workspace", "device-self"]);
	});

	it("toggles one permission under the disclosure", async () => {
		await mount();
		const details = document.body.querySelector('[data-web-device="device-iphone"] [data-web-device-permissions]');
		expect(details?.tagName).toBe("DETAILS");
		const toggle = details?.querySelector(
			`[aria-label="${translate("mobileWeb.perm.label", { name: "iPhone", permission: translate("mobileWeb.perm.desktop-control") })}"]`,
		) as HTMLButtonElement | null;
		expect(toggle?.getAttribute("aria-checked")).toBe("true");
		await act(async () => {
			toggle?.click();
		});
		expect(fake.api.devices.setGrants).toHaveBeenCalledWith(
			"device-iphone",
			DEFAULT_WEB_GRANTS.filter(permission => permission !== "desktop-control"),
		);
	});

	it("renames a device when its field is left, and not after Escape", async () => {
		await mount();
		await click(translate("mobileWeb.devices.rename", { name: "iPhone" }));
		const input = document.body.querySelector('[data-web-device="device-iphone"] input') as HTMLInputElement;
		await act(async () => {
			setInputValue(input, " Kim's iPhone ");
			reactProps(input).onBlur?.({ currentTarget: input });
		});
		expect(fake.api.devices.rename).toHaveBeenCalledWith("device-iphone", "Kim's iPhone");

		fake.api.devices.rename.mockClear();
		await click(translate("mobileWeb.devices.rename", { name: "iPhone" }));
		const second = document.body.querySelector('[data-web-device="device-iphone"] input') as HTMLInputElement;
		await act(async () => {
			setInputValue(second, "Nope");
			reactProps(second).onKeyDown?.({ key: "Escape", currentTarget: second, preventDefault() {}, nativeEvent: {} });
			reactProps(second).onBlur?.({ currentTarget: second });
		});
		expect(fake.api.devices.rename).not.toHaveBeenCalled();
	});

	it("blocks a device only after the confirmation", async () => {
		await mount();
		await click(translate("mobileWeb.devices.revokeLabel", { name: "iPhone" }));
		expect(fake.api.devices.revoke).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain(translate("mobileWeb.devices.revokeTitle", { name: "iPhone" }));
		expect(document.body.textContent).toContain(translate("mobileWeb.devices.revokeBody", { name: "iPhone" }));
		expect(document.body.textContent).not.toContain("every device signed in as");
		fake.setDevices([webDevice({ id: "device-ipad", name: "iPad" })]);
		await act(async () => {
			const dialog = document.body.querySelector('[role="dialog"], [role="alertdialog"]');
			(Array.from(dialog?.querySelectorAll("button") ?? []) as HTMLButtonElement[])
				.find(button => (button.textContent ?? "").trim() === translate("mobileWeb.devices.revoke"))
				?.click();
		});
		expect(fake.api.devices.revoke).toHaveBeenCalledWith("device-iphone");
		expect(document.body.querySelector('[data-web-device="device-iphone"]')).toBeNull();
	});

	it("says every device of the login is blocked when Tailscale gave no node identity", async () => {
		fake.setDevices([webDevice({ blockScope: "login", tailscaleLogin: "kim@example.com" })]);
		await mount();
		await click(translate("mobileWeb.devices.revokeLabel", { name: "iPhone" }));
		expect(document.body.textContent).toContain(
			translate("mobileWeb.devices.revokeBodyLogin", { name: "iPhone", user: "kim@example.com" }),
		);
		expect(document.body.textContent).not.toContain(translate("mobileWeb.devices.revokeBody", { name: "iPhone" }));
	});

	it("keeps the device when the block is cancelled", async () => {
		await mount();
		await click(translate("mobileWeb.devices.revokeLabel", { name: "iPhone" }));
		await click(translate("common.cancel"));
		expect(fake.api.devices.revoke).not.toHaveBeenCalled();
		expect(document.body.querySelector('[data-web-device="device-iphone"]')).not.toBeNull();
	});

	it("saves new limits through setLimits", async () => {
		await mount();
		await click(translate("remote.limits.label", { name: "iPhone" }));
		const fields = Array.from(document.body.querySelectorAll("[data-peer-limits] input")) as HTMLInputElement[];
		await act(async () => {
			setInputValue(fields[0], "40");
		});
		await click(translate("common.save"));
		expect(fake.api.devices.setLimits).toHaveBeenCalledWith("device-iphone", { requestsPerDay: 40 });
	});

	it("follows a device push", async () => {
		await mount();
		await act(async () => {
			fake.pushDevices([webDevice({ id: "device-pixel", name: "Pixel" })]);
		});
		expect(document.body.querySelector('[data-web-device="device-pixel"]')).not.toBeNull();
		expect(document.body.querySelector('[data-web-device="device-iphone"]')).toBeNull();
	});
});

describe("MobileWebSection blocked devices", () => {
	beforeEach(() => {
		fake.set(readyMobileWebState());
		fake.setBlocked([
			blockedDevice(),
			blockedDevice({
				id: "login:lee@example.com",
				scope: "login",
				name: "Lee's phone",
				tailscaleLogin: "lee@example.com",
			}),
		]);
	});

	it("lists a blocked device and a blocked login, and nothing while there are none", async () => {
		await mount();
		const node = document.body.querySelector('[data-web-blocked="node:nPIXEL1"]');
		expect(node?.textContent).toContain("Pixel");
		expect(node?.textContent).toContain(translate("mobileWeb.blocked.node", { user: "kim@example.com" }));
		const login = document.body.querySelector('[data-web-blocked="login:lee@example.com"]');
		expect(login?.textContent).toContain(translate("mobileWeb.blocked.login", { user: "lee@example.com" }));
		for (const root of roots.splice(0)) {
			await act(async () => {
				root.unmount();
			});
		}
		useMobileWebStore.getState().reset();
		fake.setBlocked([]);
		await mount();
		expect(document.body.querySelector("[data-mobile-web-blocked]")).toBeNull();
	});

	it("unblocks through the device API and drops the entry", async () => {
		await mount();
		fake.setBlocked([blockedDevice({ id: "login:lee@example.com", scope: "login", name: "Lee's phone" })]);
		await click(translate("mobileWeb.blocked.unblockLabel", { name: "Pixel" }));
		expect(fake.api.devices.unblock).toHaveBeenCalledWith("node:nPIXEL1");
		expect(document.body.querySelector('[data-web-blocked="node:nPIXEL1"]')).toBeNull();
		expect(document.body.querySelector('[data-web-blocked="login:lee@example.com"]')).not.toBeNull();
	});

	it("reads the blocks again when the device list changes (a block was added or lifted)", async () => {
		await mount();
		fake.setBlocked([blockedDevice({ id: "node:nNEW", name: "Tablet" })]);
		await act(async () => {
			fake.pushDevices([]);
			await Promise.resolve();
		});
		expect(document.body.querySelector('[data-web-blocked="node:nNEW"]')).not.toBeNull();
		expect(document.body.querySelector('[data-web-blocked="node:nPIXEL1"]')).toBeNull();
	});
});

describe("MobileWebSection allowed users", () => {
	beforeEach(() => {
		fake.set(readyMobileWebState({ allowedUsers: ["kim@example.com", "lee@example.com"] }));
	});

	it("keeps this computer's own login and removes another", async () => {
		await mount();
		const own = document.body.querySelector('[data-mobile-web-user="kim@example.com"]');
		expect(own?.textContent).toContain(translate("mobileWeb.users.you"));
		expect(own?.querySelector("button")).toBeNull();
		fake.api.command.mockClear();
		await click(translate("mobileWeb.users.remove", { user: "lee@example.com" }));
		expect(requests()).toEqual([{ action: "set-allowed-users", users: ["kim@example.com"] }]);
	});

	/** linkedom never submits a form: call the form's own onSubmit, as Enter or the Add button would. */
	const submitUserForm = () =>
		act(async () => {
			const form = document.body.querySelector("[data-mobile-web-user-input]")?.closest("form");
			if (form) reactProps(form).onSubmit?.({ preventDefault() {} });
		});

	it("adds a login", async () => {
		await mount();
		const input = document.body.querySelector("[data-mobile-web-user-input]") as HTMLInputElement;
		await act(async () => {
			setInputValue(input, "  park@example.com ");
		});
		fake.api.command.mockClear();
		await submitUserForm();
		expect(requests()).toEqual([
			{ action: "set-allowed-users", users: ["kim@example.com", "lee@example.com", "park@example.com"] },
		]);
	});

	it("does not send a login that is already allowed", async () => {
		await mount();
		const input = document.body.querySelector("[data-mobile-web-user-input]") as HTMLInputElement;
		await act(async () => {
			setInputValue(input, "LEE@example.com");
		});
		fake.api.command.mockClear();
		await submitUserForm();
		expect(requests()).toEqual([]);
	});
});
