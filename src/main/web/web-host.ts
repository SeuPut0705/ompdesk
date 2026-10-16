/**
 * Mobile web's host side, assembled: the paired devices, pairing, the server with its router, the virtual
 * windows, uploads and blobs, and the desktop-facing handlers (`WEB_DEVICES_*`, the pairing code and the
 * confirm dialog's events). `index.ts` creates one `WebHost`; Mobile web's service (src/main/tailscale/)
 * starts and stops its server and tells it the published address.
 */
import { join } from "node:path";
import { z } from "zod";
import type { PeerLimits } from "../../shared/ipc-types";
import {
	WEB_DEVICES_CHANGED,
	WEB_DEVICES_LIST,
	WEB_DEVICES_RENAME,
	WEB_DEVICES_REVOKE,
	WEB_DEVICES_SET_GRANTS,
	WEB_DEVICES_SET_LIMITS,
	WEB_PAIRING_CODE_NEW,
	WEB_PAIRING_REQUEST,
	WEB_PAIRING_RESPOND,
	type WebDeviceInfo,
	type WebPairingCode,
	webDeviceTier,
} from "../../shared/mobile-web";
import type { UiLanguage } from "../../shared/ui-language";
import { WEB_PERMISSIONS, type WebFeatures } from "../../shared/web-protocol";
import { readModelsText, writeModelsText } from "../models-config";
import { PeerQuota } from "../remote/peer-quota";
import type { TabActivity, TabFacts } from "../sidecar-pool";
import type { RequestPolicy } from "./auth";
import { BlobStore } from "./blobs";
import type { ClientWindow } from "./client-window";
import { type WebDevice, WebDevices } from "./devices-store";
import { createHostActions } from "./host-actions";
import type { IpcRegistry } from "./ipc-registry";
import { PairingConfirmations, WebPairing } from "./pairing";
import { PushSender, type PushTransport } from "./push";
import { WebServer } from "./server";
import { UploadStore } from "./uploads";
import { VapidStore } from "./vapid-store";
import { WebClientWindow, WebWindows } from "./web-client-window";
import { WebPushNotifier } from "./web-push-notifier";
import { CLOSE_REVOKED, WsRouter } from "./ws-router";

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
	/** Ask the desktop before pairing a phone. */
	confirmPairing: () => boolean;
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
	/** The user's `batchNotifications` pref: bursts of pushes fold into one summary unless it is off. */
	batchNotifications: () => boolean;
}

const DeviceId = z.string().min(1).max(128);
const Name = z.string().min(1).max(200);
const Grants = z.array(z.enum(WEB_PERMISSIONS)).max(WEB_PERMISSIONS.length);
const Count = z.number().int().nonnegative();
const Limits = z.object({ requestsPerDay: Count.optional(), tokensPerDay: Count.optional() });
const PairingResponse = z.object({ id: z.string().min(1), approve: z.boolean(), grants: Grants.optional() });

export class WebHost {
	readonly devices: WebDevices;
	readonly pairing: WebPairing;
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
		this.pairing = new WebPairing(now);
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
			onConnectionsChanged: () => this.devices.notifyChanged(),
			now,
		});
		this.notifier = new WebPushNotifier({
			devices: this.devices,
			sender: this.sender,
			visible: deviceId => this.router.isDeviceVisible(deviceId),
			tabFacts: deps.tabs.facts,
			language: deps.language,
			batching: deps.batchNotifications,
			setTimer: deps.pushTimers?.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref()),
			clearTimer: deps.pushTimers?.clearTimer ?? (handle => clearTimeout(handle as NodeJS.Timeout)),
		});
		const policy: RequestPolicy = {
			host: "127.0.0.1",
			publicPort: 0,
			secure: false,
			requireIdentity: false,
			allowedUsers: deps.allowedUsers,
		};
		this.server = new WebServer({
			policy,
			devices: this.devices,
			pairing: this.pairing,
			confirmations: this.confirmations,
			confirmPairing: deps.confirmPairing,
			router: this.router,
			uploads: this.uploads,
			blobs: this.blobs,
			staticRoot: deps.staticRoot,
			onUnpairedAuth: deps.onUnpairedAuth,
			push: { publicKey: () => this.vapid.keys().publicKey },
			now,
		});
		this.devices.onRevoked(deviceId => {
			this.notifier.dropDevice(deviceId);
			this.#release(deviceId);
		});
		this.devices.onChanged(() => this.#toDesktop(WEB_DEVICES_CHANGED, this.list()));
		this.#register();
	}

	/** Start listening (the loopback port; 0 picks a free one) and the upload sweep. */
	async start(options: { port?: number } = {}): Promise<{ port: number }> {
		const started = await this.server.start(options);
		this.server.configure({ publicPort: started.port });
		this.#sweeper ??= setInterval(() => void this.uploads.sweep().catch(() => 0), UPLOAD_SWEEP_MS);
		this.#sweeper.unref();
		void this.uploads.sweep().catch(() => 0);
		return started;
	}

	/** Stop serving: sockets close (1001), the pairing code and pending confirmations are dropped; devices stay paired. */
	async stop(): Promise<void> {
		clearInterval(this.#sweeper);
		this.#sweeper = undefined;
		this.notifier.dispose();
		await this.server.stop();
	}

	/**
	 * What a tab did (`SidecarPool.observeTabs`): a paired phone with a push subscription hears of it while the
	 * server runs. With Mobile web off nothing is pushed: the phones cannot open the page anyway.
	 */
	tabActivity(activity: TabActivity): void {
		if (this.server.port !== null) this.notifier.handle(activity);
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
		};
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
			this.devices.revoke(DeviceId.parse(deviceId));
			return this.list();
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
		ipc.handle(WEB_PAIRING_CODE_NEW, (): WebPairingCode => this.pairing.issue());
		ipc.handle(WEB_PAIRING_RESPOND, (_caller, response: unknown) => {
			this.confirmations.respond(PairingResponse.parse(response));
		});
	}
}
