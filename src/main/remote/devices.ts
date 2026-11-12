/**
 * Remote devices in the main process: both roles of this computer, over Tailscale only. The records, Tailscale's
 * side, the host's listener, rebind and gate, each known host's reconnecting client and the host's keep-awake run in
 * the core's devices instance (`crates/core/src/remote/devices/`, `sharing.ts` is its client); main mirrors its state
 * for the synchronous readers here and keeps what only it can say or do.
 *
 * Host (B): when prefs `remote.hostEnabled` is on, the core listens on this computer's tailnet addresses and lets in
 * the devices Tailscale vouches for (an allowed login, a node Mobile web's blocks do not hold, approved first when
 * "approve new devices" is on); `RemoteHost` here serves each device link's requests through `LocalHostServices`.
 *
 * Client (A): the computers of the tailnet are probed while a view watches them; Connect pins one and keeps a
 * RemoteClient to it, which the core reconnects at its node's current tailnet address. Tabs on a host are
 * RemoteSidecars created through `createSidecar` (the pool's factory calls it for a tab with a `device`); each
 * client's `tab.event`s are routed to its tabs by rtab, and its link state becomes their status. A host's
 * `sessions.changed`, and every link coming online, make the renderer refetch the session lists.
 *
 * The whole picture goes to every window as `remote:state` on each change.
 */

import { hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import { KEEP_AWAKE_WORKING_PREF } from "../../shared/desktop-prefs";
import { codedError, type IpcErrorCode, ipcErrorCode, isIpcErrorCode } from "../../shared/ipc-error-codes";
import {
	type HostView,
	IPC_EVENTS,
	type IpcHostOmpUpdate,
	type IpcHostSchedules,
	type IpcSessionsChanged,
	type RemoteDirListing,
	type RemoteOpenedTab,
	type RemoteState,
	type SessionInfo,
	type TailnetComputer,
} from "../../shared/ipc-types";
import type { OmpUpdateState } from "../../shared/omp-update";
import type { SchedulesState } from "../../shared/schedules";
import type { VersionedSessionList } from "../../shared/session-list-delta";
import {
	applySummaryChange,
	type SummariesChanged,
	type SummaryDelta,
	type VersionedSummaries,
} from "../../shared/session-summary";
import {
	type IpcSidebarProjects,
	SIDEBAR_PROJECTS_STATE,
	type SidebarProjectsState,
} from "../../shared/sidebar-projects";
import type { ModelWaitTracker } from "../model-wait-count";
import type { RelaySocket } from "../preview/relay-socket";
import type { ResumeMarker } from "../turn-resume";
import type { WebBlocks } from "../web/blocks-store";
import {
	AUTOPILOT_NOTICE_EVENT,
	AutopilotNoticeEvent,
	DEVICE_RENAME_EVENT,
	DeviceNameSchema,
	HOST_NAME_EVENT,
	KEPT_TABS_METHOD,
	KeptTab,
	KeptTabsReply,
	MOBILE_WEB_LINK_EVENT,
	MOBILE_WEB_LINK_METHOD,
	MODEL_WAIT_EVENT,
	MODELS_CHANGED_EVENT,
	MobileWebLinkReply,
	NAME_METHODS,
	NameParams,
	OMP_UPDATE_EVENT,
	OmpUpdateStateSchema,
	PREVIEW_RELAY_EVENT,
	PROJECTS_EVENT,
	PreviewRelayEvent,
	REMOTE_OPENED_EVENT,
	REMOTE_OPENED_METHOD,
	RemoteOpenedReply,
	RemoteOpenedTabSchema,
	SCHEDULES_EVENT,
	SchedulesStateSchema,
	SESSIONS_CHANGED_EVENT,
	SESSIONS_DELETED_EVENT,
	SESSIONS_DELETED_MAX_PATHS,
	SESSIONS_DELETED_METHOD,
	SessionsDeletedReply,
	SidebarProjectsStateSchema,
	SUMMARIES_EVENT,
	SUMMARIES_METHOD,
	SummaryDeltaSchema,
	TAB_EVENT,
	TabEventMessage,
	VersionedSummariesSchema,
} from "./app-protocol";
import { HELLO_CAPABILITIES, RemoteClient, RemoteError, type WakeTrigger } from "./client";
import { type HostMachineInfo, RemoteHost } from "./host-server";
import type { LocalHostServices } from "./host-services";
import { HostSessionList } from "./host-session-list";
import type { Identity } from "./identity";
import { ImageBlobCache } from "./image-blob-cache";
import { type KeepAwakeBlocker, KeepAwakePolicy } from "./keep-awake";
import { LinkRelaySocket } from "./link-relay-socket";
import { PeerQuota, type QuotaRecord, type QuotaReservation, type QuotaStore } from "./peer-quota";
import type { PeerInfo } from "./peers-store";
import { REFUSAL_CODES } from "./protocol";
import { PendingTabCloses, RemoteSidecar, type RemoteSidecarOptions } from "./remote-sidecar";
import { SharingCore, type SharingSnapshot, type TailnetAccess } from "./sharing";
import { TranscriptCache } from "./transcript-cache";

const ModelWaitCountsSchema = z.object({ counts: z.record(z.string(), z.number().int().nonnegative()) });
const RenamePayload = z.object({ deviceId: z.string().min(1), name: z.string() });
/** Usage counters reach the Settings view at most this often. */
const QUOTA_BROADCAST_MS = 1_000;
const Limit = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
const PeerLimitsPayload = z.object({
	deviceId: z.string().min(1),
	limits: z.object({ requestsPerDay: Limit, tokensPerDay: Limit }),
});

const HOST_ENABLED_KEY = "remote.hostEnabled";
const DEVICE_NAME_KEY = "remote.deviceName";
/** The one "approve new devices" switch, shared with Mobile web (`MOBILE_WEB_PREFS.confirmNewDevices`, written there). */
const CONFIRM_KEY = "mobileWeb.confirmNewDevices";
/** When code-paired hosts were matched to tailnet nodes (epoch ms); unset = not yet. */
const MIGRATED_KEY = "remote.tailnetMigratedAt";
/** Names of code-paired hosts that were not found on the tailnet and were forgotten (until the user read it). */
const FORGOTTEN_KEY = "remote.forgottenHosts";

/** A refusal (or this side's verdict) as the error code the renderer localizes. */
function remoteErrorCode(code: string): IpcErrorCode {
	const mapped = `remote_${code}`;
	if ((REFUSAL_CODES as readonly string[]).includes(code) && isIpcErrorCode(mapped)) return mapped;
	return code === "unreachable" ? "remote_unreachable" : "remote_protocol";
}

export interface RemoteDevicesDeps {
	userData: string;
	/** This computer's remote identity, loaded by the core before the devices start (`loadIdentity`). */
	identity: Identity;
	appVersion: string;
	prefs: { get(key: string): unknown; set(key: string, value: unknown): void };
	/** Send to every window. */
	broadcast: (channel: string, data: unknown) => void;
	/** Host role services (this machine's sidecars, sessions, files). */
	services: LocalHostServices;
	/** Receives a paired host's own count of the sessions waiting on each provider (model-wait-count.ts). */
	modelWait?: Pick<ModelWaitTracker, "setHostCounts">;
	/** Machine part of the host hello. */
	machineInfo: () => HostMachineInfo;
	/** Status message of a tab whose host is unreachable, in the UI language. */
	offlineMessage: () => string;
	/** Status message of a host tab whose host leaves its start unanswered for now, naming the host, in the UI language. */
	unansweredMessage: (device: string) => string;
	/** A host tab's bring-up step, for the runtime log (`remote-tab`). */
	logTab?: RemoteSidecarOptions["log"];
	/**
	 * A host tab's browser sign-in comes back through this computer's loopback (sign-in-relay.ts): the browser page's
	 * words, naming the host, when the host could not take the callback. Absent: no stand-in.
	 */
	signInRelay?: { failure: (device: string) => { title: string; message: string }; port?: number };
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
}

/** A host whose link is down: no summaries of it, so its rows show no live state rather than stale state. */
const OFFLINE_SUMMARIES: VersionedSummaries = { version: "offline", sessions: [] };

interface HostLink {
	client: RemoteClient;
	/** rtab → tab on this host. */
	tabs: Map<string, RemoteSidecar>;
	/** Tabs closed here while the host was unreachable; it is told when the link is back. */
	closes: PendingTabCloses;
	/** The host's session list, one copy for every window here that shows it. */
	sessions: HostSessionList;
	/** What the host built of its sessions' live state (`host.summaries`); unset while offline or from an older host. */
	summaries?: VersionedSummaries;
	/** The tabs the host's windows hold on a paired device that its sessions opened (`host.remoteOpened`). */
	remoteOpened?: RemoteOpenedTab[];
	/** The host's Mobile web address (`host.mobileWeb.link`); unset while offline, not serving, or from an older host. */
	webUrl?: string;
	/** Open agent-browsing tunnels to this host's tab relays, by rtab (`previewRelay`). */
	relays: Map<string, LinkRelaySocket>;
}

/**
 * The device records as main reads them in the same tick (the quota's `reserve`, the device lists): the core's last
 * state with main's own quota writes over it until the core says it applied them (`patched`). Main is the only
 * writer of `limits` and `usage`, so its latest write of a field is the record's.
 */
class PeerMirror implements QuotaStore {
	#peers = new Map<string, PeerInfo>();
	readonly #written = new Map<string, { seq: number; patch: Partial<Pick<PeerInfo, "limits" | "usage">> }>();
	#seq = 0;
	readonly #send: (seq: number, deviceId: string, patch: Record<string, unknown>) => void;

	constructor(send: (seq: number, deviceId: string, patch: Record<string, unknown>) => void) {
		this.#send = send;
	}

	told(snapshot: SharingSnapshot): void {
		this.#peers = new Map(snapshot.peers.map(peer => [peer.deviceId, peer]));
		for (const [deviceId, written] of this.#written)
			if (written.seq <= snapshot.patched) this.#written.delete(deviceId);
	}

	list(): PeerInfo[] {
		return [...this.#peers.keys()].flatMap(deviceId => this.get(deviceId) ?? []);
	}

	get(deviceId: string): PeerInfo | undefined {
		const peer = this.#peers.get(deviceId);
		if (!peer) return undefined;
		const written = this.#written.get(deviceId)?.patch ?? {};
		const merged: PeerInfo = { ...peer, ...written };
		if ("limits" in written && written.limits === undefined) delete merged.limits;
		return merged;
	}

	update(deviceId: string, patch: Pick<QuotaRecord, "limits" | "usage">): PeerInfo | undefined {
		if (!this.#peers.has(deviceId)) return undefined;
		const seq = ++this.#seq;
		const written = { ...this.#written.get(deviceId)?.patch, ...patch };
		this.#written.set(deviceId, { seq, patch: written });
		const wire: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(patch)) wire[key] = value ?? null;
		this.#send(seq, deviceId, wire);
		return this.get(deviceId);
	}
}

export class RemoteDevices {
	readonly #deps: RemoteDevicesDeps;
	readonly #identity: Identity;
	readonly #sharing: Promise<SharingCore>;
	/** The core's devices instance once open; its snapshot is what the synchronous readers here read. */
	#core: SharingCore | null = null;
	readonly #peers: PeerMirror;
	/** Every host's subagent pictures this device read, by content address: one folder for all tabs and hosts. */
	readonly #imageBlobs: ImageBlobCache;
	/** Every host's transcripts this device read (subagent journals, tail pages): one folder for all tabs and hosts. */
	readonly #transcripts: TranscriptCache;
	readonly #links = new Map<string, HostLink>();
	#host: RemoteHost | null = null;
	#disposed = false;
	readonly #keepAwake: KeepAwakePolicy;
	readonly #unwatchRunning: () => void;
	readonly #quota: PeerQuota;
	#quotaTimer: NodeJS.Timeout | undefined;
	/** The device name the core was told last. */
	#toldName: string;
	readonly #hostOnline = new Set<(deviceId: string) => void>();
	readonly #autopilotNotices = new Set<(hostId: string, notice: AutopilotNoticeEvent) => void>();
	readonly #hostProjects = new Set<(hostId: string, state: SidebarProjectsState) => void>();
	readonly #hostSessionsDeleted = new Set<(hostId: string, paths: string[]) => void>();

	constructor(deps: RemoteDevicesDeps) {
		this.#deps = deps;
		this.#identity = deps.identity;
		this.#imageBlobs = new ImageBlobCache(path.join(deps.userData, "remote-image-blobs"));
		this.#transcripts = new TranscriptCache(path.join(deps.userData, "remote-transcripts"));
		this.#keepAwake = new KeepAwakePolicy({
			blocker: deps.powerSaveBlocker,
			onChange: () => this.#broadcastState(),
		});
		this.#toldName = this.deviceName();
		this.#sharing = SharingCore.open({
			identity: deps.identity,
			userData: deps.userData,
			appVersion: deps.appVersion,
			name: this.#toldName,
			tailnet: deps.tailnet,
			policy: who => ({
				allowedUsers: deps.allowedUsers(),
				blocked: Boolean(deps.blocks()?.check(who)),
			}),
			admit: (visitor, name) =>
				deps.prefs.get(CONFIRM_KEY) !== true
					? Promise.resolve(true)
					: deps.confirm({ name, login: visitor.login, ip: visitor.ip, nodeName: visitor.nodeName }),
			loopback: deps.loopback === true,
			traffic: deps.logLink !== undefined,
			keepAwake: this.#keepAwake.policyId(),
			keepAwakeEnabled: this.#keepAwakeEnabled(),
			migratedAt: typeof deps.prefs.get(MIGRATED_KEY) === "number" ? (deps.prefs.get(MIGRATED_KEY) as number) : null,
			...(deps.log ? { log: deps.log } : {}),
			onState: snapshot => this.#told(snapshot),
			onComputers: computers => this.#deps.broadcast(IPC_EVENTS.REMOTE_TAILNET, computers),
			onAdoptLogin: login => this.#deps.adoptLogin(login),
			onMigrated: migration => this.#migrated(migration),
		}).then(sharing => {
			this.#core = sharing;
			this.#told(sharing.snapshot);
			return sharing;
		});
		this.#peers = new PeerMirror((seq, deviceId, patch) => {
			void this.#sharing.then(sharing => sharing.peerPatch(seq, deviceId, patch)).catch(() => undefined);
		});
		this.#unwatchRunning = deps.services.onRunningChange(() => {
			this.#core?.configure({ running: this.#deps.services.runningPeers().length > 0 });
			this.#broadcastState();
		});
		// Usage is written per assistant message; the Settings view needs only a settled count.
		this.#quota = new PeerQuota(this.#peers, () => this.#quotaChanged());
		deps.services.attachQuota(this.#quota);
	}

	/** Resolves once the core's devices instance is open and its records are mirrored here. */
	async ready(): Promise<void> {
		await this.#sharing;
	}

	/** Launch: the host role per prefs, a link to every known host, and the Tailscale poll. */
	start(): void {
		const sharing = this.#core;
		const failed = (error: unknown) =>
			console.warn(`[remote] devices failed to start: ${error instanceof Error ? error.message : String(error)}`);
		if (!sharing) {
			void this.#sharing.then(() => this.start(), failed);
			return;
		}
		if (this.#disposed) return;
		if (this.#deps.prefs.get(HOST_ENABLED_KEY) === true) void this.#startHost();
		for (const host of sharing.snapshot.hosts) this.#link(host.deviceId);
		sharing.start().catch(failed);
	}

	/**
	 * The computer or the network may have changed (wake from sleep, unlock, the network back, a window in front):
	 * every host link checks that it is alive, or retries now when it is not (`RemoteClient.wake`).
	 */
	wake(trigger: WakeTrigger): void {
		for (const link of this.#links.values()) link.client.wake(trigger);
	}

	#keepAwakeEnabled(): boolean {
		return this.#deps.prefs.get(KEEP_AWAKE_WORKING_PREF) !== false;
	}

	/** The core told what changed: the mirror follows, the windows are told, a new tailnet name is passed on. */
	#told(snapshot: SharingSnapshot): void {
		this.#peers.told(snapshot);
		const name = this.deviceName();
		if (this.#core && name !== this.#toldName) {
			this.#toldName = name;
			this.#core?.configure({ name });
		}
		this.#broadcastState();
	}

	/** Code-paired hosts were matched to nodes once: remembered, and the ones not found named once. */
	#migrated(migration: { at: number; forgotten: string[]; removed: string[] }): void {
		for (const deviceId of migration.removed) this.#unlink(deviceId);
		this.#deps.prefs.set(MIGRATED_KEY, migration.at);
		if (migration.forgotten.length > 0) {
			this.#deps.prefs.set(FORGOTTEN_KEY, migration.forgotten);
			this.#deps.log?.("migration", { forgotten: migration.forgotten.length });
		}
	}

	#snapshot(): SharingSnapshot | null {
		return this.#core?.snapshot ?? null;
	}

	state(): RemoteState {
		const host = this.#host;
		const versions = new Map((host?.connections() ?? []).map(peer => [peer.deviceId, peer.appVersion]));
		const online = new Set(versions.keys());
		const using = new Set([...online, ...this.#deps.services.runningPeers()]);
		const peers = this.#peers.list();
		const forgotten = this.#deps.prefs.get(FORGOTTEN_KEY);
		return {
			tailnet: this.#snapshot()?.phase ?? "not-running",
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
				keepAwake: this.#deps.prefs.get(KEEP_AWAKE_WORKING_PREF) !== false,
				keepingAwake: this.#keepAwake.held,
				usedBy: peers.filter(peer => using.has(peer.deviceId)).map(peer => peer.name),
			},
			hosts: (this.#snapshot()?.hosts ?? []).map(
				paired => this.#hostView(paired.deviceId) ?? toHostView(paired.deviceId, paired.name),
			),
			forgotten: Array.isArray(forgotten) ? forgotten.filter(name => typeof name === "string") : [],
			appVersion: this.#deps.appVersion,
		};
	}

	deviceName(): string {
		const stored = this.#deps.prefs.get(DEVICE_NAME_KEY);
		if (typeof stored === "string" && stored.trim()) return stored;
		return this.#snapshot()?.tailnetName ?? hostname().replace(/\.local$/i, "");
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

	/** A paired host's sidebar project list changed (`host.projects.changed`), after the windows were told. */
	onHostProjects(listener: (hostId: string, state: SidebarProjectsState) => void): () => void {
		this.#hostProjects.add(listener);
		return () => this.#hostProjects.delete(listener);
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
			this.#toldName = next;
			this.#core?.configure({ name: next });
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

	/** General's keep-awake switch changed: the host's blocker follows it at once. */
	keepAwakeChanged(): void {
		this.#core?.configure({ keepAwakeEnabled: this.#keepAwakeEnabled() });
		this.#broadcastState();
	}

	/** Forget a device: it may come back while its login is allowed (a block keeps it out). */
	async revokePeer(deviceId: unknown): Promise<RemoteState> {
		if (typeof deviceId !== "string") throw codedError("remote_unknown_device", "Unknown device");
		if (this.#host) await this.#host.revoke(deviceId);
		else await (await this.#sharing).revoke(deviceId);
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
		return (await this.#sharing).watch(watcher, on === true);
	}

	/** Connect to a computer of the tailnet by its Tailscale node; pins its key (`key_mismatch` for another one). */
	async connect(nodeId: unknown): Promise<HostView> {
		if (typeof nodeId !== "string" || !nodeId) throw codedError("remote_unreachable", "Missing computer");
		const answer = await (await this.#sharing).connect(nodeId, HELLO_CAPABILITIES);
		if ("failed" in answer) {
			const { code, message } = answer.failed;
			throw codedError(code === "tailscale_off" ? "remote_tailscale_off" : remoteErrorCode(code), message);
		}
		const paired = answer.host;
		// Its open tabs go on over the new link: left on the closed one they read "offline" while the host is online.
		const old = this.#links.get(paired.deviceId)?.tabs;
		const tabs = old ? [...old] : [];
		// Taken off the old link first, so its close does not show them offline for the moment of the swap.
		old?.clear();
		this.#unlink(paired.deviceId);
		this.#link(paired.deviceId, paired);
		const link = this.#links.get(paired.deviceId);
		if (link)
			for (const [rtab, tab] of tabs) {
				link.tabs.set(rtab, tab);
				tab.relink(link.client);
			}
		this.#broadcastState();
		return this.#hostView(paired.deviceId) ?? toHostView(paired.deviceId, paired.name);
	}

	async tailscaleAction(action: unknown): Promise<RemoteState> {
		if (action !== "install" && action !== "start-app") throw new Error("Unknown Tailscale action");
		await this.#deps.tailscaleAction(action);
		await (await this.#sharing).poll();
		return this.state();
	}

	dismissForgotten(): RemoteState {
		this.#deps.prefs.set(FORGOTTEN_KEY, []);
		return this.#broadcastState();
	}

	async removeHost(deviceId: unknown): Promise<RemoteState> {
		if (typeof deviceId !== "string") throw codedError("remote_unknown_device", "Unknown device");
		this.#unlink(deviceId);
		await (await this.#sharing).removeHost(deviceId);
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

	/** A paired host's whole session list with this computer's version of it (the copy every window here shares). */
	hostSessions(deviceId: string): Promise<VersionedSessionList> {
		const link = this.#links.get(deviceId);
		if (!link) return Promise.reject(codedError("remote_unknown_device", "The device is not paired"));
		return link.sessions.current();
	}

	/** A paired host's sessions, tagged with it: the global list from the shared copy, a folder's from the host. */
	async listHostSessions(deviceId: string, scope: "local" | "global", cwd?: string): Promise<SessionInfo[]> {
		if (scope === "global") return (await this.hostSessions(deviceId)).sessions;
		const sessions = await this.request<SessionInfo[]>(deviceId, "sessions.list", { scope, cwd });
		return sessions.map(info => ({ ...info, device: deviceId }));
	}

	/** A request changed the host's sessions (a delete, a move, a rename): the next read asks the host, not the copy. */
	hostSessionsStale(deviceId: string): void {
		this.#links.get(deviceId)?.sessions.stale();
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

	/**
	 * Which of `paths` (session paths on the host, the ones this computer's tabs on it hold) the host has deleted
	 * (`sessions.deleted`). Null from a host that does not know the method (an older OMPdesk).
	 */
	async deletedOnHost(deviceId: string, paths: readonly string[]): Promise<string[] | null> {
		const deleted: string[] = [];
		for (let at = 0; at < paths.length; at += SESSIONS_DELETED_MAX_PATHS) {
			let reply: unknown;
			try {
				reply = await this.request<unknown>(deviceId, SESSIONS_DELETED_METHOD, {
					paths: paths.slice(at, at + SESSIONS_DELETED_MAX_PATHS),
				});
			} catch (error) {
				if (ipcErrorCode(error) === "unsupported") return null;
				throw error;
			}
			const parsed = SessionsDeletedReply.safeParse(reply);
			if (!parsed.success) return null;
			for (const path of parsed.data.paths) if (typeof path === "string") deleted.push(path);
		}
		return deleted;
	}

	/** The sessions a paired host deleted (`host.sessionsDeleted`), as its person deletes them. */
	onHostSessionsDeleted(listener: (hostId: string, paths: string[]) => void): () => void {
		this.#hostSessionsDeleted.add(listener);
		return () => this.#hostSessionsDeleted.delete(listener);
	}

	#sessionsDeleted(hostId: string, raw: readonly unknown[]): void {
		const paths = raw.filter((path): path is string => typeof path === "string" && path !== "");
		if (paths.length === 0) return;
		for (const listener of this.#hostSessionsDeleted) listener(hostId, paths);
	}

	/** A tab on a known host; throws `remote_unknown_device` when the host is not known. */
	createSidecar(deviceId: string, rtab: string, cwd: string, kind: "agent" | "chat", fresh: boolean): RemoteSidecar {
		const link = this.#links.get(deviceId);
		if (!link) throw codedError("remote_unknown_device", "The device is not paired");
		// Opened again under an id the host was still to be told to close: that tab is live.
		link.closes.cancel(rtab);
		const relay = this.#deps.signInRelay;
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
			unansweredMessage: () => this.#deps.unansweredMessage((this.#links.get(deviceId) ?? link).client.host.name),
			...(this.#deps.logTab ? { log: this.#deps.logTab } : {}),
			imageBlobs: this.#imageBlobs,
			transcripts: this.#transcripts,
			...(relay
				? {
						signInRelay: {
							failure: () => relay.failure((this.#links.get(deviceId) ?? link).client.host.name),
							...(relay.port === undefined ? {} : { port: relay.port }),
						},
					}
				: {}),
		});
		link.tabs.set(rtab, sidecar);
		return sidecar;
	}

	/**
	 * A tunnel to the browser relay the host's tab `rtab` started, for this computer's Preview page to be driven through
	 * (`host.previewRelay.*`). The host dials only the relay it remembered for that tab. One per tab: a new one closes the old.
	 */
	previewRelay(deviceId: string, rtab: string): RelaySocket {
		const link = this.#links.get(deviceId);
		if (!link) throw codedError("remote_unknown_device", "The device is not paired");
		link.relays.get(rtab)?.close();
		const socket = new LinkRelaySocket(
			{ request: (method, params) => this.request(deviceId, method, params) },
			rtab,
			() => {
				if (link.relays.get(rtab) === socket) link.relays.delete(rtab);
			},
		);
		link.relays.set(rtab, socket);
		return socket;
	}

	/** This machine's omp updater changed state: devices using it as a host show it. */
	hostOmpUpdateChanged(state: OmpUpdateState): void {
		this.#deps.services.ompUpdateChanged(state);
	}

	/** The sessions waiting on each provider here changed: devices viewing a tab of this host say how many wait together. */
	hostModelWaitChanged(counts: Record<string, number>): void {
		this.#deps.services.modelWaitChanged(counts);
	}

	/** This machine's scheduled runs changed: devices showing them (Settings › Schedules on a tab here) follow. */
	hostSchedulesChanged(state: SchedulesState): void {
		this.#deps.services.schedulesChanged(state);
	}

	/** This machine's models.yml changed by itself (a local engine): devices showing its providers read them again. */
	hostModelsChanged(): void {
		this.#deps.services.modelsChanged();
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

	/** This machine's default browser changed: tabs it hosts for devices follow it. */
	hostDefaultBrowserChanged(): void {
		this.#deps.services.syncDefaultBrowser();
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

	/** This machine's credit-use switch changed: tabs it hosts for devices follow it. */
	hostCreditSpendChanged(): void {
		this.#deps.services.syncCreditSpend();
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
		for (const deviceId of [...this.#links.keys()]) this.#unlink(deviceId);
		this.#deps.services.disposeAll();
		await this.#host?.stop();
		this.#host = null;
		await (await this.#sharing.catch(() => null))?.dispose();
	}

	async #startHost(): Promise<void> {
		const sharing = await this.#sharing;
		if (this.#disposed) return;
		if (!this.#host) {
			const host = new RemoteHost({
				sharing,
				services: this.#deps.services,
				name: () => this.deviceName(),
				appVersion: this.#deps.appVersion,
				hello: this.#deps.machineInfo,
				logLink: this.#deps.logLink,
				renameSelf: (name, by) => {
					console.info(`[remote] ${by.name} (${by.deviceId}) renamed this computer to "${name}"`);
					this.setDeviceName(name);
				},
			});
			for (const event of ["peersChanged", "connectionsChanged"] as const) {
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

	/** A link to a known host (`paired`: its record as Connect just wrote it, else the core's last word). */
	#link(deviceId: string, paired = this.#snapshot()?.hosts.find(host => host.deviceId === deviceId)): void {
		const sharing = this.#core;
		if (!paired || !sharing || this.#links.has(deviceId) || this.#disposed) return;
		const client = new RemoteClient({
			identity: this.#identity,
			host: paired,
			appVersion: this.#deps.appVersion,
			name: () => this.deviceName(),
			sharing,
			log: this.#deps.logLink,
		});
		const link: HostLink = {
			client,
			tabs: new Map(),
			closes: new PendingTabCloses(),
			sessions: new HostSessionList(deviceId, {
				read: params => this.request(deviceId, "sessions.list", params),
				broadcast: change => this.#deps.broadcast(IPC_EVENTS.SESSIONS_CHANGED, change),
			}),
			relays: new Map(),
		};
		client.on("state", state => {
			for (const tab of link.tabs.values()) tab.linkStateChanged(state);
			// The agent's tunnel to a host tab's relay ends with the link (the host closes its end as the connection ends).
			if (state !== "online") for (const relay of [...link.relays.values()]) relay.linkLost();
			// What the host worked on is unknown while the link is down: its rows go quiet rather than stay lit.
			if (state !== "online") {
				this.#deps.modelWait?.setHostCounts(deviceId, undefined);
				if (link.summaries) {
					link.summaries = undefined;
					this.#broadcastSummaries(deviceId, OFFLINE_SUMMARIES);
				}
				link.remoteOpened = undefined;
				link.webUrl = undefined;
			}
			this.#broadcastState();
			if (state !== "online") return;
			link.closes.flush(rtab => client.request("tab.close", { rtab }));
			void this.#readSummaries(deviceId, link);
			void this.#readRemoteOpened(link);
			void this.#readWebLink(link);
			// Its session list went stale while it was away (or never loaded).
			link.sessions.stale();
			for (const listener of this.#hostOnline) listener(deviceId);
		});
		client.on("event", (event, data) => {
			if (event === SESSIONS_CHANGED_EVENT) {
				link.sessions.hostChanged(data);
				return;
			}
			if (event === MODEL_WAIT_EVENT) {
				// The host's own count (its account); a malformed one, or none from an older host, leaves this computer's view.
				const counts = ModelWaitCountsSchema.safeParse(data);
				if (counts.success) this.#deps.modelWait?.setHostCounts(deviceId, counts.data.counts);
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
			if (event === MODELS_CHANGED_EVENT) {
				// No data: the windows read the focused tab's catalog and the open list again, which is that host's when a tab of it is focused.
				this.#deps.broadcast(IPC_EVENTS.MODELS_CONFIG_CHANGED, undefined);
				return;
			}
			if (event === SUMMARIES_EVENT) {
				const delta = SummaryDeltaSchema.safeParse(data);
				if (!delta.success || link.client.state !== "online") return;
				const next = applySummaryChange(link.summaries ?? null, delta.data as SummaryDelta);
				// A change made on a version this computer does not hold: it missed one, so it reads the whole set.
				if (!next) {
					void this.#readSummaries(deviceId, link);
					return;
				}
				link.summaries = next;
				this.#broadcastSummaries(deviceId, delta.data as SummaryDelta);
				return;
			}
			if (event === SESSIONS_DELETED_EVENT) {
				const reply = SessionsDeletedReply.safeParse(data);
				if (reply.success) this.#sessionsDeleted(deviceId, reply.data.paths);
				return;
			}
			if (event === REMOTE_OPENED_EVENT) {
				this.#setRemoteOpened(link, data);
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
					for (const listener of this.#hostProjects) listener(deviceId, state.data);
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
			if (event === PREVIEW_RELAY_EVENT) {
				const relay = PreviewRelayEvent.safeParse(data);
				if (relay.success) link.relays.get(relay.data.rtab)?.receive(relay.data);
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

	/**
	 * The host's session summaries, whole: as the link comes up and whenever a change did not apply on the copy here. A
	 * host that does not know the method (an older OMPdesk) sends none, and its section shows no live state.
	 */
	async #readSummaries(deviceId: string, link: HostLink): Promise<void> {
		try {
			const read = VersionedSummariesSchema.safeParse(await link.client.request<unknown>(SUMMARIES_METHOD, {}));
			if (!read.success || link.client.state !== "online") return;
			const next = applySummaryChange(link.summaries ?? null, read.data as VersionedSummaries);
			if (!next || next === link.summaries) return;
			link.summaries = next;
			this.#broadcastSummaries(deviceId, next);
		} catch {
			// unsupported, or the link dropped again: the next push or link-up says it.
		}
	}

	#broadcastSummaries(device: string, change: SummaryDelta | VersionedSummaries): void {
		this.#deps.broadcast(IPC_EVENTS.SESSION_SUMMARIES_CHANGED, { device, change } satisfies SummariesChanged);
	}

	/** A paired host's session summaries as this computer holds them; null while offline or from an older host. */
	summaries(deviceId: string): VersionedSummaries | null {
		const link = this.#links.get(deviceId);
		return link?.client.state === "online" ? (link.summaries ?? null) : null;
	}

	/** The tabs the host's sessions opened on paired devices, as the link comes up; an older host does not know the method. */
	async #readRemoteOpened(link: HostLink): Promise<void> {
		try {
			this.#setRemoteOpened(link, await link.client.request<unknown>(REMOTE_OPENED_METHOD, {}));
		} catch {
			// unsupported, or the link dropped again: the next push or link-up says it.
		}
	}

	/** One the host opened on this computer is marked `here`: it is one of the sessions this computer runs for it. */
	#setRemoteOpened(link: HostLink, data: unknown): void {
		const reply = RemoteOpenedReply.safeParse(data);
		if (!reply.success || link.client.state !== "online") return;
		link.remoteOpened = reply.data.tabs.flatMap(entry => {
			const tab = RemoteOpenedTabSchema.safeParse(entry);
			if (!tab.success) return [];
			const { here: _here, ...facts } = tab.data as RemoteOpenedTab;
			return [facts.device === this.deviceId ? { ...facts, here: true as const } : facts];
		});
		this.#broadcastState();
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
		if (client.state === "online" && link.remoteOpened) view.remoteOpened = link.remoteOpened;
		if (client.state === "online" && link.webUrl) view.webUrl = link.webUrl;
		return view;
	}

	#broadcastState(): RemoteState {
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
