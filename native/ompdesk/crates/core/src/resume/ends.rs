//! When a tab's held work ends: its connection wait, its reachability probe, its scheduled retry, and a continuation
//! on its way (was `src/main/turn-resume-ends.ts`). One table: each row is something that ends a hold, each column a
//! place the resume looks at a hold. The table's names and its rows' places are the data `hold-ends.json`, which the
//! TypeScript test reads against `formal/turn-resume/tla/TurnResume.tla` (row `x` is the model's `End_x`, check `y`
//! its `Ends_y`); the rule each row applies is the match in `applies`.

use std::sync::LazyLock;

use serde_json::Value;

use super::facts::{Fact, RunOutcome};

/// What a hold was taken for.
#[derive(Clone, Debug, Default)]
pub struct HeldFor {
    /// The tab's session file then; none for a first turn stock has not written yet.
    pub session_file: Option<String>,
    /// The tab's moves then (`Fact::touched`).
    pub touched: i64,
    /// The person's prompts when a continuation started (`continuing` only).
    pub prompted: Option<i64>,
    /// The failed run the hold is for (a probe, a scheduled retry).
    pub outcome: Option<RunOutcome>,
    /// The hold is a scheduled retry's wait for a provider's limit.
    pub limit: bool,
}

pub struct Context {
    /// A quit is underway.
    pub frozen: bool,
    /// The run on the tab is the hold's own: stock's retry saga a wait took over, or the scheduled retry's own run.
    pub own_run: bool,
}

/// The tab went to another session or branch since `since`: `touched` moved, or the session file recorded then is no
/// longer the tab's. A file written later (a first turn stock had not saved yet) is the same conversation.
pub fn moved_since(fact: &Fact, since: &HeldFor) -> bool {
    if fact.touched() != since.touched {
        return true;
    }
    since.session_file.is_some() && fact.session_file != since.session_file
}

/// The tab runs a run of the person's: not the failed run still ending (its outcome is set; background work can keep
/// it running), not stock's retry saga, and not `own_run` (the hold's own run).
pub fn persons_run(fact: &Fact, own_run: bool) -> bool {
    fact.running && fact.last_run.is_none() && fact.retry.is_none() && !own_run
}

fn applies(end: &str, fact: Option<&Fact>, since: &HeldFor, context: &Context) -> bool {
    match end {
        "gone" => fact.is_none(),
        "frozen" => context.frozen,
        "personsRun" => fact.is_some_and(|fact| persons_run(fact, context.own_run)),
        "stopped" => fact.is_some_and(|fact| fact.stopped),
        "moved" => fact.is_some_and(|fact| moved_since(fact, since)),
        "personsPrompt" => {
            fact.and_then(|fact| fact.prompted).unwrap_or(0) != since.prompted.unwrap_or(0)
        }
        "fileWritten" => {
            since.session_file.is_none() && fact.is_some_and(|fact| fact.session_file.is_some())
        }
        "otherOutcome" => {
            fact.and_then(|fact| fact.last_run.as_ref())
                .map(|run| run.id)
                != since.outcome.as_ref().map(|run| run.id)
        }
        "notRetryable" => fact.is_some_and(|fact| {
            (fact.peer.is_some() && !since.limit)
                || fact.device.is_some()
                || fact.session_file.is_none()
                || fact.awaiting_connection
        }),
        "busy" => fact.is_some_and(|fact| fact.running),
        _ => false,
    }
}

struct Row {
    end: String,
    checks: Vec<String>,
}

static TABLE: LazyLock<Vec<Row>> = LazyLock::new(|| {
    let table: Value = serde_json::from_str(include_str!("hold-ends.json")).unwrap_or(Value::Null);
    table["ends"]
        .as_object()
        .map(|ends| {
            ends.iter()
                .map(|(end, row)| Row {
                    end: end.clone(),
                    checks: row["checks"]
                        .as_array()
                        .map(|checks| {
                            checks
                                .iter()
                                .filter_map(|c| c.as_str().map(str::to_owned))
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default()
});

/// What ends a hold `check` looks at, or `None` while it holds: the first row of the table, in its order, that is
/// listed for `check` and applies.
pub fn hold_end(
    check: &str,
    since: &HeldFor,
    fact: Option<&Fact>,
    context: &Context,
) -> Option<&'static str> {
    TABLE
        .iter()
        .find(|row| {
            row.checks.iter().any(|c| c == check) && applies(&row.end, fact, since, context)
        })
        .and_then(|row| ROWS.iter().copied().find(|name| *name == row.end))
}

/// Every row the code applies; a row of the table the match does not know would never end a hold.
const ROWS: [&str; 10] = [
    "gone",
    "frozen",
    "personsRun",
    "stopped",
    "moved",
    "personsPrompt",
    "fileWritten",
    "otherOutcome",
    "notRetryable",
    "busy",
];

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn fact(patch: Value) -> Fact {
        let mut base = json!({
            "tabId": "t1", "winId": 1, "cwd": "/work", "kind": "agent", "sessionFile": "/s/a.jsonl",
            "running": false, "stopped": false, "awaitingUi": false, "awaitingConnection": false
        });
        for (key, value) in patch.as_object().expect("object") {
            base[key] = value.clone();
        }
        serde_json::from_value(base).expect("fact")
    }

    fn outcome(id: u64) -> RunOutcome {
        RunOutcome {
            id,
            stop_reason: "error".into(),
            error_message: None,
        }
    }

    fn idle() -> Context {
        Context {
            frozen: false,
            own_run: false,
        }
    }

    #[test]
    fn the_table_names_exactly_the_rows_the_rule_knows() {
        let names: Vec<&str> = TABLE.iter().map(|row| row.end.as_str()).collect();
        assert_eq!(names, ROWS);
        for row in TABLE.iter() {
            assert!(!row.checks.is_empty(), "{}", row.end);
        }
    }

    #[test]
    fn each_row_ends_a_hold_at_its_checks_and_only_there() {
        let since = HeldFor {
            session_file: Some("/s/a.jsonl".into()),
            touched: 0,
            prompted: Some(0),
            outcome: Some(outcome(1)),
            limit: false,
        };
        let held = fact(json!({"lastRun": {"id": 1, "stopReason": "error"}}));
        let reach = |check: &str, fact: Option<&Fact>, context: &Context| {
            hold_end(check, &since, fact, context)
        };
        assert_eq!(reach("armed", Some(&held), &idle()), None);
        assert_eq!(reach("armed", None, &idle()), Some("gone"));
        assert_eq!(reach("wait", None, &idle()), None);
        let frozen = Context {
            frozen: true,
            own_run: false,
        };
        assert_eq!(reach("firing", Some(&held), &frozen), Some("frozen"));
        assert_eq!(reach("wait", Some(&held), &frozen), None);
        let stopped = fact(json!({"stopped": true, "lastRun": {"id": 1, "stopReason": "error"}}));
        assert_eq!(reach("probe", Some(&stopped), &idle()), Some("stopped"));
        assert_eq!(reach("wait", Some(&stopped), &idle()), None);
        let moved = fact(json!({"touched": 1, "lastRun": {"id": 1, "stopReason": "error"}}));
        assert_eq!(reach("wait", Some(&moved), &idle()), Some("moved"));
        assert_eq!(reach("continuing", Some(&moved), &idle()), Some("moved"));
        let other =
            fact(json!({"sessionFile": "/s/b.jsonl", "lastRun": {"id": 1, "stopReason": "error"}}));
        assert_eq!(reach("armed", Some(&other), &idle()), Some("moved"));
        let prompted = fact(json!({"prompted": 1}));
        assert_eq!(
            reach("continuing", Some(&prompted), &idle()),
            Some("personsPrompt")
        );
        let running = fact(json!({"running": true, "lastRun": {"id": 1, "stopReason": "error"}}));
        assert_eq!(reach("firing", Some(&running), &idle()), Some("busy"));
        assert_eq!(reach("armed", Some(&running), &idle()), None);
        let persons = fact(json!({"running": true}));
        assert_eq!(reach("wait", Some(&persons), &idle()), Some("personsRun"));
        let own = Context {
            frozen: false,
            own_run: true,
        };
        assert_eq!(reach("wait", Some(&persons), &own), None);
        let next = fact(json!({"lastRun": {"id": 2, "stopReason": "error"}}));
        assert_eq!(
            reach("probeAnswer", Some(&next), &idle()),
            Some("otherOutcome")
        );
        let peer = fact(json!({"peer": "d", "lastRun": {"id": 1, "stopReason": "error"}}));
        assert_eq!(reach("armed", Some(&peer), &idle()), Some("notRetryable"));
        let limit = HeldFor {
            limit: true,
            ..since.clone()
        };
        assert_eq!(hold_end("armed", &limit, Some(&peer), &idle()), None);
        let waiting =
            fact(json!({"awaitingConnection": true, "lastRun": {"id": 1, "stopReason": "error"}}));
        assert_eq!(
            reach("firing", Some(&waiting), &idle()),
            Some("notRetryable")
        );
    }

    #[test]
    fn a_first_file_written_after_a_probe_went_out_ends_only_the_probe_answer() {
        let since = HeldFor {
            session_file: None,
            touched: 0,
            prompted: None,
            outcome: Some(outcome(1)),
            limit: false,
        };
        let written = fact(json!({"lastRun": {"id": 1, "stopReason": "error"}}));
        assert_eq!(
            hold_end("probeAnswer", &since, Some(&written), &idle()),
            Some("fileWritten")
        );
        assert_eq!(hold_end("wait", &since, Some(&written), &idle()), None);
    }
}
