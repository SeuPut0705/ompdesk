/**
 * Remote devices in the main process: both roles of this computer.
 *
 * Host (B): when prefs `remote.hostEnabled` is on, a RemoteHost listens and
 * beacons, and paired devices run tabs here through LocalHostServices. While
 * a device is connected or one of its tabs still runs a turn, this computer
 * is kept awake (prefs `remote.keepAwake`, default on; see keep-awake.ts).
 *
 * Client (A): one RemoteClient per paired host, reconnecting on its own. Tabs
 * on a host are RemoteSidecars created through `createSidecar` (the pool's
 * factory calls it for a tab with a `device`); each client's `tab.event`s are
 * routed to its tabs by rtab, and its link state becomes their status. A host's
 * `sessions.changed`, and every link coming online, make the renderer refetch
 * the session lists.
 *
 * The whole picture goes to every window as `remote:state` on each change.
 */
import { hostname } from "node:os";
import { z } from "zod";
import { codedError, type IpcErrorCode, isIpcErrorCode } from "../../shared/ipc-error-codes";
import {
	type HostView,
	IPC_EVENTS,
	type IpcHostOmpUpdate,
	type RemoteDirListing,
	type RemoteDiscoveredDevice,
	type RemoteState,
} from "../../shared/ipc-types";
import type { OmpUpdateState } from "../../shared/omp-update";
import type { ResumeMarker } from "../turn-resume";
import {
	OMP_UPDATE_EVENT,
	OmpUpdateStateSchema,
	SESSIONS_CHANGED_EVENT,
	TAB_EVENT,
	TabEventMessage,
} from "./app-protocol";
import { pairWithHost, RemoteClient, RemoteError } from "./client";
import { BeaconListener, type DiscoveredHost } from "./discovery";
import { type HostMachineInfo, RemoteHost } from "./host-server";
import type { LocalHostServices } from "./host-services";
import { HostStore, type PairedHost } from "./hosts-store";
import { type Identity, loadIdentity } from "./identity";
import { type KeepAwakeBlocker, KeepAwakePolicy } from "./keep-awake";
import { PeerQuota } from "./peer-quota";
import { PeerStore } from "./peers-store";
import { PendingTabCloses, RemoteSidecar } from "./remote-sidecar";

/** Startup listen window that refreshes paired hosts' addresses from their beacons. */
const STARTUP_DISCOVERY_MS = 10_000;
/** A discovered host that stopped beaconing (2 s cadence) leaves the list after this. */
const DISCOVERY_STALE_MS = 8_000;
const MAX_DEVICE_NAME = 64;
/** Usage counters reach the Settings view at most this often. */
const QUOTA_BROADCAST_MS = 1_000;
const Limit = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
const PeerLimitsPayload = z.object({
	deviceId: z.string().min(1),
	limits: z.object({ requestsPerDay: Limit, tokensPerDay: Limit }),
});

const HOST_ENABLED_KEY = "remote.hostEnabled";
const DEVICE_NAME_KEY = "remote.deviceName";
const KEEP_AWAKE_KEY = "remote.keepAwake";

/** Pairing failures the renderer localizes; anything else reads as a protocol failure. */
const PAIR_ERROR_CODES: Record<string, IpcErrorCode> = {
	wrong_code: "remote_wrong_code",
	expired: "remote_expired",
	locked: "remote_locked",
	unreachable: "remote_unreachable",
	protocol: "remote_protocol",
};

export interface RemoteDevicesDeps {
	userData: string;
	appVersion: string;
	prefs: { get(key: string): unknown; set(key: string, value: unknown): void };
	/** Send to every window. */
	broadcast: (channel: string, data: unknown) => void;
	/** Host role services (this machine's sidecars, sessions, files). */
	services: LocalHostServices;
	/** Machine part of the host hello. */
	machineInfo: () => HostMachineInfo;
	/** Status message of a tab whose host is unreachable, in the UI language. */
	offlineMessage: () => string;
	/** Electron `powerSaveBlocker` held while devices use this computer. */
	powerSaveBlocker: KeepAwakeBlocker;
}

interface HostLink {
	client: RemoteClient;
	/** rtab → tab on this host. */
	tabs: Map<string, RemoteSidecar>;
	/** Tabs closed here while the host was unreachable; it is told when the link is back. */
	closes: PendingTabCloses;
}

interface Discovery {
	listener: BeaconListener;
	/** The connect dialog asked for it (vs. the startup address refresh only). */
	ui: boolean;
	seen: Map<string, { device: RemoteDiscoveredDevice; seenAt: number }>;
	startupTimer: NodeJS.Timeout | undefined;
	pruneTimer: NodeJS.Timeout | undefined;
}

export class RemoteDevices {
	readonly #deps: RemoteDevicesDeps;
	readonly #identity: Identity;
	readonly #peers: PeerStore;
	readonly #hosts: HostStore;
	readonly #links = new Map<string, HostLink>();
	#host: RemoteHost | null = null;
	#discovery: Discovery | null = null;
	#disposed = false;
	readonly #keepAwake: KeepAwakePolicy;
	readonly #unwatchRunning: () => void;
	readonly #quota: PeerQuota;
	#quotaTimer: NodeJS.Timeout | undefined;

	constructor(deps: RemoteDevicesDeps) {
		this.#deps = deps;
		this.#identity = loadIdentity(deps.userData);
		this.#peers = new PeerStore(deps.userData);
		this.#hosts = new HostStore(deps.userData);
		this.#keepAwake = new KeepAwakePolicy({
			blocker: deps.powerSaveBlocker,
			onChange: () => this.#broadcastState(),
		});
		this.#unwatchRunning = deps.services.onRunningChange(() => this.#broadcastState());
		// Usage is written per assistant message; the Settings view needs only a settled count.
		this.#quota = new PeerQuota(this.#peers, () => this.#quotaChanged());
		deps.services.attachQuota(this.#quota);
	}

	/** Launch: the host role per prefs, a link to every paired host, and a brief beacon listen for new addresses. */
	start(): void {
		if (this.#deps.prefs.get(HOST_ENABLED_KEY) === true) void this.#startHost();
		for (const host of this.#hosts.list()) this.#link(host.deviceId);
		if (this.#hosts.list().length > 0) void this.#listen(false);
	}

	state(): RemoteState {
		const host = this.#host;
		const code = host?.port != null ? host.pairingCode() : null;
		const online = new Set((host?.connections() ?? []).map(peer => peer.deviceId));
		const using = new Set([...online, ...this.#deps.services.runningPeers()]);
		const peers = this.#peers.list();
		return {
			host: {
				enabled: this.#deps.prefs.get(HOST_ENABLED_KEY) === true,
				name: this.deviceName(),
				port: host?.port ?? null,
				addresses: host?.addresses() ?? [],
				code: code?.code ?? null,
				expiresAt: code?.expiresAt ?? null,
				peers: peers.map(peer => ({
					deviceId: peer.deviceId,
					name: peer.name,
					online: online.has(peer.deviceId),
					lastSeenAt: peer.lastSeenAt ?? null,
					limits: peer.limits ?? {},
					usage: this.#quota.usage(peer),
				})),
				keepAwake: this.#deps.prefs.get(KEEP_AWAKE_KEY) !== false,
				keepingAwake: this.#keepAwake.held,
				usedBy: peers.filter(peer => using.has(peer.deviceId)).map(peer => peer.name),
			},
			hosts: this.#hosts
				.list()
				.map(paired => this.#hostView(paired.deviceId) ?? toHostView(paired.deviceId, paired.name)),
		};
	}

	deviceName(): string {
		const stored = this.#deps.prefs.get(DEVICE_NAME_KEY);
		if (typeof stored === "string" && stored.trim()) return stored;
		return hostname().replace(/\.local$/i, "");
	}

	async setHostEnabled(enabled: boolean): Promise<RemoteState> {
		this.#deps.prefs.set(HOST_ENABLED_KEY, enabled === true);
		if (enabled === true) await this.#startHost();
		else await this.#stopHost();
		return this.#broadcastState();
	}

	setDeviceName(name: unknown): RemoteState {
		const trimmed = typeof name === "string" ? name.trim() : "";
		if (!trimmed || trimmed.length > MAX_DEVICE_NAME) throw codedError("invalid_name", "Invalid device name");
		this.#deps.prefs.set(DEVICE_NAME_KEY, trimmed);
		return this.#broadcastState();
	}

	setKeepAwake(enabled: boolean): RemoteState {
		this.#deps.prefs.set(KEEP_AWAKE_KEY, enabled === true);
		return this.#broadcastState();
	}

	rotateCode(): RemoteState {
		this.#host?.rotateCode();
		return this.#broadcastState();
	}

	async revokePeer(deviceId: unknown): Promise<RemoteState> {
		if (typeof deviceId !== "string") throw codedError("remote_unknown_device", "Unknown device");
		if (this.#host) await this.#host.revoke(deviceId);
		else this.#peers.remove(deviceId);
		this.#deps.services.dropPeer(deviceId);
		return this.#broadcastState();
	}

	/** Daily model-use limits for a paired device (D65); `{}` removes them. */
	setPeerLimits(payload: unknown): RemoteState {
		const parsed = PeerLimitsPayload.safeParse(payload);
		if (!parsed.success) throw codedError("remote_unknown_device", "Invalid device limits");
		if (!this.#quota.setLimits(parsed.data.deviceId, parsed.data.limits)) {
			throw codedError("remote_unknown_device", "Unknown device");
		}
		return this.#broadcastState();
	}

	/** Start or stop the connect dialog's LAN discovery; resolves with what is known now. */
	async discover(action: unknown): Promise<RemoteDiscoveredDevice[]> {
		if (action === "start") {
			await this.#listen(true);
			return this.#discovered();
		}
		const discovery = this.#discovery;
		if (discovery) {
			discovery.ui = false;
			clearInterval(discovery.pruneTimer);
			discovery.pruneTimer = undefined;
			discovery.seen.clear();
			if (!discovery.startupTimer) this.#stopListening();
		}
		return [];
	}

	async pair(payload: unknown): Promise<HostView> {
		const { address, code } = (payload ?? {}) as { address?: unknown; code?: unknown };
		if (typeof address !== "string" || !address.trim()) throw codedError("remote_unreachable", "Missing address");
		if (typeof code !== "string") throw codedError("remote_wrong_code", "Missing code");
		let paired: PairedHost;
		try {
			paired = await pairWithHost({
				identity: this.#identity,
				address: address.trim(),
				code,
				name: this.deviceName(),
				appVersion: this.#deps.appVersion,
				hosts: this.#hosts,
			});
		} catch (error) {
			const remoteCode = error instanceof RemoteError ? error.code : "protocol";
			const message = error instanceof Error ? error.message : String(error);
			throw codedError(PAIR_ERROR_CODES[remoteCode] ?? "remote_protocol", message);
		}
		// A re-pair replaces the old key: the old link must not keep using it.
		this.#unlink(paired.deviceId);
		this.#link(paired.deviceId);
		const discovered = this.#discovery?.seen.get(paired.deviceId);
		if (discovered) discovered.device.paired = true;
		this.#broadcastState();
		return this.#hostView(paired.deviceId) ?? toHostView(paired.deviceId, paired.name);
	}

	removeHost(deviceId: unknown): RemoteState {
		if (typeof deviceId !== "string") throw codedError("remote_unknown_device", "Unknown device");
		this.#unlink(deviceId);
		this.#hosts.remove(deviceId);
		this.#deps.broadcast(IPC_EVENTS.SESSIONS_CHANGED, undefined);
		return this.#broadcastState();
	}

	listDirs(deviceId: unknown, path: unknown, query: unknown): Promise<RemoteDirListing> {
		if (typeof deviceId !== "string") throw codedError("remote_unknown_device", "Unknown device");
		return this.request<RemoteDirListing>(deviceId, "fs.listDirs", {
			...(typeof path === "string" && path ? { path } : {}),
			...(typeof query === "string" && query.trim() ? { query } : {}),
		});
	}

	/**
	 * One host-level request on a paired host. Failures surface as coded
	 * errors: `remote_offline` while the link is down, `remote_unknown_device`
	 * for a host that is not paired, and the host's own code otherwise.
	 */
	async request<T>(deviceId: string, method: string, params: unknown, timeoutMs?: number): Promise<T> {
		const link = this.#links.get(deviceId);
		if (!link) throw codedError("remote_unknown_device", "The device is not paired");
		try {
			return await link.client.request<T>(method, params, timeoutMs);
		} catch (error) {
			if (!(error instanceof RemoteError)) throw error;
			if (error.code === "remote_offline") throw codedError("remote_offline", error.message);
			// The host's `[code] message` already carries its code; a bare known code gets the marker.
			if (!/\[[a-z_]+\] /.test(error.message) && isIpcErrorCode(error.code))
				throw codedError(error.code, error.message);
			throw new Error(error.message);
		}
	}

	/**
	 * A turn this computer ran for a paired device when it last crashed or quit (turn-resume.ts):
	 * its tab again, waiting for the device to reconnect. Null while hosting is off or the
	 * device is no longer paired.
	 */
	reviveHostTab(deviceId: string, marker: ResumeMarker): string | null {
		if (this.#deps.prefs.get(HOST_ENABLED_KEY) !== true) return null;
		const peer = this.#peers.get(deviceId);
		return peer ? this.#deps.services.reviveTab(peer, marker) : null;
	}

	/** A tab on a paired host; throws `remote_unknown_device` when the host is not paired. */
	createSidecar(deviceId: string, rtab: string, cwd: string, kind: "agent" | "chat", fresh: boolean): RemoteSidecar {
		const link = this.#links.get(deviceId);
		if (!link) throw codedError("remote_unknown_device", "The device is not paired");
		// Opened again under an id the host was still to be told to close: that tab is live.
		link.closes.cancel(rtab);
		const sidecar = new RemoteSidecar({
			link: link.client,
			rtab,
			cwd,
			kind,
			fresh,
			offlineMessage: this.#deps.offlineMessage,
			onDispose: () => {
				if (link.tabs.get(rtab) === sidecar) link.tabs.delete(rtab);
			},
			deferClose: closing => link.closes.defer(closing),
		});
		link.tabs.set(rtab, sidecar);
		return sidecar;
	}

	/** This machine's omp updater changed state: devices using it as a host show it. */
	hostOmpUpdateChanged(state: OmpUpdateState): void {
		this.#deps.services.ompUpdateChanged(state);
	}

	/** This machine's session index changed: devices using it as a host refetch. */
	hostSessionsChanged(): void {
		this.#deps.services.sessionsChanged();
	}

	/** This machine's reply-language setting changed: tabs it hosts for devices follow it. */
	hostReplyLanguageChanged(): void {
		this.#deps.services.syncReplyLanguage();
	}

	/** This machine's profile setting changed: tabs it hosts for devices follow it. */
	hostUserProfileChanged(): void {
		this.#deps.services.syncUserProfile();
	}

	/** This machine's prompt-suggestion switches changed: tabs it hosts for devices follow them. */
	hostNextPromptChanged(): void {
		this.#deps.services.syncNextPrompt();
	}

	/** This machine's account-rotation setting changed: tabs it hosts for devices follow it. */
	hostAccountRotationChanged(): void {
		this.#deps.services.syncAccountRotation();
	}

	#quotaChanged(): void {
		if (this.#quotaTimer || this.#disposed) return;
		this.#quotaTimer = setTimeout(() => {
			this.#quotaTimer = undefined;
			this.#broadcastState();
		}, QUOTA_BROADCAST_MS);
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		this.#unwatchRunning();
		clearTimeout(this.#quotaTimer);
		this.#keepAwake.dispose();
		this.#stopListening();
		for (const deviceId of [...this.#links.keys()]) this.#unlink(deviceId);
		this.#deps.services.disposeAll();
		await this.#host?.stop();
		this.#host = null;
	}

	async #startHost(): Promise<void> {
		if (this.#disposed) return;
		if (!this.#host) {
			const host = new RemoteHost({
				identity: this.#identity,
				peers: this.#peers,
				services: this.#deps.services,
				name: () => this.deviceName(),
				appVersion: this.#deps.appVersion,
				hello: this.#deps.machineInfo,
			});
			for (const event of ["peersChanged", "connectionsChanged", "codeChanged"] as const) {
				host.on(event, () => this.#broadcastState());
			}
			this.#host = host;
		}
		try {
			await this.#host.start();
		} catch (error) {
			console.warn(`[remote] host failed to start: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.#broadcastState();
	}

	async #stopHost(): Promise<void> {
		const host = this.#host;
		this.#host = null;
		this.#deps.services.disposeAll();
		await host?.stop();
	}

	#link(deviceId: string): void {
		const paired = this.#hosts.get(deviceId);
		if (!paired || this.#links.has(deviceId) || this.#disposed) return;
		const client = new RemoteClient({
			identity: this.#identity,
			host: paired,
			appVersion: this.#deps.appVersion,
			name: () => this.deviceName(),
			hosts: this.#hosts,
		});
		const link: HostLink = { client, tabs: new Map(), closes: new PendingTabCloses() };
		client.on("state", state => {
			for (const tab of link.tabs.values()) tab.linkStateChanged(state);
			this.#broadcastState();
			if (state !== "online") return;
			link.closes.flush(rtab => client.request("tab.close", { rtab }));
			// Its session list went stale while it was away (or never loaded).
			this.#deps.broadcast(IPC_EVENTS.SESSIONS_CHANGED, undefined);
		});
		client.on("event", (event, data) => {
			if (event === SESSIONS_CHANGED_EVENT) {
				this.#deps.broadcast(IPC_EVENTS.SESSIONS_CHANGED, undefined);
				return;
			}
			if (event === OMP_UPDATE_EVENT) {
				const state = OmpUpdateStateSchema.safeParse(data);
				if (state.success) {
					const update: IpcHostOmpUpdate = { device: deviceId, state: state.data };
					this.#deps.broadcast(IPC_EVENTS.HOST_OMP_UPDATE_STATE, update);
				}
				return;
			}
			if (event !== TAB_EVENT) return;
			const message = TabEventMessage.safeParse(data);
			if (message.success) link.tabs.get(message.data.rtab)?.handleEvent(message.data);
		});
		this.#links.set(deviceId, link);
		client.connect();
	}

	#unlink(deviceId: string): void {
		const link = this.#links.get(deviceId);
		if (!link) return;
		// close() reports offline to the tabs first; they stay, showing the host as unreachable.
		link.client.close();
		this.#links.delete(deviceId);
	}

	#hostView(deviceId: string): HostView | null {
		const client = this.#links.get(deviceId)?.client;
		if (!client) return null;
		const view = toHostView(deviceId, client.host.name, client.state);
		if (client.hello) {
			view.platform = client.hello.platform;
			view.home = client.hello.home;
		}
		return view;
	}

	async #listen(ui: boolean): Promise<void> {
		if (!this.#discovery) {
			const listener = new BeaconListener({ ignoreDeviceId: this.#identity.deviceId });
			listener.on("beacon", beacon => this.#onBeacon(beacon));
			this.#discovery = { listener, ui: false, seen: new Map(), startupTimer: undefined, pruneTimer: undefined };
			if (!(await listener.start())) console.warn("[remote] discovery port busy; LAN discovery is off");
		}
		const discovery = this.#discovery;
		if (!discovery) return;
		if (ui) {
			discovery.ui = true;
			discovery.pruneTimer ??= setInterval(() => this.#prune(), DISCOVERY_STALE_MS / 2);
		} else {
			clearTimeout(discovery.startupTimer);
			discovery.startupTimer = setTimeout(() => {
				discovery.startupTimer = undefined;
				if (!discovery.ui) this.#stopListening();
			}, STARTUP_DISCOVERY_MS);
		}
	}

	#stopListening(): void {
		const discovery = this.#discovery;
		if (!discovery) return;
		this.#discovery = null;
		clearTimeout(discovery.startupTimer);
		clearInterval(discovery.pruneTimer);
		discovery.listener.stop();
	}

	#onBeacon(beacon: DiscoveredHost): void {
		// A paired host may have moved: dial the address it beacons from now.
		if (this.#hosts.get(beacon.deviceId)) {
			this.#hosts.rememberAddress(beacon.deviceId, beacon.address);
			this.#links.get(beacon.deviceId)?.client.connect();
		}
		const discovery = this.#discovery;
		if (!discovery?.ui) return;
		const previous = discovery.seen.get(beacon.deviceId)?.device;
		const device: RemoteDiscoveredDevice = {
			deviceId: beacon.deviceId,
			name: beacon.name,
			address: beacon.address,
			paired: this.#hosts.get(beacon.deviceId) !== undefined,
		};
		discovery.seen.set(beacon.deviceId, { device, seenAt: Date.now() });
		if (previous?.name !== device.name || previous.address !== device.address || previous.paired !== device.paired) {
			this.#deps.broadcast(IPC_EVENTS.REMOTE_DISCOVERED, this.#discovered());
		}
	}

	#prune(): void {
		const discovery = this.#discovery;
		if (!discovery) return;
		const cutoff = Date.now() - DISCOVERY_STALE_MS;
		let changed = false;
		for (const [deviceId, entry] of discovery.seen) {
			if (entry.seenAt >= cutoff) continue;
			discovery.seen.delete(deviceId);
			changed = true;
		}
		if (changed) this.#deps.broadcast(IPC_EVENTS.REMOTE_DISCOVERED, this.#discovered());
	}

	#discovered(): RemoteDiscoveredDevice[] {
		return [...(this.#discovery?.seen.values() ?? [])].map(entry => ({ ...entry.device }));
	}

	/** Every change lands here, so this is also where the keep-awake policy sees it. */
	#broadcastState(): RemoteState {
		const host = this.#host;
		this.#keepAwake.update({
			enabled:
				!this.#disposed &&
				this.#deps.prefs.get(HOST_ENABLED_KEY) === true &&
				this.#deps.prefs.get(KEEP_AWAKE_KEY) !== false,
			connected: (host?.connections().length ?? 0) > 0,
			running: this.#deps.services.runningPeers().length > 0,
		});
		const state = this.state();
		this.#deps.broadcast(IPC_EVENTS.REMOTE_STATE, state);
		return state;
	}
}

function toHostView(deviceId: string, name: string, state: HostView["state"] = "offline"): HostView {
	return { deviceId, name, state };
}
