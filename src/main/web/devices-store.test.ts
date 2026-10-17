import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WEB_GRANTS } from "../../shared/web-protocol";
import { PeerQuota } from "../remote/peer-quota";
import { ABSOLUTE_EXPIRY_MS, pushSettingsOf, SLIDING_EXPIRY_MS, sanitizeGrants, WebDevices } from "./devices-store";

const DAY = 24 * 60 * 60 * 1000;
let dir: string;
let now: number;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "web-devices-"));
	now = 1_700_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const store = () => new WebDevices(dir, () => now);
const phone = {
	name: "iPhone",
	userAgent: "Mozilla/5.0 (iPhone)",
	tailscaleLogin: "me@example.com",
	publicKeyJwk: null,
};

describe("WebDevices", () => {
	it("stores only the secret's hash, in a 0600 file, and the cookie authenticates", () => {
		const devices = store();
		const { device, cookie } = devices.create(phone);
		const secret = cookie.slice(cookie.indexOf(".") + 1);
		const file = join(dir, "web-devices.json");
		const text = readFileSync(file, "utf8");
		expect(text).not.toContain(secret);
		expect(text).toContain(device.secretSha256);
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(devices.authenticate(cookie)).toMatchObject({ ok: true, device: { deviceId: device.deviceId } });
		expect(new WebDevices(dir, () => now).authenticate(cookie)).toMatchObject({ ok: true });
	});

	it("refuses malformed, unknown and wrong-secret cookies without touching the record", () => {
		const devices = store();
		const { device, cookie } = devices.create(phone);
		expect(devices.authenticate("nodot")).toEqual({ ok: false, reason: "malformed" });
		expect(devices.authenticate(`${device.deviceId}.`)).toEqual({ ok: false, reason: "malformed" });
		expect(devices.authenticate("ghost.secret")).toEqual({ ok: false, reason: "unknown" });
		expect(devices.authenticate(`${device.deviceId}.${"x".repeat(43)}`)).toEqual({ ok: false, reason: "mismatch" });
		expect(devices.authenticate(cookie)).toMatchObject({ ok: true });
	});

	it("never grants pairing-admin, however it is asked", () => {
		const devices = store();
		const { device } = devices.create({ ...phone, grants: ["workspace", "pairing-admin"] });
		expect(device.grants).toEqual(["workspace"]);
		expect(devices.setGrants(device.deviceId, ["pairing-admin", "device-self"])).toBe(true);
		expect(devices.get(device.deviceId)?.grants).toEqual(["device-self"]);
		expect(sanitizeGrants(DEFAULT_WEB_GRANTS)).toEqual([...DEFAULT_WEB_GRANTS]);
		expect(DEFAULT_WEB_GRANTS).not.toContain("pairing-admin");
	});

	it("expires after 14 days without a request, and each request slides the window", () => {
		const devices = store();
		const { device, cookie } = devices.create(phone);
		for (let step = 0; step < 6; step++) {
			now += 13 * DAY;
			expect(devices.authenticate(cookie), `step ${step}`).toMatchObject({ ok: true });
		}
		now += SLIDING_EXPIRY_MS + 1;
		expect(devices.authenticate(cookie)).toEqual({ ok: false, reason: "expired" });
		expect(devices.get(device.deviceId)).toBeUndefined();
	});

	it("expires 90 days after pairing however recently it was used", () => {
		const devices = store();
		const { device, cookie } = devices.create(phone);
		for (let step = 0; step < 8; step++) {
			now += 10 * DAY;
			expect(devices.authenticate(cookie)).toMatchObject({ ok: true });
		}
		now = device.createdAt + ABSOLUTE_EXPIRY_MS + 1000;
		expect(devices.authenticate(cookie)).toEqual({ ok: false, reason: "expired" });
	});

	it("revoking deletes the record, kills the cookie and tells the listeners once", () => {
		const devices = store();
		const revoked = vi.fn();
		const changed = vi.fn();
		devices.onRevoked(revoked);
		devices.onChanged(changed);
		const { device, cookie } = devices.create(phone);
		expect(changed).toHaveBeenCalledTimes(1);
		expect(devices.revoke(device.deviceId)).toBe(true);
		expect(devices.revoke(device.deviceId)).toBe(false);
		expect(revoked).toHaveBeenCalledExactlyOnceWith(device.deviceId);
		expect(devices.authenticate(cookie)).toEqual({ ok: false, reason: "unknown" });
		expect(store().list()).toEqual([]);
	});

	it("keeps the Tailscale node a device came from, and reads an older record that has none", () => {
		const devices = store();
		const withNode = devices.create({ ...phone, nodeId: "nPHONE1" }).device;
		const without = devices.create({ ...phone, name: "Old" }).device;
		expect(withNode.nodeId).toBe("nPHONE1");
		expect(without.nodeId).toBeNull();
		const file = join(dir, "web-devices.json");
		const parsed = JSON.parse(readFileSync(file, "utf8")) as {
			devices: Array<{ deviceId: string; nodeId?: unknown }>;
		};
		for (const entry of parsed.devices) if (entry.deviceId === without.deviceId) delete entry.nodeId;
		writeFileSync(file, JSON.stringify(parsed));
		const reloaded = new WebDevices(dir, () => now);
		expect(reloaded.get(withNode.deviceId)?.nodeId).toBe("nPHONE1");
		expect(reloaded.get(without.deviceId)?.nodeId ?? null).toBeNull();
	});

	it("renames, trims, and refuses an empty name", () => {
		const devices = store();
		const { device } = devices.create({ ...phone, name: "  " });
		expect(device.name).toBe("Phone");
		expect(devices.rename(device.deviceId, "  Kitchen iPad ")).toBe(true);
		expect(devices.get(device.deviceId)?.name).toBe("Kitchen iPad");
		expect(devices.rename(device.deviceId, "   ")).toBe(false);
		expect(devices.rename("ghost", "x")).toBe(false);
	});

	it("drops a corrupt entry alone and keeps the rest", () => {
		const devices = store();
		devices.create(phone);
		const second = devices.create({ ...phone, name: "Pad" });
		const file = join(dir, "web-devices.json");
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { v: number; devices: unknown[] };
		parsed.devices.unshift({ deviceId: "broken" });
		writeFileSync(file, JSON.stringify(parsed));
		const reloaded = new WebDevices(dir, () => now);
		expect(
			reloaded
				.list()
				.map(device => device.name)
				.sort(),
		).toEqual(["Pad", "iPhone"]);
		expect(reloaded.get(second.device.deviceId)).toBeDefined();
	});
});

describe("push settings on a web device", () => {
	const subscription = (name: string) => ({
		endpoint: `https://push.example.com/${name}`,
		keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
	});

	it("starts without any and reads as the defaults", () => {
		const { device } = store().create(phone);
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

	it("persists a subscription with its preferences, and the file keeps it across a reload", () => {
		const devices = store();
		const { device } = devices.create(phone);
		const push = { subscription: subscription("a"), hideContent: true, categories: ["ask"] as const };
		expect(devices.setPush(device.deviceId, push)).toBe(true);
		expect(new WebDevices(dir, () => now).get(device.deviceId)?.push).toEqual(push);
		expect(devices.setPush("ghost", push)).toBe(false);
	});

	it("keeps the device when only its push block is damaged", () => {
		const devices = store();
		const { device } = devices.create(phone);
		devices.setPush(device.deviceId, { subscription: subscription("a"), hideContent: false, categories: ["ask"] });
		const file = join(dir, "web-devices.json");
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { devices: Array<{ push: unknown }> };
		for (const entry of parsed.devices) entry.push = { subscription: { endpoint: 1 }, hideContent: "x" };
		writeFileSync(file, JSON.stringify({ v: 1, ...parsed }));
		const reloaded = new WebDevices(dir, () => now).get(device.deviceId);
		expect(reloaded).toMatchObject({ deviceId: device.deviceId, name: "iPhone" });
		expect(reloaded?.push).toBeUndefined();
	});

	it("forgets a subscription only while it is still the one the push service refused", () => {
		const devices = store();
		const { device } = devices.create(phone);
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
	});

	it("drops every subscription when the VAPID keypair was made anew, keeping the preferences", () => {
		const devices = store();
		const a = devices.create(phone).device;
		const b = devices.create({ ...phone, name: "Pad" }).device;
		const never = devices.create({ ...phone, name: "Mac" }).device;
		devices.setPush(a.deviceId, { subscription: subscription("a"), hideContent: true, categories: ["ask"] });
		devices.setPush(b.deviceId, { subscription: subscription("b"), hideContent: false, categories: ["error"] });
		expect(devices.dropAllPushSubscriptions()).toBe(2);
		expect(devices.get(a.deviceId)?.push).toEqual({ subscription: null, hideContent: true, categories: ["ask"] });
		expect(devices.get(b.deviceId)?.push?.subscription).toBeNull();
		expect(devices.get(never.deviceId)?.push).toBeUndefined();
		expect(devices.dropAllPushSubscriptions()).toBe(0);
	});

	it("goes with the device on revoke", () => {
		const devices = store();
		const { device } = devices.create(phone);
		devices.setPush(device.deviceId, { subscription: subscription("a"), hideContent: false, categories: ["ask"] });
		devices.revoke(device.deviceId);
		expect(readFileSync(join(dir, "web-devices.json"), "utf8")).not.toContain("push.example.com");
	});
});

describe("model quota on a web device", () => {
	it("counts reservations against the device's daily limit and keeps usage on its record", () => {
		const devices = store();
		const { device } = devices.create(phone);
		const quota = new PeerQuota(
			devices,
			() => {},
			() => new Date(now),
		);
		quota.setLimits(device.deviceId, { requestsPerDay: 2 });
		const first = quota.reserve(device.deviceId);
		expect(first.ok).toBe(true);
		expect(quota.reserve(device.deviceId).ok).toBe(true);
		expect(quota.reserve(device.deviceId)).toEqual({ ok: false, refusal: "requests" });
		if (first.ok) first.refund();
		expect(quota.reserve(device.deviceId).ok).toBe(true);
		quota.record(device.deviceId, { tokens: 500 });
		const stored = store().get(device.deviceId);
		expect(stored?.usage).toMatchObject({ requests: 2, tokens: 500 });
		expect(stored?.limits).toEqual({ requestsPerDay: 2 });
	});
});
