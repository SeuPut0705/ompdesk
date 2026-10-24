/**
 * Remote devices in the main process: both roles of this computer, over Tailscale only.
 *
 * Host (B): when prefs `remote.hostEnabled` is on, a RemoteHost listens on this computer's tailnet addresses (never
 * LAN or 0.0.0.0) and lets in the devices Tailscale vouches for: `tailscale whois` of the connection's address
 * must name a node of an allowed login (the list Mobile web uses) that is not blocked (Mobile web's blocks, by
 * node). Each device is pinned to its node and key on first contact; "approve new devices" asks first. While a
 * device is connected or one of its tabs still runs a turn, this computer is kept awake (prefs `remote.keepAwake`,
 * default on; see keep-awake.ts).
 *
 * Client (A): the computers of the tailnet are probed while a view watches them; Connect pins one and keeps a
 * RemoteClient to it, reconnecting on its own at its node's current tailnet address. Tabs on a host are
 * RemoteSidecars created through `createSidecar` (the pool's factory calls it for a tab with a `device`); each
 * client's `tab.event`s are routed to its tabs by rtab, and its link state becomes their status. A host's
 * `sessions.changed`, and every link coming online, make the renderer refetch the session lists.
 *
 * The whole picture goes to every window as `remote:state` on each change.
 */

import { isIP, isIPv4 } from "node:net";
import { hostname } from "node:os";
import { z } from "zod";
import { codedError, type IpcErrorCode, ipcErrorCode, isIpcErrorCode } from "../../shared/ipc-error-codes";
import {
	type HostLiveSession,
	type HostView,
	IPC_EVENTS,
	type IpcHostOmpUpdate,
	type IpcHostSchedules,
	type IpcSessionsChanged,
	type RemoteDirListing,
	type RemoteState,
	type RemoteTailnetPhase,
	type TailnetComputer,
} from "../../shared/ipc-types";
import type { OmpUpdateState } from "../../shared/omp-update";
import type { SchedulesState } from "../../shared/schedules";
import {
	type IpcSidebarProjects,
	SIDEBAR_PROJECTS_STATE,
	type SidebarProjectsState,
} from "../../shared/sidebar-projects";
import type { TailnetNode, TailscaleStatus } from "../tailscale/status";
import { isTailnetAddress } from "../tailscale/tailnet";
import type { TailnetPeer } from "../tailscale/whois";
import type { ResumeMarker } from "../turn-resume";
import type { WebBlocks } from "../web/blocks-store";
import { formatAddress, parseAddress, remotePortCandidates } from "./address";
import {
	AUTOPILOT_NOTICE_EVENT,
	AutopilotNoticeEvent,
	DEVICE_RENAME_EVENT,
	DeviceNameSchema,
	HOST_NAME_EVENT,
	HostLiveSessionSchema,
	KEPT_TABS_METHOD,
	KeptTab,
	KeptTabsReply,
	LIVE_SESSIONS_EVENT,
	LIVE_SESSIONS_METHOD,
	LiveSessionsReply,
	MOBILE_WEB_LINK_EVENT,
	MOBILE_WEB_LINK_METHOD,
	MobileWebLinkReply,
	NAME_METHODS,
	NameParams,
	OMP_UPDATE_EVENT,
	OmpUpdateStateSchema,
	PROJECTS_EVENT,
	SCHEDULES_EVENT,
	SchedulesStateSchema,
	SESSIONS_CHANGED_EVENT,
	SidebarProjectsStateSchema,
	TAB_EVENT,
	TabEventMessage,
} from "./app-protocol";
import { connectFirst, type ProbeResult, probeHost, RemoteClient, RemoteError, type WakeTrigger } from "./client";
import { type GateResult, type HostMachineInfo, RemoteHost, type TailnetVisitor } from "./host-server";
import type { LocalHostServices } from "./host-services";
import { HostStore, type PairedHost } from "./hosts-store";
import { type Identity, loadIdentity } from "./identity";
import { type KeepAwakeBlocker, KeepAwakePolicy } from "./keep-awake";
import { PeerQuota, type QuotaReservation } from "./peer-quota";
import { PeerStore } from "./peers-store";
import { REFUSAL_CODES } from "./protocol";
import { PendingTabCloses, RemoteSidecar, type RemoteSidecarOptions } from "./remote-sidecar";

const RenamePayload = z.object({ deviceId: z.string().min(1), name: z.string() });
/** Usage counters reach the Settings view at most this often. */
const QUOTA_BROADCAST_MS = 1_000;
const Limit = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
const PeerLimitsPayload = z.object({
	deviceId: z.string().min(1),
	limits: z.object({ requestsPerDay: Limit, tokensPerDay: Limit }),
});
/** Tailscale's side (up, signed in, this computer's addresses) is read this often; also when a view watches. */
export const TAILNET_POLL_MS = 15_000;
/** The tailnet's computers are probed this often while a view shows them. */
export const TAILNET_SCAN_MS = 5_000;
const PROBE_CONCURRENCY = 8;
/** A device paired by code that never connected again is forgotten this long after the switch to Tailscale. */
export const LEGACY_PEER_GRACE_MS = 30 * 24 * 60 * 60_000;

const HOST_ENABLED_KEY = "remote.hostEnabled";
const DEVICE_NAME_KEY = "remote.deviceName";
const KEEP_AWAKE_KEY = "remote.keepAwake";
/** The one "approve new devices" switch, shared with Mobile web (`MOBILE_WEB_PREFS.confirmNewDevices`, written there). */
const CONFIRM_KEY = "mobileWeb.confirmNewDevices";
/** When code-paired hosts were matched to tailnet nodes (epoch ms); unset = not yet. */
const MIGRATED_KEY = "remote.tailnetMigratedAt";
/** Names of code-paired hosts that were not found on the tailnet and were forgotten (until the user read it). */
const FORGOTTEN_KEY = "remote.forgottenHosts";

/** Phones and tablets run no OMPdesk: never probed. */
const MOBILE_OS = /^(ios|ipados|android)$/i;

/** A refusal (or this side's verdict) as the error code the renderer localizes. */
function remoteErrorCode(code: string): IpcErrorCode {
	const mapped = `remote_${code}`;
	if ((REFUSAL_CODES as readonly string[]).includes(code) && isIpcErrorCode(mapped)) return mapped;
	return code === "unreachable" ? "remote_unreachable" : "remote_protocol";
}

/** The parts of the Tailscale side computer sharing reads (src/main/tailscale/tailnet.ts). */
export interface TailnetAccess {
	status(): Promise<TailscaleStatus | null>;
	phase(): Promise<RemoteTailnetPhase>;
	whois(ip: string): Promise<TailnetPeer | null>;
}

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
	/** Status message of a host tab that did not come up in `seconds`, naming the host, in the UI language. */
	stalledMessage: (device: string, seconds: number) => string;
	/** How long a host tab may take to come up before it says so; default `REMOTE_START_TIMEOUT_MS`. */
	startTimeoutMs?: number;
	/** A host tab's bring-up step, for the runtime log (`remote-tab`). */
	logTab?: RemoteSidecarOptions["log"];
	/** An approved quit leaves interrupted work to continue: host tabs are left running, not closed (`keepOnHost`). */
	keepHostTabsOnQuit?: () => boolean;
	/** Electron `powerSaveBlocker` held while devices use this computer. */
	powerSaveBlocker: KeepAwakeBlocker;
	tailnet: TailnetAccess;
	/** Tailscale logins allowed to use this computer: Mobile web's list (one list for both). */
	allowedUsers: () => readonly string[];
	/** This computer's own login, read from Tailscale: allowed by default (Mobile web keeps the list). */
	adoptLogin: (login: string) => void;
	/** Mobile web's blocks (by Tailscale node): a blocked node is refused here too. Null before they exist. */
	blocks: () => WebBlocks | null;
	/** Ask on this computer whether a new device may use it (only while "approve new devices" is on). */
	confirm: (details: { name: string; login: string; ip: string; nodeName: string | null }) => Promise<boolean>;
	/** Get Tailscale going: Mobile web's own install and start-the-app steps. */
	tailscaleAction: (action: "install" | "start-app") => Promise<void>;
	/**
	 * Tests only (an unpackaged build with `OMP_GUI_TEST_REMOTE_LOOPBACK=1`): a loopback address counts as a tailnet
	 * address, so two apps on one machine can share through the fake Tailscale CLI.
	 */
	loopback?: boolean;
	/** A line in the runtime log (`source: "remote"`). */
	log?: (event: string, details: Record<string, unknown>) => void;
	/** A host link's transitions and the host role's connections (`remote-link`; no addresses or keys). */
	logLink?: (event: string, details: Record<string, unknown>) => void;
	now?: () => number;
}

interface HostLink {
	client: RemoteClient;
	/** rtab → tab on this host. */
	tabs: Map<string, RemoteSidecar>;
	/** Tabs closed here while the host was unreachable; it is told when the link is back. */
	closes: PendingTabCloses;
	/** The host's sessions whose work goes on now (`host.liveSessions`); unset while offline or from an older host. */
	live?: HostLiveSession[];
	/** The host's Mobile web address (`host.mobileWeb.link`); unset while offline, not serving, or from an older host. */
	webUrl?: string;
}

export class RemoteDevices {
	readonly #deps: RemoteDevicesDeps;
	readonly #now: () => number;
	readonly #identity: Identity;
	readonly #peers: PeerStore;
	readonly #hosts: HostStore;
	readonly #links = new Map<string, HostLink>();
	#host: RemoteHost | null = null;
	#disposed = false;
	readonly #keepAwake: KeepAwakePolicy;
	readonly #unwatchRunning: () => void;
	readonly #quota: PeerQuota;
	#quotaTimer: NodeJS.Timeout | undefined;
	#phase: RemoteTailnetPhase = "not-running";
	#pollTimer: NodeJS.Timeout | undefined;
	/** Views watching the tailnet's computers (a window id each). */
	readonly #watchers = new Set<number>();
	#scanTimer: NodeJS.Timeout | undefined;
	#scanning: Promise<TailnetComputer[]> | null = null;
	#computers: TailnetComputer[] = [];
	/** Where each node's host answered last (`ip:port`). */
	readonly #found = new Map<string, string>();
	/** Whether each known host's node was online in the last Tailscale poll. */
	readonly #nodeOnline = new Map<string, boolean>();
	/** This computer's name on the tailnet: the device name until the user picks one. */
	#tailnetName: string | null = null;
	readonly #hostOnline = new Set<(deviceId: string) => void>();
	readonly #autopilotNotices = new Set<(hostId: string, notice: AutopilotNoticeEvent) => void>();

	constructor(deps: RemoteDevicesDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
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

	/** Launch: the host role per prefs, a link to every known host, and the Tailscale poll. */
	start(): void {
		if (this.#deps.prefs.get(HOST_ENABLED_KEY) === true) void this.#startHost();
		for (const host of this.#hosts.list()) this.#link(host.deviceId);
		this.#forgetStaleLegacyPeers();
		void this.#poll();
		this.#pollTimer = setInterval(() => void this.#poll(), TAILNET_POLL_MS);
		this.#pollTimer.unref?.();
	}

	/**
	 * The computer or the network may have changed (wake from sleep, unlock, the network back, a window in front):
	 * every host link checks that it is alive, or retries now when it is not (`RemoteClient.wake`).
	 */
	wake(trigger: WakeTrigger): void {
		for (const link of this.#links.values()) link.client.wake(trigger);
	}

	state(): RemoteState {
		const host = this.#host;
		const versions = new Map((host?.connections() ?? []).map(peer => [peer.deviceId, peer.appVersion]));
		const online = new Set(versions.keys());
		const using = new Set([...online, ...this.#deps.services.runningPeers()]);
		const peers = this.#peers.list();
		const forgotten = this.#deps.prefs.get(FORGOTTEN_KEY);
		return {
			tailnet: this.#phase,
			host: {
				enabled: this.#deps.prefs.get(HOST_ENABLED_KEY) === true,
				name: this.deviceName(),
				port: host?.port ?? null,
				addresses: host?.addresses() ?? [],
				listenError: host?.listenError ?? null,
				peers: peers.map(peer => ({
					deviceId: peer.deviceId,
					name: peer.name,
					login: peer.login,
					online: online.has(peer.deviceId),
					appVersion: versions.get(peer.deviceId) ?? null,
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
			forgotten: Array.isArray(forgotten) ? forgotten.filter(name => typeof name === "string") : [],
			appVersion: this.#deps.appVersion,
		};
	}

	deviceName(): string {
		const stored = this.#deps.prefs.get(DEVICE_NAME_KEY);
		if (typeof stored === "string" && stored.trim()) return stored;
		return this.#tailnetName ?? hostname().replace(/\.local$/i, "");
	}

	/** This computer's OMPdesk device id (what the computers it shares with know it by). */
	get deviceId(): string {
		return this.#identity.deviceId;
	}

	/** A device may still use this computer: paired here and its Tailscale node (or login) not blocked. */
	allowsPeer(deviceId: string): boolean {
		const peer = this.#peers.get(deviceId);
		if (!peer) return false;
		return !this.#deps.blocks()?.check({ nodeId: peer.nodeId, login: peer.login });
	}

	/** The hosts this computer is connected to now. */
	onlineHosts(): string[] {
		return [...this.#links].filter(([, link]) => link.client.state === "online").map(([deviceId]) => deviceId);
	}

	/** Called each time a link to a host comes up. */
	/** A paired host's Autopilot run this device started or shows stopped, ended or released. */
	onAutopilotNotice(listener: (hostId: string, notice: AutopilotNoticeEvent) => void): () => void {
		this.#autopilotNotices.add(listener);
		return () => this.#autopilotNotices.delete(listener);
	}

	onHostOnline(listener: (deviceId: string) => void): () => void {
		this.#hostOnline.add(listener);
		return () => this.#hostOnline.delete(listener);
	}

	async setHostEnabled(enabled: boolean): Promise<RemoteState> {
		this.#deps.prefs.set(HOST_ENABLED_KEY, enabled === true);
		if (enabled === true) await this.#startHost();
		else await this.#stopHost();
		return this.#broadcastState();
	}

	/**
	 * This computer's one device name: saved, announced to every device connected to it (`host.name`) and
	 * to every host it is connected to (`peer.name`). Offline ones learn it from the next hello.
	 */
	setDeviceName(name: unknown): RemoteState {
		const parsed = DeviceNameSchema.safeParse(name);
		if (!parsed.success) throw codedError("invalid_name", "Invalid device name");
		const next = parsed.data;
		if (next !== this.deviceName()) {
			this.#deps.prefs.set(DEVICE_NAME_KEY, next);
			this.#host?.announceName();
			for (const link of this.#links.values()) {
				if (link.client.state === "online") {
					link.client.request(NAME_METHODS.peerName, { name: next }).catch(() => {});
				}
			}
		}
		return this.#broadcastState();
	}

	/** Rename a known host: it sets its own name (`host.rename`) and announces it back. */
	async renameHost(payload: unknown): Promise<RemoteState> {
		const { deviceId, name } = parseRename(payload);
		await this.request(deviceId, NAME_METHODS.hostRename, { name });
		this.#links.get(deviceId)?.client.hostRenamed(name);
		return this.#broadcastState();
	}

	/** Rename a device that uses this computer: it is asked to rename itself, so it must be connected. */
	renamePeer(payload: unknown): RemoteState {
		const { deviceId, name } = parseRename(payload);
		if (!this.#peers.get(deviceId)) throw codedError("remote_unknown_device", "Unknown device");
		if (!this.#host?.askPeerRename(deviceId, name)) {
			throw codedError("remote_offline", "The device must be connected to rename it");
		}
		return this.state();
	}

	setKeepAwake(enabled: boolean): RemoteState {
		this.#deps.prefs.set(KEEP_AWAKE_KEY, enabled === true);
		return this.#broadcastState();
	}

	/** Forget a device: it may come back while its login is allowed (a block keeps it out). */
	async revokePeer(deviceId: unknown): Promise<RemoteState> {
		if (typeof deviceId !== "string") throw codedError("remote_unknown_device", "Unknown device");
		if (this.#host) await this.#host.revoke(deviceId);
		else this.#peers.remove(deviceId);
		this.#deps.services.dropPeer(deviceId);
		return this.#broadcastState();
	}

	/** Keep a device out: block its node (its login when it never bound one), then forget it. */
	async blockPeer(deviceId: unknown): Promise<RemoteState> {
		if (typeof deviceId !== "string") throw codedError("remote_unknown_device", "Unknown device");
		const peer = this.#peers.get(deviceId);
		if (!peer) throw codedError("remote_unknown_device", "Unknown device");
		const blocks = this.#deps.blocks();
		if (!blocks) throw codedError("remote_tailscale_off", "Blocks are not available yet");
		if (peer.nodeId) {
			blocks.add({ scope: "node", key: peer.nodeId, name: peer.name, tailscaleLogin: peer.login });
		} else if (peer.login) {
			blocks.add({ scope: "login", key: peer.login, name: peer.name, tailscaleLogin: peer.login });
		}
		return this.revokePeer(deviceId);
	}

	/** Daily model-use limits for a device (D65); `{}` removes them. */
	setPeerLimits(payload: unknown): RemoteState {
		const parsed = PeerLimitsPayload.safeParse(payload);
		if (!parsed.success) throw codedError("remote_unknown_device", "Invalid device limits");
		if (!this.#quota.setLimits(parsed.data.deviceId, parsed.data.limits)) {
			throw codedError("remote_unknown_device", "Unknown device");
		}
		return this.#broadcastState();
	}

	/** Count one of a device's daily model requests on this computer outside a link call: a schedule it saved here starting. */
	reserveModelRequest(deviceId: string): QuotaReservation {
		return this.#quota.reserve(deviceId, 1);
	}

	/** A view shows (`true`) or stops showing the tailnet's computers; resolves with what is known now. */
	async watchTailnet(watcher: number, on: unknown): Promise<TailnetComputer[]> {
		if (on === true) {
			this.#watchers.add(watcher);
			if (!this.#scanTimer) {
				this.#scanTimer = setInterval(() => void this.#scan(), TAILNET_SCAN_MS);
				this.#scanTimer.unref?.();
			}
			return this.#scan();
		}
		this.#watchers.delete(watcher);
		if (this.#watchers.size === 0) {
			clearInterval(this.#scanTimer);
			this.#scanTimer = undefined;
		}
		return this.#computers.map(computer => ({ ...computer }));
	}

	/** Connect to a computer of the tailnet by its Tailscale node; pins its key (`key_mismatch` for another one). */
	async connect(nodeId: unknown): Promise<HostView> {
		if (typeof nodeId !== "string" || !nodeId) throw codedError("remote_unreachable", "Missing computer");
		const status = await this.#deps.tailnet.status();
		if (status?.backend !== "running") throw codedError("remote_tailscale_off", "Tailscale is not running");
		const node = status.peers.find(peer => peer.nodeId === nodeId);
		if (!node) throw codedError("remote_unreachable", "That computer is not on the tailnet");
		const found = await this.#probeNode(node);
		if (!found.address) throw codedError("remote_unreachable", "OMPdesk does not answer on that computer");
		if (!found.probe.ok) throw codedError(remoteErrorCode(found.probe.code), found.probe.code);
		let paired: PairedHost;
		try {
			paired = await connectFirst({
				identity: this.#identity,
				address: found.address,
				name: this.deviceName(),
				appVersion: this.#deps.appVersion,
				nodeId,
				hosts: this.#hosts,
			});
		} catch (error) {
			const code = error instanceof RemoteError ? error.code : "protocol";
			throw codedError(remoteErrorCode(code), error instanceof Error ? error.message : String(error));
		}
		this.#found.set(nodeId, found.address);
		// Its open tabs go on over the new link: left on the closed one they read "offline" while the host is online.
		const old = this.#links.get(paired.deviceId)?.tabs;
		const tabs = old ? [...old] : [];
		// Taken off the old link first, so its close does not show them offline for the moment of the swap.
		old?.clear();
		this.#unlink(paired.deviceId);
		this.#link(paired.deviceId);
		const link = this.#links.get(paired.deviceId);
		if (link)
			for (const [rtab, tab] of tabs) {
				link.tabs.set(rtab, tab);
				tab.relink(link.client);
			}
		this.#markComputers();
		this.#broadcastState();
		return this.#hostView(paired.deviceId) ?? toHostView(paired.deviceId, paired.name);
	}

	async tailscaleAction(action: unknown): Promise<RemoteState> {
		if (action !== "install" && action !== "start-app") throw new Error("Unknown Tailscale action");
		await this.#deps.tailscaleAction(action);
		await this.#poll();
		return this.state();
	}

	dismissForgotten(): RemoteState {
		this.#deps.prefs.set(FORGOTTEN_KEY, []);
		return this.#broadcastState();
	}

	removeHost(deviceId: unknown): RemoteState {
		if (typeof deviceId !== "string") throw codedError("remote_unknown_device", "Unknown device");
		this.#unlink(deviceId);
		this.#hosts.remove(deviceId);
		this.#markComputers();
		this.#deps.broadcast(IPC_EVENTS.SESSIONS_CHANGED, { device: deviceId } satisfies IpcSessionsChanged);
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
	 * One host-level request on a known host. Failures surface as coded errors: `remote_offline` while the link
	 * is down, `remote_unknown_device` for a host this device does not know, and the host's own code otherwise.
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
	 * A turn this computer ran for a device when it last crashed or quit (turn-resume.ts): its tab again, waiting
	 * for the device to reconnect. Null while hosting is off or the device is no longer known.
	 */
	reviveHostTab(deviceId: string, marker: ResumeMarker): string | null {
		if (this.#deps.prefs.get(HOST_ENABLED_KEY) !== true) return null;
		const peer = this.#peers.get(deviceId);
		return peer ? this.#deps.services.reviveTab(peer, marker) : null;
	}

	/**
	 * The tabs a paired host keeps running for this computer that no connection holds (`tabs.kept`), the ones that
	 * still have work. Null from a host that does not know the method (an older OMPdesk); an entry this side cannot
	 * read is left out.
	 */
	async keptTabs(deviceId: string): Promise<KeptTab[] | null> {
		let reply: unknown;
		try {
			reply = await this.request<unknown>(deviceId, KEPT_TABS_METHOD, {});
		} catch (error) {
			if (ipcErrorCode(error) === "unsupported") return null;
			throw error;
		}
		const parsed = KeptTabsReply.safeParse(reply);
		if (!parsed.success) return null;
		return parsed.data.tabs.flatMap(entry => {
			const tab = KeptTab.safeParse(entry);
			return tab.success ? [tab.data] : [];
		});
	}

	/** A tab on a known host; throws `remote_unknown_device` when the host is not known. */
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
			// Through the device's current link: Connect pressed again makes a new one and moves the tab onto it.
			onDispose: () => {
				const current = this.#links.get(deviceId) ?? link;
				if (current.tabs.get(rtab) === sidecar) current.tabs.delete(rtab);
			},
			deferClose: closing => (this.#links.get(deviceId) ?? link).closes.defer(closing),
			...(this.#deps.keepHostTabsOnQuit ? { keepOnHost: this.#deps.keepHostTabsOnQuit } : {}),
			stalledMessage: seconds =>
				this.#deps.stalledMessage((this.#links.get(deviceId) ?? link).client.host.name, seconds),
			...(this.#deps.startTimeoutMs === undefined ? {} : { startTimeoutMs: this.#deps.startTimeoutMs }),
			...(this.#deps.logTab ? { log: this.#deps.logTab } : {}),
		});
		link.tabs.set(rtab, sidecar);
		return sidecar;
	}

	/** This machine's omp updater changed state: devices using it as a host show it. */
	hostOmpUpdateChanged(state: OmpUpdateState): void {
		this.#deps.services.ompUpdateChanged(state);
	}

	/** This machine's scheduled runs changed: devices showing them (Settings › Schedules on a tab here) follow. */
	hostSchedulesChanged(state: SchedulesState): void {
		this.#deps.services.schedulesChanged(state);
	}

	/** This machine's sidebar project list changed: devices showing its section follow. */
	hostSidebarProjectsChanged(state: SidebarProjectsState): void {
		this.#deps.services.sidebarProjectsChanged(state);
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

	/** This machine's automatic-title switches changed: tabs it hosts for devices follow them. */
	hostAutoTitleChanged(): void {
		this.#deps.services.syncAutoTitle();
	}

	/** This machine's judge-assist switch changed: tabs it hosts for devices follow it. */
	hostJudgeAssistChanged(): void {
		this.#deps.services.syncJudgeAssist();
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
		clearInterval(this.#pollTimer);
		clearInterval(this.#scanTimer);
		this.#keepAwake.dispose();
		for (const deviceId of [...this.#links.keys()]) this.#unlink(deviceId);
		this.#deps.services.disposeAll();
		await this.#host?.stop();
		this.#host = null;
	}

	/** Read Tailscale's side: phase, this computer's login, the host's addresses, the code-paired hosts. */
	async #poll(): Promise<void> {
		if (this.#disposed) return;
		const phase = await this.#deps.tailnet.phase().catch((): RemoteTailnetPhase => "not-running");
		const status = phase === "ready" ? await this.#deps.tailnet.status() : null;
		if (status?.login) this.#deps.adoptLogin(status.login);
		if (status?.selfName) this.#tailnetName = status.selfName;
		if (status) this.#migrateHosts(status);
		if (status) this.#wakeReturnedHosts(status);
		await this.#host?.rebind();
		if (phase !== this.#phase) {
			this.#phase = phase;
			// Back on the tailnet: known hosts are reachable at their nodes again.
			if (phase === "ready") this.wake("tailnet");
		}
		this.#broadcastState();
	}

	/** A host whose node was offline in the last poll and is online now: its link checks or retries at once. */
	#wakeReturnedHosts(status: TailscaleStatus): void {
		for (const host of this.#hosts.list()) {
			if (!host.nodeId) continue;
			const online = status.peers.find(peer => peer.nodeId === host.nodeId)?.online === true;
			const was = this.#nodeOnline.get(host.nodeId);
			this.#nodeOnline.set(host.nodeId, online);
			if (online && was === false) this.#links.get(host.deviceId)?.client.wake("tailnet");
		}
	}

	/**
	 * Hosts an older release paired by code have no node. Each is matched to a tailnet node by, in order: a stored
	 * address that is one of the node's tailnet addresses; a stored address that is one of its endpoints (`CurAddr`/
	 * `Addrs`: code pairing stored LAN addresses, which Tailscale reports only as the node's endpoint); its announced
	 * name equal to the node's (case aside). A match is kept and verified at its first connection (the client pins
	 * the node, the host its key: a different key is refused); the rest are forgotten (named once in Settings). Runs
	 * once Tailscale is up.
	 */
	#migrateHosts(status: TailscaleStatus): void {
		if (typeof this.#deps.prefs.get(MIGRATED_KEY) === "number") return;
		const forgotten: string[] = [];
		const candidates = status.peers.filter(peer => peer.login !== null);
		for (const host of this.#hosts.list()) {
			if (host.nodeId !== null) continue;
			const stored = new Set(host.addresses.map(address => parseAddress(address)?.host).filter(Boolean));
			const name = host.name.trim().toLowerCase();
			const node =
				candidates.find(peer => peer.ips.some(ip => stored.has(ip))) ??
				candidates.find(peer => peer.endpoints.some(endpoint => stored.has(endpoint))) ??
				candidates.find(peer => peer.name.trim().toLowerCase() === name);
			if (node) {
				// Its stored addresses (LAN, old ports) are of no use any more: the node's tailnet address is.
				this.#hosts.update(host.deviceId, { nodeId: node.nodeId, addresses: [] });
				this.#links.get(host.deviceId)?.client.connect();
				continue;
			}
			this.#unlink(host.deviceId);
			this.#hosts.remove(host.deviceId);
			forgotten.push(host.name);
		}
		this.#deps.prefs.set(MIGRATED_KEY, this.#now());
		if (forgotten.length > 0) {
			this.#deps.prefs.set(FORGOTTEN_KEY, forgotten);
			this.#deps.log?.("migration", { forgotten: forgotten.length });
		}
	}

	/** A device an older release paired by code that never connected over Tailscale goes after the grace period. */
	#forgetStaleLegacyPeers(): void {
		const migratedAt = this.#deps.prefs.get(MIGRATED_KEY);
		if (typeof migratedAt !== "number" || this.#now() - migratedAt < LEGACY_PEER_GRACE_MS) return;
		for (const peer of this.#peers.list()) {
			if (peer.nodeId === null) this.#peers.remove(peer.deviceId);
		}
	}

	/** Who may connect, from Tailscale: a tailnet address, a node of an allowed login, not blocked. */
	async #gate(ip: string): Promise<GateResult> {
		const loopback = this.#deps.loopback === true && (ip === "127.0.0.1" || ip === "::1");
		if (!isTailnetAddress(ip) && !loopback) return { ok: false, code: "not_tailnet" };
		const peer = await this.#deps.tailnet.whois(ip);
		if (!peer?.nodeId || !peer.login) return { ok: false, code: "no_identity" };
		const login = peer.login.trim().toLowerCase();
		// Unset list: this computer's own account, as Mobile web reads it (its poll may not have stored it yet).
		const listed = this.#deps.allowedUsers();
		const users = listed.length > 0 ? listed : [(await this.#deps.tailnet.status())?.login ?? ""];
		const allowed = users.map(user => user.trim().toLowerCase()).filter(Boolean);
		if (!allowed.includes(login)) return { ok: false, code: "not_allowed" };
		const blocked = this.#deps.blocks()?.check({ nodeId: peer.nodeId, login: peer.login });
		if (blocked) return { ok: false, code: "blocked" };
		return { ok: true, visitor: { nodeId: peer.nodeId, login: peer.login, nodeName: peer.nodeName, ip } };
	}

	async #admit(visitor: TailnetVisitor, name: string): Promise<boolean> {
		if (this.#deps.prefs.get(CONFIRM_KEY) !== true) return true;
		return this.#deps
			.confirm({ name, login: visitor.login, ip: visitor.ip, nodeName: visitor.nodeName })
			.catch(() => false);
	}

	/** This computer's tailnet addresses: the only ones the host listens on. */
	async #bindHosts(): Promise<string[]> {
		const status = await this.#deps.tailnet.status();
		if (status?.backend !== "running") return [];
		const loopback = (ip: string) => this.#deps.loopback === true && (ip === "127.0.0.1" || ip === "::1");
		return status.selfIps.filter(ip => isTailnetAddress(ip) || loopback(ip));
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
				bindHosts: () => this.#bindHosts(),
				gate: ip => this.#gate(ip),
				admit: (visitor, name) => this.#admit(visitor, name),
				log: this.#deps.log,
				logLink: this.#deps.logLink,
				// The computer that just connected may be one this device uses as a host: it is up, so dial it now.
				peerOpened: deviceId => this.#links.get(deviceId)?.client.wake("peer"),
				renameSelf: (name, by) => {
					console.info(`[remote] ${by.name} (${by.deviceId}) renamed this computer to "${name}"`);
					this.setDeviceName(name);
				},
			});
			for (const event of ["peersChanged", "connectionsChanged", "listenChanged"] as const) {
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

	/** Where a node's host answers: the first candidate port that answers a probe, on the node's address. */
	async #probeNode(node: TailnetNode): Promise<{ address: string | null; probe: ProbeResult }> {
		const ip = node.ips.find(candidate => isIPv4(candidate)) ?? node.ips.find(candidate => isIP(candidate) !== 0);
		let probe: ProbeResult = { ok: false, code: "unreachable" };
		if (!ip) return { address: null, probe };
		const last = this.#found.get(node.nodeId);
		const candidates = remotePortCandidates().map(port => formatAddress({ host: ip, port }));
		const addresses = last && candidates.includes(last) ? [last, ...candidates.filter(a => a !== last)] : candidates;
		for (const address of addresses) {
			try {
				probe = await probeHost(address);
			} catch (error) {
				// No answer at all: the computer is away, and its other ports would each wait out the timeout too.
				if (error instanceof RemoteError && error.timedOut) break;
				continue;
			}
			// This computer itself (a test's two apps on one address).
			if (probe.ok && probe.deviceId === this.#identity.deviceId) continue;
			this.#found.set(node.nodeId, address);
			return { address, probe };
		}
		this.#found.delete(node.nodeId);
		return { address: null, probe };
	}

	/** Probe every computer of the tailnet (not phones) and push the list while views watch it. */
	#scan(): Promise<TailnetComputer[]> {
		this.#scanning ??= this.#scanOnce().finally(() => {
			this.#scanning = null;
		});
		return this.#scanning;
	}

	async #scanOnce(): Promise<TailnetComputer[]> {
		const status = await this.#deps.tailnet.status();
		const nodes =
			status?.backend === "running"
				? status.peers.filter(peer => peer.online && !(peer.os && MOBILE_OS.test(peer.os)))
				: [];
		const results: TailnetComputer[] = new Array(nodes.length);
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < nodes.length) {
				const index = next++;
				const node = nodes[index];
				if (!node) continue;
				const { probe, address } = await this.#probeNode(node);
				results[index] = {
					nodeId: node.nodeId,
					name: probe.ok ? probe.name : node.name,
					login: node.login,
					state: address === null ? "absent" : probe.ok ? "available" : "refused",
					refusal: address !== null && !probe.ok ? probe.code : null,
					deviceId: probe.ok ? probe.deviceId : null,
					connected: false,
				};
			}
		};
		await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, nodes.length) }, worker));
		this.#computers = results.filter(Boolean);
		this.#markComputers();
		return this.#computers.map(computer => ({ ...computer }));
	}

	/** Mark the computers this device already uses, and push the list. */
	#markComputers(): void {
		for (const computer of this.#computers) {
			computer.connected = this.#hosts.byNode(computer.nodeId) !== undefined;
		}
		this.#deps.broadcast(IPC_EVENTS.REMOTE_TAILNET, this.#computers);
	}

	/**
	 * A known host's addresses now: its node's current tailnet address on the port it answered on in this run, then
	 * on every candidate port. Stored addresses and ports are never dialed: a reboot moves the port, code pairing
	 * stored LAN addresses, and a host now listens on its tailnet address only. A host with no node yet (code-paired,
	 * not migrated) has nothing to dial until the migration finds its node.
	 */
	async #hostAddresses(host: PairedHost): Promise<string[]> {
		if (!host.nodeId) return [];
		const status = await this.#deps.tailnet.status();
		const node = status?.peers.find(peer => peer.nodeId === host.nodeId);
		const ip = node?.ips.find(candidate => isIPv4(candidate)) ?? node?.ips[0];
		if (!ip) return [];
		const found = this.#found.get(host.nodeId);
		const addresses = remotePortCandidates().map(port => formatAddress({ host: ip, port }));
		return found && addresses.includes(found) ? [found, ...addresses.filter(a => a !== found)] : addresses;
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
			addresses: host => this.#hostAddresses(host),
			log: this.#deps.logLink,
		});
		const link: HostLink = { client, tabs: new Map(), closes: new PendingTabCloses() };
		client.on("state", state => {
			for (const tab of link.tabs.values()) tab.linkStateChanged(state);
			// What the host worked on is unknown while the link is down: its rows go quiet rather than stay lit.
			if (state !== "online") {
				link.live = undefined;
				link.webUrl = undefined;
			}
			this.#broadcastState();
			if (state !== "online") return;
			link.closes.flush(rtab => client.request("tab.close", { rtab }));
			void this.#readLiveSessions(link);
			void this.#readWebLink(link);
			// Its session list went stale while it was away (or never loaded).
			this.#deps.broadcast(IPC_EVENTS.SESSIONS_CHANGED, { device: deviceId } satisfies IpcSessionsChanged);
			for (const listener of this.#hostOnline) listener(deviceId);
		});
		client.on("event", (event, data) => {
			if (event === SESSIONS_CHANGED_EVENT) {
				this.#deps.broadcast(IPC_EVENTS.SESSIONS_CHANGED, { device: deviceId } satisfies IpcSessionsChanged);
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
			if (event === SCHEDULES_EVENT) {
				const state = SchedulesStateSchema.safeParse(data);
				if (state.success) {
					const update: IpcHostSchedules = { device: deviceId, state: state.data };
					this.#deps.broadcast(IPC_EVENTS.HOST_SCHEDULES_STATE, update);
				}
				return;
			}
			if (event === LIVE_SESSIONS_EVENT) {
				this.#setLiveSessions(link, data);
				return;
			}
			if (event === MOBILE_WEB_LINK_EVENT) {
				this.#setWebLink(link, data);
				return;
			}
			if (event === PROJECTS_EVENT) {
				const state = SidebarProjectsStateSchema.safeParse(data);
				if (state.success) {
					const update: IpcSidebarProjects = { device: deviceId, state: state.data };
					this.#deps.broadcast(SIDEBAR_PROJECTS_STATE, update);
				}
				return;
			}
			if (event === AUTOPILOT_NOTICE_EVENT) {
				const notice = AutopilotNoticeEvent.safeParse(data);
				if (notice.success) for (const listener of this.#autopilotNotices) listener(deviceId, notice.data);
				return;
			}
			if (event === HOST_NAME_EVENT || event === DEVICE_RENAME_EVENT) {
				const named = NameParams.safeParse(data);
				if (!named.success) return;
				if (event === DEVICE_RENAME_EVENT) {
					console.info(`[remote] ${client.host.name} renamed this computer to "${named.data.name}"`);
					this.setDeviceName(named.data.name);
					return;
				}
				client.hostRenamed(named.data.name);
				this.#broadcastState();
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

	/** The host's live sessions as the link comes up; a host that does not know the method (older OMPdesk) sends none. */
	async #readLiveSessions(link: HostLink): Promise<void> {
		try {
			this.#setLiveSessions(link, await link.client.request<unknown>(LIVE_SESSIONS_METHOD, {}));
		} catch {
			// unsupported, or the link dropped again: the next push or link-up says it.
		}
	}

	/** The host's Mobile web address as the link comes up; an older host does not know the method. */
	async #readWebLink(link: HostLink): Promise<void> {
		try {
			this.#setWebLink(link, await link.client.request<unknown>(MOBILE_WEB_LINK_METHOD, {}));
		} catch {
			// unsupported, or the link dropped again: the next push or link-up says it.
		}
	}

	#setWebLink(link: HostLink, data: unknown): void {
		const reply = MobileWebLinkReply.safeParse(data);
		if (!reply.success || link.client.state !== "online") return;
		const url = reply.data.url ?? undefined;
		if (url === link.webUrl) return;
		link.webUrl = url;
		this.#broadcastState();
	}

	#setLiveSessions(link: HostLink, data: unknown): void {
		const reply = LiveSessionsReply.safeParse(data);
		if (!reply.success || link.client.state !== "online") return;
		link.live = reply.data.sessions.flatMap(entry => {
			const session = HostLiveSessionSchema.safeParse(entry);
			return session.success ? [session.data] : [];
		});
		this.#broadcastState();
	}

	#hostView(deviceId: string): HostView | null {
		const link = this.#links.get(deviceId);
		const client = link?.client;
		if (!client) return null;
		const view = toHostView(deviceId, client.host.name, client.state);
		if (client.hello) {
			view.platform = client.hello.platform;
			view.home = client.hello.home;
			// Only while connected: the last hello says nothing of a host that may have updated since.
			if (client.state === "online") view.appVersion = client.hello.appVersion;
		}
		if (client.state === "online" && link.live) view.live = link.live;
		if (client.state === "online" && link.webUrl) view.webUrl = link.webUrl;
		return view;
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

function parseRename(payload: unknown): { deviceId: string; name: string } {
	const parsed = RenamePayload.safeParse(payload);
	if (!parsed.success) throw codedError("remote_unknown_device", "Invalid rename");
	const name = DeviceNameSchema.safeParse(parsed.data.name);
	if (!name.success) throw codedError("invalid_name", "Invalid device name");
	return { deviceId: parsed.data.deviceId, name: name.data };
}
