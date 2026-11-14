//! Native git effects for session-owned worktrees.

use crate::run::Runner;
use crate::server::{Fault, Scope};
use serde::{Deserialize, Serialize};

use super::{orphans, read, repo_lock, run::Git, worktree};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    pub source_cwd: String,
    pub base_commit: String,
    pub root: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Risk {
    pub dirty: bool,
    pub moved: bool,
    pub off_branch: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Snapshot {
    pub state: Risk,
    pub fingerprint: String,
    pub present: bool,
}

pub struct Service {
    runner: Runner,
    scope: Scope,
}

impl Service {
    pub fn new(runner: Runner, scope: Scope) -> Self {
        Self { runner, scope }
    }

    pub async fn inspect(&self, worktree: &Worktree) -> Result<Snapshot, Fault> {
        let git = Git::new(self.runner.clone(), self.scope.clone());
        let snapshot = worktree::snapshot(&git, &lifecycle(worktree)).await?;
        Ok(Snapshot {
            state: Risk {
                dirty: snapshot.state.dirty,
                moved: snapshot.state.moved,
                off_branch: snapshot.state.off_branch,
            },
            fingerprint: snapshot.fingerprint,
            present: snapshot.present,
        })
    }

    pub async fn remove(&self, worktree: &Worktree, moved: bool) -> Result<(), Fault> {
        let git = Git::new(self.runner.clone(), self.scope.clone());
        let primary = worktree::session_removal(&git, &lifecycle(worktree))
            .await?
            .primary;
        let runner = self.runner.clone();
        let worktree = worktree.clone();
        let expected_primary = primary.clone();
        repo_lock::run(&primary, self.scope.clone(), move |scope| async move {
            let git = Git::new(runner, scope);
            let lifecycle = lifecycle(&worktree);
            let removal = worktree::session_removal(&git, &lifecycle).await?;
            let expected = worktree::real(&expected_primary);
            let actual = worktree::real(&removal.primary);
            if expected.is_err() || actual.is_err() || expected.ok() != actual.ok() {
                return Err(Fault::new(
                    "worktree_changed",
                    "The source repository changed before removal",
                ));
            }
            let current = worktree::snapshot(&git, &lifecycle).await?;
            if current.state.moved != moved {
                return Err(Fault::new(
                    "worktree_changed",
                    "The worktree branch changed before removal",
                ));
            }
            let target = if removal.present {
                let path = worktree.path.clone();
                let root = worktree.root.clone();
                let target = read::blocking(move || {
                    if !std::path::Path::new(&path).is_absolute() {
                        return None;
                    }
                    let root = worktree::real(&root).ok()?;
                    let target = worktree::real(&path).ok()?;
                    orphans::inside(&root, &target).then_some(target)
                })
                .await?;
                let Some(target) = target else {
                    return Err(Fault::new(
                        "worktree_outside_root",
                        format!(
                            "Refusing to remove {}: only worktrees under {} can be removed.",
                            worktree.path, worktree.root
                        ),
                    ));
                };
                let checked = worktree::removal(&git, &target, true).await?;
                if worktree::real(&checked.primary).ok().as_ref()
                    != Some(&worktree::real(&removal.primary).map_err(|_| {
                        Fault::new("worktree_changed", "The source repository disappeared")
                    })?)
                {
                    return Err(Fault::new(
                        "not_a_worktree",
                        "Worktree belongs to another repository",
                    ));
                }
                Some(target)
            } else {
                None
            };
            worktree::session_remove(
                &git,
                &removal.primary,
                &worktree.path,
                &worktree.branch,
                target.as_deref(),
                moved,
                120_000,
            )
            .await
        })
        .await
    }
}

fn lifecycle(worktree: &Worktree) -> worktree::Lifecycle {
    worktree::Lifecycle {
        path: worktree.path.clone(),
        branch: worktree.branch.clone(),
        source_cwd: worktree.source_cwd.clone(),
        base_commit: worktree.base_commit.clone(),
    }
}

#[cfg(test)]
pub mod test_support {
    pub use crate::git::run::tests::runner;
    pub use crate::git::scm::tests::{repo_at, sh};
}

#[cfg(test)]
#[path = "session_lifecycle_tests.rs"]
mod tests;
