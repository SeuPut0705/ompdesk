/**
 * Sessions that share a git checkout on one computer (modes/checkout-peers.ts, main's src/main/checkout-peers.ts).
 * Dependency-free: main imports it.
 *
 * Two scopes, because git keeps state at two levels:
 * - a worktree (`git rev-parse --show-toplevel`): its files, index and HEAD. Sessions with the same top level edit,
 *   stage, check out and build the same files.
 * - a repository (`git rev-parse --git-common-dir`): the stash, branches and other refs, shared by every worktree of
 *   it. Sessions in two worktrees of one repository still pop each other's stash.
 */

/** Another live session in the same worktree or repository. */
export interface CheckoutPeer {
	/** The id the control tools address it by (`ompdesk_report {to}`); null when it cannot be messaged (hidden from agents, or run here for a paired device). */
	id: string | null;
	title: string;
	/** A session this computer runs for a paired device: that device's name. */
	device?: string;
	/** Its session file on this computer, for the work board to open it (never for a session hidden from agents). */
	sessionPath?: string;
	/** Its worktree's top level, for a peer in another worktree of the repository. */
	worktree?: string;
	/** Files it changed lately (absolute paths, newest first), only for a peer in the same worktree. */
	files?: string[];
	/** What it is doing now: its in-progress todo item, one line (`CHECKOUT_TASK_MAX`). Absent: none, its title stands. Never in the prompt section. */
	task?: string;
	/** Only for a peer in the same worktree: the files both this session and that peer changed. */
	shared?: string[];
}

/** What main pushes to a session (`checkout_peers_set`). Empty lists: the session works alone. */
export interface CheckoutPeers {
	/** This session's worktree top level and the repository's common git dir, as main resolved them. */
	toplevel: string;
	commonDir: string;
	/** Other live sessions with the same top level. */
	worktree: CheckoutPeer[];
	/** Other live sessions in other worktrees of the same repository. */
	repo: CheckoutPeer[];
	/** This session has the OMPdesk control tools (`ompdesk_report`), so it can message its peers. */
	canMessage: boolean;
}

export const CHECKOUT_PEERS_SECTION_ID = "checkout-peers";
/** Main → bridge: the session's peers (`CheckoutPeers`). */
export const CHECKOUT_PEERS_SET = "checkout_peers_set";
/** Main → bridge: what this session is doing: `{files, task?}`, the files its agents changed lately (absolute, newest first) and its in-progress todo item. */
export const CHECKOUT_STATUS = "checkout_status";
/** The longest task a peer carries. */
export const CHECKOUT_TASK_MAX = 120;
/**
 * Bridge → GUI frame `{type, peers: CheckoutPeers | null}` (null: the session works alone), pushed whenever
 * `checkout_peers_set` changes what the session knows; bridge method `checkout_peers.get` answers the same value
 * (`{peers}`) for a window that opens later (the work board's "same checkout" row).
 */
export const CHECKOUT_PEERS_EVENT = "checkout_peers";
export const CHECKOUT_PEERS_GET = "checkout_peers.get";
/** How many changed files a session remembers and reports. */
export const CHECKOUT_FILES_MAX = 40;
