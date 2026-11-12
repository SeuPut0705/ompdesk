/**
 * Test-only: the paired-device lists as the core keeps them (`crates/core/src/remote/store.rs`), read and changed by
 * the methods `remote.store.*`. A test that checks what devices.ts left in `remote-peers.json` or `remote-hosts.json`
 * reads it through here, or writes it as it wants the core to find it.
 */

import { core } from "../core/process";
import type { PairedHost } from "./hosts-store";
import type { PeerInfo } from "./peers-store";

/** What a key holding `undefined` is as JSON: the core keeps the key (its place for a later set) and writes none. */
const UNDEFINED = { "~undefined": true };

const encode = (fields: object): Record<string, unknown> =>
	Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value === undefined ? UNDEFINED : value]));

export interface TestStore<T extends { deviceId: string }> {
	list(): Promise<T[]>;
	get(deviceId: string): Promise<T | undefined>;
	/** Add or replace, as the TypeScript `put` did (a key that is `undefined` keeps its place). */
	put(entry: T): Promise<void>;
	update(deviceId: string, patch: Partial<Omit<T, "deviceId">>): Promise<T | undefined>;
	remove(deviceId: string): Promise<boolean>;
	byNode(nodeId: string): Promise<T | undefined>;
	/** Forget what the core read: the next call reads the file again (a new store object). */
	reload(): Promise<void>;
}

/**
 * Each call to `peerStore(dir)` or `hostStore(dir)` is a new store object, as `new PeerStore(dir)` was: its first call
 * makes the core read the file again, so a file a test wrote behind the core's back (or another object saved) is seen.
 * `reload()` does it again on the same object.
 */
function store<T extends { deviceId: string }>(
	userData: string,
	kind: "peers" | "hosts",
): TestStore<T> & { rememberAddress(deviceId: string, address: string): Promise<T | undefined> } {
	let fresh = true;
	const call = async <R>(method: string, params: object = {}): Promise<R> => {
		const rpc = (name: string, extra: object) => core().call<R>(`remote.store.${name}`, { userData, kind, ...extra });
		if (fresh) {
			fresh = false;
			await rpc("reload", {});
		}
		return (await rpc(method, params)).result;
	};
	const found = async (method: string, params: object): Promise<T | undefined> =>
		(await call<T | null>(method, params)) ?? undefined;
	return {
		list: () => call<T[]>("list"),
		get: deviceId => found("get", { deviceId }),
		put: async entry => {
			await call("put", { entry: encode(entry) });
		},
		update: (deviceId, patch) => found("update", { deviceId, patch: encode(patch) }),
		remove: deviceId => call<boolean>("remove", { deviceId }),
		byNode: nodeId => found("byNode", { nodeId }),
		rememberAddress: (deviceId, address) => found("rememberAddress", { deviceId, address }),
		reload: async () => {
			await call("reload");
		},
	};
}

export const peerStore = (userData: string): TestStore<PeerInfo> => store<PeerInfo>(userData, "peers");

export const hostStore = (
	userData: string,
): TestStore<PairedHost> & { rememberAddress(deviceId: string, address: string): Promise<PairedHost | undefined> } =>
	store<PairedHost>(userData, "hosts");
