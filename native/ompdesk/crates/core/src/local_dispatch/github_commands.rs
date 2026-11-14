use std::sync::LazyLock;
use std::time::Duration;

use regress::Regex;
use serde::Serialize;
use serde_json::{Value, json};

use crate::control::js;
use crate::agentctl::service::host::node_resolve;
use crate::agentctl::service::js::slice16;
use crate::application::omp_cli;
use crate::disk::tree;
use crate::fs::order::is_js_space;
use crate::gh::{Runners, Tools, center, pr};
use crate::git::{read, repo_lock};
use crate::pool::application::Sidecar;
use crate::run::Runner;
use crate::server::{Fault, Scope};

use super::protocol::{CommandError, CommandResult, RpcCommand};
use super::session::Session;

pub const COMMANDS: &[&str] = &[
    "github", "pr_repo", "pr_list", "pr_get", "pr_diff", "pr_draft", "pr_create", "pr_checkout",
    "pr_merge", "pr_review", "pr_comment", "pr_comments", "pr_edit",
];

fn error(fault: Fault) -> CommandError {
    match fault.code.as_ref() {
        "gh_missing" | "gh_unauthenticated" | "not_a_repo" | "no_github_remote" |
        "pr_not_found" | "pr_create_failed" | "pr_draft_failed" | "pr_merge_failed" |
        "pr_review_failed" | "pr_edit_failed" | "github_failed" => CommandError::local(fault.code, fault.message),
        _ => CommandError::Other(fault.message),
    }
}

fn value<T: Serialize>(tools: &Tools, result: Result<T, Fault>) -> CommandResult {
    let result = tools.gh.answer(result).map_err(error)?;
    serde_json::to_value(result).map(Some).map_err(|e| CommandError::Other(e.to_string()))
}

fn number(input: Option<&Value>) -> f64 {
    match input {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(value)) => if *value { 1.0 } else { 0.0 },
        Some(Value::Number(value)) => value.as_f64().unwrap_or(f64::NAN),
        Some(value) => {
            let text = js::string_of_value(value);
            let text = js::trim(&text);
            if text.is_empty() { return 0.0; }
            for (prefix, radix) in [("0x", 16), ("0X", 16), ("0b", 2), ("0B", 2), ("0o", 8), ("0O", 8)] {
                if let Some(digits) = text.strip_prefix(prefix) {
                    if digits.is_empty() { return f64::NAN; }
                    return digits.chars().try_fold(0.0, |n, c| c.to_digit(radix).map(|digit| n * radix as f64 + digit as f64)).unwrap_or(f64::NAN);
                }
            }
            if matches!(text, "inf" | "+inf" | "-inf" | "infinity" | "+infinity" | "-infinity") { return f64::NAN; }
            text.parse().unwrap_or(f64::NAN)
        }
    }
}

fn checked_number(command: &RpcCommand, code: &str) -> Result<u64, CommandError> {
    let n = number(command.params.get("number"));
    if !n.is_finite() || n.fract() != 0.0 || n <= 0.0 || n > 9_007_199_254_740_991.0 {
        return Err(CommandError::local(code, format!("Invalid PR number: {}", js::number(n))));
    }
    Ok(n as u64)
}

const GITHUB_OPS: &[&str] = &[
    "hosts", "issue_list", "issue_get", "issue_create", "issue_edit", "issue_state",
    "issue_comment", "repo_list", "repo_get", "repo_create", "repo_clone", "repo_fork",
    "workflow_list", "run_list", "run_get", "run_log", "workflow_dispatch", "run_rerun",
    "run_cancel", "release_list", "release_get", "release_create", "release_edit",
    "notification_list", "notification_read", "notification_read_all",
];

fn invalid(issues: &[Value]) -> CommandError {
    CommandError::local("github_failed", format!("Invalid GitHub request: {}", serde_json::to_string_pretty(issues).expect("JSON issues serialize")))
}

fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn type_issue(expected: &str, input: Option<&Value>, path: Value, enum_type: bool) -> Value {
    let got = received(input);
    let message = if got == "undefined" { "Required".to_owned() } else { format!("Expected {expected}, received {got}") };
    if enum_type {
        json!({"expected":expected,"received":got,"code":"invalid_type","path":path,"message":message})
    } else {
        json!({"code":"invalid_type","expected":expected,"received":got,"path":path,"message":message})
    }
}

fn length_issue(key: &str, bound: usize, small: bool) -> Value {
    if small {
        json!({"code":"too_small","minimum":bound,"type":"string","inclusive":true,"exact":false,"message":format!("String must contain at least {bound} character(s)"),"path":[key]})
    } else {
        json!({"code":"too_big","maximum":bound,"type":"string","inclusive":true,"exact":false,"message":format!("String must contain at most {bound} character(s)"),"path":[key]})
    }
}

fn regex_match(pattern: &Regex, text: &str) -> bool {
    let units: Vec<u16> = text.encode_utf16().collect();
    let matched = pattern.find_from_ucs2(&units, 0).next().is_some();
    matched
}

static REPO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$").expect("repository regex"));
static HOST: LazyLock<Regex> = LazyLock::new(|| Regex::with_flags(r"^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$", "i").expect("host regex"));
static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._-]{1,100}$").expect("repository name regex"));
static NOTIFICATION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{1,20}$").expect("notification regex"));

static DRAFT_IF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{\{#if (\w+)\}\}([\s\S]*?)\{\{/if\}\}").expect("draft conditional regex"));
static DRAFT_VAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{\{(\w+)\}\}").expect("draft variable regex"));

fn render_draft_prompt(template: &str, vars: &[(&str, String)]) -> String {
    let find = |name: &[u16]| vars.iter().find(|(key, _)| key.encode_utf16().eq(name.iter().copied())).map(|(_, value)| value.as_str());
    let source: Vec<u16> = template.encode_utf16().collect();
    let mut conditional = Vec::with_capacity(source.len());
    let mut end = 0;
    for found in DRAFT_IF.find_from_ucs2(&source, 0) {
        conditional.extend_from_slice(&source[end..found.start()]);
        if let (Some(name), Some(body)) = (found.group(1), found.group(2)) {
            if find(&source[name]).is_some_and(|value| !value.is_empty()) {
                conditional.extend_from_slice(&source[body]);
            }
        }
        end = found.end();
    }
    conditional.extend_from_slice(&source[end..]);
    let mut output = Vec::with_capacity(conditional.len());
    let mut end = 0;
    for found in DRAFT_VAR.find_from_ucs2(&conditional, 0) {
        output.extend_from_slice(&conditional[end..found.start()]);
        if let Some(name) = found.group(1) {
            if let Some(value) = find(&conditional[name]) { output.extend(value.encode_utf16()); }
        }
        end = found.end();
    }
    output.extend_from_slice(&conditional[end..]);
    String::from_utf16_lossy(&output)
}

fn extract_draft(output: &str) -> Option<(String, String)> {
    let bytes = output.as_bytes();
    for start in bytes.iter().enumerate().filter_map(|(i, byte)| (*byte == b'{').then_some(i)) {
        let mut depth = 0usize;
        let mut quoted = false;
        let mut i = start;
        while i < bytes.len() {
            let ch = bytes[i];
            if quoted {
                if ch == b'\\' { i += 1; } else if ch == b'\"' { quoted = false; }
            } else if ch == b'\"' {
                quoted = true;
            } else if ch == b'{' {
                depth += 1;
            } else if ch == b'}' {
                depth -= 1;
                if depth == 0 {
                    let candidate = crate::json::whole_surrogates(&output[start..=i]);
                    if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(&candidate) {
                        if let (Some(title), Some(body)) = (object.get("title").and_then(Value::as_str), object.get("body").and_then(Value::as_str)) {
                            return Some((title.to_owned(), body.to_owned()));
                        }
                    }
                    break;
                }
            }
            i += 1;
        }
    }
    None
}

fn github_request(raw: Option<&Value>) -> Result<Value, CommandError> {
    let Some(mut request) = raw.and_then(Value::as_object).cloned() else {
        let issue = type_issue("object", raw, json!([]), false);
        return Err(invalid(&[issue.clone(), issue]));
    };
    let op = request.get("op").and_then(Value::as_str).unwrap_or("").to_owned();
    let mut issues = Vec::new();
    let mut allowed = vec!["op", "host", "repo"];
    let fields: &[(&str, &str, bool)] = match op.as_str() {
        "hosts" | "repo_get" | "repo_fork" | "workflow_list" | "release_list" | "notification_read_all" => &[],
        "issue_list" => &[("state", "issue_state_all", false), ("search", "search", true)],
        "issue_get" => &[("number", "id", false)],
        "issue_create" => &[("title", "title", false), ("body", "text", false)],
        "issue_edit" => &[("number", "id", false), ("title", "title", false), ("body", "text", false)],
        "issue_state" => &[("number", "id", false), ("state", "issue_state", false)],
        "issue_comment" => &[("number", "id", false), ("body", "comment", false)],
        "repo_list" => &[("owner", "word", true)],
        "repo_create" => &[("name", "repo_name", false), ("visibility", "visibility", false), ("description", "description", false)],
        "repo_clone" => &[("destination", "destination", false)],
        "run_list" => &[("workflow", "word", true)],
        "run_get" | "run_cancel" => &[("id", "id", false)],
        "run_log" | "run_rerun" => &[("id", "id", false), ("failedOnly", "bool", false)],
        "workflow_dispatch" => &[("workflow", "word", false), ("ref", "word", true)],
        "release_get" => &[("tag", "word", false)],
        "release_create" => &[("tag", "word", false), ("title", "title", false), ("notes", "text", false), ("draft", "bool", false), ("prerelease", "bool", false), ("target", "word", true)],
        "release_edit" => &[("tag", "word", false), ("title", "title", false), ("notes", "text", false), ("draft", "bool", false), ("prerelease", "bool", false)],
        "notification_list" => &[("all", "bool", false)],
        "notification_read" => &[("id", "notification_id", false)],
        _ => {
            let expected = GITHUB_OPS.iter().map(|op| format!("'{op}'")).collect::<Vec<_>>().join(" | ");
            issues.push(json!({"code":"invalid_union_discriminator","options":GITHUB_OPS,"path":["op"],"message":format!("Invalid discriminator value. Expected {expected}")}));
            &[]
        },
    };
    for (key, kind, optional) in fields.iter().copied().chain([("host", "host", true), ("repo", "repo", true)]) {
        allowed.push(key);
        let input = request.get(key);
        if optional && input.is_none() { continue; }
        let enum_values: Option<&[&str]> = match kind {
            "issue_state" => Some(&["open", "closed"]),
            "issue_state_all" => Some(&["open", "closed", "all"]),
            "visibility" => Some(&["public", "private", "internal"]),
            _ => None,
        };
        let expected = if let Some(values) = enum_values {
            values.iter().map(|v| format!("'{v}'")).collect::<Vec<_>>().join(" | ")
        } else {
            match kind { "id" => "number", "bool" => "boolean", _ => "string" }.to_owned()
        };
        let actual = received(input);
        let expected_type = if enum_values.is_some() { "string" } else { expected.as_str() };
        if actual != expected_type {
            issues.push(type_issue(&expected, input, json!([key]), enum_values.is_some()));
            continue;
        }
        let Some(item) = request.get_mut(key) else { continue };
        if kind == "bool" { continue; }
        if kind == "id" {
            let n = item.as_f64().unwrap_or(f64::NAN);
            if n.fract() != 0.0 {
                issues.push(json!({"code":"invalid_type","expected":"integer","received":"float","message":"Expected integer, received float","path":[key]}));
            }
            if n <= 0.0 {
                issues.push(json!({"code":"too_small","minimum":0,"type":"number","inclusive":false,"exact":false,"message":"Number must be greater than 0","path":[key]}));
            }
            if n > 9_007_199_254_740_991.0 {
                issues.push(json!({"code":"too_big","maximum":9007199254740991_u64,"type":"number","inclusive":true,"exact":false,"message":"Number must be less than or equal to 9007199254740991","path":[key]}));
            }
            if n > 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0 {
                *item = Value::from(n as u64);
            }
            continue;
        }
        let Some(text) = item.as_str() else { continue };
        let trimmed = matches!(kind, "word" | "title" | "comment" | "search" | "description");
        let text = if trimmed { js::trim(text) } else { text };
        let len = text.encode_utf16().count();
        if let Some(values) = enum_values {
            if !values.contains(&text) {
                issues.push(json!({"received":text,"code":"invalid_enum_value","options":values,"path":[key],"message":format!("Invalid enum value. Expected {expected}, received '{text}'")}));
            }
        }
        let min = matches!(kind, "word" | "title" | "comment");
        let max = match kind { "word" => Some(250), "title" | "search" => Some(256), "comment" | "text" => Some(65_536), "description" => Some(350), _ => None };
        if min && len == 0 { issues.push(length_issue(key, 1, true)); }
        if let Some(max) = max {
            if len > max { issues.push(length_issue(key, max, false)); }
        }
        let custom_invalid = match kind {
            "word" => text.starts_with('-') || text.chars().any(is_js_space),
            "repo_name" => !regex_match(&NAME, text) && !regex_match(&REPO, text),
            "destination" => !js::is_absolute(text),
            _ => false,
        };
        if custom_invalid { issues.push(json!({"code":"custom","message":"Invalid input","path":[key]})); }
        let regex_invalid = match kind {
            "host" => !regex_match(&HOST, text),
            "repo" => !regex_match(&REPO, text),
            "notification_id" => !regex_match(&NOTIFICATION, text),
            _ => false,
        };
        if regex_invalid { issues.push(json!({"validation":"regex","code":"invalid_string","message":"Invalid","path":[key]})); }
        if trimmed { *item = Value::String(text.to_owned()); }
    }
    if !issues.is_empty() { return Err(invalid(&issues)); }
    request.retain(|key, _| allowed.contains(&key.as_str()));
    Ok(Value::Object(request))
}

pub async fn handle<S: Sidecar<Error = Fault> + ?Sized + 'static>(
    command: &RpcCommand, session: &Session<S>, git: Option<&Runner>, gh: Option<&Runner>, omp: &omp_cli::Service, scope: Scope,
) -> CommandResult {
    let cwd = session.cwd();
    let tools = Tools::new(Runners { git: git.cloned(), gh: gh.cloned() }, scope.clone());
    let number = || number(command.params.get("number"));
    let text = |key| command.string(key).unwrap_or("");
    match command.kind.as_str() {
        "github" => {
            let mut request = github_request(command.params.get("request"))?;
            if request["op"] == "repo_clone" {
                let destination = node_resolve(request["destination"].as_str().expect("validated clone destination"));
                let path = std::path::Path::new(&destination);
                let parent = path.parent().unwrap_or(path).to_string_lossy().into_owned();
                request["destination"] = Value::String(destination);
                request["parent"] = Value::String(parent);
            }
            let result = tools.gh.answer(center::command(&tools, &cwd, &request, center::Timeouts { clone_ms: 600_000, log_ms: 120_000 }).await).map_err(error)?;
            serde_json::from_str(result.result.get()).map(Some).map_err(|e| CommandError::Other(e.to_string()))
        }
        "pr_repo" => value(&tools, pr::availability(&tools, &cwd).await),
        "pr_list" => {
            let view = match command.string("view") { Some("review") => pr::View::Review, Some("mine") => pr::View::Mine, _ => pr::View::All };
            value(&tools, pr::list(&tools, &cwd, command.string("state"), command.params.get("limit").and_then(Value::as_f64), view).await)
        }
        "pr_get" => value(&tools, pr::detail(&tools, &cwd, Some(number()).filter(|n| n.is_finite())).await),
        "pr_diff" => value(&tools, pr::diff(&tools, &cwd, Some(number()).filter(|n| n.is_finite()), text("path")).await),
        "pr_draft" => {
            let facts = tools.gh.answer(pr::draft_facts(&tools, &cwd, command.string("base").map(str::to_owned), command.string("head").map(str::to_owned)).await).map_err(error)?;
            let vars = [
                ("base", facts.base),
                ("head", facts.head),
                ("commitCount", facts.commits.len().to_string()),
                ("commits", facts.commits.join("\n")),
                ("fileCount", facts.files.len().to_string()),
                ("files", slice16(&facts.files.join("\n"), 0, 6000)),
                ("diffStat", slice16(&facts.diff_stat, 0, 3000)),
            ];
            let user = render_draft_prompt(include_str!("pr-draft-user.txt"), &vars);
            let prompt = format!("{}\n\n---\n\n{user}", js::trim(include_str!("pr-draft-system.txt")));
            let model_command = omp_cli::Command {
                args: ["-p", "--no-session", "--no-tools", "--no-lsp"].into_iter().map(str::to_owned).collect(),
                cwd: facts.root.into(),
                input: prompt.into_bytes(),
                timeout: Duration::from_millis(170_000),
                env: Default::default(),
                launch: omp_cli::LaunchMode::Runtime,
            };
            let output = omp.run(model_command, scope).await.map_err(|fault| CommandError::local("pr_draft_failed", format!("Draft failed: {}", fault.message)))?;
            if output.code == 0 {
                if let Some((title, body)) = extract_draft(&output.stdout) {
                    return Ok(Some(json!({"title":js::trim(&title),"body":js::trim(&body)})));
                }
            }
            let detail = if output.stderr.is_empty() { &output.stdout } else { &output.stderr };
            let detail = slice16(js::trim(detail), 0, 300);
            let suffix = if detail.is_empty() { String::new() } else { format!(": {detail}") };
            Err(CommandError::local("pr_draft_failed", format!("The model did not return a draft{suffix}")))
        }
        "pr_create" => {
            let input = pr::CreateInput { title: text("title").to_owned(), body: text("body").to_owned(), base: command.string("base").map(str::to_owned), head: command.string("head").map(str::to_owned), draft: command.is_true("draft") };
            value(&tools, pr::create(&tools, &cwd, &input, 110_000).await)
        }
        "pr_checkout" => {
            let n = checked_number(command, "pr_checkout_failed")?;
            let repo = tools.gh.answer(pr::repo(&tools, &cwd).await).map_err(error)?;
            let primary = tools.gh.answer(async { read::primary_root(tools.git()?, &cwd).await }.await).map_err(error)?;
            let session = session.clone();
            let outcome = repo_lock::run(&primary, scope, move |scope| async move {
                tree::live(&scope)?;
                session.bridge("git.pr_checkout", json!({"number":n,"repo":repo.repo})).await
                    .map_err(|e| Fault::new("pr_checkout_failed", e.to_string()))
            }).await;
            value(&tools, outcome)
        }
        "pr_merge" => {
            let n = checked_number(command, "pr_merge_failed")?;
            let method = match command.string("method") { Some("squash") => pr::MergeMethod::Squash, Some("rebase") => pr::MergeMethod::Rebase, _ => pr::MergeMethod::Merge };
            value(&tools, pr::merge(&tools, &cwd, n, method, command.is_true("deleteBranch"), 110_000).await)
        }
        "pr_review" => {
            let n = checked_number(command, "pr_review_failed")?;
            let event = match command.string("event") { Some("approve") => pr::ReviewEvent::Approve, Some("request_changes") => pr::ReviewEvent::RequestChanges, _ => pr::ReviewEvent::Comment };
            let body = js::trim(text("body"));
            if !matches!(event, pr::ReviewEvent::Approve) && body.is_empty() { return Err(CommandError::local("pr_review_failed", "A comment or change request needs text")); }
            value(&tools, pr::review(&tools, &cwd, n, event, body).await)
        }
        "pr_comment" => {
            let n = checked_number(command, "pr_review_failed")?;
            let body = js::trim(text("body"));
            if body.is_empty() { return Err(CommandError::local("pr_review_failed", "A comment needs text")); }
            value(&tools, pr::comment(&tools, &cwd, n, body).await)
        }
        "pr_comments" => {
            let n = checked_number(command, "pr_not_found")?;
            value(&tools, pr::comments(&tools, &cwd, n).await)
        }
        "pr_edit" => {
            let n = checked_number(command, "pr_edit_failed")?;
            let edit = pr::Edit { title: command.string("title"), body: command.string("body"), base: command.string("base") };
            value(&tools, pr::edit(&tools, &cwd, n, edit).await)
        }
        name => Err(CommandError::Other(format!("Unknown GitHub command: {name}"))),
    }
}

#[cfg(test)]
#[path = "github_command_tests.rs"]
mod tests;
