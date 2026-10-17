/**
 * The web client's side of the wire (web-protocol.ts): one `WsConnection` per open socket, owned by the
 * `WsRouter`. Frames from a page become calls on the one `IpcRegistry` (`invoke` for `inv`, `send` for `snd`)
 * with the device's `WebClientWindow` as the caller, after the channel policy (ipc-policy.ts) and the device's
 * grants have said yes; the model-use quota counts model commands first. Pushes the pool makes to that window
 * come back as `evt` frames, batched every 75 ms with a reply's streaming deltas merged, and stop while the
 * page reports itself hidden. The socket itself (`RouterSocket`) is whatever `ws` hands the server, or a fake.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { codedError, ipcErrorCode } from "../../shared/ipc-error-codes";
import { IPC_COMMANDS, IPC_EVENTS } from "../../shared/ipc-types";
import { WEB_DEVICE_CONNECTED, WEB_DEVICES_CHANGED, WEB_PAIRING_REQUEST } from "../../shared/mobile-web";
import type { AgentSessionEvent } from "../../shared/rpc-types";
import {
	WEB_PROTOCOL_VERSION,
	type WebClientFrame,
	type WebFeatures,
	type WebInvokeError,
	type WebPermission,
	type WebServerFrame,
} from "../../shared/web-protocol";
import type { PeerQuota } from "../remote/peer-quota";
import { commandUsesModel } from "../remote/quota-commands";
import type { BlobStore } from "./blobs";
import type { WebDevice, WebDevices } from "./devices-store";
import { IPC_POLICY, type IpcChannel } from "./ipc-policy";
import type { IpcCaller } from "./ipc-registry";
import { ConcurrencyLimiter, TokenBucket } from "./rate-limit";
import type { WebClientWindow, WebWindows } from "./web-client-window";

/** Files up to this size ride in the reply as base64; bigger ones are fetched over `/blob`. */
const INLINE_BINARY_MAX_BYTES = 512 * 1024;

/** The most a page may send in one frame. */
export const MAX_FRAME_BYTES = 1024 * 1024;
export const EVENT_BATCH_MS = 75;
export const MAX_CONNECTIONS_PER_DEVICE = 4;
/** Sustained and burst messages a second per socket. */
export const MESSAGE_RATE = 200;
export const MESSAGE_BURST = 400;
/** Heavy calls (a search, a big read, a directory listing) one device may have running at once. */
export const HEAVY_CALLS_PER_DEVICE = 4;
export const HEARTBEAT_MS = 20_000;
export const HEARTBEAT_MAX_MISSES = 3;
/** A socket this far behind on what it was sent is closed rather than fed more. */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export const CLOSE_GOING_AWAY = 1001;
export const CLOSE_POLICY = 1008;
export const CLOSE_TOO_BIG = 1009;
/** The device was revoked or expired. */
export const CLOSE_REVOKED = 4401;
export const CLOSE_RATE_LIMITED = 4429;
export const CLOSE_SLOW_CONSUMER = 4408;
export const CLOSE_HEARTBEAT = 4410;

/** Timers a test can drive: each returns what cancels it. */
export interface Timers {
	every(callback: () => void, ms: number): () => void;
	after(callback: () => void, ms: number): () => void;
}

/** Real timers that never keep the process alive. */
const realTimers: Timers = {
	every(callback, ms) {
		const handle = setInterval(callback, ms);
		handle.unref();
		return () => clearInterval(handle);
	},
	after(callback, ms) {
		const handle = setTimeout(callback, ms);
		handle.unref();
		return () => clearTimeout(handle);
	},
};

/** The pushes that carry a running reply or a log: dropped while the page is hidden (it reloads state on return). */
const STREAM_CHANNELS: ReadonlySet<string> = new Set([
	IPC_EVENTS.EVENTS_BATCH,
	IPC_EVENTS.SUBAGENT_FRAMES,
	IPC_EVENTS.LIVE_FRAME,
	IPC_EVENTS.BTW_FRAME,
	IPC_EVENTS.LOG_LINE,
	IPC_EVENTS.COMMAND_OUTPUT,
]);

/** Pushes for the desktop's own windows: a web window never gets them. */
const DESKTOP_ONLY_PUSH: Readonly<Record<string, true>> = {
	[WEB_DEVICES_CHANGED]: true,
	[WEB_DEVICE_CONNECTED]: true,
	[WEB_PAIRING_REQUEST]: true,
};

/** Calls that read or scan a lot: a device runs a few at once. */
const HEAVY_CHANNELS: ReadonlySet<string> = new Set([
	IPC_COMMANDS.FS_SEARCH,
	IPC_COMMANDS.FS_READ_BINARY,
	IPC_COMMANDS.FS_LIST,
	IPC_COMMANDS.REMOTE_LIST_DIRS,
]);

/** The caller of a web-only channel: who, and the window their pushes and tabs belong to. */
export interface WebCallContext {
	deviceId: string;
	device: WebDevice;
	win: WebClientWindow;
}

export interface WebChannelEntry {
	dir: "invoke" | "send";
	permission: WebPermission;
	/** Counts against the device's concurrent heavy calls. */
	heavy?: boolean;
	handler(context: WebCallContext, args: readonly unknown[]): unknown;
}

/** Channels a web device has and Electron's windows do not (shared/web-host.ts and the device's own prefs). */
export type WebChannelTable = Readonly<Record<string, WebChannelEntry>>;

/** What the router needs of a socket. */
export interface RouterSocket {
	send(data: string): void;
	close(code: number, reason: string): void;
	/** A WebSocket-level ping (the page's browser answers it without a script). */
	ping(): void;
	/** Drop the connection without a close handshake (a peer that stopped answering). */
	terminate(): void;
	/** Bytes queued for the peer and not yet written. */
	readonly bufferedAmount?: number;
}

export interface WsRouterDeps {
	registry: {
		invoke(channel: string, caller: IpcCaller, args: readonly unknown[]): Promise<unknown>;
		send(channel: string, caller: IpcCaller, args: readonly unknown[]): void;
	};
	devices: Pick<WebDevices, "get">;
	windows: Pick<WebWindows, "windowFor" | "callerFor">;
	quota: Pick<PeerQuota, "reserve" | "record">;
	webChannels: WebChannelTable;
	features: () => WebFeatures;
	/** The tab a window's untargeted calls act on, to know whose model command it was. */
	activeTab?: (win: WebClientWindow) => string | null;
	/** `/blob` URLs for bytes and streams a reply carries. */
	blobs: Pick<BlobStore, "addBytes" | "addMedia" | "mediaUrl" | "release">;
	/** Opens an `omp-media://` stream for a range (MediaStreams.handle); without it a stream answer passes unchanged. */
	mediaOpen?: (url: string, range: string | undefined) => Promise<Response>;
	/** A device's connection count changed (the settings list shows who is connected). */
	onConnectionsChanged?: (deviceId: string) => void;
	now?: () => number;
	timers?: Timers;
}

const FrameSchema = z.discriminatedUnion("t", [
	z.object({
		t: z.literal("inv"),
		id: z.number().int().nonnegative(),
		ch: z.string().min(1).max(128),
		a: z.array(z.unknown()).max(16),
	}),
	z.object({ t: z.literal("snd"), ch: z.string().min(1).max(128), a: z.array(z.unknown()).max(16) }),
	z.object({ t: z.literal("ack"), seq: z.number().int().nonnegative() }),
	z.object({ t: z.literal("presence"), visible: z.boolean() }),
	z.object({ t: z.literal("ping") }),
	z.object({ t: z.literal("pong") }),
]);

interface QueuedEvent {
	ch: string;
	d: unknown;
}

interface TabBatch {
	tabId: string;
	payload: AgentSessionEvent[];
}

function isTabBatch(data: unknown): data is TabBatch {
	return (
		typeof data === "object" &&
		data !== null &&
		"tabId" in data &&
		typeof data.tabId === "string" &&
		"payload" in data &&
		Array.isArray(data.payload)
	);
}

type MessageUpdate = Extract<AgentSessionEvent, { type: "message_update" }>;
const DELTA_TYPES: ReadonlySet<string> = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

/** A streamed update with no snapshot (the pool slims every update after a message's first): its delta can be joined. */
function mergeableUpdate(event: AgentSessionEvent): event is MessageUpdate {
	if (event.type !== "message_update") return false;
	const increment = event.assistantMessageEvent;
	return DELTA_TYPES.has(increment.type) && !("content" in event.message);
}

/** Two neighbouring slim updates of one block of one message become one with their deltas joined. */
function joinUpdates(earlier: MessageUpdate, later: MessageUpdate): MessageUpdate | null {
	const a = earlier.assistantMessageEvent;
	const b = later.assistantMessageEvent;
	if (a.type !== b.type || a.contentIndex !== b.contentIndex) return null;
	if (earlier.messageId !== later.messageId || earlier.message.timestamp !== later.message.timestamp) return null;
	return { ...later, assistantMessageEvent: { ...b, delta: a.delta + b.delta } };
}

/** Merge a tab's neighbouring slim `message_update`s; anything else keeps its place and count. */
export function mergeMessageUpdates(events: readonly AgentSessionEvent[]): AgentSessionEvent[] {
	const merged: AgentSessionEvent[] = [];
	for (const event of events) {
		const previous = merged.at(-1);
		if (previous && mergeableUpdate(previous) && mergeableUpdate(event)) {
			const joined = joinUpdates(previous, event);
			if (joined) {
				merged[merged.length - 1] = joined;
				continue;
			}
		}
		merged.push(event);
	}
	return merged;
}

/** Join neighbouring `EVENTS_BATCH` pushes of one tab into one, then merge their streaming deltas. */
export function coalesceEvents(queue: readonly QueuedEvent[]): QueuedEvent[] {
	const out: QueuedEvent[] = [];
	for (const item of queue) {
		const previous = out.at(-1);
		if (
			previous &&
			item.ch === IPC_EVENTS.EVENTS_BATCH &&
			previous.ch === IPC_EVENTS.EVENTS_BATCH &&
			isTabBatch(previous.d) &&
			isTabBatch(item.d) &&
			previous.d.tabId === item.d.tabId
		) {
			out[out.length - 1] = {
				ch: item.ch,
				d: { tabId: item.d.tabId, payload: [...previous.d.payload, ...item.d.payload] },
			};
			continue;
		}
		out.push(item);
	}
	return out.map(item =>
		item.ch === IPC_EVENTS.EVENTS_BATCH && isTabBatch(item.d)
			? { ch: item.ch, d: { ...item.d, payload: mergeMessageUpdates(item.d.payload) } }
			: item,
	);
}

/** Tokens one assistant reply used (its `message_end` usage). */
function assistantTokens(event: AgentSessionEvent): number {
	if (event.type !== "message_end") return 0;
	const { message } = event;
	if (message.role !== "assistant" || !("usage" in message)) return 0;
	const usage: unknown = message.usage;
	if (typeof usage !== "object" || usage === null || !("totalTokens" in usage)) return 0;
	const total = usage.totalTokens;
	return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : 0;
}

/** The host's RemoteState without the pairing code a page must never read. */
function withoutPairingCode(state: unknown): unknown {
	if (typeof state !== "object" || state === null || !("host" in state)) return state;
	const { host } = state;
	if (typeof host !== "object" || host === null) return state;
	return { ...state, host: { ...host, code: null, expiresAt: null } };
}

const SECRET_PREF_KEY = /token|secret|password|passphrase|credential|api[-_]?key/i;

/** PREFS_GET's whole-store answer without keys that look like credentials. */
function withoutSecretPrefs(store: unknown): unknown {
	if (typeof store !== "object" || store === null || Array.isArray(store)) return store;
	return Object.fromEntries(Object.entries(store).filter(([key]) => !SECRET_PREF_KEY.test(key)));
}

function webError(error: unknown): WebInvokeError {
	const message = error instanceof Error ? error.message : String(error);
	const code = ipcErrorCode(error);
	return code ? { message, code } : { message };
}

function forbidden(message: string): Error {
	return codedError("web_forbidden", message);
}

/** The command and the tab a model-using RPC payload names, for the quota. */
function rpcPayload(payload: unknown): { command: unknown; tabId: string | undefined } {
	if (typeof payload !== "object" || payload === null) return { command: undefined, tabId: undefined };
	const command = "command" in payload ? payload.command : undefined;
	const tabId = "tabId" in payload && typeof payload.tabId === "string" ? payload.tabId : undefined;
	return { command, tabId };
}

function isCommandWithType(command: unknown): command is Parameters<typeof commandUsesModel>[0] {
	return typeof command === "object" && command !== null && "type" in command && typeof command.type === "string";
}

export class WsRouter {
	readonly #deps: WsRouterDeps;
	readonly #connections = new Map<string, Set<WsConnection>>();
	readonly #heavy = new ConcurrencyLimiter(HEAVY_CALLS_PER_DEVICE);
	/** The device that last sent each tab a model command: it is charged that tab's tokens. */
	readonly #drivers = new Map<string, string>();
	readonly now: () => number;
	readonly timers: Timers;

	constructor(deps: WsRouterDeps) {
		this.#deps = deps;
		this.now = deps.now ?? Date.now;
		this.timers = deps.timers ?? realTimers;
	}

	get deps(): WsRouterDeps {
		return this.#deps;
	}

	get heavy(): ConcurrencyLimiter {
		return this.#heavy;
	}

	connectionCount(deviceId: string): number {
		return this.#connections.get(deviceId)?.size ?? 0;
	}

	isConnected(deviceId: string): boolean {
		return this.connectionCount(deviceId) > 0;
	}

	/** Some socket of the device is open with its page in the foreground (`presence.visible`): it sees events live. */
	isDeviceVisible(deviceId: string): boolean {
		for (const connection of this.#connections.get(deviceId) ?? []) if (connection.visible) return true;
		return false;
	}

	/** Start serving a socket the server accepted for `deviceId`; null when the device already has its four. */
	attach(deviceId: string, socket: RouterSocket): WsConnection | null {
		if (this.connectionCount(deviceId) >= MAX_CONNECTIONS_PER_DEVICE) return null;
		const connection = new WsConnection(this, deviceId, socket);
		let set = this.#connections.get(deviceId);
		if (!set) {
			set = new Set();
			this.#connections.set(deviceId, set);
		}
		set.add(connection);
		this.#deps.onConnectionsChanged?.(deviceId);
		connection.start();
		return connection;
	}

	/** Called by a connection that ended. */
	detach(connection: WsConnection): void {
		const set = this.#connections.get(connection.deviceId);
		if (!set?.delete(connection)) return;
		if (set.size === 0) this.#connections.delete(connection.deviceId);
		this.#deps.onConnectionsChanged?.(connection.deviceId);
	}

	/** A push the pool or a handler made to the device's window. */
	deliver(deviceId: string, channel: string, payload: unknown): void {
		this.#recordTokens(deviceId, channel, payload);
		const policy = Object.hasOwn(IPC_POLICY, channel) ? IPC_POLICY[channel as IpcChannel] : undefined;
		if (policy?.dir !== "push" || policy.mode === "client" || Object.hasOwn(DESKTOP_ONLY_PUSH, channel)) return;
		const data = channel === IPC_EVENTS.REMOTE_STATE ? withoutPairingCode(payload) : payload;
		for (const connection of this.#connections.get(deviceId) ?? []) connection.push(channel, data);
	}

	closeDevice(deviceId: string, code: number, reason: string): void {
		for (const connection of [...(this.#connections.get(deviceId) ?? [])]) connection.close(code, reason);
	}

	closeAll(code: number, reason: string): void {
		for (const deviceId of [...this.#connections.keys()]) this.closeDevice(deviceId, code, reason);
	}

	noteDriver(tabId: string, deviceId: string): void {
		this.#drivers.set(tabId, deviceId);
	}

	/** A finished turn's tokens go to the device that drove the tab, whether or not its page is looking. */
	#recordTokens(deviceId: string, channel: string, payload: unknown): void {
		if (channel !== IPC_EVENTS.EVENTS_BATCH || !isTabBatch(payload)) return;
		if (this.#drivers.get(payload.tabId) !== deviceId) return;
		let tokens = 0;
		for (const event of payload.payload) tokens += assistantTokens(event);
		if (tokens > 0) this.#deps.quota.record(deviceId, { tokens });
	}
}

export class WsConnection {
	readonly deviceId: string;
	readonly connId = randomUUID();
	readonly #router: WsRouter;
	readonly #socket: RouterSocket;
	readonly #bucket: TokenBucket;
	#queue: QueuedEvent[] = [];
	#cancelFlush: (() => void) | null = null;
	#stopHeartbeat: (() => void) | null = null;
	#seq = 0;
	#visible = true;
	#closed = false;
	#misses = 0;
	#lastActivity: number;
	#lastTick: number;

	constructor(router: WsRouter, deviceId: string, socket: RouterSocket) {
		this.#router = router;
		this.deviceId = deviceId;
		this.#socket = socket;
		this.#bucket = new TokenBucket(MESSAGE_RATE, MESSAGE_BURST, router.now);
		this.#lastActivity = router.now();
		this.#lastTick = router.now();
	}

	start(): void {
		this.#sendHello(false);
		this.#stopHeartbeat = this.#router.timers.every(() => this.#tick(), HEARTBEAT_MS);
	}

	/** One text frame from the page. */
	receive(text: string): void {
		if (this.#closed) return;
		this.#lastActivity = this.#router.now();
		if (text.length > MAX_FRAME_BYTES || Buffer.byteLength(text) > MAX_FRAME_BYTES) {
			this.close(CLOSE_TOO_BIG, "frame too large");
			return;
		}
		if (!this.#bucket.take()) {
			this.close(CLOSE_RATE_LIMITED, "too many messages");
			return;
		}
		let frame: WebClientFrame;
		try {
			frame = FrameSchema.parse(JSON.parse(text));
		} catch {
			this.close(CLOSE_POLICY, "malformed frame");
			return;
		}
		switch (frame.t) {
			case "inv":
				void this.#invoke(frame.id, frame.ch, frame.a);
				return;
			case "snd":
				this.#send(frame.ch, frame.a);
				return;
			case "ping":
				this.#write({ t: "pong" });
				return;
			case "presence":
				this.#setVisible(frame.visible);
				return;
			case "ack":
			case "pong":
				return;
		}
	}

	/** A pushed event for this socket; queued, merged and sent within a batch window. */
	push(channel: string, data: unknown): void {
		if (this.#closed || (!this.#visible && STREAM_CHANNELS.has(channel))) return;
		this.#queue.push({ ch: channel, d: data });
		if (this.#cancelFlush) return;
		this.#cancelFlush = this.#router.timers.after(() => this.flush(), EVENT_BATCH_MS);
	}

	/** Send what is queued now. */
	flush(): void {
		this.#cancelFlush = null;
		if (this.#closed || this.#queue.length === 0) return;
		const queue = this.#queue;
		this.#queue = [];
		for (const item of coalesceEvents(queue)) this.#write({ t: "evt", seq: ++this.#seq, ch: item.ch, d: item.d });
		if ((this.#socket.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) this.close(CLOSE_SLOW_CONSUMER, "slow consumer");
	}

	close(code: number, reason: string): void {
		if (this.#closed) return;
		this.#finish();
		try {
			this.#socket.close(code, reason);
		} catch {
			this.#socket.terminate();
		}
	}

	/** The socket ended on its own. */
	dispose(): void {
		this.#finish();
	}

	#finish(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#cancelFlush?.();
		this.#stopHeartbeat?.();
		this.#cancelFlush = null;
		this.#stopHeartbeat = null;
		this.#queue = [];
		this.#router.detach(this);
	}

	#write(frame: WebServerFrame): void {
		if (this.#closed) return;
		try {
			this.#socket.send(JSON.stringify(frame));
		} catch {
			// A payload that cannot be serialized or a socket that just closed: the page re-reads state on reconnect.
		}
	}

	#sendHello(resumed: boolean): void {
		this.#write({
			t: "hello",
			protocol: WEB_PROTOCOL_VERSION,
			minClient: WEB_PROTOCOL_VERSION,
			connId: this.connId,
			resumed,
			features: this.#router.deps.features(),
		});
	}

	/** The page's last `presence` (visible until it says otherwise). */
	get visible(): boolean {
		return this.#visible;
	}

	#setVisible(visible: boolean): void {
		if (visible === this.#visible) return;
		this.#visible = visible;
		if (!visible) {
			this.#queue = this.#queue.filter(item => !STREAM_CHANNELS.has(item.ch));
			return;
		}
		// Whatever streamed while hidden was dropped: the page reloads its state, as after a reconnect.
		this.#queue = [];
		this.#sendHello(false);
	}

	/** Every 20 s: a socket that said nothing for three ticks in a row is gone; a tick that ran late counts for nothing. */
	#tick(): void {
		const now = this.#router.now();
		const late = now - this.#lastTick > HEARTBEAT_MS * 1.5;
		const quiet = now - this.#lastActivity >= HEARTBEAT_MS;
		this.#lastTick = now;
		if (late || !quiet) {
			this.#misses = 0;
		} else if (++this.#misses >= HEARTBEAT_MAX_MISSES) {
			this.#finish();
			this.#socket.terminate();
			return;
		}
		try {
			this.#socket.ping();
		} catch {
			// The socket is closing; its close event ends this connection.
		}
		this.#write({ t: "ping" });
	}

	/** The device now, or the reason it cannot call (revoked while connected). */
	#caller(): { device: WebDevice; win: WebClientWindow; caller: IpcCaller } | null {
		const { devices, windows } = this.#router.deps;
		const device = devices.get(this.deviceId);
		if (!device) {
			this.close(CLOSE_REVOKED, "revoked");
			return null;
		}
		return { device, win: windows.windowFor(this.deviceId), caller: windows.callerFor(this.deviceId) };
	}

	async #invoke(id: number, channel: string, args: readonly unknown[]): Promise<void> {
		try {
			const value = await this.#dispatch("invoke", channel, args);
			this.#write({ t: "res", id, ok: true, v: value });
		} catch (error) {
			this.#write({ t: "res", id, ok: false, e: webError(error) });
		}
	}

	#send(channel: string, args: readonly unknown[]): void {
		void this.#dispatch("send", channel, args).catch(() => {
			// A fire-and-forget call has nobody to tell.
		});
	}

	async #dispatch(dir: "invoke" | "send", channel: string, args: readonly unknown[]): Promise<unknown> {
		const who = this.#caller();
		if (!who) throw forbidden("This device is no longer paired");
		const { device, win, caller } = who;
		const { webChannels, registry } = this.#router.deps;

		const own = Object.hasOwn(webChannels, channel) ? webChannels[channel] : undefined;
		if (own) {
			this.#authorize(device, dir, own.dir, own.permission, channel);
			const release = own.heavy ? this.#acquireHeavy() : null;
			try {
				return await own.handler({ deviceId: this.deviceId, device, win }, args);
			} finally {
				release?.();
			}
		}

		const policy = Object.hasOwn(IPC_POLICY, channel) ? IPC_POLICY[channel as IpcChannel] : undefined;
		if (!policy || policy.dir === "push") throw forbidden(`Unknown channel ${channel}`);
		if (policy.mode === "boundary") throw forbidden(`${channel} is not available to a paired web device`);
		this.#authorize(device, dir, policy.dir, policy.permission, channel);
		this.#guardPrefs(channel, args);

		const release = HEAVY_CHANNELS.has(channel) ? this.#acquireHeavy() : null;
		const refund = dir === "invoke" ? this.#meter(channel, args, win) : null;
		try {
			if (dir === "send") {
				registry.send(channel, caller, this.#translate(channel, args));
				return undefined;
			}
			const result = await registry.invoke(channel, caller, args);
			if (refund && refused(result)) refund();
			return this.#shape(channel, args, result);
		} catch (error) {
			refund?.();
			throw error;
		} finally {
			release?.();
		}
	}

	#authorize(
		device: WebDevice,
		asked: "invoke" | "send",
		declared: "invoke" | "send",
		permission: WebPermission,
		channel: string,
	): void {
		if (asked !== declared) throw forbidden(`${channel} is not a ${asked} channel`);
		if (permission === "pairing-admin" || !device.grants.includes(permission)) {
			throw forbidden(`This device may not use ${channel} (${permission})`);
		}
	}

	/** `mobileWeb.*` preferences decide who may pair and reach the page: only the desktop writes them. */
	#guardPrefs(channel: string, args: readonly unknown[]): void {
		if (channel !== IPC_COMMANDS.PREFS_SET) return;
		const payload = args[0];
		const key = typeof payload === "object" && payload !== null && "key" in payload ? payload.key : undefined;
		if (typeof key === "string" && key.toLowerCase().startsWith("mobileweb")) {
			throw forbidden("Mobile web settings can only be changed on the computer");
		}
	}

	#acquireHeavy(): () => void {
		const release = this.#router.heavy.acquire(this.deviceId);
		if (!release) throw forbidden("Too many heavy requests at once");
		return release;
	}

	/**
	 * Count a model command against the device's daily limit before it runs (synchronously, so parallel
	 * callers see each other). The returned function gives the request back; null when the call is free.
	 */
	#meter(channel: string, args: readonly unknown[], win: WebClientWindow): (() => void) | null {
		const weight = this.#modelRequests(channel, args, win);
		if (weight === 0) return null;
		const reservation = this.#router.deps.quota.reserve(this.deviceId, weight);
		if (!reservation.ok) {
			throw codedError(
				"remote_limit_reached",
				reservation.refusal === "requests" && weight > 1
					? `This needs ${weight} of this device's daily requests on this computer's models, more than are left today.`
					: `This device's ${reservation.refusal === "requests" ? "request" : "token"} limit for today on this computer's models is used up.`,
			);
		}
		return reservation.refund;
	}

	/** How many model requests a call spends: 0 for a free one. */
	#modelRequests(channel: string, args: readonly unknown[], win: WebClientWindow): number {
		if (channel === IPC_COMMANDS.RPC_COMMAND || channel === IPC_COMMANDS.RPC_COMMAND_FOR_TAB) {
			const { command, tabId } = rpcPayload(args[0]);
			if (!isCommandWithType(command) || !commandUsesModel(command)) return 0;
			const tab = tabId ?? this.#router.deps.activeTab?.(win) ?? null;
			if (tab) this.#router.noteDriver(tab, this.deviceId);
			return 1;
		}
		if (channel === IPC_COMMANDS.BENCH_RUN) {
			const options = args[0];
			const models = typeof options === "object" && options !== null && "models" in options ? options.models : null;
			const runs = typeof options === "object" && options !== null && "runs" in options ? options.runs : null;
			const count = Array.isArray(models) && typeof runs === "number" ? models.length * runs : 1;
			return Math.max(1, Number.isFinite(count) ? Math.floor(count) : 1);
		}
		return channel === IPC_COMMANDS.MODEL_SETUP_RUN ? 1 : 0;
	}

	/** What a page may see: no pairing code, no secret-looking preferences, no raw bytes or `omp-media://` address. */
	#shape(channel: string, args: readonly unknown[], result: unknown): unknown {
		if (channel === IPC_COMMANDS.REMOTE_GET_STATE) return withoutPairingCode(result);
		if (channel === IPC_COMMANDS.PREFS_GET) {
			const payload = args[0];
			const keyed = typeof payload === "object" && payload !== null && "key" in payload && payload.key;
			return keyed ? result : withoutSecretPrefs(result);
		}
		if (channel === IPC_COMMANDS.FS_READ_BINARY) return this.#binaryResult(result);
		if (channel === IPC_COMMANDS.FS_MEDIA_STREAM) return this.#mediaResult(result);
		return result;
	}

	/** The file's bytes inline as base64 up to 512 KiB, else behind a `/blob` URL (the shim turns either back into bytes). */
	#binaryResult(result: unknown): unknown {
		if (
			typeof result !== "object" ||
			result === null ||
			!("data" in result) ||
			!(result.data instanceof Uint8Array)
		) {
			return result;
		}
		const { data, ...rest } = result;
		if (data.length <= INLINE_BINARY_MAX_BYTES) {
			return { ...rest, dataBase64: Buffer.from(data.buffer, data.byteOffset, data.length).toString("base64") };
		}
		const mime = "mime" in rest && typeof rest.mime === "string" ? rest.mime : "application/octet-stream";
		return { ...rest, blobUrl: this.#router.deps.blobs.addBytes(this.deviceId, data, mime) };
	}

	/** A player's stream: `MediaStreams` keeps serving it, behind this device's `/blob` URL. */
	#mediaResult(result: unknown): unknown {
		const { blobs, mediaOpen } = this.#router.deps;
		if (!mediaOpen || typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true) {
			return result;
		}
		if (
			!("url" in result) ||
			typeof result.url !== "string" ||
			!("mime" in result) ||
			typeof result.mime !== "string"
		) {
			return result;
		}
		const size = "size" in result && typeof result.size === "number" ? result.size : 0;
		const url = result.url;
		const open = (range: string | undefined): Promise<Response> => mediaOpen(url, range);
		return { ...result, url: blobs.addMedia(this.deviceId, { url, mime: result.mime, size, open }) };
	}

	/** `FS_MEDIA_RELEASE` names the `/blob` URL the page holds; the handler knows the `omp-media://` one. */
	#translate(channel: string, args: readonly unknown[]): readonly unknown[] {
		if (channel !== IPC_COMMANDS.FS_MEDIA_RELEASE || typeof args[0] !== "string") return args;
		const { blobs } = this.#router.deps;
		const media = blobs.mediaUrl(this.deviceId, args[0]);
		blobs.release(this.deviceId, args[0]);
		return media === null ? args : [media];
	}
}

/** An RPC response that reports failure: the request it reserved is given back. */
function refused(result: unknown): boolean {
	return typeof result === "object" && result !== null && "success" in result && result.success === false;
}
