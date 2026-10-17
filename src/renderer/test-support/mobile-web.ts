/**
 * A `window.omp.mobileWeb` double: `getState`/`command` answer with the state the test set, the device
 * actions answer with the current list, `blocked`/`unblock` with the current blocks, and `push*` deliver main's
 * pushes.
 */
import { vi } from "vitest";
import type {
	MobileWebApi,
	MobileWebState,
	WebBlockedInfo,
	WebDeviceConnected,
	WebDeviceInfo,
	WebPairingRequest,
} from "../../shared/mobile-web";
import { DEFAULT_WEB_GRANTS } from "../../shared/web-protocol";

export function mobileWebState(partial: Partial<MobileWebState> = {}): MobileWebState {
	return {
		enabled: false,
		phase: "off",
		url: null,
		host: null,
		port: null,
		user: "kim@example.com",
		allowedUsers: ["kim@example.com"],
		confirmNewDevices: false,
		tailscale: null,
		install: null,
		loginUrl: null,
		guideUrl: null,
		detail: null,
		funnelExposed: false,
		published: false,
		phones: [],
		...partial,
	};
}

/** A ready Mobile web: the link, this computer's own login allowed. */
export function readyMobileWebState(partial: Partial<MobileWebState> = {}): MobileWebState {
	return mobileWebState({
		enabled: true,
		phase: "ready",
		url: "https://studio.tail1234.ts.net:47831",
		host: "studio.tail1234.ts.net",
		port: 47831,
		published: true,
		...partial,
	});
}

export function webDevice(partial: Partial<WebDeviceInfo> = {}): WebDeviceInfo {
	return {
		id: "device-iphone",
		name: "iPhone",
		userAgent: "Mozilla/5.0 (iPhone)",
		tailscaleLogin: "kim@example.com",
		createdAt: Date.now() - 86_400_000,
		lastSeenAt: Date.now() - 120_000,
		connected: true,
		grants: [...DEFAULT_WEB_GRANTS],
		tier: "full",
		limits: {},
		usage: { requests: 0, tokens: 0 },
		blockScope: "node",
		...partial,
	};
}

export function blockedDevice(partial: Partial<WebBlockedInfo> = {}): WebBlockedInfo {
	return {
		id: "node:nPIXEL1",
		scope: "node",
		name: "Pixel",
		tailscaleLogin: "kim@example.com",
		blockedAt: Date.now() - 3_600_000,
		...partial,
	};
}

export function fakeMobileWeb(
	initial: MobileWebState = mobileWebState(),
	initialDevices: WebDeviceInfo[] = [],
	initialBlocked: WebBlockedInfo[] = [],
) {
	let state = initial;
	let devices = initialDevices;
	let blocked = initialBlocked;
	const stateListeners = new Set<(state: MobileWebState) => void>();
	const deviceListeners = new Set<(devices: WebDeviceInfo[]) => void>();
	const connectedListeners = new Set<(device: WebDeviceConnected) => void>();
	const requestListeners = new Set<(request: WebPairingRequest) => void>();

	const api = {
		getState: vi.fn(async () => state),
		command: vi.fn(async (_request: Parameters<MobileWebApi["command"]>[0]) => state),
		onState: vi.fn((callback: (state: MobileWebState) => void) => {
			stateListeners.add(callback);
			return () => stateListeners.delete(callback);
		}),
		devices: {
			list: vi.fn(async () => devices),
			revoke: vi.fn(async (_deviceId: string) => devices),
			blocked: vi.fn(async () => blocked),
			unblock: vi.fn(async (_blockId: string) => blocked),
			rename: vi.fn(async (_deviceId: string, _name: string) => devices),
			setGrants: vi.fn(async (_deviceId: string, _grants: WebDeviceInfo["grants"]) => devices),
			setLimits: vi.fn(async (_deviceId: string, _limits: WebDeviceInfo["limits"]) => devices),
			onChanged: vi.fn((callback: (devices: WebDeviceInfo[]) => void) => {
				deviceListeners.add(callback);
				return () => deviceListeners.delete(callback);
			}),
			onConnected: vi.fn((callback: (device: WebDeviceConnected) => void) => {
				connectedListeners.add(callback);
				return () => connectedListeners.delete(callback);
			}),
		},
		pairing: {
			onRequest: vi.fn((callback: (request: WebPairingRequest) => void) => {
				requestListeners.add(callback);
				return () => requestListeners.delete(callback);
			}),
			respond: vi.fn(async (_response: Parameters<MobileWebApi["pairing"]["respond"]>[0]) => {}),
		},
	} satisfies MobileWebApi;

	return {
		api,
		/** The state the next read or command answers with. */
		set(next: MobileWebState) {
			state = next;
		},
		/** The device list the next read or device action answers with. */
		setDevices(next: WebDeviceInfo[]) {
			devices = next;
		},
		/** The blocks the next read or unblock answers with. */
		setBlocked(next: WebBlockedInfo[]) {
			blocked = next;
		},
		/** A state push from main. */
		pushState(next: MobileWebState) {
			state = next;
			for (const listener of stateListeners) listener(next);
		},
		pushDevices(next: WebDeviceInfo[]) {
			devices = next;
			for (const listener of deviceListeners) listener(next);
		},
		/** A device connected for the first time (the desktop's notice). */
		pushConnected(device: WebDeviceConnected) {
			for (const listener of connectedListeners) listener(device);
		},
		pushRequest(request: WebPairingRequest) {
			for (const listener of requestListeners) listener(request);
		},
	};
}
