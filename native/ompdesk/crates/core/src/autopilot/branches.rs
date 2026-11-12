//! Which branch an Autopilot run commits on and pushes to (was `src/shared/autopilot-branch.ts`, the rules, and
//! `src/main/autopilot-branches.ts`, the git reads behind them): what a run may not take, the default branch, the name
//! a new branch gets, the folder slug and the run id derived from the choice. The start sheet shows only the folder's
//! own branch (`read_info`); an agent's start re-reads every branch (`read_entries`) because a sheet's list may be old.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fs::order::is_js_space;
use crate::git::read::resolve;
use crate::git::run::Git;
use crate::run::Opts;

/// `AUTOPILOT_BRANCH_PREFIX` (`resources/gui-bridge/modes/autopilot-contracts.ts`).
pub const BRANCH_PREFIX: &str = "autopilot/";
const GIT_MS: u64 = 30_000;

/// What `git for-each-ref` and `git worktree list` said, already split.
#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchFacts {
    pub locals: Vec<String>,
    /// Branch names on the ship remote (without the remote's name), `HEAD` excluded.
    pub remotes: Vec<String>,
    /// Local branch → the worktree that has it checked out (the user's own folder included).
    pub worktrees: BTreeMap<String, String>,
    /// The branch the user's own folder is on; none when detached.
    pub current: Option<String>,
    pub default_branch: Option<String>,
}

/// One branch as a run's start reads it from git (`AutopilotBranchEntry`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub local: bool,
    pub remote: bool,
    pub default: bool,
    pub current: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_out_at: Option<String>,
}

/// `AutopilotBranchChoice`: where a run commits and pushes.
#[derive(Debug, Clone, PartialEq)]
pub enum Choice {
    New { name: Option<String> },
    Existing { name: String },
}

impl Choice {
    pub fn name(&self) -> &str {
        match self {
            Choice::New { name } => name.as_deref().unwrap_or(""),
            Choice::Existing { name } => name,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Problem {
    InvalidName,
    Exists,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    New,
    Local,
    Remote,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::New => "new",
            Mode::Local => "local",
            Mode::Remote => "remote",
        }
    }
}

/// `git worktree list --porcelain` → branch → path (detached and bare entries have no branch).
pub fn parse_worktree_branches(porcelain: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut path: Option<&str> = None;
    for line in porcelain.split('\n') {
        if let Some(folder) = line.strip_prefix("worktree ") {
            path = Some(folder);
        } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            if let Some(path) = path {
                out.insert(branch.to_owned(), path.to_owned());
            }
        } else if line.is_empty() {
            path = None;
        }
    }
    out
}

/// The picker's rows: the default branch first, then the user's own folder's branch, then the rest in the order git
/// gave (most recent first). A branch that is both local and on the remote is one row.
pub fn branch_entries(facts: &BranchFacts) -> Vec<Entry> {
    let mut names: Vec<&str> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for name in facts.locals.iter().chain(&facts.remotes) {
        if name == "HEAD" || !seen.insert(name) {
            continue;
        }
        names.push(name);
    }
    let rank = |name: &str| {
        if facts.default_branch.as_deref() == Some(name) {
            0
        } else if facts.current.as_deref() == Some(name) {
            1
        } else {
            2
        }
    };
    let mut ordered: Vec<(usize, &str)> = names.into_iter().enumerate().collect();
    ordered.sort_by_key(|(order, name)| (rank(name), *order));
    ordered
        .into_iter()
        .map(|(_, name)| Entry {
            name: name.to_owned(),
            local: facts.locals.iter().any(|local| local == name),
            remote: facts.remotes.iter().any(|remote| remote == name),
            default: facts.default_branch.as_deref() == Some(name),
            current: facts.current.as_deref() == Some(name),
            checked_out_at: facts
                .worktrees
                .get(name)
                .filter(|folder| !folder.is_empty())
                .cloned(),
        })
        .collect()
}

/// The default branch: the remote's HEAD when it says, else `main` or `master` when one exists.
pub fn pick_default_branch(remote_head: Option<&str>, names: &[String]) -> Option<String> {
    if let Some(head) = remote_head.filter(|head| !head.is_empty()) {
        return Some(head.to_owned());
    }
    ["main", "master"]
        .into_iter()
        .find(|name| names.iter().any(|known| known == name))
        .map(str::to_owned)
}

/// A branch name git accepts (`git check-ref-format --branch`, without the shell-out the sheet cannot do).
pub fn is_valid_branch_name(name: &str) -> bool {
    if name.is_empty()
        || name.encode_utf16().count() > 200
        || name.starts_with('-')
        || name.starts_with('/')
        || name.ends_with('/')
    {
        return false;
    }
    if name.ends_with('.') || name.ends_with(".lock") || name == "@" || name.contains("@{") {
        return false;
    }
    let forbidden = |c: char| {
        is_js_space(c)
            || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
            || c <= '\u{1f}'
            || c == '\u{7f}'
    };
    if name.chars().any(forbidden)
        || name.contains("..")
        || name.contains("//")
        || name.contains("/.")
    {
        return false;
    }
    !name
        .split('/')
        .any(|part| part.starts_with('.') || part.ends_with(".lock"))
}

/// `autopilot/<date>`, or `autopilot/<date>-2`, `-3`, … when a branch of that name exists.
pub fn suggest_branch_name(date: &str, taken: &HashSet<String>) -> String {
    let mut name = format!("{BRANCH_PREFIX}{date}");
    let mut suffix = 2;
    while taken.contains(&name) {
        name = format!("{BRANCH_PREFIX}{date}-{suffix}");
        suffix += 1;
    }
    name
}

/// Why the run cannot take `choice`, or none (a branch another worktree holds is no problem: see `via_work_branch`).
pub fn branch_problem(choice: &Choice, entries: &[Entry]) -> Option<Problem> {
    match choice {
        Choice::New { name: None } => None,
        Choice::New { name: Some(name) } => {
            if !is_valid_branch_name(name) {
                Some(Problem::InvalidName)
            } else if entries.iter().any(|entry| &entry.name == name) {
                Some(Problem::Exists)
            } else {
                None
            }
        }
        Choice::Existing { name } => match entries.iter().find(|entry| &entry.name == name) {
            Some(entry) if entry.local || entry.remote => None,
            _ => Some(Problem::Missing),
        },
    }
}

/// Whether a run on this branch commits straight onto the default branch (the sheet warns; Push then pushes to it).
pub fn is_default_branch_choice(choice: &Choice, entries: &[Entry]) -> bool {
    matches!(choice, Choice::Existing { name } if entries.iter().any(|entry| entry.default && &entry.name == name))
}

/// The branch Push pushes to when the run cannot work on it itself: another worktree (usually the user's own folder on
/// `main`) has it checked out, so the run works on its own branch cut from it and pushes `HEAD:<target>`.
pub fn via_work_branch(choice: &Choice, entries: &[Entry]) -> Option<String> {
    let Choice::Existing { name } = choice else {
        return None;
    };
    entries
        .iter()
        .find(|entry| &entry.name == name)
        .filter(|entry| entry.checked_out_at.is_some())
        .map(|entry| entry.name.clone())
}

/// How `worktree_create` makes the checkout for `choice`: a new branch, a local one, or one tracking the remote.
pub fn worktree_mode_for(choice: &Choice, entries: &[Entry]) -> Mode {
    if matches!(choice, Choice::New { .. }) || via_work_branch(choice, entries).is_some() {
        return Mode::New;
    }
    if entries
        .iter()
        .find(|entry| entry.name == choice.name())
        .is_some_and(|entry| entry.local)
    {
        Mode::Local
    } else {
        Mode::Remote
    }
}

/// The folder slug of a branch (`worktree_create`'s `name`: 1–41 chars of [a-z0-9-]); `fallback` when nothing is left.
pub fn branch_slug(branch: &str, fallback: &str) -> String {
    let lowered: String = branch
        .trim_matches(is_js_space)
        .chars()
        .flat_map(char::to_lowercase)
        .collect();
    let mut dashed = String::new();
    let mut in_run = false;
    for c in lowered.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            dashed.push(c);
            in_run = false;
        } else if !in_run {
            dashed.push('-');
            in_run = true;
        }
    }
    let trimmed = dashed.trim_matches('-');
    let cut: String = trimmed.chars().take(41).collect();
    let slug = cut.trim_end_matches('-');
    if slug.is_empty() {
        fallback.to_owned()
    } else {
        slug.to_owned()
    }
}

/// The run's id (children are `autopilot/<run>-c<N>-<area>`): the part after `autopilot/` for a branch there, else the
/// date. Never holds a `/` (a branch of that name and a directory of it cannot both exist).
pub fn run_id_for(branch: &str, date: &str) -> String {
    let Some(rest) = branch.strip_prefix(BRANCH_PREFIX) else {
        return date.to_owned();
    };
    let mut joined = String::new();
    let mut in_run = false;
    for c in rest.chars() {
        if c == '/' {
            if !in_run {
                joined.push('-');
                in_run = true;
            }
        } else {
            joined.push(c);
            in_run = false;
        }
    }
    let id = joined.trim_matches('-');
    if id.is_empty() {
        date.to_owned()
    } else {
        id.to_owned()
    }
}

/// A start's `branch` option as an agent or an older client sent it, tolerating a malformed value.
pub fn parse_choice(value: &Value) -> Option<Choice> {
    let object = value.as_object()?;
    let name = object.get("name").and_then(Value::as_str);
    match object.get("kind").and_then(Value::as_str)? {
        "new" => Some(Choice::New {
            name: name.filter(|name| !name.is_empty()).map(str::to_owned),
        }),
        "existing" => name
            .filter(|name| !name.is_empty())
            .map(|name| Choice::Existing {
                name: name.to_owned(),
            }),
        _ => None,
    }
}

/// The remote a start's `existing` choice named, when it names one (the `worktree_create` source's `remote`).
pub fn choice_remote(value: &Value) -> Option<&str> {
    value
        .get("remote")
        .and_then(Value::as_str)
        .filter(|remote| !remote.is_empty())
}

// ---- the git reads --------------------------------------------------------------------------------------------

fn slow() -> Opts<'static> {
    Opts {
        timeout_ms: Some(GIT_MS),
        ..Opts::default()
    }
}

async fn lines(git: &Git, cwd: &str, args: &[&str]) -> Vec<String> {
    match git.run(cwd, args, slow()).await {
        Ok(output) if output.code == 0 => output
            .text()
            .split('\n')
            .map(|line| line.trim_matches(is_js_space).to_owned())
            .filter(|line| !line.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// The repository's branches as git has them now; `remote` is the ship remote whose branches count.
pub async fn read_facts(git: &Git, cwd: &str, remote: &str) -> BranchFacts {
    let tracking = format!("refs/remotes/{remote}");
    let head = format!("refs/remotes/{remote}/HEAD");
    let list_heads = [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname)",
        "refs/heads",
    ];
    let list_remote = [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname)",
        tracking.as_str(),
    ];
    let list_trees = ["worktree", "list", "--porcelain"];
    let read_current = ["symbolic-ref", "--short", "-q", "HEAD"];
    let read_head = ["symbolic-ref", "--short", "-q", head.as_str()];
    let (heads, remotes, worktrees, current, remote_head) = tokio::join!(
        lines(git, cwd, &list_heads),
        lines(git, cwd, &list_remote),
        async { git.run(cwd, &list_trees, slow()).await.ok() },
        lines(git, cwd, &read_current),
        lines(git, cwd, &read_head),
    );
    let prefix = format!("refs/remotes/{remote}/");
    let locals: Vec<String> = heads
        .iter()
        .filter_map(|reference| reference.strip_prefix("refs/heads/"))
        .map(str::to_owned)
        .collect();
    let remote_names: Vec<String> = remotes
        .iter()
        .filter_map(|reference| reference.strip_prefix(&prefix))
        .filter(|name| *name != "HEAD")
        .map(str::to_owned)
        .collect();
    let remote_default = remote_head
        .first()
        .and_then(|name| name.strip_prefix(&format!("{remote}/")));
    let mut all = locals.clone();
    all.extend(remote_names.iter().cloned());
    BranchFacts {
        // git prints `C:/x` on Windows; the picker names the folders as native paths.
        worktrees: worktrees
            .filter(|output| output.code == 0)
            .map(|output| {
                parse_worktree_branches(&output.text())
                    .into_iter()
                    .map(|(branch, folder)| (branch, resolve("/", &folder)))
                    .collect()
            })
            .unwrap_or_default(),
        current: current.into_iter().next(),
        default_branch: pick_default_branch(remote_default, &all),
        locals,
        remotes: remote_names,
    }
}

/// What the start sheet shows of the repository `cwd` is in (`toplevel` its top level): the folder's own branch.
pub async fn read_info(git: &Git, cwd: &str, toplevel: &str, remote: &str) -> Value {
    let facts = read_facts(git, cwd, remote).await;
    serde_json::json!({
        "repo": toplevel,
        "remote": remote,
        "defaultBranch": facts.default_branch,
        "current": facts.current,
    })
}

/// The entries of `read_facts` (a start re-reads them: the sheet's list may be old).
pub async fn read_entries(git: &Git, cwd: &str, remote: &str) -> (Vec<Entry>, Option<String>) {
    let facts = read_facts(git, cwd, remote).await;
    (branch_entries(&facts), facts.default_branch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn captured() -> Value {
        serde_json::from_str(include_str!("captured-branches.json")).unwrap()
    }

    fn facts_of(value: &Value) -> BranchFacts {
        serde_json::from_value(value.clone()).unwrap()
    }

    fn choice_of(value: &Value) -> Choice {
        parse_choice(value).expect("a captured choice parses")
    }

    #[test]
    fn entries_match_the_typescript() {
        for case in captured()["entries"].as_array().unwrap() {
            let entries = branch_entries(&facts_of(&case["facts"]));
            assert_eq!(
                serde_json::to_value(entries).unwrap(),
                case["out"],
                "{case}"
            );
        }
    }

    #[test]
    fn problems_modes_and_targets_match_the_typescript() {
        for case in captured()["problems"].as_array().unwrap() {
            let entries = branch_entries(&facts_of(&case["facts"]));
            let choice = choice_of(&case["choice"]);
            let problem = branch_problem(&choice, &entries).map(|problem| match problem {
                Problem::InvalidName => json!({"code": "invalid_name"}),
                Problem::Exists => json!({"code": "exists"}),
                Problem::Missing => json!({"code": "missing"}),
            });
            assert_eq!(problem.unwrap_or(Value::Null), case["problem"], "{case}");
            assert_eq!(
                json!(is_default_branch_choice(&choice, &entries)),
                case["default"],
                "{case}"
            );
            assert_eq!(
                json!(via_work_branch(&choice, &entries)),
                case["via"],
                "{case}"
            );
            assert_eq!(
                json!(worktree_mode_for(&choice, &entries).as_str()),
                case["mode"],
                "{case}"
            );
        }
    }

    #[test]
    fn names_slugs_ids_and_choices_match_the_typescript() {
        let all = captured();
        for case in all["valid"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            assert_eq!(json!(is_valid_branch_name(name)), case["ok"], "{name:?}");
        }
        for case in all["suggest"].as_array().unwrap() {
            let taken: HashSet<String> = case["taken"]
                .as_array()
                .unwrap()
                .iter()
                .map(|name| name.as_str().unwrap().to_owned())
                .collect();
            assert_eq!(
                json!(suggest_branch_name(case["date"].as_str().unwrap(), &taken)),
                case["out"]
            );
        }
        for case in all["slug"].as_array().unwrap() {
            let out = branch_slug(
                case["branch"].as_str().unwrap(),
                case["fallback"].as_str().unwrap(),
            );
            assert_eq!(json!(out), case["out"], "{case}");
        }
        for case in all["runId"].as_array().unwrap() {
            let out = run_id_for(
                case["branch"].as_str().unwrap(),
                case["date"].as_str().unwrap(),
            );
            assert_eq!(json!(out), case["out"], "{case}");
        }
        for case in all["choice"].as_array().unwrap() {
            let parsed = parse_choice(&case["value"]).map(|choice| match choice {
                Choice::New { name: None } => json!({"kind": "new"}),
                Choice::New { name: Some(name) } => json!({"kind": "new", "name": name}),
                Choice::Existing { name } => {
                    let mut value = json!({"kind": "existing", "name": name});
                    if let Some(remote) = choice_remote(&case["value"]) {
                        value["remote"] = json!(remote);
                    }
                    value
                }
            });
            assert_eq!(parsed.unwrap_or(Value::Null), case["out"], "{case}");
        }
    }

    #[test]
    fn worktrees_and_default_branches_match_the_typescript() {
        let all = captured();
        for case in all["porcelain"].as_array().unwrap() {
            let out = parse_worktree_branches(case["input"].as_str().unwrap());
            assert_eq!(serde_json::to_value(out).unwrap(), case["out"], "{case}");
        }
        for case in all["defaults"].as_array().unwrap() {
            let names: Vec<String> = case["names"]
                .as_array()
                .unwrap()
                .iter()
                .map(|name| name.as_str().unwrap().to_owned())
                .collect();
            let out = pick_default_branch(case["remoteHead"].as_str(), &names);
            assert_eq!(json!(out), case["out"], "{case}");
        }
    }
}
