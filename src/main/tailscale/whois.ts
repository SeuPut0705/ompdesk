/**
 * `tailscale whois --json <tailnet IP>`: which node and user an address belongs to. Serve puts the client's tailnet
 * address in `X-Forwarded-For`; whois names its node (a device name for the desktop notice) and gives the node's
 * stable ID (what a block keys on) and the login behind it (cross-checked against `Tailscale-User-Login`).
 * Only the keys needed are read.
 */
import { z } from "zod";

const lenient = <T extends z.ZodTypeAny>(schema: T) => schema.nullish().catch(undefined);

const WhoisSchema = z.object({
	Node: lenient(
		z.object({
			StableID: lenient(z.string()),
			Name: lenient(z.string()),
			ComputedName: lenient(z.string()),
			Hostinfo: lenient(z.object({ Hostname: lenient(z.string()) })),
		}),
	),
	UserProfile: lenient(z.object({ LoginName: lenient(z.string()) })),
});

/** What whois says about a client address; each part null when whois did not say. */
export interface TailnetPeer {
	/** The node's stable ID: the same device across key rotations and renames. */
	nodeId: string | null;
	/** The node's device name, as Tailscale shows it. */
	nodeName: string | null;
	/** The login of the user that owns the node (null for a tagged node: it has none). */
	login: string | null;
}

/** A name safe to show: no control characters, trimmed, at most 80 characters; null when nothing is left. */
function cleanName(value: string | null | undefined): string | null {
	const text = (value ?? "")
		.replace(/\p{Cc}/gu, "")
		.trim()
		.slice(0, 80);
	return text === "" ? null : text;
}

/** The peer in `stdout`, or null when it is not whois output. */
export function parseWhois(stdout: string): TailnetPeer | null {
	let json: unknown;
	try {
		json = JSON.parse(stdout);
	} catch {
		return null;
	}
	const parsed = WhoisSchema.safeParse(json);
	if (!parsed.success || !parsed.data.Node) return null;
	const node = parsed.data.Node;
	const label = node.Name?.replace(/\.$/, "").split(".")[0];
	const login = parsed.data.UserProfile?.LoginName?.trim();
	return {
		nodeId: node.StableID?.trim() || null,
		nodeName: cleanName(node.ComputedName) ?? cleanName(label) ?? cleanName(node.Hostinfo?.Hostname),
		login: login || null,
	};
}
