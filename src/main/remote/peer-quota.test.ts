import { describe, expect, it } from "vitest";
import { localDay, PeerQuota } from "./peer-quota";
import type { PeerInfo } from "./peers-store";

/** PeerStore's get/update over a map (the real store also copies on every read). */
function memoryPeers(...peers: PeerInfo[]) {
	const entries = new Map(peers.map(peer => [peer.deviceId, { ...peer }]));
	return {
		entries,
		get: (deviceId: string) => {
			const entry = entries.get(deviceId);
			return entry && { ...entry };
		},
		update: (deviceId: string, patch: Partial<Omit<PeerInfo, "deviceId">>) => {
			const current = entries.get(deviceId);
			if (!current) return undefined;
			const next = { ...current, ...patch };
			entries.set(deviceId, next);
			return { ...next };
		},
	};
}

const LAPTOP: PeerInfo = { deviceId: "laptop", name: "laptop", staticPub: "pub", pairedAt: 0 };

describe("PeerQuota", () => {
	it("has no limit until one is set, and counts per local day", () => {
		let now = new Date(2026, 9, 15, 23, 59);
		const changed: string[] = [];
		const peers = memoryPeers(LAPTOP);
		const quota = new PeerQuota(
			peers,
			id => changed.push(id),
			() => now,
		);

		quota.record("laptop", { requests: 1, tokens: 900 });
		expect(quota.refusal("laptop")).toBeNull();
		expect(peers.entries.get("laptop")?.usage).toEqual({ day: "2026-10-15", requests: 1, tokens: 900 });
		expect(changed).toEqual(["laptop"]);

		expect(quota.setLimits("laptop", { requestsPerDay: 2, tokensPerDay: 1_000 })).toBe(true);
		quota.record("laptop", { tokens: 100 });
		expect(quota.refusal("laptop")).toBe("tokens");
		quota.setLimits("laptop", { requestsPerDay: 2 });
		expect(quota.refusal("laptop")).toBeNull();
		quota.record("laptop", { requests: 1 });
		expect(quota.refusal("laptop")).toBe("requests");

		// The next day starts from zero.
		now = new Date(2026, 9, 16, 0, 1);
		const stored = peers.get("laptop");
		if (!stored) throw new Error("peer gone");
		expect(quota.usage(stored)).toEqual({ requests: 0, tokens: 0 });
		expect(quota.refusal("laptop")).toBeNull();
		quota.record("laptop", { requests: 1 });
		expect(peers.entries.get("laptop")?.usage).toEqual({ day: "2026-10-16", requests: 1, tokens: 0 });
	});

	it("removes the limits with an empty object and refuses an unknown device", () => {
		const peers = memoryPeers(LAPTOP);
		const quota = new PeerQuota(peers, () => {});
		quota.setLimits("laptop", { tokensPerDay: 0 });
		expect(quota.refusal("laptop")).toBe("tokens");
		quota.setLimits("laptop", {});
		expect(peers.entries.get("laptop")?.limits).toBeUndefined();
		expect(quota.refusal("laptop")).toBeNull();
		expect(quota.setLimits("nobody", { requestsPerDay: 1 })).toBe(false);
	});

	it("names days in this computer's time zone", () => {
		expect(localDay(new Date(2026, 0, 5, 0, 0))).toBe("2026-01-05");
	});
});
