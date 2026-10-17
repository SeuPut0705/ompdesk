/**
 * Notifications on a web page (ipc-policy `SYSTEM_NOTIFY` → "in-page toast or the service worker's
 * notification"), and the service worker's registration. A visible page shows a toast; a hidden one asks the
 * service worker to show a system notification when the user allowed them. Web Push itself (the subscription,
 * the worker's `push` handler, the manifest) is the PWA slice's: this registers `/sw.js` when the host serves
 * one and listens for the clicks it reports.
 */
import type { IpcNotifyKind, NotificationClickPayload } from "../../shared/ipc-types";
import { NOTIFICATION_BADGE, NOTIFICATION_ICON } from "./sw-core";

/** What the service worker posts to its pages when a notification is clicked (the page then routes it). */
export interface NotificationClickMessage {
	type: "notification-click";
	payload: NotificationClickPayload;
}

export function isNotificationClickMessage(value: unknown): value is NotificationClickMessage {
	if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "notification-click") {
		return false;
	}
	const payload = "payload" in value ? value.payload : null;
	return typeof payload === "object" && payload !== null && "tabId" in payload && typeof payload.tabId === "string";
}

export interface ServiceWorkerHost {
	serviceWorker?: {
		register(url: string, options?: { scope?: string }): Promise<ServiceWorkerRegistration>;
		addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
	};
}

/** Register `/sw.js` (HTTPS pages only). Null when the browser or the host has none; never throws. */
export async function registerServiceWorker(
	nav: ServiceWorkerHost = navigator,
	secure: boolean = typeof isSecureContext === "boolean" && isSecureContext,
): Promise<ServiceWorkerRegistration | null> {
	if (!secure || !nav.serviceWorker) return null;
	try {
		return await nav.serviceWorker.register("/sw.js", { scope: "/" });
	} catch {
		return null;
	}
}

/** Route the worker's click messages to `onClick`; returns the stop function. */
export function listenNotificationClicks(
	onClick: (payload: NotificationClickPayload) => void,
	nav: ServiceWorkerHost = navigator,
): void {
	nav.serviceWorker?.addEventListener("message", event => {
		if (isNotificationClickMessage(event.data)) onClick(event.data.payload);
	});
}

export interface NotifyDeps {
	isVisible: () => boolean;
	permission: () => NotificationPermission | "unsupported";
	registration: () => Promise<ServiceWorkerRegistration | null>;
	/** The in-page toast; `onOpen` runs from its action. */
	toast: (title: string, body: string | undefined, onOpen: (() => void) | undefined) => void;
	/** The page routes a click on `tabId` like a system notification's. */
	openTab: (tabId: string) => void;
}

/** Show one notification the way the page's state allows. Returns where it went. */
export async function notifyPage(
	deps: NotifyDeps,
	title: string,
	body: string | undefined,
	tabId: string | undefined,
	kind: IpcNotifyKind | undefined,
): Promise<"toast" | "system" | "dropped"> {
	if (deps.isVisible()) {
		deps.toast(title, body, tabId ? () => deps.openTab(tabId) : undefined);
		return "toast";
	}
	if (deps.permission() !== "granted") return "dropped";
	const registration = await deps.registration();
	if (!registration) return "dropped";
	await registration.showNotification(title, {
		body,
		// One notification per tab and kind: a newer one replaces the older.
		tag: tabId ? `${tabId}:${kind ?? "info"}` : (kind ?? "info"),
		icon: NOTIFICATION_ICON,
		badge: NOTIFICATION_BADGE,
		data: tabId ? { tabId } : undefined,
	});
	return "system";
}

/** Ask for the permission (a user gesture is required); resolves with the answer. */
export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
	if (typeof Notification === "undefined") return "unsupported";
	return await Notification.requestPermission();
}
