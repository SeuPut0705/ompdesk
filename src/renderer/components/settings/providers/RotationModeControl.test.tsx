/**
 * Settings › Models & providers › Account rotation: reads the machine's mode,
 * saves a new one through `window.omp.accountRotation` (to the paired host
 * when `device` names one), explains the chosen mode, disables even on an omp
 * that can't do it, and reverts with a toast when a save fails.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRotationMode, AccountRotationState } from "../../../../shared/account-rotation";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useRemoteStore } from "../../../stores/remote";
import { useToastStore } from "../../../stores/toast";
import { RotationModeControl } from "./RotationModeControl";

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

let state: AccountRotationState;
let failSet = false;
const accountRotation = {
	get: vi.fn(async (_device?: string): Promise<AccountRotationState> => state),
	set: vi.fn(async (mode: AccountRotationMode, _device?: string): Promise<AccountRotationState> => {
		if (failSet) throw new Error("bridge down");
		state = { ...state, mode };
		return state;
	}),
};
Object.assign(window as unknown as Record<string, unknown>, { omp: { accountRotation } });

const roots: Root[] = [];

async function mount(device?: string): Promise<void> {
	const root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<RotationModeControl device={device} />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	roots.push(root);
}

function option(mode: AccountRotationMode): HTMLButtonElement {
	const button = document.body.querySelector(`[data-rotation-mode="${mode}"]`) as HTMLButtonElement | null;
	if (!button) throw new Error(`${mode} option missing`);
	return button;
}

async function pick(mode: AccountRotationMode): Promise<void> {
	await act(async () => {
		option(mode).click();
	});
	await act(async () => {
		await Promise.resolve();
	});
}

function text(): string {
	return document.body.textContent ?? "";
}

beforeEach(() => {
	state = { mode: "quota", evenSupported: true };
	failSet = false;
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

describe("RotationModeControl", () => {
	it("shows this device's mode with its explanation and saves a switch to even", async () => {
		await mount();
		expect(accountRotation.get).toHaveBeenCalledWith(undefined);
		expect(option("quota").getAttribute("aria-checked")).toBe("true");
		expect(option("even").getAttribute("aria-checked")).toBe("false");
		expect(text()).toContain(translate("providers.rotation.label"));
		expect(text()).toContain(translate("providers.rotation.quotaDesc"));
		expect(text()).toContain(translate("providers.rotation.hint"));

		await pick("even");
		expect(accountRotation.set).toHaveBeenCalledWith("even", undefined);
		expect(option("even").getAttribute("aria-checked")).toBe("true");
		expect(text()).toContain(translate("providers.rotation.evenDesc"));
		expect(text()).not.toContain(translate("providers.rotation.quotaDesc"));

		// Choosing the current mode again saves nothing.
		await pick("even");
		expect(accountRotation.set).toHaveBeenCalledTimes(1);
	});

	it("reads and writes a paired host's own setting and says its sessions follow it", async () => {
		state = { mode: "even", evenSupported: true };
		await mount("host-b");
		expect(accountRotation.get).toHaveBeenCalledWith("host-b");
		expect(option("even").getAttribute("aria-checked")).toBe("true");
		expect(text()).toContain(translate("providers.rotation.host", { name: translate("remote.tab.unknownDevice") }));
		await pick("quota");
		expect(accountRotation.set).toHaveBeenCalledWith("quota", "host-b");
	});

	it("disables even on an omp without the feature and says why", async () => {
		state = { mode: "quota", evenSupported: false };
		await mount();
		expect(option("even").disabled).toBe(true);
		expect(text()).toContain(translate("providers.rotation.evenUnavailable"));
		await pick("even");
		expect(accountRotation.set).not.toHaveBeenCalled();
	});

	it("keeps the old mode and toasts when a save fails", async () => {
		failSet = true;
		await mount();
		await pick("even");
		expect(option("quota").getAttribute("aria-checked")).toBe("true");
		expect(useToastStore.getState().toasts.map(entry => entry.title)).toEqual([
			translate("providers.rotation.saveFailed"),
		]);
	});

	it("falls back to quota and toasts when the setting can't be read", async () => {
		accountRotation.get.mockRejectedValueOnce(new Error("link down"));
		await mount("host-b");
		expect(option("quota").getAttribute("aria-checked")).toBe("true");
		expect(useToastStore.getState().toasts.map(entry => entry.title)).toEqual([
			translate("providers.rotation.loadFailed"),
		]);
	});
});
