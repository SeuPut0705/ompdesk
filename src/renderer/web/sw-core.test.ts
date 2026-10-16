import { describe, expect, it, type Mock, vi } from "vitest";
import type { WebPushPayload } from "../../shared/web-push";
import {
	type CacheLike,
	type CacheStorageLike,
	type ClientsLike,
	cacheNameFor,
	handleNotificationClick,
	handlePush,
	installShell,
	type NotificationLike,
	type NotificationShowOptions,
	PRECACHE_LIMITS,
	type PushRegistrationLike,
	parsePushPayload,
	pruneCaches,
	respondToFetch,
	type ShellDeps,
	selectPrecache,
	type WindowClientLike,
} from "./sw-core";

const PAYLOAD: WebPushPayload = {
	v: 1,
	kind: "completion",
	title: "Done",
	body: "my-repo finished",
	tabId: "t1",
	tag: "t1:completion",
};

function registration(shown: NotificationLike[] = []) {
	const showNotification = vi.fn(async (_title: string, _options: NotificationShowOptions) => undefined);
	const getNotifications = vi.fn(async (filter?: { tag?: string }) =>
		shown.filter(item => filter?.tag === undefined || item.tag === filter.tag),
	);
	return {
		api: { showNotification, getNotifications } satisfies PushRegistrationLike,
		showNotification,
		getNotifications,
	};
}

function notification(tag: string, data?: unknown): NotificationLike & { close: Mock } {
	return { tag, data, close: vi.fn() };
}

describe("parsePushPayload", () => {
	it("accepts the contract shape and drops anything else", () => {
		expect(parsePushPayload(PAYLOAD)).toEqual(PAYLOAD);
		expect(parsePushPayload({ ...PAYLOAD, v: 2 })).toBeNull();
		expect(parsePushPayload({ ...PAYLOAD, kind: "other" })).toBeNull();
		expect(parsePushPayload({ ...PAYLOAD, title: 3 })).toBeNull();
		expect(parsePushPayload({ ...PAYLOAD, tabId: 3 })).toBeNull();
		expect(parsePushPayload(null)).toBeNull();
		expect(parsePushPayload("text")).toBeNull();
	});
});

describe("handlePush", () => {
	it("shows the notification with tag, silent and the tab to open", async () => {
		const { api, showNotification } = registration();
		expect(await handlePush({ json: () => PAYLOAD }, api)).toBe("shown");
		expect(showNotification).toHaveBeenCalledWith("Done", {
			body: "my-repo finished",
			tag: "t1:completion",
			silent: false,
			renotify: true,
			icon: "/icons/icon-192.png",
			data: { tabId: "t1", url: "/#/open?tab=t1" },
		});
	});

	it("shows a silent replacement without alerting again", async () => {
		const { api, showNotification } = registration();
		await handlePush({ json: () => ({ ...PAYLOAD, silent: true }) }, api);
		expect(showNotification.mock.calls[0]?.[1]).toMatchObject({ silent: true, renotify: false });
	});

	it("shows only the title when the host hides content (empty body, no tab)", async () => {
		const { api, showNotification } = registration();
		const hidden = { ...PAYLOAD, body: "", tabId: undefined };
		await handlePush({ json: () => hidden }, api);
		expect(showNotification.mock.calls[0]).toEqual([
			"Done",
			expect.objectContaining({ body: "", data: { url: "/" } }),
		]);
	});

	it("closes the notifications with the tag on `clear` and shows nothing", async () => {
		const mine = notification("t1:ask");
		const other = notification("t2:ask");
		const { api, showNotification } = registration([mine, other]);
		const clear: WebPushPayload = { v: 1, kind: "clear", title: "", body: "", tag: "t1:ask" };
		expect(await handlePush({ json: () => clear }, api)).toBe("cleared");
		expect(mine.close).toHaveBeenCalledTimes(1);
		expect(other.close).not.toHaveBeenCalled();
		expect(showNotification).not.toHaveBeenCalled();
	});

	it("ignores an unknown payload version, unreadable data and an empty push", async () => {
		const { api, showNotification } = registration();
		expect(await handlePush({ json: () => ({ ...PAYLOAD, v: 9 }) }, api)).toBe("ignored");
		expect(
			await handlePush(
				{
					json: () => {
						throw new SyntaxError("bad json");
					},
				},
				api,
			),
		).toBe("ignored");
		expect(await handlePush(null, api)).toBe("ignored");
		expect(showNotification).not.toHaveBeenCalled();
	});
});

function client(url: string, focused = false) {
	const focus = vi.fn(async () => undefined);
	const postMessage = vi.fn();
	return { api: { url, focused, focus, postMessage } satisfies WindowClientLike, focus, postMessage };
}

function clients(open: WindowClientLike[]) {
	const openWindow = vi.fn(async () => undefined);
	const matchAll = vi.fn(async () => open);
	return { api: { matchAll, openWindow } satisfies ClientsLike, openWindow, matchAll };
}

describe("handleNotificationClick", () => {
	it("focuses an open page, preferring the focused one, and tells it the tab", async () => {
		const idle = client("https://mac.tail.ts.net:47831/");
		const front = client("https://mac.tail.ts.net:47831/", true);
		const { api, openWindow, matchAll } = clients([idle.api, front.api]);
		const clicked = notification("t1:completion", { tabId: "t1", url: "/#/open?tab=t1" });
		expect(await handleNotificationClick(clicked, api)).toBe("focused");
		expect(clicked.close).toHaveBeenCalled();
		expect(matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true });
		expect(front.focus).toHaveBeenCalled();
		expect(front.postMessage).toHaveBeenCalledWith({ type: "notification-click", payload: { tabId: "t1" } });
		expect(idle.focus).not.toHaveBeenCalled();
		expect(openWindow).not.toHaveBeenCalled();
	});

	it("only focuses when the notification names no tab (a batch)", async () => {
		const page = client("https://mac.tail.ts.net:47831/");
		const { api } = clients([page.api]);
		await handleNotificationClick(notification("batch", { url: "/" }), api);
		expect(page.focus).toHaveBeenCalled();
		expect(page.postMessage).not.toHaveBeenCalled();
	});

	it("opens the page at the open URL when none is open", async () => {
		const { api, openWindow } = clients([]);
		expect(await handleNotificationClick(notification("t1:ask", { tabId: "t1", url: "/#/open?tab=t1" }), api)).toBe(
			"opened",
		);
		expect(openWindow).toHaveBeenCalledWith("/#/open?tab=t1");
	});

	it("rebuilds the URL from the tab when the notification carries none", async () => {
		const { api, openWindow } = clients([]);
		await handleNotificationClick(notification("t 1", { tabId: "t 1" }), api);
		expect(openWindow).toHaveBeenCalledWith("/#/open?tab=t%201");
	});
});

describe("selectPrecache", () => {
	const entry = (url: string, size: number) => ({ url, size });

	it("keeps priority order, drops duplicates and caps the count", () => {
		const chosen = selectPrecache(
			[entry("/assets/a.js", 1), entry("/assets/b.js", 1), entry("/assets/a.js", 1), entry("/assets/c.js", 1)],
			{ maxBytes: 100, maxCount: 2 },
		);
		expect(chosen.map(item => item.url)).toEqual(["/assets/a.js", "/assets/b.js"]);
	});

	it("skips an entry that would pass the byte cap but still takes smaller ones after it", () => {
		const chosen = selectPrecache(
			[entry("/assets/a.js", 60), entry("/assets/big.js", 50), entry("/assets/s.js", 30)],
			{
				maxBytes: 100,
				maxCount: 10,
			},
		);
		expect(chosen.map(item => item.url)).toEqual(["/assets/a.js", "/assets/s.js"]);
	});

	it("has finite default limits", () => {
		expect(PRECACHE_LIMITS.maxBytes).toBeGreaterThan(0);
		expect(PRECACHE_LIMITS.maxCount).toBeGreaterThan(0);
	});
});

class FakeCache implements CacheLike {
	readonly store = new Map<string, Response>();
	async match(key: string): Promise<Response | undefined> {
		return this.store.get(key)?.clone();
	}
	async put(key: string, response: Response): Promise<void> {
		this.store.set(key, response);
	}
}

class FakeCaches implements CacheStorageLike {
	readonly named = new Map<string, FakeCache>();
	async open(name: string): Promise<CacheLike> {
		let cache = this.named.get(name);
		if (!cache) {
			cache = new FakeCache();
			this.named.set(name, cache);
		}
		return cache;
	}
	async keys(): Promise<string[]> {
		return [...this.named.keys()];
	}
	async delete(name: string): Promise<boolean> {
		return this.named.delete(name);
	}
}

function shellDeps(overrides: Partial<ShellDeps> = {}) {
	const caches = new FakeCaches();
	const network = vi.fn(async (url: string) => new Response(`net:${url}`, { status: 200 }));
	const deps: ShellDeps = {
		build: "b1",
		precache: [
			{ url: "/assets/web-aaa.js", size: 10 },
			{ url: "/assets/index-bbb.css", size: 10 },
		],
		caches,
		fetch: network,
		origin: "https://mac.tail.ts.net:47831",
		...overrides,
	};
	return { deps, caches, network };
}

const GET = (path: string, mode = "no-cors") => ({
	method: "GET",
	url: `https://mac.tail.ts.net:47831${path}`,
	mode,
});

describe("shell cache", () => {
	it("installs the shell page and the eager assets into this build's cache", async () => {
		const { deps, caches, network } = shellDeps();
		expect(await installShell(deps)).toEqual({ cached: 3 });
		expect([...(caches.named.get(cacheNameFor("b1"))?.store.keys() ?? [])].sort()).toEqual([
			"/",
			"/assets/index-bbb.css",
			"/assets/web-aaa.js",
		]);
		expect(network).toHaveBeenCalledWith("/", expect.objectContaining({ cache: "reload" }));
	});

	it("skips a file that fails or answers an error, without failing the install", async () => {
		const { deps, caches } = shellDeps({
			fetch: async (url: string) => {
				if (url === "/assets/web-aaa.js") throw new TypeError("offline");
				if (url === "/") return new Response("login", { status: 401 });
				return new Response("ok");
			},
		});
		expect(await installShell(deps)).toEqual({ cached: 1 });
		expect([...(caches.named.get(cacheNameFor("b1"))?.store.keys() ?? [])]).toEqual(["/assets/index-bbb.css"]);
	});

	it("deletes the caches of other builds and nothing else", async () => {
		const { caches } = shellDeps();
		await caches.open("omp-shell-old");
		await caches.open("omp-shell-b1");
		await caches.open("someone-elses");
		expect(await pruneCaches(caches, "b1")).toEqual(["omp-shell-old"]);
		expect(await caches.keys()).toEqual(["omp-shell-b1", "someone-elses"]);
	});

	it("answers a precached hashed asset from the cache, falling back to the network", async () => {
		const { deps, network } = shellDeps();
		await installShell(deps);
		network.mockClear();
		const hit = respondToFetch(GET("/assets/web-aaa.js"), deps);
		expect(await (await hit)?.text()).toBe("net:/assets/web-aaa.js");
		expect(network).not.toHaveBeenCalled();
		const miss = respondToFetch(GET("/assets/lazy-ccc.js"), deps);
		expect(miss).toBeNull();
	});

	it("serves a precached asset from the network when the cache lost it", async () => {
		const { deps, network } = shellDeps();
		const response = await respondToFetch(GET("/assets/web-aaa.js"), deps);
		expect(await response?.text()).toBe("net:https://mac.tail.ts.net:47831/assets/web-aaa.js");
		expect(network).toHaveBeenCalledTimes(1);
	});

	it("loads the shell network-first, stores it, and falls back to it offline", async () => {
		const { deps, caches, network } = shellDeps();
		const online = await respondToFetch(GET("/", "navigate"), deps);
		expect(await online?.text()).toBe("net:https://mac.tail.ts.net:47831/");
		expect(await caches.named.get(cacheNameFor("b1"))?.store.get("/")?.clone().text()).toBe(
			"net:https://mac.tail.ts.net:47831/",
		);
		network.mockRejectedValue(new TypeError("offline"));
		const offline = await respondToFetch(GET("/", "navigate"), deps);
		expect(await offline?.text()).toBe("net:https://mac.tail.ts.net:47831/");
	});

	it("rejects an offline shell load when nothing is cached", async () => {
		const { deps, network } = shellDeps();
		network.mockRejectedValue(new TypeError("offline"));
		await expect(respondToFetch(GET("/", "navigate"), deps)).rejects.toThrow("offline");
	});

	it("never touches the API, the socket, blobs, uploads, other methods, other origins or other pages", () => {
		const { deps } = shellDeps();
		for (const path of ["/api/push", "/api/session", "/ws", "/blob/abc", "/upload", "/healthz"]) {
			expect(respondToFetch(GET(path, "navigate"), deps)).toBeNull();
			expect(respondToFetch(GET(path), deps)).toBeNull();
		}
		expect(respondToFetch({ ...GET("/", "navigate"), method: "POST" }, deps)).toBeNull();
		expect(respondToFetch({ method: "GET", url: "https://elsewhere.example/", mode: "navigate" }, deps)).toBeNull();
		expect(respondToFetch(GET("/pair", "navigate"), deps)).toBeNull();
		expect(respondToFetch(GET("/manifest.webmanifest"), deps)).toBeNull();
		expect(respondToFetch({ method: "GET", url: "not a url", mode: "navigate" }, deps)).toBeNull();
	});
});
