/**
 * This computer's remote identity: its device id and static X25519 public key. The core keeps the file
 * (`remote-identity.json`, 0600) and the private key (`crates/core/src/remote/identity.rs`); main holds the public
 * part, read once at launch, because the device id is read synchronously everywhere (the tab holders, memory's
 * origin, reviews).
 */
import { join } from "node:path";
import { core } from "../core/process";

export interface Identity {
	readonly deviceId: string;
	readonly publicKey: string;
}

export function identityFile(userData: string): string {
	return join(userData, "remote-identity.json");
}

/** Loads the identity in `userData`, or makes and keeps a new one; the core then answers handshakes with it. */
export async function loadIdentity(userData: string): Promise<Identity> {
	const { result } = await core().call<Identity>("remote.identity", { userData });
	return { deviceId: result.deviceId, publicKey: result.publicKey };
}
