import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRawKey } from "./crypto";
import { HostStore } from "./hosts-store";
import { identityFile, loadIdentity } from "./identity";
import { PeerStore } from "./peers-store";
import { generateKeyPair } from "./test-legacy-peer";

describe("identity and stores", () => {
	let dir: string;
	// Windows has no POSIX permission bits to check.
	const expectOwnerOnly = (file: string) => {
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
	};
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompdesk-remote-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("persists the identity with mode 0600 and reloads the same keys", async () => {
		const first = await loadIdentity(dir);
		expect(first.deviceId).toMatch(/^[0-9a-z]{26}$/);
		expect(isRawKey(first.publicKey)).toBe(true);
		expectOwnerOnly(identityFile(dir));
		const again = await loadIdentity(dir);
		expect(again).toEqual(first);
	});

	it("replaces an identity file whose keys do not match with a new identity", async () => {
		const written = {
			v: 1,
			deviceId: "z".repeat(26),
			publicKey: generateKeyPair().publicKey,
			privateKey: "A".repeat(43),
		};
		writeFileSync(identityFile(dir), JSON.stringify(written));
		const fresh = await loadIdentity(dir);
		expect(fresh.deviceId).not.toBe(written.deviceId);
		expect(await loadIdentity(dir)).toEqual(fresh);
	});

	it("writes peers and hosts atomically with mode 0600, and reads an older record as not yet bound to a node", () => {
		const staticPub = generateKeyPair().publicKey;
		const peers = new PeerStore(dir);
		peers.put({ deviceId: "a", name: "A", staticPub, nodeId: "nA", login: "me@x", pairedAt: 1 });
		peers.update("a", { lastSeenAt: 2 });
		expect(new PeerStore(dir).get("a")).toEqual({
			deviceId: "a",
			name: "A",
			staticPub,
			nodeId: "nA",
			login: "me@x",
			pairedAt: 1,
			lastSeenAt: 2,
		});
		expect(new PeerStore(dir).byNode("nA")?.deviceId).toBe("a");
		expectOwnerOnly(join(dir, "remote-peers.json"));
		expect(peers.remove("a")).toBe(true);
		expect(new PeerStore(dir).list()).toEqual([]);

		const hosts = new HostStore(dir);
		hosts.put({ deviceId: "b", name: "B", staticPub, nodeId: "nB", addresses: ["10.0.0.1:47821"], pairedAt: 1 });
		hosts.rememberAddress("b", "10.0.0.2:47821");
		hosts.rememberAddress("b", "10.0.0.1:47821");
		expect(new HostStore(dir).get("b")?.addresses).toEqual(["10.0.0.1:47821", "10.0.0.2:47821"]);
		expectOwnerOnly(join(dir, "remote-hosts.json"));

		writeFileSync(
			join(dir, "remote-peers.json"),
			JSON.stringify({ v: 1, peers: [{ deviceId: "old", name: "Old", staticPub, pairedAt: 1 }] }),
		);
		expect(new PeerStore(dir).get("old")).toMatchObject({ nodeId: null, login: null });
	});
});
