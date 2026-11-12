//! When a session an agent opened (`ompdesk_session_open`) closes by itself (`auto-close.ts`). Pure rules: the service
//! gathers the facts (tab state, git, what the person is doing) and applies the decision. No seams.
//!
//! A tab closes only once its work has landed and nobody is using it; the session file stays, except for a throwaway
//! session that ended `Result: ok`. A child that ended `Result: problem` closes its tab too, once its opener read the
//! answer. A finished child that needs a look stays a row.

/// What git says about the child's branch (none for a session without a worktree).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BranchLanding {
    /// The branch has a commit of its own.
    pub has_work: bool,
    /// Its tip is in the parent's HEAD or the remote's default branch.
    pub landed: bool,
    /// No uncommitted or untracked file in the worktree.
    pub clean: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    Ok,
    Failed,
}

/// The verdict line a final answer ends with (`parseWorkerResult`); `Missing`: it has none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Ok,
    Problem,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AutoCloseFacts {
    /// An agent opened it with the control tools.
    pub opened_by_agent: bool,
    /// The tab has a session file the sidebar can open again.
    pub stored: bool,
    /// No turn runs, nothing is queued and no question or approval waits.
    pub idle: bool,
    /// Nothing runs in the background either.
    pub settled: bool,
    /// A final answer is in.
    pub answered: bool,
    pub ended: Ended,
    pub result: Verdict,
    pub branch: Option<BranchLanding>,
    /// The person is looking at it.
    pub looked: bool,
    /// The person typed into it or sent it a prompt of their own.
    pub user_touched: bool,
    /// The opener read the answer, or has nothing running that could still read it.
    pub collected: bool,
    /// Its opener asked for it to be deleted once done.
    pub throwaway: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeepReason {
    NotAgentOpened,
    NotStored,
    Working,
    NoAnswer,
    Failed,
    NoResult,
    UserTouched,
    LookedAt,
    NotCollected,
    NothingLanded,
    Unmerged,
    Uncommitted,
}

impl KeepReason {
    pub fn as_str(self) -> &'static str {
        match self {
            KeepReason::NotAgentOpened => "not-agent-opened",
            KeepReason::NotStored => "not-stored",
            KeepReason::Working => "working",
            KeepReason::NoAnswer => "no-answer",
            KeepReason::Failed => "failed",
            KeepReason::NoResult => "no-result",
            KeepReason::UserTouched => "user-touched",
            KeepReason::LookedAt => "looked-at",
            KeepReason::NotCollected => "not-collected",
            KeepReason::NothingLanded => "nothing-landed",
            KeepReason::Unmerged => "unmerged",
            KeepReason::Uncommitted => "uncommitted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoCloseDecision {
    Keep(KeepReason),
    /// Close the tab; `remove_worktree`: its branch landed and the worktree is clean, so it goes too;
    /// `delete_session`: a throwaway session that ended `Result: ok`, whose saved session goes with the tab.
    Close {
        remove_worktree: bool,
        delete_session: bool,
    },
}

/// The first rule that holds decides; the order is the rules' priority.
pub fn auto_close_decision(facts: &AutoCloseFacts) -> AutoCloseDecision {
    use AutoCloseDecision::{Close, Keep};
    if !facts.opened_by_agent {
        return Keep(KeepReason::NotAgentOpened);
    }
    if !facts.idle || !facts.settled {
        return Keep(KeepReason::Working);
    }
    if !facts.answered {
        return Keep(KeepReason::NoAnswer);
    }
    if facts.ended == Ended::Failed {
        return Keep(KeepReason::Failed);
    }
    if facts.user_touched {
        return Keep(KeepReason::UserTouched);
    }
    if facts.looked {
        return Keep(KeepReason::LookedAt);
    }
    if !facts.stored {
        return Keep(KeepReason::NotStored);
    }
    if !facts.collected {
        return Keep(KeepReason::NotCollected);
    }
    let branch = facts.branch;
    // A problem verdict is delivered to the opener as its done report; the tab has nothing left to show. Its work is
    // not landed work, so the worktree goes only where a clean, landed branch makes that safe anyway.
    if facts.result == Verdict::Problem {
        return Close {
            remove_worktree: branch.is_some_and(|b| b.has_work && b.landed && b.clean),
            delete_session: false,
        };
    }
    // Without a verdict line the work is done, but left for the person.
    if facts.result == Verdict::Missing {
        return Keep(KeepReason::NoResult);
    }
    let Some(branch) = branch else {
        return Close {
            remove_worktree: false,
            delete_session: facts.throwaway,
        };
    };
    if !branch.has_work {
        return Keep(KeepReason::NothingLanded);
    }
    if !branch.landed {
        return Keep(KeepReason::Unmerged);
    }
    // Landed commits with work left beside them are not landed work: the leftovers wait for the person.
    if !branch.clean {
        return Keep(KeepReason::Uncommitted);
    }
    Close {
        remove_worktree: true,
        delete_session: facts.throwaway,
    }
}
