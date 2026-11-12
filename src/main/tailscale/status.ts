/**
 * `tailscale status --json`, reduced to what Mobile web and computer sharing decide on: the shape the core process
 * answers (`native/ompdesk/crates/core/src/tailscale/status.rs` reads the document; only the keys it names count, so
 * a Tailscale that adds or reshapes fields keeps working). The text form of `status` is never parsed.
 */

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
	/** The hosts of the node's current and advertised endpoints (its LAN or public addresses, not tailnet ones). */
	endpoints: string[];
}
