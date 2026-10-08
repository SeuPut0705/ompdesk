/**
 * Connect dialog: LAN discovery runs only while it is open, a discovered
 * device fills the address, a typed address works on its own, a wrong code
 * shows main's localized reason, and a successful pairing closes it.
 */

import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostView, IpcRemotePairPayload, RemoteDiscoveredDevice } from "../../../shared/ipc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useToastStore } from "../../stores/toast";
import { RemoteConnectDialog } from "./RemoteConnectDialog";

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

const studio: RemoteDiscoveredDevice = {
	deviceId: "dev-studio",
	name: "studio",
	address: "192.168.0.12:47821",
	paired: false,
};

let discoveredListener: ((devices: RemoteDiscoveredDevice[]) => void) | null = null;
const remote = {
	discover: vi.fn(
		async (action: "start" | "stop"): Promise<RemoteDiscoveredDevice[]> => (action === "start" ? [studio] : []),
	),
	onDiscovered: vi.fn((callback: (devices: RemoteDiscoveredDevice[]) => void) => {
		discoveredListener = callback;
		return () => {
			discoveredListener = null;
		};
	}),
	pair: vi.fn(
		async (payload: IpcRemotePairPayload): Promise<HostView> => ({
			deviceId: "dev-x",
			name: payload.address,
			state: "online",
		}),
	),
};
Object.assign(window as unknown as Record<string, unknown>, { omp: { remote } });

const roots: Root[] = [];
let closeCount = 0;

function Harness() {
	const [open, setOpen] = useState(true);
	return (
		<RemoteConnectDialog
			onClose={() => {
				closeCount++;
				setOpen(false);
			}}
			open={open}
		/>
	);
}

async function mount(): Promise<void> {
	const root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<Harness />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	roots.push(root);
}

/** Drive a React prop handler (onChange) directly; linkedom has no input events. */
async function type(selector: string, value: string): Promise<void> {
	const element = document.body.querySelector(selector);
	if (!element) throw new Error(`no ${selector}`);
	const record = element as unknown as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	const props = key ? (record[key] as { onChange?: (event: unknown) => void }) : undefined;
	await act(async () => props?.onChange?.({ target: { value } }));
}

function submitButton(): HTMLButtonElement {
	const button = document.body.querySelector("[data-remote-connect-submit]");
	if (!button) throw new Error("no submit");
	return button as unknown as HTMLButtonElement;
}

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useToastStore.setState({ toasts: [] });
	closeCount = 0;
	vi.clearAllMocks();
});

describe("RemoteConnectDialog", () => {
	it("discovers while open, lists devices live, and stops when it closes", async () => {
		await mount();

		expect(remote.discover).toHaveBeenCalledWith("start");
		expect(document.body.querySelector('[data-remote-device="dev-studio"]')).not.toBeNull();

		await act(async () => {
			discoveredListener?.([
				studio,
				{ deviceId: "dev-den", name: "den", address: "192.168.0.40:47821", paired: true },
			]);
		});
		const den = document.body.querySelector('[data-remote-device="dev-den"]');
		expect(den).not.toBeNull();
		expect(document.body.textContent).toContain(translate("remote.connect.paired"));

		// Picking a discovered device fills the address.
		await act(async () =>
			(document.body.querySelector('[data-remote-device="dev-studio"]') as HTMLButtonElement).click(),
		);
		expect((document.body.querySelector("[data-remote-address]") as HTMLInputElement).value).toBe(studio.address);

		await act(async () =>
			(
				Array.from(document.body.querySelectorAll("button")).find(
					button => (button.textContent ?? "").trim() === translate("common.cancel"),
				) as HTMLButtonElement
			).click(),
		);
		expect(closeCount).toBe(1);
		expect(remote.discover).toHaveBeenLastCalledWith("stop");
	});

	it("pairs with a typed address and closes on success", async () => {
		await mount();

		expect(submitButton().disabled).toBe(true);
		await type("[data-remote-address]", "100.64.0.7");
		await type("[data-remote-code]", "k7qm2xdp");
		expect((document.body.querySelector("[data-remote-code]") as HTMLInputElement).value).toBe("K7QM-2XDP");
		expect(submitButton().disabled).toBe(false);

		await act(async () => submitButton().click());

		expect(remote.pair).toHaveBeenCalledWith({ address: "100.64.0.7", code: "K7QM-2XDP" });
		expect(closeCount).toBe(1);
		expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
			translate("remote.connect.success", { name: "100.64.0.7" }),
		);
	});

	it("shows the localized wrong-code reason and stays open", async () => {
		remote.pair.mockRejectedValueOnce(
			new Error("Error invoking remote method 'remote:pair': Error: [remote_wrong_code] wrong code"),
		);
		await mount();
		await type("[data-remote-address]", "192.168.0.12:47821");
		await type("[data-remote-code]", "AAAA-BBBB");

		await act(async () => submitButton().click());

		const alert = document.body.querySelector("[data-remote-connect-error]")?.textContent ?? "";
		expect(alert).toContain(translate("ipcError.remote_wrong_code"));
		expect(alert).not.toContain(translate("remote.connect.failed"));
		expect(closeCount).toBe(0);
		expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
	});
});
