//! Application effects that need no window or tab authority. The page's log formatter remains TypeScript;
//! `captured-log.json` holds its output for these same records so the native PR body stays byte-identical.

use std::collections::HashSet;
use std::fmt::Write;

use serde::Serialize;
use serde_json::Value;

use super::util::{flag, number, text};
use crate::gh::Gh;
use crate::json::utf16_prefix;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct RunStatus {
    pub status: String,
    pub conclusion: Option<String>,
}

/// Installed gh, using the shared native runner and its existing timeout/redaction rules.
pub async fn gh_run(gh: &Gh, cwd: &str, url: &str) -> Option<RunStatus> {
    let output = gh
        .text(cwd, &["run", "view", url, "--json", "status,conclusion"])
        .await
        .ok()?;
    if output.code != 0 {
        return None;
    }
    let parsed: Value = serde_json::from_str(&output.stdout).ok()?;
    Some(RunStatus {
        status: text(&parsed, "status")?.to_owned(),
        conclusion: text(&parsed, "conclusion")
            .filter(|text| !text.is_empty())
            .map(str::to_owned),
    })
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct PrText {
    pub title: String,
    pub body: String,
}

const SECTIONS: [(&str, &str); 10] = [
    ("design", "Design"),
    ("performance", "Performance"),
    ("features", "Features"),
    ("refactoring", "Refactoring"),
    ("tests", "Tests"),
    ("bugs", "Bugs"),
    ("docs", "Docs"),
    ("user", "Your requests"),
    ("release", "Release"),
    ("unreported", "Unreported"),
];

fn plural(count: usize, word: &str) -> String {
    format!("{count} {word}{}", if count == 1 { "" } else { "s" })
}

fn trim(text: &str) -> &str {
    text.trim_matches(crate::fs::order::is_js_space)
}

fn clip_summary(text: &str) -> String {
    let mut flat = String::with_capacity(text.len().min(400));
    let mut space = false;
    let mut units = 0;
    for ch in text.chars() {
        if crate::fs::order::is_js_space(ch) {
            space = !flat.is_empty();
            continue;
        }
        if space {
            flat.push(' ');
            units += 1;
            space = false;
        }
        flat.push(ch);
        units += ch.len_utf16();
        if units > 400 {
            return format!("{}…", utf16_prefix(&flat, 399));
        }
    }
    flat
}

fn values<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// Input records are the bridge's cycle ledger, not summaries supplied by a page.
pub fn pr_text(branch: &str, cycles: &[Value]) -> PrText {
    let title = format!("{branch}: {}", plural(cycles.len(), "cycle"));
    let commits = cycles
        .iter()
        .filter(|cycle| text(cycle, "commit").is_some_and(|sha| !sha.is_empty()))
        .count();
    let red = cycles
        .iter()
        .filter(|cycle| text(cycle, "verify") == Some("red"))
        .count();
    let mut body = format!(
        "# {title}\n\n{} · {} · {red} red\n",
        plural(cycles.len(), "cycle"),
        plural(commits, "commit")
    );
    let mut sorted: Vec<&Value> = cycles.iter().collect();
    sorted.sort_by_key(|cycle| std::cmp::Reverse(number(cycle, "n").unwrap_or(0)));
    for (area, heading) in SECTIONS {
        let mut matching = sorted
            .iter()
            .copied()
            .filter(|cycle| text(cycle, "area") == Some(area))
            .peekable();
        if matching.peek().is_none() {
            continue;
        }
        let _ = write!(body, "\n## {heading}\n");
        for cycle in matching {
            cycle_lines(&mut body, cycle);
        }
    }
    let mut seen = HashSet::new();
    let mut followups = cycles
        .iter()
        .flat_map(|cycle| values(cycle, "followups"))
        .filter_map(Value::as_str)
        .filter(|followup| seen.insert(*followup))
        .peekable();
    if followups.peek().is_some() {
        body.push_str("\n## Open follow-ups\n");
        for followup in followups {
            let _ = writeln!(body, "- {followup}");
        }
    }
    PrText { title, body }
}

fn cycle_lines(body: &mut String, cycle: &Value) {
    let verify = match text(cycle, "verify") {
        Some("unreported") => "no report",
        Some(verify) => verify,
        None => "",
    };
    let title = trim(text(cycle, "title").unwrap_or_default());
    let title = if title.is_empty() {
        "(untitled)"
    } else {
        title
    };
    let _ = write!(
        body,
        "- **#{}** {title} — {verify}",
        number(cycle, "n").unwrap_or(0)
    );
    if let Some(sha) = text(cycle, "commit").filter(|sha| !sha.is_empty()) {
        let _ = write!(body, " · `{}`", utf16_prefix(sha, 7));
    }
    if let Some(change) = cycle.get("change").filter(|change| !change.is_null()) {
        let files = number(change, "files").unwrap_or(0);
        let _ = write!(
            body,
            " · +{} −{} in {files} file{}",
            number(change, "added").unwrap_or(0),
            number(change, "removed").unwrap_or(0),
            if files == 1 { "" } else { "s" }
        );
    }
    if flag(cycle, "reverted") {
        body.push_str(" · reverted");
    }
    body.push('\n');
    if let Some(summary) = text(cycle, "summary").filter(|summary| !trim(summary).is_empty()) {
        let _ = writeln!(body, "  {}", clip_summary(summary));
    }
    if let Some(note) = cycle.get("verifyNote").filter(|note| !note.is_null()) {
        let kind = text(note, "kind").unwrap_or_default();
        let message = match kind {
            "no_check" => "reported green, but no check ran this cycle",
            "check_failed" => "reported green, but the last check failed",
            "edited_after" => "reported green, but files were edited after the last check",
            _ => "undefined",
        };
        let _ = write!(body, "  - Verify: {message}");
        if kind == "check_failed" {
            if let Some(command) = text(note, "command").filter(|command| !command.is_empty()) {
                let _ = write!(body, " (`{command}`)");
            }
        }
        body.push('\n');
    }
    for followup in values(cycle, "followups").iter().filter_map(Value::as_str) {
        let _ = writeln!(body, "  - Follow-up: {followup}");
    }
    for child in values(cycle, "children") {
        let _ = write!(
            body,
            "  - Child `{}`: {}",
            text(child, "branch").unwrap_or_default(),
            text(child, "outcome").unwrap_or_default()
        );
        if let Some(sha) = text(child, "sha").filter(|sha| !sha.is_empty()) {
            let _ = write!(body, " `{}`", utf16_prefix(sha, 7));
        }
        body.push('\n');
    }
    if let Some(ship) = cycle.get("ship").filter(|ship| !ship.is_null()) {
        let _ = write!(
            body,
            "  - Released {}",
            text(ship, "version").unwrap_or_default()
        );
        if let Some(url) = text(ship, "runUrl").filter(|url| !url.is_empty()) {
            let _ = write!(body, " ({url})");
        }
        body.push('\n');
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_pr_text_is_the_same_report_the_page_copies() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("captured-log.json")).unwrap();
        for case in cases {
            let output = pr_text(
                case["branch"].as_str().unwrap(),
                case["cycles"].as_array().unwrap(),
            );
            assert_eq!(output.title, case["title"].as_str().unwrap());
            assert_eq!(output.body, case["body"].as_str().unwrap());
        }
    }

    #[tokio::test]
    async fn a_missing_gh_is_unknown_not_a_failed_release() {
        assert_eq!(
            gh_run(
                &Gh::new(None, crate::server::Scope::detached()),
                ".",
                "https://example.invalid/run"
            )
            .await,
            None
        );
    }
}
