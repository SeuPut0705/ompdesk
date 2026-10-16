/**
 * The paired web client's wire contract (mobile web over Tailscale): the JSON frames its WebSocket carries,
 * the permissions a device is granted, and the features a host offers. The renderer's calls keep their
 * Electron channels and payloads (`createOmpApi` over a WebSocket transport); these frames only carry them.
 */
import type { IpcErrorCode } from "./ipc-error-codes";

/** Bumped only by a change an older page cannot follow; added frames and fields keep it. */
export const WEB_PROTOCOL_VERSION = 1;

/**
 * What a call may do, declared per channel (main/web/ipc-policy.ts). `workspace` already runs code as the
 * host user, so the others are guard rails rather than a sandbox; the real boundary is pairing, and a web
 * device never gets `pairing-admin` (a stolen cookie must not be able to pair another device).
 */
export const WEB_PERMISSIONS = [
	/** Sessions, prompts, answers, files, git, terminal, preview, tabs, uploads, launch profiles. */
	"workspace",
	/** Preferences, agent settings, models.yml. */
	"settings-write",
	/** Provider accounts and sign-ins, GitHub sign-in, account rotation. */
	"accounts-admin",
	/** Extensions, skills, MCP servers, schedules, SSH tools. */
	"extensions-admin",
	/** Updates, installs, restart and quit, paired desktop hosts. */
	"host-admin",
	/** Acting on the host's own screen: open a path or link there, its OS notifications. */
	"desktop-control",
	/** This device's own name, push subscription, passkey, revocation. */
	"device-self",
	/** Pairing codes, devices and their grants, allowed Tailscale users, turning mobile web off. */
	"pairing-admin",
] as const;

export type WebPermission = (typeof WEB_PERMISSIONS)[number];

/** A paired device's default grants: everything except `pairing-admin`. */
export const DEFAULT_WEB_GRANTS: readonly WebPermission[] = WEB_PERMISSIONS.filter(
	permission => permission !== "pairing-admin",
);

/** What this host offers a web page, sent in `hello`; a page hides what is missing. */
export interface WebFeatures {
	push: boolean;
	preview: boolean;
	upload: boolean;
	passkey: boolean;
}

/** Page → host. `inv` expects a `res` with the same `id`; `snd` is fire-and-forget. */
export type WebClientFrame =
	| { t: "inv"; id: number; ch: string; a: unknown[] }
	| { t: "snd"; ch: string; a: unknown[] }
	/** The last event `seq` the page applied. */
	| { t: "ack"; seq: number }
	/** The page became hidden (the host stops the full streams) or visible again. */
	| { t: "presence"; visible: boolean }
	| { t: "ping" }
	| { t: "pong" };

/** A failed `inv`, shaped so the renderer's `ipcErrorCode()` reads its code as it reads Electron's. */
export interface WebInvokeError {
	message: string;
	code?: IpcErrorCode;
}

/** Host → page. `evt` carries a push channel's payload unchanged. */
export type WebServerFrame =
	| { t: "res"; id: number; ok: true; v: unknown }
	| { t: "res"; id: number; ok: false; e: WebInvokeError }
	| { t: "evt"; seq: number; ch: string; d: unknown }
	| {
			t: "hello";
			protocol: number;
			/** The oldest page protocol this host still serves; an older page reloads. */
			minClient: number;
			connId: string;
			/** The connection continued an earlier one without losing events. */
			resumed: boolean;
			features: WebFeatures;
	  }
	| { t: "ping" }
	| { t: "pong" };
