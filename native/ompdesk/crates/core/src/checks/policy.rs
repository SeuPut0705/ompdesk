//! What a `start` dispatches (design §5, §6): which workflow and inputs a purpose runs in a repo, its lane and pool,
//! and the digest a green result is reused on. Pure: the hub reads the files and hands their text in.
//!
//! - A repo may say it in `.ompdesk/checks.json` (beside `.ompdesk/worktree-setup`):
//!   `{"branch": {"workflow": "ci.yml", "inputs": {"batch": "true"}}, "release": {…, "macos": true}}`.
//! - Without it: `branch` runs `ci.yml` with `batch=true`, `release` with `batch=true mac=true`.
//! - Only the inputs the workflow's `on.workflow_dispatch.inputs` declares are sent, so a repo whose `ci.yml` has no
//!   `mac` input decides its own systems; a workflow with no `workflow_dispatch` cannot be started at all.
//! - A named workflow (`ompdesk checks start --workflow`, `scripts/ci-run.ts`) goes through the same filter; it is in
//!   the release lane when it asks for macOS from `main` or a `MAC_REFS` branch, else the branch lane.

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::contract::{Lane, Purpose, WorkflowAsk};

pub const REPO_FILE: &str = ".ompdesk/checks.json";
pub const DEFAULT_WORKFLOW: &str = "ci.yml";
pub const MACOS_POOL: &str = "github-macos";
/// Linux and Windows share the account's whole allowance; a run that asks for no macOS waits for that.
pub const HOSTED_POOL: &str = "github-linux";

/// One purpose's run as a repo states it, or the default.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Choice {
    pub workflow: String,
    #[serde(default)]
    pub inputs: BTreeMap<String, String>,
    /// Whether it takes macOS runners; unset: when it sends `mac=true`.
    #[serde(default)]
    pub macos: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoFile {
    #[serde(default)]
    branch: Option<Choice>,
    #[serde(default)]
    release: Option<Choice>,
}

fn default_choice(purpose: Purpose) -> Choice {
    let mut inputs = BTreeMap::from([("batch".to_owned(), "true".to_owned())]);
    if purpose == Purpose::Release {
        inputs.insert("mac".into(), "true".into());
    }
    Choice {
        workflow: DEFAULT_WORKFLOW.into(),
        inputs,
        macos: None,
    }
}

/// The run `purpose` dispatches, from the repo's `.ompdesk/checks.json` (its text, when it has one) or the default.
/// `land` is the merge queue's, never a dispatch of its own.
pub fn choose(purpose: Purpose, repo_file: Option<&str>) -> Result<Choice, String> {
    if purpose == Purpose::Land {
        return Err("a land goes through the merge queue".into());
    }
    let stated = match repo_file {
        Some(text) => {
            let file: RepoFile =
                serde_json::from_str(text).map_err(|error| format!("{REPO_FILE}: {error}"))?;
            match purpose {
                Purpose::Release => file.release,
                _ => file.branch,
            }
        }
        None => None,
    };
    Ok(stated.unwrap_or_else(|| default_choice(purpose)))
}

/// A named workflow as the caller gave it.
pub fn named(ask: &WorkflowAsk) -> Choice {
    Choice {
        workflow: ask.file.clone(),
        inputs: ask.inputs.clone(),
        macos: Some(ask.macos),
    }
}

/// What will be dispatched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub workflow: String,
    pub inputs: BTreeMap<String, String>,
    pub macos: bool,
}

/// The choice cut to the inputs the workflow declares (`declared`: None when it has no `workflow_dispatch`).
pub fn fit(choice: Choice, declared: Option<BTreeSet<String>>) -> Result<Plan, String> {
    let Some(declared) = declared else {
        return Err(format!(
            "{} cannot be dispatched (it has no on.workflow_dispatch)",
            choice.workflow
        ));
    };
    let inputs: BTreeMap<String, String> = choice
        .inputs
        .into_iter()
        .filter(|(name, _)| declared.contains(name))
        .collect();
    let macos = choice
        .macos
        .unwrap_or_else(|| inputs.get("mac").is_some_and(|value| value == "true"));
    Ok(Plan {
        workflow: choice.workflow,
        inputs,
        macos,
    })
}

/// Whether `git_ref` may take macOS runners: `main`, or a branch the repository variable `MAC_REFS` names (space or
/// comma separated, exact names; queue-gate.yml reads it the same way).
pub fn listed(git_ref: &str, mac_refs: &str) -> bool {
    git_ref == "main"
        || mac_refs
            .split([' ', ',', '\n', '\t'])
            .any(|name| name == git_ref)
}

/// The lane: a purpose's own, or for a named workflow release when it asks for macOS from `main` or a `MAC_REFS`
/// branch, else branch.
pub fn lane(purpose: Purpose, named: bool, macos: bool, git_ref: &str, mac_refs: &str) -> Lane {
    if !named {
        return match purpose {
            Purpose::Release => Lane::Release,
            Purpose::Land => Lane::Land,
            Purpose::Branch => Lane::Branch,
        };
    }
    if macos && listed(git_ref, mac_refs) {
        Lane::Release
    } else {
        Lane::Branch
    }
}

pub fn pool(macos: bool) -> &'static str {
    if macos { MACOS_POOL } else { HOSTED_POOL }
}

/// What a green result is reused on: the commit, the workflow file's own hash and the inputs (design §5: never the
/// sha alone).
pub fn digest(sha: &str, workflow_text: &str, inputs: &BTreeMap<String, String>) -> String {
    let mut hash = Sha256::new();
    hash.update(sha.as_bytes());
    hash.update(b"\n");
    hash.update(Sha256::digest(workflow_text.as_bytes()));
    for (name, value) in inputs {
        hash.update(format!("\n{name}={value}").as_bytes());
    }
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn indent(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

/// A mapping line's key and value, comments and quotes off; None for anything else.
fn key_value(line: &str) -> Option<(&str, &str)> {
    let text = line.trim();
    if text.is_empty() || text.starts_with('#') {
        return None;
    }
    let (key, value) = text.split_once(':')?;
    let key = key.trim().trim_matches(|c| c == '"' || c == '\'');
    let value = match value.find(" #") {
        Some(at) => &value[..at],
        None => value,
    };
    Some((key, value.trim()))
}

/// The inputs a workflow's `on.workflow_dispatch` declares; None when it has no `workflow_dispatch`. Reads the
/// shapes workflows are written in (`on: workflow_dispatch`, `on: [push, workflow_dispatch]`, a block of triggers,
/// `- workflow_dispatch` items), not YAML in general: an `inputs` written as a flow map counts as none.
pub fn dispatch_inputs(workflow: &str) -> Option<BTreeSet<String>> {
    let lines: Vec<&str> = workflow
        .lines()
        .filter(|line| {
            let text = line.trim();
            !text.is_empty() && !text.starts_with('#')
        })
        .collect();
    let at = lines.iter().position(|line| {
        indent(line) == 0 && key_value(line).is_some_and(|(key, _)| matches!(key, "on" | "true"))
    })?;
    let (_, value) = key_value(lines[at])?;
    if !value.is_empty() {
        let names = value.trim_start_matches('[').trim_end_matches(']');
        return names
            .split(',')
            .any(|name| name.trim() == "workflow_dispatch")
            .then(BTreeSet::new);
    }
    let block: Vec<&str> = lines[at + 1..]
        .iter()
        .take_while(|line| indent(line) > 0)
        .copied()
        .collect();
    let level = indent(block.first()?);
    let mut found = None;
    for (index, line) in block.iter().enumerate() {
        if indent(line) != level {
            continue;
        }
        let text = line.trim();
        if text.trim_start_matches("- ").trim() == "workflow_dispatch" {
            return Some(BTreeSet::new());
        }
        if key_value(line).is_some_and(|(key, _)| key == "workflow_dispatch") {
            found = Some(index);
            break;
        }
    }
    let start = found?;
    let mut inputs = BTreeSet::new();
    let below: Vec<&str> = block[start + 1..]
        .iter()
        .take_while(|line| indent(line) > level)
        .copied()
        .collect();
    let Some(first) = below.first() else {
        return Some(inputs);
    };
    let child = indent(first);
    let Some(at) = below.iter().position(|line| {
        indent(line) == child && key_value(line).is_some_and(|(key, _)| key == "inputs")
    }) else {
        return Some(inputs);
    };
    let named: Vec<&str> = below[at + 1..]
        .iter()
        .take_while(|line| indent(line) > child)
        .copied()
        .collect();
    if let Some(first) = named.first() {
        let input = indent(first);
        for line in named.iter().filter(|line| indent(line) == input) {
            if let Some((key, _)) = key_value(line) {
                inputs.insert(key.to_owned());
            }
        }
    }
    Some(inputs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(names: &[&str]) -> Option<BTreeSet<String>> {
        Some(names.iter().map(|name| (*name).to_owned()).collect())
    }

    #[test]
    fn reads_the_inputs_this_repos_workflows_declare() {
        let workflows = "../../../../../../.github/workflows";
        let read = |name: &str| {
            std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("src/checks")
                    .join(workflows)
                    .join(name),
            )
            .unwrap()
        };
        assert_eq!(
            dispatch_inputs(&read("ci.yml")),
            set(&[
                "batch",
                "e2e",
                "force",
                "install_check",
                "installer_check",
                "legacy_tag",
                "mac",
                "ticket",
                "win_e2e",
                "win_e2e_grep",
                "win_platform",
            ])
        );
        assert_eq!(
            dispatch_inputs(&read("flake-probe.yml")),
            set(&["grep", "os", "repeat", "spec", "ticket"])
        );
        // queue-gate.yml is only called: it cannot be dispatched.
        assert_eq!(dispatch_inputs(&read("queue-gate.yml")), None);
    }

    #[test]
    fn reads_every_way_a_workflow_names_its_triggers() {
        assert_eq!(
            dispatch_inputs("on: workflow_dispatch\njobs: {}\n"),
            set(&[])
        );
        assert_eq!(dispatch_inputs("on: [push, workflow_dispatch]\n"), set(&[]));
        assert_eq!(dispatch_inputs("on: [push]\n"), None);
        assert_eq!(
            dispatch_inputs("on:\n  - push\n  - workflow_dispatch\n"),
            set(&[])
        );
        assert_eq!(dispatch_inputs("\"on\":\n  workflow_dispatch:\n"), set(&[]));
        let block = "name: x\non:\n  push:\n    branches: [main]\n  workflow_dispatch:\n    inputs:\n      \
                     # a comment\n      level: # why\n        type: string\n        default: \"a: b\"\n      \
                     'quoted':\n        type: boolean\n  schedule:\n    - cron: x\njobs:\n  a:\n    inputs:\n";
        assert_eq!(dispatch_inputs(block), set(&["level", "quoted"]));
        assert_eq!(
            dispatch_inputs("on:\n  push:\n    branches: [main]\n"),
            None
        );
    }

    #[test]
    fn a_purpose_runs_the_repos_choice_cut_to_what_the_workflow_takes() {
        // The default, on a workflow that has neither `batch` nor `mac`: it decides its own systems.
        let plan = fit(choose(Purpose::Release, None).unwrap(), set(&["force"])).unwrap();
        assert_eq!(
            plan,
            Plan {
                workflow: "ci.yml".into(),
                inputs: BTreeMap::new(),
                macos: false,
            }
        );
        let plan = fit(
            choose(Purpose::Release, None).unwrap(),
            set(&["batch", "mac"]),
        )
        .unwrap();
        assert!(plan.macos);
        assert_eq!(plan.inputs.len(), 2);
        let file = r#"{"branch": {"workflow": "test.yml", "inputs": {"suite": "quick", "extra": "x"}, "macos": true}}"#;
        let plan = fit(
            choose(Purpose::Branch, Some(file)).unwrap(),
            set(&["suite"]),
        )
        .unwrap();
        assert_eq!(
            plan,
            Plan {
                workflow: "test.yml".into(),
                inputs: BTreeMap::from([("suite".into(), "quick".into())]),
                macos: true,
            }
        );
        // A purpose the file leaves out takes the default.
        assert_eq!(
            choose(Purpose::Release, Some(file)).unwrap().workflow,
            "ci.yml"
        );
        assert!(
            choose(Purpose::Branch, Some(r#"{"brnach": {}}"#))
                .unwrap_err()
                .starts_with(".ompdesk/checks.json:")
        );
        assert_eq!(
            fit(choose(Purpose::Branch, None).unwrap(), None).unwrap_err(),
            "ci.yml cannot be dispatched (it has no on.workflow_dispatch)"
        );
    }

    #[test]
    fn a_named_workflow_is_release_bound_only_with_macos_from_main_or_a_listed_branch() {
        assert_eq!(lane(Purpose::Branch, true, true, "main", ""), Lane::Release);
        assert_eq!(
            lane(Purpose::Branch, true, true, "rel", "a rel,b"),
            Lane::Release
        );
        assert_eq!(lane(Purpose::Branch, true, true, "re", "rel"), Lane::Branch);
        assert_eq!(lane(Purpose::Branch, true, false, "main", ""), Lane::Branch);
        assert_eq!(lane(Purpose::Release, false, false, "x", ""), Lane::Release);
    }

    #[test]
    fn the_digest_changes_with_the_commit_the_workflow_and_each_input() {
        let inputs = BTreeMap::from([("batch".to_owned(), "true".to_owned())]);
        let base = digest("abc", "on: x", &inputs);
        assert_ne!(base, digest("abd", "on: x", &inputs));
        assert_ne!(base, digest("abc", "on: y", &inputs));
        assert_ne!(base, digest("abc", "on: x", &BTreeMap::new()));
        assert_eq!(base, digest("abc", "on: x", &inputs.clone()));
    }
}
