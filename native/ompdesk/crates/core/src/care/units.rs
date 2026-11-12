//! The units memory care runs (7d; was `src/main/ai-memory/care-units.ts`), each over the module that does the work:
//!
//! - `backfill` (`backfill.rs`): session conclusions for the turns before the server captured them, from omp's own
//!   journals. Runs a budget at a time until it is through, again after an update; never on a schedule (turns since are
//!   captured live).
//! - `curate` (`curate.rs`): durable pages that repeat or contradict each other, judged by Jev, else the cheap model,
//!   else the code rule. Daily.
//! - `fresh` (`freshness.rs`): decisions, gotchas and procedures naming repository files or symbols that are gone.
//!   Daily.
//!
//! A test gives its own units (`units` of the request): each is asked of main (`unit` `{run, name, memo}`), and the
//! client calls it makes while it runs come back as `care.unitCall` for the recording client of that run.

use std::collections::HashSet;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::backfill::{self, Deps};
use super::curate::{self, Options};
use super::engine::{Recording, Run, Step, Writer};
use super::freshness::{self, check_freshness};
use super::judge::{Judge, JudgeConfig};
use super::{Ctx, is_cancelled};
use crate::aimemory::ops::ProjectRef;
use crate::run::Runner;
use crate::server::{Fault, Scope};

const DAY_MS: f64 = 24.0 * 60.0 * 60_000.0;
/// Pairs judged unrelated stay settled until one of the two pages changes (the key holds both versions); this many
/// are remembered.
const UNRELATED_KEPT: usize = 2000;

/// A unit of the schedule: its name and how long after it last finished it runs again (none: only after an update).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitSpec {
    pub name: String,
    #[serde(default)]
    pub every_ms: Option<f64>,
}

/// The three units, in the order they are tried.
pub fn production() -> Vec<UnitSpec> {
    [
        ("backfill", None),
        ("curate", Some(DAY_MS)),
        ("fresh", Some(DAY_MS)),
    ]
    .into_iter()
    .map(|(name, every_ms)| UnitSpec {
        name: name.to_owned(),
        every_ms,
    })
    .collect()
}

/// What the three units need of main: the sessions folder, this computer's device id, how to judge, git's rules and
/// the request's scope (the gits of the check end with it).
pub struct Setup {
    pub sessions_dir: String,
    pub origin: String,
    pub judge: Option<JudgeConfig>,
    pub git: Option<Runner>,
    pub scope: Scope,
}

/// `value` as the list of strings it holds (anything else is none).
fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

/// One bounded step of the unit `unit`. `memo` is the unit's own record, kept in `care.json` across ticks and launches
/// whatever the step ended in.
pub async fn run(
    asked: bool,
    ctx: &Arc<Ctx>,
    recording: &Arc<Recording>,
    service: &str,
    unit: &str,
    setup: &Setup,
    memo: &mut Map<String, Value>,
) -> Result<Step, Fault> {
    if asked {
        return run_asked(ctx, recording, service, unit, memo).await;
    }
    match unit {
        "backfill" => {
            let deps = Deps {
                sessions_dir: &setup.sessions_dir,
                origin: &setup.origin,
                max_journals: None,
                max_rows: None,
            };
            let report = backfill::backfill_conclusions(ctx, &deps, memo).await?;
            Ok(Step {
                done: report.remaining == 0 && !report.failed,
                written: Some(report.written as f64),
            })
        }
        "curate" => {
            let writer = Writer::Recording(recording);
            let judge = Judge::choose(&ctx.asker, ctx.asked("judge"), setup.judge.as_ref());
            let before = strings(memo.get("unrelated"));
            let report = curate::curate_memory(
                ctx,
                &writer,
                judge.as_ref(),
                &Options {
                    dry_run: false,
                    max_pairs: None,
                    skip: before.iter().cloned().collect(),
                    project_rules: true,
                },
            )
            .await?;
            let mut seen = HashSet::new();
            let mut all: Vec<String> = before
                .into_iter()
                .chain(report.unrelated)
                .filter(|key| seen.insert(key.clone()))
                .collect();
            if all.len() > UNRELATED_KEPT {
                all.drain(..all.len() - UNRELATED_KEPT);
            }
            memo.insert("unrelated".to_owned(), json!(all));
            Ok(Step {
                done: true,
                written: None,
            })
        }
        "fresh" => {
            let writer = Writer::Recording(recording);
            let mut flagged = match memo.get("flagged") {
                Some(Value::Object(flagged)) => flagged.clone(),
                _ => Map::new(),
            };
            memo.insert("flagged".to_owned(), Value::Object(flagged.clone()));
            let checked = check_each_project(ctx, &writer, setup, &mut flagged).await;
            memo.insert("flagged".to_owned(), Value::Object(flagged));
            checked?;
            Ok(Step {
                done: true,
                written: None,
            })
        }
        other => Err(Fault::new("memory_care", format!("no unit named {other}"))),
    }
}

/// Every project's freshness, one project the server cannot read never keeping the others from being checked.
async fn check_each_project(
    ctx: &Ctx,
    writer: &Writer<'_>,
    setup: &Setup,
    flagged: &mut Map<String, Value>,
) -> Result<(), Fault> {
    for project in ctx.store.projects().await? {
        let at = ProjectRef {
            workspace: project.workspace,
            project: project.project,
        };
        let checked = check_freshness(
            ctx,
            writer,
            &at,
            setup.git.as_ref(),
            &setup.scope,
            flagged,
            &freshness::Options::default(),
        )
        .await;
        match checked {
            Ok(_) => {}
            Err(fault) if is_cancelled(&fault) => return Err(fault),
            Err(fault) => ctx.log(
                "care-skipped",
                json!({
                    "unit": "fresh",
                    "project": format!("{}/{}", at.workspace, at.project),
                    "detail": fault.message,
                }),
            ),
        }
    }
    Ok(())
}

/// A test's own unit, run by main: it may change pages through the recording client of this run (`care.unitCall`).
/// What it did to its memo comes back with its answer; a unit that threw leaves the memo as it was.
async fn run_asked(
    ctx: &Arc<Ctx>,
    recording: &Arc<Recording>,
    service: &str,
    unit: &str,
    memo: &mut Map<String, Value>,
) -> Result<Step, Fault> {
    let run = Run::start(service, recording);
    let answer = ctx
        .asker
        .ask(
            "unit",
            json!({ "run": run.number, "name": unit, "memo": memo }),
        )
        .await?;
    let stepped: Answer = serde_json::from_value(answer).map_err(|error| {
        Fault::new(
            "memory_main",
            format!("unit answered another shape than a step: {error}"),
        )
    })?;
    *memo = stepped.memo;
    Ok(Step {
        done: stepped.done,
        written: stepped.written,
    })
}

/// What a test's unit answers: its step and its memo as the unit left it.
#[derive(Deserialize)]
struct Answer {
    #[serde(default)]
    done: bool,
    #[serde(default)]
    written: Option<f64>,
    #[serde(default)]
    memo: Map<String, Value>,
}
