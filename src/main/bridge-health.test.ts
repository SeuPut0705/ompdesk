import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeHealth, unavailableFeatures } from "./bridge-health";

function fakeBridge(result: () => Promise<unknown>) {
	const request = vi.fn((_method: string) => result());
	return { bridge: { request: <T>(method: string) => request(method) as Promise<T> }, request };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("unavailableFeatures", () => {
	it("reads distinct feature ids and ignores malformed entries", () => {
		expect(
			unavailableFeatures({
				ompVersion: "19.0.0",
				unavailable: [
					{ feature: "planMode", missing: ["x"] },
					{ feature: "planMode" },
					{ feature: 3 },
					null,
					"btw",
				],
			}),
		).toEqual(["planMode"]);
		expect(unavailableFeatures({ unavailable: [] })).toEqual([]);
		expect(unavailableFeatures(null)).toEqual([]);
	});
});

describe("BridgeHealth", () => {
	it("probes once per omp version and queues one warning for the first window that takes it", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const notify = vi.fn();
		const health = new BridgeHealth(notify);
		const broken = fakeBridge(async () => ({
			ompVersion: "19.0.0",
			unavailable: [
				{ feature: "planMode", missing: ["AgentSession.setPlanModeState"] },
				{ feature: "goalMode", missing: ["@oh-my-pi/pi-coding-agent/goals/settings"] },
			],
		}));

		await health.observe({ connected: true, ompVersion: "19.0.0", bridge: broken.bridge });
		await health.observe({ connected: true, ompVersion: "19.0.0", bridge: broken.bridge });

		expect(broken.request).toHaveBeenCalledTimes(1);
		expect(broken.request).toHaveBeenCalledWith("capabilities");
		expect(notify).toHaveBeenCalledTimes(1);
		expect(health.take()).toEqual([
			{ kind: "unsupported", ompVersion: "19.0.0", features: ["planMode", "goalMode"] },
		]);
		expect(health.take()).toEqual([]);

		// A different omp (after `omp update` + restart) is checked again.
		const healthy = fakeBridge(async () => ({ ompVersion: "19.0.1", unavailable: [] }));
		await health.observe({ connected: true, ompVersion: "19.0.1", bridge: healthy.bridge });
		expect(healthy.request).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(health.take()).toEqual([]);
	});

	it("probes again after an omp update and warns when the new omp dropped a feature the old one had", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const notify = vi.fn();
		const health = new BridgeHealth(notify);
		const before = fakeBridge(async () => ({ ompVersion: "18.8.7", unavailable: [] }));
		await health.observe({ connected: true, ompVersion: "18.8.7", bridge: before.bridge });
		expect(health.take()).toEqual([]);
		expect(health.supports("18.8.7", "planMode")).toBe(true);

		// omp updated itself; the tab that restarted on it reports its own version.
		const after = fakeBridge(async () => ({
			ompVersion: "18.9.0",
			unavailable: [{ feature: "planMode", missing: ["AgentSession.setPlanModeState"] }],
		}));
		await health.observe({ connected: true, ompVersion: "18.9.0", bridge: after.bridge });
		expect(after.request).toHaveBeenCalledWith("capabilities");
		expect(notify).toHaveBeenCalledTimes(1);
		expect(health.take()).toEqual([{ kind: "unsupported", ompVersion: "18.9.0", features: ["planMode"] }]);
		expect(health.supports("18.9.0", "planMode")).toBe(false);
		// The old version's answer stays; a second tab on 18.9.0 does not warn twice.
		expect(health.supports("18.8.7", "planMode")).toBe(true);
		await health.observe({ connected: true, ompVersion: "18.9.0", bridge: after.bridge });
		expect(after.request).toHaveBeenCalledTimes(1);
	});

	it("answers whether a probed omp version serves a feature, and doesn't know before a probe", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const health = new BridgeHealth(() => {});
		expect(health.supports("18.8.0", "accountRotation")).toBeNull();
		const old = fakeBridge(async () => ({ unavailable: [{ feature: "accountRotation", missing: ["x"] }] }));
		await health.observe({ connected: true, ompVersion: "18.7.0", bridge: old.bridge });
		const current = fakeBridge(async () => ({ unavailable: [] }));
		await health.observe({ connected: true, ompVersion: "18.8.0", bridge: current.bridge });
		expect(health.supports("18.7.0", "accountRotation")).toBe(false);
		expect(health.supports("18.7.0", "planMode")).toBe(true);
		expect(health.supports("18.8.0", "accountRotation")).toBe(true);
	});

	it("retries on the next sidecar when the capabilities request itself fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const health = new BridgeHealth(() => {});
		const dropped = fakeBridge(async () => {
			throw new Error("GUI bridge disconnected");
		});
		await health.observe({ connected: true, ompVersion: "19.0.0", bridge: dropped.bridge });
		expect(health.take()).toEqual([]);

		const next = fakeBridge(async () => ({ unavailable: [{ feature: "mcp", missing: ["x"] }] }));
		await health.observe({ connected: true, ompVersion: "19.0.0", bridge: next.bridge });
		expect(next.request).toHaveBeenCalledTimes(1);
		// No version in the result: the sidecar's own omp version stands in.
		expect(health.take()).toEqual([{ kind: "unsupported", ompVersion: "19.0.0", features: ["mcp"] }]);
	});

	it("reports a bridge that never connected once per version", async () => {
		const notify = vi.fn();
		const health = new BridgeHealth(notify);
		const failure = {
			connected: false,
			ompVersion: "19.0.0",
			error: "did not accept a connection within 3000ms",
		} as const;
		await health.observe(failure);
		await health.observe(failure);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(health.take()).toEqual([
			{ kind: "unavailable", ompVersion: "19.0.0", reason: "did not accept a connection within 3000ms" },
		]);
	});
});

describe("BridgeHealth self-repair", () => {
	const lacking = (version: string) =>
		fakeBridge(async () => ({ ompVersion: version, unavailable: [{ feature: "planMode", missing: ["x"] }] }));

	it("newest omp still incompatible: one repair attempt, the toast still shows", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const onIncompatible = vi.fn();
		const notify = vi.fn();
		const health = new BridgeHealth(notify, onIncompatible);
		await health.observe({ connected: true, ompVersion: "19.0.1", bridge: lacking("19.0.1").bridge });
		expect(onIncompatible).toHaveBeenCalledExactlyOnceWith("19.0.1");
		expect(health.take()).toHaveLength(1);
	});

	it("a second probe of the same version, connected or not, starts no new attempt", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const onIncompatible = vi.fn();
		const health = new BridgeHealth(vi.fn(), onIncompatible);
		await health.observe({ connected: true, ompVersion: "19.0.1", bridge: lacking("19.0.1").bridge });
		await health.observe({ connected: true, ompVersion: "19.0.1", bridge: lacking("19.0.1").bridge });
		await health.observe({ connected: false, ompVersion: "19.0.1", error: "x" });
		expect(onIncompatible).toHaveBeenCalledTimes(1);
		await health.observe({ connected: false, ompVersion: "19.0.2", error: "x" });
		expect(onIncompatible).toHaveBeenCalledTimes(2);
	});

	it("a healthy omp starts none", async () => {
		const onIncompatible = vi.fn();
		const health = new BridgeHealth(vi.fn(), onIncompatible);
		const ok = fakeBridge(async () => ({ ompVersion: "19.0.2", unavailable: [] }));
		await health.observe({ connected: true, ompVersion: "19.0.2", bridge: ok.bridge });
		expect(onIncompatible).not.toHaveBeenCalled();
	});
});
