/**
 * A `window.omp.mobileWeb` double: `getState`/`command` answer with the state the test set, the device
 * actions answer with the current list, and `push*` deliver main's pushes.
 */
import { vi } from "vitest";
import type {
	MobileWebApi,
	MobileWebState,
	WebDeviceInfo,
	WebPairingCode,
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
		...partial,
	};
}

export function fakeMobileWeb(initial: MobileWebState = mobileWebState(), initialDevices: WebDeviceInfo[] = []) {
	let state = initial;
	let devices = initialDevices;
	const stateListeners = new Set<(state: MobileWebState) => void>();
	const deviceListeners = new Set<(devices: WebDeviceInfo[]) => void>();
	const requestListeners = new Set<(request: WebPairingRequest) => void>();
	let nextCode: WebPairingCode = { code: "K7QM2XDP", expiresAt: Date.now() + 10 * 60_000 };

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
			rename: vi.fn(async (_deviceId: string, _name: string) => devices),
			setGrants: vi.fn(async (_deviceId: string, _grants: WebDeviceInfo["grants"]) => devices),
			setLimits: vi.fn(async (_deviceId: string, _limits: WebDeviceInfo["limits"]) => devices),
			onChanged: vi.fn((callback: (devices: WebDeviceInfo[]) => void) => {
				deviceListeners.add(callback);
				return () => deviceListeners.delete(callback);
			}),
		},
		pairing: {
			newCode: vi.fn(async () => nextCode),
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
		/** The code the next `newCode()` answers with. */
		setCode(next: WebPairingCode) {
			nextCode = next;
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
		pushRequest(request: WebPairingRequest) {
			for (const listener of requestListeners) listener(request);
		},
	};
}
