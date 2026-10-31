/**
 * When a session an agent opened (`ompdesk_session_open`) closes by itself. Pure rules: `AgentControl.autoClose`
 * gathers the facts (tab state, git, what the person is doing) and applies the decision.
 *
 * A tab closes only once its work has landed and nobody is using it; the session file stays, except for a throwaway
 * session (`ompdesk_session_open {throwaway: true}`) that ended `Result: ok`: its saved session is deleted with the
 * close. A child that ended `Result: problem` closes its tab too, once its opener read the answer: its worktree stays
 * when its branch has not landed, and its saved session stays even when it was opened as throwaway. A finished child
 * that needs a look (it ended in an error or was stopped, its branch holds commits nothing merged, its worktree holds
 * uncommitted or untracked files, it gave no verdict) stays a row.
 */

/** What git says about the child's branch; null for a session without a worktree. */
export interface BranchLanding {
	/** The branch has a commit of its own (an untouched branch has nothing to land). */
	hasWork: boolean;
	/** Its tip is in the parent's HEAD or the remote's default branch. */
	landed: boolean;
	/** No uncommitted or untracked file in the worktree. */
	clean: boolean;
}

export interface AutoCloseFacts {
	/** An agent opened it with the control tools (not the person, not an Autopilot run or child). */
	openedByAgent: boolean;
	/** The tab has a session file the sidebar can open again. */
	stored: boolean;
	/** No turn runs, nothing is queued and no question or approval waits. */
	idle: boolean;
	/** Nothing runs in the background either (its subagents, jobs, a compaction). */
	settled: boolean;
	/** A final answer is in. */
	answered: boolean;
	/** Its last turn ended in an error or was stopped. */
	ended: "ok" | "failed";
	/** The verdict line its final answer ends with (`parseWorkerResult`); `missing`: it has none. */
	result: "ok" | "problem" | "missing";
	branch: BranchLanding | null;
	/** The person is looking at it: the focused tab, a visible pane of any window, a viewer on another device. */
	looked: boolean;
	/** The person typed into it (a draft) or sent it a prompt of their own. */
	userTouched: boolean;
	/** The opener read the answer (a result, a read, a merge), or has nothing running that could still read it. */
	collected: boolean;
	/** Its opener asked for it to be deleted once done (`ompdesk_session_open {throwaway: true}`). */
	throwaway: boolean;
}

export type KeepReason =
	| "not-agent-opened"
	| "not-stored"
	| "working"
	| "no-answer"
	| "failed"
	| "no-result"
	| "user-touched"
	| "looked-at"
	| "not-collected"
	| "nothing-landed"
	| "unmerged"
	| "uncommitted";

export type AutoCloseDecision =
	| { action: "keep"; reason: KeepReason }
	/**
	 * Close the tab; `removeWorktree`: its branch landed and the worktree is clean, so it goes too; `deleteSession`: a
	 * throwaway session that ended `Result: ok`, whose saved session goes with the tab.
	 */
	| { action: "close"; removeWorktree: boolean; deleteSession: boolean };

/** The first rule that holds decides; the order is the rules' priority. */
export function autoCloseDecision(facts: AutoCloseFacts): AutoCloseDecision {
	if (!facts.openedByAgent) return { action: "keep", reason: "not-agent-opened" };
	if (!facts.idle || !facts.settled) return { action: "keep", reason: "working" };
	if (!facts.answered) return { action: "keep", reason: "no-answer" };
	if (facts.ended === "failed") return { action: "keep", reason: "failed" };
	if (facts.userTouched) return { action: "keep", reason: "user-touched" };
	if (facts.looked) return { action: "keep", reason: "looked-at" };
	if (!facts.stored) return { action: "keep", reason: "not-stored" };
	if (!facts.collected) return { action: "keep", reason: "not-collected" };
	const branch = facts.branch;
	// A problem verdict is delivered to the opener as its done report; the tab has nothing left to show. Its work is
	// not landed work, so the worktree goes only where a clean, landed branch makes that safe anyway.
	if (facts.result === "problem")
		return {
			action: "close",
			removeWorktree: branch ? branch.hasWork && branch.landed && branch.clean : false,
			deleteSession: false,
		};
	// Without a verdict line the work is done, but left for the person.
	if (facts.result === "missing") return { action: "keep", reason: "no-result" };
	if (!branch) return { action: "close", removeWorktree: false, deleteSession: facts.throwaway };
	if (!branch.hasWork) return { action: "keep", reason: "nothing-landed" };
	if (!branch.landed) return { action: "keep", reason: "unmerged" };
	// Landed commits with work left beside them are not landed work: the leftovers wait for the person.
	if (!branch.clean) return { action: "keep", reason: "uncommitted" };
	return { action: "close", removeWorktree: true, deleteSession: facts.throwaway };
}
