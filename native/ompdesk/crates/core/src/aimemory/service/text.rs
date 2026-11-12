//! What the service reads out of ai-memory's output and files, and the texts it writes: `setup`'s problems and plan,
//! a failed command's last lines, the config's embedding opt-out, the suppression overlay. Pure; each is held to the
//! TypeScript's answers in `captured.json`.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::fs::order::{is_js_space, js_trim};
use crate::json::whole_surrogates;

/// The lines of `text` as `text.split(/\r?\n/)` cut them.
pub fn lines(text: &str) -> impl Iterator<Item = &str> {
    text.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
}

/// Whether `at` starts a line as the `m` flag's `^` reads one: the text's start, or right after a line terminator.
fn line_start(text: &str, at: usize) -> bool {
    at == 0
        || text[..at]
            .chars()
            .next_back()
            .is_some_and(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
}

/// `problem:` lines of `setup`'s summary.
pub fn parse_problems(output: &str) -> Vec<String> {
    lines(output)
        .map(js_trim)
        .filter_map(|line| line.strip_prefix("problem:"))
        .map(|problem| js_trim(problem).to_owned())
        .collect()
}

/// What `setup --plan --json` says: the data folder, its config file and whether it is fresh.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub data_dir: Option<String>,
    pub config_path: Option<String>,
    pub fresh: bool,
}

/// `setup --plan --json`'s document (a log line may precede it): from the first `{` that starts a line to the last `}`.
pub fn parse_plan(output: &str) -> Option<Plan> {
    let start = output
        .match_indices('{')
        .map(|(at, _)| at)
        .find(|at| line_start(output, *at))?;
    let end = output.rfind('}')?;
    if end < start {
        return None;
    }
    let plan: Value = serde_json::from_str(&whole_surrogates(&output[start..=end])).ok()?;
    let text = |name: &str| plan.get(name).and_then(Value::as_str).map(str::to_owned);
    Some(Plan {
        data_dir: text("data_dir"),
        config_path: text("config_path"),
        fresh: plan.get("fresh") == Some(&Value::Bool(true)),
    })
}

/// `text` without its CSI escape sequences (`/\x1b\[[0-9;?]*[ -/]*[@-~]/g`).
fn without_csi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("\u{1b}[") {
        out.push_str(&rest[..at]);
        let after = &rest[at + 2..];
        let params = after
            .find(|c: char| !(c.is_ascii_digit() || c == ';' || c == '?'))
            .unwrap_or(after.len());
        let middle = &after[params..];
        let inter = middle
            .find(|c: char| !(' '..='/').contains(&c))
            .unwrap_or(middle.len());
        match middle[inter..].chars().next() {
            Some(last @ '@'..='~') => rest = &middle[inter + last.len_utf8()..],
            _ => {
                out.push('\u{1b}');
                rest = &rest[at + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// `/\bINFO\b/`: `INFO` with no ASCII word character on either side.
fn has_info(line: &str) -> bool {
    let word = |c: Option<u8>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_');
    let bytes = line.as_bytes();
    line.match_indices("INFO").any(|(at, _)| {
        !word(at.checked_sub(1).map(|before| bytes[before])) && !word(bytes.get(at + 4).copied())
    })
}

/// The last meaningful lines of a command's output, without log prefixes and color codes.
pub fn tail(output: &str, count: usize) -> String {
    let clean = without_csi(output);
    let kept: Vec<&str> = lines(&clean)
        .map(js_trim)
        .filter(|line| !line.is_empty() && !has_info(line))
        .collect();
    kept[kept.len().saturating_sub(count)..].join(" ¶ ")
}

pub const EMBEDDINGS_NOTE: &str = "# OMPdesk: no local embedding model (no download, ~220 MB less memory). Remove this line for hybrid search.";

/// The byte range of the first line that `matches` (a line as the `m` flag's `^` and `$` see it, without its `\n`).
fn first_line(text: &str, matches: impl Fn(&str) -> bool) -> Option<(usize, usize)> {
    let mut at = 0;
    loop {
        if line_start(text, at) {
            let end = text[at..].find('\n').map_or(text.len(), |end| at + end);
            if matches(&text[at..end]) {
                return Some((at, end));
            }
        }
        at += text[at..].chars().next()?.len_utf8();
    }
}

/// `/^[ \t]*embedding_provider[ \t]*=/m`: some line already sets the provider.
fn sets_provider(line: &str) -> bool {
    let rest = line.trim_start_matches([' ', '\t']);
    rest.strip_prefix("embedding_provider")
        .is_some_and(|rest| rest.trim_start_matches([' ', '\t']).starts_with('='))
}

/// `/^#[ \t]+embedding_provider[ \t]*=[ \t]*"none"[^\n]*$/m`: the template's commented opt-out.
fn opt_out(line: &str) -> bool {
    let Some(rest) = line.strip_prefix('#') else {
        return false;
    };
    let spaced = rest.trim_start_matches([' ', '\t']);
    spaced.len() < rest.len()
        && spaced
            .strip_prefix("embedding_provider")
            .and_then(|rest| rest.trim_start_matches([' ', '\t']).strip_prefix('='))
            .is_some_and(|rest| rest.trim_start_matches([' ', '\t']).starts_with("\"none\""))
}

/// `config.toml` with `embedding_provider = "none"` switched on, or none when it has the setting already or no
/// template line. Lines start where JavaScript's `m` flag starts them (after `\r`, U+2028 and U+2029 too).
pub fn without_local_embeddings(toml: &str) -> Option<String> {
    let mut at = 0;
    while at <= toml.len() {
        if line_start(toml, at) && sets_provider(&toml[at..]) {
            return None;
        }
        match toml[at..].chars().next() {
            Some(c) => at += c.len_utf8(),
            None => break,
        }
    }
    let (start, end) = first_line(toml, opt_out)?;
    Some(format!(
        "{}embedding_provider = \"none\"  {EMBEDDINGS_NOTE}{}",
        &toml[..start],
        &toml[end..]
    ))
}

/// `sha256(bytes)` as lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `JSON.stringify(value, null, 2)` and a line end, as the files OMPdesk rewrites end.
pub fn pretty(value: &Value) -> String {
    let mut text = serde_json::to_string_pretty(value).unwrap_or_default();
    text.push('\n');
    text
}

/// The overlay for a spawn: the ids omp would hold disabled (`lists`, lowest precedence first: the agent dir's
/// configs, then the folder's) plus `ids`, without repeats, as the file's text and its name by content.
pub fn overlay(
    lists: &[Option<Vec<String>>],
    agent_configs: usize,
    ids: &[String],
) -> (String, String) {
    // The agent dir's first config that sets the list, then each of the folder's that does replaces it.
    let agent = lists[..agent_configs].iter().flatten().next();
    let project = lists[agent_configs..].iter().flatten().last();
    let mut disabled: Vec<&String> = Vec::new();
    for id in project.or(agent).into_iter().flatten().chain(ids) {
        if !disabled.contains(&id) {
            disabled.push(id);
        }
    }
    let text = pretty(&json!({ "disabledExtensions": disabled }));
    let name = format!("suppress-{}.yml", &sha256_hex(text.as_bytes())[..12]);
    (text, name)
}

/// `/\s+/`'s first field of `text.trim()`.
pub fn first_field(text: &str) -> &str {
    js_trim(text).split(is_js_space).next().unwrap_or_default()
}
