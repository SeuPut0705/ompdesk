//! The engine held to what the TypeScript `ScheduleService` did: `captured.json`'s scenarios are scripts of what the
//! page, the clock, the triggers and the runs did, with the state the service answered after each step and the
//! journal it left; its loads are journals as a launch finds them. Each is replayed here on the engine alone, with
//! this file standing in for main (the charge, the run, its stop) and for the host (the run's files).

use std::collections::HashMap;

use serde_json::Value;

use super::captured;
use super::engine::{Commanded, Engine, Limits, Out};
use super::rules::Fixed;
use crate::server::Fault;

/// The clock's check, as `SCHEDULE_TICK_MS` set it.
const TICK_MS: i64 = 30_000;
const DIR: &str = "/work/ompdesk-replay";
const KEY: &str = "KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK";

fn limits() -> Limits {
    Limits {
        runs_kept: 200,
        runs_per_schedule: 20,
        once_done_kept: 20,
        chain_limit: 10,
        agent_prefix: "[agent] ".into(),
    }
}

fn engine(ids: std::sync::Arc<std::sync::atomic::AtomicU64>) -> Engine {
    let next = move || {
        let number = ids.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("u~{number}~")
    };
    Engine::new(
        limits(),
        60_000,
        true,
        true,
        Box::new(Fixed(0)),
        Box::new(next),
        Box::new(|| KEY.to_owned()),
    )
}

/// Main and the host, as the capture's fakes were: a device's budget, runs that end when the script says, a folder
/// named `gone` that is not there.
struct Play {
    engine: Engine,
    ids: std::sync::Arc<std::sync::atomic::AtomicU64>,
    now: i64,
    next_tick: i64,
    /// A device's requests left; none: no limit.
    left: Option<u64>,
    launches: Vec<(String, String, bool)>,
    refunds: u64,
    journals: Vec<String>,
    /// What a run now answered once main had said whether it may be charged.
    answered: Option<Result<(), Fault>>,
    schedules: Vec<String>,
    runs: Vec<String>,
    /// The engine's ids by the names the capture gave them: in the order they first showed.
    names: HashMap<String, String>,
    /// The first schedule's webhook key as it last was, which the capture wrote as `<key>`.
    key: String,
}

impl Play {
    fn new(start: i64) -> Play {
        let ids = std::sync::Arc::default();
        let mut play = Play {
            engine: engine(std::sync::Arc::clone(&ids)),
            ids,
            now: start,
            next_tick: start + TICK_MS,
            left: None,
            launches: Vec::new(),
            refunds: 0,
            journals: Vec::new(),
            answered: None,
            schedules: Vec::new(),
            runs: Vec::new(),
            names: HashMap::new(),
            key: String::new(),
        };
        play.engine.load(None, start);
        play.settle();
        play
    }

    fn settle(&mut self) {
        loop {
            let outs = std::mem::take(&mut self.engine.outs);
            if outs.is_empty() {
                break;
            }
            for out in outs {
                match out {
                    Out::Reserve { ask, device } => {
                        let refused = match &mut self.left {
                            Some(0) => Some(format!("{device}'s daily model limit is used up")),
                            Some(left) => {
                                *left -= 1;
                                None
                            }
                            None => None,
                        };
                        let answered = self.engine.reserved(ask, refused.as_deref(), self.now);
                        self.answered = self.answered.take().or(answered);
                    }
                    Out::Refund { .. } => self.refunds += 1,
                    Out::Prepare { run, cwd, .. } => {
                        let failed = cwd
                            .filter(|cwd| cwd.ends_with("/gone"))
                            .map(|cwd| format!("Project folder not found: {cwd}"));
                        self.engine.prepared(&run, failed, self.now);
                    }
                    Out::Start {
                        run,
                        schedule,
                        wake,
                        ..
                    } => {
                        let prompt = schedule["prompt"].as_str().unwrap().to_owned();
                        self.launches.push((run.clone(), prompt, wake));
                        self.engine.started(&run, self.now);
                    }
                    // The fake run ends as a stopped supervisor does.
                    Out::Stop { run } => self.engine.ended(&run, Some(130), None, self.now),
                    Out::Closed { journal } => self.journals.push(journal),
                    Out::Changed { .. }
                    | Out::WakeLog { .. }
                    | Out::RemovePrompt { .. }
                    | Out::RemoveLogs { .. } => {}
                }
            }
        }
    }

    /// `@n`: the nth schedule that showed; `#n`: the nth run.
    fn named(&self, written: &Value) -> String {
        let text = written.as_str().unwrap_or_default();
        let at = |list: &[String]| {
            let index: usize = text[1..].parse().unwrap();
            list.get(index).cloned().unwrap_or_else(|| "missing".into())
        };
        match text.as_bytes().first() {
            Some(b'@') => at(&self.schedules),
            Some(b'#') => at(&self.runs),
            _ => text.to_owned(),
        }
    }

    fn track(&mut self) {
        let state = self.engine.state();
        let ids = |list: &Value| -> Vec<String> {
            let items = list.as_array().unwrap();
            items
                .iter()
                .map(|item| item["id"].as_str().unwrap().to_owned())
                .collect()
        };
        for id in ids(&state["schedules"]) {
            if !self.schedules.contains(&id) {
                self.schedules.push(id);
            }
        }
        // Oldest first among the ones not seen yet: the list is newest first.
        for id in ids(&state["runs"]).into_iter().rev() {
            if !self.runs.contains(&id) {
                self.runs.push(id);
            }
        }
    }

    /// `text` as the capture wrote it: each id by the order it first showed, the key and the folder by their marks.
    fn normal(&mut self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(at) = rest.find("u~") {
            let end = at + 2 + rest[at + 2..].find('~').unwrap() + 1;
            out.push_str(&rest[..at]);
            let count = self.names.len();
            let name = self
                .names
                .entry(rest[at..end].to_owned())
                .or_insert_with(|| format!("id-{count}"));
            out.push_str(name);
            rest = &rest[end..];
        }
        out.push_str(rest);
        if !self.key.is_empty() {
            out = out.replace(&self.key, "<key>");
        }
        out.replace(DIR, "<dir>")
    }

    fn rekey(&mut self) {
        let event = &self.engine.state()["schedules"][0]["frequency"]["event"];
        if let (Some("webhook"), Some(key)) = (event["source"].as_str(), event["key"].as_str()) {
            self.key = key.to_owned();
        }
    }

    /// `told`: the prompts the TypeScript's runs were started with, in its order. Runs that came due in one check
    /// it started in whatever order their files were made, so a script's `launch` names a run by its prompt.
    fn step(&mut self, step: &Value, told: &[Value]) -> (Option<Value>, Option<String>) {
        let own = |fault: Fault| match fault.code.as_ref() {
            "remote_limit_reached" => format!("[remote_limit_reached] {}", fault.message),
            _ => fault.message,
        };
        let origin = step["origin"].as_str();
        let now = self.now;
        let mut result = None;
        let mut error = None;
        let command = |play: &mut Play, request: Value| {
            let commanded = play.engine.command(&request, origin, now);
            play.settle();
            match commanded {
                Ok(Commanded::Done) => None,
                Ok(Commanded::Asked(_)) => play.answered.take().and_then(Result::err).map(own),
                Err(fault) => Some(own(fault)),
            }
        };
        let id = self.named(&step["id"]);
        match step["op"].as_str().unwrap() {
            "advance" => {
                let until = now + step["ms"].as_i64().unwrap();
                while self.next_tick <= until {
                    self.now = self.next_tick;
                    self.engine.tick(self.now);
                    self.settle();
                    self.next_tick += TICK_MS;
                }
                self.now = until;
            }
            "reserve" => self.left = step["left"].as_u64(),
            "create" => match self.engine.create(&step["draft"], origin, now) {
                Ok(id) => {
                    self.settle();
                    self.track();
                    let at = self.schedules.iter().position(|known| *known == id);
                    result = Some(Value::String(format!("@{}", at.unwrap())));
                }
                Err(fault) => error = Some(own(fault)),
            },
            "save" => {
                let mut request = serde_json::json!({ "action": "save", "draft": step["draft"] });
                if !step["id"].is_null() {
                    request["id"] = id.into();
                }
                error = command(self, request);
            }
            "delete" => error = command(self, serde_json::json!({ "action": "delete", "id": id })),
            "setEnabled" => {
                let request = serde_json::json!({ "action": "setEnabled", "id": id, "enabled": step["enabled"] });
                error = command(self, request);
            }
            "setPaused" => {
                let request =
                    serde_json::json!({ "action": "setPaused", "paused": step["paused"] });
                error = command(self, request);
            }
            "runNow" => error = command(self, serde_json::json!({ "action": "runNow", "id": id })),
            "stop" => {
                let run = self.named(&step["run"]);
                error = command(self, serde_json::json!({ "action": "stop", "runId": run }));
            }
            "get" => error = command(self, serde_json::json!({ "action": "get" })),
            "command" => error = command(self, step["request"].clone()),
            "fire" => {
                let detail = step["detail"].as_str().unwrap();
                result = Some(self.engine.fire(&id, detail, now).into());
            }
            "webhook" => {
                let bearer = step["bearer"].as_str().unwrap();
                let bearer = bearer.replace("$key", KEY).replace("+x", "x");
                let detail = step["detail"].as_str().unwrap();
                result = Some(self.engine.webhook(&id, &bearer, detail, now).into());
            }
            "triggerFailed" => {
                let reason = step["reason"].as_str().unwrap();
                result = Some(self.engine.trigger_failed(&id, reason, now).into());
            }
            "prune" => self.engine.prune(now + step["plus"].as_i64().unwrap(), now),
            "finish" => {
                let launch = step["launch"].as_u64().unwrap() as usize;
                let prompt = told.get(launch).map(|told| &told["prompt"]);
                let earlier = told.iter().take(launch);
                let nth = earlier
                    .filter(|told| Some(&told["prompt"]) == prompt)
                    .count();
                let ours = self.launches.iter();
                let mut ours = ours
                    .filter(|(_, ours, _)| Some(ours.as_str()) == prompt.and_then(Value::as_str));
                match ours.nth(nth) {
                    Some((run, ..)) => {
                        let run = run.clone();
                        let error = step["error"].as_str().map(str::to_owned);
                        self.engine.ended(&run, step["code"].as_i64(), error, now);
                    }
                    None => error = Some(format!("no launch {launch}")),
                }
            }
            "dispose" => self.engine.close(now),
            "reload" => {
                self.engine.close(now);
                self.settle();
                let journal = self.journals.last().unwrap().clone();
                self.engine = engine(std::sync::Arc::clone(&self.ids));
                self.engine.load(Some(&journal), now);
                self.next_tick = now + TICK_MS;
            }
            other => panic!("unknown step {other}"),
        }
        self.settle();
        (result, error)
    }
}

/// Two long texts are the same; a failure shows where they part.
#[track_caller]
fn same(ours: &str, theirs: &str, at: &str) {
    if ours == theirs {
        return;
    }
    let parted = ours
        .bytes()
        .zip(theirs.bytes())
        .position(|(ours, theirs)| ours != theirs)
        .unwrap_or(ours.len().min(theirs.len()));
    let near = |text: &str| {
        let from = (0..=parted.saturating_sub(300))
            .rev()
            .find(|at| text.is_char_boundary(*at));
        let to = (parted + 200).min(text.len());
        let to = (to..=text.len()).find(|at| text.is_char_boundary(*at));
        text[from.unwrap_or(0)..to.unwrap_or(text.len())].to_owned()
    };
    panic!("{at}\n  ours: …{}\ntheirs: …{}", near(ours), near(theirs));
}

#[test]
fn does_what_the_typescript_service_did() {
    let scenarios = captured("scenarios");
    assert_eq!(scenarios.len(), 26);
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let mut play = Play::new(scenario["start"].as_i64().unwrap());
        let steps = serde_json::to_string(&scenario["steps"]).unwrap();
        let steps: Value = serde_json::from_str(&steps.replace("<dir>", DIR)).unwrap();
        let mut journals = 0;
        for (index, step) in steps.as_array().unwrap().iter().enumerate() {
            let at = format!("{name}, step {index} {step}");
            let (result, error) = play.step(step, scenario["launches"].as_array().unwrap());
            play.track();
            // In the order the capture named things: a journal a step wrote, then its error, then its state.
            for journal in play.journals.clone().iter().skip(journals) {
                let journal = play.normal(journal);
                same(
                    &journal,
                    scenario["journals"][journals].as_str().unwrap(),
                    &at,
                );
                journals += 1;
            }
            play.rekey();
            let record = &scenario["records"][index];
            if record.is_null() {
                continue;
            }
            let error = error.map(|error| play.normal(&error));
            assert_eq!(error.as_deref(), record["error"].as_str(), "{at}");
            assert_eq!(result.as_ref(), record.get("result"), "{at}");
            let state = play.engine.state().to_string();
            same(&play.normal(&state), &record["state"].to_string(), &at);
            assert_eq!(
                play.launches.len() as u64,
                record["launched"].as_u64().unwrap(),
                "{at}"
            );
            assert_eq!(play.refunds, record["refunds"].as_u64().unwrap(), "{at}");
        }
        let mut ours: Vec<String> = play
            .launches
            .iter()
            .map(|(_, prompt, wake)| {
                serde_json::json!({ "prompt": prompt, "wake": wake }).to_string()
            })
            .collect();
        let theirs = scenario["launches"].as_array().unwrap();
        let mut theirs: Vec<String> = theirs.iter().map(Value::to_string).collect();
        ours.sort();
        theirs.sort();
        assert_eq!(ours, theirs, "{name}");
        assert_eq!(
            journals,
            scenario["journals"].as_array().unwrap().len(),
            "{name}"
        );
    }
}

#[test]
fn reads_a_journal_as_the_typescript_service_did() {
    let loads = captured("loads");
    assert_eq!(loads.len(), 10);
    for load in loads {
        let name = load["name"].as_str().unwrap();
        let mut engine = engine(std::sync::Arc::default());
        let now = load["now"].as_i64().unwrap();
        engine.load(load["text"].as_str(), now);
        same(
            &engine.state().to_string(),
            &load["state"].to_string(),
            name,
        );
        engine.outs.clear();
        engine.close(now);
        let Some(Out::Closed { journal }) = engine.outs.pop() else {
            panic!("{name}: no journal at the close");
        };
        same(&journal, load["journal"].as_str().unwrap(), name);
    }
}

#[test]
fn a_stop_asked_before_main_started_the_run_goes_out_once_it_did() {
    let mut engine = engine(std::sync::Arc::default());
    engine.load(None, 0);
    let draft = serde_json::json!({
        "name": "Tidy", "prompt": "Tidy", "cwd": "/work", "frequency": { "kind": "interval", "minutes": 60 },
        "model": null, "autoApprove": false, "enabled": true,
    });
    let id = engine.create(&draft, None, 0).unwrap();
    let run_now = serde_json::json!({ "action": "runNow", "id": id });
    assert!(matches!(
        engine.command(&run_now, None, 0),
        Ok(Commanded::Done)
    ));
    let run = engine
        .outs
        .iter()
        .find_map(|out| match out {
            Out::Prepare { run, .. } => Some(run.clone()),
            _ => None,
        })
        .unwrap();
    engine.outs.clear();
    engine.prepared(&run, None, 0);
    assert!(matches!(
        engine.outs.as_slice(),
        [Out::Start { wake: false, .. }]
    ));
    engine.outs.clear();
    let stop = serde_json::json!({ "action": "stop", "runId": run });
    assert!(matches!(
        engine.command(&stop, None, 0),
        Ok(Commanded::Done)
    ));
    assert!(
        !engine
            .outs
            .iter()
            .any(|out| matches!(out, Out::Stop { .. }))
    );
    engine.started(&run, 0);
    assert!(
        engine
            .outs
            .iter()
            .any(|out| matches!(out, Out::Stop { .. }))
    );
    // Whatever the run answers, it reads stopped.
    engine.ended(&run, Some(0), None, 5);
    let state = engine.state();
    assert_eq!(state["runs"][0]["status"], "stopped");
    assert_eq!(state["runs"][0]["error"], Value::Null);
}

#[test]
fn a_charge_asked_while_the_schedule_goes_is_given_back() {
    let mut engine = engine(std::sync::Arc::default());
    engine.load(None, 0);
    let draft = serde_json::json!({
        "name": "Tidy", "prompt": "Tidy", "cwd": "/work", "frequency": { "kind": "interval", "minutes": 60 },
        "model": null, "autoApprove": false, "enabled": true,
    });
    let id = engine.create(&draft, Some("dev-a"), 0).unwrap();
    engine.tick(3_600_000);
    let ask = engine
        .outs
        .iter()
        .find_map(|out| match out {
            Out::Reserve { ask, .. } => Some(*ask),
            _ => None,
        })
        .unwrap();
    // The check after it finds the start waiting, and neither asks again nor calls it skipped.
    engine.outs.clear();
    engine.tick(3_630_000);
    assert!(engine.outs.is_empty());
    let delete = serde_json::json!({ "action": "delete", "id": id });
    assert!(matches!(
        engine.command(&delete, None, 3_630_000),
        Ok(Commanded::Done)
    ));
    engine.outs.clear();
    assert!(engine.reserved(ask, None, 3_630_001).is_none());
    assert!(matches!(engine.outs.as_slice(), [Out::Refund { charge }] if *charge == ask));
    assert_eq!(engine.state()["runs"], serde_json::json!([]));
}
