/**
 * The page's side of Web Push: the device's subscription and its notification settings, over `GET|POST
 * /api/push` (shared/web-push.ts). Everything the browser provides is injected (`PushEnv`), so the unit test
 * drives it with a fake `PushManager`.
 *
 * `enable()` must run straight from a click: the permission prompt needs the user gesture, and it is the first
 * thing `enable()` does (before any network call), because awaiting something else first loses the gesture on
 * Safari.
 */
import {
	WEB_PUSH_CATEGORIES,
	type WebPushCategory,
	type WebPushRequest,
	type WebPushStateResponse,
	type WebPushSubscriptionJson,
} from "../../shared/web-push";
import { translate } from "../lib/i18n";
import type { FetchLike } from "./session";

/** Why push can or cannot work on this page right now. */
export type PushAvailability =
	| "ready"
	/** iOS Safari in a tab: push needs the page added to the Home Screen first. */
	| "needs-install"
	/** Not HTTPS: no service worker, no push. */
	| "insecure"
	| "unsupported"
	/** The host does not offer push (`hello.features.push` is false). */
	| "host-off";

export type PushPermission = NotificationPermission | "unsupported";

export interface PushSubscriptionLike {
	endpoint: string;
	options?: { applicationServerKey?: ArrayBuffer | null };
	toJSON(): unknown;
	unsubscribe(): Promise<boolean>;
}

export interface PushManagerLike {
	getSubscription(): Promise<PushSubscriptionLike | null>;
	subscribe(options: {
		userVisibleOnly: true;
		applicationServerKey: Uint8Array<ArrayBuffer>;
	}): Promise<PushSubscriptionLike>;
}

export interface PushEnv {
	fetch: FetchLike;
	isSecureContext: boolean;
	/** iOS Safari that is not installed to the Home Screen. */
	needsInstall: boolean;
	/** Notification, PushManager and a service worker all exist. */
	supported: boolean;
	/** The host's `hello.features.push`; null before the first `hello` (treated as on). */
	hostPush: () => boolean | null;
	permission: () => PushPermission;
	requestPermission: () => Promise<PushPermission>;
	/** The worker's push manager; null while no worker is registered. */
	pushManager: () => Promise<PushManagerLike | null>;
}

export interface PushViewState {
	availability: PushAvailability;
	permission: PushPermission;
	/** The host stores this browser's subscription and the browser still has it. */
	subscribed: boolean;
	hideContent: boolean;
	categories: readonly WebPushCategory[];
}

const DEFAULT_VIEW: PushViewState = {
	availability: "unsupported",
	permission: "unsupported",
	subscribed: false,
	hideContent: false,
	categories: WEB_PUSH_CATEGORIES,
};

/** A VAPID public key (base64url) as the bytes `PushManager.subscribe` takes. */
export function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
	const base64 = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const raw = atob(base64);
	return Uint8Array.from(raw, char => char.charCodeAt(0));
}

function sameBytes(left: ArrayBuffer | null | undefined, right: Uint8Array<ArrayBuffer>): boolean {
	if (!left || left.byteLength !== right.byteLength) return false;
	const view = new Uint8Array(left);
	return view.every((byte, index) => byte === right[index]);
}

function isSubscriptionJson(value: unknown): value is WebPushSubscriptionJson {
	if (typeof value !== "object" || value === null) return false;
	if (!("endpoint" in value) || typeof value.endpoint !== "string") return false;
	if (!("keys" in value) || typeof value.keys !== "object" || value.keys === null) return false;
	return (
		"p256dh" in value.keys &&
		typeof value.keys.p256dh === "string" &&
		"auth" in value.keys &&
		typeof value.keys.auth === "string"
	);
}

function isStateResponse(value: unknown): value is WebPushStateResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		"publicKey" in value &&
		typeof value.publicKey === "string" &&
		"subscribed" in value &&
		typeof value.subscribed === "boolean" &&
		"hideContent" in value &&
		typeof value.hideContent === "boolean" &&
		"categories" in value &&
		Array.isArray(value.categories)
	);
}

export class PushClient {
	readonly #env: PushEnv;
	readonly #listeners = new Set<() => void>();
	#view: PushViewState = DEFAULT_VIEW;
	#host: WebPushStateResponse | null = null;

	constructor(env: PushEnv) {
		this.#env = env;
		this.#view = { ...DEFAULT_VIEW, availability: this.#availability(), permission: env.permission() };
	}

	get state(): PushViewState {
		return this.#view;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#availability(): PushAvailability {
		const env = this.#env;
		if (env.needsInstall) return "needs-install";
		if (!env.isSecureContext) return "insecure";
		if (!env.supported) return "unsupported";
		if (env.hostPush() === false) return "host-off";
		return "ready";
	}

	#set(next: Partial<PushViewState>): PushViewState {
		this.#view = { ...this.#view, ...next };
		for (const listener of [...this.#listeners]) listener();
		return this.#view;
	}

	async #request(method: "GET" | "POST", body?: WebPushRequest): Promise<WebPushStateResponse> {
		const response = await this.#env.fetch("/api/push", {
			method,
			credentials: "same-origin",
			cache: "no-store",
			...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
		});
		if (!response.ok) throw new Error(translate("web.push.error.refused", { status: response.status }));
		const parsed: unknown = await response.json();
		if (!isStateResponse(parsed)) throw new Error(translate("web.push.error.unreadable"));
		this.#host = parsed;
		return parsed;
	}

	/** Read the host's settings and this browser's subscription. Failures leave the last state and rethrow. */
	async load(): Promise<PushViewState> {
		const availability = this.#availability();
		const permission = this.#env.permission();
		if (availability !== "ready") return this.#set({ availability, permission, subscribed: false });
		const host = await this.#request("GET");
		const manager = await this.#env.pushManager();
		const local = manager ? await manager.getSubscription() : null;
		return this.#set({
			availability,
			permission,
			subscribed: host.subscribed && local !== null && permission === "granted",
			hideContent: host.hideContent,
			categories: host.categories,
		});
	}

	/**
	 * Ask for the permission, subscribe and tell the host. Call it from the click handler. Returns the new state;
	 * a denied permission is a state (`permission: "denied"`), not an error.
	 */
	async enable(): Promise<PushViewState> {
		const availability = this.#availability();
		if (availability !== "ready") return this.#set({ availability });
		const permission = await this.#env.requestPermission();
		if (permission !== "granted") return this.#set({ permission, subscribed: false });
		const host = this.#host ?? (await this.#request("GET"));
		const manager = await this.#env.pushManager();
		if (!manager) throw new Error(translate("web.push.error.worker"));
		const key = urlBase64ToBytes(host.publicKey);
		let subscription = await manager.getSubscription();
		const stored = subscription?.options?.applicationServerKey;
		if (subscription && stored && !sameBytes(stored, key)) {
			// The computer's VAPID key changed (a reset): the old subscription cannot receive its pushes.
			await subscription.unsubscribe();
			subscription = null;
		}
		subscription ??= await manager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
		const json = subscription.toJSON();
		if (!isSubscriptionJson(json)) throw new Error(translate("web.push.error.subscription"));
		const reply = await this.#request("POST", { subscription: json });
		return this.#set({
			permission,
			subscribed: reply.subscribed,
			hideContent: reply.hideContent,
			categories: reply.categories,
		});
	}

	/** Forget the subscription on the computer and in this browser. */
	async disable(): Promise<PushViewState> {
		const manager = await this.#env.pushManager();
		const local = manager ? await manager.getSubscription() : null;
		const reply = await this.#request("POST", { subscription: null });
		await local?.unsubscribe();
		return this.#set({ subscribed: false, hideContent: reply.hideContent, categories: reply.categories });
	}

	/** Change "hide content" or the categories; the computer keeps them with the device. */
	async configure(change: { hideContent?: boolean; categories?: readonly WebPushCategory[] }): Promise<PushViewState> {
		const reply = await this.#request("POST", change);
		return this.#set({ hideContent: reply.hideContent, categories: reply.categories });
	}
}
