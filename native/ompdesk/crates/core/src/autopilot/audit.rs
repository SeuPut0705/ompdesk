//! Autopilot's git audit (was `src/main/autopilot-audit.ts`): the required second defence behind the bridge's
//! `tool_call` guard, which cannot see through `sh -c`, interpreters or a subprocess of `eval`. The run snapshots the
//! repository's refs, its `config` and the default checkout's HEAD around each cycle and judges the difference. Moves
//! the run is entitled to are the own branch, the children's branches, what the ShipRunner journaled and, in the
//! release scope, the default branch on the remote and new `v*` tags.
//!
//! A remote-tracking ref that only a fetch moved is not the agent's (the reflog says `fetch`). Neither is one that moved
//! forward or was created without holding any commit the run's branch made this cycle: in a repository other sessions
//! work in, their pushes update the shared remote-tracking refs (the reflog says `update by push`), and that paused the
//! run as its own. A deleted or rewound remote-tracking ref still counts, whoever did it. A user's own commit on a local
//! branch cannot be told from the agent's, so it counts, like the design says.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::fs::disk;
use crate::fs::order::js_trim;
use crate::git::read::{blocking, resolve};
use crate::git::run::Git;
use crate::run::Opts;
use crate::server::Fault;

const REFS_TIMEOUT_MS: u64 = 30_000;

/// The repository as one cycle's start or end found it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    /// Every ref: name → object id.
    pub refs: BTreeMap<String, String>,
    /// SHA-256 of the repository's `config` file (a `git config` write, a remote added or re-pointed).
    pub config: Option<String>,
    /// The default checkout's HEAD: its branch (or `detached`) and commit.
    pub checkout: Option<String>,
}

/// What the cycle was entitled to move.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    /// The run's own branch, e.g. `autopilot/2026-10-17`.
    pub branch: String,
    /// Branches the children of this run were given.
    #[serde(default)]
    pub child_branches: Vec<String>,
    pub remote: String,
    pub default_branch: String,
    /// The release scope is open: the default branch on the remote and new `v*` tags may move.
    #[serde(default)]
    pub release: bool,
    /// Exact refs the ShipRunner journaled since the snapshot.
    #[serde(default)]
    pub expected_refs: Vec<String>,
    /// The ShipRunner merged into the default checkout since the snapshot.
    #[serde(default)]
    pub checkout_may_move: bool,
    /// The ShipRunner pushed since the snapshot (it sets the branch's upstream, a `git config` write).
    #[serde(default)]
    pub config_may_change: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RefChange {
    #[serde(rename = "ref")]
    pub name: String,
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Violation {
    pub kind: &'static str,
    pub detail: String,
}

/// Refs created, moved or deleted between two snapshots, sorted by name (as JavaScript sorts: by UTF-16 unit).
pub fn diff_refs(
    before: &BTreeMap<String, String>,
    after: &BTreeMap<String, String>,
) -> Vec<RefChange> {
    let names: BTreeSet<&String> = before.keys().chain(after.keys()).collect();
    let mut names: Vec<&String> = names.into_iter().collect();
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    names
        .into_iter()
        .filter_map(|name| {
            let (from, to) = (before.get(name), after.get(name));
            (from != to).then(|| RefChange {
                name: name.clone(),
                from: from.cloned(),
                to: to.cloned(),
            })
        })
        .collect()
}

fn slow() -> Opts<'static> {
    Opts {
        timeout_ms: Some(REFS_TIMEOUT_MS),
        ..Opts::default()
    }
}

/// Every ref and the commit it names. A symbolic ref (`refs/remotes/origin/HEAD`, which a clone or `remote set-head`
/// makes) is left out: it moves whenever its target does, and the target is diffed itself, so a fetch that moved
/// `origin/main` read as "refs/remotes/origin/HEAD moved" with no fetch in its own reflog and paused the run.
async fn read_refs(git: &Git, root: &str) -> Result<BTreeMap<String, String>, Fault> {
    let args = [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(symref)",
    ];
    let out = git.text_with(root, &args, slow()).await?;
    let mut refs = BTreeMap::new();
    for line in out.split('\n') {
        let mut fields = line.split('\0');
        let (name, oid, symref) = (
            fields.next().unwrap_or_default(),
            fields.next().unwrap_or_default(),
            fields.next().unwrap_or_default(),
        );
        if !name.is_empty() && !oid.is_empty() && symref.is_empty() {
            refs.insert(name.to_owned(), oid.to_owned());
        }
    }
    Ok(refs)
}

async fn read_config_hash(git: &Git, root: &str) -> Result<Option<String>, Fault> {
    let common = git
        .run(root, &["rev-parse", "--git-common-dir"], slow())
        .await?;
    let common = js_trim(&common.text()).to_owned();
    if common.is_empty() {
        return Ok(None);
    }
    let file = std::path::Path::new(&resolve(root, &common)).join("config");
    Ok(blocking(move || std::fs::read(file).ok())
        .await?
        .map(|bytes| crate::hex(&Sha256::digest(bytes))))
}

async fn read_checkout(git: &Git, root: &str) -> Result<Option<String>, Fault> {
    let head = git.run(root, &["rev-parse", "HEAD"], slow()).await?;
    if head.code != 0 {
        return Ok(None);
    }
    let branch = git
        .run(root, &["symbolic-ref", "-q", "HEAD"], slow())
        .await?;
    let name = if branch.code == 0 {
        js_trim(&branch.text()).to_owned()
    } else {
        "detached".to_owned()
    };
    Ok(Some(format!("{name} {}", js_trim(&head.text()))))
}

/// Snapshot the repository `root` belongs to; `checkout_root` is the user's default checkout of it.
pub async fn take_snapshot(
    git: &Git,
    root: &str,
    checkout_root: Option<&str>,
) -> Result<Snapshot, Fault> {
    let checkout = async {
        match checkout_root {
            Some(folder) if !folder.is_empty() => read_checkout(git, folder).await,
            _ => Ok(None),
        }
    };
    let (refs, config, checkout) =
        tokio::try_join!(read_refs(git, root), read_config_hash(git, root), checkout)?;
    Ok(Snapshot {
        refs,
        config,
        checkout,
    })
}

/// Whether the last reflog entry of `ref` is a fetch (the user's or the app's), not a push.
async fn moved_by_fetch(git: &Git, root: &str, name: &str) -> Result<bool, Fault> {
    let log = git
        .run(
            root,
            &["reflog", "show", "--format=%gs", "-n", "1", name],
            slow(),
        )
        .await?;
    if log.code != 0 {
        return Ok(false);
    }
    let text = log.text();
    let text = js_trim(&text);
    let word_end = text
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(text.len());
    Ok(matches!(&text[..word_end], "fetch" | "pull"))
}

/// What judges "another session did it": the run's own commits, read once and only when a ref needs them.
struct Others<'a> {
    git: &'a Git,
    root: &'a str,
    tip: Option<&'a str>,
    base: Option<&'a str>,
    mine: Option<Option<Vec<String>>>,
}

impl Others<'_> {
    /// The run's own commits: those on its branch's first-parent line that the default branch on the remote did not hold
    /// when the cycle began (a merge brings others' commits; first parents are the run's). None when git cannot say,
    /// which counts as the run's (an empty answer is never evidence that another session acted).
    async fn own_commits(&self) -> Result<Option<Vec<String>>, Fault> {
        let Some(tip) = self.tip else {
            return Ok(Some(Vec::new()));
        };
        let mut args = vec!["rev-list", "--first-parent", tip];
        if let Some(base) = self.base {
            args.extend(["--not", base]);
        }
        let range = self.git.run(self.root, &args, slow()).await?;
        Ok((range.code == 0).then(|| {
            range
                .text()
                .split('\n')
                .filter(|line| !line.is_empty())
                .map(str::to_owned)
                .collect()
        }))
    }

    /// A ref another session moved: created or moved forward, holding none of the run's own commits.
    async fn theirs(&mut self, change: &RefChange) -> Result<bool, Fault> {
        if self.mine.is_none() {
            self.mine = Some(self.own_commits().await?);
        }
        let (Some(to), Some(Some(own))) = (&change.to, &self.mine) else {
            return Ok(false);
        };
        if let Some(from) = &change.from {
            let forward = self
                .git
                .run(
                    self.root,
                    &["merge-base", "--is-ancestor", from, to],
                    slow(),
                )
                .await?;
            if forward.code != 0 {
                return Ok(false);
            }
        }
        for sha in own {
            let holds = self
                .git
                .run(self.root, &["merge-base", "--is-ancestor", sha, to], slow())
                .await?;
            if holds.code == 0 {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

/// Branches checked out in a worktree of the repository other than the run's own: another session's worktree branch or
/// the user's own checkout. The agent's `git branch x` is checked out nowhere, so it still counts.
async fn other_worktree_branches(git: &Git, root: &str) -> Result<HashSet<String>, Fault> {
    let list = git
        .run(root, &["worktree", "list", "--porcelain"], slow())
        .await?;
    if list.code != 0 {
        return Ok(HashSet::new());
    }
    let real = |path: String| async move {
        blocking(move || {
            disk::realpath(&path)
                .map(|resolved| disk::spelled(&resolved))
                .unwrap_or(path)
        })
        .await
    };
    let this = real(root.to_owned()).await?;
    let mut branches = HashSet::new();
    for block in list.text().split("\n\n") {
        let field = |key: &str| {
            block
                .lines()
                .find_map(|line| line.strip_prefix(key))
                .map(str::to_owned)
        };
        let (Some(tree), Some(branch)) = (field("worktree "), field("branch ")) else {
            continue;
        };
        if real(tree).await? != this {
            branches.insert(branch);
        }
    }
    Ok(branches)
}

fn allowed(change: &RefChange, scope: &Scope) -> bool {
    let name = change.name.as_str();
    if scope.expected_refs.iter().any(|expected| expected == name) {
        return true;
    }
    if name.strip_prefix("refs/heads/") == Some(scope.branch.as_str()) {
        return change.to.is_some();
    }
    if scope
        .child_branches
        .iter()
        .any(|child| name.strip_prefix("refs/heads/") == Some(child.as_str()))
    {
        return true;
    }
    // `git stash` is not guarded against creating one; dropping is (the guard bans `stash drop|clear`).
    if name == "refs/stash" {
        return true;
    }
    if !scope.release {
        return false;
    }
    if name == format!("refs/remotes/{}/{}", scope.remote, scope.default_branch) {
        return change.to.is_some();
    }
    let version_tag = name
        .strip_prefix("refs/tags/v")
        .is_some_and(|rest| !rest.is_empty() && !rest.contains('/'));
    version_tag && change.from.is_none() && change.to.is_some()
}

fn describe_change(change: &RefChange) -> String {
    let verb = match (&change.from, &change.to) {
        (None, _) => "created",
        (_, None) => "deleted",
        _ => "moved",
    };
    format!("{} {verb}", change.name)
}

/// What the cycle between `before` and `after` did outside its entitlement. `root` is the run's worktree (any checkout of
/// the repository answers the ancestry question).
pub async fn audit_cycle(
    git: &Git,
    root: &str,
    before: &Snapshot,
    after: &Snapshot,
    scope: &Scope,
) -> Result<Vec<Violation>, Fault> {
    let mut violations = Vec::new();
    let own = format!("refs/heads/{}", scope.branch);
    let base = before
        .refs
        .get(&format!(
            "refs/remotes/{}/{}",
            scope.remote, scope.default_branch
        ))
        .map(String::as_str);
    let mut others = Others {
        git,
        root,
        tip: after.refs.get(&own).map(String::as_str),
        base,
        mine: None,
    };
    let mut elsewhere: Option<HashSet<String>> = None;
    for change in diff_refs(&before.refs, &after.refs) {
        if allowed(&change, scope) {
            continue;
        }
        if change.to.is_some() && change.name.starts_with("refs/remotes/") {
            if moved_by_fetch(git, root, &change.name).await? || others.theirs(&change).await? {
                continue;
            }
        } else if change.to.is_some() && change.name.starts_with("refs/heads/") {
            if elsewhere.is_none() {
                elsewhere = Some(other_worktree_branches(git, root).await?);
            }
            let held = elsewhere
                .as_ref()
                .is_some_and(|set| set.contains(&change.name));
            if held && others.theirs(&change).await? {
                continue;
            }
        }
        violations.push(Violation {
            kind: "ref",
            detail: describe_change(&change),
        });
    }
    let (old_tip, new_tip) = (before.refs.get(&own), after.refs.get(&own));
    match (old_tip, new_tip) {
        (Some(_), None) => violations.push(Violation {
            kind: "history",
            detail: format!("{own} deleted"),
        }),
        (Some(old), Some(new)) if old != new => {
            let ancestor = git
                .run(root, &["merge-base", "--is-ancestor", old, new], slow())
                .await?;
            if ancestor.code != 0 {
                violations.push(Violation {
                    kind: "history",
                    detail: format!(
                        "{own} no longer contains its previous tip {}",
                        old.chars().take(9).collect::<String>()
                    ),
                });
            }
        }
        _ => {}
    }
    if before.config.is_some() && after.config != before.config && !scope.config_may_change {
        violations.push(Violation {
            kind: "config",
            detail: "the repository's git config changed".into(),
        });
    }
    if let Some(was) = &before.checkout
        && after.checkout.as_ref() != Some(was)
        && !scope.checkout_may_move
    {
        // The same branch moved forward without the run's commits is the user's own pull or commit there.
        let mut from = was.split(' ');
        let (branch_before, from) = (from.next().unwrap_or_default(), from.next());
        let now = after.checkout.clone().unwrap_or_default();
        let mut to = now.split(' ');
        let (branch_after, to) = (to.next().unwrap_or_default(), to.next());
        let pulled = if branch_before == branch_after
            && branch_before != "detached"
            && from.is_some()
            && to.is_some()
        {
            others
                .theirs(&RefChange {
                    name: branch_before.to_owned(),
                    from: from.map(str::to_owned),
                    to: to.map(str::to_owned),
                })
                .await?
        } else {
            false
        };
        if !pulled {
            violations.push(Violation {
                kind: "checkout",
                detail: format!(
                    "the default checkout moved ({was} → {})",
                    after.checkout.as_deref().unwrap_or("null")
                ),
            });
        }
    }
    Ok(violations)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::run::tests::git;
    use serde_json::{Value, json};

    fn map(value: &Value) -> BTreeMap<String, String> {
        value
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, oid)| (name.clone(), oid.as_str().unwrap().to_owned()))
            .collect()
    }

    #[test]
    fn diff_refs_matches_the_typescript() {
        let captured: Value = serde_json::from_str(include_str!("captured-audit.json")).unwrap();
        for case in captured["diff"].as_array().unwrap() {
            let out = diff_refs(&map(&case["before"]), &map(&case["after"]));
            assert_eq!(serde_json::to_value(out).unwrap(), case["out"], "{case}");
        }
    }

    fn sh(cwd: &std::path::Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args([
                "-c",
                "user.email=t@example.com",
                "-c",
                "user.name=T",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    /// A repository with a bare remote and the run's worktree on its own branch.
    struct World {
        _tmp: tempdir::Dir,
        main: std::path::PathBuf,
        work: std::path::PathBuf,
    }

    mod tempdir {
        pub struct Dir(pub std::path::PathBuf);
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    fn world() -> World {
        let base = crate::fs::disk::make_temp_dir("ompdesk-audit-test-").unwrap();
        let base = std::fs::canonicalize(base).unwrap();
        let (main, remote, work) = (
            base.join("main"),
            base.join("remote.git"),
            base.join("work"),
        );
        std::fs::create_dir(&main).unwrap();
        sh(&main, &["init", "-q"]);
        std::fs::write(main.join("README.md"), "x\n").unwrap();
        sh(&main, &["add", "."]);
        sh(&main, &["commit", "-q", "-m", "init"]);
        sh(&base, &["init", "-q", "--bare", remote.to_str().unwrap()]);
        sh(
            &main,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        sh(&main, &["push", "-q", "origin", "main"]);
        sh(&main, &["fetch", "-q", "origin"]);
        sh(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "autopilot/2026-10-17",
                work.to_str().unwrap(),
            ],
        );
        World {
            _tmp: tempdir::Dir(base),
            main,
            work,
        }
    }

    fn scope() -> Scope {
        serde_json::from_value(json!({
            "branch": "autopilot/2026-10-17", "remote": "origin", "defaultBranch": "main"
        }))
        .unwrap()
    }

    fn commit(cwd: &std::path::Path, file: &str) {
        std::fs::write(cwd.join(file), format!("{file}\n")).unwrap();
        sh(cwd, &["add", file]);
        sh(cwd, &["commit", "-q", "-m", file]);
    }

    async fn audit(world: &World, before: &Snapshot, scope: &Scope) -> Vec<Violation> {
        let (work, main) = (world.work.to_str().unwrap(), world.main.to_str().unwrap());
        let after = take_snapshot(&git(), work, Some(main)).await.unwrap();
        audit_cycle(&git(), work, before, &after, scope)
            .await
            .unwrap()
    }

    async fn snapshot(world: &World) -> Snapshot {
        take_snapshot(
            &git(),
            world.work.to_str().unwrap(),
            world.main.to_str().unwrap().into(),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn a_cycle_that_only_committed_on_its_own_branch_passes() {
        let world = world();
        let before = snapshot(&world).await;
        commit(&world.work, "a.txt");
        commit(&world.work, "b.txt");
        assert_eq!(audit(&world, &before, &scope()).await, vec![]);
    }

    #[tokio::test]
    async fn children_branches_pass_when_named_and_count_when_not() {
        let world = world();
        let before = snapshot(&world).await;
        sh(&world.work, &["branch", "omp/agent/perf"]);
        let mut named = scope();
        named.child_branches = vec!["omp/agent/perf".into()];
        assert_eq!(audit(&world, &before, &named).await, vec![]);
        let kinds: Vec<_> = audit(&world, &before, &scope())
            .await
            .iter()
            .map(|v| v.kind)
            .collect();
        assert_eq!(kinds, ["ref"]);
    }

    #[tokio::test]
    async fn a_push_the_agent_was_not_allowed_is_caught_and_a_journaled_one_is_not() {
        let world = world();
        let before = snapshot(&world).await;
        commit(&world.work, "a.txt");
        sh(
            &world.work,
            &[
                "push",
                "-q",
                "origin",
                "HEAD:refs/heads/autopilot/2026-10-17",
            ],
        );
        let violations = audit(&world, &before, &scope()).await;
        assert_eq!(violations.len(), 1);
        assert!(
            violations[0]
                .detail
                .contains("refs/remotes/origin/autopilot/2026-10-17")
        );
        let mut expected = scope();
        expected.expected_refs = vec!["refs/remotes/origin/autopilot/2026-10-17".into()];
        assert_eq!(audit(&world, &before, &expected).await, vec![]);
        sh(
            &world.work,
            &["push", "-q", "origin", "HEAD:refs/heads/other"],
        );
        let details: Vec<_> = audit(&world, &before, &expected)
            .await
            .into_iter()
            .map(|v| v.detail)
            .collect();
        assert_eq!(details.len(), 1);
        assert!(details[0].contains("refs/remotes/origin/other"));
    }

    #[tokio::test]
    async fn a_rewound_own_branch_is_a_history_violation() {
        let world = world();
        commit(&world.work, "a.txt");
        let before = snapshot(&world).await;
        sh(&world.work, &["reset", "-q", "--hard", "HEAD~1"]);
        let violations = audit(&world, &before, &scope()).await;
        assert!(
            violations.iter().any(|v| v.kind == "history"),
            "{violations:?}"
        );
    }
}
