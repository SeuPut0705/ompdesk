import { describe, expect, it, type Mock, vi } from "vitest";
import type { WebPushRequest, WebPushStateResponse } from "../../shared/web-push";
import {
	PushClient,
	type PushEnv,
	type PushManagerLike,
	type PushPermission,
	type PushSubscriptionLike,
	urlBase64ToBytes,
} from "./push-client";

const PUBLIC_KEY = "BAEC-w_-"; // base64url of 0x04 0x01 0x02 0xfb 0x0f 0xfe
const KEY_BYTES = [4, 1, 2, 251, 15, 254];
const SUBSCRIPTION_JSON = { endpoint: "https://push.example/abc", keys: { p256dh: "pk", auth: "au" } };

function hostState(overrides: Partial<WebPushStateResponse> = {}): WebPushStateResponse {
	return {
		publicKey: PUBLIC_KEY,
		subscribed: false,
		hideContent: false,
		categories: ["completion", "error", "ask"],
		...overrides,
	};
}

interface FakeSubscription extends PushSubscriptionLike {
	unsubscribe: Mock<() => Promise<boolean>>;
}

function fakeSubscription(key: number[] | null = null): FakeSubscription {
	return {
		endpoint: SUBSCRIPTION_JSON.endpoint,
		options: { applicationServerKey: key ? new Uint8Array(key).buffer : null },
		toJSON: () => SUBSCRIPTION_JSON,
		unsubscribe: vi.fn(async () => true),
	};
}

function setup(
	options: {
		permission?: PushPermission;
		asked?: PushPermission;
		existing?: FakeSubscription | null;
		host?: WebPushStateResponse;
		env?: Partial<PushEnv>;
	} = {},
) {
	let current = options.existing ?? null;
	let host = options.host ?? hostState();
	const requests: { method: string; body: WebPushRequest | null }[] = [];
	const events: string[] = [];
	const manager: PushManagerLike = {
		getSubscription: async () => current,
		subscribe: vi.fn(async (_options: { userVisibleOnly: true; applicationServerKey: Uint8Array<ArrayBuffer> }) => {
			events.push("subscribe");
			current = fakeSubscription(KEY_BYTES);
			return current;
		}),
	};
	let permission: PushPermission = options.permission ?? "default";
	const env: PushEnv = {
		fetch: async (input, init) => {
			events.push(`fetch ${init?.method}`);
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as WebPushRequest) : null;
			requests.push({ method: String(init?.method), body });
			if (input !== "/api/push") return new Response("no", { status: 404 });
			if (body) {
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
			events.push("permission");
			permission = options.asked ?? "granted";
			return permission;
		},
		pushManager: async () => manager,
		...options.env,
	};
	return { client: new PushClient(env), requests, events, manager, current: () => current };
}

describe("urlBase64ToBytes", () => {
	it("decodes the unpadded base64url VAPID key", () => {
		expect([...urlBase64ToBytes(PUBLIC_KEY)]).toEqual(KEY_BYTES);
	});
});

describe("PushClient availability", () => {
	it("explains why push cannot work", async () => {
		expect(setup({ env: { needsInstall: true } }).client.state.availability).toBe("needs-install");
		expect(setup({ env: { isSecureContext: false } }).client.state.availability).toBe("insecure");
		expect(setup({ env: { supported: false } }).client.state.availability).toBe("unsupported");
		expect(setup({ env: { hostPush: () => false } }).client.state.availability).toBe("host-off");
		expect(setup({ env: { hostPush: () => null } }).client.state.availability).toBe("ready");
	});

	it("neither asks nor calls the host when push is not available", async () => {
		const { client, requests, events } = setup({ env: { needsInstall: true } });
		expect((await client.load()).availability).toBe("needs-install");
		expect((await client.enable()).subscribed).toBe(false);
		expect(requests).toEqual([]);
		expect(events).toEqual([]);
	});
});

describe("PushClient.load", () => {
	it("reads the host's settings and requires the browser to still hold the subscription", async () => {
		const settings = hostState({ subscribed: true, hideContent: true, categories: ["ask"] });
		const withLocal = setup({ permission: "granted", existing: fakeSubscription(KEY_BYTES), host: settings });
		expect(await withLocal.client.load()).toMatchObject({ subscribed: true, hideContent: true, categories: ["ask"] });
		// The browser lost it (site data cleared): the computer's record is stale, the device is not subscribed.
		const lost = setup({ permission: "granted", existing: null, host: settings });
		expect((await lost.client.load()).subscribed).toBe(false);
		// Permission revoked in the browser's settings.
		const revoked = setup({ permission: "denied", existing: fakeSubscription(KEY_BYTES), host: settings });
		expect(await revoked.client.load()).toMatchObject({ subscribed: false, permission: "denied" });
	});

	it("rejects a refused or unreadable answer and keeps the last state", async () => {
		const bad = setup({ env: { fetch: async () => new Response("no", { status: 401 }) } });
		await expect(bad.client.load()).rejects.toThrow("401");
		const garbled = setup({ env: { fetch: async () => Response.json({ nope: true }) } });
		await expect(garbled.client.load()).rejects.toThrow("unreadable");
	});
});

describe("PushClient.enable", () => {
	it("asks for the permission before anything else, subscribes with the VAPID key and tells the host", async () => {
		const { client, events, requests, manager } = setup();
		const state = await client.enable();
		expect(events[0]).toBe("permission");
		expect(events).toEqual(["permission", "fetch GET", "subscribe", "fetch POST"]);
		expect(manager.subscribe).toHaveBeenCalledWith({
			userVisibleOnly: true,
			applicationServerKey: new Uint8Array(KEY_BYTES),
		});
		expect(requests.at(-1)).toEqual({ method: "POST", body: { subscription: SUBSCRIPTION_JSON } });
		expect(state).toMatchObject({ subscribed: true, permission: "granted" });
	});

	it("reuses a subscription that already has the host's key", async () => {
		const existing = fakeSubscription(KEY_BYTES);
		const { client, manager } = setup({ existing });
		await client.enable();
		expect(manager.subscribe).not.toHaveBeenCalled();
		expect(existing.unsubscribe).not.toHaveBeenCalled();
	});

	it("replaces a subscription made with an older VAPID key", async () => {
		const stale = fakeSubscription([9, 9, 9]);
		const { client, manager } = setup({ existing: stale });
		await client.enable();
		expect(stale.unsubscribe).toHaveBeenCalledTimes(1);
		expect(manager.subscribe).toHaveBeenCalledTimes(1);
	});

	it("reports a denied permission as a state and does not contact the host", async () => {
		const { client, requests, manager } = setup({ asked: "denied" });
		const state = await client.enable();
		expect(state).toMatchObject({ permission: "denied", subscribed: false });
		expect(requests).toEqual([]);
		expect(manager.subscribe).not.toHaveBeenCalled();
	});

	it("notifies listeners of each state", async () => {
		const { client } = setup();
		const seen = vi.fn();
		client.onChange(seen);
		await client.enable();
		expect(seen).toHaveBeenCalled();
		expect(client.state.subscribed).toBe(true);
	});
});

describe("PushClient.disable and configure", () => {
	it("tells the host to drop the subscription and unsubscribes the browser", async () => {
		const existing = fakeSubscription(KEY_BYTES);
		const { client, requests } = setup({ permission: "granted", existing, host: hostState({ subscribed: true }) });
		await client.load();
		const state = await client.disable();
		expect(requests.at(-1)).toEqual({ method: "POST", body: { subscription: null } });
		expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
		expect(state.subscribed).toBe(false);
	});

	it("saves hide-content and the categories", async () => {
		const { client, requests } = setup({
			permission: "granted",
			existing: fakeSubscription(KEY_BYTES),
			host: hostState({ subscribed: true }),
		});
		await client.load();
		expect((await client.configure({ hideContent: true })).hideContent).toBe(true);
		expect(requests.at(-1)?.body).toEqual({ hideContent: true });
		expect((await client.configure({ categories: ["ask"] })).categories).toEqual(["ask"]);
		expect(requests.at(-1)?.body).toEqual({ categories: ["ask"] });
	});
});
