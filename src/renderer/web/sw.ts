/**
 * The service worker the host serves at `/sw.js` (scope `/`; the build injects `__SW_BUILD__` and
 * `__SW_PRECACHE__`, see scripts/pwa-plugin.ts). It shows Web Push notifications, opens or focuses the page
 * on a click, and keeps a small versioned cache of the page shell so a reopened page paints before the
 * network answers. The logic is in sw-core.ts; this file only connects it to the worker's events.
 *
 * A new worker waits until the page asks (`skip-waiting`, after the user chose "Reload"), so a page is never
 * switched to a newer bundle under its feet; the first install activates at once.
 */
import {
	type ClientsLike,
	handleNotificationClick,
	handlePush,
	installShell,
	type NotificationLike,
	type PrecacheEntry,
	type PushRegistrationLike,
	pruneCaches,
	respondToFetch,
	type ShellDeps,
} from "./sw-core";

declare const __SW_BUILD__: string;
declare const __SW_PRECACHE__: readonly PrecacheEntry[];

interface WaitableEvent {
	waitUntil(promise: Promise<unknown>): void;
}

interface WorkerScope {
	registration: PushRegistrationLike;
	clients: ClientsLike & { claim(): Promise<void> };
	location: { origin: string };
	skipWaiting(): Promise<void>;
	addEventListener(type: "install" | "activate", listener: (event: WaitableEvent) => void): void;
	addEventListener(
		type: "push",
		listener: (event: WaitableEvent & { data: { json(): unknown } | null }) => void,
	): void;
	addEventListener(
		type: "notificationclick",
		listener: (event: WaitableEvent & { notification: NotificationLike }) => void,
	): void;
	addEventListener(
		type: "fetch",
		listener: (
			event: WaitableEvent & {
				request: { method: string; url: string; mode: string };
				respondWith(response: Promise<Response>): void;
			},
		) => void,
	): void;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

const scope = self as unknown as WorkerScope;
const shell = (): ShellDeps => ({
	build: __SW_BUILD__,
	precache: __SW_PRECACHE__,
	caches: caches as unknown as ShellDeps["caches"],
	fetch: (url, init) => fetch(url, init),
	origin: scope.location.origin,
});

scope.addEventListener("install", event => {
	event.waitUntil(installShell(shell()));
});

scope.addEventListener("activate", event => {
	event.waitUntil(Promise.all([pruneCaches(shell().caches, __SW_BUILD__), scope.clients.claim()]));
});

scope.addEventListener("push", event => {
	event.waitUntil(handlePush(event.data, scope.registration));
});

scope.addEventListener("notificationclick", event => {
	event.waitUntil(handleNotificationClick(event.notification, scope.clients));
});

scope.addEventListener("fetch", event => {
	const response = respondToFetch(event.request, shell(), promise => event.waitUntil(promise));
	if (response) event.respondWith(response);
});

scope.addEventListener("message", event => {
	const data = event.data;
	if (typeof data === "object" && data !== null && "type" in data && data.type === "skip-waiting") {
		void scope.skipWaiting();
	}
});
