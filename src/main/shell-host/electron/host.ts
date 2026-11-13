/**
 * What every part of the `electron` shim shares: the connection to the shell, the facts it handed over, the ids the
 * shim assigns (Electron's constructors return before anything can be asked of the shell, so `win.id` and
 * `webContents.id` are Node's to give), and the registry of live pages that routes the shell's events.
 */
import type { EventEmitter } from "node:events";
import type { Answer, HandlerContext, RequestOptions } from "../client";
import type { HostFacts } from "../facts";

/** The part of `ShellClient` the shim uses; tests give it a fake. */
export interface HostClient {
	request<T = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<Answer<T>>;
	call<T = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<T>;
	event(name: string, data?: unknown, bin?: Uint8Array): Promise<void>;
	handle(method: string, handler: (params: never, context: HandlerContext) => unknown): void;
	on(name: string, listener: (data: never, bin?: Buffer) => void): () => void;
	flush(): Promise<void>;
}

/** `event.preventDefault()` as Electron's events have it. */
export interface PreventableEvent {
	preventDefault(): void;
	readonly defaultPrevented: boolean;
}

/** An Electron event object, with the parameters some of them carry (`details.url`) as properties. */
export function makeEvent<T extends object>(params?: T): PreventableEvent & T {
	let prevented = false;
	const event = {
		...(params ?? {}),
		preventDefault: () => {
			prevented = true;
		},
		get defaultPrevented() {
			return prevented;
		},
	};
	return event as PreventableEvent & T;
}

/** Emits `name` with a preventable event first; true when no listener prevented it. */
export function emitPreventable(emitter: EventEmitter, name: string, ...args: unknown[]): boolean {
	const event = makeEvent();
	emitter.emit(name, event, ...args);
	return !event.defaultPrevented;
}

/** What a registered page offers the shell's events and requests. */
export interface PageRecord {
	readonly id: number;
	/** The shell's event for this page (`wc.event`, `wc.state`, `wc.paint`, `wc.cdp.*`). */
	handleEvent(name: string, args: unknown[]): void;
	handleState(state: unknown): void;
	/** The app window this page belongs to, undefined for a view and an offscreen page. */
	readonly windowId?: number;
}

export class Host {
	readonly client: HostClient;
	readonly facts: HostFacts;
	#winId = 0;
	#wcId = 0;
	#viewId = 0;
	/** Pages by `wcId`; filled by the page constructors, emptied when a page is destroyed. */
	readonly pages = new Map<number, PageRecord>();
	/** Everything that must know the shell's connection ended (requests already reject with `gone`). */
	readonly warnings: string[] = [];

	constructor(client: HostClient, facts: HostFacts) {
		this.client = client;
		this.facts = facts;
	}

	nextWindowId(): number {
		return ++this.#winId;
	}

	nextContentsId(): number {
		return ++this.#wcId;
	}

	nextViewId(): number {
		return ++this.#viewId;
	}

	/** A request nobody awaits: a failure is logged (the shell's answer is no use to the caller). */
	post(method: string, params?: unknown, bin?: Uint8Array): void {
		this.client.call(method, params, bin === undefined ? undefined : { bin }).catch((error: unknown) => {
			this.warn(`${method}: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	warn(message: string): void {
		console.warn(`[shell-host] ${message}`);
	}
}
