/**
 * Agent browsing for a paired device's Preview page (`host.previewRelay.*`, app-protocol.ts). The tab's omp runs on this
 * computer, so stock's browser relay (`browser_relay_start`) listens on THIS computer's loopback, out of the device's
 * reach. The device's page is the one the agent drives, so the relay's extension socket is carried over the link: this
 * file remembers what each tab's bridge answered and dials exactly that, never an address a device names. The socket
 * itself is the core's (`remotebytes/relay.rs`); which tab holds which socket, and for which link connection, stays
 * here, because `RemoteHostServices` reads it in the same tick (`has`, `dropConnection`).
 */
import { codedError } from "../../shared/ipc-error-codes";
import { core } from "../core/process";
import { relayExtensionUrl } from "../preview/agent-relay";
import type { PreviewRelayEvent } from "./app-protocol";

/** What the core says of an open socket: a frame the relay sent, or the socket's end. */
type SocketEvent = { kind: "message"; data: string } | { kind: "close" };

interface Tunnel {
	/** The relay's extension endpoint (`ws://127.0.0.1:<port>/ext?token=…`), as the tab's own bridge answered it. */
	target: string;
	/** The core's socket to it, while one is open or opening. */
	socket?: number;
	/** Whether that socket finished opening (a frame sent before is refused, as on a connecting WebSocket). */
	open?: boolean;
	/** The link connection the open socket's frames go to. */
	owner?: object;
}

/** Sends an event to the connection that opened the tunnel; false when it did not go out (a frame over the cap). */
export type RelayPush = (event: PreviewRelayEvent) => boolean;

const sockets = new Map<number, (event: SocketEvent) => void>();
let nextSocket = 0;
let routed = false;

function route(): void {
	if (routed) return;
	routed = true;
	core().on("remotebytes.relay", data => {
		const { socket, ...event } = data as { socket: number } & SocketEvent;
		sockets.get(socket)?.(event);
	});
}

export class PreviewRelayTunnels {
	readonly #tunnels = new Map<string, Tunnel>();

	has(key: string): boolean {
		return this.#tunnels.has(key);
	}

	/** `browser_relay_start` answered `data` on the tab `key`: what its bridge returned is what a later open dials. */
	remember(key: string, data: unknown): void {
		this.close(key);
		const reply = data && typeof data === "object" ? (data as { url?: unknown; token?: unknown }) : {};
		const target =
			typeof reply.url === "string" && typeof reply.token === "string"
				? relayExtensionUrl(reply.url, reply.token)
				: null;
		if (target) this.#tunnels.set(key, { target });
		else this.#tunnels.delete(key);
	}

	/** The tab's relay stopped, or the tab went: close its socket and forget the endpoint. */
	forget(key: string): void {
		this.close(key);
		this.#tunnels.delete(key);
	}

	/** Dial the remembered relay for the tab `key`; resolves once its socket is open. */
	async open(key: string, rtab: string, owner: object, push: RelayPush): Promise<void> {
		const tunnel = this.#tunnels.get(key);
		if (!tunnel) throw codedError("relay_unavailable", "This tab has no browser relay running");
		this.close(key);
		route();
		const socket = ++nextSocket;
		tunnel.socket = socket;
		tunnel.owner = owner;
		// What the core says before this call is answered waits for it, as a WebSocket's events wait for its `open`.
		const early: SocketEvent[] = [];
		let waiting = true;
		const receive = (event: SocketEvent) => {
			if (waiting) {
				early.push(event);
				return;
			}
			if (tunnel.socket !== socket) return;
			if (event.kind === "close") {
				sockets.delete(socket);
				tunnel.socket = tunnel.owner = tunnel.open = undefined;
				push({ kind: "close", rtab });
				// A frame the link cannot carry would leave the agent waiting for its answer: end the tunnel instead.
			} else if (!push({ kind: "message", rtab, data: event.data })) this.close(key, push, rtab);
		};
		sockets.set(socket, receive);
		try {
			await core().call("remotebytes.relayOpen", { socket, target: tunnel.target });
		} catch {
			sockets.delete(socket);
			if (tunnel.socket === socket) tunnel.socket = tunnel.owner = undefined;
			throw codedError("relay_unavailable", "The browser relay did not answer");
		}
		waiting = false;
		if (tunnel.socket === socket) tunnel.open = true;
		for (const event of early.splice(0)) receive(event);
	}

	/** One text frame from the device's extension to the relay. */
	send(key: string, data: string): void {
		const tunnel = this.#tunnels.get(key);
		if (tunnel?.socket === undefined || !tunnel.open)
			throw codedError("relay_unavailable", "The browser relay is not open");
		core().push("remotebytes.relaySend", { socket: tunnel.socket, data });
	}

	/** Close the open socket (the endpoint stays remembered while the tab's relay runs); `push` tells the device. */
	close(key: string, push?: RelayPush, rtab?: string): void {
		const tunnel = this.#tunnels.get(key);
		const socket = tunnel?.socket;
		if (!tunnel || socket === undefined) return;
		tunnel.socket = tunnel.owner = tunnel.open = undefined;
		sockets.delete(socket);
		core().push("remotebytes.relayClose", { socket });
		if (push && rtab) push({ kind: "close", rtab });
	}

	/** A link connection ended: the keys of the tunnels it held open (closed here, their relays still to stop). */
	dropConnection(owner: object): string[] {
		const dropped: string[] = [];
		for (const [key, tunnel] of this.#tunnels) {
			if (tunnel.owner !== owner || tunnel.socket === undefined) continue;
			this.close(key);
			dropped.push(key);
		}
		return dropped;
	}

	dispose(): void {
		for (const key of [...this.#tunnels.keys()]) this.forget(key);
	}
}
