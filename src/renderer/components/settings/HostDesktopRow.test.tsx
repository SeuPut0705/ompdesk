/**
 * B26: Settings › Updates on a paired host's tab shows OMPdesk on that host —
 * its version and updater state — and runs Check, Download and Install &
 * restart there; a refused install toasts the host's reason.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDesktopState, HostUpdateAction, UpdateStatus } from "../../../shared/ipc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useToastStore } from "../../stores/toast";
import { HostDesktopRow } from "./UpdatesSection";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

function hostState(update: UpdateStatus): HostDesktopState {
	return { version: "1.2.3", update, appearance: { themeName: null, language: null } };
}

let current = hostState({ state: "available", version: "1.3.0", mode: "relaunch" });
const hostDesktop = {
	get: vi.fn(async (_device?: string) => current),
	update: vi.fn(async (action: HostUpdateAction, _device?: string): Promise<HostDesktopState> => {
		if (action === "download") current = hostState({ state: "downloaded", version: "1.3.0", mode: "relaunch" });
		// Electron rethrows a coded main error as an Error whose message carries `[code]`.
		if (action === "install") throw new Error("Error invoking remote method: [host_busy] Work is running");
		return current;
	}),
};
Object.assign(window as unknown as Record<string, unknown>, { omp: { hostDesktop } });

let root: Root | null = null;

async function mount(): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<HostDesktopRow deviceId="dev-studio" />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
}

function button(label: string): HTMLButtonElement | undefined {
	return (Array.from(document.body.querySelectorAll("button")) as HTMLButtonElement[]).find(
		candidate => (candidate.textContent ?? "").trim() === label,
	);
}

async function click(label: string): Promise<void> {
	await act(async () => {
		button(label)?.click();
	});
	await act(async () => {
		await Promise.resolve();
	});
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useToastStore.setState({ toasts: [] });
	hostDesktop.get.mockClear();
	hostDesktop.update.mockClear();
	current = hostState({ state: "available", version: "1.3.0", mode: "relaunch" });
});

describe("HostDesktopRow", () => {
	it("downloads and installs the host's update there, and toasts the host's refusal", async () => {
		await mount();
		expect(hostDesktop.get).toHaveBeenCalledWith("dev-studio");
		expect(document.body.querySelector("[data-host-desktop-version]")?.textContent).toContain("1.2.3");
		expect(document.body.querySelector("[data-host-desktop-version]")?.textContent).toContain("1.3.0");

		await click(translate("updates.host.download"));
		expect(hostDesktop.update).toHaveBeenCalledWith("download", "dev-studio");

		await click(translate("updates.host.install"));
		expect(hostDesktop.update).toHaveBeenCalledWith("install", "dev-studio");
		const toasts = useToastStore.getState().toasts;
		expect(toasts.at(-1)?.title).toBe(translate("updates.host.actionFailed"));
		expect(JSON.stringify(toasts.at(-1))).toContain(translate("ipcError.host_busy"));
	});

	it("offers a check when the host is up to date and points a manual installer at the host", async () => {
		current = hostState({ state: "not-available", version: "1.2.3" });
		await mount();
		expect(document.body.textContent).toContain(translate("updates.upToDate"));
		await click(translate("updates.host.check"));
		expect(hostDesktop.update).toHaveBeenCalledWith("check", "dev-studio");

		await act(async () => {
			root?.unmount();
		});
		current = hostState({ state: "downloaded", version: "1.3.0", mode: "manual" });
		await mount();
		expect(button(translate("updates.host.install"))).toBeUndefined();
		expect(document.body.textContent).toContain(translate("updates.host.manualHint"));
	});
});
