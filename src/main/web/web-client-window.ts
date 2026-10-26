/**
 * A paired web device's virtual window. The sidecar pool, the window records and the IPC handlers see it as
 * any `ClientWindow` with a negative id; what main sends it goes to the device's sockets (`deliver`), and a
 * call from the device runs with it as the caller. It outlives the socket: a dropped connection leaves it
 * parked, so the tabs it owns and the turns they run carry on, and the page finds them again on reconnect.
 * Only revoking the device destroys it (`closed` makes the pool release its tabs).
 */
import { EventEmitter } from "node:events";
import type { ClientWindow } from "./client-window";
import type { IpcCaller, IpcSender } from "./ipc-registry";

/** Where a window's pushes go: the device's connections (ws-router.ts). */
export type WindowDelivery = (deviceId: string, channel: string, payload: unknown) => void;

export class WebClientWindow implements ClientWindow {
	readonly deviceId: string;
	readonly webContents: IpcSender & { send(channel: string, ...args: unknown[]): void };
	readonly #events = new EventEmitter();
	#destroyed = false;

	constructor(deviceId: string, id: number, deliver: WindowDelivery) {
		this.deviceId = deviceId;
		const events = this.#events;
		this.webContents = {
			id,
			// Every push the pool makes carries one payload; a second argument would ride as an array.
			send: (channel, ...args) => {
				if (!this.#destroyed) deliver(deviceId, channel, args.length > 1 ? args : args[0]);
			},
			once: (event, listener) => events.once(event, listener),
		};
	}

	isDestroyed(): boolean {
		return this.#destroyed;
	}

	once(event: "closed", listener: () => void): this {
		this.#events.once(event, listener);
		return this;
	}

	removeListener(event: "closed", listener: () => void): this {
		this.#events.removeListener(event, listener);
		return this;
	}

	/** The device is gone: owners release the tabs, handlers drop what they held for this page. */
	destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.#events.emit("closed");
		this.#events.emit("destroyed");
	}
}

/** One window per device, created on first use and kept until the device is revoked. */
export class WebWindows {
	readonly #deliver: WindowDelivery;
	readonly #windows = new Map<string, WebClientWindow>();
	#nextId = -1;

	constructor(deliver: WindowDelivery) {
		this.#deliver = deliver;
	}

	/** The device's window; its id is negative and stays for as long as this process runs. */
	windowFor(deviceId: string): WebClientWindow {
		let win = this.#windows.get(deviceId);
		if (!win) {
			win = new WebClientWindow(deviceId, this.#nextId--, this.#deliver);
			this.#windows.set(deviceId, win);
		}
		return win;
	}

	has(deviceId: string): boolean {
		return this.#windows.has(deviceId);
	}

	/** The caller a handler sees for this device's page; `connId` names the one socket of the page's up to four it came over. */
	callerFor(deviceId: string, connId?: string): IpcCaller {
		const win = this.windowFor(deviceId);
		return { win, browserWindow: null, sender: win.webContents, connId };
	}

	destroy(deviceId: string): void {
		const win = this.#windows.get(deviceId);
		if (!win) return;
		this.#windows.delete(deviceId);
		win.destroy();
	}

	destroyAll(): void {
		for (const deviceId of [...this.#windows.keys()]) this.destroy(deviceId);
	}
}
