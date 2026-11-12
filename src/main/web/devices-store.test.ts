import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WEB_GRANTS } from "../../shared/web-protocol";
import { PeerQuota } from "../remote/peer-quota";
import { pushSettingsOf, sanitizeGrants, type WebDevice, WebDevices } from "./devices-store";
import { seededDevice, writeWebDevices } from "./test-web-devices";

// The devices are the core's (crates/core/src/web/store.rs): these cases run against the real process. A device is
// paired by the web edge, which the Rust tests cover (cookie check, expiry, never `pairing-admin` on a new device),
// so a case here that needed one starts from a file the edge's format fills (`seededDevice`).
let dir: string;
const opened: WebDevices[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "web-devices-"));
});
afterEach(async () => {
	// Every write is on disk before the folder goes, or the core's writer would make it again.
	for (const store of opened.splice(0)) {
		await store.flush();
		store.close();
	}
	rmSync(dir, { recursive: true, force: true });
});

const store = async (folder = dir): Promise<WebDevices> => {
	const devices = new WebDevices(folder);
	opened.push(devices);
	await devices.ready();
	return devices;
};
const fileOf = (folder = dir) =>
	JSON.parse(readFileSync(join(folder, "web-devices.json"), "utf8")) as { v: number; devices: Partial<WebDevice>[] };

describe("WebDevices", () => {
	it("reads the core's list once ready, keeps only the secret's hash in a 0600 file and rewrites it on a change", async () => {
		const { record, cookie } = seededDevice({ name: "iPhone" });
		writeWebDevices(dir, [record]);
		const devices = new WebDevices(dir);
		opened.push(devices);
		expect(devices.list()).toEqual([]);
		await devices.ready();
		expect(devices.get(record.deviceId)).toEqual(record);
		expect(devices.rename(record.deviceId, "Kitchen")).toBe(true);
		await devices.flush();
		const file = join(dir, "web-devices.json");
		const text = readFileSync(file, "utf8");
		expect(text).not.toContain(cookie.slice(cookie.indexOf(".") + 1));
		expect(text).toContain(record.secretSha256);
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(fileOf().devices[0]).toMatchObject({ deviceId: record.deviceId, name: "Kitchen" });
	});

	it("never grants pairing-admin, however it is asked", async () => {
		const { record } = seededDevice({ grants: ["workspace"] });
		writeWebDevices(dir, [record]);
		const devices = await store();
		expect(devices.setGrants(record.deviceId, ["pairing-admin", "device-self"])).toBe(true);
		expect(devices.get(record.deviceId)?.grants).toEqual(["device-self"]);
		await devices.flush();
		expect(fileOf().devices[0]?.grants).toEqual(["device-self"]);
		expect(sanitizeGrants(DEFAULT_WEB_GRANTS)).toEqual([...DEFAULT_WEB_GRANTS]);
		expect(DEFAULT_WEB_GRANTS).not.toContain("pairing-admin");
		expect(devices.setGrants("ghost", ["workspace"])).toBe(false);
	});

	it("revoking deletes the record and tells the listeners once, however often the core answers", async () => {
		const { record } = seededDevice();
		writeWebDevices(dir, [record]);
		const devices = await store();
		const revoked = vi.fn();
		const changed = vi.fn();
		devices.onRevoked(revoked);
		devices.onChanged(changed);
		expect(devices.revoke(record.deviceId)).toBe(true);
		expect(devices.revoke(record.deviceId)).toBe(false);
		expect(devices.get(record.deviceId)).toBeUndefined();
		await devices.flush();
		expect(revoked).toHaveBeenCalledExactlyOnceWith(record.deviceId);
		expect(changed).toHaveBeenCalledTimes(1);
		expect(fileOf().devices).toEqual([]);
	});

	it("keeps the Tailscale node a device came from, and reads an older record that has none", async () => {
		const withNode = seededDevice({ name: "Node", nodeId: "nPHONE1" }).record;
		const older: Record<string, unknown> = { ...seededDevice({ name: "Old" }).record };
		delete older.nodeId;
		writeWebDevices(dir, [withNode, older]);
		const devices = await store();
		expect(devices.get(withNode.deviceId)?.nodeId).toBe("nPHONE1");
		expect(devices.get(older.deviceId as string)?.nodeId ?? null).toBeNull();
	});

	it("renames, trims, and refuses an empty name", async () => {
		const { record } = seededDevice();
		writeWebDevices(dir, [record]);
		const devices = await store();
		expect(devices.rename(record.deviceId, "  Kitchen iPad ")).toBe(true);
		expect(devices.get(record.deviceId)?.name).toBe("Kitchen iPad");
		expect(devices.rename(record.deviceId, "   ")).toBe(false);
		expect(devices.rename("ghost", "x")).toBe(false);
		await devices.flush();
		expect(fileOf().devices[0]?.name, "the core trims the same way").toBe("Kitchen iPad");
	});

	it("drops a corrupt entry alone and keeps the rest", async () => {
		const first = seededDevice({ name: "iPhone" }).record;
		const second = seededDevice({ name: "Pad" }).record;
		writeWebDevices(dir, [{ deviceId: "broken" }, first, second]);
		const devices = await store();
		expect(
			devices
				.list()
				.map(device => device.name)
				.sort(),
		).toEqual(["Pad", "iPhone"]);
		expect(devices.get(second.deviceId)).toBeDefined();
	});

	it("lists what is in the folder to every store over it and keeps its changes in one place", async () => {
		const { record } = seededDevice();
		writeWebDevices(dir, [record]);
		const first = await store();
		const second = await store();
		first.rename(record.deviceId, "Changed here");
		expect(second.get(record.deviceId)?.name).toBe("Changed here");
	});
});

describe("push settings on a web device", () => {
	const subscription = (name: string) => ({
		endpoint: `https://push.example.com/${name}`,
		keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
	});
	const seeded = async () => {
		const { record } = seededDevice();
		writeWebDevices(dir, [record]);
		return { devices: await store(), device: record };
	};

	it("starts without any and reads as the defaults", async () => {
		const { device } = await seeded();
		expect(device.push).toBeUndefined();
		expect(pushSettingsOf(device)).toEqual({
			subscription: null,
			hideContent: false,
			categories: ["completion", "error", "ask"],
		});
		// A copy: changing it touches nothing stored.
		pushSettingsOf(device).categories = [];
		expect(pushSettingsOf(device).categories).toHaveLength(3);
	});

	it("persists a subscription with its preferences, and the file keeps it", async () => {
		const { devices, device } = await seeded();
		const push = { subscription: subscription("a"), hideContent: true, categories: ["ask"] as const };
		expect(devices.setPush(device.deviceId, push)).toBe(true);
		await devices.flush();
		expect(fileOf().devices[0]?.push).toEqual(push);
		expect(devices.get(device.deviceId)?.push).toEqual(push);
		expect(devices.setPush("ghost", push)).toBe(false);
	});

	it("keeps the device when only its push block is damaged", async () => {
		const { record } = seededDevice({ name: "iPhone" });
		writeWebDevices(dir, [{ ...record, push: { subscription: { endpoint: 1 }, hideContent: "x" } }]);
		const reloaded = (await store()).get(record.deviceId);
		expect(reloaded).toMatchObject({ deviceId: record.deviceId, name: "iPhone" });
		expect(reloaded?.push).toBeUndefined();
	});

	it("forgets a subscription only while it is still the one the push service refused", async () => {
		const { devices, device } = await seeded();
		const old = subscription("old");
		devices.setPush(device.deviceId, { subscription: old, hideContent: true, categories: ["error"] });
		const fresh = subscription("fresh");
		devices.setPush(device.deviceId, { subscription: fresh, hideContent: true, categories: ["error"] });
		expect(devices.forgetPushSubscription(device.deviceId, old.endpoint)).toBe(false);
		expect(devices.get(device.deviceId)?.push?.subscription).toEqual(fresh);
		expect(devices.forgetPushSubscription(device.deviceId, fresh.endpoint)).toBe(true);
		expect(devices.get(device.deviceId)?.push).toEqual({
			subscription: null,
			hideContent: true,
			categories: ["error"],
		});
		expect(devices.forgetPushSubscription(device.deviceId, fresh.endpoint)).toBe(false);
		expect(devices.forgetPushSubscription("ghost", fresh.endpoint)).toBe(false);
		await devices.flush();
		expect(fileOf().devices[0]?.push).toEqual({ subscription: null, hideContent: true, categories: ["error"] });
	});

	it("drops every subscription when the VAPID keypair was made anew, keeping the preferences", async () => {
		const a = seededDevice({ name: "iPhone" }).record;
		const b = seededDevice({ name: "Pad" }).record;
		const never = seededDevice({ name: "Mac" }).record;
		writeWebDevices(dir, [a, b, never]);
		const devices = await store();
		devices.setPush(a.deviceId, { subscription: subscription("a"), hideContent: true, categories: ["ask"] });
		devices.setPush(b.deviceId, { subscription: subscription("b"), hideContent: false, categories: ["error"] });
		expect(devices.dropAllPushSubscriptions()).toBe(2);
		expect(devices.get(a.deviceId)?.push).toEqual({ subscription: null, hideContent: true, categories: ["ask"] });
		expect(devices.get(b.deviceId)?.push?.subscription).toBeNull();
		expect(devices.get(never.deviceId)?.push).toBeUndefined();
		expect(devices.dropAllPushSubscriptions()).toBe(0);
		await devices.flush();
		const [first, second, third] = fileOf().devices;
		expect(first?.push).toEqual({ subscription: null, hideContent: true, categories: ["ask"] });
		expect(second?.push?.subscription).toBeNull();
		expect(third?.push).toBeUndefined();
	});

	it("goes with the device on revoke", async () => {
		const { devices, device } = await seeded();
		devices.setPush(device.deviceId, { subscription: subscription("a"), hideContent: false, categories: ["ask"] });
		devices.revoke(device.deviceId);
		await devices.flush();
		expect(readFileSync(join(dir, "web-devices.json"), "utf8")).not.toContain("push.example.com");
	});
});

describe("model quota on a web device", () => {
	it("counts reservations against the device's daily limit and keeps usage on its record", async () => {
		const { record } = seededDevice();
		writeWebDevices(dir, [record]);
		const devices = await store();
		const now = Date.parse("2026-11-12T12:00:00");
		const quota = new PeerQuota(
			devices,
			() => {},
			() => new Date(now),
		);
		quota.setLimits(record.deviceId, { requestsPerDay: 2 });
		const first = quota.reserve(record.deviceId);
		expect(first.ok).toBe(true);
		expect(quota.reserve(record.deviceId).ok).toBe(true);
		expect(quota.reserve(record.deviceId)).toEqual({ ok: false, refusal: "requests" });
		if (first.ok) first.refund();
		expect(quota.reserve(record.deviceId).ok).toBe(true);
		quota.record(record.deviceId, { tokens: 500 });
		await devices.flush();
		const stored = fileOf().devices[0];
		expect(stored?.usage).toMatchObject({ requests: 2, tokens: 500 });
		expect(stored?.limits).toEqual({ requestsPerDay: 2 });
		expect(devices.get(record.deviceId)?.usage).toMatchObject({ requests: 2, tokens: 500 });
		quota.setLimits(record.deviceId, {});
		await devices.flush();
		expect(fileOf().devices[0]?.limits, "an empty object removes the limits").toBeUndefined();
	});
});
