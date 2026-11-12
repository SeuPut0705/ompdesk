/**
 * Computer sharing's devices instance in the core (`crates/core/src/remote/devices/`), as main holds it: the device
 * and host records, Tailscale's side, the host's listener and gate, and each known host's reconnecting client run
 * there. Main mirrors what the core tells (`remote.devices.state`) for its synchronous readers, answers what only it
 * can say (`policy`: Mobile web's allowed accounts and blocks; `admit`: the person's approval; `tailnet`: a test
 * rig's Tailscale), and writes the quota's counts in order (`peerPatch`).
 */
import type { RemoteTailnetPhase, TailnetComputer } from "../../shared/ipc-types";
import { core } from "../core/process";
import type { TailscaleStatus } from "../tailscale/status";
import type { TailnetPeer } from "../tailscale/whois";
import { onCoreAsk } from "./core-asks";
import type { ListenError, TailnetVisitor } from "./host-server";
import type { PairedHost } from "./hosts-store";
import type { Identity } from "./identity";
import type { PeerInfo } from "./peers-store";
import type { Liveness } from "./wire";

/** The parts of the Tailscale side computer sharing reads; `coreId` hands the core its own cached reads (tailnet.ts). */
export interface TailnetAccess {
	status(): Promise<TailscaleStatus | null>;
	phase(): Promise<RemoteTailnetPhase>;
	whois(ip: string): Promise<TailnetPeer | null>;
	coreId?(): Promise<number>;
}

export interface SharingOptions {
	identity: Identity;
	userData: string;
	appVersion: string;
	/** This computer's device name now; later ones through `configure`. */
	name: string;
	tailnet: TailnetAccess;
	/** Mobile web's allowed accounts and whether a node (or its login) is blocked; asked at each connection. */
	policy: (who: { nodeId: string; login: string }) => { allowedUsers: readonly string[]; blocked: boolean };
	/** Whether a new device may be recorded (the person's approval when they asked to be asked). */
	admit: (visitor: TailnetVisitor, name: string) => Promise<boolean>;
	/** Tests only: loopback counts as a tailnet address (`OMP_GUI_TEST_REMOTE_LOOPBACK`). */
	loopback?: boolean;
	/** First port tried; `OMP_GUI_REMOTE_PORT` or 47821 otherwise (address.rs). */
	port?: number;
	/** Tests: ports the system refuses, with its code (`EACCES`). */
	refusePorts?: Record<number, string>;
	/** Tests: the links' ping and dead timers, and how often the traffic line is written. */
	liveness?: Liveness;
	trafficMs?: number;
	/** Count each device link's traffic for the `remote-link` log. */
	traffic?: boolean;
	/** The host's keep-awake policy (keep-awake.ts), driven by the core. */
	keepAwake?: Promise<number>;
	keepAwakeEnabled?: boolean;
	/** Pref `remote.tailnetMigratedAt`; null: code-paired hosts are matched on the first poll. */
	migratedAt?: number | null;
	/** A line in the runtime log (`source: "remote"`). */
	log?: (event: string, details: Record<string, unknown>) => void;
	/** What changed, each time the core tells it. */
	onState?: (snapshot: SharingSnapshot) => void;
	onComputers?: (computers: TailnetComputer[]) => void;
	onAdoptLogin?: (login: string) => void;
	/** Code-paired hosts were matched (or forgotten, `removed`) once. */
	onMigrated?: (migration: { at: number; forgotten: string[]; removed: string[] }) => void;
}

export interface SharingSnapshot {
	phase: RemoteTailnetPhase;
	tailnetName: string | null;
	host: { port: number | null; addresses: string[]; listenError: ListenError | null };
	peers: PeerInfo[];
	hosts: PairedHost[];
	/** The last quota patch the core applied. */
	patched: number;
}

const EMPTY: SharingSnapshot = {
	phase: "not-running",
	tailnetName: null,
	host: { port: null, addresses: [], listenError: null },
	peers: [],
	hosts: [],
	patched: 0,
};

const instances = new Map<number, SharingCore>();
let routed = false;

function route(): void {
	if (routed) return;
	routed = true;
	const process = core();
	process.on("remote.devices.state", data => {
		const { devices, ...snapshot } = data as { devices: number } & SharingSnapshot;
		instances.get(devices)?.told(snapshot);
	});
	process.on("remote.devices.computers", data => {
		const { devices, computers } = data as { devices: number; computers: TailnetComputer[] };
		instances.get(devices)?.options.onComputers?.(computers);
	});
	process.on("remote.devices.adoptLogin", data => {
		const { devices, login } = data as { devices: number; login: string };
		instances.get(devices)?.options.onAdoptLogin?.(login);
	});
	process.on("remote.devices.migrated", data => {
		const { devices, ...migration } = data as { devices: number; at: number; forgotten: string[]; removed: string[] };
		instances.get(devices)?.options.onMigrated?.(migration);
	});
	process.on("remote.log", data => {
		const { host, event, details } = data as { host: number; event: string; details: Record<string, unknown> };
		instances.get(host)?.options.log?.(event, details);
	});
	onCoreAsk("tailnet", async ask => {
		const sharing = instances.get(ask.devices as number);
		if (!sharing) return null;
		const { tailnet } = sharing.options;
		if (ask.op === "whois") return tailnet.whois(String(ask.ip ?? ""));
		if (ask.op === "phase") return tailnet.phase().catch((): RemoteTailnetPhase => "not-running");
		return tailnet.status();
	});
	onCoreAsk("policy", ask => {
		const sharing = instances.get(ask.devices as number);
		if (!sharing) return { allowedUsers: [], blocked: true };
		return sharing.options.policy({ nodeId: String(ask.nodeId), login: String(ask.login) });
	});
	onCoreAsk(
		"admit",
		async ask => {
			const sharing = instances.get(ask.devices as number);
			if (!sharing) return false;
			return sharing.options.admit(ask.visitor as TailnetVisitor, String(ask.name ?? "")).catch(() => false);
		},
		false,
	);
}

export class SharingCore {
	readonly id: number;
	readonly options: SharingOptions;
	#snapshot: SharingSnapshot = EMPTY;

	private constructor(id: number, options: SharingOptions) {
		this.id = id;
		this.options = options;
	}

	static async open(options: SharingOptions): Promise<SharingCore> {
		route();
		const [tailnet, keepAwake] = await Promise.all([options.tailnet.coreId?.(), options.keepAwake]);
		const params = {
			identity: options.identity.deviceId,
			userData: options.userData,
			appVersion: options.appVersion,
			name: options.name,
			loopback: options.loopback === true,
			portSetting: process.env.OMP_GUI_REMOTE_PORT,
			traffic: options.traffic === true,
			keepAwakeEnabled: options.keepAwakeEnabled === true,
			...(options.port !== undefined ? { port: options.port } : {}),
			...(options.refusePorts ? { refuse: options.refusePorts } : {}),
			...(options.liveness ? { liveness: options.liveness } : {}),
			...(options.trafficMs !== undefined ? { trafficMs: options.trafficMs } : {}),
			...(tailnet !== undefined ? { tailnet } : {}),
			...(keepAwake !== undefined ? { keepAwake } : {}),
			...(typeof options.migratedAt === "number" ? { migratedAt: options.migratedAt } : {}),
		};
		const { result } = await core().call<{ devices: number; state: { devices: number } & SharingSnapshot }>(
			"remote.devices.open",
			params,
		);
		const sharing = new SharingCore(result.devices, options);
		const { devices: _id, ...snapshot } = result.state;
		sharing.#snapshot = snapshot;
		instances.set(sharing.id, sharing);
		return sharing;
	}

	/** What the core told last. */
	get snapshot(): SharingSnapshot {
		return this.#snapshot;
	}

	/** A state event from the core. */
	told(snapshot: SharingSnapshot): void {
		this.#snapshot = snapshot;
		this.options.onState?.(snapshot);
	}

	#call<T = unknown>(method: string, params: object = {}, timeoutMs?: number): Promise<T> {
		return core()
			.call<T>(method, { devices: this.id, ...params }, timeoutMs === undefined ? undefined : { timeoutMs })
			.then(answer => answer.result);
	}

	#push(method: string, params: object): void {
		core().push(method, { devices: this.id, ...params });
	}

	/** Forget stale code-paired devices; read Tailscale now and on its poll. */
	start(): Promise<void> {
		return this.#call("remote.devices.start");
	}

	/** One poll now; resolves once it ran. */
	poll(): Promise<void> {
		return this.#call("remote.devices.poll", {}, 60_000);
	}

	/** Start or stop listening as a host; resolves once it listens (or tried) or stopped. */
	setHost(enabled: boolean): Promise<void> {
		return this.#call("remote.devices.setHost", { enabled }, 60_000);
	}

	rebind(): Promise<void> {
		return this.#call("remote.devices.rebind", {}, 60_000);
	}

	watch(watcher: number, on: boolean): Promise<TailnetComputer[]> {
		return this.#call("remote.devices.watch", { watcher, on }, 120_000);
	}

	/** `{host}` once paired, or the code a refusal or failure gave (`tailscale_off`, `unreachable`, a refusal code). */
	connect(
		nodeId: string,
		capabilities: object,
	): Promise<{ host: PairedHost } | { failed: { code: string; message: string } }> {
		return this.#call("remote.devices.connect", { nodeId, capabilities }, 120_000);
	}

	revoke(deviceId: string): Promise<boolean> {
		return this.#call("remote.devices.revoke", { deviceId });
	}

	removeHost(deviceId: string): Promise<void> {
		return this.#call("remote.devices.removeHost", { deviceId });
	}

	peerName(deviceId: string, name: string): Promise<PeerInfo | null> {
		return this.#call("remote.devices.peerName", { deviceId, name });
	}

	configure(patch: { name?: string; loopback?: boolean; keepAwakeEnabled?: boolean; running?: boolean }): void {
		this.#push("remote.devices.configure", patch);
	}

	/** The quota wrote a device's `limits` or `usage` (null removes it): applied in the order sent. */
	peerPatch(seq: number, deviceId: string, patch: Record<string, unknown>): void {
		this.#push("remote.devices.peerPatch", { seq, deviceId, patch });
	}

	wake(trigger: string): void {
		this.#push("remote.devices.wake", { trigger });
	}

	async dispose(): Promise<void> {
		await this.#call("remote.devices.dispose").catch(() => undefined);
		instances.delete(this.id);
	}
}
