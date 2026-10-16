/**
 * The one table of main's IPC handlers. `handle` and `on` register a handler once: on `ipcMain` at that moment
 * (same channel, same arguments, same order as registering it there directly), so the app's own windows reach
 * it exactly as before, and in the table `invoke` and `send` dispatch from, for a caller that does not come
 * through Electron (a paired web device).
 *
 * A handler takes the caller where it took Electron's event. For an Electron call `caller.win` is
 * `BrowserWindow.fromWebContents(event.sender)`, looked up again on every read like the call it replaces, and
 * `caller.sender` is `event.sender`.
 */
import { BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { ClientWindow } from "./client-window";

/** The page that made the call: Electron's `event.sender`. */
export interface IpcSender {
	readonly id: number;
	once(event: "destroyed", listener: () => void): unknown;
}

export interface IpcCaller {
	/** The calling window; null when the sender has none. */
	readonly win: ClientWindow | null;
	/** The same window as Electron's own, for a dialog sheet, the title-bar overlay or the preview; null for a web caller. */
	readonly browserWindow: BrowserWindow | null;
	readonly sender: IpcSender;
}

type IpcHandler = (caller: IpcCaller, ...args: unknown[]) => unknown;

/** What the registry registers on: Electron's `ipcMain`. */
interface ElectronIpc {
	handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void;
	on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): unknown;
}

/** An Electron call's caller: its window is looked up on each read, like the `fromWebContents` call it replaces. */
class ElectronCaller implements IpcCaller {
	readonly sender: WebContents;
	constructor(sender: WebContents) {
		this.sender = sender;
	}
	get win(): ClientWindow | null {
		return BrowserWindow.fromWebContents(this.sender);
	}
	get browserWindow(): BrowserWindow | null {
		return BrowserWindow.fromWebContents(this.sender);
	}
}

export class IpcRegistry {
	readonly #ipcMain: ElectronIpc;
	readonly #invokeHandlers = new Map<string, IpcHandler>();
	readonly #sendHandlers = new Map<string, IpcHandler>();

	constructor(ipcMain: ElectronIpc) {
		this.#ipcMain = ipcMain;
	}

	/** An invoke channel's handler; its result (or rejection) is the caller's. A second one for a channel throws, as in Electron. */
	handle<A extends unknown[]>(channel: string, handler: (caller: IpcCaller, ...args: A) => unknown): void {
		// The IPC boundary is untyped: each handler checks the arguments it declares.
		const run = handler as IpcHandler;
		this.#ipcMain.handle(channel, (event, ...args: unknown[]) => run(new ElectronCaller(event.sender), ...args));
		this.#invokeHandlers.set(channel, run);
	}

	/** A fire-and-forget channel's handler (the renderer's `send`). One per channel. */
	on<A extends unknown[]>(channel: string, handler: (caller: IpcCaller, ...args: A) => void): void {
		if (this.#sendHandlers.has(channel)) throw new Error(`Attempted to register a second listener for '${channel}'`);
		const run = handler as IpcHandler;
		this.#ipcMain.on(channel, (event, ...args: unknown[]) => run(new ElectronCaller(event.sender), ...args));
		this.#sendHandlers.set(channel, run);
	}

	/** Run an invoke channel's handler for a caller outside Electron; rejects for a channel nobody handles, as Electron does. */
	async invoke(channel: string, caller: IpcCaller, args: readonly unknown[]): Promise<unknown> {
		const handler = this.#invokeHandlers.get(channel);
		if (!handler) throw new Error(`No handler registered for '${channel}'`);
		return handler(caller, ...args);
	}

	/** Run a fire-and-forget channel's handler for a caller outside Electron; a channel nobody listens on is dropped. */
	send(channel: string, caller: IpcCaller, args: readonly unknown[]): void {
		this.#sendHandlers.get(channel)?.(caller, ...args);
	}
}
