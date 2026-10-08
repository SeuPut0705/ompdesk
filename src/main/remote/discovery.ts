/**
 * LAN discovery: an enabled host broadcasts a UDP beacon
 * `{app:"ompdesk", v:1, deviceId, name, port}` every 2 s (no secrets); a client
 * listens while its connect dialog is open. Several instances on one machine
 * share the discovery port (reuseAddr, plus SO_REUSEPORT on macOS when dgram
 * supports it), and a port that stays busy only leaves the listener inactive.
 */
import { createSocket, type Socket, type SocketOptions } from "node:dgram";
import { EventEmitter } from "node:events";
import { networkInterfaces } from "node:os";
import { z } from "zod";
import { discoveryPort, formatAddress } from "./address";

export const BEACON_INTERVAL_MS = 2_000;
const LIMITED_BROADCAST = "255.255.255.255";

const Beacon = z.object({
	app: z.literal("ompdesk"),
	v: z.literal(1),
	deviceId: z.string().min(1).max(64),
	name: z.string().max(256),
	port: z.number().int().min(1).max(65535),
});

export interface BeaconInfo {
	deviceId: string;
	name: string;
	/** The host's TCP port. */
	port: number;
}

export interface DiscoveredHost {
	deviceId: string;
	name: string;
	/** `ip:port` to dial. */
	address: string;
	host: string;
	port: number;
	seenAt: number;
}

/** 255.255.255.255 plus each IPv4 interface's directed broadcast, so every LAN hears it. */
export function broadcastTargets(): string[] {
	const targets = new Set([LIMITED_BROADCAST]);
	for (const addresses of Object.values(networkInterfaces())) {
		for (const info of addresses ?? []) {
			if (info.family !== "IPv4" || info.internal) continue;
			const ip = info.address.split(".").map(Number);
			const mask = info.netmask.split(".").map(Number);
			targets.add(ip.map((octet, i) => (octet | (~(mask[i] ?? 0) & 255)) & 255).join("."));
		}
	}
	return [...targets];
}

function bindSocket(port: number, options: SocketOptions): Promise<Socket> {
	const socket = createSocket(options);
	const { promise, resolve, reject } = Promise.withResolvers<Socket>();
	const onError = (error: Error) => {
		reject(error);
		try {
			socket.close();
		} catch {
			// A socket that never bound may already count as closed.
		}
	};
	socket.once("error", onError);
	socket.bind(port, () => {
		socket.off("error", onError);
		resolve(socket);
	});
	return promise;
}

/** The host's beacon, sent to every broadcast target until `stop()`. */
export class BeaconBroadcaster {
	readonly #port: number;
	readonly #intervalMs: number;
	readonly #targets: () => string[];
	readonly #beacon: () => BeaconInfo;
	#socket: Socket | null = null;
	#timer: NodeJS.Timeout | undefined;
	#starting: Promise<void> | null = null;
	#generation = 0;

	constructor(opts: { beacon: () => BeaconInfo; port?: number; intervalMs?: number; targets?: () => string[] }) {
		this.#beacon = opts.beacon;
		this.#port = opts.port ?? discoveryPort();
		this.#intervalMs = opts.intervalMs ?? BEACON_INTERVAL_MS;
		this.#targets = opts.targets ?? broadcastTargets;
	}

	/** Starts beaconing; a machine without a usable UDP socket just stays silent. */
	start(): Promise<void> {
		this.#starting ??= this.#start(this.#generation);
		return this.#starting;
	}

	async #start(generation: number): Promise<void> {
		let socket: Socket;
		try {
			socket = await bindSocket(0, { type: "udp4" });
			socket.setBroadcast(true);
		} catch {
			return;
		}
		if (generation !== this.#generation) {
			socket.close();
			return;
		}
		// Send failures (no route, interface going down) only cost one beacon.
		socket.on("error", () => {});
		socket.unref();
		this.#socket = socket;
		this.#send();
		this.#timer = setInterval(() => this.#send(), this.#intervalMs);
		this.#timer.unref();
	}

	#send(): void {
		const socket = this.#socket;
		if (!socket) return;
		const payload = Buffer.from(JSON.stringify({ app: "ompdesk", v: 1, ...this.#beacon() }));
		for (const target of this.#targets()) {
			try {
				socket.send(payload, this.#port, target, () => {});
			} catch {
				// A bad port or target throws synchronously; that beacon is just lost.
			}
		}
	}

	stop(): void {
		this.#generation++;
		this.#starting = null;
		clearInterval(this.#timer);
		this.#socket?.close();
		this.#socket = null;
	}
}

/** Receives host beacons on the discovery port while started. */
export class BeaconListener {
	readonly #port: number;
	readonly #ignoreDeviceId: string | undefined;
	readonly #emitter = new EventEmitter();
	#socket: Socket | null = null;
	#starting: Promise<boolean> | null = null;
	#generation = 0;

	constructor(opts: { port?: number; ignoreDeviceId?: string } = {}) {
		this.#port = opts.port ?? discoveryPort();
		this.#ignoreDeviceId = opts.ignoreDeviceId;
	}

	on(event: "beacon", fn: (host: DiscoveredHost) => void): void {
		this.#emitter.on(event, fn);
	}

	off(event: "beacon", fn: (host: DiscoveredHost) => void): void {
		this.#emitter.off(event, fn);
	}

	/** Resolves true once listening, false when the port stays busy. */
	start(): Promise<boolean> {
		this.#starting ??= this.#start(this.#generation);
		return this.#starting;
	}

	async #start(generation: number): Promise<boolean> {
		// libuv sets SO_REUSEPORT for reuseAddr on macOS; dgram's own reusePort
		// is newer and rejects at bind where unsupported, so it falls back.
		const attempts: SocketOptions[] =
			process.platform === "darwin"
				? [
						{ type: "udp4", reuseAddr: true, reusePort: true },
						{ type: "udp4", reuseAddr: true },
					]
				: [{ type: "udp4", reuseAddr: true }];
		for (const options of attempts) {
			let socket: Socket;
			try {
				socket = await bindSocket(this.#port, options);
			} catch {
				continue;
			}
			if (generation !== this.#generation) {
				socket.close();
				return false;
			}
			socket.on("error", () => {});
			socket.on("message", (message, rinfo) => this.#receive(message, rinfo.address));
			socket.unref();
			this.#socket = socket;
			return true;
		}
		return false;
	}

	#receive(message: Buffer, from: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(message.toString("utf8"));
		} catch {
			return;
		}
		const beacon = Beacon.safeParse(parsed);
		if (!beacon.success || beacon.data.deviceId === this.#ignoreDeviceId) return;
		const { deviceId, name, port } = beacon.data;
		const host: DiscoveredHost = {
			deviceId,
			name,
			address: formatAddress({ host: from, port }),
			host: from,
			port,
			seenAt: Date.now(),
		};
		this.#emitter.emit("beacon", host);
	}

	stop(): void {
		this.#generation++;
		this.#starting = null;
		this.#socket?.close();
		this.#socket = null;
	}
}
