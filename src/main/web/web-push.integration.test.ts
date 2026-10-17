/**
 * Web Push end to end on the host: the real WebHost (server, router, device store, VAPID store, sender, notifier)
 * and the real SidecarPool, with a fake omp per tab and a fake push service where the network would be. A phone
 * pairs over HTTP, subscribes through `POST /api/push`, and connects a WebSocket; a tab finishing or asking then
 * produces exactly the pushes the rules allow. Only Electron, omp and the push service are faked.
 */
import { createECDH, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { WEB_PAIRING_REQUEST, type WebPairingRequest } from "../../shared/mobile-web";
import type { WebPushPayload, WebPushStateResponse } from "../../shared/web-push";
import { SidecarPool } from "../sidecar-pool";
import type { SidecarLike } from "../sidecar-types";
import type { ClientWindow } from "./client-window";
import type { IpcCaller } from "./ipc-registry";
import type { PushTransport } from "./push";
import { WebHost } from "./web-host";
import { COMPLETION_DEBOUNCE_MS } from "./web-push-notifier";

/** A stand-in for one tab's omp: only what the pool listens to. */
class FakeOmp extends EventEmitter {
	currentStatus = "asleep";
	statusFromLink = false;
	constructor(public cwd: string) {
		super();
	}
	get status() {
		return this.currentStatus;
	}
	adoptCwd(): boolean {
		return false;
	}
	start(): void {
		this.emitStatus("starting");
	}
	restart(): void {
		this.emitStatus("starting");
	}
	kill(): void {}
	dispose(): void {
		this.removeAllListeners();
	}
	whenExited(): Promise<void> {
		return Promise.resolve();
	}
	async sendSideChannel(): Promise<void> {}
	emitStatus(status: string): void {
		this.currentStatus = status;
		this.emit("status", { status, cwd: this.cwd });
	}
	startTurn(): void {
		this.emit("events", [{ type: "agent_start" }]);
	}
	endTurn(reply: string, stopReason = "stop"): void {
		this.emit("events", [
			{ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: reply }], stopReason }] },
		]);
	}
	ask(id: string, title: string): void {
		this.emit("extensionUi", { type: "extension_ui_request", id, method: "confirm", title, message: "" });
	}
}

function fakeWindow(id: number): ClientWindow {
	const emitter = new EventEmitter();
	return {
		webContents: { id, send: () => undefined },
		isDestroyed: () => false,
		once: (event: "closed", listener: () => void) => emitter.once(event, listener),
		removeListener: (event: "closed", listener: () => void) => emitter.removeListener(event, listener),
	};
}

interface PushCall {
	endpoint: string;
	payload: WebPushPayload;
	ttl: number;
	urgency: string;
}

let userData: string;
let staticRoot: string;
let host: WebHost;
let pool: SidecarPool;
let omps: FakeOmp[];
let port: number;
let sockets: WebSocket[];
let calls: PushCall[];
let pushStatus: number;
let timers: Map<number, { at: number; fn: () => void }>;
let clock: number;

const origin = () => `http://127.0.0.1:${port}`;
/** The secret path prefix of serve's target, and the identity headers serve adds to every request it forwards. */
const SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const IDENTITY = { "tailscale-user-login": "me@example.com", "x-forwarded-for": "100.64.0.9" };
const language = { current: "en" as "en" | "ko" };

function advance(ms: number): void {
	const target = clock + ms;
	for (;;) {
		const due = [...timers].filter(([, timer]) => timer.at <= target).sort(([, a], [, b]) => a.at - b.at)[0];
		if (!due) break;
		timers.delete(due[0]);
		clock = Math.max(clock, due[1].at);
		due[1].fn();
	}
	clock = target;
}

/** Let the sender's promise chain (a fake push service answers in a microtask) finish. */
const flush = () => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
};

const until = async (predicate: () => boolean): Promise<void> => {
	for (let i = 0; i < 20_000 && !predicate(); i++) await flush();
	expect(predicate()).toBe(true);
};

beforeEach(async () => {
	userData = mkdtempSync(join(tmpdir(), "web-push-it-"));
	staticRoot = mkdtempSync(join(tmpdir(), "web-push-static-"));
	mkdirSync(join(staticRoot, "assets"));
	writeFileSync(join(staticRoot, "web.html"), "<!doctype html>");
	omps = [];
	sockets = [];
	calls = [];
	pushStatus = 201;
	timers = new Map();
	clock = 0;
	language.current = "en";
	let nextTimer = 1;
	pool = new SidecarPool(cwd => {
		const omp = new FakeOmp(cwd);
		omps.push(omp);
		return omp as unknown as SidecarLike;
	});
	const handlers = new Map<string, (caller: IpcCaller, ...args: unknown[]) => unknown>();
	const transport: PushTransport = {
		send: async (subscription, body, options) => {
			calls.push({
				endpoint: subscription.endpoint,
				payload: JSON.parse(body) as WebPushPayload,
				ttl: options.ttl,
				urgency: options.urgency,
			});
			return { statusCode: pushStatus };
		},
	};
	const desktop: ClientWindow = {
		webContents: {
			id: 1,
			send: (channel: string, payload: unknown) => {
				if (channel !== WEB_PAIRING_REQUEST) return;
				const request = payload as WebPairingRequest;
				queueMicrotask(() => host.confirmations.respond({ id: request.id, approve: true }));
			},
		},
		isDestroyed: () => false,
		once: () => undefined,
		removeListener: () => undefined,
	};
	host = new WebHost({
		ipc: {
			handle: (channel, handler) => {
				handlers.set(channel, handler as never);
			},
			invoke: async () => undefined,
			send: () => undefined,
		},
		userData,
		staticRoot: () => staticRoot,
		desktopWindows: () => [desktop],
		tabs: { activeTab: () => null, cwd: () => null, facts: tabId => pool.tabFacts(tabId) },
		openMedia: async () => new Response(null, { status: 404 }),
		shell: { openPath: async () => {}, reveal: () => {}, openExternal: async () => {} },
		allowedUsers: () => ["me@example.com"],
		confirmNewDevices: () => false,
		whois: async () => null,
		onUnpairedAuth: () => undefined,
		language: () => language.current,
		batchNotifications: () => true,
		pushTransport: transport,
		pushTimers: {
			setTimer: (fn, ms) => {
				const handle = nextTimer++;
				timers.set(handle, { at: clock + ms, fn });
				return handle;
			},
			clearTimer: handle => {
				timers.delete(handle as number);
			},
		},
	});
	({ port } = await host.start({ port: 0 }));
	host.server.configure({ host: "127.0.0.1", publicPort: port, secure: false, servePrefix: SECRET });
	pool.observeTabs(activity => host.tabActivity(activity));
});

afterEach(async () => {
	for (const socket of sockets) socket.terminate();
	await host.stop();
	rmSync(userData, { recursive: true, force: true });
	rmSync(staticRoot, { recursive: true, force: true });
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
	return fetch(`http://127.0.0.1:${port}/${SECRET}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: origin(),
			"user-agent": "TestBrowser/1.0",
			...IDENTITY,
			...headers,
		},
		body: JSON.stringify(body),
	});
}

function subscriptionBody() {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return {
		endpoint: `https://push.example.com/send/${randomBytes(6).toString("hex")}`,
		keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
	};
}

/** A paired phone that subscribed and is connected with its page in the foreground or the background. */
async function phone(
	options: { visible: boolean; connect?: boolean; push?: Record<string, unknown> } = { visible: false },
) {
	const paired = await post("/api/pair", { name: "Test phone" });
	expect(paired.status).toBe(200);
	const cookie = (paired.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
	const { deviceId } = (await paired.json()) as { deviceId: string };
	const subscription = subscriptionBody();
	const state = await post("/api/push", { subscription, ...options.push }, { cookie });
	expect(state.status).toBe(200);
	let socket: WebSocket | null = null;
	const frames: unknown[] = [];
	if (options.connect !== false) {
		const ticket = (await (await post("/api/session", {}, { cookie })).json()) as { ticket: string };
		const opened = Promise.withResolvers<WebSocket>();
		const ws = new WebSocket(`ws://127.0.0.1:${port}/${SECRET}/ws`, ["ompdesk.v1", `ticket.${ticket.ticket}`], {
			headers: { origin: origin(), cookie, "user-agent": "TestBrowser/1.0", ...IDENTITY },
		});
		sockets.push(ws);
		ws.on("message", data => frames.push(JSON.parse(data.toString())));
		ws.once("open", () => opened.resolve(ws));
		ws.once("error", opened.reject);
		socket = await opened.promise;
		await until(() => host.router.isConnected(deviceId));
		socket.send(JSON.stringify({ t: "presence", visible: options.visible }));
		await until(() => host.router.isDeviceVisible(deviceId) === options.visible);
	}
	return { cookie, deviceId, subscription, socket, frames };
}

function openTab(tabId: string, title = "Refactor parser"): FakeOmp {
	pool.acquire("/work", fakeWindow(10 + omps.length), tabId);
	const omp = omps.at(-1);
	if (!omp) throw new Error("no omp");
	omp.emitStatus("ready");
	omp.emit("sessionInfoUpdate", { type: "session_info_update", title });
	return omp;
}

describe("a tab completing", () => {
	it("pushes one payload to a paired device whose socket is hidden, with the tab's title and reply", async () => {
		const p = await phone({ visible: false });
		const omp = openTab("tab-a");
		omp.startTurn();
		omp.endTurn("Fixed the parser and added two tests.");
		expect(calls).toEqual([]);
		advance(COMPLETION_DEBOUNCE_MS);
		await flush();
		expect(calls).toEqual([
			{
				endpoint: p.subscription.endpoint,
				payload: {
					v: 1,
					kind: "completion",
					title: "Refactor parser",
					body: "Fixed the parser and added two tests.",
					tabId: "tab-a",
					tag: "tab:tab-a",
				},
				ttl: 3600,
				urgency: "normal",
			},
		]);
		// A later quiet period sends nothing more.
		advance(60_000);
		await flush();
		expect(calls).toHaveLength(1);
	});

	it("pushes nothing while the device's socket is visible: the page shows its own toast", async () => {
		await phone({ visible: true });
		const omp = openTab("tab-a");
		omp.startTurn();
		omp.endTurn("Done.");
		advance(COMPLETION_DEBOUNCE_MS);
		omp.ask("ask-1", "Proceed?");
		advance(10_000);
		await flush();
		expect(calls).toEqual([]);
	});

	it("pushes to a device with no socket at all: nothing keeps it from the notification", async () => {
		await phone({ visible: false, connect: false });
		const omp = openTab("tab-a");
		omp.startTurn();
		omp.endTurn("One.");
		advance(COMPLETION_DEBOUNCE_MS);
		await flush();
		expect(calls).toHaveLength(1);
	});

	it("honours the device's categories and hide-content setting", async () => {
		const quiet = await phone({ visible: false, push: { categories: ["ask"] } });
		const hidden = await phone({ visible: false, push: { hideContent: true } });
		const omp = openTab("tab-a", "Secret migration");
		omp.startTurn();
		omp.endTurn("Dropped the production table.");
		advance(COMPLETION_DEBOUNCE_MS);
		await flush();
		expect(calls.map(call => call.endpoint)).toEqual([hidden.subscription.endpoint]);
		expect(calls[0]?.payload).toEqual({
			v: 1,
			kind: "completion",
			title: "A task finished",
			body: "",
			tabId: "tab-a",
			tag: "tab:tab-a",
		});
		expect(JSON.stringify(calls)).not.toMatch(/Secret|production/);
		expect(quiet.deviceId).not.toBe(hidden.deviceId);
	});

	it("stays quiet when the tab starts a new turn within the debounce", async () => {
		await phone({ visible: false });
		const omp = openTab("tab-a");
		omp.startTurn();
		omp.endTurn("First.");
		advance(COMPLETION_DEBOUNCE_MS - 100);
		omp.startTurn();
		advance(10_000);
		await flush();
		expect(calls).toEqual([]);
	});

	it("reads in the host's UI language", async () => {
		language.current = "ko";
		await phone({ visible: false, push: { hideContent: true } });
		const omp = openTab("tab-a");
		omp.startTurn();
		omp.endTurn("Done.", "error");
		advance(COMPLETION_DEBOUNCE_MS);
		await flush();
		expect(calls[0]?.payload).toMatchObject({ kind: "error", title: "작업이 오류로 중단됐어요", body: "" });
	});
});

describe("asks", () => {
	it("pushes an ask at once and retracts it with a silent clear when it is answered", async () => {
		const p = await phone({ visible: false });
		const omp = openTab("tab-a");
		omp.ask("ask-1", "Run the migration?");
		await flush();
		expect(calls).toEqual([
			{
				endpoint: p.subscription.endpoint,
				payload: {
					v: 1,
					kind: "ask",
					title: "Refactor parser",
					body: "Run the migration?",
					tabId: "tab-a",
					tag: "tab:tab-a",
				},
				ttl: 6 * 60 * 60,
				urgency: "high",
			},
		]);
		advance(10_000);
		await pool.routeSideChannel("ask-1", { type: "extension_ui_response", id: "ask-1", confirmed: true });
		await flush();
		expect(calls.at(-1)).toMatchObject({
			endpoint: p.subscription.endpoint,
			payload: { v: 1, kind: "clear", tabId: "tab-a", tag: "tab:tab-a", silent: true },
		});
		expect(calls).toHaveLength(2);
	});
});

describe("subscription lifecycle", () => {
	it("prunes a subscription the push service answers 410 to; /api/push then reports unsubscribed", async () => {
		const p = await phone({ visible: false });
		const omp = openTab("tab-a");
		pushStatus = 410;
		omp.ask("ask-1", "Go?");
		await flush();
		expect(calls).toHaveLength(1);
		const state = (await (
			await fetch(`http://127.0.0.1:${port}/${SECRET}/api/push`, { headers: { cookie: p.cookie, ...IDENTITY } })
		).json()) as WebPushStateResponse;
		expect(state.subscribed).toBe(false);
		omp.ask("ask-2", "Again?");
		await flush();
		expect(calls).toHaveLength(1);
	});

	it("stops pushing to a device the moment it is revoked, and its subscription leaves the file", async () => {
		const p = await phone({ visible: false });
		const omp = openTab("tab-a");
		omp.ask("ask-1", "Go?");
		await flush();
		expect(calls).toHaveLength(1);
		host.devices.revoke(p.deviceId);
		omp.ask("ask-2", "Again?");
		omp.startTurn();
		omp.endTurn("Done.");
		advance(10_000);
		await flush();
		expect(calls).toHaveLength(1);
		expect(host.devices.get(p.deviceId)).toBeUndefined();
	});

	it("pushes nothing while Mobile web is off", async () => {
		await phone({ visible: false });
		const omp = openTab("tab-a");
		await host.stop();
		omp.ask("ask-1", "Go?");
		omp.startTurn();
		omp.endTurn("Done.");
		advance(10_000);
		await flush();
		expect(calls).toEqual([]);
	});

	it("announces push in hello", async () => {
		const p = await phone({ visible: true });
		await until(() => p.frames.length > 0);
		expect(p.frames[0]).toMatchObject({ t: "hello", features: { push: true } });
	});
});
