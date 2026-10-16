/**
 * The web page's Settings › Mobile web: this device's notification controls and the install guidance. The
 * real `PushClient` runs over a fake browser (permission, push manager, `/api/push`), so a click goes the whole
 * way: the permission prompt first, the subscription, the host's state back into the switches.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebPushRequest, WebPushStateResponse } from "../../../shared/web-push";
import { I18nProvider, translate } from "../../lib/i18n";
import { useToastStore } from "../../stores/toast";
import { type InstallEnvironment, InstallPrompt, installGuidance } from "../../web/install";
import { PushClient, type PushEnv, type PushPermission, type PushSubscriptionLike } from "../../web/push-client";
import { setWebPwa, type WebPwa } from "../../web/pwa";
import { MobileWebSection } from "./MobileWebSection";
import { WebNotificationsSection } from "./WebNotificationsSection";

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

const KEY = "BAEC-w_-";
const KEY_BYTES = new Uint8Array([4, 1, 2, 251, 15, 254]);
const JSON_SUB = { endpoint: "https://push.example/x", keys: { p256dh: "p", auth: "a" } };
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari";

interface Setup {
	pwa: WebPwa;
	asked: string[];
	posts: WebPushRequest[];
}

function build(
	options: {
		permission?: PushPermission;
		asked?: PushPermission;
		host?: Partial<WebPushStateResponse>;
		local?: boolean;
		env?: Partial<PushEnv>;
		install?: Partial<InstallEnvironment>;
	} = {},
): Setup {
	let permission: PushPermission = options.permission ?? "default";
	let subscription: PushSubscriptionLike | null = options.local
		? {
				endpoint: JSON_SUB.endpoint,
				options: { applicationServerKey: KEY_BYTES.buffer as ArrayBuffer },
				toJSON: () => JSON_SUB,
				unsubscribe: async () => true,
			}
		: null;
	let host: WebPushStateResponse = {
		publicKey: KEY,
		subscribed: false,
		hideContent: false,
		categories: ["completion", "error", "ask"],
		...options.host,
	};
	const asked: string[] = [];
	const posts: WebPushRequest[] = [];
	const env: PushEnv = {
		fetch: async (_input, init) => {
			if (typeof init?.body === "string") {
				const body = JSON.parse(init.body) as WebPushRequest;
				posts.push(body);
				host = {
					...host,
					subscribed: body.subscription === undefined ? host.subscribed : body.subscription !== null,
					hideContent: body.hideContent ?? host.hideContent,
					categories: body.categories ?? host.categories,
				};
			}
			return Response.json(host);
		},
		isSecureContext: true,
		needsInstall: false,
		supported: true,
		hostPush: () => true,
		permission: () => permission,
		requestPermission: async () => {
			asked.push("permission");
			permission = options.asked ?? "granted";
			return permission;
		},
		pushManager: async () => ({
			getSubscription: async () => subscription,
			subscribe: async () => {
				subscription = {
					endpoint: JSON_SUB.endpoint,
					options: { applicationServerKey: KEY_BYTES.buffer as ArrayBuffer },
					toJSON: () => JSON_SUB,
					unsubscribe: async () => true,
				};
				return subscription;
			},
		}),
		...options.env,
	};
	const target = { addEventListener: () => undefined };
	const install = new InstallPrompt(target);
	const environment = (): InstallEnvironment => ({
		userAgent: "Mozilla/5.0 (Macintosh)",
		platform: "MacIntel",
		maxTouchPoints: 0,
		standalone: false,
		...options.install,
	});
	const pwa: WebPwa = {
		push: new PushClient(env),
		install,
		environment,
		guidance: () => installGuidance(environment(), install.available),
		update: null,
	};
	return { pwa, asked, posts };
}

const roots: Root[] = [];

async function mount(node: React.ReactNode): Promise<void> {
	const root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(<I18nProvider>{node}</I18nProvider>);
	});
	await act(async () => {
		await Promise.resolve();
	});
	roots.push(root);
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
	vi.clearAllMocks();
});

const q = (selector: string) => document.body.querySelector(selector);

async function press(selector: string): Promise<void> {
	const button = q(selector) as HTMLButtonElement | null;
	expect(button, selector).not.toBeNull();
	await act(async () => {
		button?.click();
	});
}

const switchOf = (id: string) => q(`#${id} [role="switch"]`) as HTMLButtonElement | null;

describe("WebNotificationsSection", () => {
	it("turns notifications on from the click: permission first, then the subscription reaches the host", async () => {
		const { pwa, asked, posts } = build();
		await mount(<WebNotificationsSection pwa={pwa} />);
		expect(q('[data-web-push-state="off"]')).not.toBeNull();
		expect(switchOf("settings-web-push-hide")).toBeNull();
		await press("[data-web-push-enable]");
		expect(asked).toEqual(["permission"]);
		expect(posts).toEqual([{ subscription: JSON_SUB }]);
		expect(q('[data-web-push-state="on"]')).not.toBeNull();
		expect(switchOf("settings-web-push-hide")).not.toBeNull();
		expect(q("[data-web-push-disable]")).not.toBeNull();
	});

	it("saves hide-content and a category switch, and turns notifications off", async () => {
		const { pwa, posts } = build({ permission: "granted", local: true, host: { subscribed: true } });
		await mount(<WebNotificationsSection pwa={pwa} />);
		expect(q('[data-web-push-state="on"]')).not.toBeNull();
		await act(async () => {
			switchOf("settings-web-push-hide")?.click();
		});
		expect(posts.at(-1)).toEqual({ hideContent: true });
		expect(switchOf("settings-web-push-hide")?.getAttribute("aria-checked")).toBe("true");
		await act(async () => {
			switchOf("settings-web-push-error")?.click();
		});
		expect(posts.at(-1)).toEqual({ categories: ["completion", "ask"] });
		expect(switchOf("settings-web-push-error")?.getAttribute("aria-checked")).toBe("false");
		await press("[data-web-push-disable]");
		expect(posts.at(-1)).toEqual({ subscription: null });
		expect(q('[data-web-push-state="off"]')).not.toBeNull();
	});

	it("says the permission is blocked and keeps the button off", async () => {
		const { pwa, asked } = build({ permission: "denied" });
		await mount(<WebNotificationsSection pwa={pwa} />);
		expect(q("[data-web-push-denied]")?.textContent).toBe(translate("web.push.denied"));
		expect((q("[data-web-push-enable]") as HTMLButtonElement | null)?.disabled).toBe(true);
		expect(asked).toEqual([]);
	});

	it("shows the reason push is unavailable instead of controls", async () => {
		for (const [override, key] of [
			[{ isSecureContext: false }, "web.push.insecure"],
			[{ supported: false }, "web.push.unsupported"],
			[{ hostPush: () => false }, "web.push.hostOff"],
		] as const) {
			const { pwa } = build({ env: override });
			await mount(<WebNotificationsSection pwa={pwa} />);
			expect(document.body.textContent).toContain(translate(key));
			expect(q("[data-web-push-enable]")).toBeNull();
			await act(async () => {
				roots.pop()?.unmount();
			});
			while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
		}
	});

	it("tells iOS Safari users to add the page to the Home Screen (Share › Add to Home Screen)", async () => {
		const { pwa } = build({
			env: { needsInstall: true },
			install: { userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5 },
		});
		await mount(<WebNotificationsSection pwa={pwa} />);
		expect(q('[data-web-push-state="needs-install"]')).not.toBeNull();
		expect(document.body.textContent).toContain(translate("web.push.needsInstall"));
		expect(q('[data-web-install="ios-share"]')).not.toBeNull();
		expect(q("[data-web-install-steps]")?.textContent).toContain(translate("web.install.ios2"));
		expect(q("[data-web-push-enable]")).toBeNull();
	});

	it("says the app is installed when it runs standalone, and shows no install steps on desktop", async () => {
		const standalone = build({ install: { standalone: true } });
		await mount(<WebNotificationsSection pwa={standalone.pwa} />);
		expect(q('[data-web-install="installed"]')).not.toBeNull();
		await act(async () => {
			roots.pop()?.unmount();
		});
		while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
		await mount(<WebNotificationsSection pwa={build().pwa} />);
		expect(q("[data-web-install]")).toBeNull();
	});
});

describe("MobileWebSection on the web page", () => {
	it("shows only the device's own controls, not the computer's pairing and Tailscale panels", async () => {
		const { pwa } = build();
		setWebPwa(pwa);
		await mount(<MobileWebSection />);
		expect(q("[data-web-device-section]")).not.toBeNull();
		expect(q("[data-mobile-web-section]")).toBeNull();
	});
});
