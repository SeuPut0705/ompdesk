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

const LAPTOP: PeerInfo = {
	deviceId: "laptop",
	name: "laptop",
	staticPub: "pub",
	nodeId: "nLAPTOP",
	login: null,
	pairedAt: 0,
};

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

	it("reserves a request when it checks, so parallel requests at limit minus one let exactly one through", () => {
		const peers = memoryPeers({
			...LAPTOP,
			limits: { requestsPerDay: 3 },
			usage: { day: "2026-10-15", requests: 2, tokens: 0 },
		});
		const quota = new PeerQuota(
			peers,
			() => {},
			() => new Date(2026, 9, 15, 12, 0),
		);

		const results = Array.from({ length: 5 }, () => quota.reserve("laptop"));
		expect(results.filter(result => result.ok)).toHaveLength(1);
		expect(results.filter(result => !result.ok).map(result => !result.ok && result.refusal)).toEqual([
			"requests",
			"requests",
			"requests",
			"requests",
		]);
		expect(peers.entries.get("laptop")?.usage?.requests).toBe(3);
	});

	it("gives a reserved request back on refund, once", () => {
		const now = new Date(2026, 9, 15, 23, 59);
		const peers = memoryPeers({ ...LAPTOP, limits: { requestsPerDay: 1 } });
		const quota = new PeerQuota(
			peers,
			() => {},
			() => now,
		);

		const first = quota.reserve("laptop");
		if (!first.ok) throw new Error("expected a reservation");
		expect(quota.reserve("laptop")).toEqual({ ok: false, refusal: "requests" });
		first.refund();
		first.refund();
		expect(peers.entries.get("laptop")?.usage?.requests).toBe(0);
		expect(quota.reserve("laptop").ok).toBe(true);
	});

	it("does not take a request off the new day when a refund lands after midnight", () => {
		let now = new Date(2026, 9, 15, 23, 59);
		const peers = memoryPeers({ ...LAPTOP, limits: { requestsPerDay: 5 } });
		const quota = new PeerQuota(
			peers,
			() => {},
			() => now,
		);
		const reservation = quota.reserve("laptop");
		if (!reservation.ok) throw new Error("expected a reservation");
		now = new Date(2026, 9, 16, 0, 1);
		quota.record("laptop", { requests: 2 });
		reservation.refund();
		expect(peers.entries.get("laptop")?.usage).toEqual({ day: "2026-10-16", requests: 2, tokens: 0 });
	});

	it("reserves nothing for an unknown device", () => {
		const quota = new PeerQuota(memoryPeers(), () => {});
		expect(quota.reserve("nobody").ok).toBe(true);
	});

	it("counts a weighted reservation, such as a benchmark's model requests, and never lets one cross the limit", () => {
		const peers = memoryPeers({ ...LAPTOP, limits: { requestsPerDay: 10 } });
		const quota = new PeerQuota(peers, () => {});
		expect(quota.reserve("laptop", 40)).toEqual({ ok: false, refusal: "requests" });
		expect(quota.reserve("laptop", 6).ok).toBe(true);
		expect(quota.reserve("laptop", 6)).toEqual({ ok: false, refusal: "requests" });
		expect(quota.reserve("laptop", 4).ok).toBe(true);
		expect(quota.reserve("laptop").ok).toBe(false);
		expect(peers.entries.get("laptop")?.usage?.requests).toBe(10);
	});

	it("names days in this computer's time zone", () => {
		expect(localDay(new Date(2026, 0, 5, 0, 0))).toBe("2026-01-05");
	});
});
