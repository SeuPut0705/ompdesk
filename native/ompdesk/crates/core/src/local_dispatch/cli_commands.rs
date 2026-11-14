use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::application::omp_cli::{Command, LaunchMode, Output, Service};
use crate::pool::application::Sidecar;
use crate::server::{Fault, Scope};

use super::protocol::{CommandError, CommandResult, RpcCommand};
use super::session::Session;

use std::sync::LazyLock;

use regress::Regex;
use serde_json::{Value, json};

// These are GUI projections of stock CLI output (local/misc.ts, agent-worktrees.ts), not copies of stock's
// doctor, update or worktree decisions. Actual execution is the one native application::omp_cli service.
static CURRENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Current version:\s*(\d+\.\d+\.\d+\S*)").expect("update report regex"));
static LATEST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"New version available:\s*(\d+\.\d+\.\d+\S*)").expect("update report regex"));

pub const COMMANDS: &[&str] = &[
    "get_omp_update", "get_plugin_doctor", "get_agent_worktrees",
    "clear_agent_worktrees", "reload_plugins",
];

fn plain_env() -> BTreeMap<String, String> {
    [("NO_COLOR".into(), "1".into()), ("FORCE_COLOR".into(), "0".into())].into()
}

fn checked_at() -> String {
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    crate::schedules::rules::iso(millis.min(i64::MAX as u128) as i64)
}

fn cli_error(output: &Output, code: &'static str, fallback: &str) -> CommandError {
    let detail = if output.stderr.is_empty() { &output.stdout } else { &output.stderr };
    let detail = crate::agentctl::service::js::trim(detail);
    let tail = detail.rmatch_indices('\n').nth(5).map_or(detail, |(at, _)| &detail[at + 1..]);
    let tail = tail.replace("\r\n", "\n");
    CommandError::local(code, if tail.is_empty() {
        format!("{fallback} exited with code {}", output.code)
    } else { tail })
}

pub async fn handle<S: Sidecar<Error = Fault> + ?Sized + 'static>(
    command: &RpcCommand, session: &Session<S>, omp: &Service, scope: Scope,
) -> CommandResult {
    if command.kind == "reload_plugins" {
        session.slash("reload-plugins", None).await?;
        let listing = omp.run(Command {
            args: ["plugin", "list", "--json"].into_iter().map(str::to_owned).collect(),
            cwd: session.cwd().into(), input: Vec::new(), timeout: Duration::from_secs(30),
            env: BTreeMap::new(), launch: LaunchMode::Runtime,
        }, scope);
        let (commands, skills, plugins) = tokio::join!(
            session.stock(json!({"type":"get_available_commands"})),
            session.bridge_optional("composer.skill_count", None),
            listing,
        );
        let commands = commands?;
        let skills = skills?;
        let plugins = plugins?;
        return Ok(Some(json!({
            "plugins":if plugins.code == 0 { plugin_count(&plugins.stdout) } else { 0 },
            "skills":skills["skills"],
            "commands":commands["commands"].as_array().map_or(0, Vec::len),
        })));
    }
    let (args, seconds, launch) = match command.kind.as_str() {
        "get_omp_update" => (["update", "--check", ""], 60, LaunchMode::Update),
        "get_plugin_doctor" => (["plugin", "doctor", "--json"], 60, LaunchMode::Runtime),
        "get_agent_worktrees" => (["worktree", "list", "--json"], 60, LaunchMode::Runtime),
        "clear_agent_worktrees" => (["worktree", "clear", "--json"], 300, LaunchMode::Runtime),
        _ => return Err(CommandError::Other(format!("Unknown CLI command: {}", command.kind))),
    };
    let output = omp.run(Command {
        args: args.into_iter().filter(|arg| !arg.is_empty()).map(str::to_owned).collect(),
        cwd: session.cwd().into(), input: Vec::new(), timeout: Duration::from_secs(seconds),
        env: plain_env(), launch,
    }, scope).await?;
    let parsed = (output.code == 0).then(|| match command.kind.as_str() {
        "get_omp_update" => parse_update_check(&output.stdout),
        "get_plugin_doctor" => parse_doctor_checks(&output.stdout),
        "get_agent_worktrees" => parse_agent_worktrees(&output.stdout),
        _ => parse_agent_worktree_clear(&output.stdout),
    }).flatten();
    let Some(mut parsed) = parsed else {
        let (code, fallback) = match command.kind.as_str() {
            "get_omp_update" => ("update_check_failed", "omp update --check"),
            "get_plugin_doctor" => ("doctor_failed", "omp plugin doctor"),
            "get_agent_worktrees" => ("worktree_cli_failed", "omp worktree list"),
            _ => ("worktree_cli_failed", "omp worktree clear"),
        };
        return Err(cli_error(&output, code, fallback));
    };
    match command.kind.as_str() {
        "get_omp_update" => {
            parsed["updateAvailable"] = json!(parsed["latestVersion"] != parsed["currentVersion"]);
            parsed["checkedAt"] = json!(checked_at());
            parsed["distribution"] = json!("system");
            parsed["installStrategy"] = json!("omp-update");
        }
        "get_plugin_doctor" => parsed = json!({"checks":parsed,"checkedAt":checked_at()}),
        "get_agent_worktrees" => parsed = json!({"entries":parsed}),
        _ => {}
    }
    Ok(Some(parsed))
}

fn json(text: &str) -> Option<Value> {
    serde_json::from_str(&crate::json::whole_surrogates(text)).ok()
}

pub fn parse_update_check(text: &str) -> Option<Value> {
    let current = CURRENT.find(text).and_then(|matched| matched.group(1)).map(|range| &text[range])?;
    let latest = LATEST.find(text).and_then(|matched| matched.group(1)).map(|range| &text[range])
        .or_else(|| text.contains("Already up to date").then_some(current))?;
    Some(json!({"currentVersion":current,"latestVersion":latest}))
}

pub fn parse_doctor_checks(text: &str) -> Option<Value> {
    let data = json(text)?;
    let rows = data.as_array()?;
    Some(Value::Array(rows.iter().filter_map(|row| {
        let name = row.get("name")?.as_str()?;
        let status = row.get("status")?.as_str().filter(|status| matches!(*status, "ok"|"warning"|"error"))?;
        Some(json!({"name":name,"status":status,"message":row.get("message").and_then(Value::as_str).unwrap_or("")}))
    }).collect()))
}

fn optional_text(out: &mut Value, source: &Value, name: &str) {
    if let Some(value) = source.get(name).and_then(Value::as_str).filter(|value| !value.is_empty()) {
        out[name] = json!(value);
    }
}

pub fn parse_agent_worktrees(text: &str) -> Option<Value> {
    let data = json(text)?;
    Some(Value::Array(data.as_array()?.iter().filter_map(|row| {
        let path = row.get("path")?.as_str()?;
        let kind = row.get("kind")?.as_str().filter(|kind| matches!(*kind,"pr-checkout"|"task-isolation"|"empty"|"stray"))?;
        let mut out = json!({"path":path,"kind":kind});
        for field in ["parentRepo","branch","orphanReason"] { optional_text(&mut out, row, field); }
        Some(out)
    }).collect()))
}

pub fn parse_agent_worktree_clear(text: &str) -> Option<Value> {
    let data = json(text)?;
    let removed = data.get("removed").filter(|removed| removed.is_number())?;
    let rows: Vec<_> = data.get("results").and_then(Value::as_array).into_iter().flatten().filter_map(|row| {
        let path = row.get("path")?.as_str()?;
        let ok = row.get("ok")?.as_bool()?;
        let mut out = json!({"path":path,"ok":ok});
        optional_text(&mut out, row, "error");
        Some(out)
    }).collect();
    Some(json!({"removed":removed,"failed":data.get("failed").filter(|failed|failed.is_number()).cloned().unwrap_or(json!(0)),"results":rows}))
}

pub fn plugin_count(text: &str) -> usize {
    let Some(data) = json(text) else { return 0; };
    match data {
        Value::Object(fields) => fields.values().filter_map(Value::as_array).map(Vec::len).sum(),
        Value::Array(fields) => fields.iter().filter_map(Value::as_array).map(Vec::len).sum(),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_failures_preserve_stderr_precedence_tail_and_command_code() {
        let output = Output {
            code: 9, stdout: "ignored stdout".into(),
            stderr: "old\r\none\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\n".into(),
        };
        assert_eq!(
            cli_error(&output, "doctor_failed", "omp plugin doctor"),
            CommandError::local("doctor_failed", "one\ntwo\nthree\nfour\nfive\nsix"),
        );
        let output = Output { code: 7, stdout: String::new(), stderr: " \t\n".into() };
        assert_eq!(
            cli_error(&output, "worktree_cli_failed", "omp worktree clear"),
            CommandError::local("worktree_cli_failed", "omp worktree clear exited with code 7"),
        );
    }

    #[test]
    fn keeps_stock_update_channel_versions_without_guessing_a_missing_latest() {
        assert_eq!(parse_update_check("Current version: 18.18.9\nNew version available: 19.0.0-next.2\n"), Some(json!({"currentVersion":"18.18.9","latestVersion":"19.0.0-next.2"})));
        assert_eq!(parse_update_check("Current version: 18.18.9\nAlready up to date"), Some(json!({"currentVersion":"18.18.9","latestVersion":"18.18.9"})));
        assert!(parse_update_check("Current version: 18.18.9\nregistry unavailable").is_none());
    }

    #[test]
    fn doctor_and_worktree_views_drop_unknown_rows_without_inventing_success() {
        assert_eq!(parse_doctor_checks(r#"[{"name":"plugin","status":"error","message":"missing"},{"name":"future","status":"unknown"},{"name":"optional","status":"ok","message":3},null]"#), Some(json!([{"name":"plugin","status":"error","message":"missing"},{"name":"optional","status":"ok","message":""}])));
        assert_eq!(parse_agent_worktrees(r#"[{"path":"/fictional/wt","kind":"stray","branch":"","orphanReason":"gone"},{"path":"/fictional/new","kind":"future"}]"#), Some(json!([{"path":"/fictional/wt","kind":"stray","orphanReason":"gone"}])));
        assert_eq!(parse_agent_worktree_clear(r#"{"removed":0,"kept":3}"#), Some(json!({"removed":0,"failed":0,"results":[]})));
        assert!(parse_agent_worktree_clear(r#"{"removed":"0"}"#).is_none());
        assert_eq!(plugin_count(r#"{"bundled":[1,2],"installed":[3],"ignored":8}"#), 3);
        assert_eq!(plugin_count("[[1],[2,3],null]"), 3);
    }
}
