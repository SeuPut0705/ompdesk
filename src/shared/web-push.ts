/**
 * Web Push contract between the host (src/main/web), the page (src/renderer/web) and the service worker
 * (src/renderer/web/sw.ts). Dependency-free: all three import it.
 */

/** What a push is about. `clear` retracts the notifications of a tab (its ask was answered elsewhere). */
export type WebPushKind = "completion" | "error" | "ask" | "batch" | "clear";

/** The categories a device may switch off (a `batch` follows its strongest member). */
export const WEB_PUSH_CATEGORIES = ["completion", "error", "ask"] as const;
export type WebPushCategory = (typeof WEB_PUSH_CATEGORIES)[number];

/** The JSON the host sends through the push service and the worker parses in its `push` handler. */
export interface WebPushPayload {
	/** Payload version; the worker ignores a payload it does not know. */
	v: 1;
	kind: WebPushKind;
	title: string;
	/** Empty when the device hides content. */
	body: string;
	/** The tab a click opens (`/#/open?tab=<id>`); absent for a batch with several tabs. */
	tabId?: string;
	/** Notifications with the same tag replace each other; `clear` closes the ones with its tag. */
	tag: string;
	/** Silent: shown without sound/vibration (a replaced or retracted one). */
	silent?: boolean;
}

/** A browser's `PushSubscription.toJSON()`, as far as the host needs it. */
export interface WebPushSubscriptionJson {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

/** The device's push settings the host stores on its record (`WebDevice.push`). */
export interface WebPushSettings {
	subscription: WebPushSubscriptionJson | null;
	/** Title only: no tab or session names, no text. Default off (title shows what happened). */
	hideContent: boolean;
	/** Categories delivered; all by default. */
	categories: readonly WebPushCategory[];
}

export const DEFAULT_WEB_PUSH_SETTINGS: WebPushSettings = {
	subscription: null,
	hideContent: false,
	categories: WEB_PUSH_CATEGORIES,
};

/**
 * `GET /api/push` (device auth) → {@link WebPushStateResponse}.
 * `POST /api/push` (device auth, JSON) with {@link WebPushRequest} → the same response; a `subscription: null`
 * unsubscribes. Rate limited like the other device routes.
 */
export interface WebPushRequest {
	subscription?: WebPushSubscriptionJson | null;
	hideContent?: boolean;
	categories?: readonly WebPushCategory[];
}

export interface WebPushStateResponse {
	/** The VAPID public key (base64url, uncompressed P-256 point) for `PushManager.subscribe`. */
	publicKey: string;
	subscribed: boolean;
	hideContent: boolean;
	categories: readonly WebPushCategory[];
}

/** The URL a notification click opens; the page's shim turns it into a `NotificationClickPayload`. */
export function notificationOpenUrl(tabId: string | undefined): string {
	return tabId ? `/#/open?tab=${encodeURIComponent(tabId)}` : "/";
}
