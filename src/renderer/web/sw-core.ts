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
/**
 * The other hashed `/assets/` files of this build the page fetched (lazy chunks: panels, Settings, a language,
 * mermaid…), kept as they arrive so a page older than the host's update still finds them; oldest out first.
 */
export const RUNTIME_LIMITS: PrecacheLimits = { maxBytes: 24 * 1024 * 1024, maxCount: 150 };
/** How long a failed asset fetch waits before its first retry. */
export const ASSET_RETRY_MS = 400;
/** How long the worker keeps retrying a hashed asset while the host does not answer or answers a 5xx. */
export const ASSET_OUTAGE_MS = 30_000;

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
const RUNTIME_PREFIX = "omp-assets-";
/** The page the shell cache stands in for when the network is down. */
export const SHELL_URL = "/";
/** Never answered or stored by the worker: the API, the socket, blobs, uploads, the health probe. */
const NEVER_CACHED = ["/api/", "/ws", "/blob/", "/upload", "/healthz"] as const;

export function cacheNameFor(build: string): string {
	return `${CACHE_PREFIX}${build}`;
}

export function runtimeCacheNameFor(build: string): string {
	return `${RUNTIME_PREFIX}${build}`;
}

export interface CacheLike {
	match(key: string): Promise<Response | undefined>;
	put(key: string, response: Response): Promise<void>;
	/** The stored requests, oldest first (the Cache API keeps insertion order). */
	keys(): Promise<readonly { url: string }[]>;
	delete(key: string): Promise<boolean>;
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
	/** The pause before a failed asset fetch is tried again (a timer in the worker). */
	wait?: (ms: number) => Promise<void>;
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

/** Delete every shell and asset cache but this build's. Returns the names removed. */
export async function pruneCaches(caches: CacheStorageLike, build: string): Promise<string[]> {
	const keep = new Set([cacheNameFor(build), runtimeCacheNameFor(build)]);
	const stale = (await caches.keys()).filter(
		name => (name.startsWith(CACHE_PREFIX) || name.startsWith(RUNTIME_PREFIX)) && !keep.has(name),
	);
	await Promise.all(stale.map(name => caches.delete(name)));
	return stale;
}

/** Drop the oldest kept assets until the cache fits `limits` (sizes from each copy's `content-length`). */
export async function trimRuntimeCache(cache: CacheLike, limits: PrecacheLimits): Promise<number> {
	const keys = await cache.keys();
	const sizes = await Promise.all(
		keys.map(async key => Number((await cache.match(key.url))?.headers.get("content-length") ?? 0) || 0),
	);
	let bytes = sizes.reduce((sum, size) => sum + size, 0);
	let count = keys.length;
	let dropped = 0;
	for (const [index, key] of keys.entries()) {
		if (count <= limits.maxCount && bytes <= limits.maxBytes) break;
		await cache.delete(key.url);
		bytes -= sizes[index] ?? 0;
		count--;
		dropped++;
	}
	return dropped;
}

/** The same hashed file in any build's cache: names change with content, so another build's copy is this one. */
async function matchAnyBuild(caches: CacheStorageLike, path: string): Promise<Response | undefined> {
	for (const name of await caches.keys()) {
		if (!name.startsWith(CACHE_PREFIX) && !name.startsWith(RUNTIME_PREFIX)) continue;
		const hit = await (await caches.open(name)).match(path);
		if (hit) return hit;
	}
	return undefined;
}

/**
 * A hashed `/assets/` file: this build's cache first (precached, or kept when the page last fetched it), then the
 * network, once more after `ASSET_RETRY_MS` when that failed, then any other build's copy. While the host does not
 * answer or answers a 5xx (a host restarting for an update, a phone between networks) it keeps trying, waiting
 * longer each time, for up to `ASSET_OUTAGE_MS`: a page's lazy import that got an error stays failed for the page's
 * life (a browser keeps a failed module, and every view built on it opened empty until a reload). A 404 (a chunk the
 * host really lacks) gives up after the one retry. A file fetched whole is kept for the next time (`RUNTIME_LIMITS`,
 * oldest out first), so a page loaded before the host updated still finds the chunks it already used; the host also
 * serves the previous builds' assets for a while (main/web/asset-archive.ts).
 */
async function respondWithAsset(
	path: string,
	url: string,
	deps: ShellDeps,
	waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
	const precached = deps.precache.some(entry => entry.url === path);
	const shell = await deps.caches.open(cacheNameFor(deps.build));
	const kept = await deps.caches.open(runtimeCacheNameFor(deps.build));
	const hit = (precached ? await shell.match(path) : undefined) ?? (await kept.match(path));
	if (hit) return hit;
	const wait = deps.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const attempt = () => deps.fetch(url).catch((error: unknown) => error);
	const failed = (result: unknown) => !(result instanceof Response) || !result.ok;
	const outage = (result: unknown) => !(result instanceof Response) || result.status >= 500;
	let result = await attempt();
	if (failed(result)) {
		await wait(ASSET_RETRY_MS);
		result = await attempt();
	}
	if (failed(result)) {
		const elsewhere = await matchAnyBuild(deps.caches, path);
		if (elsewhere) return elsewhere;
		let waited = ASSET_RETRY_MS;
		for (let pause = ASSET_RETRY_MS * 2; outage(result) && waited < ASSET_OUTAGE_MS; pause *= 2) {
			const next = Math.min(pause, ASSET_OUTAGE_MS - waited);
			await wait(next);
			waited += next;
			result = await attempt();
		}
	}
	if (result instanceof Response && result.ok) {
		if (!precached && result.status === 200 && !result.redirected) {
			const keep = kept.put(path, result.clone()).then(() => trimRuntimeCache(kept, RUNTIME_LIMITS));
			if (waitUntil) waitUntil(keep.catch(() => undefined));
			else await keep.catch(() => undefined);
		}
		return result;
	}
	if (result instanceof Response) return result;
	throw result;
}

export interface FetchRequestLike {
	method: string;
	url: string;
	mode: string;
}

/**
 * How the worker answers a request, or null to leave it to the browser: hashed `/assets/` files through
 * `respondWithAsset` (this build's cache, the network with one retry, kept as fetched); the shell page (`/`) comes
 * from the cache at once when this build has it (it names exactly the assets this build precached) while a fetch
 * refreshes the copy in the background (`waitUntil` keeps the worker alive for it), and from the network otherwise.
 * A newer host build reaches the page through its new worker (sw-update.ts), as an installed app's always did.
 * Everything else — the API, the socket, blobs, uploads, other origins, other methods — is never touched.
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
	if (path.startsWith("/assets/")) return respondWithAsset(path, request.url, deps, waitUntil);
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
