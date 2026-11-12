/**
 * The host's VAPID keypair (RFC 8292) lives in the core (`crates/core/src/web/push.rs`): it makes the pair once in
 * `<userData>/web-push.json` (mode 0600, written atomically), signs every push with it, and never hands the private
 * half to this process. A page subscribes to push against the public key, so a new keypair invalidates every stored
 * subscription: a missing, corrupt or mismatched file makes a fresh pair and says so (`created`), and the host then
 * drops the subscriptions that were made against the old one.
 */
import { core } from "../core/process";

export interface VapidFacts {
	/** Uncompressed P-256 point, base64url: what `PushManager.subscribe` takes as `applicationServerKey`. */
	publicKey: string;
	/** The push services' contact for this sender (RFC 8292 §2.1). */
	subject: string;
	/** True when this call made the keypair (first run, or the file was unusable). */
	created: boolean;
}

/** Reads the keypair, or makes and saves one, and keeps it in the core for `push.send` to sign with. */
export async function loadVapid(userData: string): Promise<VapidFacts> {
	return (await core().call<VapidFacts>("push.vapid", { userData })).result;
}
