/**
 * The one table of main's IPC handlers. `handle` and `on` register a handler once: on `ipcMain` at that moment
 * (same channel, same arguments, same order as registering it there directly), so the app's own windows reach
 * it exactly as before, and in the table `invoke` and `send` dispatch from, for a caller that does not come
 * through Electron (a paired web device).
 *
 * A handler takes the caller where it took Electron's event. For an Electron call `caller.win` is
 * `BrowserWindow.fromWebContents(event.sender)`, looked up again on every read like the call it replaces, and
 * `caller.sender` is `event.sender`.
 *
 * The channels the core serves (`crates/core/src/ipc`, unit 9a) are registered the same way by `routeCore`, which
 * hands the core `IPC_POLICY` as data and takes its table of channels: each call of one goes to the core's
 * `ipc.call`, every other channel stays here and never touches the core, so a core that is down or resting fails
 * only its own channels.
 */
import { BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { CoreAnswer, CoreCallOptions } from "../core/process";
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
	/** A paired web page's connection the call came over (a device's pages share one window); absent for an Electron caller. */
	readonly connId?: string;
}

type IpcHandler = (caller: IpcCaller, ...args: unknown[]) => unknown;

/** What `routeCore` needs of the core: `CoreProcess`. */
export interface IpcCore {
	readonly pid: number | null;
	call<T>(method: string, params?: unknown, options?: CoreCallOptions): Promise<CoreAnswer<T>>;
}

/** A channel the core serves, as `ipc.start` names it; its direction is `IPC_POLICY`'s. */
interface CoreChannel {
	channel: string;
	dir: "invoke" | "send";
}

/** A core-served channel's call has no deadline of its own, as an Electron handler has none. */
const CORE_CALL_MS = 2 ** 31 - 1;

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
	#core: IpcCore | null = null;
	#coreParams: { policy: Record<string, unknown>; testChannels?: boolean } | null = null;
	/** The core that was handed the policy last; a core started again (another pid) is handed it again first. */
	#startedPid: number | null = null;
	#starting: Promise<unknown> | null = null;
	/** Core calls made while the policy was being handed over, in the order they came; given the hand-over's failure. */
	#held: Array<(failure: unknown) => void> = [];

	constructor(ipcMain: ElectronIpc) {
		this.#ipcMain = ipcMain;
	}

	/**
	 * Hands the core `policy` (`IPC_POLICY`) and registers each channel it serves, as `handle`/`on` would. Rejects when
	 * the core cannot be started or refuses the policy; the channels main serves are untouched either way.
	 */
	async routeCore(core: IpcCore, policy: Record<string, unknown>, options: { testChannels?: boolean } = {}) {
		this.#core = core;
		this.#coreParams = { policy, ...(options.testChannels ? { testChannels: true } : {}) };
		const channels = await this.#handOver();
		for (const { channel, dir } of channels) {
			if (dir === "invoke")
				this.handle(channel, (caller, ...args) => this.#viaCore(caller, "invoke", channel, args));
			else
				this.on(channel, (caller, ...args) => {
					this.#viaCore(caller, "send", channel, args).catch((error: unknown) =>
						console.warn(`[ipc] ${channel}: ${error instanceof Error ? error.message : String(error)}`),
					);
				});
		}
	}

	/** `ipc.start` on the running core (starting it), once at a time; its table of channels. */
	#handOver(): Promise<CoreChannel[]> {
		const core = this.#core;
		if (!core || !this.#coreParams) return Promise.reject(new Error("No core to route IPC to"));
		const started = core.call<{ channels: CoreChannel[] }>("ipc.start", this.#coreParams);
		const pid = core.pid;
		const handed = started.then(
			answer => {
				this.#startedPid = pid;
				return answer.result.channels;
			},
			(error: unknown) => {
				this.#startedPid = null;
				throw error;
			},
		);
		this.#starting = handed.then(
			() => undefined,
			(error: unknown) => error ?? new Error("ompdesk-core refused IPC_POLICY"),
		);
		void this.#starting.then(failure => {
			this.#starting = null;
			const held = this.#held;
			this.#held = [];
			for (const send of held) send(failure);
		});
		return handed;
	}

	/**
	 * A call of a core-served channel. Its line is written to the core at once, so a page's calls reach the core in the
	 * order Electron ran their handlers; a call that finds the core started again (or not yet handed the policy) waits,
	 * behind the calls already waiting, until the policy is handed over again.
	 */
	#viaCore(caller: IpcCaller, dir: "invoke" | "send", channel: string, args: unknown[]): Promise<unknown> {
		const core = this.#core;
		if (!core) return Promise.reject(new Error(`No handler registered for '${channel}'`));
		const params = {
			// The lane the call is ordered in, in the core: one per window page, one per paired page's connection.
			caller: {
				key: caller.connId === undefined ? `w${caller.sender.id}` : `c${caller.connId}`,
				window: caller.win?.webContents.id ?? null,
				connId: caller.connId ?? null,
			},
			channel,
			dir,
			args,
		};
		const send = (): Promise<unknown> =>
			core
				.call<{ value: unknown }>("ipc.call", params, { timeoutMs: CORE_CALL_MS })
				.then(answer => answer.result.value);
		const current = this.#startedPid !== null && core.pid === this.#startedPid;
		if (current && !this.#starting) return send();
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#held.push(failure => {
			if (failure !== undefined) reject(failure);
			else send().then(resolve, reject);
		});
		if (!this.#starting) this.#handOver().catch(() => undefined);
		return promise;
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
