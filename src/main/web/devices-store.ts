/**
 * The paired web devices, as main reads and changes them. The list is the core's (`<userData>/web-devices.json`,
 * mode 0600, only each secret's SHA-256; `native/ompdesk/crates/core/src/web/store.rs`): the web edge pairs, checks
 * and expires devices there, and the same objects answer main's requests. `WebDevices` keeps a copy for the callers
 * that read in the same tick (the router's grants, `PeerQuota`, the push notifier), changes it at once and sends each
 * change to the core as an ordered push (`web-stores-client.ts`). The core's answer replaces the copy, so a rule the
 * copy applied differently from the core is corrected as soon as the answer comes.
 *
 * Call `ready()` before reading: until the core's list is in, the copy is empty.
 */
import type { JsonWebKey } from "node:crypto";
import type { PeerLimits } from "../../shared/ipc-types";
import { WEB_PERMISSIONS, type WebPermission } from "../../shared/web-protocol";
import { DEFAULT_WEB_PUSH_SETTINGS, type WebPushSettings } from "../../shared/web-push";
import type { QuotaStore } from "../remote/peer-quota";
import { acquireChannel, releaseChannel, type StoresChannel } from "./web-stores-client";

const NAME_MAX = 80;

export interface WebDevice {
	deviceId: string;
	name: string;
	userAgent: string;
	/** The Tailscale login that connected it. */
	tailscaleLogin: string | null;
	/** The device's Tailscale node (`tailscale whois` stable ID) when serve and whois gave one; blocking keys on it. */
	nodeId?: string | null | undefined;
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

function copyDevice(device: WebDevice): WebDevice {
	return {
		...device,
		grants: [...device.grants],
		uiPrefs: { ...device.uiPrefs },
		publicKeyJwk: device.publicKeyJwk ? { ...device.publicKeyJwk } : null,
		...(device.limits ? { limits: { ...device.limits } } : {}),
		...(device.usage ? { usage: { ...device.usage } } : {}),
		...(device.push ? { push: copyPush(device.push) } : {}),
	};
}

export type DevicesListener = () => void;

export class WebDevices implements QuotaStore {
	readonly #channel: StoresChannel;

	constructor(userData: string) {
		this.#channel = acquireChannel(userData);
	}

	/** Resolves once the core's list is in. */
	ready(): Promise<void> {
		return this.#channel.ready();
	}

	/** Resolves once every change made so far (here or by the edge) is on disk. */
	flush(): Promise<void> {
		return this.#channel.flush();
	}

	/** Lets go of the core's list; the copy goes with the last holder. */
	close(): void {
		releaseChannel(this.#channel);
	}

	list(): WebDevice[] {
		return this.#channel.devices.list.map(copyDevice);
	}

	get(deviceId: string): WebDevice | undefined {
		const device = this.#channel.devices.list.find(other => other.deviceId === deviceId);
		return device && copyDevice(device);
	}

	/** Called with the id of every device removed (revoked or expired) after its record is gone. */
	onRevoked(listener: (deviceId: string) => void): () => void {
		this.#channel.revokedListeners.add(listener);
		return () => this.#channel.revokedListeners.delete(listener);
	}

	/** Called after any change to the list (paired, renamed, regranted, removed). */
	onChanged(listener: DevicesListener): () => void {
		this.#channel.devicesListeners.add(listener);
		return () => this.#channel.devicesListeners.delete(listener);
	}

	/** Delete a device: its credential stops working and the listeners close its sockets and free its tabs. */
	revoke(deviceId: string): boolean {
		if (!this.#channel.devices.list.some(device => device.deviceId === deviceId)) return false;
		this.#channel.devices.list = this.#channel.devices.list.filter(device => device.deviceId !== deviceId);
		this.#channel.pushDevices("revoke", { deviceId });
		for (const listener of [...this.#channel.revokedListeners]) listener(deviceId);
		this.notifyChanged();
		return true;
	}

	rename(deviceId: string, name: string): boolean {
		const trimmed = name.trim().slice(0, NAME_MAX);
		if (trimmed === "") return false;
		if (!this.#change(deviceId, { name: trimmed })) return false;
		this.#channel.pushDevices("rename", { deviceId, name });
		this.notifyChanged();
		return true;
	}

	setGrants(deviceId: string, grants: readonly WebPermission[]): boolean {
		if (!this.#change(deviceId, { grants: sanitizeGrants(grants) })) return false;
		this.#channel.pushDevices("setGrants", { deviceId, grants });
		this.notifyChanged();
		return true;
	}

	setUiPrefs(deviceId: string, uiPrefs: Record<string, unknown>): boolean {
		if (!this.#change(deviceId, { uiPrefs })) return false;
		this.#channel.pushDevices("setUiPrefs", { deviceId, uiPrefs });
		return true;
	}

	/** Replace a device's push settings (its subscription, what it hides, what it wants). */
	setPush(deviceId: string, push: WebPushSettings): boolean {
		if (!this.#change(deviceId, { push })) return false;
		this.#channel.pushDevices("setPush", { deviceId, push });
		return true;
	}

	/** The push service said the subscription is gone (404/410): forget it, unless the device has since sent a new one. */
	forgetPushSubscription(deviceId: string, endpoint: string): boolean {
		const push = this.get(deviceId)?.push;
		if (push?.subscription?.endpoint !== endpoint) return false;
		this.#change(deviceId, { push: { ...push, subscription: null } });
		this.#channel.pushDevices("forgetPush", { deviceId, endpoint });
		return true;
	}

	/**
	 * The VAPID keypair was made anew: every subscription was made against the old key and is dead. The core drops
	 * its own list's, so this works before `ready()` too (the count is the copy's, 0 while it is empty).
	 */
	dropAllPushSubscriptions(): number {
		let dropped = 0;
		for (const device of this.#channel.devices.list) {
			if (!device.push?.subscription) continue;
			this.#change(device.deviceId, { push: { ...device.push, subscription: null } });
			dropped++;
		}
		this.#channel.pushDevices("dropAllPush", {});
		return dropped;
	}

	/** Quota's write path (peer-quota.ts): usage and limits ride the device record. A member set to undefined is removed. */
	update(deviceId: string, patch: Pick<WebDevice, "limits" | "usage">): WebDevice | undefined {
		if (!this.#change(deviceId, patch)) return undefined;
		const sent: Record<string, unknown> = {};
		if ("limits" in patch) sent.limits = patch.limits ?? null;
		if ("usage" in patch) sent.usage = patch.usage ?? null;
		this.#channel.pushDevices("update", { deviceId, patch: sent });
		return this.get(deviceId);
	}

	/** The list changed in a way the settings page shows (a connection came or went, usage moved). */
	notifyChanged(): void {
		for (const listener of [...this.#channel.devicesListeners]) listener();
	}

	/** Applies `patch` to the copy of a device (a member set to undefined is removed); false when there is none. */
	#change(deviceId: string, patch: Partial<WebDevice>): boolean {
		const list = this.#channel.devices.list;
		const current = list.find(device => device.deviceId === deviceId);
		if (!current) return false;
		const next = Object.fromEntries(
			Object.entries({ ...current, ...patch }).filter(([, value]) => value !== undefined),
		) as unknown as WebDevice;
		this.#channel.devices.list = list.map(device => (device === current ? copyDevice(next) : device));
		return true;
	}
}
