import { randomUUID } from "node:crypto";
import { RpcClient } from "../rpc-client";

const instances = new WeakMap<RpcClient, string>();

/** Command proxies do not identify the local omp that owns a receiving journal. */
export function localInboxRuntimeInstance(client: Pick<RpcClient, "command"> | null | undefined): string | undefined {
	if (!(client instanceof RpcClient)) return undefined;
	let instance = instances.get(client);
	if (instance === undefined) {
		instance = randomUUID();
		instances.set(client, instance);
	}
	return instance;
}
