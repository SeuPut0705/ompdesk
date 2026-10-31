/**
 * The agent's relay as the preview host sees it: one text-frame socket to stock's browser relay. A tab on this computer
 * dials the relay's loopback address (`localRelaySocket`); a tab on a paired host reaches the relay over the link
 * (`LinkRelaySocket`, remote/link-relay-socket.ts). `agentStart` (host.ts) runs the same code over either.
 */
export interface RelaySocket {
	/** Resolves once frames may be sent; rejects when the relay cannot be reached or closes first. */
	readonly ready: Promise<void>;
	readonly isOpen: boolean;
	send(data: string): void;
	close(): void;
	onMessage(listener: (data: string) => void): void;
	onClose(listener: () => void): void;
}

/** A tab on this computer: stock's relay on its loopback port (`relayExtensionUrl` has vetted `target`). */
export function localRelaySocket(target: string): RelaySocket {
	const socket = new WebSocket(target);
	const { promise: ready, resolve, reject } = Promise.withResolvers<void>();
	// Nobody may be awaiting `ready` when it rejects (the socket closes before agentStart's await returns).
	ready.catch(() => {});
	socket.addEventListener("open", () => resolve(), { once: true });
	socket.addEventListener("error", () => reject(new Error("The browser relay did not answer")), { once: true });
	socket.addEventListener("close", () => reject(new Error("The browser relay closed")), { once: true });
	return {
		ready,
		get isOpen() {
			return socket.readyState === WebSocket.OPEN;
		},
		send: data => socket.send(data),
		close: () => socket.close(),
		onMessage: listener => socket.addEventListener("message", message => listener(String(message.data))),
		onClose: listener => socket.addEventListener("close", () => listener()),
	};
}
