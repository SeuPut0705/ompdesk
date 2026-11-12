//! A session's pace as a line says it (`session-pace.ts`: `Pace`, `waste`, `paceShort`, `paceLine`). Main reads the
//! session file (`sessionPace`); only the wording is here. A pace is JSON-safe: a paired host sends it over the link.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

const WASTE_CALL_RATIO: f64 = 1.5;
const WASTE_POLLS: u64 = 5;
const WASTE_MIN_TOOL_CALLS: u64 = 10;
const WASTE_READS: u64 = 10;

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ToolRow {
    #[serde(default)]
    pub seconds: f64,
    #[serde(default)]
    pub calls: u64,
    #[serde(default)]
    pub errors: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RepeatRead {
    pub path: String,
    pub count: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PaceChecks {
    pub runs: u64,
    pub seconds: f64,
}

/// `Pace`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Pace {
    pub wall_s: f64,
    pub tool_s: f64,
    pub model_s: f64,
    pub idle_s: f64,
    pub model_calls: u64,
    pub output_tokens: u64,
    pub tools: BTreeMap<String, ToolRow>,
    pub think_gaps: Vec<f64>,
    pub repeat_read: Option<RepeatRead>,
    pub polls: u64,
    /// In the order the host listed them (`Object.entries`).
    pub poll_kinds: Option<serde_json::Map<String, Value>>,
    pub checks: Option<PaceChecks>,
}

impl Pace {
    /// What main answered `sessionPace` with; None when it is no pace.
    pub fn from_value(value: Value) -> Option<Pace> {
        if value.is_null() {
            return None;
        }
        serde_json::from_value(value).ok()
    }
}

/// `x.toFixed(1)`: a tie that is exactly representable (.25, .75) rounds up, as JavaScript does.
fn fixed1(x: f64) -> String {
    if (x * 4.0).fract() == 0.0 && (x * 2.0).fract() != 0.0 {
        let up = if x >= 0.0 {
            (x * 10.0).floor() + 1.0
        } else {
            (x * 10.0).ceil() - 1.0
        };
        return format!("{:.1}", up / 10.0);
    }
    format!("{x:.1}")
}

/// `Math.round`: halves go up.
fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn percentile(values: &[f64], p: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    sorted[((sorted.len() as f64 * p).floor() as usize).min(sorted.len() - 1)]
}

fn span(s: f64) -> String {
    if s < 90.0 {
        format!("{} s", super::js::number(round(s)))
    } else {
        format!("{} min", super::js::number(round(s / 60.0)))
    }
}

fn tool_calls(pace: &Pace) -> u64 {
    pace.tools.values().map(|row| row.calls).sum()
}

fn tool_errors(pace: &Pace) -> u64 {
    pace.tools.values().map(|row| row.errors).sum()
}

/// `waste`: what the brief that opened this session can cut next time.
pub fn waste(pace: &Pace) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(read) = &pace.repeat_read
        && read.count >= WASTE_READS
    {
        parts.push(format!("read {} ×{}", read.path, read.count));
    }
    let calls = tool_calls(pace);
    if calls >= WASTE_MIN_TOOL_CALLS && pace.model_calls as f64 / calls as f64 >= WASTE_CALL_RATIO {
        parts.push(format!(
            "{} model calls per tool call",
            fixed1(pace.model_calls as f64 / calls as f64)
        ));
    }
    if pace.polls >= WASTE_POLLS {
        let mut kinds: Vec<(&String, u64)> = pace
            .poll_kinds
            .iter()
            .flatten()
            .map(|(kind, count)| (kind, count.as_u64().unwrap_or(0)))
            .collect();
        // A stable sort, as `Array.prototype.sort` is.
        kinds.sort_by_key(|entry| std::cmp::Reverse(entry.1));
        let kinds: Vec<String> = kinds
            .iter()
            .map(|(kind, count)| format!("{kind} ×{count}"))
            .collect();
        parts.push(format!(
            "polled ×{}{}",
            pace.polls,
            if kinds.is_empty() {
                String::new()
            } else {
                format!(" ({})", kinds.join(", "))
            }
        ));
    }
    (!parts.is_empty()).then(|| parts.join(", "))
}

fn checks_part(pace: &Pace) -> Option<String> {
    let checks = pace.checks.as_ref()?;
    let share = if pace.tool_s > 0.0 {
        round(checks.seconds / pace.tool_s * 100.0)
    } else {
        0.0
    };
    Some(format!(
        "checks ×{} {} ({}% of tools)",
        checks.runs,
        span(checks.seconds),
        super::js::number(share)
    ))
}

/// `paceLine`: the one line a done report ends with.
pub fn pace_line(pace: &Pace) -> String {
    let mut parts = vec![
        format!("wall {}", span(pace.wall_s)),
        format!(
            "model+between-calls {} ({} calls, median {} s)",
            span(pace.model_s),
            pace.model_calls,
            fixed1(percentile(&pace.think_gaps, 0.5))
        ),
        format!("tools {}", span(pace.tool_s)),
    ];
    if let Some(checks) = checks_part(pace) {
        parts.push(checks);
    }
    if pace.idle_s > 0.0 {
        parts.push(format!("idle {}", span(pace.idle_s)));
    }
    parts.push(format!("errors {}", tool_errors(pace)));
    if let Some(cut) = waste(pace) {
        parts.push(format!("waste: {cut}"));
    }
    format!("Pace: {}", parts.join(" · "))
}

/// `paceShort`: the short form a session row carries.
pub fn pace_short(pace: &Pace) -> String {
    let checks = checks_part(pace);
    let cut = waste(pace);
    format!(
        "pace {}, {} calls, median {} s{}{}",
        span(pace.wall_s),
        pace.model_calls,
        fixed1(percentile(&pace.think_gaps, 0.5)),
        checks.map_or_else(String::new, |checks| format!(", {checks}")),
        cut.map_or_else(String::new, |cut| format!(", waste: {cut}"))
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_short_pace_reads_as_the_row_says_it() {
        let pace = Pace::from_value(json!({
            "wallS": 1320.4, "toolS": 120, "modelS": 1200, "idleS": 0, "modelCalls": 156,
            "outputTokens": 1, "tools": {"bash": {"seconds": 1, "calls": 6, "errors": 2}},
            "thinkGaps": [4.0, 4.25, 3.0], "polls": 0,
            "checks": {"runs": 3, "seconds": 61}
        }))
        .unwrap();
        assert_eq!(
            pace_short(&pace),
            "pace 22 min, 156 calls, median 4.0 s, checks ×3 61 s (51% of tools)"
        );
        assert!(pace_line(&pace).starts_with(
            "Pace: wall 22 min · model+between-calls 20 min (156 calls, median 4.0 s)"
        ));
    }

    #[test]
    fn a_median_tie_rounds_up_as_to_fixed_does() {
        assert_eq!(fixed1(0.25), "0.3");
        assert_eq!(fixed1(2.75), "2.8");
        assert_eq!(fixed1(4.0), "4.0");
    }

    #[test]
    fn waste_names_polls_most_frequent_first() {
        let pace = Pace::from_value(json!({
            "wallS": 10, "modelCalls": 1, "tools": {}, "thinkGaps": [], "polls": 6,
            "pollKinds": {"sleep": 2, "proc": 4}
        }))
        .unwrap();
        assert_eq!(
            waste(&pace).as_deref(),
            Some("polled ×6 (proc ×4, sleep ×2)")
        );
    }
}
