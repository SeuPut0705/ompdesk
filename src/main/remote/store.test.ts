/**
 * The paired-device lists in the core (`crates/core/src/remote/store.rs`): the file's exact bytes and mode after what a
 * test does through `test-stores.ts`, and a file an older OMPdesk (the TypeScript stores) wrote loading unchanged.
 * Every case the TypeScript stores were captured on before they were deleted is replayed by the Rust tests
 * (`store-captured.json`); the files here are spelled as those stores wrote them, `JSON.stringify(value, null, "\t")`.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PairedHost } from "./hosts-store";
import type { PeerInfo } from "./peers-store";
import { hostStore, peerStore } from "./test-stores";

const KEY = "A".repeat(43);
const peer = (id: string, extra: Partial<PeerInfo> = {}): PeerInfo => ({
	deviceId: id,
	name: `Phone ${id}`,
	staticPub: KEY,
	nodeId: `node-${id}`,
	login: "a@b.c",
	pairedAt: 1_700_000_000_000,
	...extra,
});
const host = (id: string, extra: Partial<PairedHost> = {}): PairedHost => ({
	deviceId: id,
	name: `Mac ${id}`,
	staticPub: KEY,
	nodeId: `node-${id}`,
	addresses: ["100.64.0.1:7777", "100.64.0.1:7778"],
	pairedAt: 1_700_000_000_000,
	...extra,
});
/** A store's file as the TypeScript wrote it. */
const file = (value: object) => `${JSON.stringify(value, null, "\t")}\n`;

describe("remote stores in the core", () => {
	let dir: string;
	const peersFile = () => join(dir, "remote-peers.json");
	const hostsFile = () => join(dir, "remote-hosts.json");
	// Windows has no POSIX permission bits to check.
	const expectOwnerOnly = (path: string) => {
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
	};
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompdesk-store-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes the file the TypeScript wrote, byte for byte, mode 0600", async () => {
		const peers = peerStore(dir);
		await peers.put(peer("a"));
		await peers.put(peer("b", { limits: { requestsPerDay: 3 } }));
		await peers.update("a", { lastSeenAt: 1.5e21, limits: undefined });
		await peers.update("a", { usage: { day: "2026-11-12", requests: 1, tokens: 2 } });
		// A field set again after it was unset keeps the place it had (`{...current, ...patch}`).
		await peers.update("a", { limits: { tokensPerDay: 9 } });
		await peers.put(peer("c", { name: 'q"\\\u0001\u007f\u2028 日本語' }));
		await peers.remove("b");
		expect(readFileSync(peersFile(), "utf8")).toBe(
			file({
				v: 1,
				peers: [
					{
						...peer("a"),
						lastSeenAt: 1.5e21,
						limits: { tokensPerDay: 9 },
						usage: { day: "2026-11-12", requests: 1, tokens: 2 },
					},
					peer("c", { name: 'q"\\\u0001\u007f\u2028 日本語' }),
				],
			}),
		);
		expectOwnerOnly(peersFile());

		const hosts = hostStore(dir);
		const ten = Array.from({ length: 10 }, (_, i) => `100.64.0.${i}:1`);
		await hosts.put(host("a", { addresses: ten }));
		const remembered = ["100.64.0.3:1", ...ten.filter(a => a !== "100.64.0.3:1")].slice(0, 8);
		expect(await hosts.rememberAddress("a", "100.64.0.3:1")).toEqual(host("a", { addresses: remembered }));
		expect(await hosts.rememberAddress("a", "100.64.0.3:1")).toEqual(host("a", { addresses: remembered }));
		expect(await hosts.update("a", { name: "Renamed" })).toEqual(
			host("a", { name: "Renamed", addresses: remembered }),
		);
		expect(readFileSync(hostsFile(), "utf8")).toBe(
			file({ v: 1, hosts: [host("a", { name: "Renamed", addresses: remembered })] }),
		);
		expectOwnerOnly(hostsFile());
	});

	it("loads a file the TypeScript stores wrote, and reads its own file back after a reload", async () => {
		const a = peer("a", {
			name: "Renamed",
			lastSeenAt: 5,
			limits: { requestsPerDay: 2 },
			usage: { day: "d", requests: 1, tokens: 3 },
		});
		const b = peer("b", { nodeId: null, login: null });
		writeFileSync(peersFile(), file({ v: 1, peers: [a, b] }), { mode: 0o600 });
		const h = host("h", { addresses: ["100.64.0.9:7", ...host("h").addresses] });
		writeFileSync(hostsFile(), file({ v: 1, hosts: [h] }), { mode: 0o600 });

		const coreStore = peerStore(dir);
		expect(await coreStore.list()).toEqual([a, b]);
		expect(await coreStore.get("a")).toEqual(a);
		expect(await coreStore.byNode("node-a")).toEqual(a);
		expect(await coreStore.get("nobody")).toBeUndefined();
		expect(await hostStore(dir).list()).toEqual([h]);
		expect(await hostStore(dir).byNode("node-h")).toEqual(h);

		await coreStore.put(peer("z"));
		expect(readFileSync(peersFile(), "utf8")).toBe(file({ v: 1, peers: [a, b, peer("z")] }));
		writeFileSync(peersFile(), file({ v: 1, peers: [b] }));
		await coreStore.reload();
		expect((await coreStore.list()).map(p => p.deviceId)).toEqual(["b"]);
	});

	it("drops a corrupt entry alone and normalises the rest as zod did", async () => {
		writeFileSync(
			peersFile(),
			JSON.stringify({
				v: 1,
				peers: [
					{ pairedAt: 2, staticPub: KEY, name: "n", deviceId: "good", extra: 1 },
					{ ...peer("badkey"), staticPub: "short" },
					{ ...peer("badusage"), usage: { day: "d" } },
					{ ...peer("neg"), limits: { requestsPerDay: -1 } },
				],
			}),
		);
		const good = { deviceId: "good", name: "n", staticPub: KEY, nodeId: null, login: null, pairedAt: 2 };
		expect(await peerStore(dir).list()).toEqual([good]);
		await peerStore(dir).put(peer("two"));
		expect(readFileSync(peersFile(), "utf8")).toBe(file({ v: 1, peers: [good, peer("two")] }));
	});

	it("shares one copy per file and an update of an absent device writes nothing", async () => {
		const first = peerStore(dir);
		const second = peerStore(dir);
		await first.put(peer("a"));
		expect(await second.list()).toEqual([peer("a")]);
		expect(await second.update("nobody", { name: "x" })).toBeUndefined();
		expect(await second.remove("nobody")).toBe(false);
		await expect(
			hostStore(dir).put({ ...host("h"), addresses: undefined } as unknown as PairedHost),
		).rejects.toThrow();
		expect(() => readFileSync(hostsFile())).toThrow();
	});
});
