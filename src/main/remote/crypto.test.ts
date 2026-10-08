import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DISCOVERY_PORT, DEFAULT_REMOTE_PORT, discoveryPort, parseAddress, remotePort } from "./address";
import { authKeys, dh, formatCode, generateCode, generateKeyPair, normalizeCode } from "./crypto";
import { HostStore } from "./hosts-store";
import { identityFile, loadIdentity } from "./identity";
import { PeerStore } from "./peers-store";

describe("pairing codes", () => {
	it("generates 8 Crockford chars shown as XXXX-XXXX", () => {
		const code = generateCode();
		expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
		expect(formatCode(code)).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
	});

	it("normalizes case, dashes, spaces and the I/L/O look-alikes", () => {
		expect(normalizeCode("ab1c-d0ef")).toBe("AB1CD0EF");
		expect(normalizeCode(" abIc dOef ")).toBe("AB1CD0EF");
		expect(normalizeCode("ablc-doef")).toBe("AB1CD0EF");
		expect(normalizeCode("ABCD-EFG")).toBeNull();
		expect(normalizeCode("ABCD-EFGU")).toBeNull();
	});
});

describe("key agreement", () => {
	it("derives the same direction keys on both sides of DH(eA,eB)||DH(sA,eB)||DH(eA,sB)", () => {
		const [sA, eA, sB, eB] = [generateKeyPair(), generateKeyPair(), generateKeyPair(), generateKeyPair()];
		const transcript = Buffer.from("t");
		const onA = authKeys(
			Buffer.concat([
				dh(eA.privateKey, eB.publicKey),
				dh(sA.privateKey, eB.publicKey),
				dh(eA.privateKey, sB.publicKey),
			]),
			transcript,
		);
		const onB = authKeys(
			Buffer.concat([
				dh(eB.privateKey, eA.publicKey),
				dh(eB.privateKey, sA.publicKey),
				dh(sB.privateKey, eA.publicKey),
			]),
			transcript,
		);
		expect(onA.ab.equals(onB.ab)).toBe(true);
		expect(onA.ba.equals(onB.ba)).toBe(true);
		expect(onA.ab.equals(onA.ba)).toBe(false);
	});
});

describe("addresses and ports", () => {
	const saved = { port: process.env.OMP_GUI_REMOTE_PORT, discovery: process.env.OMP_GUI_REMOTE_DISCOVERY_PORT };
	afterEach(() => {
		for (const [name, value] of [
			["OMP_GUI_REMOTE_PORT", saved.port],
			["OMP_GUI_REMOTE_DISCOVERY_PORT", saved.discovery],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	it("parses host, host:port and IPv6 forms", () => {
		expect(parseAddress("10.0.0.5")).toEqual({ host: "10.0.0.5", port: DEFAULT_REMOTE_PORT });
		expect(parseAddress(" studio.local:5000 ")).toEqual({ host: "studio.local", port: 5000 });
		expect(parseAddress("[fe80::1]:6000")).toEqual({ host: "fe80::1", port: 6000 });
		expect(parseAddress("fe80::1")).toEqual({ host: "fe80::1", port: DEFAULT_REMOTE_PORT });
		expect(parseAddress("host:99999")).toBeNull();
		expect(parseAddress("a b")).toBeNull();
		expect(parseAddress("")).toBeNull();
	});

	it("reads the port overrides from the environment", () => {
		delete process.env.OMP_GUI_REMOTE_PORT;
		delete process.env.OMP_GUI_REMOTE_DISCOVERY_PORT;
		expect(remotePort()).toBe(DEFAULT_REMOTE_PORT);
		expect(discoveryPort()).toBe(DEFAULT_DISCOVERY_PORT);
		process.env.OMP_GUI_REMOTE_PORT = "50111";
		process.env.OMP_GUI_REMOTE_DISCOVERY_PORT = "50112";
		expect(remotePort()).toBe(50111);
		expect(discoveryPort()).toBe(50112);
		process.env.OMP_GUI_REMOTE_PORT = "nope";
		expect(remotePort()).toBe(DEFAULT_REMOTE_PORT);
	});
});

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

	it("persists the identity with mode 0600 and reloads the same keys", () => {
		const first = loadIdentity(dir);
		expect(first.deviceId).toMatch(/^[0-9a-z]{26}$/);
		expectOwnerOnly(identityFile(dir));
		const again = loadIdentity(dir);
		expect(again.deviceId).toBe(first.deviceId);
		expect(again.publicKey).toBe(first.publicKey);
		const peer = generateKeyPair();
		expect(dh(again.privateKey, peer.publicKey).equals(dh(peer.privateKey, first.publicKey))).toBe(true);
	});

	it("writes peers and hosts atomically with mode 0600", () => {
		const staticPub = generateKeyPair().publicKey;
		const peers = new PeerStore(dir);
		peers.put({ deviceId: "a", name: "A", staticPub, pairedAt: 1 });
		peers.update("a", { lastSeenAt: 2 });
		expect(new PeerStore(dir).get("a")).toEqual({ deviceId: "a", name: "A", staticPub, pairedAt: 1, lastSeenAt: 2 });
		expectOwnerOnly(join(dir, "remote-peers.json"));
		expect(peers.remove("a")).toBe(true);
		expect(new PeerStore(dir).list()).toEqual([]);

		const hosts = new HostStore(dir);
		hosts.put({ deviceId: "b", name: "B", staticPub, addresses: ["10.0.0.1:47821"], pairedAt: 1 });
		hosts.rememberAddress("b", "10.0.0.2:47821");
		hosts.rememberAddress("b", "10.0.0.1:47821");
		expect(new HostStore(dir).get("b")?.addresses).toEqual(["10.0.0.1:47821", "10.0.0.2:47821"]);
		expectOwnerOnly(join(dir, "remote-hosts.json"));
	});
});
