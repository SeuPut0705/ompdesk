/**
 * Test support: a `web-devices.json` written by hand, for a test that needs paired devices before the core opens the
 * folder. Pairing is the web edge's (`crates/core/src/web/server.rs`), so no TypeScript code makes a device; the
 * file's format is the contract between that and these tests.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_WEB_GRANTS } from "../../shared/web-protocol";
import type { WebDevice } from "./devices-store";

export interface SeededDevice {
	record: WebDevice;
	/** The cookie `<deviceId>.<secret>` the record's hash belongs to. */
	cookie: string;
}

/** A device record as the edge would have stored it after a pairing at `createdAt`, with the cookie it was given. */
export function seededDevice(init: Partial<WebDevice> & { secret?: string } = {}): SeededDevice {
	const { secret = randomBytes(32).toString("base64url"), ...rest } = init;
	const deviceId = rest.deviceId ?? randomBytes(16).toString("hex");
	const createdAt = rest.createdAt ?? 1_700_000_000_000;
	const record: WebDevice = {
		deviceId,
		name: "iPhone",
		userAgent: "Mozilla/5.0 (iPhone)",
		tailscaleLogin: "me@example.com",
		nodeId: null,
		secretSha256: createHash("sha256").update(secret).digest("hex"),
		publicKeyJwk: null,
		grants: [...DEFAULT_WEB_GRANTS],
		uiPrefs: {},
		createdAt,
		lastSeenAt: createdAt,
		...rest,
	};
	return { record, cookie: `${deviceId}.${secret}` };
}

/** Writes `<dir>/web-devices.json` (mode 0600) with `entries` as its devices, as they are (a damaged one too). */
export function writeWebDevices(dir: string, entries: readonly unknown[]): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "web-devices.json"), `${JSON.stringify({ v: 1, devices: entries }, null, "\t")}\n`, {
		mode: 0o600,
	});
}
