/**
 * The desktop's confirmation of a phone's pairing request: it names the phone, offers the access presets,
 * Approve answers with the picked preset, Decline (and closing) refuses, and a request nobody answered drops out.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_GRANT_PRESETS, type WebPairingRequest } from "../../../shared/mobile-web";
import { DEFAULT_WEB_GRANTS } from "../../../shared/web-protocol";
import { I18nProvider, translate } from "../../lib/i18n";
import { fakeMobileWeb } from "../../test-support/mobile-web";
import { WebPairingDialog } from "./WebPairingDialog";

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

const REQUEST: WebPairingRequest = {
	id: "request-1",
	name: "Kim's iPhone",
	userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari",
	tailscaleLogin: "kim@example.com",
	ip: "100.64.0.9",
	grants: [...DEFAULT_WEB_GRANTS],
	expiresAt: Date.now() + 60_000,
};

async function mount(): Promise<void> {
	const root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<WebPairingDialog />
			</I18nProvider>,
		);
	});
	roots.push(root);
}

function buttonLabeled(label: string): HTMLButtonElement | undefined {
	return (Array.from(document.body.querySelectorAll("button")) as HTMLButtonElement[]).find(
		button => (button.textContent ?? "").trim() === label,
	);
}

beforeEach(() => {
	fake = fakeMobileWeb();
	Object.assign(window as unknown as Record<string, unknown>, { omp: { mobileWeb: fake.api } });
});

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	vi.clearAllMocks();
});

describe("WebPairingDialog", () => {
	it("renders nothing until a phone asks, then names it", async () => {
		await mount();
		expect(document.body.querySelector("[data-web-pairing-request]")).toBeNull();
		await act(async () => {
			fake.pushRequest(REQUEST);
		});
		const body = document.body.textContent ?? "";
		expect(body).toContain(translate("mobileWeb.request.title", { name: "Kim's iPhone" }));
		for (const value of [REQUEST.userAgent, "kim@example.com", "100.64.0.9"]) expect(body).toContain(value);
	});

	it("approves with the proposed preset", async () => {
		await mount();
		await act(async () => {
			fake.pushRequest(REQUEST);
		});
		await act(async () => {
			buttonLabeled(translate("mobileWeb.request.approve"))?.click();
		});
		expect(fake.api.pairing.respond).toHaveBeenCalledWith({
			id: "request-1",
			approve: true,
			grants: [...WEB_GRANT_PRESETS.full],
		});
		expect(document.body.querySelector("[data-web-pairing-request]")).toBeNull();
	});

	it("declines without grants", async () => {
		await mount();
		await act(async () => {
			fake.pushRequest(REQUEST);
		});
		await act(async () => {
			buttonLabeled(translate("mobileWeb.request.decline"))?.click();
		});
		expect(fake.api.pairing.respond).toHaveBeenCalledWith({ id: "request-1", approve: false });
	});

	it("queues a second request behind the first and drops one that expired unanswered", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		try {
			await mount();
			await act(async () => {
				fake.pushRequest({ ...REQUEST, expiresAt: Date.now() + 1_000 });
				fake.pushRequest({ ...REQUEST, id: "request-2", name: "Pixel" });
			});
			expect(document.body.textContent).toContain("Kim's iPhone");
			await act(async () => {
				vi.advanceTimersByTime(1_500);
			});
			expect(document.body.textContent).toContain(translate("mobileWeb.request.title", { name: "Pixel" }));
			expect(fake.api.pairing.respond).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
