import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_REMOTE_PORT, parseAddress, remotePort, remotePortCandidates } from "./address";
import { authKeys, dh, generateKeyPair } from "./crypto";
import { HostStore } from "./hosts-store";
import { identityFile, loadIdentity } from "./identity";
import { PeerStore } from "./peers-store";

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
	const saved = process.env.OMP_GUI_REMOTE_PORT;
	afterEach(() => {
		if (saved === undefined) delete process.env.OMP_GUI_REMOTE_PORT;
		else process.env.OMP_GUI_REMOTE_PORT = saved;
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

	it("reads the port override from the environment, and offers it with its successors", () => {
		delete process.env.OMP_GUI_REMOTE_PORT;
		expect(remotePort()).toBe(DEFAULT_REMOTE_PORT);
		const ports = remotePortCandidates();
		expect(ports.slice(0, 5)).toEqual([47821, 47822, 47823, 47824, 47825]);
		// A block of reserved or taken ports (Windows reserves 100-port ranges for Hyper-V, WSL and Docker) never
		// leaves a host nowhere to listen: the fallbacks lie in other blocks, below every OS's dynamic range.
		const fallbacks = ports.slice(5);
		expect(fallbacks.length).toBeGreaterThanOrEqual(4);
		const blocks = new Set(ports.map(port => Math.floor(port / 1000)));
		expect(blocks.size).toBe(fallbacks.length + 1);
		for (const port of fallbacks) expect(port).toBeGreaterThan(1024);
		for (const port of fallbacks) expect(port).toBeLessThan(49152);
		process.env.OMP_GUI_REMOTE_PORT = "50111";
		expect(remotePort()).toBe(50111);
		expect(remotePortCandidates()).toEqual([50111, 50112, 50113, 50114, 50115]);
		expect(remotePortCandidates(65534)).toEqual([65534, 65535]);
		process.env.OMP_GUI_REMOTE_PORT = "0";
		expect(remotePortCandidates()).toEqual([0]);
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
