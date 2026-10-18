/**
 * The service worker's logic with every browser object injected (sw.ts wires the real `self`): the Web Push
 * handlers (a payload becomes a notification, `clear` closes the ones of its tag, a click focuses or opens the
 * page) and the bounded shell cache (what is precached, which requests the worker answers, which it never
 * touches). Nothing here reads a global, so the unit tests drive it with fakes.
 */
import { notificationOpenUrl, type WebPushKind, type WebPushPayload } from "../../shared/web-push";

const PUSH_KINDS: ReadonlySet<string> = new Set<WebPushKind>(["completion", "error", "ask", "batch", "clear"]);
/** The payload version this worker understands; any other is ignored (a newer host, an older worker). */
const PAYLOAD_VERSION = 1;

/** A push payload this worker understands, or null (unparsable, an unknown `v`, a missing field). */
export function parsePushPayload(value: unknown): WebPushPayload | null {
	if (typeof value !== "object" || value === null) return null;
	const raw = value as Record<string, unknown>;
	if (raw.v !== PAYLOAD_VERSION) return null;
	if (typeof raw.kind !== "string" || !PUSH_KINDS.has(raw.kind)) return null;
	if (typeof raw.title !== "string" || typeof raw.body !== "string" || typeof raw.tag !== "string") return null;
	if (raw.tabId !== undefined && typeof raw.tabId !== "string") return null;
	if (raw.silent !== undefined && typeof raw.silent !== "boolean") return null;
	return {
		v: PAYLOAD_VERSION,
		kind: raw.kind as WebPushKind,
		title: raw.title,
		body: raw.body,
		tag: raw.tag,
		...(raw.tabId ? { tabId: raw.tabId } : {}),
		...(raw.silent !== undefined ? { silent: raw.silent } : {}),
	};
}

export interface NotificationLike {
	tag: string;
	data?: unknown;
	close(): void;
}

export interface NotificationShowOptions {
	body: string;
	tag: string;
	silent: boolean;
	/** A replaced notification with the same tag alerts again unless it is silent. */
	renotify: boolean;
	icon: string;
	badge: string;
	data: { tabId?: string; url: string };
}

export interface PushRegistrationLike {
	showNotification(title: string, options: NotificationShowOptions): Promise<void>;
	getNotifications(filter?: { tag?: string }): Promise<NotificationLike[]>;
}

export const NOTIFICATION_ICON = "/icons/icon-192.png";
/** The status-bar badge (Android keeps only its alpha): the mark in one colour, `badge` of PWA_ICON_SVGS. */
export const NOTIFICATION_BADGE = "/icons/badge-96.png";

/** What a `push` event carries; unreadable data is ignored (nothing to show). */
export async function handlePush(
	data: { json(): unknown } | null,
	registration: PushRegistrationLike,
): Promise<"shown" | "cleared" | "ignored"> {
	let parsed: unknown;
	try {
		parsed = data?.json();
	} catch {
		return "ignored";
	}
	const payload = parsePushPayload(parsed);
	if (!payload) return "ignored";
	if (payload.kind === "clear") {
		// Retract only; a clear shows nothing (the ask was answered elsewhere).
		for (const shown of await registration.getNotifications({ tag: payload.tag })) shown.close();
		return "cleared";
	}
	const silent = payload.silent === true;
	await registration.showNotification(payload.title, {
		body: payload.body,
		tag: payload.tag,
		silent,
		renotify: !silent,
		icon: NOTIFICATION_ICON,
		badge: NOTIFICATION_BADGE,
		data: { ...(payload.tabId ? { tabId: payload.tabId } : {}), url: notificationOpenUrl(payload.tabId) },
	});
	return "shown";
}

export interface WindowClientLike {
	url: string;
	focused?: boolean;
	focus(): Promise<unknown>;
	postMessage(message: unknown): void;
}

export interface ClientsLike {
	matchAll(options: { type: "window"; includeUncontrolled: true }): Promise<readonly WindowClientLike[]>;
	openWindow(url: string): Promise<unknown>;
}

function dataOf(notification: NotificationLike): { tabId?: string; url?: string } {
	const data = notification.data;
	if (typeof data !== "object" || data === null) return {};
	const record = data as Record<string, unknown>;
	return {
		...(typeof record.tabId === "string" && record.tabId ? { tabId: record.tabId } : {}),
		...(typeof record.url === "string" ? { url: record.url } : {}),
	};
}

/** A click closes the notification, then focuses a page that is open (telling it the tab) or opens one. */
export async function handleNotificationClick(
	notification: NotificationLike,
	clients: ClientsLike,
): Promise<"focused" | "opened"> {
	notification.close();
	const { tabId, url } = dataOf(notification);
	const open = await clients.matchAll({ type: "window", includeUncontrolled: true });
	const target = open.find(client => client.focused) ?? open[0];
	if (target) {
		await target.focus();
		if (tabId) target.postMessage({ type: "notification-click", payload: { tabId } });
		return "focused";
	}
	await clients.openWindow(url ?? notificationOpenUrl(tabId));
	return "opened";
}

// ---- shell cache -----------------------------------------------------------------------------------------

export interface PrecacheEntry {
	url: string;
	size: number;
}

export interface PrecacheLimits {
	maxBytes: number;
	maxCount: number;
}

/** A shell is a few megabytes of eager chunks; anything past this stays on the network. */
export const PRECACHE_LIMITS: PrecacheLimits = { maxBytes: 8 * 1024 * 1024, maxCount: 80 };

/** The entries, in priority order, that fit the limits (an entry that would overflow the bytes is skipped). */
export function selectPrecache(entries: readonly PrecacheEntry[], limits: PrecacheLimits): PrecacheEntry[] {
	const chosen: PrecacheEntry[] = [];
	const seen = new Set<string>();
	let bytes = 0;
	for (const entry of entries) {
		if (seen.has(entry.url)) continue;
		if (chosen.length >= limits.maxCount) break;
		if (bytes + entry.size > limits.maxBytes) continue;
		seen.add(entry.url);
		chosen.push(entry);
		bytes += entry.size;
	}
	return chosen;
}

const CACHE_PREFIX = "omp-shell-";
/** The page the shell cache stands in for when the network is down. */
export const SHELL_URL = "/";
/** Never answered or stored by the worker: the API, the socket, blobs, uploads, the health probe. */
const NEVER_CACHED = ["/api/", "/ws", "/blob/", "/upload", "/healthz"] as const;

export function cacheNameFor(build: string): string {
	return `${CACHE_PREFIX}${build}`;
}

export interface CacheLike {
	match(key: string): Promise<Response | undefined>;
	put(key: string, response: Response): Promise<void>;
}

export interface CacheStorageLike {
	open(name: string): Promise<CacheLike>;
	keys(): Promise<string[]>;
	delete(name: string): Promise<boolean>;
}

export interface ShellDeps {
	build: string;
	/** Already limited (`selectPrecache`). */
	precache: readonly PrecacheEntry[];
	caches: CacheStorageLike;
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	origin: string;
}

const INSTALL_PARALLEL = 6;

/**
 * Fill this build's cache: the shell page and the eager assets. Best effort: one that fails is skipped. The page
 * revalidates (`reload`); the `/assets/` files are content-hashed and immutable, so the copy the page itself just
 * loaded into the HTTP cache is the same file and is taken from there instead of downloading the shell twice.
 */
export async function installShell(deps: ShellDeps): Promise<{ cached: number }> {
	const cache = await deps.caches.open(cacheNameFor(deps.build));
	const urls = [SHELL_URL, ...deps.precache.map(entry => entry.url)];
	let cached = 0;
	for (let start = 0; start < urls.length; start += INSTALL_PARALLEL) {
		await Promise.all(
			urls.slice(start, start + INSTALL_PARALLEL).map(async url => {
				try {
					const response = await deps.fetch(url, {
						cache: url === SHELL_URL ? "reload" : "default",
						credentials: "same-origin",
					});
					// The shell of an unpaired browser is a redirect or an error: not worth keeping.
					if (!response.ok || response.redirected) return;
					await cache.put(url, response);
					cached++;
				} catch {
					// Offline during install: the page works from the network.
				}
			}),
		);
	}
	return { cached };
}

/** Delete every shell cache but this build's. Returns the names removed. */
export async function pruneCaches(caches: CacheStorageLike, build: string): Promise<string[]> {
	const keep = cacheNameFor(build);
	const stale = (await caches.keys()).filter(name => name.startsWith(CACHE_PREFIX) && name !== keep);
	await Promise.all(stale.map(name => caches.delete(name)));
	return stale;
}

export interface FetchRequestLike {
	method: string;
	url: string;
	mode: string;
}

/**
 * How the worker answers a request, or null to leave it to the browser: hashed `/assets/` files that were
 * precached come from the cache first; the shell page (`/`) comes from the cache at once when this build has
 * it (it names exactly the assets this build precached) while a fetch refreshes the copy in the background
 * (`waitUntil` keeps the worker alive for it), and from the network otherwise. A newer host build reaches the
 * page through its new worker (sw-update.ts), as an installed app's always did. Everything else — the API,
 * the socket, blobs, uploads, other origins, other methods — is never touched.
 */
export function respondToFetch(
	request: FetchRequestLike,
	deps: ShellDeps,
	waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> | null {
	if (request.method !== "GET") return null;
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		return null;
	}
	if (url.origin !== deps.origin) return null;
	const path = url.pathname;
	if (NEVER_CACHED.some(prefix => path === prefix || path.startsWith(prefix) || path === prefix.replace(/\/$/, ""))) {
		return null;
	}
	const name = cacheNameFor(deps.build);
	if (path.startsWith("/assets/") && deps.precache.some(entry => entry.url === path)) {
		return (async () => {
			const cache = await deps.caches.open(name);
			return (await cache.match(path)) ?? (await deps.fetch(request.url));
		})();
	}
	if (request.mode === "navigate" && path === SHELL_URL) {
		return (async () => {
			const cache = await deps.caches.open(name);
			const refresh = deps.fetch(request.url).then(async response => {
				if (response.ok && !response.redirected) await cache.put(SHELL_URL, response.clone());
				return response;
			});
			const cached = await cache.match(SHELL_URL);
			if (!cached) return refresh;
			const settled = refresh.catch(() => undefined);
			waitUntil?.(settled);
			return cached;
		})();
	}
	return null;
}
