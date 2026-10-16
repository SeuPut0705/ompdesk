import { describe, expect, it } from "vitest";
import { IPC_EVENTS } from "../../shared/ipc-types";
import { LocalChannels, parseOmpUrl, parseOpenHash } from "./deep-link";
import { signNonce } from "./device-key";
import { base64ToBytes, safeFileName, saveBlob } from "./download";
import { isNotificationClickMessage, notifyPage, registerServiceWorker } from "./notify";
import { defaultDeviceName, normalizePairCode } from "./pairing";
import { fetchTicket, UnpairedError } from "./session";
import { acceptFromFilters } from "./upload";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("fetchTicket", () => {
	it("takes the ticket from the first answer when the device has no key", async () => {
		const calls: unknown[] = [];
		const ticket = await fetchTicket({
			fetch: async (url, init) => {
				calls.push([url, init?.method, init?.body, init?.credentials]);
				return reply({ ticket: "T1", expiresAt: 1 });
			},
		});
		expect(ticket).toBe("T1");
		expect(calls).toEqual([["/api/session", "POST", "{}", "same-origin"]]);
	});

	it("signs the nonce with the device key in a second step", async () => {
		const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
		const bodies: unknown[] = [];
		const ticket = await fetchTicket({
			fetch: async (_url, init) => {
				const body = JSON.parse(String(init?.body)) as { nonce?: string; sig?: string };
				bodies.push(body);
				return body.nonce ? reply({ ticket: "T2" }) : reply({ nonce: "n-123" });
			},
			loadKey: async () => ({ privateKey: pair.privateKey }),
		});
		expect(ticket).toBe("T2");
		const second = bodies[1] as { nonce: string; sig: string };
		expect(second.nonce).toBe("n-123");
		// The host verifies base64url raw P1363 over the UTF-8 nonce with the public key it stored.
		const raw = Uint8Array.from(atob(second.sig.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
		expect(raw.byteLength).toBe(64);
		await expect(
			crypto.subtle.verify(
				{ name: "ECDSA", hash: "SHA-256" },
				pair.publicKey,
				raw,
				new TextEncoder().encode("n-123"),
			),
		).resolves.toBe(true);
	});

	it("signNonce answers base64url without padding", async () => {
		const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
		expect(await signNonce(pair.privateKey, "x")).toMatch(/^[A-Za-z0-9_-]{86}$/);
	});

	it("is unpaired on 401, and when the host wants a proof the browser cannot give", async () => {
		await expect(fetchTicket({ fetch: async () => reply({}, 401) })).rejects.toBeInstanceOf(UnpairedError);
		await expect(
			fetchTicket({ fetch: async () => reply({ nonce: "n" }), loadKey: async () => null }),
		).rejects.toBeInstanceOf(UnpairedError);
	});

	it("fails plainly on other statuses", async () => {
		await expect(fetchTicket({ fetch: async () => reply({}, 500) })).rejects.toThrow("500");
		await expect(fetchTicket({ fetch: async () => reply({}) })).rejects.toThrow("no session ticket");
	});
});

describe("page-made links", () => {
	it("reads #/open for notification clicks, links and a session handoff", () => {
		expect(parseOpenHash("#/open?tab=t7")).toEqual({ kind: "notification-click", payload: { tabId: "t7" } });
		expect(parseOpenHash("#/open?session=abc")).toEqual({
			kind: "deep-link",
			link: { action: "switch-session", sessionId: "abc" },
		});
		expect(parseOpenHash("#/open?new=1")).toEqual({ kind: "deep-link", link: { action: "new-session" } });
		expect(parseOpenHash("#/open?sessionPath=%2Fa%2Fb.jsonl")).toEqual({
			kind: "session-path",
			sessionPath: "/a/b.jsonl",
		});
		expect(parseOpenHash("#/other")).toBeNull();
		expect(parseOpenHash("#/open?x=1")).toBeNull();
	});

	it("reads omp:// the way main does", () => {
		expect(parseOmpUrl("omp://new")).toEqual({ action: "new-session" });
		expect(parseOmpUrl("omp://session/abc-1/")).toEqual({ action: "switch-session", sessionId: "abc-1" });
		expect(parseOmpUrl("omp://session")).toBeNull();
		expect(parseOmpUrl("https://x.test")).toBeNull();
		expect(parseOmpUrl("nope")).toBeNull();
	});

	it("holds an emission until the first listener subscribes", () => {
		const channels = new LocalChannels();
		channels.emit(IPC_EVENTS.DEEP_LINK, { a: 1 });
		channels.emit(IPC_EVENTS.DEEP_LINK, { a: 2 });
		const seen: unknown[] = [];
		channels.on(IPC_EVENTS.DEEP_LINK, data => seen.push(data));
		expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
		channels.emit(IPC_EVENTS.DEEP_LINK, { a: 3 });
		expect(seen).toHaveLength(3);
	});
});

describe("pairing helpers", () => {
	it("normalizes a typed code like the host", () => {
		expect(normalizePairCode("abcd-efgh")).toBe("ABCDEFGH");
		expect(normalizePairCode("0IL1 oo12")).toBe("01110012");
		expect(normalizePairCode("short")).toBeNull();
		expect(normalizePairCode("ABCDEFGU")).toBeNull();
	});

	it("names the device from its user agent", () => {
		expect(
			defaultDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Version/17 Mobile Safari/604"),
		).toBe("iPhone · Safari");
		expect(defaultDeviceName("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari/537")).toBe(
			"Android phone · Chrome",
		);
		expect(defaultDeviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X) Version/17 Safari/605", 5)).toBe(
			"iPad · Safari",
		);
		expect(defaultDeviceName("curl/8")).toBe("Browser");
	});
});

describe("downloads", () => {
	it("cleans a file name of paths and control characters", () => {
		expect(safeFileName("../../etc/pass\u0000wd")).toBe("passwd");
		expect(safeFileName("C:\\a\\b.txt")).toBe("b.txt");
		expect(safeFileName("  ")).toBe("download");
	});

	it("decodes base64", () => {
		expect(Array.from(base64ToBytes(btoa("hi")))).toEqual([104, 105]);
	});

	it("shares on a touch device that can share the file, and falls back to a download when it cannot", async () => {
		const shared: unknown[] = [];
		const nav = {
			canShare: () => true,
			share: async (data: unknown) => void shared.push(data),
		} as unknown as Navigator;
		const outcome = await saveBlob("a.txt", new Blob(["x"]), { navigator: nav, preferShare: () => true });
		expect(outcome).toBe("shared");
		expect(shared).toHaveLength(1);

		const clicks: string[] = [];
		const anchor = {
			click: () => clicks.push(anchor.download),
			remove: () => undefined,
			style: {},
		} as unknown as HTMLAnchorElement;
		const doc = { createElement: () => anchor, body: { append: () => undefined } } as unknown as Document;
		const revoked: string[] = [];
		const result = await saveBlob("b.txt", new Blob(["y"]), {
			navigator: { canShare: () => false, share: async () => undefined } as unknown as Navigator,
			preferShare: () => true,
			document: doc,
			url: { createObjectURL: () => "blob:1", revokeObjectURL: url => void revoked.push(url) },
			setTimer: callback => void callback(),
		});
		expect(result).toBe("downloaded");
		expect(clicks).toEqual(["b.txt"]);
		expect(revoked).toEqual(["blob:1"]);
	});

	it("reports a dismissed share sheet as cancelled, not a second download", async () => {
		const nav = {
			canShare: () => true,
			share: async () => {
				throw new DOMException("dismissed", "AbortError");
			},
		} as unknown as Navigator;
		await expect(saveBlob("a.txt", new Blob(["x"]), { navigator: nav, preferShare: () => true })).resolves.toBe(
			"cancelled",
		);
	});

	it("builds an accept list from Electron-style filters", () => {
		expect(acceptFromFilters([{ extensions: ["png", ".jpg"] }])).toBe(".png,.jpg");
		expect(acceptFromFilters([{ extensions: ["*"] }])).toBeUndefined();
		expect(acceptFromFilters(undefined)).toBeUndefined();
	});
});

describe("notifications", () => {
	const base = () => {
		const log: string[] = [];
		return {
			log,
			deps: {
				isVisible: () => true,
				permission: () => "granted" as const,
				registration: async () =>
					({
						showNotification: async (title: string, options: { tag?: string; data?: unknown }) => {
							log.push(`system:${title}:${options.tag}:${JSON.stringify(options.data)}`);
						},
					}) as unknown as ServiceWorkerRegistration,
				toast: (title: string, _body: string | undefined, onOpen: (() => void) | undefined) =>
					void log.push(`toast:${title}:${onOpen ? "open" : "-"}`),
				openTab: (tabId: string) => void log.push(`tab:${tabId}`),
			},
		};
	};

	it("toasts on a visible page, with an action that opens the tab", async () => {
		const { deps, log } = base();
		expect(await notifyPage(deps, "Done", "ok", "t1", "completion")).toBe("toast");
		expect(log).toEqual(["toast:Done:open"]);
		expect(await notifyPage(deps, "Done", undefined, undefined, undefined)).toBe("toast");
		expect(log.at(-1)).toBe("toast:Done:-");
	});

	it("shows a system notification through the service worker when hidden and allowed", async () => {
		const { deps, log } = base();
		expect(await notifyPage({ ...deps, isVisible: () => false }, "Needs you", "q", "t2", "ask")).toBe("system");
		expect(log).toEqual(['system:Needs you:t2:ask:{"tabId":"t2"}']);
	});

	it("drops it when hidden without permission or without a worker", async () => {
		const { deps } = base();
		expect(
			await notifyPage(
				{ ...deps, isVisible: () => false, permission: () => "denied" },
				"x",
				undefined,
				undefined,
				undefined,
			),
		).toBe("dropped");
		expect(
			await notifyPage(
				{ ...deps, isVisible: () => false, registration: async () => null },
				"x",
				undefined,
				undefined,
				undefined,
			),
		).toBe("dropped");
	});

	it("registers /sw.js only on a secure page that has service workers, and never throws", async () => {
		const registered: unknown[] = [];
		const nav = {
			serviceWorker: {
				register: async (url: string, options?: { scope?: string }) => {
					registered.push([url, options]);
					return {} as ServiceWorkerRegistration;
				},
				addEventListener: () => undefined,
			},
		};
		expect(await registerServiceWorker(nav, false)).toBeNull();
		expect(await registerServiceWorker({}, true)).toBeNull();
		expect(await registerServiceWorker(nav, true)).not.toBeNull();
		expect(registered).toEqual([["/sw.js", { scope: "/" }]]);
		const failing = {
			serviceWorker: { register: async () => Promise.reject(new Error("404")), addEventListener: () => undefined },
		};
		expect(await registerServiceWorker(failing, true)).toBeNull();
	});

	it("recognizes the worker's click message", () => {
		expect(isNotificationClickMessage({ type: "notification-click", payload: { tabId: "t" } })).toBe(true);
		expect(isNotificationClickMessage({ type: "notification-click", payload: {} })).toBe(false);
		expect(isNotificationClickMessage({ type: "other" })).toBe(false);
		expect(isNotificationClickMessage(null)).toBe(false);
	});
});
