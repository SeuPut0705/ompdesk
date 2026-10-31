/**
 * The device's end of agent browsing's tunnel (`host.previewRelay.*`, app-protocol.ts): a `RelaySocket` whose frames
 * cross the paired link to the relay the host's tab started (`PreviewRelayTunnels` there dials it). The preview host
 * (preview/host.ts) runs the same relay extension over it as over a loopback socket.
 */
import type { RelaySocket } from "../preview/relay-socket";
import { PREVIEW_RELAY_METHODS, type PreviewRelayEvent } from "./app-protocol";

/** What the tunnel needs of the host's link: one request. Failures are the link's own errors. */
export interface RelayRequester {
	request<T>(method: string, params: unknown): Promise<T>;
}

export class LinkRelaySocket implements RelaySocket {
	readonly ready: Promise<void>;
	readonly #link: RelayRequester;
	readonly #rtab: string;
	readonly #ended: () => void;
	readonly #messageListeners: Array<(data: string) => void> = [];
	readonly #closeListeners: Array<() => void> = [];
	readonly #opened = Promise.withResolvers<void>();
	#open = false;
	#closed = false;

	/** Asks the host to dial the tab's relay at once; `ended` runs once, when the socket is over (the owner forgets it). */
	constructor(link: RelayRequester, rtab: string, ended: () => void) {
		this.#link = link;
		this.#rtab = rtab;
		this.#ended = ended;
		// The owner awaits `ready`; one that closed the socket first never reads a rejection.
		this.ready = this.#opened.promise;
		this.ready.catch(() => {});
		link.request(PREVIEW_RELAY_METHODS.open, { rtab }).then(
			() => {
				if (this.#closed) return;
				this.#open = true;
				this.#opened.resolve();
			},
			(error: unknown) => this.#end(true, error),
		);
	}

	get isOpen(): boolean {
		return this.#open;
	}

	send(data: string): void {
		if (!this.#open) throw new Error("The browser relay is not open");
		this.#link
			.request(PREVIEW_RELAY_METHODS.send, { rtab: this.#rtab, data })
			.catch((error: unknown) => this.#end(true, error));
	}

	close(): void {
		this.#end(true, new Error("The browser relay closed"));
	}

	onMessage(listener: (data: string) => void): void {
		this.#messageListeners.push(listener);
	}

	onClose(listener: () => void): void {
		this.#closeListeners.push(listener);
	}

	/** What the host pushed for this tab: a frame the relay sent, or the relay socket's end. */
	receive(event: PreviewRelayEvent): void {
		if (this.#closed) return;
		if (event.kind === "message") for (const listener of this.#messageListeners) listener(event.data);
		else this.#end(false, new Error("The browser relay closed"));
	}

	/** The link dropped: the host closes its end on the connection ending. */
	linkLost(): void {
		this.#end(false, new Error("The link to the host dropped"));
	}

	#end(tellHost: boolean, reason: unknown): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#open = false;
		this.#opened.reject(reason);
		if (tellHost) this.#link.request(PREVIEW_RELAY_METHODS.close, { rtab: this.#rtab }).catch(() => {});
		for (const listener of this.#closeListeners) listener();
		this.#ended();
	}
}
