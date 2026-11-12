//! Memory care (7d, was `src/main/ai-memory/{care,care-units,backfill,curate,memory-judge}.ts` and the caller side of
//! `freshness.ts`): the units that tidy what memory stores, run on a schedule and quietly.
//!
//! One request is one step of the TypeScript client (`care.tick` one unit, `care.summary`, `care.undo`) or one call a
//! test makes directly (`care.backfill`, `care.curate`, `care.freshness`, `care.judgeSmol`, `care.judgeJev`).
//! Every request carries `service` (the client's name for its memory in the core, dropped by `care.close`), `asks`
//! (what main answers: `upkeep/asks.rs`), `server` (where the memory server is, for the requests that ask no
//! `client`), `stockHost` (the stock worker that knows the memory prompt), `locale` (`Intl.Collator`'s, for the one
//! tie `localeCompare` breaks) and, in a test, `now` (ms; the core then reads that value wherever the TypeScript read
//! its clock during the request).

pub mod backfill;
pub mod curate;
pub mod durable;
pub mod engine;
pub mod freshness;
pub mod judge;
pub mod units;

#[cfg(test)]
mod tests;

use std::future::Future;
use std::pin::Pin;
use std::task::Poll;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::aimemory::client::Server;
use crate::aimemory::value::iso;
use crate::server::{Events, Fault, Registry};
use crate::upkeep::asks::Asker;
use crate::upkeep::facts::Facts;
use crate::upkeep::store::Store;

/// What every `care.*` request carries, read from the same params as the method's own fields (a second parse, never
/// `#[serde(flatten)]`: the workspace build unifies the CLI's `arbitrary_precision`, under which a flattened number
/// reads as a map and fails).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Common {
    pub service: String,
    /// The kinds main answers (`client`, `facts`, `journal`, `model`, `rules`, `judge`, `unit`; production asks only
    /// `omp`).
    #[serde(default)]
    pub asks: Vec<String>,
    #[serde(default)]
    pub server: Server,
    #[serde(default)]
    pub stock_host: String,
    #[serde(default)]
    pub locale: String,
    /// A test's clock, ms since the epoch.
    #[serde(default)]
    pub now: Option<f64>,
}

/// The clock of one request: a test's fixed `now`, else the system's.
#[derive(Clone, Copy, Debug)]
pub struct Clock(Option<f64>);

impl Clock {
    pub fn new(fixed: Option<f64>) -> Clock {
        Clock(fixed)
    }

    /// `Date.now()`.
    pub fn now(self) -> f64 {
        self.0.unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0.0, |since| since.as_millis() as f64)
        })
    }

    /// `new Date(Date.now()).toISOString()`.
    pub fn iso(self) -> String {
        iso_of(self.now())
    }
}

/// `new Date(ms).toISOString()` (a fraction of a millisecond is dropped, as the Date does).
pub fn iso_of(ms: f64) -> String {
    iso(ms.max(0.0) as u64)
}

/// `Math.round`: the nearest integer, a tie to the greater one.
pub fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// What a request works with: where main is (`asker`), the memory (`store`), the memory prompt and journals
/// (`facts`), the clock and the collation's locale.
pub struct Ctx {
    pub asker: Asker,
    pub store: Store,
    pub facts: Facts,
    pub clock: Clock,
    pub locale: String,
    pub asks: Vec<String>,
}

impl Ctx {
    pub fn new(common: Common, events: &Events) -> Ctx {
        let asker = Asker::new(common.service, events.clone());
        let store = Store::choose(&asker, &common.asks, common.server);
        let facts = Facts::choose(&asker, &common.asks, &common.stock_host);
        Ctx {
            asker,
            store,
            facts,
            clock: Clock::new(common.now),
            locale: common.locale,
            asks: common.asks,
        }
    }

    /// Whether main answers the ask `kind` (a test's own function stands in for the core's).
    pub fn asked(&self, kind: &str) -> bool {
        self.asks.iter().any(|ask| ask == kind)
    }

    /// One runtime-log line, `details` the strings, numbers, booleans and nulls of the TypeScript's.
    pub fn log(&self, message: &str, details: Value) {
        self.asker.log(message, details);
    }
}

/// Whether a fault is the request's own cancellation: it ends the request where any other failure is the answer of
/// the step it came from.
pub fn is_cancelled(fault: &Fault) -> bool {
    fault.code == "cancelled"
}

/// `{"a": 1}` as the members of an object, else none.
pub fn members(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// JavaScript's truthiness of a JSON value.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Runs every future at once and answers their outputs in order (`Promise.all` of futures that never fail).
pub async fn join_all<F: Future>(futures: Vec<F>) -> Vec<F::Output> {
    let mut futures: Vec<Pin<Box<F>>> = futures.into_iter().map(Box::pin).collect();
    let mut outputs: Vec<Option<F::Output>> = futures.iter().map(|_| None).collect();
    std::future::poll_fn(|context| {
        let mut pending = false;
        for (future, output) in futures.iter_mut().zip(outputs.iter_mut()) {
            if output.is_none() {
                match future.as_mut().poll(context) {
                    Poll::Ready(value) => *output = Some(value),
                    Poll::Pending => pending = true,
                }
            }
        }
        if pending {
            Poll::Pending
        } else {
            Poll::Ready(())
        }
    })
    .await;
    outputs.into_iter().flatten().collect()
}

/// `Date.parse(text)` for the ECMAScript date-time format (`YYYY[-MM[-DD]][THH:mm[:ss[.s…]]][Z|±HH:mm]`, a year of six
/// digits with its sign), which is what ai-memory and `toISOString` write. A day up to 31 is taken in any month, as V8
/// takes it. A date-time with no offset reads as UTC (JavaScript reads it as local time), and any other spelling is
/// none (V8 guessed at some).
pub fn date_parse(text: &str) -> Option<i64> {
    fn digits(bytes: &[u8], count: usize) -> Option<(i64, &[u8])> {
        let (head, rest) = bytes.split_at_checked(count)?;
        let mut value = 0;
        for byte in head {
            if !byte.is_ascii_digit() {
                return None;
            }
            value = value * 10 + i64::from(byte - b'0');
        }
        Some((value, rest))
    }
    /// Days since 1970-01-01 of a civil date (month 1-12, any day count from the month's first).
    fn days(year: i64, month: i64, day: i64) -> i64 {
        let year = if month <= 2 { year - 1 } else { year };
        let era = year.div_euclid(400);
        let year_of_era = year.rem_euclid(400);
        let shifted = (month + 9) % 12;
        let day_of_year = (153 * shifted + 2) / 5;
        let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
        era * 146_097 + day_of_era - 719_468 + day - 1
    }
    let bytes = text.as_bytes();
    let (year, rest) = match bytes.first()? {
        sign @ (b'+' | b'-') => {
            let (year, rest) = digits(&bytes[1..], 6)?;
            if *sign == b'-' && year == 0 {
                return None;
            }
            (if *sign == b'-' { -year } else { year }, rest)
        }
        _ => digits(bytes, 4)?,
    };
    let (mut month, mut day) = (1, 1);
    let mut rest = rest;
    if let Some(after) = rest.strip_prefix(b"-") {
        (month, rest) = digits(after, 2)?;
        if let Some(after) = rest.strip_prefix(b"-") {
            (day, rest) = digits(after, 2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let date = days(year, month, day) * 86_400_000;
    let clip = |ms: i64| (ms.abs() <= 8_640_000_000_000_000).then_some(ms);
    let Some(after) = rest.strip_prefix(b"T").or_else(|| rest.strip_prefix(b"t")) else {
        return if rest.is_empty() { clip(date) } else { None };
    };
    let (hour, after) = digits(after, 2)?;
    let (minute, mut rest) = digits(after.strip_prefix(b":")?, 2)?;
    let (mut second, mut milli) = (0, 0);
    if let Some(after) = rest.strip_prefix(b":") {
        (second, rest) = digits(after, 2)?;
        if let Some(after) = rest.strip_prefix(b".") {
            let count = after
                .iter()
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            if count == 0 {
                return None;
            }
            let (fraction, _) = digits(after, count.min(3))?;
            milli = fraction * 10_i64.pow(3 - count.min(3) as u32);
            rest = &after[count..];
        }
    }
    let whole_day = hour == 24 && minute == 0 && second == 0 && milli == 0;
    if !(hour < 24 || whole_day) || minute > 59 || second > 59 {
        return None;
    }
    let local = date + ((hour * 60 + minute) * 60 + second) * 1000 + milli;
    let offset = match rest {
        b"" | b"Z" | b"z" => 0,
        [sign @ (b'+' | b'-'), offset @ ..] => {
            let (hours, after) = digits(offset, 2)?;
            let (minutes, after) = digits(after.strip_prefix(b":").unwrap_or(after), 2)?;
            if !after.is_empty() || hours > 23 || minutes > 59 {
                return None;
            }
            let ahead = (hours * 60 + minutes) * 60_000;
            if *sign == b'+' { -ahead } else { ahead }
        }
        _ => return None,
    };
    clip(local + offset)
}

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;

use crate::aimemory::ops::{PageAt, ProjectRef, RetireInput};
use crate::run::Runner;
use crate::server::{Call, Reply};
use crate::upkeep::model::Model;
use backfill::Deps;
use curate::Options;
use engine::{Tick, Writer};
use judge::{Judge, JudgeConfig, PagePair, jev, launch_of, smol_judge};
use units::{Setup, UnitSpec};

/// Runs `work` until it ends or the request is cancelled.
async fn until_cancelled<T>(
    call: &Call,
    work: impl Future<Output = Result<T, Fault>>,
) -> Result<T, Fault> {
    tokio::select! {
        result = work => result,
        () = call.scope.on_cancel() => Err(Fault::cancelled()),
    }
}

fn json_reply<T: serde::Serialize>(value: &T) -> Result<Reply, Fault> {
    Reply::json(value)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TickParams {
    state_file: String,
    version: String,
    /// A test's own units; else the three of `units.rs`.
    #[serde(default)]
    units: Option<Vec<UnitSpec>>,
    #[serde(default)]
    sessions_dir: String,
    #[serde(default)]
    origin: String,
    #[serde(default)]
    judge: Option<JudgeConfig>,
    #[serde(default)]
    git: Option<Runner>,
}

/// `care.tick`: one unit's step, the first one due. Answers its name, or null when none is.
async fn tick(call: Call) -> Result<Reply, Fault> {
    let (common, params): (Common, TickParams) = (call.params()?, call.params()?);
    let service = engine::service(&common.service);
    let name = common.service.clone();
    let ctx = Arc::new(Ctx::new(common, &call.events));
    let (asked, units) = match params.units {
        Some(units) => (true, units),
        None => (false, units::production()),
    };
    let setup = Setup {
        sessions_dir: params.sessions_dir,
        origin: params.origin,
        judge: params.judge,
        git: params.git,
        scope: call.scope.clone(),
    };
    let config = Tick {
        state_file: &params.state_file,
        version: &params.version,
        units: &units,
        asked,
        setup: &setup,
    };
    let ran = until_cancelled(&call, engine::tick(&service, ctx, &name, &config)).await?;
    json_reply(&ran)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateParams {
    state_file: String,
}

/// `care.summary`: the Maintenance line, or null.
async fn summary(call: Call) -> Result<Reply, Fault> {
    let (common, params): (Common, StateParams) = (call.params()?, call.params()?);
    let ctx = Ctx::new(common, &call.events);
    let line = until_cancelled(&call, async {
        Ok(engine::summary(&ctx, &params.state_file).await)
    })
    .await?;
    json_reply(&line)
}

/// `care.undo`: puts back every page the line shows. Answers how many came back.
async fn undo(call: Call) -> Result<Reply, Fault> {
    let (common, params): (Common, StateParams) = (call.params()?, call.params()?);
    let service = engine::service(&common.service);
    let ctx = Ctx::new(common, &call.events);
    let restored = until_cancelled(&call, engine::undo(&service, &ctx, &params.state_file)).await?;
    json_reply(&restored)
}

#[derive(Deserialize)]
struct CloseParams {
    service: String,
}

/// `care.close`: forgets the service.
async fn close(call: Call) -> Result<Reply, Fault> {
    let params: CloseParams = call.params()?;
    engine::close(&params.service);
    json_reply(&Value::Null)
}

#[derive(Deserialize)]
struct UnitCallParams {
    service: String,
    run: u64,
    op: String,
    #[serde(default)]
    args: Vec<Value>,
}

/// `care.unitCall`: a call a test's unit makes on the client it was given, run through the recording client of its run.
async fn unit_call(call: Call) -> Result<Reply, Fault> {
    let params: UnitCallParams = call.params()?;
    let recording = engine::run_of(&params.service, params.run)
        .ok_or_else(|| Fault::new("memory_care", "the unit's run is over"))?;
    let arg = |index: usize| params.args.get(index).cloned().unwrap_or(Value::Null);
    let at = || {
        serde_json::from_value::<PageAt>(arg(0))
            .map_err(|error| Fault::new("invalid_params", error.to_string()))
    };
    let answer = until_cancelled(&call, async {
        match params.op.as_str() {
            "retirePage" => {
                let input: RetireInput = serde_json::from_value(arg(0))
                    .map_err(|error| Fault::new("invalid_params", error.to_string()))?;
                Ok(json!(recording.retire_page(&at()?, &input).await?))
            }
            "feedback" => {
                let signal = arg(1);
                let signal = signal
                    .as_str()
                    .ok_or_else(|| Fault::new("invalid_params", "feedback needs a signal"))?;
                recording.feedback(&at()?, signal).await?;
                Ok(Value::Null)
            }
            other => Err(Fault::new(
                "invalid_params",
                format!("the care client has no {other}"),
            )),
        }
    })
    .await?;
    json_reply(&answer)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackfillParams {
    sessions_dir: String,
    origin: String,
    #[serde(default)]
    memo: Map<String, Value>,
    #[serde(default)]
    max_journals: Option<usize>,
    #[serde(default)]
    max_rows: Option<usize>,
}

/// `care.backfill`: one pass. Answers `{report, memo}`, the memo as the pass left it.
async fn backfill(call: Call) -> Result<Reply, Fault> {
    let (common, params): (Common, BackfillParams) = (call.params()?, call.params()?);
    let ctx = Ctx::new(common, &call.events);
    let deps = Deps {
        sessions_dir: &params.sessions_dir,
        origin: &params.origin,
        max_journals: params.max_journals,
        max_rows: params.max_rows,
    };
    let mut memo = params.memo;
    let report = until_cancelled(
        &call,
        backfill::backfill_conclusions(&ctx, &deps, &mut memo),
    )
    .await?;
    json_reply(&json!({ "report": report, "memo": memo }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurateParams {
    #[serde(default)]
    judge: Option<JudgeConfig>,
    #[serde(default)]
    dry_run: bool,
    #[serde(default)]
    max_pairs: Option<usize>,
    #[serde(default)]
    skip: Vec<String>,
    /// Show the judge each project's rules-file outline.
    #[serde(default)]
    project_rules: bool,
}

/// `care.curate`: one curation run, its page changes made on the memory itself. Answers the report.
async fn curate(call: Call) -> Result<Reply, Fault> {
    let (common, params): (Common, CurateParams) = (call.params()?, call.params()?);
    let ctx = Ctx::new(common, &call.events);
    let judge = Judge::choose(&ctx.asker, ctx.asked("judge"), params.judge.as_ref());
    let options = Options {
        dry_run: params.dry_run,
        max_pairs: params.max_pairs,
        skip: params.skip.into_iter().collect(),
        project_rules: params.project_rules,
    };
    let writer = Writer::Direct(&ctx.store);
    let report = until_cancelled(
        &call,
        curate::curate_memory(&ctx, &writer, judge.as_ref(), &options),
    )
    .await?;
    json_reply(&report)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FreshnessParams {
    project: ProjectRef,
    #[serde(default)]
    git: Option<Runner>,
    #[serde(default)]
    flagged: Map<String, Value>,
    #[serde(default)]
    dry_run: bool,
    #[serde(default)]
    max_pages: Option<usize>,
    #[serde(default)]
    max_changes: Option<usize>,
}

/// `care.freshness`: one project's check, its page changes made on the memory itself. Answers `{report, flagged}`,
/// `flagged` as the check left it.
async fn freshness(call: Call) -> Result<Reply, Fault> {
    let (common, params): (Common, FreshnessParams) = (call.params()?, call.params()?);
    let ctx = Ctx::new(common, &call.events);
    let options = freshness::Options {
        dry_run: params.dry_run,
        max_pages: params.max_pages,
        max_changes: params.max_changes,
    };
    let writer = Writer::Direct(&ctx.store);
    let mut flagged = params.flagged;
    let report = until_cancelled(
        &call,
        freshness::check_freshness(
            &ctx,
            &writer,
            &params.project,
            params.git.as_ref(),
            &call.scope,
            &mut flagged,
            &options,
        ),
    )
    .await?;
    json_reply(&json!({ "report": report, "flagged": flagged }))
}

#[derive(Deserialize)]
struct SmolParams {
    pairs: Vec<PagePair>,
    #[serde(default)]
    rules: String,
    /// The empty folder omp runs in (production's model call).
    #[serde(default)]
    cwd: String,
}

/// `care.judgeSmol`: one batched call on the cheap model. Answers a judgment or null.
async fn judge_smol(call: Call) -> Result<Reply, Fault> {
    let (common, params): (Common, SmolParams) = (call.params()?, call.params()?);
    let ctx = Ctx::new(common, &call.events);
    let model = Model::choose(&ctx.asker, &ctx.asks, PathBuf::from(&params.cwd));
    let judgment = until_cancelled(&call, async {
        Ok(
            smol_judge(&params.pairs, &params.rules, |message| async move {
                model.call(&message).await
            })
            .await,
        )
    })
    .await?;
    json_reply(&judgment)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JevParams {
    pairs: Vec<PagePair>,
    enabled: bool,
    host_file: String,
    cwd: String,
}

/// `care.judgeJev`: Jev through stock's judge chain, on the omp main names (ask `omp`). Answers a judgment or null.
async fn judge_jev(call: Call) -> Result<Reply, Fault> {
    let (common, params): (Common, JevParams) = (call.params()?, call.params()?);
    let ctx = Ctx::new(common, &call.events);
    let config = JudgeConfig {
        enabled: params.enabled,
        host_file: params.host_file,
        cwd: params.cwd,
    };
    let judgment = until_cancelled(&call, async {
        if !config.enabled || params.pairs.is_empty() {
            return Ok(None);
        }
        let Some(launch) = launch_of(&ctx.asker).await? else {
            return Ok(None);
        };
        jev(&launch, &config, &params.pairs).await
    })
    .await?;
    json_reply(&judgment)
}

pub fn register(registry: &mut Registry) {
    registry.add("care.tick", |call| Box::pin(tick(call)));
    registry.add("care.summary", |call| Box::pin(summary(call)));
    registry.add("care.undo", |call| Box::pin(undo(call)));
    registry.add("care.close", |call| Box::pin(close(call)));
    registry.add("care.unitCall", |call| Box::pin(unit_call(call)));
    registry.add("care.backfill", |call| Box::pin(backfill(call)));
    registry.add("care.curate", |call| Box::pin(curate(call)));
    registry.add("care.freshness", |call| Box::pin(freshness(call)));
    registry.add("care.judgeSmol", |call| Box::pin(judge_smol(call)));
    registry.add("care.judgeJev", |call| Box::pin(judge_jev(call)));
}
