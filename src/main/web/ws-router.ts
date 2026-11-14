/**
 * Main's side of the paired pages' router. The sockets are the core's (`native/ompdesk/crates/core/src/web/router.rs`,
 * native-rust ledger 8c): there each connection is rate limited, its frames parsed, its pushes numbered, batched every
 * 75 ms with a reply's streaming deltas merged and dropped while the page reports itself hidden, and each call is
 * checked against the channel policy (ipc-policy.ts), the web-only channels and the device's grants. What stays here
 * is what reads main's state in the same tick: a call the core let through (`web.call`) runs on the one `IpcRegistry`
 * (`invoke` for `inv`, `send` for `snd`) with the device's `WebClientWindow` as the caller, after the model-use quota
 * counted it and a picture the page sent by upload (`WebUploadedImage`) was read back into it; the window's pushes
 * go to the core once per device (`web.deliver`), a stream's data text made once for every device; and a copy of
 * each device's connections (`web.conns`) answers who is connected and whose page is in the foreground.
 *
 * Every message between the core and main is handled in the order it came: a page's call reaches main before the
 * event that ends its connection, and a call's answer (`web.reply`) leaves after every push main made before it.
 */
import { codedError, ipcErrorCode } from "../../shared/ipc-error-codes";
import { IPC_COMMANDS, IPC_EVENTS } from "../../shared/ipc-types";
import { WEB_DEVICE_CONNECTED, WEB_DEVICES_CHANGED, WEB_PAIRING_REQUEST } from "../../shared/mobile-web";
import type { AgentSessionEvent } from "../../shared/rpc-types";
import {
	holdsBlock,
	isWebUploadedImage,
	replaceBlocks,
	WEB_PROTOCOL_VERSION,
	type WebFeatures,
	type WebInvokeError,
	type WebPermission,
} from "../../shared/web-protocol";
import { CORE_EXITED, type CoreProcess, core } from "../core/process";
import type { PeerQuota } from "../remote/peer-quota";
import { commandUsesModel } from "../remote/quota-commands";
import type { BlobStore } from "./blobs";
import type { WebDevice, WebDevices } from "./devices-store";
import { IPC_POLICY } from "./ipc-policy";
import type { IpcCaller } from "./ipc-registry";
import type { UploadStore } from "./uploads";
import type { WebClientWindow, WebWindows } from "./web-client-window";

/** Files up to this size ride in the reply as base64; bigger ones are fetched over `/blob`. */
const INLINE_BINARY_MAX_BYTES = 512 * 1024;

/** The device was revoked or expired. */
export const CLOSE_REVOKED = 4401;

/**
 * The pushes that carry a running reply or a log: the core's router drops them while the page is hidden (it reloads
 * state on return), and their data is a fresh object the pool never changes, so its JSON is made once for every device.
 */
const STREAM_CHANNELS: ReadonlySet<string> = new Set([
	IPC_EVENTS.EVENTS_BATCH,
	IPC_EVENTS.SUBAGENT_FRAMES,
	IPC_EVENTS.LIVE_FRAME,
	IPC_EVENTS.BTW_FRAME,
	IPC_EVENTS.LOG_LINE,
	IPC_EVENTS.COMMAND_OUTPUT,
]);

/** Calls that read or scan a lot: a device runs a few at once. */
const HEAVY_CHANNELS: readonly string[] = [
	IPC_COMMANDS.FS_SEARCH,
	IPC_COMMANDS.FS_READ_BINARY,
	IPC_COMMANDS.FS_LIST,
	IPC_COMMANDS.REMOTE_LIST_DIRS,
];

/** Pushes for the desktop's own windows: a web window never gets them. */
const DESKTOP_ONLY_PUSH: Readonly<Record<string, true>> = {
	[WEB_DEVICES_CHANGED]: true,
	[WEB_DEVICE_CONNECTED]: true,
	[WEB_PAIRING_REQUEST]: true,
};

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

export interface WsRouterDeps {
	registry: {
		invoke(channel: string, caller: IpcCaller, args: readonly unknown[]): Promise<unknown>;
		send(channel: string, caller: IpcCaller, args: readonly unknown[]): void;
	};
	devices: Pick<WebDevices, "get">;
	windows: Pick<WebWindows, "windowFor"> & { callerFor(deviceId: string, connId?: string): IpcCaller };
	quota: Pick<PeerQuota, "reserve" | "record">;
	webChannels: WebChannelTable;
	features: () => WebFeatures;
	/** The page build this host serves (`WEB_BUILD_META` of its `web.html`); null in a dev run. */
	build?: () => string | null;
	/** The tab a window's untargeted calls act on, to know whose model command it was. */
	activeTab?: (win: WebClientWindow) => string | null;
	/** `/blob` URLs for bytes and streams a reply carries. */
	blobs: Pick<BlobStore, "addBytes" | "addMedia" | "mediaUrl" | "release">;
	/** Opens an `omp-media://` stream for a range (`mediaResponse`); without it a stream answer passes unchanged. */
	mediaOpen?: (url: string, range: string | undefined) => Promise<Response>;
	/** The device's uploads: a picture a call names by upload (`WebUploadedImage`) is read back into the call. */
	uploads: Pick<UploadStore, "take">;
	/** A picture in a format models refuse made model-safe (stock's image path in the stock helper, `image.toModel`). */
	toModelImage: (image: InlineImage) => Promise<InlineImage>;
	/** A device's connection count changed (the settings list shows who is connected). */
	onConnectionsChanged?: (deviceId: string) => void;
	/** One connection of the device ended (its socket closed, was retired or timed out); others of the device may remain. */
	onConnectionEnded?: (deviceId: string, connId: string) => void;
	/** The device's page got a hello it must resync from (`resumed: false`): it missed pushes. */
	onResync?: (deviceId: string) => void;
}

/** What the core's router is started with (`web.start`'s `router`). */
export interface RouterConfig {
	channels: { batch: string; streams: string[]; heavy: readonly string[]; prefsSet: string };
	protocol: number;
	features: WebFeatures;
	build: string | null;
	policy: Record<string, { dir: string; permission?: string; mode: string }>;
	webChannels: Record<string, { dir: string; permission: string; heavy: boolean }>;
}

/** A call the core let through. `answer`: the core waits for `web.reply` (an invoke, or a send holding a heavy slot). */
interface CallEvent {
	host: number;
	call: number;
	answer: boolean;
	device: string;
	connId: string;
	dir: "invoke" | "send";
	ch: string;
}

interface PageConnection {
	connId: string;
	visible: boolean;
}

/** A device's connections after one came or went, or a page told its presence. */
interface ConnsEvent {
	host: number;
	device: string;
	conns: PageConnection[];
	change: "attach" | "end" | "presence";
	connId: string;
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

/** An image block with its bytes inline, as a call carries it to the registry. */
export interface InlineImage {
	type: "image";
	data: string;
	mimeType: string;
}

/**
 * Whether a picture's format is one models refuse (anything but JPEG, PNG, GIF and WebP: an iPhone's HEIC, AVIF,
 * TIFF, BMP, ...): stock's image path converts it as it lands. An SVG never comes as a picture (composer-files.ts).
 */
export function convertsForModel(mimeType: string): boolean {
	const type = mimeType.trim().toLowerCase();
	return type.startsWith("image/") && !/^image\/(jpe?g|png|gif|webp)$/.test(type);
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

/** An RPC response that reports failure: the request it reserved is given back. */
function refused(result: unknown): boolean {
	return typeof result === "object" && result !== null && "success" in result && result.success === false;
}

/** `IPC_POLICY` as the core's router reads it, made once. */
let policyData: RouterConfig["policy"] | null = null;

function routerPolicy(): RouterConfig["policy"] {
	policyData ??= Object.fromEntries(
		Object.entries(IPC_POLICY).map(([channel, policy]) => [
			channel,
			"permission" in policy
				? { dir: policy.dir, permission: policy.permission, mode: policy.mode }
				: { dir: policy.dir, mode: policy.mode },
		]),
	);
	return policyData;
}

const routers = new Map<number, WsRouter>();
let nextHost = 0;
let routed: CoreProcess | null = null;

/** The core's router events reach the router they name. */
function route(process: CoreProcess): void {
	if (routed === process) return;
	routed = process;
	process.on("web.call", (data, bin, generation) => {
		const event = data as CallEvent;
		routers.get(event.host)?.call(event, bin === null ? "[]" : Buffer.from(bin).toString("utf8"), generation);
	});
	process.on("web.conns", data => {
		const event = data as ConnsEvent;
		routers.get(event.host)?.connections(event);
	});
	process.on("web.resync", (data, _bin, generation) => {
		const { host, conn, device } = data as { host: number; conn: number; device: string };
		routers.get(host)?.resync(conn, device, generation);
	});
	process.on(CORE_EXITED, () => {
		for (const router of routers.values()) router.coreExited();
	});
}

export class WsRouter {
	/** The number the core's router and edge know this host by (`web.start`'s `host`). */
	readonly host = ++nextHost;
	readonly #deps: WsRouterDeps;
	/** Each connected device's connections, as the core last told them. */
	readonly #connections = new Map<string, PageConnection[]>();
	/** The device that last sent each tab a model command: it is charged that tab's tokens. */
	readonly #drivers = new Map<string, string>();
	/** A streamed push's data JSON, made once for every device that gets the pool's very push object. */
	readonly #texts = new WeakMap<object, Uint8Array>();
	/** Devices told of a push they had no connection for: until one connects, one word is all the core needs. */
	readonly #unsent = new Set<string>();
	/** The generation of the core whose router this host started in (`started`); 0 before the first start. */
	#startedIn = 0;

	constructor(deps: WsRouterDeps) {
		this.#deps = deps;
	}

	get deps(): WsRouterDeps {
		return this.#deps;
	}

	/** What `web.start` hands the core's router; from here the core's router events reach this one. */
	config(): RouterConfig {
		route(core());
		routers.set(this.host, this);
		const webChannels = Object.fromEntries(
			Object.entries(this.#deps.webChannels).map(([channel, entry]) => [
				channel,
				{ dir: entry.dir, permission: entry.permission, heavy: entry.heavy === true },
			]),
		);
		return {
			channels: {
				batch: IPC_EVENTS.EVENTS_BATCH,
				streams: [...STREAM_CHANNELS],
				heavy: HEAVY_CHANNELS,
				prefsSet: IPC_COMMANDS.PREFS_SET,
			},
			protocol: WEB_PROTOCOL_VERSION,
			features: this.#deps.features(),
			build: this.#deps.build?.() ?? null,
			policy: routerPolicy(),
			webChannels,
		};
	}

	/** The core of `generation` answered `web.start`: its router holds this host until that core ends. */
	started(generation: number): void {
		this.#startedIn = generation;
	}

	/** Whether the core running now is the one that started this host's router (a later core has not). */
	#open(): boolean {
		return this.#startedIn !== 0 && this.#startedIn === core().generation;
	}

	connectionCount(deviceId: string): number {
		return this.#connections.get(deviceId)?.length ?? 0;
	}

	isConnected(deviceId: string): boolean {
		return this.connectionCount(deviceId) > 0;
	}

	/** Some socket of the device is open with its page in the foreground (`presence.visible`): it sees events live. */
	isDeviceVisible(deviceId: string): boolean {
		return this.#connections.get(deviceId)?.some(connection => connection.visible) ?? false;
	}

	/** A push the pool or a handler made to the device's window. */
	deliver(deviceId: string, channel: string, payload: unknown): void {
		this.#recordTokens(deviceId, channel, payload);
		const policy = Object.hasOwn(IPC_POLICY, channel) ? IPC_POLICY[channel as keyof typeof IPC_POLICY] : undefined;
		if (policy?.dir !== "push" || policy.mode === "client" || Object.hasOwn(DESKTOP_ONLY_PUSH, channel)) return;
		if (!this.#open()) return;
		if (!this.#connections.has(deviceId)) {
			// Counted, so a page that comes back is not told it missed nothing; its data would reach no socket.
			if (this.#unsent.has(deviceId)) return;
			this.#unsent.add(deviceId);
			core().push("web.deliver", { host: this.host, device: deviceId });
			return;
		}
		let data: Uint8Array | undefined;
		try {
			data = this.#dataBytes(channel, payload);
		} catch {
			return;
		}
		core().push("web.deliver", { host: this.host, device: deviceId, ch: channel }, data);
	}

	/** `JSON.stringify(payload)`'s bytes; a stream's made once per push object. Throws as `JSON.stringify` does. */
	#dataBytes(channel: string, payload: unknown): Uint8Array | undefined {
		const keyed = STREAM_CHANNELS.has(channel) && typeof payload === "object" && payload !== null ? payload : null;
		const known = keyed ? this.#texts.get(keyed) : undefined;
		if (known) return known;
		const text = JSON.stringify(payload);
		if (text === undefined) return undefined;
		const bytes = Buffer.from(text, "utf8");
		if (keyed) this.#texts.set(keyed, bytes);
		return bytes;
	}

	closeDevice(deviceId: string, code: number, reason: string): void {
		if (this.#open()) core().push("web.closeDevice", { host: this.host, device: deviceId, code, reason });
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

	/** The core's word on a device's connections. */
	connections(event: ConnsEvent): void {
		if (event.conns.length > 0) {
			this.#connections.set(event.device, event.conns);
			this.#unsent.delete(event.device);
		} else {
			this.#connections.delete(event.device);
		}
		if (event.change === "presence") return;
		this.#deps.onConnectionsChanged?.(event.device);
		if (event.change === "end") this.#deps.onConnectionEnded?.(event.device, event.connId);
	}

	/** A page is about to be told to resync: the pool sends whole stream snapshots from now, then the hello goes. */
	resync(conn: number, deviceId: string, generation: number): void {
		this.#deps.onResync?.(deviceId);
		core().push("web.resynced", { host: this.host, conn }, undefined, generation);
	}

	/** The core ended, and every page socket with it. */
	coreExited(): void {
		this.#unsent.clear();
		const ended = [...this.#connections];
		this.#connections.clear();
		for (const [deviceId, connections] of ended) {
			this.#deps.onConnectionsChanged?.(deviceId);
			for (const { connId } of connections) this.#deps.onConnectionEnded?.(deviceId, connId);
		}
	}

	/**
	 * A call the core let through: run here, and answered when the core waits for it. The answer goes only to the core
	 * of `generation` that asked: the next core numbers its calls from 1 again, and a reply to its same-numbered call
	 * would hand this device's answer to another device's page.
	 */
	call(event: CallEvent, argsText: string, generation: number): void {
		let args: unknown[];
		try {
			args = JSON.parse(argsText) as unknown[];
		} catch {
			args = [];
		}
		const running = this.#dispatch(event, args);
		if (event.dir === "send") {
			const done = () => {
				if (event.answer) this.#answer(generation, { call: event.call, ok: true });
			};
			running.then(done, done);
			return;
		}
		running.then(
			value => this.#reply(event, value, generation),
			error => this.#answer(generation, { call: event.call, ok: false, e: webError(error) }),
		);
	}

	#answer(generation: number, reply: object, bin?: Uint8Array): void {
		core().push("web.reply", { host: this.host, ...reply }, bin, generation);
	}

	/** An invoke's answer; a value JSON cannot carry fails the call instead of leaving the page to wait forever. */
	#reply(event: CallEvent, value: unknown, generation: number): void {
		let text: string | undefined;
		try {
			text = JSON.stringify(value);
		} catch {
			const e = { message: `The computer's answer to ${event.ch} could not be sent to this page` };
			this.#answer(generation, { call: event.call, ok: false, e });
			return;
		}
		const bin = text === undefined ? undefined : Buffer.from(text, "utf8");
		this.#answer(generation, { call: event.call, ok: true }, bin);
	}

	async #dispatch(event: CallEvent, args: readonly unknown[]): Promise<unknown> {
		const { devices, windows, webChannels, registry } = this.#deps;
		const { device: deviceId, ch: channel, dir } = event;
		const device = devices.get(deviceId);
		if (!device) throw codedError("web_forbidden", "This device is no longer paired");
		const win = windows.windowFor(deviceId);
		const own = Object.hasOwn(webChannels, channel) ? webChannels[channel] : undefined;
		if (own) return own.handler({ deviceId, device, win }, args);

		const caller = windows.callerFor(deviceId, event.connId);
		const refund = dir === "invoke" ? this.#meter(deviceId, channel, args, win) : null;
		try {
			// Synchronous unless a picture came by upload, so plain calls keep their order and timing.
			const landed =
				channel === IPC_COMMANDS.FS_UPLOAD_TO_HOST
					? await this.#landHostUpload(deviceId, args)
					: holdsBlock(args, isWebUploadedImage)
						? await this.#landUploads(deviceId, args)
						: args;
			if (dir === "send") {
				registry.send(
					channel,
					caller,
					channel === IPC_COMMANDS.FS_MEDIA_RELEASE ? await this.#translateMediaRelease(deviceId, landed) : landed,
				);
				return undefined;
			}
			const result = await registry.invoke(channel, caller, landed);
			if (refund && refused(result)) refund();
			return this.#shape(deviceId, channel, args, result);
		} catch (error) {
			refund?.();
			throw error;
		}
	}

	/**
	 * Count a model command against the device's daily limit before it runs (synchronously, so parallel
	 * callers see each other). The returned function gives the request back; null when the call is free.
	 */
	#meter(deviceId: string, channel: string, args: readonly unknown[], win: WebClientWindow): (() => void) | null {
		const weight = this.#modelRequests(deviceId, channel, args, win);
		if (weight === 0) return null;
		const reservation = this.#deps.quota.reserve(deviceId, weight);
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
	#modelRequests(deviceId: string, channel: string, args: readonly unknown[], win: WebClientWindow): number {
		if (channel === IPC_COMMANDS.RPC_COMMAND || channel === IPC_COMMANDS.RPC_COMMAND_FOR_TAB) {
			const { command, tabId } = rpcPayload(args[0]);
			if (!isCommandWithType(command) || !commandUsesModel(command)) return 0;
			const tab = tabId ?? this.#deps.activeTab?.(win) ?? null;
			if (tab) this.noteDriver(tab, deviceId);
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

	/** What a page may see: no secret-looking preferences, no raw bytes or `omp-media://` address. */
	#shape(deviceId: string, channel: string, args: readonly unknown[], result: unknown): unknown {
		if (channel === IPC_COMMANDS.PREFS_GET) {
			const payload = args[0];
			const keyed = typeof payload === "object" && payload !== null && "key" in payload && payload.key;
			return keyed ? result : withoutSecretPrefs(result);
		}
		// A file the page saves for itself (`FS_SAVE_COPY` from a web window answers the bytes) rides like a read.
		if (channel === IPC_COMMANDS.FS_READ_BINARY || channel === IPC_COMMANDS.FS_SAVE_COPY)
			return this.#binaryResult(deviceId, result);
		if (channel === IPC_COMMANDS.FS_MEDIA_STREAM) return this.#mediaResult(deviceId, result);
		return result;
	}

	/** The file's bytes inline as base64 up to 512 KiB, else behind a `/blob` URL (the shim turns either back into bytes). */
	#binaryResult(deviceId: string, result: unknown): unknown {
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
		return { ...rest, blobUrl: this.#deps.blobs.addBytes(deviceId, data, mime) };
	}

	/** A player's stream: the shell keeps serving it, behind this device's `/blob` URL. */
	#mediaResult(deviceId: string, result: unknown): unknown {
		const { blobs, mediaOpen } = this.#deps;
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
		const url = result.url;
		const open = (range: string | undefined): Promise<Response> => mediaOpen(url, range);
		return { ...result, url: blobs.addMedia(deviceId, { url, mime: result.mime, open }) };
	}

	/**
	 * The call with each picture the page sent by upload (`WebUploadedImage`) back as an inline image block, its
	 * upload consumed; a format models refuse (`convertsForModel`) comes back converted. A path outside this
	 * device's uploads, or one already gone, fails the call, and so does a picture that cannot be converted.
	 */
	async #landUploads(deviceId: string, args: readonly unknown[]): Promise<unknown[]> {
		const { uploads, toModelImage } = this.#deps;
		const landed = await replaceBlocks(args, isWebUploadedImage, async ({ upload, ...block }) => {
			const bytes = await uploads.take(deviceId, upload).catch(() => {
				throw codedError(
					"file_not_found",
					"A picture this message names is no longer on the computer; attach it again",
				);
			});
			const image = { ...block, data: bytes.toString("base64") };
			if (!convertsForModel(block.mimeType)) return image;
			return toModelImage(image).catch(() => {
				throw codedError("unsupported_image", "This picture could not be converted for the model");
			});
		});
		return landed as unknown[];
	}

	/**
	 * A file a page attaches to a paired host's tab came to this computer by `POST /upload` first (a frame holds 1 MB):
	 * its bytes are read back here (`UploadStore.take`, this device's own uploads only) and go on to the host.
	 */
	async #landHostUpload(deviceId: string, args: readonly unknown[]): Promise<unknown[]> {
		const request = args[0];
		if (typeof request !== "object" || request === null) return [...args];
		const { upload, ...rest } = request as { upload?: unknown };
		if (typeof upload !== "string") throw codedError("invalid_path", "No uploaded file named");
		const bytes = await this.#deps.uploads.take(deviceId, upload).catch(() => {
			throw codedError("file_not_found", "The file is no longer on the computer; attach it again");
		});
		return [{ ...rest, data: new Uint8Array(bytes) }, ...args.slice(1)];
	}

	/** `FS_MEDIA_RELEASE` names the `/blob` URL the page holds; the handler knows the `omp-media://` one. */
	async #translateMediaRelease(deviceId: string, args: readonly unknown[]): Promise<readonly unknown[]> {
		if (typeof args[0] !== "string") return args;
		const { blobs } = this.#deps;
		const media = await blobs.mediaUrl(deviceId, args[0]).catch(() => null);
		await blobs.release(deviceId, args[0]).catch(() => false);
		return media === null ? args : [media];
	}
}
