/**
 * `tailscale whois --json <tailnet IP>`: which node and user an address belongs to, in the shape the core process
 * answers (`native/ompdesk/crates/core/src/tailscale/whois.rs` reads the output). Serve puts the client's tailnet
 * address in `X-Forwarded-For`; whois names its node (a device name for the desktop notice) and gives the node's
 * stable ID (what a block keys on) and the login behind it (cross-checked against `Tailscale-User-Login`).
 */

/** What whois says about a client address; each part null when whois did not say. */
export interface TailnetPeer {
	/** The node's stable ID: the same device across key rotations and renames. */
	nodeId: string | null;
	/** The node's device name, as Tailscale shows it: no control characters, trimmed, at most 80 characters. */
	nodeName: string | null;
	/** The login of the user that owns the node (null for a tagged node: it has none). */
	login: string | null;
}
