/**
 * The WebSocket router against fake sockets: the hello, call dispatch and its policy and grant checks, error
 * shaping, the quota on model commands, event batching and merging, presence, the limits and the heartbeat.
 */
import { describe, expect, it, vi } from "vitest";
import { IPC_COMMANDS, IPC_EVENTS } from "../../shared/ipc-types";
import { WEB_DEVICES_CHANGED, WEB_DEVICES_LIST, WEB_PAIRING_REQUEST } from "../../shared/mobile-web";
import type { AgentSessionEvent } from "../../shared/rpc-types";
import { WEB_PERMISSIONS, type WebPermission, type WebServerFrame } from "../../shared/web-protocol";
import { BlobStore } from "./blobs";
import type { WebDevice } from "./devices-store";
import { FileEditReports } from "./file-edit-reports";
import { IPC_POLICY, type IpcChannel } from "./ipc-policy";
import type { IpcCaller } from "./ipc-registry";
import { WebClientWindow, WebWindows } from "./web-client-window";
import {
	CLOSE_POLICY,
	CLOSE_RATE_LIMITED,
	CLOSE_REVOKED,
	CLOSE_TOO_BIG,
	coalesceEvents,
	convertsForModel,
	EVENT_BATCH_MS,
	HEARTBEAT_MAX_MISSES,
	HEARTBEAT_MS,
	MAX_CONNECTIONS_PER_DEVICE,
	MAX_FRAME_BYTES,
	MESSAGE_BURST,
	mergeMessageUpdates,
	RESUME_WINDOW_MS,
	type RouterSocket,
	type Timers,
	type WebChannelTable,
	WsRouter,
} from "./ws-router";

class FakeSocket implements RouterSocket {
	readonly sent: WebServerFrame[] = [];
	closed: { code: number; reason: string } | null = null;
	terminated = false;
	pings = 0;
	bufferedAmount = 0;
	send(data: string): void {
		this.sent.push(JSON.parse(data) as WebServerFrame);
	}
	close(code: number, reason: string): void {
		this.closed = { code, reason };
	}
	ping(): void {
		this.pings += 1;
	}
	terminate(): void {
		this.terminated = true;
	}
	frames<T extends WebServerFrame["t"]>(type: T): Extract<WebServerFrame, { t: T }>[] {
		return this.sent.filter((frame): frame is Extract<WebServerFrame, { t: T }> => frame.t === type);
	}
}

/** Timers the test fires by hand. */
class ManualTimers implements Timers {
	readonly after_: { callback: () => void; ms: number; live: boolean }[] = [];
	readonly every_: { callback: () => void; ms: number; live: boolean }[] = [];
	every(callback: () => void, ms: number): () => void {
		const entry = { callback, ms, live: true };
		this.every_.push(entry);
		return () => {
			entry.live = false;
		};
	}
	after(callback: () => void, ms: number): () => void {
		const entry = { callback, ms, live: true };
		this.after_.push(entry);
		return () => {
			entry.live = false;
		};
	}
	/** Run the pending batch timers. */
	flush(): void {
		for (const entry of this.after_.splice(0)) if (entry.live) entry.callback();
	}
	tick(): void {
		for (const entry of this.every_) if (entry.live) entry.callback();
	}
}

const device = (grants: readonly WebPermission[] = WEB_PERMISSIONS.filter(p => p !== "pairing-admin")): WebDevice => ({
	deviceId: "dev1",
	name: "Phone",
	userAgent: "UA",
	tailscaleLogin: null,
	secretSha256: "0".repeat(64),
	publicKeyJwk: null,
	grants: [...grants],
	uiPrefs: {},
	createdAt: 0,
});

interface RigOptions {
	grants?: readonly WebPermission[];
	webChannels?: WebChannelTable;
	reserve?: () => { ok: true; refund(): void } | { ok: false; refusal: "requests" | "tokens" };
}

function rig(options: RigOptions = {}) {
	let current: WebDevice | undefined = device(options.grants);
	const clock = { now: 1_000_000 };
	const timers = new ManualTimers();
	const callers: { channel: string; caller: IpcCaller; args: readonly unknown[] }[] = [];
	const invoke = vi.fn(async (channel: string, caller: IpcCaller, args: readonly unknown[]): Promise<unknown> => {
		callers.push({ channel, caller, args });
		return { echoed: channel };
	});
	const send = vi.fn((channel: string, caller: IpcCaller, args: readonly unknown[]) => {
		callers.push({ channel, caller, args });
	});
	const refund = vi.fn();
	const quota = {
		reserve: vi.fn(options.reserve ?? (() => ({ ok: true as const, refund }))),
		record: vi.fn(),
	};
	const blobs = new BlobStore();
	/** This device's uploads by host path; `take` hands one over once. */
	const uploaded = new Map<string, Buffer>();
	const uploads = {
		take: vi.fn(async (deviceId: string, file: string) => {
			const bytes = deviceId === "dev1" ? uploaded.get(file) : undefined;
			if (!bytes) throw new Error("no such upload");
			uploaded.delete(file);
			return bytes;
		}),
	};
	/** Stock's conversion, faked: the picture comes back as a JPEG. */
	const toModelImage = vi.fn(async (image: { data: string; mimeType: string }) => ({
		type: "image" as const,
		data: `jpeg:${image.data}`,
		mimeType: "image/jpeg",
	}));
	const resyncs: string[] = [];
	const ended: { deviceId: string; connId: string }[] = [];
	let routerRef: WsRouter | null = null;
	const windows = new WebWindows((id, channel, payload) => routerRef?.deliver(id, channel, payload));
	const router = new WsRouter({
		registry: { invoke, send },
		devices: { get: id => (id === current?.deviceId ? current : undefined) },
		windows,
		quota,
		webChannels: options.webChannels ?? {},
		features: () => ({ push: false, preview: false, upload: true, passkey: false }),
		activeTab: () => "tab-active",
		blobs,
		uploads,
		toModelImage,
		onResync: deviceId => resyncs.push(deviceId),
		onConnectionEnded: (deviceId, connId) => ended.push({ deviceId, connId }),
		now: () => clock.now,
		timers,
	});
	routerRef = router;
	const socket = new FakeSocket();
	const connection = router.attach("dev1", socket);
	if (!connection) throw new Error("attach failed");
	const frame = (value: unknown): void => connection.receive(JSON.stringify(value));
	const settle = async (): Promise<void> => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};
	return {
		router,
		connection,
		socket,
		timers,
		clock,
		invoke,
		send,
		quota,
		refund,
		callers,
		windows,
		blobs,
		uploaded,
		uploads,
		toModelImage,
		frame,
		settle,
		resyncs,
		ended,
		revoke: () => {
			current = undefined;
		},
	};
}

const text = (
	delta: string,
	extra: Partial<Extract<AgentSessionEvent, { type: "message_update" }>> = {},
): AgentSessionEvent => ({
	type: "message_update",
	messageId: "m1",
	message: { role: "assistant", timestamp: 7 },
	assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
	...extra,
});

describe("hello and calls", () => {
	it("sends hello first with the protocol, the connection id, the host's features and the device's grants", () => {
		const { socket, connection } = rig({ grants: ["workspace", "device-self"] });
		expect(socket.sent[0]).toEqual({
			t: "hello",
			protocol: 1,
			minClient: 1,
			connId: connection.connId,
			resumed: false,
			features: { push: false, preview: false, upload: true, passkey: false },
			grants: ["workspace", "device-self"],
		});
	});

	it("runs an inv through the registry as the device's virtual window and answers with a res", async () => {
		const { frame, settle, socket, callers, windows } = rig();
		frame({ t: "inv", id: 7, ch: IPC_COMMANDS.SESSIONS_LIST, a: [{ scope: "global" }] });
		await settle();
		expect(socket.frames("res")).toEqual([{ t: "res", id: 7, ok: true, v: { echoed: IPC_COMMANDS.SESSIONS_LIST } }]);
		const call = callers[0];
		expect(call?.args).toEqual([{ scope: "global" }]);
		expect(call?.caller.win).toBe(windows.windowFor("dev1"));
		expect(call?.caller.win).toBeInstanceOf(WebClientWindow);
		expect(call?.caller.win?.webContents.id).toBeLessThan(0);
		expect(call?.caller.browserWindow).toBeNull();
		expect(call?.caller.sender.id).toBe(call?.caller.win?.webContents.id);
	});

	it("runs a snd through the registry and answers nothing", async () => {
		const { frame, settle, socket, send } = rig();
		frame({ t: "snd", ch: IPC_COMMANDS.RUNTIME_ERROR_REPORT, a: [{ message: "x" }] });
		await settle();
		expect(send).toHaveBeenCalledOnce();
		expect(socket.frames("res")).toEqual([]);
	});

	it("returns a handler's failure with its code, keeping the message the renderer parses", async () => {
		const { frame, settle, socket, invoke } = rig();
		invoke.mockRejectedValueOnce(new Error("[session_running] Session is currently running"));
		frame({ t: "inv", id: 1, ch: IPC_COMMANDS.SESSIONS_DELETE, a: [] });
		invoke.mockRejectedValueOnce("plain");
		frame({ t: "inv", id: 2, ch: IPC_COMMANDS.SESSIONS_DELETE, a: [] });
		await settle();
		expect(socket.frames("res")).toEqual([
			{
				t: "res",
				id: 1,
				ok: false,
				e: { message: "[session_running] Session is currently running", code: "session_running" },
			},
			{ t: "res", id: 2, ok: false, e: { message: "plain" } },
		]);
	});

	it("answers a call whose result cannot be sent with an error, so the page never waits on it forever", async () => {
		const { frame, settle, socket, invoke } = rig();
		invoke.mockResolvedValueOnce({ size: 1n });
		frame({ t: "inv", id: 3, ch: IPC_COMMANDS.SESSIONS_LIST, a: [{ scope: "global" }] });
		await settle();
		expect(socket.frames("res")).toEqual([
			{
				t: "res",
				id: 3,
				ok: false,
				e: { message: expect.stringContaining("could not be sent") },
			},
		]);
	});

	it("reads a picture the page sent by upload back into the call before it runs, and the upload is gone", async () => {
		const { frame, socket, callers, uploaded, uploads } = rig();
		uploaded.set("/up/dev1/a/image.jpeg", Buffer.from("JPEG"));
		const prompt = (images: unknown[]) => ({
			tabId: "t1",
			command: { type: "prompt", message: "look", images },
		});
		frame({
			t: "inv",
			id: 3,
			ch: IPC_COMMANDS.RPC_COMMAND_FOR_TAB,
			a: [prompt([{ type: "image", mimeType: "image/jpeg", upload: "/up/dev1/a/image.jpeg" }])],
		});
		await vi.waitFor(() => expect(socket.frames("res")).toMatchObject([{ id: 3, ok: true }]));
		expect(callers[0]?.args).toEqual([prompt([{ type: "image", mimeType: "image/jpeg", data: "SlBFRw==" }])]);
		expect(uploaded.size).toBe(0);
		// A picture already taken (or never this device's) fails the call, and nothing runs.
		frame({
			t: "inv",
			id: 4,
			ch: IPC_COMMANDS.RPC_COMMAND_FOR_TAB,
			a: [prompt([{ type: "image", mimeType: "image/jpeg", upload: "/up/dev1/a/image.jpeg" }])],
		});
		await vi.waitFor(() => expect(socket.frames("res")).toHaveLength(2));
		expect(callers).toHaveLength(1);
		expect(socket.frames("res")[1]).toMatchObject({ id: 4, ok: false, e: { code: "file_not_found" } });
		expect(uploads.take).toHaveBeenCalledWith("dev1", "/up/dev1/a/image.jpeg");
	});

	it("reads a file the page uploaded back into a send to a paired host, and refuses one it no longer holds", async () => {
		const { frame, socket, callers, uploaded } = rig();
		uploaded.set("/up/dev1/b/report.docx", Buffer.from("DOCX"));
		const request = { tabId: "t1", name: "report.docx", upload: "/up/dev1/b/report.docx" };
		frame({ t: "inv", id: 3, ch: IPC_COMMANDS.FS_UPLOAD_TO_HOST, a: [request] });
		await vi.waitFor(() => expect(socket.frames("res")).toMatchObject([{ id: 3, ok: true }]));
		expect(callers[0]?.args).toEqual([
			{ tabId: "t1", name: "report.docx", data: new Uint8Array(Buffer.from("DOCX")) },
		]);
		frame({ t: "inv", id: 4, ch: IPC_COMMANDS.FS_UPLOAD_TO_HOST, a: [request] });
		await vi.waitFor(() => expect(socket.frames("res")).toHaveLength(2));
		expect(callers).toHaveLength(1);
		expect(socket.frames("res")[1]).toMatchObject({ id: 4, ok: false, e: { code: "file_not_found" } });
	});

	it("passes inline pictures and calls without pictures on unchanged, without touching the uploads", async () => {
		const { frame, settle, callers, uploads } = rig();
		const inline = {
			tabId: "t1",
			command: { type: "prompt", message: "x", images: [{ type: "image", mimeType: "image/png", data: "AA==" }] },
		};
		frame({ t: "inv", id: 5, ch: IPC_COMMANDS.RPC_COMMAND_FOR_TAB, a: [inline] });
		frame({ t: "snd", ch: IPC_COMMANDS.RUNTIME_ERROR_REPORT, a: [{ message: "x" }] });
		await settle();
		expect(callers.map(call => call.args)).toEqual([[inline], [{ message: "x" }]]);
		expect(uploads.take).not.toHaveBeenCalled();
	});

	it("converts a HEIC or HEIF picture with stock's image path whatever its size, and leaves model formats alone", async () => {
		const { frame, socket, callers, uploaded, toModelImage } = rig();
		uploaded.set("/up/dev1/a/image.heic", Buffer.from("HEIC"));
		uploaded.set("/up/dev1/b/image.jpeg", Buffer.from("JPEG"));
		const images = [
			{ type: "image", mimeType: "image/heic", upload: "/up/dev1/a/image.heic" },
			{ type: "image", mimeType: "image/jpeg", upload: "/up/dev1/b/image.jpeg" },
		];
		frame({ t: "inv", id: 6, ch: IPC_COMMANDS.RPC_COMMAND_FOR_TAB, a: [{ command: { type: "prompt", images } }] });
		await vi.waitFor(() => expect(socket.frames("res")).toHaveLength(1));
		expect(callers[0]?.args).toEqual([
			{
				command: {
					type: "prompt",
					images: [
						{ type: "image", mimeType: "image/jpeg", data: `jpeg:${Buffer.from("HEIC").toString("base64")}` },
						{ type: "image", mimeType: "image/jpeg", data: Buffer.from("JPEG").toString("base64") },
					],
				},
			},
		]);
		expect(toModelImage).toHaveBeenCalledOnce();
		// A picture stock cannot convert fails the call; nothing raw reaches the model.
		toModelImage.mockRejectedValueOnce(new Error("undecodable"));
		uploaded.set("/up/dev1/c/image.heif", Buffer.from("HEIF"));
		const heif = [{ type: "image", mimeType: "image/heif", upload: "/up/dev1/c/image.heif" }];
		frame({
			t: "inv",
			id: 7,
			ch: IPC_COMMANDS.RPC_COMMAND_FOR_TAB,
			a: [{ command: { type: "prompt", images: heif } }],
		});
		await vi.waitFor(() => expect(socket.frames("res")).toHaveLength(2));
		expect(callers).toHaveLength(1);
		expect(socket.frames("res")[1]).toMatchObject({ id: 7, ok: false, e: { code: "unsupported_image" } });
	});

	it("tells the formats models refuse from the ones they take", () => {
		for (const mime of [
			"image/heic",
			"image/heif",
			"image/HEIC",
			"image/heic-sequence",
			"image/heif-sequence",
			"image/avif",
			"image/tiff",
			"image/bmp",
		])
			expect(convertsForModel(mime)).toBe(true);
		for (const mime of ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "text/plain"])
			expect(convertsForModel(mime)).toBe(false);
	});

	it("answers ping with pong and ignores ack", () => {
		const { frame, socket } = rig();
		frame({ t: "ping" });
		frame({ t: "ack", seq: 3 });
		expect(socket.frames("pong")).toHaveLength(1);
	});
});

describe("channel policy and grants", () => {
	async function call(r: ReturnType<typeof rig>, channel: string, dir: "inv" | "snd" = "inv") {
		const before = r.socket.sent.length;
		r.frame(dir === "inv" ? { t: "inv", id: 1, ch: channel, a: [] } : { t: "snd", ch: channel, a: [] });
		await r.settle();
		return r.socket.sent.slice(before)[0];
	}

	it("refuses unknown channels, push channels, the pairing boundary and the wrong direction", async () => {
		const r = rig();
		const refused = { t: "res", id: 1, ok: false, e: { code: "web_forbidden" } };
		for (const channel of ["nope:nothing", IPC_EVENTS.EVENTS_BATCH, WEB_DEVICES_LIST]) {
			expect(await call(r, channel), channel).toMatchObject(refused);
		}
		// RUNTIME_ERROR_REPORT is a send channel; SESSIONS_LIST is an invoke channel.
		expect(await call(r, IPC_COMMANDS.RUNTIME_ERROR_REPORT)).toMatchObject(refused);
		expect(r.invoke).not.toHaveBeenCalled();
		r.frame({ t: "snd", ch: IPC_COMMANDS.SESSIONS_LIST, a: [] });
		await r.settle();
		expect(r.send).not.toHaveBeenCalled();
	});

	it("lets each channel through exactly when the device holds its permission", async () => {
		const channels = (Object.entries(IPC_POLICY) as [IpcChannel, (typeof IPC_POLICY)[IpcChannel]][]).filter(
			([, policy]) => policy.dir !== "push" && policy.mode !== "boundary",
		);
		expect(channels.length).toBeGreaterThan(100);
		for (const [channel, policy] of channels) {
			if (policy.dir === "push" || policy.mode === "boundary") continue;
			const only = rig({ grants: [policy.permission] });
			const allowed = await call(only, channel, policy.dir === "invoke" ? "inv" : "snd");
			if (policy.dir === "invoke") expect(allowed, channel).toMatchObject({ t: "res", ok: true });
			else expect(only.send, channel).toHaveBeenCalledOnce();
			const without = rig({ grants: WEB_PERMISSIONS.filter(p => p !== policy.permission && p !== "pairing-admin") });
			const refused = await call(without, channel, policy.dir === "invoke" ? "inv" : "snd");
			if (policy.dir === "invoke")
				expect(refused, channel).toMatchObject({ ok: false, e: { code: "web_forbidden" } });
			expect(without.send, channel).not.toHaveBeenCalled();
		}
	});

	it("never serves pairing-admin, even to a device that somehow holds it", async () => {
		const r = rig({ grants: ["pairing-admin", "workspace"] });
		expect(await call(r, WEB_DEVICES_LIST)).toMatchObject({ ok: false, e: { code: "web_forbidden" } });
	});

	it("serves a web-only channel with the device's context and its own permission", async () => {
		const handler = vi.fn((context: { deviceId: string }) => ({ for: context.deviceId }));
		const webChannels: WebChannelTable = {
			"web:test.open": { dir: "invoke", permission: "desktop-control", handler },
			"web:test.heavy": {
				dir: "invoke",
				permission: "workspace",
				heavy: true,
				handler: () => new Promise(() => {}),
			},
		};
		const full = rig({ webChannels });
		expect(await call(full, "web:test.open")).toMatchObject({ ok: true, v: { for: "dev1" } });
		const limited = rig({ webChannels, grants: ["workspace"] });
		expect(await call(limited, "web:test.open")).toMatchObject({ ok: false, e: { code: "web_forbidden" } });
		// Four heavy calls at once; the fifth is refused.
		for (let i = 0; i < 4; i++) limited.frame({ t: "inv", id: 10 + i, ch: "web:test.heavy", a: [] });
		await limited.settle();
		expect(await call(limited, "web:test.heavy")).toMatchObject({ ok: false, e: { code: "web_forbidden" } });
	});

	it("closes a socket whose device was revoked on its next call", async () => {
		const r = rig();
		r.revoke();
		r.frame({ t: "inv", id: 1, ch: IPC_COMMANDS.SESSIONS_LIST, a: [] });
		await r.settle();
		expect(r.socket.closed?.code).toBe(CLOSE_REVOKED);
		expect(r.router.connectionCount("dev1")).toBe(0);
	});

	it("takes secret-looking keys out of all preferences", async () => {
		const r = rig();
		r.invoke.mockResolvedValueOnce({ theme: "dark", githubToken: "x", apiKey: "y", language: "ko" });
		r.frame({ t: "inv", id: 2, ch: IPC_COMMANDS.PREFS_GET, a: [{}] });
		r.invoke.mockResolvedValueOnce("secret-value");
		r.frame({ t: "inv", id: 3, ch: IPC_COMMANDS.PREFS_GET, a: [{ key: "githubToken" }] });
		await r.settle();
		const [prefs, keyed] = r.socket.frames("res");
		expect(prefs).toMatchObject({ ok: true, v: { theme: "dark", language: "ko" } });
		expect((prefs as { v: object }).v).not.toHaveProperty("githubToken");
		expect(keyed).toMatchObject({ ok: true, v: "secret-value" });
	});
});

describe("model quota", () => {
	const prompt = { command: { type: "prompt", message: "hi" }, timeoutMs: 1 };

	it("reserves before running a model command and refuses over the limit without running it", async () => {
		const r = rig({ reserve: () => ({ ok: false, refusal: "requests" }) });
		r.frame({ t: "inv", id: 1, ch: IPC_COMMANDS.RPC_COMMAND, a: [prompt] });
		await r.settle();
		expect(r.invoke).not.toHaveBeenCalled();
		expect(r.socket.frames("res")[0]).toMatchObject({ ok: false, e: { code: "remote_limit_reached" } });
	});

	it("does not count a command that never calls a model", async () => {
		const r = rig();
		r.frame({ t: "inv", id: 1, ch: IPC_COMMANDS.RPC_COMMAND, a: [{ command: { type: "get_state" }, timeoutMs: 1 }] });
		await r.settle();
		expect(r.quota.reserve).not.toHaveBeenCalled();
		expect(r.invoke).toHaveBeenCalledOnce();
	});

	it("gives the request back when the command fails, as a response or as a throw", async () => {
		const r = rig();
		r.invoke.mockResolvedValueOnce({ type: "response", success: false, error: "no" });
		r.frame({ t: "inv", id: 1, ch: IPC_COMMANDS.RPC_COMMAND_FOR_TAB, a: [{ tabId: "t", ...prompt }] });
		await r.settle();
		expect(r.refund).toHaveBeenCalledTimes(1);
		r.invoke.mockRejectedValueOnce(new Error("boom"));
		r.frame({ t: "inv", id: 2, ch: IPC_COMMANDS.RPC_COMMAND, a: [prompt] });
		await r.settle();
		expect(r.refund).toHaveBeenCalledTimes(2);
		r.invoke.mockResolvedValueOnce({ type: "response", success: true });
		r.frame({ t: "inv", id: 3, ch: IPC_COMMANDS.RPC_COMMAND, a: [prompt] });
		await r.settle();
		expect(r.refund).toHaveBeenCalledTimes(2);
	});

	it("weighs a benchmark by models × runs and a model setup run as one", async () => {
		const r = rig();
		r.frame({ t: "inv", id: 1, ch: IPC_COMMANDS.BENCH_RUN, a: [{ models: ["a", "b", "c"], runs: 4 }] });
		r.frame({ t: "inv", id: 2, ch: IPC_COMMANDS.MODEL_SETUP_RUN, a: [{}] });
		await r.settle();
		expect(r.quota.reserve.mock.calls).toEqual([
			["dev1", 12],
			["dev1", 1],
		]);
	});

	it("charges a finished turn's tokens to the device that drove the tab, even while its page is hidden", async () => {
		const r = rig();
		r.frame({ t: "inv", id: 1, ch: IPC_COMMANDS.RPC_COMMAND_FOR_TAB, a: [{ tabId: "tab-9", ...prompt }] });
		await r.settle();
		r.frame({ t: "presence", visible: false });
		const end: AgentSessionEvent = {
			type: "message_end",
			message: { role: "assistant", usage: { totalTokens: 321 } },
		} as AgentSessionEvent;
		r.windows.windowFor("dev1").webContents.send(IPC_EVENTS.EVENTS_BATCH, { tabId: "tab-9", payload: [end] });
		r.windows.windowFor("dev1").webContents.send(IPC_EVENTS.EVENTS_BATCH, { tabId: "tab-other", payload: [end] });
		expect(r.quota.record).toHaveBeenCalledExactlyOnceWith("dev1", { tokens: 321 });
	});
});

describe("events", () => {
	it("batches pushes for 75 ms and sends each as an evt with a rising seq", () => {
		const r = rig();
		const win = r.windows.windowFor("dev1");
		win.webContents.send(IPC_EVENTS.TAB_STATUS, { tabId: "a", status: "running" });
		win.webContents.send(IPC_EVENTS.TAB_LIST_CHANGED, { tabs: [] });
		expect(r.socket.frames("evt")).toEqual([]);
		expect(r.timers.after_.map(timer => timer.ms)).toEqual([EVENT_BATCH_MS]);
		r.timers.flush();
		expect(r.socket.frames("evt")).toEqual([
			{ t: "evt", seq: 1, ch: IPC_EVENTS.TAB_STATUS, d: { tabId: "a", status: "running" } },
			{ t: "evt", seq: 2, ch: IPC_EVENTS.TAB_LIST_CHANGED, d: { tabs: [] } },
		]);
	});

	it("sends the events pushed before a call's answer ahead of it, as the desktop's IPC keeps them in order", async () => {
		// A status the tab pushed before the page's tab list was read used to wait out the batch window and land after
		// the list: a stale "no session file yet" over a known file made the page replace the tab's runtime, and the
		// text being typed in its composer went with it (web-no-reload.e2e.ts, 1 in about 4 under load).
		const r = rig();
		const win = r.windows.windowFor("dev1");
		win.webContents.send(IPC_EVENTS.TAB_STATUS, { tabId: "a", status: "ready", sessionPath: null });
		r.frame({ t: "inv", id: 9, ch: IPC_COMMANDS.SESSIONS_LIST, a: [{ scope: "global" }] });
		await r.settle();
		expect(r.socket.sent.map(frame => frame.t).filter(t => t === "evt" || t === "res")).toEqual(["evt", "res"]);
		// The batch window that held it sends nothing twice.
		r.timers.flush();
		expect(r.socket.frames("evt")).toHaveLength(1);
	});

	it("joins a tab's neighbouring batches and merges their streaming deltas", () => {
		const r = rig();
		const win = r.windows.windowFor("dev1");
		win.webContents.send(IPC_EVENTS.EVENTS_BATCH, { tabId: "a", payload: [text("Hel"), text("lo")] });
		win.webContents.send(IPC_EVENTS.EVENTS_BATCH, { tabId: "a", payload: [text(" wor"), text("ld")] });
		r.timers.flush();
		const sent = r.socket.frames("evt");
		expect(sent).toHaveLength(1);
		const batch = sent[0]?.d as { tabId: string; payload: Extract<AgentSessionEvent, { type: "message_update" }>[] };
		expect(batch.payload).toHaveLength(1);
		expect(batch.payload[0]?.assistantMessageEvent).toMatchObject({ type: "text_delta", delta: "Hello world" });
	});

	it("keeps order across tabs and channels", () => {
		const events = coalesceEvents([
			{ ch: IPC_EVENTS.EVENTS_BATCH, d: { tabId: "a", payload: [text("1")] } },
			{ ch: IPC_EVENTS.TAB_STATUS, d: { tabId: "a" } },
			{ ch: IPC_EVENTS.EVENTS_BATCH, d: { tabId: "a", payload: [text("2")] } },
			{ ch: IPC_EVENTS.EVENTS_BATCH, d: { tabId: "b", payload: [text("3")] } },
		]);
		expect(events.map(event => event.ch)).toEqual([
			IPC_EVENTS.EVENTS_BATCH,
			IPC_EVENTS.TAB_STATUS,
			IPC_EVENTS.EVENTS_BATCH,
			IPC_EVENTS.EVENTS_BATCH,
		]);
	});

	it("merges only slim updates of the same block of the same message", () => {
		const snapshot = text("a", {
			message: { role: "assistant", timestamp: 7, content: [{ type: "text", text: "a" }] },
		});
		const thinking = text("t", { assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "t" } });
		const otherBlock = text("b", { assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "b" } });
		const otherMessage = text("c", { message: { role: "assistant", timestamp: 8 } });
		const end: AgentSessionEvent = { type: "message_end", message: { role: "assistant" } } as AgentSessionEvent;
		const merged = mergeMessageUpdates([
			snapshot,
			text("b"),
			text("c"),
			thinking,
			otherBlock,
			otherMessage,
			end,
			text("d"),
		]);
		expect(
			merged.map(event =>
				event.type === "message_update" ? (event.assistantMessageEvent as { delta: string }).delta : event.type,
			),
		).toEqual(["a", "bc", "t", "b", "c", "message_end", "d"]);
	});

	it("drops events and pushes meant for the desktop or the page itself", () => {
		const r = rig();
		const win = r.windows.windowFor("dev1");
		win.webContents.send(IPC_EVENTS.MENU_ACTION, { action: "x" });
		win.webContents.send(WEB_DEVICES_CHANGED, []);
		win.webContents.send(WEB_PAIRING_REQUEST, {});
		win.webContents.send("not-a-channel", {});
		const state = { tailnet: "ready", host: { enabled: true }, hosts: [], forgotten: [] };
		win.webContents.send(IPC_EVENTS.REMOTE_STATE, state);
		r.timers.flush();
		expect(r.socket.frames("evt")).toEqual([{ t: "evt", seq: 1, ch: IPC_EVENTS.REMOTE_STATE, d: state }]);
	});

	it("goes to every connection of the device, and not to another device's", () => {
		const r = rig();
		const second = new FakeSocket();
		r.router.attach("dev1", second);
		const stranger = new FakeSocket();
		r.router.attach("dev2", stranger);
		r.windows.windowFor("dev1").webContents.send(IPC_EVENTS.TAB_STATUS, { tabId: "a" });
		r.timers.flush();
		expect(r.socket.frames("evt")).toHaveLength(1);
		expect(second.frames("evt")).toHaveLength(1);
		expect(stranger.frames("evt")).toHaveLength(0);
	});
});

describe("presence", () => {
	it("stops the streams while hidden, keeps status pushes, and sends hello again when visible", () => {
		const r = rig();
		const win = r.windows.windowFor("dev1");
		r.frame({ t: "presence", visible: false });
		win.webContents.send(IPC_EVENTS.EVENTS_BATCH, { tabId: "a", payload: [text("x")] });
		win.webContents.send(IPC_EVENTS.SUBAGENT_FRAMES, []);
		win.webContents.send(IPC_EVENTS.TAB_STATUS, { tabId: "a", status: "running" });
		r.timers.flush();
		expect(r.socket.frames("evt").map(frame => frame.ch)).toEqual([IPC_EVENTS.TAB_STATUS]);
		const hellos = r.socket.frames("hello").length;
		r.frame({ t: "presence", visible: true });
		expect(r.socket.frames("hello")).toHaveLength(hellos + 1);
		expect(r.socket.frames("hello").at(-1)).toMatchObject({ resumed: false });
		win.webContents.send(IPC_EVENTS.EVENTS_BATCH, { tabId: "a", payload: [text("y")] });
		r.timers.flush();
		expect(r.socket.frames("evt").at(-1)?.ch).toBe(IPC_EVENTS.EVENTS_BATCH);
	});

	it("asks for whole stream snapshots whenever a hello sends the page to resync, never on a resumed one", () => {
		const r = rig();
		// The first hello of a page load counts: that page holds no stream yet.
		expect(r.resyncs).toEqual(["dev1"]);
		r.frame({ t: "presence", visible: false });
		r.windows.windowFor("dev1").webContents.send(IPC_EVENTS.EVENTS_BATCH, { tabId: "a", payload: [text("x")] });
		r.frame({ t: "presence", visible: true });
		expect(r.resyncs).toEqual(["dev1", "dev1"]);
		r.windows.windowFor("dev1").webContents.send(IPC_EVENTS.TAB_STATUS, { tabId: "a" });
		r.timers.flush();
		r.frame({ t: "ack", seq: r.socket.frames("evt").at(-1)?.seq ?? 0 });
		r.connection.dispose();
		r.router.attach("dev1", new FakeSocket(), r.connection.connId);
		expect(r.resyncs).toEqual(["dev1", "dev1"]);
	});

	it("drops a stream already queued when the page hides before the batch goes out", () => {
		const r = rig();
		const win = r.windows.windowFor("dev1");
		win.webContents.send(IPC_EVENTS.EVENTS_BATCH, { tabId: "a", payload: [text("x")] });
		r.frame({ t: "presence", visible: false });
		r.timers.flush();
		expect(r.socket.frames("evt")).toEqual([]);
	});

	it("comes back without a hello when nothing streamed while hidden, and sends what queued meanwhile", () => {
		const r = rig();
		const win = r.windows.windowFor("dev1");
		const hellos = r.socket.frames("hello").length;
		r.frame({ t: "presence", visible: false });
		r.frame({ t: "presence", visible: true });
		win.webContents.send(IPC_EVENTS.TAB_STATUS, { tabId: "a", status: "idle" });
		r.frame({ t: "presence", visible: false });
		r.frame({ t: "presence", visible: true });
		r.timers.flush();
		expect(r.socket.frames("hello")).toHaveLength(hellos);
		expect(r.socket.frames("evt").map(frame => frame.ch)).toEqual([IPC_EVENTS.TAB_STATUS]);
	});
	it("tells whether any socket of a device has its page in the foreground (what keeps Web Push quiet)", () => {
		const r = rig();
		expect(r.router.isDeviceVisible("dev1")).toBe(true);
		expect(r.router.isDeviceVisible("nobody")).toBe(false);
		r.frame({ t: "presence", visible: false });
		expect(r.router.isDeviceVisible("dev1")).toBe(false);
		// A second socket of the same device that is in the foreground makes the device visible.
		const second = r.router.attach("dev1", new FakeSocket());
		expect(r.router.isDeviceVisible("dev1")).toBe(true);
		second?.receive(JSON.stringify({ t: "presence", visible: false }));
		expect(r.router.isDeviceVisible("dev1")).toBe(false);
		r.frame({ t: "presence", visible: true });
		expect(r.router.isDeviceVisible("dev1")).toBe(true);
		r.connection.dispose();
		second?.dispose();
		expect(r.router.isDeviceVisible("dev1")).toBe(false);
	});
});

describe("resume", () => {
	/** A page reconnects on a new socket, offering `resumeFrom` (its last connection's id); the hello it gets. */
	function reconnect(router: WsRouter, resumeFrom: string) {
		const socket = new FakeSocket();
		router.attach("dev1", socket, resumeFrom);
		return socket.frames("hello")[0];
	}

	it("resumes a connection whose page acknowledged every event when no push came since", () => {
		const r = rig();
		r.windows.windowFor("dev1").webContents.send(IPC_EVENTS.TAB_STATUS, { tabId: "a" });
		r.timers.flush();
		r.frame({ t: "ack", seq: r.socket.frames("evt").at(-1)?.seq ?? 0 });
		r.connection.dispose();
		expect(reconnect(r.router, r.connection.connId)).toMatchObject({ resumed: true });
		// The id is good once.
		expect(reconnect(r.router, r.connection.connId)).toMatchObject({ resumed: false });
	});

	it("does not resume a page that missed an event: unacknowledged, still queued, pushed since, or dropped hidden", () => {
		const unacked = rig();
		unacked.windows.windowFor("dev1").webContents.send(IPC_EVENTS.TAB_STATUS, { tabId: "a" });
		unacked.timers.flush();
		unacked.connection.dispose();
		expect(reconnect(unacked.router, unacked.connection.connId)).toMatchObject({ resumed: false });

		const queued = rig();
		queued.windows.windowFor("dev1").webContents.send(IPC_EVENTS.TAB_STATUS, { tabId: "a" });
		queued.connection.dispose();
		expect(reconnect(queued.router, queued.connection.connId)).toMatchObject({ resumed: false });

		const later = rig();
		later.connection.dispose();
		later.windows.windowFor("dev1").webContents.send(IPC_EVENTS.TAB_STATUS, { tabId: "a" });
		expect(reconnect(later.router, later.connection.connId)).toMatchObject({ resumed: false });

		const hidden = rig();
		hidden.frame({ t: "presence", visible: false });
		hidden.windows.windowFor("dev1").webContents.send(IPC_EVENTS.EVENTS_BATCH, { tabId: "a", payload: [text("x")] });
		hidden.connection.dispose();
		expect(reconnect(hidden.router, hidden.connection.connId)).toMatchObject({ resumed: false });

		const expired = rig();
		expired.connection.dispose();
		expired.clock.now += RESUME_WINDOW_MS + 1;
		expect(reconnect(expired.router, expired.connection.connId)).toMatchObject({ resumed: false });

		const stranger = rig();
		expect(reconnect(stranger.router, "not-a-connection")).toMatchObject({ resumed: false });
	});

	it("retires the page's old connection the server had not seen drop, judging it as of then", () => {
		const r = rig();
		r.router.retire("dev1", r.connection.connId);
		expect(r.socket.closed?.code).toBe(1001);
		expect(r.router.connectionCount("dev1")).toBe(0);
		expect(reconnect(r.router, r.connection.connId)).toMatchObject({ resumed: true });
	});
});

describe("limits", () => {
	it("closes a socket that floods past the burst", () => {
		const r = rig();
		for (let i = 0; i < MESSAGE_BURST + 5; i++) r.frame({ t: "ping" });
		expect(r.socket.closed?.code).toBe(CLOSE_RATE_LIMITED);
	});

	it("closes on a frame over 1 MiB and on one that is not a frame", () => {
		const big = rig();
		big.connection.receive("x".repeat(MAX_FRAME_BYTES + 1));
		expect(big.socket.closed?.code).toBe(CLOSE_TOO_BIG);
		for (const junk of [
			"not json",
			JSON.stringify({ t: "nope" }),
			JSON.stringify({ t: "inv", id: "x", ch: "c", a: [] }),
		]) {
			const r = rig();
			r.connection.receive(junk);
			expect(r.socket.closed?.code, junk).toBe(CLOSE_POLICY);
		}
	});

	it("allows four connections a device", () => {
		const r = rig();
		for (let i = 1; i < MAX_CONNECTIONS_PER_DEVICE; i++)
			expect(r.router.attach("dev1", new FakeSocket())).not.toBeNull();
		expect(r.router.attach("dev1", new FakeSocket())).toBeNull();
		expect(r.router.attach("dev2", new FakeSocket())).not.toBeNull();
	});

	it("closes every socket of a device, and tells when connections come and go", () => {
		const onConnectionsChanged = vi.fn();
		const r = rig();
		const second = new FakeSocket();
		const other = r.router.attach("dev1", second);
		r.router.closeDevice("dev1", CLOSE_REVOKED, "revoked");
		expect(r.socket.closed).toEqual({ code: CLOSE_REVOKED, reason: "revoked" });
		expect(second.closed?.code).toBe(CLOSE_REVOKED);
		expect(r.router.isConnected("dev1")).toBe(false);
		other?.dispose();
		expect(onConnectionsChanged).not.toHaveBeenCalled();
	});
});

describe("a connection ending", () => {
	it("is told for each connection, with its id, whether or not others remain", () => {
		const r = rig();
		const second = r.router.attach("dev1", new FakeSocket());
		const first = r.connection.connId;
		r.connection.dispose();
		expect(r.ended).toEqual([{ deviceId: "dev1", connId: first }]);
		second?.dispose();
		expect(r.ended.map(end => end.connId)).toEqual([first, second?.connId]);
	});

	it("carries the connection id on the caller of each call", async () => {
		const r = rig();
		const second = r.router.attach("dev1", new FakeSocket());
		if (!second) throw new Error("attach failed");
		r.frame({ t: "inv", id: 1, ch: IPC_COMMANDS.FILE_EDIT_REPORT, a: [{ dirtyTabId: "t1" }] });
		second.receive(JSON.stringify({ t: "inv", id: 1, ch: IPC_COMMANDS.FILE_EDIT_REPORT, a: [{ dirtyTabId: null }] }));
		await r.settle();
		expect(r.callers.map(call => call.caller.connId)).toEqual([r.connection.connId, second.connId]);
		expect(r.connection.connId).not.toBe(second.connId);
	});

	it("lets main drop only that connection's Files-edit report: the other page's stands, none left is unreported", () => {
		const reports = new FileEditReports();
		const r = rig();
		const second = r.router.attach("dev1", new FakeSocket());
		if (!second) throw new Error("attach failed");
		const win = r.windows.windowFor("dev1");
		const id = win.webContents.id;
		reports.report(win, "t1", r.connection.connId);
		reports.report(win, null, second.connId);
		expect(reports.edits(id, "t1")).toBe("dirty");
		r.connection.dispose();
		for (const end of r.ended) reports.forget(r.windows.windowFor(end.deviceId).webContents.id, end.connId);
		expect(reports.edits(id, "t1")).toBe("clean");
		second.dispose();
		for (const end of r.ended) reports.forget(r.windows.windowFor(end.deviceId).webContents.id, end.connId);
		expect(reports.edits(id, "t1")).toBe("unreported");
	});
});

describe("heartbeat", () => {
	it("pings every tick and ends a socket only after three quiet ticks in a row", () => {
		const r = rig();
		for (let tick = 1; tick < HEARTBEAT_MAX_MISSES; tick++) {
			r.clock.now += HEARTBEAT_MS;
			r.timers.tick();
		}
		expect(r.socket.terminated).toBe(false);
		expect(r.socket.pings).toBe(HEARTBEAT_MAX_MISSES - 1);
		expect(r.socket.frames("ping")).toHaveLength(HEARTBEAT_MAX_MISSES - 1);
		r.clock.now += HEARTBEAT_MS;
		r.timers.tick();
		expect(r.socket.terminated).toBe(true);
		expect(r.router.isConnected("dev1")).toBe(false);
	});

	it("is satisfied by any message, including the page's pong", () => {
		const r = rig();
		for (let tick = 0; tick < 10; tick++) {
			r.clock.now += HEARTBEAT_MS;
			r.frame({ t: "pong" });
			r.timers.tick();
		}
		expect(r.socket.terminated).toBe(false);
	});

	it("does not count a tick that ran late (the machine slept)", () => {
		const r = rig();
		r.clock.now += HEARTBEAT_MS;
		r.timers.tick();
		r.clock.now += HEARTBEAT_MS;
		r.timers.tick();
		r.clock.now += HEARTBEAT_MS * 10;
		r.timers.tick();
		r.clock.now += HEARTBEAT_MS;
		r.timers.tick();
		expect(r.socket.terminated).toBe(false);
	});
});

describe("binary and media results", () => {
	it("returns a small file inline as base64 and a large one behind a blob URL", async () => {
		const r = rig();
		r.invoke.mockResolvedValueOnce({
			ok: true,
			data: new Uint8Array([104, 105]),
			mime: "text/plain",
			size: 2,
			truncated: false,
		});
		r.frame({ t: "inv", id: 1, ch: IPC_COMMANDS.FS_READ_BINARY, a: [{}] });
		r.invoke.mockResolvedValueOnce({
			ok: true,
			data: new Uint8Array(600 * 1024),
			mime: "image/png",
			size: 600 * 1024,
		});
		r.frame({ t: "inv", id: 2, ch: IPC_COMMANDS.FS_READ_BINARY, a: [{}] });
		await r.settle();
		const [small, large] = r.socket.frames("res") as { v: Record<string, unknown> }[];
		expect(small?.v).toEqual({ ok: true, mime: "text/plain", size: 2, truncated: false, dataBase64: "aGk=" });
		expect(large?.v).not.toHaveProperty("data");
		expect(large?.v.blobUrl).toMatch(/^\/blob\/[\w-]+$/);
		expect(r.blobs.size).toBe(1);
	});

	it("hands a file the page saves for itself out like a read: behind a blob URL past the inline size", async () => {
		const r = rig();
		r.invoke.mockResolvedValueOnce({
			ok: true,
			data: new Uint8Array(600 * 1024),
			mime: "application/zip",
			size: 600 * 1024,
		});
		r.frame({ t: "inv", id: 1, ch: IPC_COMMANDS.FS_SAVE_COPY, a: [{ path: "out/app.zip" }] });
		await r.settle();
		const [saved] = r.socket.frames("res") as { v: Record<string, unknown> }[];
		expect(saved?.v).not.toHaveProperty("data");
		expect(saved?.v.blobUrl).toMatch(/^\/blob\/[\w-]+$/);
	});

	it("hands a player's stream out as a /blob URL and translates the release back", async () => {
		const open = vi.fn();
		const r = rig();
		(r.router.deps as { mediaOpen?: unknown }).mediaOpen = open;
		r.invoke.mockResolvedValueOnce({ ok: true, url: "omp-media://stream/tok", mime: "video/webm", size: 9 });
		r.frame({ t: "inv", id: 1, ch: IPC_COMMANDS.FS_MEDIA_STREAM, a: [{ path: "a.webm" }] });
		await r.settle();
		const url = (r.socket.frames("res")[0] as { v: { url: string } }).v.url;
		expect(url).toMatch(/^\/blob\/[\w-]+$/);
		expect(r.blobs.mediaUrl("dev1", url)).toBe("omp-media://stream/tok");
		r.frame({ t: "snd", ch: IPC_COMMANDS.FS_MEDIA_RELEASE, a: [url] });
		await r.settle();
		expect(r.send.mock.calls[0]?.[2]).toEqual(["omp-media://stream/tok"]);
		expect(r.blobs.mediaUrl("dev1", url)).toBeNull();
	});
});

describe("virtual windows", () => {
	it("gives each device its own negative id, keeps it parked across sockets and closes it on revoke", () => {
		const r = rig();
		const a = r.windows.windowFor("dev1");
		const b = r.windows.windowFor("dev2");
		expect(a.webContents.id).toBeLessThan(0);
		expect(b.webContents.id).not.toBe(a.webContents.id);
		expect(r.windows.windowFor("dev1")).toBe(a);
		r.connection.close(1000, "bye");
		expect(a.isDestroyed()).toBe(false);
		const closed = vi.fn();
		const destroyed = vi.fn();
		a.once("closed", closed);
		a.webContents.once("destroyed", destroyed);
		r.windows.destroy("dev1");
		expect(closed).toHaveBeenCalledOnce();
		expect(destroyed).toHaveBeenCalledOnce();
		expect(a.isDestroyed()).toBe(true);
		expect(r.windows.has("dev1")).toBe(false);
		const fresh = r.windows.windowFor("dev1");
		expect(fresh).not.toBe(a);
	});
});
