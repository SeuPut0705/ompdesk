//! Memory care's engine (7d; was `src/main/ai-memory/care.ts`): the schedule (one unit per tick), the state file, the
//! recording client every unit changes pages through, the line Settings › Memory › Maintenance shows and its undo.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde_json::{Map, Value, json};

use super::units::{self, Setup, UnitSpec};
use super::{Ctx, date_parse, iso_of, truthy};
use crate::aimemory::ops::{PageAt, ProjectRef, RetireInput};
use crate::aimemory::value::js_order;
use crate::disk::tree::write_atomic_if;
use crate::json::whole_surrogates;
use crate::server::Fault;
use crate::upkeep::store::{Retired, Store};

/// Changes older than this leave the Maintenance line (they stay in the pages' own history).
const SHOWN_MS: f64 = 7.0 * 24.0 * 60.0 * 60_000.0;
const CHANGES_KEPT: usize = 100;
const KEPT_MAX: usize = 500;
/// A unit that threw tries again after this long, not every tick.
const RETRY_MS: f64 = 60.0 * 60_000.0;

/// `workspace/project/path`: how a page is named in `kept`.
pub fn key_of(at: &PageAt) -> String {
    format!(
        "{}/{}/{}",
        at.project.workspace, at.project.project, at.path
    )
}

/// The client a unit gets: what the units change is recorded with what undo needs (the title and the wiki
/// checkpoint that still holds the page as it was), and the pages the person restored are left alone.
pub struct Recording {
    ctx: Arc<Ctx>,
    kept: HashSet<String>,
    changes: Mutex<Vec<Value>>,
}

impl Recording {
    pub fn new(ctx: Arc<Ctx>, kept: HashSet<String>) -> Recording {
        Recording {
            ctx,
            kept,
            changes: Mutex::new(Vec::new()),
        }
    }

    fn changes(&self) -> MutexGuard<'_, Vec<Value>> {
        self.changes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The changes recorded so far, in order, as `care.json` keeps them.
    pub fn take_changes(&self) -> Vec<Value> {
        std::mem::take(&mut *self.changes())
    }

    /// The head checkpoint and the page's title, read together (a page that cannot be read has its path for a
    /// title).
    async fn before(&self, at: &PageAt) -> Result<(String, String), Fault> {
        let store = &self.ctx.store;
        let (rev, page) = tokio::try_join!(store.head_checkpoint(), async {
            Ok::<_, Fault>(store.page(at).await.ok())
        })?;
        let title = page
            .map(|page| page.title)
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| at.path.clone());
        Ok((rev, title))
    }

    fn record(&self, at: &PageAt, action: &str, rev: String, title: String) {
        let change = json!({
            "workspace": at.project.workspace,
            "project": at.project.project,
            "path": at.path,
            "title": title,
            "action": action,
            "rev": rev,
            "at": self.ctx.clock.iso(),
        });
        self.changes().push(change);
    }

    pub async fn retire_page(&self, at: &PageAt, input: &RetireInput) -> Result<Retired, Fault> {
        if self.kept.contains(&key_of(at)) {
            return Ok(Retired::Pinned);
        }
        let (rev, title) = self.before(at).await?;
        let result = self.ctx.store.retire_page(at, input).await?;
        if result == Retired::Retired {
            self.record(at, "retired", rev, title);
        }
        Ok(result)
    }

    pub async fn feedback(&self, at: &PageAt, signal: &str) -> Result<(), Fault> {
        if signal == "stale" || signal == "wrong" {
            // Refused, not skipped: a unit that logs its change on success then logs nothing for it.
            if self.kept.contains(&key_of(at)) {
                return Err(Fault::new(
                    "memory_kept",
                    "the person put this page back; it stays as it is",
                ));
            }
            let (rev, title) = self.before(at).await?;
            self.ctx.store.feedback(at, signal).await?;
            self.record(at, "flagged", rev, title);
            return Ok(());
        }
        self.ctx.store.feedback(at, signal).await
    }
}

/// How a unit changes pages: through the memory itself (a direct call), or through the recording client of a care
/// tick.
pub enum Writer<'a> {
    Direct(&'a Store),
    Recording(&'a Recording),
}

impl Writer<'_> {
    pub async fn retire_page(&self, at: &PageAt, input: &RetireInput) -> Result<Retired, Fault> {
        match self {
            Writer::Direct(store) => store.retire_page(at, input).await,
            Writer::Recording(recording) => recording.retire_page(at, input).await,
        }
    }

    pub async fn feedback(&self, at: &PageAt, signal: &str) -> Result<(), Fault> {
        match self {
            Writer::Direct(store) => store.feedback(at, signal).await,
            Writer::Recording(recording) => recording.feedback(at, signal).await,
        }
    }
}

/// The state of the care service of one client: whether a tick or an undo is running (one at a time; a tick asked
/// meanwhile does nothing, and an undo waits for a running tick and holds the next one off until it is through, so
/// neither writes `care.json` over the other's changes).
pub struct Service {
    gate: tokio::sync::Mutex<()>,
}

static SERVICES: LazyLock<Mutex<HashMap<String, Arc<Service>>>> = LazyLock::new(Default::default);

fn services() -> MutexGuard<'static, HashMap<String, Arc<Service>>> {
    SERVICES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The service named `name`, made when it is the first request that names it.
pub fn service(name: &str) -> Arc<Service> {
    Arc::clone(services().entry(name.to_owned()).or_insert_with(|| {
        Arc::new(Service {
            gate: tokio::sync::Mutex::new(()),
        })
    }))
}

/// Drops the memory of the service (`care.close`).
pub fn close(name: &str) {
    services().remove(name);
}

/// `care.json`, as the TypeScript read and wrote it: members kept as they came, so what a newer or older build
/// wrote beside them is not lost.
struct State {
    version: String,
    /// Per unit: `{at, done, failed?}`.
    units: Map<String, Value>,
    /// `workspace/project/path` of pages the person restored: never changed by a unit again.
    kept: Vec<String>,
    /// `{workspace, project, path, title, action, rev, at, undone?}`.
    changes: Vec<Value>,
    /// Conclusions the backfill added, with when (for the line): `{at, written}`.
    backfills: Vec<Value>,
    memo: Map<String, Value>,
}

impl State {
    fn empty() -> State {
        State {
            version: String::new(),
            units: Map::new(),
            kept: Vec::new(),
            changes: Vec::new(),
            backfills: Vec::new(),
            memo: Map::new(),
        }
    }

    /// The file, or an empty state when it is missing or no JSON.
    async fn read(file: &str) -> State {
        let file = file.to_owned();
        let bytes = tokio::task::spawn_blocking(move || std::fs::read(file))
            .await
            .ok()
            .and_then(Result::ok);
        let Some(bytes) = bytes else {
            return State::empty();
        };
        let text = String::from_utf8_lossy(&bytes);
        let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(&whole_surrogates(&text))
        else {
            return State::empty();
        };
        let object = |name: &str| match parsed.get(name) {
            Some(Value::Object(members)) => members.clone(),
            _ => Map::new(),
        };
        let array = |name: &str| match parsed.get(name) {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        State {
            version: parsed
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            units: object("units"),
            kept: array("kept")
                .iter()
                .filter_map(|key| key.as_str().map(str::to_owned))
                .collect(),
            changes: array("changes"),
            backfills: array("backfills"),
            memo: object("memo"),
        }
    }

    /// `JSON.stringify(state)` in the key order of the TypeScript's object.
    fn text(&self) -> String {
        json!({
            "version": self.version,
            "units": self.units,
            "kept": self.kept,
            "changes": self.changes,
            "backfills": self.backfills,
            "memo": self.memo,
        })
        .to_string()
    }

    /// Replaces the file in one step (`writeFileAtomic`).
    async fn write(&self, file: &str) -> Result<(), Fault> {
        let (file, text) = (file.to_owned(), self.text());
        tokio::task::spawn_blocking(move || {
            write_atomic_if(Path::new(&file), text.as_bytes(), None, 0o777, &|| true).map(drop)
        })
        .await
        .map_err(|error| Fault::new("internal", error.to_string()))?
    }
}

/// `Date.parse(entry.at)` of a recorded entry: NaN when it is missing or no date.
fn at_of(entry: &Value) -> f64 {
    entry
        .get("at")
        .and_then(Value::as_str)
        .and_then(date_parse)
        .map_or(f64::NAN, |ms| ms as f64)
}

fn text_of<'a>(entry: &'a Value, name: &str) -> &'a str {
    entry.get(name).and_then(Value::as_str).unwrap_or_default()
}

/// What one tick is asked.
pub struct Tick<'a> {
    pub state_file: &'a str,
    /// The running OMPdesk's version: a new one runs every unit again.
    pub version: &'a str,
    /// The units in order, each with how long after it last finished it runs again (none: only after an update).
    pub units: &'a [UnitSpec],
    /// Whether main runs the units (a test's own); else they are the three of `units.rs`.
    pub asked: bool,
    pub setup: &'a Setup,
}

/// Whether `unit` is due: never run, failed an hour ago, not finished, or finished longer ago than its interval.
fn due(state: &State, unit: &UnitSpec, now: f64) -> bool {
    let Some(last) = state.units.get(&unit.name).filter(|last| truthy(last)) else {
        return true;
    };
    if last.get("failed").is_some_and(truthy) {
        return now - at_of(last) >= RETRY_MS;
    }
    if !last.get("done").is_some_and(truthy) {
        return true;
    }
    unit.every_ms
        .is_some_and(|every| now - at_of(last) >= every)
}

/// One unit's step, the first one due; none when none is.
pub async fn tick(
    service: &Service,
    ctx: Arc<Ctx>,
    name: &str,
    config: &Tick<'_>,
) -> Result<Option<String>, Fault> {
    let Ok(_running) = service.gate.try_lock() else {
        return Ok(None);
    };
    let mut state = State::read(config.state_file).await;
    if state.version != config.version {
        config.version.clone_into(&mut state.version);
        state.units = Map::new();
    }
    let now = ctx.clock.now();
    let Some(unit) = config.units.iter().find(|unit| due(&state, unit, now)) else {
        state.write(config.state_file).await?;
        return Ok(None);
    };
    let mut memo = match state.memo.get(&unit.name) {
        Some(Value::Object(memo)) => memo.clone(),
        _ => Map::new(),
    };
    state
        .memo
        .insert(unit.name.clone(), Value::Object(memo.clone()));
    let recording = Arc::new(Recording::new(
        Arc::clone(&ctx),
        state.kept.iter().cloned().collect(),
    ));
    let ran = units::run(
        config.asked,
        &ctx,
        &recording,
        name,
        &unit.name,
        config.setup,
        &mut memo,
    )
    .await;
    state.memo.insert(unit.name.clone(), Value::Object(memo));
    match ran {
        Ok(step) => {
            state.units.insert(
                unit.name.clone(),
                json!({ "at": iso_of(now), "done": step.done }),
            );
            if step
                .written
                .is_some_and(|written| written != 0.0 && !written.is_nan())
            {
                state
                    .backfills
                    .push(json!({ "at": iso_of(now), "written": step.written }));
            }
        }
        Err(fault) if super::is_cancelled(&fault) => return Err(fault),
        Err(fault) => {
            // Tried again after `RETRY_MS`, not every tick; what it finished before failing stays recorded.
            state.units.insert(
                unit.name.clone(),
                json!({ "at": iso_of(now), "done": false, "failed": true }),
            );
            ctx.log(
                "care-failed",
                json!({ "unit": unit.name, "detail": fault.message }),
            );
        }
    }
    state.changes.extend(recording.take_changes());
    if state.changes.len() > CHANGES_KEPT {
        state.changes.drain(..state.changes.len() - CHANGES_KEPT);
    }
    state
        .backfills
        .retain(|entry| now - at_of(entry) < SHOWN_MS);
    state.write(config.state_file).await?;
    Ok(Some(unit.name.clone()))
}

/// The Maintenance line: what the units changed in the last week and not undone. None when nothing.
pub async fn summary(ctx: &Ctx, state_file: &str) -> Option<Value> {
    let state = State::read(state_file).await;
    let now = ctx.clock.now();
    let shown: Vec<&Value> = state
        .changes
        .iter()
        .filter(|change| {
            !change.get("undone").is_some_and(truthy) && now - at_of(change) < SHOWN_MS
        })
        .collect();
    let backfilled = state.backfills.iter().fold(0.0, |sum, entry| {
        sum + entry
            .get("written")
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN)
    });
    if shown.is_empty() && (backfilled == 0.0 || backfilled.is_nan()) {
        return None;
    }
    let mut times: Vec<&str> = shown
        .iter()
        .map(|change| text_of(change, "at"))
        .chain(state.backfills.iter().map(|entry| text_of(entry, "at")))
        .collect();
    times.sort_by(|left, right| js_order(left, right));
    let count = |action: &str| {
        shown
            .iter()
            .filter(|change| text_of(change, "action") == action)
            .count()
    };
    let pages: Vec<Value> = shown
        .iter()
        .map(|change| {
            json!({
                "workspace": text_of(change, "workspace"),
                "project": text_of(change, "project"),
                "path": text_of(change, "path"),
                "title": text_of(change, "title"),
            })
        })
        .collect();
    Some(json!({
        "at": times.last().map_or_else(|| iso_of(now), |at| (*at).to_owned()),
        "retired": count("retired"),
        "flagged": count("flagged"),
        "backfilled": backfilled,
        "pages": pages,
    }))
}

/// Puts back every page shown on the line as it stood before the change (the page's restore from that checkpoint, a
/// new version without the expiry or the flag) and keeps each from the units from now on. Answers how many came back.
/// It waits for a tick that is running, and a tick asked while it runs does nothing.
pub async fn undo(service: &Service, ctx: &Ctx, state_file: &str) -> Result<usize, Fault> {
    let _undoing = service.gate.lock().await;
    let mut state = State::read(state_file).await;
    let now = ctx.clock.now();
    let mut restored = 0;
    for change in &mut state.changes {
        let rev = text_of(change, "rev").to_owned();
        if change.get("undone").is_some_and(truthy)
            || now - at_of(change) >= SHOWN_MS
            || rev.is_empty()
        {
            continue;
        }
        let at = PageAt {
            project: ProjectRef {
                workspace: text_of(change, "workspace").to_owned(),
                project: text_of(change, "project").to_owned(),
            },
            path: text_of(change, "path").to_owned(),
        };
        match ctx.store.restore_page(&at, &rev).await {
            Ok(()) => {}
            Err(fault) if super::is_cancelled(&fault) => return Err(fault),
            Err(fault) => {
                ctx.log(
                    "care-failed",
                    json!({ "unit": "undo", "path": at.path, "detail": fault.message }),
                );
                continue;
            }
        }
        if let Value::Object(members) = change {
            members.insert("undone".to_owned(), Value::Bool(true));
        }
        restored += 1;
        let key = key_of(&at);
        if !state.kept.contains(&key) {
            state.kept.push(key);
        }
        if state.kept.len() > KEPT_MAX {
            state.kept.drain(..state.kept.len() - KEPT_MAX);
        }
        ctx.log(
            "care-undo",
            json!({
                "project": format!("{}/{}", at.project.workspace, at.project.project),
                "path": at.path,
                "action": text_of(change, "action"),
            }),
        );
    }
    state.write(state_file).await?;
    Ok(restored)
}

/// What one step of a unit came to: whether it is through, and the conclusions it added (backfill).
pub struct Step {
    pub done: bool,
    pub written: Option<f64>,
}

/// The runs of the test units that are running, by service and number.
type Runs = Mutex<HashMap<(String, u64), Arc<Recording>>>;

static RUNS: LazyLock<Runs> = LazyLock::new(Default::default);
static NEXT_RUN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// A test unit's run, known by its number while the unit runs: its client calls (`care.unitCall`) find the recording
/// client of the run by it.
pub struct Run {
    pub number: u64,
    service: String,
}

impl Run {
    pub fn start(service: &str, recording: &Arc<Recording>) -> Run {
        let number = NEXT_RUN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        RUNS.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert((service.to_owned(), number), Arc::clone(recording));
        Run {
            number,
            service: service.to_owned(),
        }
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        RUNS.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&(self.service.clone(), self.number));
    }
}

/// The recording client of a unit's run, while it runs.
pub fn run_of(service: &str, number: u64) -> Option<Arc<Recording>> {
    RUNS.lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&(service.to_owned(), number))
        .cloned()
}
