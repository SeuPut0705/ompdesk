/**
 * Computer sharing's devices instance in the core (`crates/core/src/remote/devices/`), as main holds it: the device
 * and host records, Tailscale's side, the host's listener and gate, and each known host's reconnecting client run
 * there. Main mirrors what the core tells (`remote.devices.state`) for its synchronous readers, answers what only it
 * can say (`policy`: Mobile web's allowed accounts and blocks; `admit`: the person's approval; `tailnet`: a test
 * rig's Tailscale), and writes the quota's counts in order (`peerPatch`).
 */
import type { RemoteTailnetPhase, TailnetComputer } from "../../shared/ipc-types";
import { CORE_EXITED, CoreError, core } from "../core/process";
import { openAgain } from "../core/reopen";
import type { TailscaleStatus } from "../tailscale/status";
import type { TailnetPeer } from "../tailscale/whois";
import { onCoreAsk } from "./core-asks";
import type { ListenError, TailnetVisitor } from "./host-server";
import type { PairedHost } from "./hosts-store";
import { type Identity, loadIdentity } from "./identity";
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
	/** The host's keep-awake policy (keep-awake.ts), driven by the core; asked again for each instance opened. */
	keepAwake?: () => Promise<number>;
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
	/** The instance opened again in a new core, after it ended: what main wrote to the old one may need writing again. */
	onReopened?: () => void;
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
		instances.get(devices)?.migrated(migration);
	});
	// The instances' numbers died with the core: each opens again in the next one, under a new number.
	process.on(CORE_EXITED, () => {
		const lost = [...instances.values()];
		instances.clear();
		for (const sharing of lost) sharing.lost();
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
	// No answer (an instance gone, a policy that threw) is refused at the gate (`protocol`), never read as an unset list.
	onCoreAsk(
		"policy",
		ask => {
			const sharing = instances.get(ask.devices as number);
			return sharing ? sharing.options.policy({ nodeId: String(ask.nodeId), login: String(ask.login) }) : null;
		},
		null,
	);
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

/** The core's instance as the core that runs it numbers it: a request to it names both, so a later core never hears it. */
interface Opened {
	devices: number;
	generation: number;
}

interface OpenedAnswer {
	devices: number;
	state: { devices: number } & SharingSnapshot;
}

/** What a devices instance was told since it opened: a core that opens it again is brought to the same. */
interface Settings {
	name: string;
	loopback: boolean;
	keepAwakeEnabled: boolean;
	running?: boolean;
}

export class SharingCore {
	readonly options: SharingOptions;
	#id = 0;
	#snapshot: SharingSnapshot = EMPTY;
	/** The open instance; while the core that held it is replaced, the one the next core is giving. */
	#opened: Promise<Opened>;
	/** The instance as the core running now holds it; null while it is not open (before the first answer, or after a loss). */
	#ready: Opened | null = null;
	/** Bumped by every loss, so an attempt to open again that a later loss superseded gives up. */
	#epoch = 0;
	#disposed = false;
	/** An attempt to open again is running (the next core may take a while to start). */
	#reopening = false;
	readonly #settings: Settings;
	#migratedAt: number | null;
	#started = false;
	#hostEnabled = false;
	readonly #watchers = new Set<number>();

	private constructor(options: SharingOptions) {
		this.options = options;
		this.#settings = {
			name: options.name,
			loopback: options.loopback === true,
			keepAwakeEnabled: options.keepAwakeEnabled === true,
		};
		this.#migratedAt = typeof options.migratedAt === "number" ? options.migratedAt : null;
		this.#opened = this.#openInCore().then(opened => this.#adopt(opened));
	}

	static async open(options: SharingOptions): Promise<SharingCore> {
		route();
		const sharing = new SharingCore(options);
		await sharing.#opened;
		return sharing;
	}

	/** The instance's number in the core running now; changes when the core ends and it opens again. */
	get id(): number {
		return this.#id;
	}

	/** Resolves with the instance's number once it is open in the core that runs now (again after a core ended). */
	async opened(): Promise<number> {
		return (await this.#opened).devices;
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

	/** Code-paired hosts were matched once: a core that opens this again must not match them again. */
	migrated(migration: { at: number; forgotten: string[]; removed: string[] }): void {
		this.#migratedAt = migration.at;
		this.options.onMigrated?.(migration);
	}

	async #openInCore(): Promise<OpenedAnswer & { generation: number }> {
		const { options } = this;
		// Asked now, not at construction: the Tailscale and keep-awake instances this one uses open again by themselves.
		const [tailnet, keepAwake] = await Promise.all([options.tailnet.coreId?.(), options.keepAwake?.()]);
		const params = {
			identity: options.identity.deviceId,
			userData: options.userData,
			appVersion: options.appVersion,
			name: this.#settings.name,
			loopback: this.#settings.loopback,
			portSetting: process.env.OMP_GUI_REMOTE_PORT,
			traffic: options.traffic === true,
			keepAwakeEnabled: this.#settings.keepAwakeEnabled,
			...(options.port !== undefined ? { port: options.port } : {}),
			...(options.refusePorts ? { refuse: options.refusePorts } : {}),
			...(options.liveness ? { liveness: options.liveness } : {}),
			...(options.trafficMs !== undefined ? { trafficMs: options.trafficMs } : {}),
			...(tailnet !== undefined ? { tailnet } : {}),
			...(keepAwake !== undefined ? { keepAwake } : {}),
			...(this.#migratedAt !== null ? { migratedAt: this.#migratedAt } : {}),
		};
		const { result, generation } = await core().call<OpenedAnswer>("remote.devices.open", params);
		return { ...result, generation };
	}

	/** The core's instance is this one from now on: its events and questions reach it by that number. */
	#adopt(answer: OpenedAnswer & { generation: number }): Opened {
		const { devices: _id, ...snapshot } = answer.state;
		this.#id = answer.devices;
		this.#snapshot = snapshot;
		instances.set(this.#id, this);
		this.#ready = { devices: answer.devices, generation: answer.generation };
		return this.#ready;
	}

	/**
	 * The core ended and took the instance with it: its listener, its poll and every client's loop are gone, and the
	 * records on disk are what the next core reads. Opens it again there and tells it what this one had been told.
	 */
	lost(): void {
		if (this.#disposed) return;
		const epoch = ++this.#epoch;
		// Nothing listens while there is no core, and the number it had names no instance in the next one.
		this.#id = 0;
		this.#ready = null;
		this.#snapshot = { ...this.#snapshot, host: EMPTY.host };
		this.options.onState?.(this.#snapshot);
		this.#reopening = true;
		this.#opened = this.#reopen(epoch);
		this.#opened.catch(() => undefined);
	}

	async #reopen(epoch: number): Promise<Opened> {
		try {
			// The same exit has other listeners (the Tailscale and keep-awake instances forget their numbers): they have
			// run by the next turn.
			await Promise.resolve();
			const wanted = () => !this.#disposed && epoch === this.#epoch;
			const answer = await openAgain(async () => {
				// The core held this computer's private key; the next one reads it from its file.
				await loadIdentity(this.options.userData);
				return this.#openInCore();
			}, wanted);
			if (!answer) throw new CoreError("core_exited", "the devices instance was closed before it opened again");
			const opened = { devices: answer.devices, generation: answer.generation };
			if (!wanted()) {
				// A later loss or a dispose took over: this one belongs to a core that may still be running.
				void this.#callIn(opened, "remote.devices.dispose").catch(() => undefined);
				throw new CoreError("core_exited", "the devices instance opened again for nothing");
			}
			this.#adopt(answer);
			this.options.onState?.(this.#snapshot);
			this.#restore(opened);
			return opened;
		} finally {
			if (epoch === this.#epoch) this.#reopening = false;
		}
	}

	/** What was told the instance before, again: its settings, its poll, its listener, the views watching the tailnet. */
	#restore(opened: Opened): void {
		const failed = (what: string) => (error: unknown) =>
			this.options.log?.("restore-failed", { what, error: error instanceof Error ? error.message : String(error) });
		if (this.#settings.running !== undefined)
			this.#pushIn(opened, "remote.devices.configure", { running: this.#settings.running });
		if (this.#started) void this.#callIn(opened, "remote.devices.start").catch(failed("start"));
		if (this.#hostEnabled)
			void this.#callIn(opened, "remote.devices.setHost", { enabled: true }, 60_000).catch(failed("host"));
		for (const watcher of this.#watchers) {
			void this.#callIn<TailnetComputer[]>(opened, "remote.devices.watch", { watcher, on: true }, 120_000).then(
				computers => this.options.onComputers?.(computers),
				failed("watch"),
			);
		}
		this.options.onReopened?.();
	}

	#callIn<T = unknown>(opened: Opened, method: string, params: object = {}, timeoutMs?: number): Promise<T> {
		return core()
			.call<T>(
				method,
				{ devices: opened.devices, ...params },
				{ generation: opened.generation, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
			)
			.then(answer => answer.result);
	}

	#pushIn(opened: Opened, method: string, params: object): void {
		if (core().generation === opened.generation) core().push(method, { devices: opened.devices, ...params });
	}

	/** At once while the instance is open, so a push or call keeps its place beside the caller's other calls to the core. */
	#call<T = unknown>(method: string, params: object = {}, timeoutMs?: number): Promise<T> {
		const ready = this.#ready;
		if (ready) return this.#callIn<T>(ready, method, params, timeoutMs);
		return this.#opened.then(opened => this.#callIn<T>(opened, method, params, timeoutMs));
	}

	#push(method: string, params: object): void {
		const ready = this.#ready;
		if (ready) this.#pushIn(ready, method, params);
		else
			void this.#opened.then(
				opened => this.#pushIn(opened, method, params),
				() => undefined,
			);
	}

	/** Forget stale code-paired devices; read Tailscale now and on its poll. */
	start(): Promise<void> {
		this.#started = true;
		return this.#call("remote.devices.start");
	}

	/** One poll now; resolves once it ran. */
	poll(): Promise<void> {
		return this.#call("remote.devices.poll", {}, 60_000);
	}

	/** Start or stop listening as a host; resolves once it listens (or tried) or stopped. */
	setHost(enabled: boolean): Promise<void> {
		this.#hostEnabled = enabled;
		return this.#call("remote.devices.setHost", { enabled }, 60_000);
	}

	rebind(): Promise<void> {
		return this.#call("remote.devices.rebind", {}, 60_000);
	}

	watch(watcher: number, on: boolean): Promise<TailnetComputer[]> {
		if (on) this.#watchers.add(watcher);
		else this.#watchers.delete(watcher);
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

	configure(patch: Partial<Settings>): void {
		Object.assign(this.#settings, patch);
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
		// A core that ends from here on is not given another instance.
		this.#disposed = true;
		// One still opening again gives its instance back itself (`#reopen`), however long the next core takes.
		const opened = this.#reopening ? null : await this.#opened.catch(() => null);
		if (opened) await this.#callIn(opened, "remote.devices.dispose").catch(() => undefined);
		if (instances.get(this.#id) === this) instances.delete(this.#id);
		this.#id = 0;
		this.#ready = null;
	}
}
