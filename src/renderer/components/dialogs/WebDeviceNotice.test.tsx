/**
 * The desktop's notice of a device that connected on its own: one quiet toast names it with a Block action, Block
 * revokes that device (main keeps it out), a failed block says so, and the notice stops listening on unmount.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { useToastStore } from "../../stores/toast";
import { fakeMobileWeb } from "../../test-support/mobile-web";
import { WebDeviceNotice } from "./WebDeviceNotice";

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

let fake = fakeMobileWeb();
const roots: Root[] = [];
const DEVICE = { id: "device-s25u", name: "SeuPut S25U", tailscaleLogin: "kim@example.com" };

async function mount(): Promise<void> {
	const root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<WebDeviceNotice />
			</I18nProvider>,
		);
	});
	roots.push(root);
}

beforeEach(() => {
	fake = fakeMobileWeb();
	Object.assign(window as unknown as Record<string, unknown>, { omp: { mobileWeb: fake.api } });
	useToastStore.setState({ toasts: [] });
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
	vi.clearAllMocks();
});

describe("WebDeviceNotice", () => {
	it("shows nothing until a device connects, then one toast that names it with a Block action", async () => {
		await mount();
		expect(useToastStore.getState().toasts).toEqual([]);
		await act(async () => {
			fake.pushConnected(DEVICE);
		});
		const [notice] = useToastStore.getState().toasts;
		expect(useToastStore.getState().toasts).toHaveLength(1);
		expect(notice?.message).toBe(translate("mobileWeb.notice.message", { name: "SeuPut S25U" }));
		expect(notice?.variant).toBe("info");
		expect(notice?.action?.label).toBe(translate("mobileWeb.notice.block"));
		// It does not block anything by itself.
		expect(fake.api.devices.revoke).not.toHaveBeenCalled();
	});

	it("blocks the device when Block is pressed", async () => {
		await mount();
		await act(async () => {
			fake.pushConnected(DEVICE);
		});
		await act(async () => {
			useToastStore.getState().toasts[0]?.action?.run();
		});
		expect(fake.api.devices.revoke).toHaveBeenCalledWith("device-s25u");
		expect(useToastStore.getState().toasts.some(toast => toast.variant === "error")).toBe(false);
	});

	it("says so when the block fails", async () => {
		fake.api.devices.revoke.mockRejectedValueOnce(new Error("gone"));
		await mount();
		await act(async () => {
			fake.pushConnected(DEVICE);
		});
		await act(async () => {
			useToastStore.getState().toasts[0]?.action?.run();
			await Promise.resolve();
		});
		const failure = useToastStore.getState().toasts.find(toast => toast.variant === "error");
		expect(failure?.title).toBe(translate("mobileWeb.notice.blockFailed"));
	});

	it("stops listening when it unmounts", async () => {
		await mount();
		const root = roots.pop();
		await act(async () => {
			root?.unmount();
		});
		await act(async () => {
			fake.pushConnected(DEVICE);
		});
		expect(useToastStore.getState().toasts).toEqual([]);
	});
});
