/**
 * The paired web devices: `<userData>/web-devices.json`, mode 0600, rewritten atomically on every change
 * (remote/trust-store.ts). A device's credential is the cookie `<deviceId>.<secret>`; the file keeps only the
 * secret's SHA-256, so a copy of it is not a credential. Expiry is judged here from `lastSeenAt`: 14 days
 * without a request (sliding) or 90 days since pairing (absolute). Revoking deletes the record and tells the
 * listeners, which close the device's sockets and release its tabs.
 */
import { createHash, type JsonWebKey, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { PeerLimits } from "../../shared/ipc-types";
import { DEFAULT_WEB_GRANTS, WEB_PERMISSIONS, type WebPermission } from "../../shared/web-protocol";
import { DEFAULT_WEB_PUSH_SETTINGS, WEB_PUSH_CATEGORIES, type WebPushSettings } from "../../shared/web-push";
import { randomDeviceId } from "../remote/crypto";
import type { QuotaStore } from "../remote/peer-quota";
import { TrustStore } from "../remote/trust-store";

export const SLIDING_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
export const ABSOLUTE_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;
/** `lastSeenAt` is written at most this often, so a busy socket does not rewrite the file per request. */
const TOUCH_INTERVAL_MS = 60_000;
const NAME_MAX = 80;
const USER_AGENT_MAX = 300;

export interface WebDevice {
	deviceId: string;
	name: string;
	userAgent: string;
	/** The Tailscale login that paired it. */
	tailscaleLogin: string | null;
	/** SHA-256 hex of the cookie secret. */
	secretSha256: string;
	/** The device's ECDSA P-256 public key (WebCrypto), when its page could make one (a secure context). */
	publicKeyJwk: JsonWebKey | null;
	grants: WebPermission[];
	/** This device's own interface preferences (theme, widths): kept apart from the host's. */
	uiPrefs: Record<string, unknown>;
	createdAt: number;
	lastSeenAt?: number;
	limits?: PeerLimits | undefined;
	usage?: { day: string; requests: number; tokens: number } | undefined;
	/** Web Push: this device's subscription and what it wants pushed (absent = never subscribed). */
	push?: WebPushSettings | undefined;
}

const Count = z.number().int().nonnegative();

const StoredDevice = z.object({
	deviceId: z.string().min(1),
	name: z.string(),
	userAgent: z.string(),
	tailscaleLogin: z.string().nullable(),
	secretSha256: z.string().regex(/^[0-9a-f]{64}$/),
	publicKeyJwk: z.object({}).passthrough().nullable(),
	grants: z.array(z.enum(WEB_PERMISSIONS)),
	uiPrefs: z.record(z.unknown()),
	createdAt: z.number(),
	lastSeenAt: z.number().optional(),
	limits: z.object({ requestsPerDay: Count.optional(), tokensPerDay: Count.optional() }).optional(),
	usage: z.object({ day: z.string(), requests: Count, tokens: Count }).optional(),
	push: z
		.object({
			subscription: z
				.object({
					endpoint: z.string().min(1),
					keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
				})
				.nullable(),
			hideContent: z.boolean(),
			categories: z.array(z.enum(WEB_PUSH_CATEGORIES)),
		})
		// A damaged push block costs the device its notification settings, never its pairing.
		.optional()
		.catch(undefined),
}) as unknown as z.ZodType<WebDevice>;

/** A web device never holds `pairing-admin`, whatever a caller asks for. */
export function sanitizeGrants(grants: readonly WebPermission[]): WebPermission[] {
	const wanted = new Set(grants);
	return WEB_PERMISSIONS.filter(permission => permission !== "pairing-admin" && wanted.has(permission));
}

function copyPush(push: WebPushSettings): WebPushSettings {
	return {
		subscription: push.subscription
			? { endpoint: push.subscription.endpoint, keys: { ...push.subscription.keys } }
			: null,
		hideContent: push.hideContent,
		categories: [...push.categories],
	};
}

/** A device's push settings, the defaults for one that never subscribed. */
export function pushSettingsOf(device: Pick<WebDevice, "push">): WebPushSettings {
	return copyPush(device.push ?? DEFAULT_WEB_PUSH_SETTINGS);
}

function hashSecret(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

export type AuthResult =
	| { ok: true; device: WebDevice }
	| { ok: false; reason: "malformed" | "unknown" | "mismatch" | "expired" };

export interface NewWebDevice {
	name: string;
	userAgent: string;
	tailscaleLogin: string | null;
	publicKeyJwk: JsonWebKey | null;
	grants?: readonly WebPermission[];
}

export type DevicesListener = () => void;

export class WebDevices implements QuotaStore {
	readonly #store: TrustStore<WebDevice>;
	readonly #now: () => number;
	readonly #onRevoked = new Set<(deviceId: string) => void>();
	readonly #onChanged = new Set<DevicesListener>();

	constructor(userData: string, now: () => number = Date.now) {
		this.#store = new TrustStore<WebDevice>(join(userData, "web-devices.json"), "devices", StoredDevice, device => ({
			...device,
			grants: [...device.grants],
			uiPrefs: { ...device.uiPrefs },
			publicKeyJwk: device.publicKeyJwk ? { ...device.publicKeyJwk } : null,
			...(device.limits ? { limits: { ...device.limits } } : {}),
			...(device.usage ? { usage: { ...device.usage } } : {}),
			...(device.push ? { push: copyPush(device.push) } : {}),
		}));
		this.#now = now;
	}

	list(): WebDevice[] {
		return this.#store.list();
	}

	get(deviceId: string): WebDevice | undefined {
		return this.#store.get(deviceId);
	}

	/** Called with the id of every device removed (revoked or expired) after its record is gone. */
	onRevoked(listener: (deviceId: string) => void): () => void {
		this.#onRevoked.add(listener);
		return () => this.#onRevoked.delete(listener);
	}

	/** Called after any change to the list (added, renamed, regranted, limits, usage, removed). */
	onChanged(listener: DevicesListener): () => void {
		this.#onChanged.add(listener);
		return () => this.#onChanged.delete(listener);
	}

	/** Pair a device; `cookie` is the only time its secret exists in the clear. */
	create(init: NewWebDevice): { device: WebDevice; cookie: string } {
		const secret = randomBytes(32).toString("base64url");
		const deviceId = randomDeviceId();
		const now = this.#now();
		const device: WebDevice = {
			deviceId,
			name: init.name.trim().slice(0, NAME_MAX) || "Phone",
			userAgent: init.userAgent.slice(0, USER_AGENT_MAX),
			tailscaleLogin: init.tailscaleLogin,
			secretSha256: hashSecret(secret),
			publicKeyJwk: init.publicKeyJwk,
			grants: sanitizeGrants(init.grants ?? DEFAULT_WEB_GRANTS),
			uiPrefs: {},
			createdAt: now,
			lastSeenAt: now,
		};
		this.#store.put(device);
		this.#changed();
		return { device, cookie: `${deviceId}.${secret}` };
	}

	/** Who a cookie value belongs to; an expired device is removed, a malformed or wrong one changes nothing. */
	authenticate(cookie: string): AuthResult {
		const separator = cookie.indexOf(".");
		if (separator <= 0 || separator === cookie.length - 1) return { ok: false, reason: "malformed" };
		const device = this.#store.get(cookie.slice(0, separator));
		if (!device) return { ok: false, reason: "unknown" };
		const given = Buffer.from(hashSecret(cookie.slice(separator + 1)), "hex");
		if (!timingSafeEqual(given, Buffer.from(device.secretSha256, "hex"))) return { ok: false, reason: "mismatch" };
		const now = this.#now();
		const lastSeen = device.lastSeenAt ?? device.createdAt;
		if (now - device.createdAt > ABSOLUTE_EXPIRY_MS || now - lastSeen > SLIDING_EXPIRY_MS) {
			this.revoke(device.deviceId);
			return { ok: false, reason: "expired" };
		}
		if (now - lastSeen >= TOUCH_INTERVAL_MS) {
			const touched = this.#store.update(device.deviceId, { lastSeenAt: now });
			return { ok: true, device: touched ?? device };
		}
		return { ok: true, device };
	}

	/** Delete a device: its credential stops working and the listeners close its sockets and free its tabs. */
	revoke(deviceId: string): boolean {
		if (!this.#store.remove(deviceId)) return false;
		for (const listener of this.#onRevoked) listener(deviceId);
		this.#changed();
		return true;
	}

	rename(deviceId: string, name: string): boolean {
		const trimmed = name.trim().slice(0, NAME_MAX);
		if (trimmed === "") return false;
		const updated = this.#store.update(deviceId, { name: trimmed });
		if (updated) this.#changed();
		return updated !== undefined;
	}

	setGrants(deviceId: string, grants: readonly WebPermission[]): boolean {
		const updated = this.#store.update(deviceId, { grants: sanitizeGrants(grants) });
		if (updated) this.#changed();
		return updated !== undefined;
	}

	setUiPrefs(deviceId: string, uiPrefs: Record<string, unknown>): boolean {
		return this.#store.update(deviceId, { uiPrefs }) !== undefined;
	}

	/** Replace a device's push settings (its subscription, what it hides, what it wants). */
	setPush(deviceId: string, push: WebPushSettings): boolean {
		return this.#store.update(deviceId, { push }) !== undefined;
	}

	/** The push service said the subscription is gone (404/410): forget it, unless the device has since sent a new one. */
	forgetPushSubscription(deviceId: string, endpoint: string): boolean {
		const device = this.#store.get(deviceId);
		if (device?.push?.subscription?.endpoint !== endpoint) return false;
		return this.#store.update(deviceId, { push: { ...device.push, subscription: null } }) !== undefined;
	}

	/** The VAPID keypair was made anew: every subscription was made against the old key and is dead. */
	dropAllPushSubscriptions(): number {
		let dropped = 0;
		for (const device of this.#store.list()) {
			if (!device.push?.subscription) continue;
			this.#store.update(device.deviceId, { push: { ...device.push, subscription: null } });
			dropped++;
		}
		return dropped;
	}

	/** Quota's write path (peer-quota.ts): usage and limits ride the device record. */
	update(deviceId: string, patch: Pick<WebDevice, "limits" | "usage">): WebDevice | undefined {
		return this.#store.update(deviceId, patch);
	}

	/** The list changed in a way the settings page shows (a connection came or went, usage moved). */
	notifyChanged(): void {
		this.#changed();
	}

	#changed(): void {
		for (const listener of this.#onChanged) listener();
	}
}
