/**
 * `ipcMain`: the shell forwards what a page's `window.omp` calls (`ipc.invoke`, `ipc.send`, and `ipc.sendSync` for the
 * Preview's dialog preload) and this dispatches it to the handlers main registered, with the page's `WebContents` as
 * `event.sender` — so `IpcRegistry`, `BrowserWindow.fromWebContents` and the core routing work as under Electron.
 * Only a page that belongs to an app window may invoke or send; a Preview page (a view or an offscreen browser) has
 * no `window.omp`, and its one synchronous channel is its registered preload's.
 */
import { EventEmitter } from "node:events";
import { decodeBin, encodeBin } from "./binary-json";
import type { Host } from "./host";
import { WebContents } from "./web-contents";

export interface IpcMainEvent {
	sender: WebContents;
	senderFrame: { url: string };
	frameId: number;
	processId: number;
	returnValue?: unknown;
	reply(channel: string, ...args: unknown[]): void;
}

export type IpcMainInvokeEvent = Omit<IpcMainEvent, "returnValue" | "reply">;

type InvokeListener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

export class IpcMain extends EventEmitter {
	readonly #handlers = new Map<string, InvokeListener>();

	handle(channel: string, listener: InvokeListener): void {
		if (this.#handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
		this.#handlers.set(channel, listener);
	}

	handleOnce(channel: string, listener: InvokeListener): void {
		this.handle(channel, (event, ...args) => {
			this.removeHandler(channel);
			return listener(event, ...args);
		});
	}

	removeHandler(channel: string): void {
		this.#handlers.delete(channel);
	}

	/** An invoke call from a page; rejects for a channel nobody handles, as Electron does. */
	async dispatchInvoke(event: IpcMainInvokeEvent, channel: string, args: unknown[]): Promise<unknown> {
		const handler = this.#handlers.get(channel);
		if (!handler) throw new Error(`No handler registered for '${channel}'`);
		return handler(event, ...args);
	}
}

export function serveIpc(host: Host, ipcMain: IpcMain): void {
	const eventFor = (wcId: number, frameUrl: string): IpcMainEvent | null => {
		const sender = host.pages.get(wcId);
		if (!(sender instanceof WebContents)) return null;
		return {
			sender,
			senderFrame: { url: frameUrl },
			frameId: 0,
			processId: 0,
			reply: (channel, ...args) => sender.send(channel, ...args),
		};
	};
	const appEvent = (wcId: number, frameUrl: string): IpcMainEvent => {
		const event = eventFor(wcId, frameUrl);
		if (!event || event.sender.windowId === undefined)
			throw new Error(`IPC from a page that is not an app window: ${wcId}`);
		return event;
	};
	host.client.handle(
		"ipc.invoke",
		async (params: { wcId: number; frameUrl: string; channel: string; args?: unknown[] }) => {
			const { reply: _reply, returnValue: _returnValue, ...event } = appEvent(params.wcId, params.frameUrl);
			return {
				value: encodeBin(
					await ipcMain.dispatchInvoke(event, params.channel, decodeBin(params.args ?? []) as unknown[]),
				),
			};
		},
	);
	host.client.on("ipc.send", (params: { wcId: number; frameUrl: string; channel: string; args?: unknown[] }) => {
		ipcMain.emit(
			params.channel,
			appEvent(params.wcId, params.frameUrl),
			...(decodeBin(params.args ?? []) as unknown[]),
		);
	});
	// `event.returnValue` may be set later (the Preview's dialog waits for a person): the answer is the first value set,
	// null when nothing handles the channel or the page stops waiting (the shell cancels the request).
	host.client.handle(
		"ipc.sendSync",
		(params: { wcId: number; frameUrl: string; channel: string; args?: unknown[] }, { signal }) => {
			const event = eventFor(params.wcId, params.frameUrl);
			if (!event) throw new Error(`IPC from an unknown page: ${params.wcId}`);
			const { promise, resolve } = Promise.withResolvers<{ value: unknown }>();
			let value: unknown;
			Object.defineProperty(event, "returnValue", {
				get: () => value,
				set: (next: unknown) => {
					value = next;
					resolve({ value: encodeBin(next) ?? null });
				},
			});
			signal.addEventListener("abort", () => resolve({ value: null }), { once: true });
			if (!ipcMain.emit(params.channel, event, ...(decodeBin(params.args ?? []) as unknown[])))
				resolve({ value: null });
			return promise;
		},
	);
}
