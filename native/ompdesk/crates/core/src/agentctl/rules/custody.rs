//! What a worktree child's `done` or `review` report leaves in git, read when it reports instead of when its opener asks
//! (`custody.ts`): a report that says done while the work sits uncommitted, or names files its change does not hold,
//! is a dropped ball the opener sees at once. Pure.
//!
//! Seam: `BranchFacts` is `git::branches`' facts about a child's branch (the one definition, read back from main's
//! JSON by the service).

pub use crate::git::branches::{BranchFacts, FileChange};

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
    if facts.uncommitted != 0.0 {
        parts.push(format!("{} uncommitted file(s)", facts.uncommitted));
    }
    if facts.untracked != 0.0 {
        parts.push(format!("{} untracked file(s)", facts.untracked));
    }
    // Untracked files are no part of `files` (tracked only), a cut list cannot tell, and a landed branch is measured
    // from its tip: only a complete, untracked-free change that has not landed can say a reported file is missing.
    let missing: Vec<&String> = if facts.merged || facts.files_truncated || facts.untracked > 0.0 {
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
    if facts.uncommitted != 0.0 || facts.untracked != 0.0 {
        let mut counts: Vec<String> = Vec::new();
        if facts.uncommitted != 0.0 {
            counts.push(format!("{} uncommitted", facts.uncommitted));
        }
        if facts.untracked != 0.0 {
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
