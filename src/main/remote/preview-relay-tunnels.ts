/**
 * Agent browsing for a paired device's Preview page (`host.previewRelay.*`, app-protocol.ts). The tab's omp runs on this
 * computer, so stock's browser relay (`browser_relay_start`) listens on THIS computer's loopback, out of the device's
 * reach. The device's page is the one the agent drives, so the relay's extension socket is carried over the link: this
 * file remembers what each tab's bridge answered and dials exactly that, never an address a device names.
 */
import { codedError } from "../../shared/ipc-error-codes";
import { relayExtensionUrl } from "../preview/agent-relay";
import type { PreviewRelayEvent } from "./app-protocol";

interface Tunnel {
	/** The relay's extension endpoint (`ws://127.0.0.1:<port>/ext?token=…`), as the tab's own bridge answered it. */
	target: string;
	socket?: WebSocket;
	/** The link connection the open socket's frames go to. */
	owner?: object;
}

/** Sends an event to the connection that opened the tunnel; false when it did not go out (a frame over the cap). */
export type RelayPush = (event: PreviewRelayEvent) => boolean;

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
		const socket = new WebSocket(tunnel.target);
		tunnel.socket = socket;
		tunnel.owner = owner;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const failed = () => reject(codedError("relay_unavailable", "The browser relay did not answer"));
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", failed, { once: true });
		socket.addEventListener("close", failed, { once: true });
		try {
			await promise;
		} catch (error) {
			if (tunnel.socket === socket) tunnel.socket = tunnel.owner = undefined;
			throw error;
		}
		socket.addEventListener("message", message => {
			if (tunnel.socket !== socket) return;
			// A frame the link cannot carry would leave the agent waiting for its answer: end the tunnel instead.
			if (!push({ kind: "message", rtab, data: String(message.data) })) this.close(key, push, rtab);
		});
		socket.addEventListener("close", () => {
			if (tunnel.socket !== socket) return;
			tunnel.socket = tunnel.owner = undefined;
			push({ kind: "close", rtab });
		});
	}

	/** One text frame from the device's extension to the relay. */
	send(key: string, data: string): void {
		const socket = this.#tunnels.get(key)?.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN)
			throw codedError("relay_unavailable", "The browser relay is not open");
		socket.send(data);
	}

	/** Close the open socket (the endpoint stays remembered while the tab's relay runs); `push` tells the device. */
	close(key: string, push?: RelayPush, rtab?: string): void {
		const tunnel = this.#tunnels.get(key);
		const socket = tunnel?.socket;
		if (!tunnel || !socket) return;
		tunnel.socket = tunnel.owner = undefined;
		socket.close();
		if (push && rtab) push({ kind: "close", rtab });
	}

	/** A link connection ended: the keys of the tunnels it held open (closed here, their relays still to stop). */
	dropConnection(owner: object): string[] {
		const dropped: string[] = [];
		for (const [key, tunnel] of this.#tunnels) {
			if (tunnel.owner !== owner || !tunnel.socket) continue;
			this.close(key);
			dropped.push(key);
		}
		return dropped;
	}

	dispose(): void {
		for (const key of [...this.#tunnels.keys()]) this.forget(key);
	}
}
