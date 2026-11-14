//! The schedules' state machine (was `ScheduleService` of `src/main/schedules.ts`): which schedule starts when, what
//! a run's record says, what the journal holds. It touches nothing outside itself: every entry takes the moment it
//! happens at, and what has to happen outside (a state to tell and keep, a run to start, a file to write or remove) is
//! left in `outs` for its host (`mod.rs`) or a test to carry out. A step the TypeScript took after an `await` (a
//! run's files, its launch) is an entry of its own here, taken by the host once the step before it returned.
//!
//! Schedules and runs are held as the JSON they were written as, key order included, so a journal reads back what it
//! held and writes it the way `JSON.stringify` did; the rules read the members they name.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use super::rules::{self, Zone};
use crate::control::js::string_of_value;
use crate::server::Fault;

/// Event lines kept for the run after the running one (the newest).
const PENDING_DETAILS_MAX: usize = 20;
/// The exit status of a run its supervisor stopped (`SUPERVISOR_STOPPED_CODE`), which a stopped wake-up answers too.
const STOPPED_CODE: i64 = 130;
const CLOSED_DURING_RUN: &str = "OMPdesk closed during the run";
const DAY_MS: i64 = 24 * 60 * 60_000;

type Object = Map<String, Value>;

/// What main's constants say (`src/shared/schedules.ts`, `AGENT_SCHEDULE_PREFIX`), handed over as the service opens.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub runs_kept: usize,
    pub runs_per_schedule: usize,
    pub once_done_kept: usize,
    pub chain_limit: u64,
    pub agent_prefix: String,
}

/// What a run starts as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    Schedule,
    Manual,
    Event,
}

impl Trigger {
    fn name(self) -> &'static str {
        match self {
            Trigger::Schedule => "schedule",
            Trigger::Manual => "manual",
            Trigger::Event => "event",
        }
    }
}

/// What the engine leaves for its host to do, in order.
#[derive(Debug)]
pub enum Out {
    /// The state changed: tell main, and keep `journal` as the file.
    Changed { state: Value, journal: String },
    /// The service closed: `journal` is the file's last content, written before anything else happens.
    Closed { journal: String },
    /// Ask main whether `device` has a model request left today; answered by `reserved`.
    Reserve { ask: u64, device: String },
    /// The request `charge` reserved was not spent.
    Refund { charge: u64 },
    /// A run's files: the log folder, then its prompt file and a look at its folder (none of both for a wake-up);
    /// answered by `prepared`.
    Prepare {
        run: String,
        prompt: String,
        cwd: Option<String>,
    },
    /// Main starts the run (`schedule` carries the prompt as the run is told it); answered by `started`, then `ended`.
    Start {
        run: String,
        schedule: Value,
        wake: bool,
        /// The request the start was charged with: main forgets it once the run started.
        charge: Option<u64>,
    },
    /// A woken session's run writes its one log line; a failure is the run's (`ended`).
    WakeLog { run: String, text: String },
    /// Main stops the run it started.
    Stop { run: String },
    /// A run is over: its prompt file goes.
    RemovePrompt { run: String },
    /// Runs left the history: their logs go.
    RemoveLogs { runs: Vec<String> },
}

struct Active {
    /// None while main is asked whether the start may be charged.
    run: Option<String>,
    launched: bool,
    stop_requested: bool,
    charge: Option<u64>,
    /// What the run is told: the schedule's prompt, with what fired it.
    prompt: String,
}

/// A start waiting for main's answer about its charge.
enum Held {
    Due {
        schedule: String,
        due: i64,
    },
    Event {
        schedule: String,
        details: Vec<String>,
    },
    RunNow {
        schedule: String,
    },
}

/// What a command came to.
pub enum Commanded {
    Done,
    /// A run now waits for the charge `ask` names; `reserved` says how it went.
    Asked(u64),
}

pub struct Engine {
    limits: Limits,
    minute_ms: i64,
    /// Whether main charges a paired device's starts (`reserve`); without, none is ever asked.
    charges: bool,
    /// Whether main delivers wake-ups (`wake`).
    wakes: bool,
    zone: Box<dyn Zone>,
    ids: Box<dyn FnMut() -> String + Send>,
    keys: Box<dyn FnMut() -> String + Send>,
    now: i64,
    paused: bool,
    schedules: Vec<Object>,
    runs: Vec<Object>,
    next: HashMap<String, i64>,
    /// Running starts by schedule id.
    active: HashMap<String, Active>,
    /// Events that came while a routine ran, by schedule id: one more run starts with them when it ends.
    pending: HashMap<String, Vec<String>>,
    /// Event runs in a row each asked for while the one before ran, by schedule id (the loop guard).
    chain: HashMap<String, u64>,
    held: HashMap<u64, Held>,
    last_ask: u64,
    closed: bool,
    pub outs: Vec<Out>,
}

fn fault(message: impl Into<String>) -> Fault {
    Fault::new("schedule_error", message)
}

fn text<'a>(object: &'a Object, name: &str) -> Option<&'a str> {
    object.get(name).and_then(Value::as_str)
}

fn id_of(object: &Object) -> &str {
    text(object, "id").unwrap_or_default()
}

fn kind_of(schedule: &Object) -> Option<&str> {
    schedule.get("frequency")?.get("kind")?.as_str()
}

/// A webhook trigger's key.
fn webhook_key(frequency: Option<&Value>) -> Option<&str> {
    let frequency = frequency?;
    let event = frequency.get("event")?;
    (frequency.get("kind")?.as_str()? == "event" && event.get("source")?.as_str()? == "webhook")
        .then(|| event.get("key")?.as_str())?
}

/// `timingSafeEqual` behind its length check: whether two keys are the same, in a time that says nothing of where
/// they differ.
fn same_key(want: &[u8], got: &[u8]) -> bool {
    if want.len() != got.len() {
        return false;
    }
    let mut differing = 0;
    for (want, got) in want.iter().zip(got) {
        differing |= want ^ got;
    }
    std::hint::black_box(differing) == 0
}

impl Engine {
    pub fn new(
        limits: Limits,
        minute_ms: i64,
        charges: bool,
        wakes: bool,
        zone: Box<dyn Zone>,
        ids: Box<dyn FnMut() -> String + Send>,
        keys: Box<dyn FnMut() -> String + Send>,
    ) -> Engine {
        Engine {
            limits,
            minute_ms,
            charges,
            wakes,
            zone,
            ids,
            keys,
            now: 0,
            paused: false,
            schedules: Vec::new(),
            runs: Vec::new(),
            next: HashMap::new(),
            active: HashMap::new(),
            pending: HashMap::new(),
            chain: HashMap::new(),
            held: HashMap::new(),
            last_ask: 0,
            closed: false,
            outs: Vec::new(),
        }
    }

    fn parse(&self, value: Option<&Value>) -> Option<i64> {
        rules::date_parse(value?.as_str()?, self.zone.as_ref())
    }

    fn find(&self, id: &str) -> Option<usize> {
        self.schedules
            .iter()
            .position(|schedule| id_of(schedule) == id)
    }

    fn enabled(&self, at: usize) -> bool {
        rules::truthy(self.schedules[at].get("enabled"))
    }

    /// The paired device a schedule's starts are charged to, when main charges.
    fn charged(&self, at: usize) -> Option<String> {
        self.schedules[at]
            .get("device")
            .filter(|_| self.charges)
            .map(string_of_value)
    }

    /// Loads the journal (`stored`: the file, none when it cannot be read): a run left running by a crash ends as
    /// stopped, every schedule gets its next start.
    pub fn load(&mut self, stored: Option<&str>, now: i64) {
        self.now = now;
        let (paused, schedules, runs) = self.read_stored(stored).unwrap_or_default();
        self.paused = paused;
        self.schedules = schedules;
        self.runs = runs;
        let ended = Value::String(rules::iso(now));
        for run in &mut self.runs {
            if text(run, "status") == Some("running") {
                run.insert("status".into(), "stopped".into());
                run.insert("endedAt".into(), ended.clone());
                run.insert("error".into(), CLOSED_DURING_RUN.into());
            }
        }
        self.reschedule_all();
        self.changed();
    }

    /// `readStored`: none where the TypeScript's `catch` answered an empty journal.
    fn read_stored(&self, stored: Option<&str>) -> Option<(bool, Vec<Object>, Vec<Object>)> {
        let parsed: Value = serde_json::from_str(&crate::json::whole_surrogates(stored?)).ok()?;
        // `typeof parsed === "object"`: a list reads as an object with none of the members.
        if !(parsed.is_object() || parsed.is_array()) {
            return None;
        }
        let mut schedules = Vec::new();
        for schedule in parsed
            .get("schedules")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(object) = schedule
                .as_object()
                .filter(|object| text(object, "id").is_some())
            else {
                continue;
            };
            if rules::draft_problem(schedule, self.zone.as_ref())
                .ok()?
                .is_none()
            {
                schedules.push(object.clone());
            }
        }
        let runs = parsed
            .get("runs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .filter(|run| text(run, "id").is_some())
            .take(self.limits.runs_kept)
            .cloned()
            .collect();
        Some((
            parsed.get("paused") == Some(&Value::Bool(true)),
            schedules,
            runs,
        ))
    }

    /// The moment of the entry that is being taken, or was taken last.
    pub fn now(&self) -> i64 {
        self.now
    }

    pub fn state(&self) -> Value {
        let mut next_runs = Object::new();
        for schedule in &self.schedules {
            let id = id_of(schedule);
            let next = self.next.get(id).map(|next| rules::iso(*next));
            next_runs.insert(id.to_owned(), next.map_or(Value::Null, Value::String));
        }
        json!({
            "paused": self.paused,
            "schedules": self.schedules,
            "runs": self.runs,
            "nextRuns": next_runs,
        })
    }

    fn journal(&self) -> String {
        let stored = json!({
            "version": 1,
            "paused": self.paused,
            "schedules": self.schedules,
            "runs": self.runs,
        });
        // `JSON.stringify(stored, null, 2)`.
        serde_json::to_string_pretty(&stored).unwrap_or_default()
    }

    fn changed(&mut self) {
        if self.closed {
            return;
        }
        self.outs.push(Out::Changed {
            state: self.state(),
            journal: self.journal(),
        });
    }

    /// Whether a routine's trigger may act on it now.
    fn routine(&self, id: &str) -> Option<usize> {
        let at = self.find(id)?;
        (kind_of(&self.schedules[at]) == Some("event")
            && self.enabled(at)
            && !self.paused
            && !self.closed)
            .then_some(at)
    }

    /// An event schedule's trigger fired (`detail`: one English line saying what happened). Starts a run now, or keeps
    /// the event for one more run after the running one. False when nothing will run on it: no such routine, it is no
    /// event schedule, off, everything is paused, or the app is closing.
    pub fn fire(&mut self, id: &str, detail: &str, now: i64) -> bool {
        self.now = now;
        let Some(at) = self.routine(id) else {
            return false;
        };
        let mut line = rules::one_line(detail);
        if line.is_empty() {
            line = "The trigger fired".into();
        }
        if self.active.contains_key(id) {
            let kept = self.pending.entry(id.to_owned()).or_default();
            kept.push(line);
            let over = kept.len().saturating_sub(PENDING_DETAILS_MAX);
            kept.drain(..over);
            return true;
        }
        self.chain.remove(id);
        self.start_event(at, vec![line]);
        self.changed();
        true
    }

    /// `POST /hooks/<id>` with `Authorization: Bearer <key>`: fires the routine whose webhook key it is.
    pub fn webhook(&mut self, id: &str, bearer: &str, detail: &str, now: i64) -> &'static str {
        let key = self
            .find(id)
            .and_then(|at| webhook_key(self.schedules[at].get("frequency")));
        let Some(key) = key else {
            return "unknown";
        };
        if !same_key(key.as_bytes(), bearer.as_bytes()) {
            return "denied";
        }
        if self.fire(id, detail, now) {
            "fired"
        } else {
            "off"
        }
    }

    /// A routine's trigger cannot watch what it names: recorded as a failed run with the reason, and nothing runs.
    /// False when the routine is gone, off or paused.
    pub fn trigger_failed(&mut self, id: &str, reason: &str, now: i64) -> bool {
        self.now = now;
        if self.routine(id).is_none() {
            return false;
        }
        let at = rules::iso(now);
        let error = format!("Its trigger failed: {}", rules::one_line(reason));
        let run = json!({
            "id": (self.ids)(),
            "scheduleId": id,
            "trigger": "event",
            "startedAt": at,
            "endedAt": at,
            "status": "failed",
            "exitCode": null,
            "error": error,
        });
        self.record(run);
        self.changed();
        true
    }

    /// One `SchedulesRequest`. `origin`: the paired device it comes from; a save from a device makes the schedule
    /// that device's, a run now from one is charged to it.
    pub fn command(
        &mut self,
        request: &Value,
        origin: Option<&str>,
        now: i64,
    ) -> Result<Commanded, Fault> {
        self.now = now;
        let id = request.get("id");
        let named = |engine: &Engine| {
            id.and_then(Value::as_str)
                .and_then(|id| engine.find(id))
                .ok_or_else(|| fault("Schedule not found"))
        };
        match request.get("action").and_then(Value::as_str) {
            Some("get") => {}
            Some("save") => {
                let draft = request.get("draft").unwrap_or(&Value::Null);
                self.save(draft, id, origin)?;
            }
            Some("delete") => {
                let at = named(self)?;
                self.delete(at);
            }
            Some("setEnabled") => {
                let at = named(self)?;
                let enabled = request.get("enabled") == Some(&Value::Bool(true));
                self.schedules[at].insert("enabled".into(), enabled.into());
                let id = id_of(&self.schedules[at]).to_owned();
                if !enabled {
                    self.invalidate_pending(&id);
                }
                self.pending.remove(&id);
                self.chain.remove(&id);
                self.reschedule(at);
            }
            Some("setPaused") => {
                self.paused = request.get("paused") == Some(&Value::Bool(true));
                if self.paused {
                    for active in self.active.values_mut().filter(|active| !active.launched) {
                        active.stop_requested = true;
                    }
                }
                self.reschedule_all();
            }
            Some("runNow") => {
                let at = named(self)?;
                let id = id_of(&self.schedules[at]).to_owned();
                if self.active.contains_key(&id) {
                    return Err(fault("This schedule is already running"));
                }
                if let Some(device) = origin.filter(|_| self.charges) {
                    let ask = self.reserve(&id, device.to_owned());
                    self.held.insert(ask, Held::RunNow { schedule: id });
                    return Ok(Commanded::Asked(ask));
                }
                self.run_now(at, None);
            }
            Some("stop") => {
                let run = request.get("runId").and_then(Value::as_str);
                let running = self
                    .active
                    .iter()
                    .find(|(_, active)| active.run.is_some() && active.run.as_deref() == run)
                    .map(|(id, _)| id.clone());
                if let Some(id) = running {
                    self.stop_schedule(&id);
                }
            }
            _ => return Err(fault("Unknown schedules action")),
        }
        self.changed();
        Ok(Commanded::Done)
    }

    fn run_now(&mut self, at: usize, charge: Option<u64>) {
        let test = (kind_of(&self.schedules[at]) == Some("event"))
            .then(|| vec!["A test run: no event fired".to_owned()]);
        self.start_run(at, Trigger::Manual, charge, test);
    }

    /// Saves a new schedule and says which one it is.
    pub fn create(
        &mut self,
        draft: &Value,
        origin: Option<&str>,
        now: i64,
    ) -> Result<String, Fault> {
        self.now = now;
        let id = self.save(draft, None, origin)?;
        self.changed();
        Ok(id)
    }

    /// `draft` is what main's `cleanDraft` made of what the page sent: every member of its own type, a webhook's key
    /// as sent (empty: make one, or keep the schedule's).
    fn save(
        &mut self,
        draft: &Value,
        id: Option<&Value>,
        origin: Option<&str>,
    ) -> Result<String, Fault> {
        let existing = match id.filter(|id| rules::truthy(Some(id))) {
            Some(id) => Some(
                id.as_str()
                    .and_then(|id| self.find(id))
                    .ok_or_else(|| fault("Schedule not found"))?,
            ),
            None => None,
        };
        let mut clean = draft.as_object().cloned().unwrap_or_default();
        // A saved edit keeps what the Settings dialog does not show: the session a wake-up goes to.
        if !clean.contains_key("wakeSession")
            && let Some(kept) = existing.and_then(|at| self.schedules[at].get("wakeSession"))
        {
            clean.insert("wakeSession".into(), string_of_value(kept).into());
        }
        let before = existing.and_then(|at| self.schedules[at].get("frequency"));
        if let Some(sent) = webhook_key(clean.get("frequency")) {
            let key = match (sent, webhook_key(before)) {
                ("", Some(kept)) if !kept.is_empty() => kept.to_owned(),
                ("", _) => (self.keys)(),
                (sent, _) => sent.to_owned(),
            };
            clean.insert(
                "frequency".into(),
                json!({ "kind": "event", "event": { "source": "webhook", "key": key } }),
            );
        }
        let draft = Value::Object(clean);
        // Main's cleaning leaves nothing the rule throws over; a draft that came another way is no schedule.
        let problem = rules::draft_problem(&draft, self.zone.as_ref()).unwrap_or(Some("interval"));
        if let Some(problem) = problem {
            return Err(fault(format!("Invalid schedule: {problem}")));
        }
        let Value::Object(clean) = draft else {
            unreachable!("the draft was made an object above");
        };
        let frequency = clean.get("frequency");
        // A one-time start is set for a moment still to come (a changed moment too); a missed one never runs.
        if frequency.and_then(|frequency| frequency.get("kind")) == Some(&Value::from("once")) {
            let at = frequency.and_then(|frequency| frequency.get("at"));
            let unchanged = before.is_some_and(|before| {
                before.get("kind") == Some(&Value::from("once")) && before.get("at") == at
            });
            if self.parse(at).is_some_and(|at| at <= self.now) && !unchanged {
                return Err(fault("Invalid schedule: once (the moment has passed)"));
            }
        }
        if let Some(session) = text(&clean, "wakeSession") {
            let drive = matches!(session.as_bytes(), [drive, b':', b'\\' | b'/', ..] if drive.is_ascii_alphabetic());
            if !(session.starts_with('/') || drive) {
                return Err(fault("Invalid schedule: session"));
            }
            if origin.is_some() {
                return Err(fault(
                    "Invalid schedule: only this computer's own sessions are woken",
                ));
            }
        }
        if let Some(at) = existing {
            let id = id_of(&self.schedules[at]).to_owned();
            self.invalidate_pending(&id);
            let schedule = &mut self.schedules[at];
            // `Object.assign`: a member it has keeps its place, a new one goes last.
            for (name, value) in clean {
                schedule.insert(name, value);
            }
            match origin {
                None => {
                    schedule.shift_remove("device");
                }
                Some(origin) => {
                    schedule.insert("device".into(), origin.into());
                }
            }
            self.reschedule(at);
            return Ok(id_of(&self.schedules[at]).to_owned());
        }
        let id = (self.ids)();
        let mut schedule = clean;
        schedule.insert("id".into(), id.clone().into());
        schedule.insert("createdAt".into(), rules::iso(self.now).into());
        if let Some(origin) = origin {
            schedule.insert("device".into(), origin.into());
        }
        self.schedules.push(schedule);
        self.reschedule(self.schedules.len() - 1);
        Ok(id)
    }

    fn last_start(&self, id: &str) -> Option<i64> {
        let last = self.runs.iter().find(|run| {
            text(run, "scheduleId") == Some(id) && text(run, "status") != Some("skipped")
        })?;
        self.parse(last.get("startedAt"))
    }

    fn set_next(&mut self, at: usize, next: Option<i64>) {
        let id = id_of(&self.schedules[at]).to_owned();
        match next {
            Some(next) => self.next.insert(id, next),
            None => self.next.remove(&id),
        };
    }

    fn next_after(&self, at: usize, last: Option<i64>) -> Option<i64> {
        let frequency = self.schedules[at].get("frequency")?;
        rules::next_run_at(
            frequency,
            self.now,
            last,
            self.minute_ms,
            self.zone.as_ref(),
        )
    }

    fn reschedule(&mut self, at: usize) {
        let next = if self.paused || !self.enabled(at) {
            None
        } else {
            self.next_after(at, self.last_start(id_of(&self.schedules[at])))
        };
        self.set_next(at, next);
    }

    fn reschedule_all(&mut self) {
        for at in 0..self.schedules.len() {
            self.reschedule(at);
        }
    }

    /// The start after a skipped one, from the moment it was due.
    fn skip_to(&mut self, at: usize, due: i64) {
        let next = self.next_after(at, Some(due));
        self.set_next(at, next);
    }

    fn skipped(&mut self, at: usize, trigger: Trigger, error: &str, detail: Option<String>) {
        let moment = rules::iso(self.now);
        let mut run = json!({
            "id": (self.ids)(),
            "scheduleId": id_of(&self.schedules[at]),
            "trigger": trigger.name(),
            "startedAt": moment,
            "endedAt": moment,
            "status": "skipped",
            "exitCode": null,
            "error": error,
        });
        if let Some(detail) = detail {
            run["detail"] = detail.into();
        }
        self.record(run);
    }

    /// Holds the schedule's start and asks main whether `device` may be charged for it.
    fn reserve(&mut self, id: &str, device: String) -> u64 {
        self.last_ask += 1;
        self.active.insert(
            id.to_owned(),
            Active {
                run: None,
                launched: false,
                stop_requested: false,
                charge: None,
                prompt: String::new(),
            },
        );
        self.outs.push(Out::Reserve {
            ask: self.last_ask,
            device,
        });
        self.last_ask
    }

    /// The clock's check: every schedule whose start is due starts, or is recorded as skipped while its previous run
    /// still goes.
    pub fn tick(&mut self, now: i64) {
        self.now = now;
        if self.paused || self.closed {
            return;
        }
        let mut changed = false;
        // A start may delete spent one-time schedules: the ones listed now are the ones looked at.
        let ids: Vec<String> = self.schedules.iter().map(|s| id_of(s).to_owned()).collect();
        for id in ids {
            let Some(due) = self.next.get(&id).copied().filter(|due| *due <= now) else {
                continue;
            };
            let Some(at) = self.find(&id) else {
                continue;
            };
            match self.active.get(&id) {
                // Its charge is still being asked: this start is the one waiting.
                Some(Active { run: None, .. }) => continue,
                Some(_) => {
                    changed = true;
                    self.skipped(
                        at,
                        Trigger::Schedule,
                        "The previous run was still going",
                        None,
                    );
                    self.skip_to(at, due);
                    continue;
                }
                None => {}
            }
            changed = true;
            if let Some(device) = self.charged(at) {
                let ask = self.reserve(&id, device);
                self.held.insert(ask, Held::Due { schedule: id, due });
                continue;
            }
            self.start_run(at, Trigger::Schedule, None, None);
        }
        if changed {
            self.changed();
        }
    }

    /// An event run with what fired it; a paired device's routine is charged like any start of its.
    fn start_event(&mut self, at: usize, details: Vec<String>) {
        if let Some(device) = self.charged(at) {
            let id = id_of(&self.schedules[at]).to_owned();
            let ask = self.reserve(&id, device);
            self.held.insert(
                ask,
                Held::Event {
                    schedule: id,
                    details,
                },
            );
            return;
        }
        self.start_run(at, Trigger::Event, None, Some(details));
    }

    /// Main's answer to a `Reserve`: `refused` is why the device has no request left. For a run now, how it went
    /// (the command's answer); none for a start the clock or an event made.
    pub fn reserved(
        &mut self,
        ask: u64,
        refused: Option<&str>,
        now: i64,
    ) -> Option<Result<(), Fault>> {
        self.now = now;
        let held = self.held.remove(&ask)?;
        let (Held::Due { schedule, .. } | Held::Event { schedule, .. } | Held::RunNow { schedule }) =
            &held;
        let cancelled = self
            .active
            .get(schedule)
            .is_none_or(|active| active.stop_requested);
        if self
            .active
            .get(schedule)
            .is_some_and(|active| active.run.is_none())
        {
            self.active.remove(schedule);
        }
        let at = self.find(schedule).filter(|_| !self.closed && !cancelled);
        let Some(at) = at else {
            // Deleted, or the service closed, while main was asked: nothing starts, nothing is spent.
            if refused.is_none() {
                self.outs.push(Out::Refund { charge: ask });
            }
            return matches!(held, Held::RunNow { .. }).then(|| Err(fault("Schedule not found")));
        };
        let charge = refused.is_none().then_some(ask);
        match held {
            Held::RunNow { .. } => {
                if let Some(reason) = refused {
                    return Some(Err(Fault::new("remote_limit_reached", reason)));
                }
                self.run_now(at, charge);
                self.changed();
                return Some(Ok(()));
            }
            Held::Due { due, .. } => match refused {
                Some(reason) => {
                    self.skipped(at, Trigger::Schedule, reason, None);
                    self.skip_to(at, due);
                }
                None => self.start_run(at, Trigger::Schedule, charge, None),
            },
            Held::Event { details, .. } => match refused {
                Some(reason) => self.skipped(at, Trigger::Event, reason, Some(details.join("\n"))),
                None => self.start_run(at, Trigger::Event, charge, Some(details)),
            },
        }
        self.changed();
        None
    }

    /// Records a run as started and leaves its files to the host (`prepared` goes on).
    fn start_run(
        &mut self,
        at: usize,
        trigger: Trigger,
        charge: Option<u64>,
        details: Option<Vec<String>>,
    ) {
        let detail = details.map(|details| details.join("\n"));
        let id = (self.ids)();
        let schedule_id = id_of(&self.schedules[at]).to_owned();
        let mut run = json!({
            "id": id,
            "scheduleId": schedule_id,
            "trigger": trigger.name(),
            "startedAt": rules::iso(self.now),
            "endedAt": null,
            "status": "running",
            "exitCode": null,
            "error": null,
        });
        if let Some(detail) = &detail {
            run["detail"] = detail.as_str().into();
        }
        let schedule = &self.schedules[at];
        let prompt = text(schedule, "prompt").unwrap_or_default();
        let prompt = match &detail {
            None => prompt.to_owned(),
            Some(detail) => {
                let heading = if trigger == Trigger::Manual {
                    "Test run"
                } else {
                    "What fired this run"
                };
                format!("{prompt}\n\n{heading}:\n{detail}")
            }
        };
        let cwd = match schedule.get("wakeSession") {
            Some(_) => None,
            None => Some(schedule.get("cwd").map(string_of_value).unwrap_or_default()),
        };
        self.active.insert(
            schedule_id.clone(),
            Active {
                run: Some(id.clone()),
                launched: false,
                stop_requested: false,
                charge,
                prompt: prompt.clone(),
            },
        );
        self.record(run);
        // A one-time start is spent: the schedule is off from now on (a test run leaves it as it was).
        if kind_of(&self.schedules[at]) == Some("once") && trigger == Trigger::Schedule {
            self.schedules[at].insert("enabled".into(), false.into());
            self.prune_once();
        }
        // Pruning leaves this schedule (it runs), but may have moved it.
        if let Some(at) = self.find(&schedule_id) {
            self.reschedule(at);
        }
        self.changed();
        self.outs.push(Out::Prepare {
            run: id,
            prompt,
            cwd,
        });
    }

    fn running(&self, run: &str) -> Option<String> {
        self.active
            .iter()
            .find(|(_, active)| active.run.as_deref() == Some(run))
            .map(|(id, _)| id.clone())
    }

    /// Called under the host's engine lock through the actual spawn or wake commit.
    pub fn launch_allowed(&self, run: &str) -> bool {
        !self.closed
            && self.running(run).is_some_and(|id| {
                self.find(&id).is_some()
                    && self
                        .active
                        .get(&id)
                        .is_some_and(|active| !active.launched && !active.stop_requested)
            })
    }

    fn invalidate_pending(&mut self, id: &str) {
        if let Some(active) = self.active.get_mut(id).filter(|active| !active.launched) {
            active.stop_requested = true;
        }
    }

    /// The host made a run's files (`failed`: why it could not, or its folder is gone): main is asked to start it.
    pub fn prepared(&mut self, run: &str, failed: Option<String>, now: i64) {
        self.now = now;
        let Some(id) = self.running(run) else {
            return;
        };
        if !self.launch_allowed(run) {
            self.ended(run, None, failed, now);
            return;
        }
        let schedule = self.find(&id).map(|at| &self.schedules[at]);
        let wake = schedule.is_some_and(|schedule| schedule.contains_key("wakeSession"));
        let failed = failed.or_else(|| {
            (wake && !self.wakes).then(|| "Waking a session is not available here".to_owned())
        });
        let (None, Some(schedule)) = (&failed, schedule) else {
            // A schedule deleted in between has stopped its run already: it ends as the stop it was.
            self.ended(run, None, failed, now);
            return;
        };
        let mut told = schedule.clone();
        let active = self.active.get(&id);
        let prompt = active.map(|active| active.prompt.clone());
        told.insert("prompt".into(), prompt.into());
        self.outs.push(Out::Start {
            run: run.to_owned(),
            schedule: Value::Object(told),
            wake,
            charge: active.and_then(|active| active.charge),
        });
    }

    /// Main started the run: a wake-up writes its log line, a stop asked for meanwhile goes out.
    pub fn started(&mut self, run: &str, now: i64) {
        self.now = now;
        let Some(id) = self.running(run) else {
            return;
        };
        let session = self
            .find(&id)
            .and_then(|at| self.schedules[at].get("wakeSession"))
            .map(string_of_value);
        let Some(active) = self.active.get_mut(&id) else {
            return;
        };
        if active.launched {
            return;
        }
        active.launched = true;
        if active.stop_requested {
            self.outs.push(Out::Stop {
                run: run.to_owned(),
            });
        }
        if let Some(session) = session {
            let text = format!("Woke {session}\n{}\n", active.prompt);
            self.outs.push(Out::WakeLog {
                run: run.to_owned(),
                text,
            });
        }
    }

    /// A run is over: `code` is its exit status (0 for a woken turn that ended well), `error` why it has none.
    pub fn ended(&mut self, run: &str, code: Option<i64>, error: Option<String>, now: i64) {
        self.now = now;
        let Some(id) = self.running(run) else {
            return;
        };
        let Some(active) = self.active.remove(&id) else {
            return;
        };
        // A run that never started spent nothing of the device's day.
        if let (false, Some(charge)) = (active.launched, active.charge) {
            self.outs.push(Out::Refund { charge });
        }
        self.outs.push(Out::RemovePrompt {
            run: run.to_owned(),
        });
        if self.closed {
            return;
        }
        let stopped = active.stop_requested || code == Some(STOPPED_CODE);
        let (status, error) = if stopped {
            ("stopped", None)
        } else if code == Some(0) {
            ("succeeded", error)
        } else {
            let exit = code.map_or("null".to_owned(), |code| code.to_string());
            (
                "failed",
                error.or(Some(format!("omp exited with code {exit}"))),
            )
        };
        self.finish(run, status, code, error);
        if self
            .find(&id)
            .is_some_and(|at| kind_of(&self.schedules[at]) == Some("event"))
        {
            self.after_run(&id);
        }
    }

    fn finish(&mut self, run: &str, status: &str, code: Option<i64>, error: Option<String>) {
        let ended = rules::iso(self.now);
        let mut spent = None;
        if let Some(record) = self.runs.iter_mut().find(|record| id_of(record) == run) {
            record.insert("status".into(), status.into());
            record.insert("exitCode".into(), code.into());
            record.insert("error".into(), error.into());
            record.insert("endedAt".into(), ended.into());
            if text(record, "trigger") == Some("schedule") && status == "succeeded" {
                spent = text(record, "scheduleId").map(str::to_owned);
            }
        }
        self.changed();
        // An agent's one-time wake that did its work is spent and gone: nothing is left to read but a success.
        let spent = spent
            .and_then(|id| self.find(&id))
            .filter(|at| self.spent_agent_once(*at));
        if let Some(at) = spent {
            self.delete(at);
            self.changed();
        }
    }

    /// A routine's run ended with events kept meanwhile: one more run with all of them, unless every run has been
    /// asked for again before it ended `chain_limit` times in a row (its own work fires its trigger): then it is off.
    fn after_run(&mut self, id: &str) {
        let details = self.pending.remove(id);
        let at = self.find(id).filter(|at| !self.paused && self.enabled(*at));
        let (Some(details), Some(at)) = (details, at) else {
            self.chain.remove(id);
            return;
        };
        let chain = self.chain.get(id).copied().unwrap_or(0) + 1;
        if chain >= self.limits.chain_limit {
            self.schedules[at].insert("enabled".into(), false.into());
            self.chain.remove(id);
            self.reschedule(at);
            let why = format!(
                "Turned off: its trigger fired again during each of its last {} runs, so its own work probably fires it. Check the trigger, then turn it back on.",
                self.limits.chain_limit
            );
            self.skipped(at, Trigger::Event, &why, Some(details.join("\n")));
            self.changed();
            return;
        }
        self.chain.insert(id.to_owned(), chain);
        self.start_event(at, details);
        self.changed();
    }

    /// A one-time schedule an agent made (`[agent] …`) whose start is spent (it turned itself off).
    fn spent_agent_once(&self, at: usize) -> bool {
        let schedule = &self.schedules[at];
        kind_of(schedule) == Some("once") && !self.enabled(at) && self.agents(schedule)
    }

    fn agents(&self, schedule: &Object) -> bool {
        text(schedule, "name").is_some_and(|name| name.starts_with(&self.limits.agent_prefix))
    }

    /// When a run ended, else started, as `Date.parse(run.endedAt ?? run.startedAt)` read it.
    fn ended_at(&self, run: &Object) -> Option<i64> {
        match run.get("endedAt") {
            None | Some(Value::Null) => self.parse(run.get("startedAt")),
            ended => self.parse(ended),
        }
    }

    /// Ages out what agents left (launch and hourly): an agent schedule's finished runs past seven days, and a spent
    /// one-time agent schedule, at once when its run did not fail (or it never ran), or a day after a failed run
    /// ended. The owner's own schedules keep their history.
    pub fn prune(&mut self, at: i64, now: i64) {
        self.now = now;
        let mut changed = false;
        let ids: Vec<String> = self.schedules.iter().map(|s| id_of(s).to_owned()).collect();
        for id in ids {
            let Some(index) = self.find(&id) else {
                continue;
            };
            if !self.spent_agent_once(index) || self.active.contains_key(&id) {
                continue;
            }
            let last = self
                .runs
                .iter()
                .find(|run| text(run, "scheduleId") == Some(&id));
            let failed = last.filter(|last| text(last, "status") != Some("succeeded"));
            if failed
                .is_some_and(|last| self.ended_at(last).is_none_or(|ended| ended >= at - DAY_MS))
            {
                continue;
            }
            self.delete(index);
            changed = true;
        }
        let old: Vec<String> = self
            .runs
            .iter()
            .filter(|run| {
                text(run, "status") != Some("running")
                    && text(run, "scheduleId")
                        .and_then(|id| self.find(id))
                        .is_some_and(|at| self.agents(&self.schedules[at]))
                    && self
                        .ended_at(run)
                        .is_some_and(|ended| ended < at - 7 * DAY_MS)
            })
            .map(|run| id_of(run).to_owned())
            .collect();
        if !old.is_empty() {
            self.runs
                .retain(|run| !old.iter().any(|id| id == id_of(run)));
            self.outs.push(Out::RemoveLogs { runs: old });
            changed = true;
        }
        if changed {
            self.changed();
        }
    }

    fn stop_schedule(&mut self, id: &str) {
        let Some(active) = self.active.get_mut(id) else {
            return;
        };
        active.stop_requested = true;
        if let (true, Some(run)) = (active.launched, &active.run) {
            self.outs.push(Out::Stop { run: run.clone() });
        }
    }

    /// Newest first; each schedule keeps its `runs_per_schedule` newest, all together `runs_kept`.
    fn record(&mut self, run: Value) {
        let Value::Object(run) = run else {
            return;
        };
        self.runs.insert(0, run);
        let mut kept = Vec::with_capacity(self.runs.len());
        let mut dropped = Vec::new();
        let mut per_schedule: HashMap<String, usize> = HashMap::new();
        for run in std::mem::take(&mut self.runs) {
            let of = string_of_value(run.get("scheduleId").unwrap_or(&Value::Null));
            let count = per_schedule.get(&of).copied().unwrap_or(0);
            if text(&run, "status") == Some("running")
                || (kept.len() < self.limits.runs_kept && count < self.limits.runs_per_schedule)
            {
                per_schedule.insert(of, count + 1);
                kept.push(run);
            } else {
                dropped.push(id_of(&run).to_owned());
            }
        }
        self.runs = kept;
        if !dropped.is_empty() {
            self.outs.push(Out::RemoveLogs { runs: dropped });
        }
    }

    /// A schedule and its finished runs go; a running one is stopped and its record ends as it ends.
    fn delete(&mut self, at: usize) {
        let id = id_of(&self.schedules[at]).to_owned();
        self.stop_schedule(&id);
        self.schedules.remove(at);
        let gone = |run: &Object| {
            text(run, "scheduleId") == Some(&id) && text(run, "status") != Some("running")
        };
        let dropped: Vec<String> = self
            .runs
            .iter()
            .filter(|run| gone(run))
            .map(|run| id_of(run).to_owned())
            .collect();
        self.runs.retain(|run| !gone(run));
        if !dropped.is_empty() {
            self.outs.push(Out::RemoveLogs { runs: dropped });
        }
        self.next.remove(&id);
        self.pending.remove(&id);
        self.chain.remove(&id);
    }

    /// Spent one-time schedules past `once_done_kept`, the oldest first, are deleted with their runs.
    fn prune_once(&mut self) {
        let spent: Vec<String> = (0..self.schedules.len())
            .filter(|at| {
                let schedule = &self.schedules[*at];
                kind_of(schedule) == Some("once")
                    && !self.enabled(*at)
                    && !self.active.contains_key(id_of(schedule))
            })
            .map(|at| id_of(&self.schedules[at]).to_owned())
            .collect();
        let over = spent.len().saturating_sub(self.limits.once_done_kept);
        for id in &spent[..over] {
            if let Some(at) = self.find(id) {
                self.delete(at);
            }
        }
    }

    /// Whether the history holds the run (its log may be read).
    pub fn has_run(&self, run: &str) -> bool {
        self.runs.iter().any(|record| id_of(record) == run)
    }

    /// The service closes (app quit, the core's input ended): every running run is recorded as stopped and the
    /// journal is written once more. The runs themselves are main's to stop.
    pub fn close(&mut self, now: i64) {
        if self.closed {
            return;
        }
        self.closed = true;
        let ended = Value::String(rules::iso(now));
        for active in self.active.values() {
            let Some(run) = self
                .runs
                .iter_mut()
                .find(|run| Some(id_of(run)) == active.run.as_deref())
            else {
                continue;
            };
            if text(run, "status") == Some("running") {
                run.insert("status".into(), "stopped".into());
                run.insert("endedAt".into(), ended.clone());
                run.insert("error".into(), CLOSED_DURING_RUN.into());
            }
        }
        self.active.clear();
        self.outs.push(Out::Closed {
            journal: self.journal(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_keys_whole() {
        assert!(same_key(b"kkkkkkkkkkkkkkkk", b"kkkkkkkkkkkkkkkk"));
        assert!(same_key(b"", b""));
        // A difference in any place, the first and the last too, and any other length.
        for at in 0..16 {
            let mut other = *b"kkkkkkkkkkkkkkkk";
            other[at] ^= 1;
            assert!(!same_key(b"kkkkkkkkkkkkkkkk", &other), "{at}");
        }
        assert!(!same_key(b"kkkkkkkkkkkkkkkk", b"kkkkkkkkkkkkkkkkx"));
        assert!(!same_key(b"kkkkkkkkkkkkkkkk", b"kkkkkkkkkkkkkkk"));
        assert!(!same_key(b"kkkkkkkkkkkkkkkk", b""));
    }
}
