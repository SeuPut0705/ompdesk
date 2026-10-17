/**
 * Mobile web (Settings › Devices & connections › Mobile web): OMPdesk's own page, served on this computer's
 * loopback and published to the user's tailnet with `tailscale serve`, so a paired phone or tablet runs the same
 * renderer. Main owns every piece of state (src/main/tailscale/ for the Tailscale side, src/main/web/ for the
 * server and the paired devices); the page only shows it and asks for changes.
 *
 * Every request here is `pairing-admin`: a web device never gets it, so a stolen cookie cannot connect another
 * device or switch the feature off. The state itself holds no secret, so a web device may read it.
 */
import type { PeerLimits, PeerUsageView } from "./ipc-types";
import type { SetupFailure, SetupProgress } from "./setup";
import { DEFAULT_WEB_GRANTS, type WebPermission } from "./web-protocol";

/** The port the loopback server listens on and `tailscale serve` publishes (HTTPS), unless it is taken there. */
export const MOBILE_WEB_PORT = 47831;

/** The whole `MobileWebState`; also what every `MOBILE_WEB_COMMAND` answers with. */
export const MOBILE_WEB_GET_STATE = "mobile-web:get-state";
export const MOBILE_WEB_COMMAND = "mobile-web:command";
/** Push: the whole `MobileWebState` changed. */
export const MOBILE_WEB_STATE = "mobile-web:state";

/** `WebDeviceInfo[]`. */
export const WEB_DEVICES_LIST = "mobile-web:devices-list";
/**
 * Block a device (`deviceId`): its record goes, its sockets close with 4401 and its tabs are released, and the block
 * (its Tailscale node, or its whole Tailscale login when serve gave no node identity: `WebDeviceInfo.blockScope`)
 * keeps it from connecting again until it is unblocked. Answers the new list.
 */
export const WEB_DEVICES_REVOKE = "mobile-web:devices-revoke";
/** `deviceId, name`. Answers the new list. */
export const WEB_DEVICES_RENAME = "mobile-web:devices-rename";
/** `deviceId, grants`. Answers the new list. */
export const WEB_DEVICES_SET_GRANTS = "mobile-web:devices-set-grants";
/** `deviceId, limits`. Answers the new list. */
export const WEB_DEVICES_SET_LIMITS = "mobile-web:devices-set-limits";
/** Push: the device list or a device's connection changed; payload is the whole `WebDeviceInfo[]`. */
export const WEB_DEVICES_CHANGED = "mobile-web:devices-changed";
/** `WebBlockedInfo[]`. */
export const WEB_BLOCKS_LIST = "mobile-web:blocks-list";
/** Lift a block (`blockId`); the device connects again on its next visit. Answers the new `WebBlockedInfo[]`. */
export const WEB_BLOCKS_REMOVE = "mobile-web:blocks-remove";
/**
 * Push to desktop windows only: a device connected for the first time (its record was just made) and the user can
 * block it from the notice (`WebDeviceConnected`). Not sent while "approve new devices" is on: the dialog asked.
 */
export const WEB_DEVICE_CONNECTED = "mobile-web:device-connected";
/** Push to desktop windows only: a new device waits for the user's decision (`WebPairingRequest`). */
export const WEB_PAIRING_REQUEST = "mobile-web:pairing-request";
/** Answer a `WebPairingRequest` (`WebPairingResponse`). */
export const WEB_PAIRING_RESPOND = "mobile-web:pairing-respond";

/** Channels a web device may never call (`pairing-admin`). */
export const MOBILE_WEB_ADMIN_CHANNELS = [
	MOBILE_WEB_COMMAND,
	WEB_DEVICES_LIST,
	WEB_DEVICES_REVOKE,
	WEB_DEVICES_RENAME,
	WEB_DEVICES_SET_GRANTS,
	WEB_DEVICES_SET_LIMITS,
	WEB_BLOCKS_LIST,
	WEB_BLOCKS_REMOVE,
	WEB_PAIRING_RESPOND,
] as const;

/**
 * Where setting Mobile web up stands. Each phase after `off` is one thing the user sees and, where a button
 * is named, one thing they (or the OS) must do next:
 *
 * - `off`: the switch is off; nothing listens, nothing is published.
 * - `detecting`: looking for Tailscale and its state.
 * - `not-installed`: no Tailscale here (`install` button).
 * - `installing`: setup is installing Tailscale (`install.progress`, cancel).
 * - `app-not-running`: installed but its app or daemon is not running (`start` button, polls).
 * - `needs-os-approval`: the OS waits for the user (macOS system-extension / VPN configuration, Windows UAC).
 * - `needs-login`: Tailscale is signed out (`login` opens the sign-in page).
 * - `logging-in`: the sign-in page is open; waiting up to ten minutes.
 * - `needs-machine-approval`: the tailnet admin must approve this computer.
 * - `https-disabled`: the tailnet has no HTTPS certificates / MagicDNS (`guideUrl` has the admin page).
 * - `serve-blocked`: `tailscale serve` refused (policy, another Windows user, Funnel on our port); `detail` says why.
 * - `starting`: starting the server and publishing it.
 * - `ready`: `url` works.
 * - `error`: anything else (`detail`).
 */
export const MOBILE_WEB_PHASES = [
	"off",
	"detecting",
	"not-installed",
	"installing",
	"app-not-running",
	"needs-os-approval",
	"needs-login",
	"logging-in",
	"needs-machine-approval",
	"https-disabled",
	"serve-blocked",
	"starting",
	"ready",
	"error",
] as const;
export type MobileWebPhase = (typeof MOBILE_WEB_PHASES)[number];

/** Which Tailscale this is: the Mac App Store app, the Standalone app, a CLI-only daemon, or Windows. */
export type TailscaleVariant = "mac-app-store" | "mac-standalone" | "mac-cli" | "windows" | "other";

export interface MobileWebTailscale {
	variant: TailscaleVariant;
	/** The executable used for every call. */
	path: string;
	version: string | null;
	/** A newer Tailscale exists (`ClientVersion` of `status --json`). */
	updateAvailable: boolean;
}

export interface MobileWebInstall {
	/** Setup's progress for the Tailscale item while it installs; null otherwise. */
	progress: SetupProgress | null;
	failure: SetupFailure | null;
	/** `tailscale.com/download`: the manual route. */
	manualUrl: string;
}

export interface MobileWebState {
	enabled: boolean;
	phase: MobileWebPhase;
	/** `https://<MagicDNS name>:<port>` while `ready`. */
	url: string | null;
	/** The MagicDNS name and the port published; null until known / while off. */
	host: string | null;
	port: number | null;
	/** The login name of the tailnet user of this computer; it is allowed by default. */
	user: string | null;
	/** Tailscale logins whose devices connect to the page without a code (the first visit makes the device). */
	allowedUsers: string[];
	/** A new device waits for the user's approval on this computer (pref `mobileWeb.confirmNewDevices`, default off). */
	confirmNewDevices: boolean;
	tailscale: MobileWebTailscale | null;
	install: MobileWebInstall | null;
	/** The sign-in page, while `needs-login` / `logging-in`. Only a Tailscale host is ever offered. */
	loginUrl: string | null;
	/** The admin page that fixes `https-disabled` / `needs-machine-approval`. */
	guideUrl: string | null;
	/** The tool's own words for `serve-blocked` / `error` (English, shown under "Details"). */
	detail: string | null;
	/** Our published port is reachable by Funnel: the server refuses to start. */
	funnelExposed: boolean;
	/** `tailscale serve` published by this OMPdesk is in place. */
	published: boolean;
	/** Peers of this tailnet user that are phones or tablets and online (wizard "phone connected" hint). */
	phones: string[];
}

/** What a button sends. `enable` and `disable` are the switch; the rest answer the phase's named next step. */
export type MobileWebRequest =
	| { action: "enable" }
	| { action: "disable" }
	| { action: "install" }
	| { action: "cancel-install" }
	| { action: "start-app" }
	| { action: "login" }
	| { action: "retry" }
	| { action: "open-system-settings" }
	| { action: "set-allowed-users"; users: string[] }
	| { action: "set-confirm-new-devices"; on: boolean }
	/** Settings is open: poll `status --json` every 2 s instead of 15 s; false when it closes. */
	| { action: "watch"; on: boolean };

/** A paired device as Settings lists it. */
export interface WebDeviceInfo {
	id: string;
	name: string;
	userAgent: string;
	/** The Tailscale login that connected it. */
	tailscaleLogin: string | null;
	createdAt: number;
	/** Epoch ms of the last request; null when it never connected after it was made. */
	lastSeenAt: number | null;
	connected: boolean;
	grants: WebPermission[];
	tier: WebDeviceTier;
	limits: PeerLimits;
	/** What the device used today (local date). */
	usage: PeerUsageView;
	/** What blocking it blocks: its Tailscale node, or (no node identity was known) every device of its login. */
	blockScope: WebBlockScope;
}

export type WebBlockScope = "node" | "login";

/** A block as Settings lists it: a node, or a whole login. */
export interface WebBlockedInfo {
	id: string;
	scope: WebBlockScope;
	/** The device's name when it was blocked. */
	name: string;
	/** The Tailscale login of the device (for a login block: the blocked login). */
	tailscaleLogin: string | null;
	blockedAt: number;
}

/** The grant presets: the approval dialog and the device row pick one; anything else is `custom`. */
export const WEB_GRANT_PRESETS = {
	full: DEFAULT_WEB_GRANTS,
	"no-desktop": DEFAULT_WEB_GRANTS.filter(permission => permission !== "desktop-control"),
	"chat-view": ["workspace", "device-self"],
} as const satisfies Record<string, readonly WebPermission[]>;

export type WebGrantPreset = keyof typeof WEB_GRANT_PRESETS;
export type WebDeviceTier = WebGrantPreset | "custom";

/** The preset whose grants are exactly `grants`, else `custom`. */
export function webDeviceTier(grants: readonly WebPermission[]): WebDeviceTier {
	const held = new Set(grants);
	for (const [name, preset] of Object.entries(WEB_GRANT_PRESETS) as [WebGrantPreset, readonly WebPermission[]][]) {
		if (preset.length === held.size && preset.every(permission => held.has(permission))) return name;
	}
	return "custom";
}

/** A device connected for the first time: what the desktop's notice names (`WEB_DEVICE_CONNECTED`). */
export interface WebDeviceConnected {
	id: string;
	name: string;
	tailscaleLogin: string | null;
}

/** A new device waits for the desktop's decision (only while "approve new devices" is on). */
export interface WebPairingRequest {
	id: string;
	name: string;
	userAgent: string;
	tailscaleLogin: string | null;
	/** The phone's Tailscale address. */
	ip: string | null;
	/** What it would be granted (the default preset). */
	grants: WebPermission[];
	expiresAt: number;
}

export interface WebPairingResponse {
	id: string;
	approve: boolean;
	/** Overrides the request's grants (the preset picked in the dialog). */
	grants?: WebPermission[];
}

export interface MobileWebApi {
	getState(): Promise<MobileWebState>;
	command(request: MobileWebRequest): Promise<MobileWebState>;
	onState(callback: (state: MobileWebState) => void): () => void;
	devices: {
		list(): Promise<WebDeviceInfo[]>;
		/** Block the device (see `WEB_DEVICES_REVOKE`). */
		revoke(deviceId: string): Promise<WebDeviceInfo[]>;
		blocked(): Promise<WebBlockedInfo[]>;
		unblock(blockId: string): Promise<WebBlockedInfo[]>;
		rename(deviceId: string, name: string): Promise<WebDeviceInfo[]>;
		setGrants(deviceId: string, grants: WebPermission[]): Promise<WebDeviceInfo[]>;
		setLimits(deviceId: string, limits: PeerLimits): Promise<WebDeviceInfo[]>;
		onChanged(callback: (devices: WebDeviceInfo[]) => void): () => void;
		/** A device connected for the first time (desktop windows only). */
		onConnected(callback: (device: WebDeviceConnected) => void): () => void;
	};
	pairing: {
		onRequest(callback: (request: WebPairingRequest) => void): () => void;
		respond(response: WebPairingResponse): Promise<void>;
	};
}

/** What the server asks of Mobile web's service (src/main/tailscale/): who may reach the page. */
export function allowedLogin(allowed: readonly string[], login: string | null): boolean {
	if (!login) return false;
	const wanted = login.trim().toLowerCase();
	return allowed.some(entry => entry.trim().toLowerCase() === wanted);
}
