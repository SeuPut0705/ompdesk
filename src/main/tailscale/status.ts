/**
 * `tailscale status --json`, reduced to what Mobile web decides on. Only the keys below are read (zod strips the
 * rest, and a key of an unexpected shape reads as absent instead of failing the whole document), so a Tailscale
 * that adds or reshapes fields keeps working. The text form of `status` is never parsed.
 */
import { z } from "zod";

/** The `BackendState`s that matter; anything else reads as `unknown`. */
export type BackendKind =
	| "running"
	| "needs-login"
	| "stopped"
	| "needs-machine-auth"
	| "starting"
	| "no-state"
	| "in-use-other-user"
	| "unknown";

/** The serve CLI changed in 1.52. */
export const MIN_TAILSCALE_VERSION = "1.52.0";
/** The admin pages the user is sent to. */
export const ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns";
export const ADMIN_MACHINES_URL = "https://login.tailscale.com/admin/machines";

/** A value that is absent, null or of the wrong type reads as `undefined`. */
const lenient = <T extends z.ZodTypeAny>(schema: T) => schema.nullish().catch(undefined);

const PeerSchema = z.object({
	ID: lenient(z.string()),
	HostName: lenient(z.string()),
	DNSName: lenient(z.string()),
	OS: lenient(z.string()),
	Online: lenient(z.boolean()),
	UserID: lenient(z.number()),
	TailscaleIPs: lenient(z.array(z.string())),
});

const StatusSchema = z.object({
	Version: lenient(z.string()),
	BackendState: z.string(),
	AuthURL: lenient(z.string()),
	TailscaleIPs: lenient(z.array(z.string())),
	Self: lenient(
		z.object({
			ID: lenient(z.string()),
			HostName: lenient(z.string()),
			DNSName: lenient(z.string()),
			UserID: lenient(z.number()),
			Capabilities: lenient(z.array(z.string())),
			CapMap: lenient(z.record(z.unknown())),
			KeyExpiry: lenient(z.string()),
		}),
	),
	CertDomains: lenient(z.array(z.string())),
	CurrentTailnet: lenient(z.object({ MagicDNSEnabled: lenient(z.boolean()) })),
	MagicDNSSuffix: lenient(z.string()),
	User: lenient(z.record(z.object({ LoginName: lenient(z.string()) }))),
	Peer: lenient(z.record(PeerSchema)),
	ClientVersion: lenient(z.object({ RunningLatest: lenient(z.boolean()), LatestVersion: lenient(z.string()) })),
});

export interface TailscaleStatus {
	/** `BackendState` as Tailscale spelled it. */
	backendState: string;
	backend: BackendKind;
	/** `Version` without the build suffix (`1.104.1-t…` → `1.104.1`). */
	version: string | null;
	/** The sign-in page while `NeedsLogin`. */
	authUrl: string | null;
	/** This machine's MagicDNS name without its trailing dot. */
	dnsName: string | null;
	userId: number | null;
	/** `User[Self.UserID].LoginName`: this computer's tailnet user. */
	login: string | null;
	certDomains: string[];
	/** `CurrentTailnet.MagicDNSEnabled`; null when the document does not say. */
	magicDns: boolean | null;
	/** `Self.Capabilities` plus the keys of `Self.CapMap`. */
	capabilities: string[];
	keyExpiry: string | null;
	/** A newer Tailscale exists. */
	updateAvailable: boolean;
	/** Hostnames of this user's online phones and tablets. */
	phones: string[];
	/** This machine's tailnet addresses (`TailscaleIPs`). */
	selfIps: string[];
	/** This machine's node (`Self.ID`, the stable ID `whois` reports). */
	selfNodeId: string | null;
	/** This machine's name on the tailnet. */
	selfName: string | null;
	/** The other nodes of the tailnet (and those shared with it). */
	peers: TailnetNode[];
}

export interface TailnetNode {
	/** Stable node ID (`Peer.ID`, what `whois` calls `Node.StableID`). */
	nodeId: string;
	name: string;
	ips: string[];
	os: string | null;
	online: boolean;
	/** The node's user's login; null for a tagged node or a user the document does not list. */
	login: string | null;
}

const BACKENDS: Record<string, BackendKind> = {
	Running: "running",
	NeedsLogin: "needs-login",
	Stopped: "stopped",
	NeedsMachineAuth: "needs-machine-auth",
	Starting: "starting",
	NoState: "no-state",
	InUseOtherUser: "in-use-other-user",
};

/** Peers that count as the user's phone or tablet. */
const MOBILE_OS = /^(ios|ipados|android)$/i;

/** The status document in `stdout`, or null when it is not one. */
export function parseStatus(stdout: string): TailscaleStatus | null {
	let json: unknown;
	try {
		json = JSON.parse(stdout);
	} catch {
		return null;
	}
	const parsed = StatusSchema.safeParse(json);
	if (!parsed.success) return null;
	const doc = parsed.data;
	const userId = doc.Self?.UserID ?? null;
	const loginOf = (id: number | null | undefined): string | null =>
		id === null || id === undefined ? null : (doc.User?.[String(id)]?.LoginName ?? null);
	const phones: string[] = [];
	const peers: TailnetNode[] = [];
	for (const peer of Object.values(doc.Peer ?? {})) {
		const name = peer.HostName || peer.DNSName?.split(".")[0] || "";
		if (peer.ID && name) {
			peers.push({
				nodeId: peer.ID,
				name,
				ips: peer.TailscaleIPs ?? [],
				os: peer.OS ?? null,
				online: peer.Online === true,
				login: loginOf(peer.UserID),
			});
		}
		if (userId === null) continue;
		if (peer.Online !== true || peer.UserID !== userId || !peer.OS || !MOBILE_OS.test(peer.OS)) continue;
		if (name) phones.push(name);
	}
	const dnsName = doc.Self?.DNSName?.replace(/\.$/, "") || null;
	return {
		backendState: doc.BackendState,
		backend: BACKENDS[doc.BackendState] ?? "unknown",
		version: doc.Version?.split("-")[0] || null,
		authUrl: doc.AuthURL || null,
		dnsName,
		userId,
		login: loginOf(userId),
		certDomains: doc.CertDomains ?? [],
		magicDns: doc.CurrentTailnet?.MagicDNSEnabled ?? null,
		capabilities: [...(doc.Self?.Capabilities ?? []), ...Object.keys(doc.Self?.CapMap ?? {})],
		keyExpiry: doc.Self?.KeyExpiry ?? null,
		// `RunningLatest` is omitted when false; `LatestVersion` is only set then.
		updateAvailable: doc.ClientVersion?.RunningLatest !== true && Boolean(doc.ClientVersion?.LatestVersion),
		phones,
		selfIps: doc.TailscaleIPs ?? [],
		selfNodeId: doc.Self?.ID || null,
		selfName: doc.Self?.HostName || dnsName?.split(".")[0] || null,
		peers,
	};
}

/**
 * Why `serve` over HTTPS cannot work on this tailnet, or null when it can: MagicDNS is off, the tailnet has no
 * certificate domain for this machine (HTTPS is not enabled), or Tailscale reports capabilities and `https`
 * is not among them.
 */
export function httpsProblem(status: TailscaleStatus): string | null {
	if (status.magicDns === false) return "MagicDNS is off for this tailnet";
	if (status.certDomains.length === 0) return "HTTPS certificates are not enabled for this tailnet";
	if (status.capabilities.length > 0 && !status.capabilities.includes("https")) {
		return "This machine has no https capability";
	}
	return null;
}
