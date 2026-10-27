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
	/** Its worktree's top level, for a peer in another worktree of the repository (never for a session hidden from agents). */
	worktree?: string;
	/**
	 * Files it changed and has not committed yet (absolute, newest first). A peer in another worktree's files are
	 * spelled in this session's worktree (the same path relative to the top level), so both scopes compare with this
	 * session's own paths; only same-worktree files ever refuse anything.
	 */
	files?: string[];
	/** What it is doing now: its in-progress todo item, one line (`CHECKOUT_TASK_MAX`). Absent: none, its title stands. Never in the prompt section. */
	task?: string;
	/** The files both this session and that peer changed and have not committed, in this session's spelling. */
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
/**
 * Main → bridge: `{files: [{file, stamp}]}`, claims main saw committed (`git status` no longer lists them). The
 * session drops each whose stamp (`checkout_status`'s `stamps`, parallel to `files`) is unchanged; a file changed
 * again since keeps its newer claim.
 */
export const CHECKOUT_RETIRE = "checkout_retire";
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
/**
 * Bridge → main frame `{type}`: this session's agents changed a file they had not changed before, so main runs a pass
 * now instead of at its next sweep (the others' guards learn of it within a pass, not ten seconds).
 */
export const CHECKOUT_FILES_EVENT = "checkout_files";
/** How every refusal of the shared-checkout guard begins: the work card shows such a call as protection, not a failure. */
export const CHECKOUT_REFUSAL_PREFIX = "Refused while other sessions work here";
