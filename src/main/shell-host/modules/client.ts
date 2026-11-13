/**
 * Node's typed client of a subsystem moved into the shell (batch SX, native/ompdesk/crates/shell/PROTOCOL.md §15). One
 * file per namespace beside this one (`modules/<namespace>.ts`) declares its `ModuleSpec` and exports the functions
 * the rest of main calls; the TypeScript that did the work is deleted in the same commits. Every name on the wire is
 * `<namespace>.<name>`; requests wait for `app.ready`, as the shim's own do.
 */
import * as electron from "electron";
import type { Answer, Answered, HandlerContext, RequestOptions } from "../client";
import type { HostClient } from "../electron/host";

interface Exchange {
	params: unknown;
	result: unknown;
}

/** A namespace's wire, as its client file declares it (names without the namespace). */
export interface ModuleSpec {
	/** Node → shell requests. */
	calls: Record<string, Exchange>;
	/** Node → shell events (no answer). */
	posts: Record<string, unknown>;
	/** Shell → Node events. */
	events: Record<string, unknown>;
	/** Shell → Node requests the module makes (`Ctx::ask`). */
	asks: Record<string, Exchange>;
}

type Name<T> = keyof T & string;

export interface ModuleClient<S extends ModuleSpec> {
	readonly namespace: string;
	call<K extends Name<S["calls"]>>(
		name: K,
		params: S["calls"][K]["params"],
		options?: RequestOptions,
	): Promise<S["calls"][K]["result"]>;
	/** A call whose answer carries raw bytes (`bin`). */
	request<K extends Name<S["calls"]>>(
		name: K,
		params: S["calls"][K]["params"],
		options?: RequestOptions,
	): Promise<Answer<S["calls"][K]["result"]>>;
	post<K extends Name<S["posts"]>>(name: K, data: S["posts"][K], bin?: Uint8Array): Promise<void>;
	/** Returns what removes the listener. */
	on<K extends Name<S["events"]>>(name: K, listener: (data: S["events"][K], bin?: Buffer) => void): () => void;
	/** Serves one of the module's asks; a throw is an error answer (`HostError` keeps its code). */
	serve<K extends Name<S["asks"]>>(
		name: K,
		handler: (
			params: S["asks"][K]["params"],
			context: HandlerContext,
		) => S["asks"][K]["result"] | Answered | Promise<S["asks"][K]["result"] | Answered>,
	): void;
}

/** The shim's connection; read at each use, so a module file loads in a test that replaces `electron` without it. */
export function shellHost(): HostClient {
	const host: unknown = "shellHost" in electron ? electron.shellHost : undefined;
	if (!host) throw new Error("no shell connection: main runs outside ompdesk-shell");
	// The shim's own member (electron/create.ts `shellHost`); Electron's typings do not know it.
	return host as HostClient;
}

/** The client of `namespace`; tests pass a fake `host`. */
export function shellModule<S extends ModuleSpec>(
	namespace: string,
	host: () => HostClient = shellHost,
): ModuleClient<S> {
	const full = (name: string): string => `${namespace}.${name}`;
	return {
		namespace,
		call: (name, params, options) => host().call(full(name), params, options),
		request: (name, params, options) => host().request(full(name), params, options),
		post: (name, data, bin) => host().event(full(name), data, bin),
		on: (name, listener) => host().on(full(name), listener as (data: never, bin?: Buffer) => void),
		serve: (name, handler) =>
			host().handle(full(name), handler as (params: never, context: HandlerContext) => unknown),
	};
}
