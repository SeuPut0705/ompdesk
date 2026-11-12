//! What a worktree child's `done` or `review` report leaves in git, read when it reports instead of when its opener asks
//! (`custody.ts`): a report that says done while the work sits uncommitted, or names files its change does not hold,
//! is a dropped ball the opener sees at once. Pure.
//!
//! Seam: `BranchFacts` is `branches.ts`' facts about a child's branch, built by the git side of the service. It is
//! defined here because the branches port has not landed; it moves to wherever that port puts it (one definition).

/// A tracked file that differs from where the branch left the parent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    pub added: i64,
    pub removed: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchFacts {
    pub branch: String,
    /// The parent checkout's current branch; none while its HEAD is detached.
    pub base_branch: Option<String>,
    pub commits_ahead: i64,
    /// Tracked files that differ from where the branch left the parent, committed or not.
    pub files: Vec<FileChange>,
    pub files_truncated: bool,
    /// Tracked files with uncommitted edits in the worktree.
    pub uncommitted: i64,
    pub untracked: i64,
    /// Tracked files with uncommitted edits in the parent checkout.
    pub base_uncommitted: i64,
    /// The branch's commits are already in the parent's branch or in the upstream it tracks.
    pub merged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Custody {
    /// One line of facts appended to the report the opener reads.
    pub line: String,
    /// What the reporter should fix before its report holds, or none when its git agrees with it.
    pub gap: Option<String>,
}

/// A reported path names a changed file when they are equal or one ends with the other at a folder boundary.
fn names(reported: &str, changed: &str) -> bool {
    let a = reported.replace('\\', "/");
    let a = a.strip_prefix("./").unwrap_or(&a);
    let b = changed.replace('\\', "/");
    a == b || a.ends_with(&format!("/{b}")) || b.ends_with(&format!("/{a}"))
}

pub fn custody_of(facts: &BranchFacts, reported: &[String]) -> Custody {
    let mut parts: Vec<String> = vec![if facts.merged {
        "landed".to_owned()
    } else {
        format!(
            "{} commit(s) not in {} yet",
            facts.commits_ahead,
            facts.base_branch.as_deref().unwrap_or("the base")
        )
    }];
    if facts.uncommitted != 0 {
        parts.push(format!("{} uncommitted file(s)", facts.uncommitted));
    }
    if facts.untracked != 0 {
        parts.push(format!("{} untracked file(s)", facts.untracked));
    }
    // Untracked files are no part of `files` (tracked only), a cut list cannot tell, and a landed branch is measured
    // from its tip: only a complete, untracked-free change that has not landed can say a reported file is missing.
    let missing: Vec<&String> = if facts.merged || facts.files_truncated || facts.untracked > 0 {
        Vec::new()
    } else {
        reported
            .iter()
            .filter(|path| !facts.files.iter().any(|change| names(path, &change.path)))
            .collect()
    };
    let listed = || {
        missing
            .iter()
            .take(5)
            .map(|path| path.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    };
    if !missing.is_empty() {
        parts.push(format!("reported but unchanged: {}", listed()));
    }
    let mut gaps: Vec<String> = Vec::new();
    if facts.uncommitted != 0 || facts.untracked != 0 {
        let mut counts: Vec<String> = Vec::new();
        if facts.uncommitted != 0 {
            counts.push(format!("{} uncommitted", facts.uncommitted));
        }
        if facts.untracked != 0 {
            counts.push(format!("{} untracked", facts.untracked));
        }
        gaps.push(format!(
            "your worktree still has {} file(s): commit what belongs to the work (or say why it stays out)",
            counts.join(" and ")
        ));
    }
    if !missing.is_empty() {
        gaps.push(format!(
            "the files you named {} are not in your branch's change",
            listed()
        ));
    }
    Custody {
        line: format!("Git ({}): {}.", facts.branch, parts.join("; ")),
        gap: (!gaps.is_empty()).then(|| format!("{}.", gaps.join("; "))),
    }
}
