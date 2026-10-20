/**
 * Mobile web's host side, assembled: the connected devices and the blocks, the desktop's say over a new device,
 * the server with its router, the virtual windows, uploads and blobs, and the desktop-facing handlers
 * (`WEB_DEVICES_*`, `WEB_BLOCKS_*`, the new-device notice and the approval dialog's events). `index.ts` creates one
 * `WebHost`; Mobile web's service (src/main/tailscale/) starts and stops its server and tells it the published
 * address and the secret path of its serve handler.
 */
import { join } from "node:path";
import { z } from "zod";
import type { PeerLimits } from "../../shared/ipc-types";
import {
	WEB_BLOCKS_LIST,
	WEB_BLOCKS_REMOVE,
	WEB_DEVICE_CONNECTED,
	WEB_DEVICES_CHANGED,
	WEB_DEVICES_LIST,
	WEB_DEVICES_RENAME,
	WEB_DEVICES_REVOKE,
	WEB_DEVICES_SET_GRANTS,
	WEB_DEVICES_SET_LIMITS,
	WEB_PAIRING_REQUEST,
	WEB_PAIRING_RESPOND,
	type WebBlockedInfo,
	type WebDeviceInfo,
	webDeviceTier,
} from "../../shared/mobile-web";
import type { UiLanguage } from "../../shared/ui-language";
import { WEB_PERMISSIONS, type WebFeatures } from "../../shared/web-protocol";
import { readModelsText, writeModelsText } from "../models-config";
import { PeerQuota } from "../remote/peer-quota";
import type { TabActivity, TabFacts } from "../sidecar-pool";
import { stockHelperRequest } from "../stock-helper";
import type { TailnetPeer } from "../tailscale/whois";
import { AssetArchive } from "./asset-archive";
import type { RequestPolicy } from "./auth";
import { BlobStore } from "./blobs";
import { WebBlocks } from "./blocks-store";
import type { ClientWindow } from "./client-window";
import { type WebDevice, WebDevices } from "./devices-store";
import { createHostActions } from "./host-actions";
import type { IpcRegistry } from "./ipc-registry";
import { PairingConfirmations } from "./pairing";
import { PushSender, type PushTransport } from "./push";
import { ServeSecretStore } from "./serve-secret";
import { WebServer } from "./server";
import { UploadStore } from "./uploads";
import { VapidStore } from "./vapid-store";
import { WebClientWindow, WebWindows } from "./web-client-window";
import { WebPushNotifier } from "./web-push-notifier";
import { CLOSE_REVOKED, type InlineImage, WsRouter } from "./ws-router";

/** How often old uploads are looked for. */
const UPLOAD_SWEEP_MS = 60 * 60_000;

export interface WebHostDeps {
	ipc: Pick<IpcRegistry, "handle" | "invoke" | "send">;
	userData: string;
	/** The built renderer's folder (`web.html` and assets), null when the app has none (a dev run). */
	staticRoot: () => string | null;
	/** The desktop's own windows: pairing requests and the device list go to them, never to a web window. */
	desktopWindows: () => readonly ClientWindow[];
	/** The window's active tab, and the folder a tab works in on this computer. */
	tabs: {
		activeTab(win: ClientWindow): string | null;
		cwd(win: ClientWindow, tabId: string | undefined): string | null;
		/** A live tab's facts (`SidecarPool.tabFacts`), for what a push says; null once the tab is gone. */
		facts(tabId: string): TabFacts | null;
		/** The window missed pushes: its tabs' next streamed update carries the whole message (`SidecarPool.resnapshotWindow`). */
		resnapshot(win: ClientWindow): void;
	};
	/** `MediaStreams.handle`: answers a range request for an `omp-media://` stream. */
	openMedia: (url: string, range: string | undefined) => Promise<Response>;
	/** The host's own screen: open a file (launcher types are only revealed), reveal it, open a link. */
	shell: {
		openPath(abs: string): Promise<unknown>;
		reveal(abs: string): void;
		openExternal(url: string): Promise<void>;
	};
	/** Tailscale logins that may reach the page (Mobile web's service decides). */
	allowedUsers: () => readonly string[];
	/** Hold a new device until the desktop approves it (Settings › Mobile web, off by default). */
	confirmNewDevices: () => boolean;
	/** The node and user behind a tailnet address (`tailscale whois`); null when it cannot say. */
	whois: (address: string) => Promise<TailnetPeer | null>;
	onUnpairedAuth: (info: { address: string }) => void;
	features?: Partial<WebFeatures>;
	now?: () => number;
	/** The wire for Web Push; the real `web-push` HTTPS transport when absent (tests pass a fake push service). */
	pushTransport?: PushTransport | undefined;
	/** The notifier's debounce and batch timers; real unref'd timers when absent. */
	pushTimers?:
		| { setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (handle: unknown) => void }
		| undefined;
	/** Where a refused or failed push is noted. */
	log?: ((message: string) => void) | undefined;
	/** The host's UI language: pushes read in it. */
	language: () => UiLanguage;
}

const DeviceId = z.string().min(1).max(128);
const Name = z.string().min(1).max(200);
const Grants = z.array(z.enum(WEB_PERMISSIONS)).max(WEB_PERMISSIONS.length);
const Count = z.number().int().nonnegative();
const Limits = z.object({ requestsPerDay: Count.optional(), tokensPerDay: Count.optional() });
const PairingResponse = z.object({ id: z.string().min(1), approve: z.boolean(), grants: Grants.optional() });
const BlockId = z.string().min(1).max(400);

export class WebHost {
	readonly devices: WebDevices;
	readonly blocks: WebBlocks;
	readonly server: WebServer;
	readonly router: WsRouter;
	readonly windows: WebWindows;
	readonly quota: PeerQuota;
	readonly blobs: BlobStore;
	readonly uploads: UploadStore;
	readonly confirmations: PairingConfirmations;
	readonly #deps: WebHostDeps;
	readonly vapid: VapidStore;
	readonly sender: PushSender;
	readonly notifier: WebPushNotifier;
	readonly #serveSecret: ServeSecretStore;
	/** The previous builds' assets the server still serves (asset-archive.ts); filled once per launch at `start`. */
	readonly assets: AssetArchive;
	#archiving: Promise<void> | null = null;
	/** The upload sweep in flight; one at a time, and `stop` waits for it. */
	#sweeping: Promise<number> | null = null;
	#sweeper: ReturnType<typeof setInterval> | undefined;

	constructor(deps: WebHostDeps) {
		this.#deps = deps;
		const now = deps.now ?? Date.now;
		this.devices = new WebDevices(deps.userData, now);
		// A keypair made now (first run, or its file was lost) breaks every subscription made against the old one.
		this.vapid = new VapidStore(deps.userData);
		if (this.vapid.takeCreated()) this.devices.dropAllPushSubscriptions();
		this.sender = new PushSender({
			vapid: () => this.vapid.keys(),
			transport: deps.pushTransport,
			log: deps.log,
		});
		this.quota = new PeerQuota(this.devices, () => this.devices.notifyChanged());
		this.blobs = new BlobStore({ now });
		this.uploads = new UploadStore({ root: join(deps.userData, "web-uploads"), now });
		this.blocks = new WebBlocks(deps.userData, now);
		this.#serveSecret = new ServeSecretStore(deps.userData);
		this.assets = new AssetArchive(join(deps.userData, "web-assets"), now);
		this.confirmations = new PairingConfirmations({
			notify: request => this.#toDesktop(WEB_PAIRING_REQUEST, request),
			now,
		});
		this.windows = new WebWindows((deviceId, channel, payload) => this.router.deliver(deviceId, channel, payload));
		this.router = new WsRouter({
			registry: deps.ipc,
			devices: this.devices,
			windows: this.windows,
			quota: this.quota,
			webChannels: createHostActions({
				devices: this.devices,
				uploads: this.uploads,
				blobs: this.blobs,
				cwdFor: (context, tabId) => deps.tabs.cwd(context.win, tabId),
				openPath: deps.shell.openPath,
				reveal: deps.shell.reveal,
				openExternal: deps.shell.openExternal,
				models: { read: readModelsText, write: writeModelsText },
			}),
			// The phone's streamed Preview (preview-stream.ts) is built in; a host build without it passes `preview: false`.
			features: () => ({ push: true, preview: true, upload: true, passkey: false, ...deps.features }),
			activeTab: win => deps.tabs.activeTab(win),
			blobs: this.blobs,
			mediaOpen: deps.openMedia,
			uploads: this.uploads,
			toModelImage: image => stockHelperRequest<InlineImage>("image.toModel", image),
			onConnectionsChanged: () => this.devices.notifyChanged(),
			onResync: deviceId => deps.tabs.resnapshot(this.windows.windowFor(deviceId)),
			now,
		});
		this.notifier = new WebPushNotifier({
			devices: this.devices,
			sender: this.sender,
			visible: deviceId => this.router.isDeviceVisible(deviceId),
			tabFacts: deps.tabs.facts,
			language: deps.language,
			setTimer: deps.pushTimers?.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref()),
			clearTimer: deps.pushTimers?.clearTimer ?? (handle => clearTimeout(handle as NodeJS.Timeout)),
		});
		const policy: RequestPolicy = {
			host: "127.0.0.1",
			publicPort: 0,
			secure: false,
			servePrefix: null,
			allowedUsers: deps.allowedUsers,
		};
		this.server = new WebServer({
			policy,
			devices: this.devices,
			blocks: this.blocks,
			confirmations: this.confirmations,
			confirmNewDevices: deps.confirmNewDevices,
			whois: deps.whois,
			onDeviceConnected: device =>
				this.#toDesktop(WEB_DEVICE_CONNECTED, {
					id: device.deviceId,
					name: device.name,
					tailscaleLogin: device.tailscaleLogin,
				}),
			router: this.router,
			uploads: this.uploads,
			blobs: this.blobs,
			staticRoot: deps.staticRoot,
			previousBuilds: () => this.assets.roots(),
			onUnpairedAuth: deps.onUnpairedAuth,
			push: { publicKey: () => this.vapid.keys().publicKey },
			now,
		});
		this.devices.onRevoked(deviceId => {
			this.notifier.dropDevice(deviceId);
			this.#release(deviceId);
		});
		this.devices.onChanged(() => this.#toDesktop(WEB_DEVICES_CHANGED, this.list()));
		// A block added or lifted changes what the device list's block scopes mean: the desktop reads both again.
		this.blocks.onChanged(() => this.devices.notifyChanged());
		this.#register();
	}

	/** Start listening (the loopback port; 0 picks a free one) and the upload sweep. */
	async start(options: { port?: number } = {}): Promise<{ port: number }> {
		const started = await this.server.start(options);
		// Until Mobile web confirms serve's handler, a request under this host's secret is answered 503, not 404.
		this.server.configure({ publicPort: started.port, pendingPrefix: this.serveSecret() });
		this.#sweeper ??= setInterval(() => this.#sweep(), UPLOAD_SWEEP_MS);
		this.#sweeper.unref();
		this.#sweep();
		const root = this.#deps.staticRoot();
		if (root) {
			this.#archiving ??= this.assets
				.retain(root)
				.catch(error => this.#deps.log?.(`web assets: keeping this build's assets failed: ${String(error)}`));
		}
		return started;
	}

	/**
	 * Stop serving: sockets close (1001) and pending approvals are declined; devices stay connected, blocks stay.
	 * Returns once the start's background work (the asset copy, an upload sweep) is done too, so nothing of this host
	 * writes into userData after it.
	 */
	async stop(): Promise<void> {
		clearInterval(this.#sweeper);
		this.#sweeper = undefined;
		this.notifier.dispose();
		await Promise.all([this.server.stop(), this.#archiving, this.#sweeping]);
	}

	#sweep(): void {
		this.#sweeping ??= this.uploads
			.sweep()
			.catch(() => 0)
			.finally(() => {
				this.#sweeping = null;
			});
	}

	/** The secret path of the serve handler's target (made on first use, kept 0600). */
	serveSecret(): string {
		return this.#serveSecret.get();
	}

	/**
	 * What a tab did (`SidecarPool.observeTabs`): a paired phone with a push subscription hears of it while the
	 * server runs. With Mobile web off nothing is pushed: the phones cannot open the page anyway.
	 */
	tabActivity(activity: TabActivity): void {
		if (this.server.port !== null) this.notifier.handle(activity);
	}

	/** An Autopilot run of tab `tabId` stopped, ended or released: paired phones hear it while the server runs. */
	autopilotNotice(tabId: string, notice: { kind: "completion" | "error"; title: string; body: string }): void {
		if (this.server.port !== null) this.notifier.notice(tabId, notice);
	}

	/** The device a web window's prompts come from, as its name stands now; null for any other window. */
	promptOrigin(win: ClientWindow): { deviceId: string; name: string } | null {
		if (!(win instanceof WebClientWindow)) return null;
		const device = this.devices.get(win.deviceId);
		return device ? { deviceId: device.deviceId, name: device.name } : null;
	}

	/** The paired devices as Settings lists them. */
	list(): WebDeviceInfo[] {
		return this.devices.list().map(device => this.#info(device));
	}

	#info(device: WebDevice): WebDeviceInfo {
		return {
			id: device.deviceId,
			name: device.name,
			userAgent: device.userAgent,
			tailscaleLogin: device.tailscaleLogin,
			createdAt: device.createdAt,
			lastSeenAt: device.lastSeenAt ?? null,
			connected: this.router.isConnected(device.deviceId),
			grants: device.grants,
			tier: webDeviceTier(device.grants),
			limits: device.limits ?? {},
			usage: this.quota.usage(device),
			blockScope: device.nodeId ? "node" : "login",
		};
	}

	/**
	 * Block a device: the record of its Tailscale node (or, with no node identity, of its login) is kept apart so the
	 * next visit cannot make a new one, and every record of that node or login is revoked. False when it is unknown.
	 */
	block(deviceId: string): boolean {
		const device = this.devices.get(deviceId);
		if (!device) return false;
		const nodeId = device.nodeId ?? null;
		const login = device.tailscaleLogin;
		const sameKey = (other: WebDevice): boolean =>
			nodeId !== null ? other.nodeId === nodeId : other.tailscaleLogin?.toLowerCase() === login?.toLowerCase();
		if (nodeId !== null) {
			this.blocks.add({ scope: "node", key: nodeId, name: device.name, tailscaleLogin: login });
		} else if (login !== null) {
			this.blocks.add({ scope: "login", key: login, name: device.name, tailscaleLogin: login });
		} else {
			return this.devices.revoke(deviceId);
		}
		for (const other of this.devices.list()) if (sameKey(other)) this.devices.revoke(other.deviceId);
		return true;
	}

	/** A revoked or expired device: its sockets close, its tabs and files are released. */
	#release(deviceId: string): void {
		this.router.closeDevice(deviceId, CLOSE_REVOKED, "revoked");
		this.windows.destroy(deviceId);
		this.blobs.releaseDevice(deviceId);
		void this.uploads.removeDevice(deviceId).catch(() => {});
	}

	#toDesktop(channel: string, payload: unknown): void {
		for (const win of this.#deps.desktopWindows()) {
			if (!win.isDestroyed()) win.webContents.send(channel, payload);
		}
	}

	#register(): void {
		const { ipc } = this.#deps;
		ipc.handle(WEB_DEVICES_LIST, () => this.list());
		ipc.handle(WEB_DEVICES_REVOKE, (_caller, deviceId: unknown) => {
			this.block(DeviceId.parse(deviceId));
			return this.list();
		});
		ipc.handle(WEB_BLOCKS_LIST, (): WebBlockedInfo[] => this.blocks.list());
		ipc.handle(WEB_BLOCKS_REMOVE, (_caller, blockId: unknown): WebBlockedInfo[] => {
			this.blocks.remove(BlockId.parse(blockId));
			return this.blocks.list();
		});
		ipc.handle(WEB_DEVICES_RENAME, (_caller, deviceId: unknown, name: unknown) => {
			this.devices.rename(DeviceId.parse(deviceId), Name.parse(name));
			return this.list();
		});
		ipc.handle(WEB_DEVICES_SET_GRANTS, (_caller, deviceId: unknown, grants: unknown) => {
			this.devices.setGrants(DeviceId.parse(deviceId), Grants.parse(grants));
			return this.list();
		});
		ipc.handle(WEB_DEVICES_SET_LIMITS, (_caller, deviceId: unknown, limits: unknown) => {
			const parsed: PeerLimits = Limits.parse(limits);
			this.quota.setLimits(DeviceId.parse(deviceId), parsed);
			this.devices.notifyChanged();
			return this.list();
		});
		ipc.handle(WEB_PAIRING_RESPOND, (_caller, response: unknown) => {
			this.confirmations.respond(PairingResponse.parse(response));
		});
	}
}
