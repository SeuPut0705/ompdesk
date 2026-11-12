/**
 * Main's side of the core's web stores for one `userData` (`native/ompdesk/crates/core/src/web/store.rs`): the
 * paired devices (`web-devices.json`) and the blocks (`web-blocked.json`) live in the core, which the web edge reads
 * and changes too. Main keeps a copy for the callers that read in the same tick (`WebDevices.get`, `PeerQuota`, the
 * computer-sharing gate's `WebBlocks.check`), changes it at once when it makes a change, and sends the change to the
 * core as an ordered push. The core answers every push with the whole list and the number of the last push it applied
 * (`ack`), and tells every change of its own (a device the edge paired, one it expired) the same way.
 *
 * A snapshot replaces the copy only when it is newer than the last one seen (`version`) and holds every change main
 * made (`ack` reaches the last push's number), so a list the core sent before it saw main's change never undoes it.
 * A core that was restarted lost the pushes it had not applied: the snapshot its `web.devices.open` answers is the
 * truth for everything sent before that request.
 */
import type { WebBlockedInfo } from "../../shared/mobile-web";
import { core } from "../core/process";
import type { WebDevice } from "./devices-store";

interface Snapshot<T> {
	list: T[];
	version: number;
	ack: number;
}

interface Opened {
	devices: Snapshot<WebDevice>;
	blocks: Snapshot<WebBlockedInfo>;
}

interface Told {
	userData: string;
}

/** One store's copy and what it needs to take a snapshot of the core's. */
class Lane<T> {
	list: T[] = [];
	/** The number of the last push main sent. */
	seq = 0;
	/** Pushes up to here are settled without an `ack`: they were sent before the open request of the current core. */
	#floor = 0;
	#version = 0;
	#loaded = false;
	/** The newest snapshot an event brought before the open request's answer. */
	#held: Snapshot<T> | null = null;

	/** A new core: nothing of the old one's version counts, and what was pushed to it is settled by the next open. */
	reset(): void {
		this.#loaded = false;
		this.#version = 0;
		this.#held = null;
		this.#floor = this.seq;
	}

	/** The snapshot of an event; whether the copy took it. */
	offer(snapshot: Snapshot<T>): boolean {
		if (!this.#loaded) {
			if (!this.#held || snapshot.version > this.#held.version) this.#held = snapshot;
			return false;
		}
		return this.#take(snapshot);
	}

	/** The snapshot `web.devices.open` answered; `sentBefore` is the last push number sent before that request. */
	load(snapshot: Snapshot<T>, sentBefore: number): void {
		this.#floor = Math.max(this.#floor, sentBefore);
		this.#loaded = true;
		this.#version = 0;
		this.#take(snapshot);
		const held = this.#held;
		this.#held = null;
		if (held) this.#take(held);
	}

	#take(snapshot: Snapshot<T>): boolean {
		if (snapshot.version <= this.#version) return false;
		this.#version = snapshot.version;
		if (Math.max(snapshot.ack, this.#floor) < this.seq) return false;
		this.list = snapshot.list;
		return true;
	}
}

type DevicesChanged = Told & { devices: WebDevice[]; version: number; ack: number; notify: boolean };
type DevicesRevoked = Told & { deviceId: string };
type BlocksChanged = Told & { blocks: WebBlockedInfo[]; version: number; ack: number };

export class StoresChannel {
	readonly userData: string;
	readonly devices = new Lane<WebDevice>();
	readonly blocks = new Lane<WebBlockedInfo>();
	readonly revokedListeners = new Set<(deviceId: string) => void>();
	readonly devicesListeners = new Set<() => void>();
	readonly blocksListeners = new Set<() => void>();
	#references = 0;
	#opening: Promise<void> | null = null;
	#opened = false;

	constructor(userData: string) {
		this.userData = userData;
	}

	retain(): void {
		this.#references++;
	}

	/** Whether this was the last holder; the caller then drops the channel. */
	release(): boolean {
		return --this.#references <= 0;
	}

	/** Resolves once the core's lists are in the copy. A failed open is tried again by the next call. */
	ready(): Promise<void> {
		this.#opening ??= this.#open().catch(error => {
			this.#opening = null;
			throw error;
		});
		return this.#opening;
	}

	async #open(): Promise<void> {
		const sentBefore = { devices: this.devices.seq, blocks: this.blocks.seq };
		const { result } = await core().call<Opened>("web.devices.open", { userData: this.userData });
		this.devices.load(result.devices, sentBefore.devices);
		this.blocks.load(result.blocks, sentBefore.blocks);
		this.#opened = true;
	}

	/** Resolves once every change made before this call is on disk. */
	async flush(): Promise<void> {
		await core().call("web.devices.flush", { userData: this.userData });
	}

	pushDevices(method: string, params: Record<string, unknown>): void {
		this.#push(this.devices, `web.devices.${method}`, params);
	}

	pushBlocks(method: string, params: Record<string, unknown>): void {
		this.#push(this.blocks, `web.blocks.${method}`, params);
	}

	#push(lane: Lane<unknown>, method: string, params: Record<string, unknown>): void {
		const seq = ++lane.seq;
		try {
			core().push(method, { userData: this.userData, seq, ...params });
		} catch (error) {
			// Nothing was sent: the core cannot be started now. The copy keeps the change; the next open replaces it.
			lane.seq = seq - 1;
			console.error(`[web] couldn't send ${method} to ompdesk-core:`, error);
		}
	}

	devicesChanged(told: DevicesChanged): void {
		this.devices.offer({ list: told.devices, version: told.version, ack: told.ack });
		if (told.notify) for (const listener of [...this.devicesListeners]) listener();
	}

	deviceRevoked(deviceId: string): void {
		// A device main removed itself is gone from the copy already, and its listeners have run.
		const before = this.devices.list.length;
		this.devices.list = this.devices.list.filter(device => device.deviceId !== deviceId);
		if (this.devices.list.length === before) return;
		for (const listener of [...this.revokedListeners]) listener(deviceId);
	}

	blocksChanged(told: BlocksChanged): void {
		this.blocks.offer({ list: told.blocks, version: told.version, ack: told.ack });
	}

	/** A core started after the one this opened against (it crashed, or was stopped): open against the new one. */
	coreStarted(): void {
		if (!this.#opened) return;
		this.devices.reset();
		this.blocks.reset();
		this.#opening = this.#open().catch(error => {
			this.#opening = null;
			console.error("[web] couldn't open the web stores in ompdesk-core:", error);
		});
	}
}

const channels = new Map<string, StoresChannel>();
let subscribed = false;

function subscribe(): void {
	if (subscribed) return;
	subscribed = true;
	const host = core();
	host.on("web.devices.changed", data =>
		channels.get((data as Told).userData)?.devicesChanged(data as DevicesChanged),
	);
	host.on("web.devices.revoked", data =>
		channels.get((data as Told).userData)?.deviceRevoked((data as DevicesRevoked).deviceId),
	);
	host.on("web.blocks.changed", data => channels.get((data as Told).userData)?.blocksChanged(data as BlocksChanged));
	host.on("ready", () => {
		for (const channel of channels.values()) channel.coreStarted();
	});
}

/** The channel of `userData`, the same one for every holder in this process. Give it back with `releaseChannel`. */
export function acquireChannel(userData: string): StoresChannel {
	subscribe();
	let channel = channels.get(userData);
	if (!channel) {
		channel = new StoresChannel(userData);
		channels.set(userData, channel);
	}
	channel.retain();
	return channel;
}

export function releaseChannel(channel: StoresChannel): void {
	if (channel.release()) channels.delete(channel.userData);
}
