use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

use crate::application::omp_cli;

use crate::git::{read, repo_lock, run::Git, scm, triggers, unlanded};
use crate::pool::application::Sidecar;
use crate::run::Runner;
use crate::server::{Fault, Scope};
use super::protocol::{CommandError, CommandResult, RpcCommand};
use super::session::Session;

pub const COMMANDS: &[&str] = &[
    "get_git_status", "get_git_changes", "get_git_unlanded", "get_git_diff",
    "git_stage", "git_unstage", "git_discard", "git_commit", "git_commit_message", "git_last_commit_message",
    "git_undo_commit", "git_remote", "git_stash", "git_operation", "git_branches",
    "git_branch", "git_log", "git_commit_detail", "git_commit_diff", "git_history_action",
    "autopilot_branch_status",
];

const SLOW_MS: u64 = 300_000;

fn value<T: Serialize>(data: T) -> Result<Option<Value>, Fault> {
    serde_json::to_value(data).map(Some).map_err(|e| Fault::new("internal", e.to_string()))
}

fn scm_error(error: Fault) -> CommandError {
    match error.code.as_ref() {
        "git_failed" | "invalid_name" | "invalid_path" | "nothing_staged" | "no_remote" |
        "detached_head" | "push_rejected" | "branch_checked_out" | "dirty_worktree" | "commit_pushed" =>
            CommandError::local(error.code.to_string(), error.message),
        _ => CommandError::Other(error.message),
    }
}

fn safe_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    !path.is_empty() && !path.contains('\0') && !path.starts_with(['/', '\\']) &&
        !(bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'/' || bytes[2] == b'\\')) &&
        !path.split(['/', '\\']).any(|part| part == "..")
}

fn check_ref(name: &str) -> Result<(), Fault> {
    let valid = !name.is_empty() && name.encode_utf16().count() <= 200 && !name.starts_with(['-', '/']) &&
        !name.ends_with(['/', '.']) && !name.ends_with(".lock") && !name.contains("..") &&
        !name.contains("//") && !name.contains("@{") && name != "@" &&
        !name.chars().any(|c| crate::fs::order::is_js_space(c) || c <= '\u{1f}' || c == '\u{7f}' || "~^:?*[\\".contains(c)) &&
        !name.split('/').any(|part| part.starts_with('.'));
    if valid { Ok(()) } else { Err(Fault::new("invalid_name", format!("Invalid branch or tag name: {name}"))) }
}

fn check_sha(sha: &str) -> Result<(), Fault> {
    if (4..=64).contains(&sha.len()) && sha.bytes().all(|b| b.is_ascii_hexdigit()) { Ok(()) }
    else { Err(Fault::new("invalid_name", format!("Invalid commit: {sha}"))) }
}

fn paths(command: &RpcCommand, all: bool) -> Result<Option<Vec<String>>, Fault> {
    let input = command.params.get("paths");
    if all && input.and_then(Value::as_str) == Some("all") { return Ok(None); }
    let array = input.and_then(Value::as_array).filter(|a| !a.is_empty())
        .ok_or_else(|| Fault::new("invalid_path", "Invalid repository-relative path"))?;
    let mut paths = Vec::with_capacity(array.len());
    for entry in array {
        let path = entry.as_str().filter(|s| safe_path(s))
            .ok_or_else(|| Fault::new("invalid_path", "Invalid repository-relative path"))?;
        paths.push(path.to_owned());
    }
    Ok(Some(paths))
}

async fn remove_fresh(root: String, discarded: scm::Discarded, scope: Scope) -> Result<(), Fault> {
    let data = serde_json::to_value(discarded).map_err(|e| Fault::new("internal", e.to_string()))?;
    let fresh: Vec<String> = data["fresh"].as_array().ok_or_else(|| Fault::new("internal", "Invalid discarded paths"))?
        .iter().filter_map(Value::as_str).map(str::to_owned).collect();
    if fresh.is_empty() { return Ok(()); }
    tokio::task::spawn_blocking(move || {
        crate::disk::tree::live(&scope)?;
        let real = crate::fs::disk::realpath(&root).map_err(|error| Fault::new("io", error.to_string()))?;
        for file in fresh {
            if !safe_path(&file) || file.starts_with("..") { continue; }
            crate::disk::tree::remove(&real.join(file), false, &scope)?;
        }
        Ok(())
    }).await.map_err(|error| Fault::new("internal", error.to_string()))?
}

fn branch_ref<'a>(input: Option<&'a Value>, what: &str) -> Result<&'a str, CommandError> {
    input.and_then(Value::as_str).filter(|value| {
        !value.is_empty() && !value.starts_with('-') && !value.contains("..")
            && !value.chars().any(crate::fs::order::is_js_space)
    }).ok_or_else(|| CommandError::local("invalid_ref", format!("Invalid {what}.")))
}

pub async fn handle<S: Sidecar<Error = Fault> + ?Sized + 'static>(command: &RpcCommand, session: &Session<S>, runner: Option<&Runner>, omp: &omp_cli::Service, scope: Scope) -> CommandResult {
    let cwd = session.cwd();
    if command.kind == "autopilot_branch_status" {
        let root = command.string("root").filter(|root| !root.is_empty())
            .ok_or_else(|| CommandError::local("invalid_root", "Invalid root."))?;
        let base = branch_ref(command.params.get("base"), "base branch")?;
        let branch = branch_ref(command.params.get("branch"), "branch")?;
        let runner = runner.cloned().ok_or_else(|| CommandError::local(
            "git_failed", format!("Could not compare {branch} with {base}: git failed"),
        ))?;
        let result = triggers::branch_status(&Git::new(runner, scope), root, base, branch).await
            .map_err(|fault| CommandError::local("git_failed", if fault.code == "git_failed" {
                fault.message
            } else { format!("Could not compare {branch} with {base}: git failed") }))?;
        return value(result).map_err(Into::into);
    }
    if command.kind == "get_git_diff" && !safe_path(command.string("path").unwrap_or("")) {
        return Err(CommandError::Other("Invalid repository-relative path".into()));
    }
    let name = command.string("name").unwrap_or("");
    let sha = command.string("sha").unwrap_or("");
    let action = command.string("action").unwrap_or("");
    if command.kind == "git_commit" && crate::fs::order::js_trim(command.string("message").unwrap_or("")).is_empty() {
        return Err(CommandError::local("invalid_name", "A commit needs a message"));
    }
    if command.kind == "git_branch" { check_ref(name).map_err(scm_error)?; }
    if command.kind == "git_history_action" {
        if !["checkout", "branch", "cherry_pick", "revert", "reset", "tag", "delete_tag", "move_earlier", "move_later"].contains(&action) {
            let text = command.params.get("action").map_or("undefined".to_owned(), |v| match v { Value::String(s) => s.clone(), _ => v.to_string() });
            return Err(CommandError::Other(format!("Unknown history action: {text}")));
        }
        check_sha(sha).map_err(scm_error)?;
    }
    let runner = runner.cloned().ok_or_else(|| CommandError::Other("git is not installed or not on PATH".into()))?;
    let git = Git::new(runner.clone(), scope.clone());
    match command.kind.as_str() {
        "get_git_status" => return value(read::status(&git, &cwd).await?).map_err(Into::into),
        "get_git_changes" => return value(read::changes(&git, &cwd).await?).map_err(Into::into),
        "get_git_unlanded" => return value(unlanded::unlanded(&git, &cwd).await?).map_err(Into::into),
        "get_git_diff" => {
            let path = command.string("path").unwrap_or("");
            return value(read::diff(&git, &cwd, path).await?).map_err(Into::into);
        }
        _ => {}
    }
    let root = read::repo_root(&git, &cwd).await.map_err(CommandError::from)?
        .ok_or_else(|| CommandError::local("not_a_repo", format!("Not a git repository: {cwd}")))?;
    match command.kind.as_str() {
        "git_commit_message" => {
            let staged = scm::staged(&git, &root).await.map_err(scm_error)?;
            let staged = serde_json::to_value(staged).map_err(|e| CommandError::Other(e.to_string()))?;
            if staged["staged"] != Value::Bool(true) {
                return Err(CommandError::local("nothing_staged", "Stage changes first"));
            }
            let output = omp.run(omp_cli::Command {
                args: ["commit", "--dry-run", "--legacy", "--no-changelog"].into_iter().map(str::to_owned).collect(),
                cwd: root.into(),
                input: Vec::new(),
                timeout: Duration::from_secs(180),
                env: Default::default(),
                launch: omp_cli::LaunchMode::Runtime,
            }, scope).await.map_err(|error| CommandError::local("commit_message_failed", format!("omp commit failed: {}", error.message)))?;
            let message = if output.code == 0 {
                output.stdout.rsplit_once("Generated commit message:")
                    .map(|(_, text)| crate::fs::order::js_trim(text))
                    .filter(|text| !text.is_empty())
            } else { None };
            let Some(message) = message else {
                let detail = if output.stderr.is_empty() { &output.stdout } else { &output.stderr };
                let units: Vec<u16> = crate::fs::order::js_trim(detail).encode_utf16().collect();
                let detail = String::from_utf16_lossy(&units[units.len().saturating_sub(400)..]);
                let suffix = if detail.is_empty() { String::new() } else { format!(": {detail}") };
                return Err(CommandError::local("commit_message_failed", format!("omp commit gave no message{suffix}")));
            };
            let warning = output.stderr.match_indices("requires manual correction: ").find_map(|(at, marker)| {
                let text = &output.stderr[at + marker.len()..];
                let line = text.split(['\n', '\r', '\u{2028}', '\u{2029}']).next().unwrap_or("");
                (!line.is_empty()).then(|| crate::fs::order::js_trim(line))
            });
            return Ok(Some(match warning {
                Some(warning) if !warning.is_empty() => serde_json::json!({ "message": message, "warning": warning }),
                _ => serde_json::json!({ "message": message }),
            }));
        }
        "git_last_commit_message" => return value(scm::last_commit_message(&git, &root).await.map_err(scm_error)?).map_err(Into::into),
        "git_branches" => return value(scm::branches(&git, &root).await.map_err(scm_error)?).map_err(Into::into),
        "git_log" => {
            let query = command.string("query").map(crate::fs::order::js_trim).filter(|s| !s.is_empty());
            return value(scm::log(&git, &root, command.params.get("limit").and_then(Value::as_f64), command.params.get("skip").and_then(Value::as_f64), query).await.map_err(scm_error)?).map_err(Into::into);
        }
        "git_commit_detail" | "git_commit_diff" => {
            check_sha(sha).map_err(scm_error)?;
            if command.kind == "git_commit_detail" { return value(scm::commit_detail(&git, &root, sha).await.map_err(scm_error)?).map_err(Into::into); }
            let path = command.string("path").unwrap_or("");
            if !safe_path(path) { return Err(CommandError::local("invalid_path", "Invalid repository-relative path")); }
            return value(scm::commit_diff(&git, &root, sha, path).await.map_err(scm_error)?).map_err(Into::into);
        }
        _ => {}
    }
    let primary = read::primary_root(&git, &root).await.map_err(|e| CommandError::local("git_failed", e.message))?;
    let command = command.clone();
    let result = repo_lock::run(&primary, scope, move |scope| async move {
        let git = Git::new(runner, scope.clone());
        let action = command.string("action").unwrap_or("");
        match command.kind.as_str() {
            "git_stage" | "git_unstage" => {
                let paths = paths(&command, true)?;
                if command.kind == "git_stage" { scm::stage(&git, &root, paths.as_deref()).await?; }
                else { scm::unstage(&git, &root, paths.as_deref()).await?; }
                Ok(None)
            }
            "git_discard" => {
                let paths = paths(&command, false)?.unwrap_or_default();
                let discarded = scm::discard(&git, &root, &paths).await?;
                remove_fresh(root.clone(), discarded, scope).await?;
                Ok(None)
            }
            "git_commit" => value(scm::commit(&git, &root, crate::fs::order::js_trim(command.string("message").unwrap_or("")), command.is_true("amend"), SLOW_MS).await?),
            "git_undo_commit" => { scm::undo_commit(&git, &root).await?; Ok(None) }
            "git_remote" => value(scm::remote(&git, &root, match action { "push" => scm::RemoteAction::Push, "pull" => scm::RemoteAction::Pull, _ => scm::RemoteAction::Fetch }, SLOW_MS).await?),
            "git_stash" => value(scm::stash(&git, &root, if action == "pop" { scm::StashAction::Pop } else { scm::StashAction::Push }, if action == "pop" { None } else { command.string("message").map(crate::fs::order::js_trim).filter(|s| !s.is_empty()) }, SLOW_MS).await?),
            "git_operation" => value(scm::operation(&git, &root, if action == "abort" { scm::OperationAction::Abort } else { scm::OperationAction::Continue }, SLOW_MS).await?),
            "git_branch" => {
                let action = match action { "create" => scm::BranchAction::Create, "rename" => scm::BranchAction::Rename, "delete" => scm::BranchAction::Delete, "merge" => scm::BranchAction::Merge, _ => scm::BranchAction::Switch };
                let new_name = if action == scm::BranchAction::Rename { command.string("newName").unwrap_or("") } else { "" };
                let base = if action == scm::BranchAction::Create { command.string("base").filter(|s| !s.is_empty()) } else { None };
                if action == scm::BranchAction::Rename { check_ref(new_name)?; }
                if let Some(base) = base { check_ref(base)?; }
                value(scm::branch(&git, &root, scm::BranchInput { action, name: command.string("name").unwrap_or(""), new_name, base, force: command.is_true("force") }, SLOW_MS).await?)
            }
            "git_history_action" => {
                let action = match action { "checkout" => scm::HistoryAction::Checkout, "branch" => scm::HistoryAction::Branch, "cherry_pick" => scm::HistoryAction::CherryPick, "revert" => scm::HistoryAction::Revert, "reset" => scm::HistoryAction::Reset, "tag" => scm::HistoryAction::Tag, "delete_tag" => scm::HistoryAction::DeleteTag, "move_earlier" => scm::HistoryAction::MoveEarlier, _ => scm::HistoryAction::MoveLater };
                let name = if matches!(action, scm::HistoryAction::Branch | scm::HistoryAction::Tag | scm::HistoryAction::DeleteTag) { command.string("name").unwrap_or("") } else { "" };
                if matches!(action, scm::HistoryAction::Branch | scm::HistoryAction::Tag | scm::HistoryAction::DeleteTag) { check_ref(name)?; }
                let mode = if action == scm::HistoryAction::Reset { match command.string("mode") { Some("soft") => "soft", Some("hard") => "hard", _ => "mixed" } } else { "" };
                value(scm::history_action(&git, &root, action, command.string("sha").unwrap_or(""), mode, name, SLOW_MS).await?)
            }
            _ => Err(Fault::new("internal", "Unknown git command")),
        }
    }).await;
    result.map_err(|error| match error.code.as_ref() {
        "invalid_path" | "invalid_name" | "git_failed" | "nothing_staged" | "no_remote" | "detached_head" | "push_rejected" | "branch_checked_out" | "dirty_worktree" | "commit_pushed" => scm_error(error),
        _ => CommandError::local("git_failed", error.message),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_comparison_rejects_range_options_and_javascript_whitespace() {
        for name in ["", "-topic", "a..b", "a b", "topic\u{feff}"] {
            assert_eq!(
                branch_ref(Some(&Value::from(name)), "base branch").unwrap_err(),
                CommandError::local("invalid_ref", "Invalid base branch."),
            );
        }
        for name in ["topic/name", "release.v2", "topic\u{85}"] {
            let input = Value::from(name);
            assert_eq!(branch_ref(Some(&input), "branch").unwrap(), name);
        }
        assert_eq!(
            branch_ref(None, "branch").unwrap_err(),
            CommandError::local("invalid_ref", "Invalid branch."),
        );
    }
}
