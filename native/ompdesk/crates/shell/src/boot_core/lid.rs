//! Closing the lid of a laptop that is charging must not stop OMPdesk's running work; on battery the OS keeps its own
//! behaviour (interrupted-work › Keep awake, lid closed while charging). The idle-sleep blocker a keep-awake holds
//! (`power.rs`, `prevent-app-suspension`) is ignored by a lid close, so whenever one is held this policy also holds a
//! platform [`Backend`] while the computer is a laptop on AC power. macOS and Windows differ only in the backend
//! (`modules/boot/lid.rs`, [`super::powercfg`]); every rule is here. Was `src/main/power/lid-awake.ts`.

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

/// What a hold changed: `changed` false when the person's own setting already keeps the work running.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub changed: bool,
    pub details: Map<String, Value>,
}

/// A platform's way to keep a closed lid from sleeping. Every call may block (it runs processes); the policy runs on a
/// thread of its own.
pub trait Backend {
    /// What holds the lid, for the log (`caffeinate`, `powercfg`).
    fn name(&self) -> &'static str;
    /// A computer with a lid to close: it has a battery. Asked once, when first needed.
    fn is_laptop(&mut self) -> Result<bool, String>;
    /// Undo what an earlier process left held (it crashed or was killed). Runs before the first hold.
    fn recover(&mut self) -> Result<Option<Map<String, Value>>, String>;
    fn hold(&mut self) -> Result<Outcome, String>;
    fn release(&mut self) -> Result<(), String>;
    /// Release at once (quit: the process may end right after).
    fn release_now(&mut self) -> Result<(), String>;
}

/// Why the lid hold changed, for the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Work,
    Charging,
    WorkEnded,
    OnBattery,
    Quit,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Work => "work",
            Reason::Charging => "charging",
            Reason::WorkEnded => "work-ended",
            Reason::OnBattery => "on-battery",
            Reason::Quit => "quit",
        }
    }
}

/// One `gui-runtime.jsonl` line (source `keep-awake`): `held`, `released`, `recovered`, `skipped` or `failed`.
pub type Log<'a> = &'a mut dyn FnMut(&'static str, Value);

fn details(pairs: Value, extra: Option<&Map<String, Value>>) -> Value {
    let mut map = match pairs {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    if let Some(extra) = extra {
        for (key, value) in extra {
            map.insert(key.clone(), value.clone());
        }
    }
    Value::Object(map)
}

/// The policy's state. Inputs (`set_blocker`, `set_on_ac`) say whether the backend needs to move; `converge` moves
/// it one step at a time until it matches the inputs, reading inputs that arrive meanwhile through `poll`.
#[derive(Debug)]
pub struct Policy {
    blockers: BTreeSet<String>,
    on_ac: bool,
    applied: bool,
    cause: Reason,
    laptop: Option<bool>,
    recovered: bool,
    disposed: bool,
    /// Dispose arrived inside `converge`; its release runs when the step under way ended.
    release_pending: bool,
}

/// An input the policy's thread receives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Input {
    Blocker { key: String, held: bool },
    OnAc(bool),
    Dispose,
}

impl Policy {
    pub fn new(on_ac: bool) -> Policy {
        Policy {
            blockers: BTreeSet::new(),
            on_ac,
            applied: false,
            cause: Reason::Work,
            laptop: None,
            recovered: false,
            disposed: false,
            release_pending: false,
        }
    }

    /// The lid hold is in place now.
    pub fn held(&self) -> bool {
        self.applied
    }

    pub fn disposed(&self) -> bool {
        self.disposed
    }

    /// Applies one input; true when the backend may have to move (`converge`). `Dispose` is not an input here: it
    /// releases at once (`dispose`).
    pub fn apply(&mut self, input: Input) -> bool {
        match input {
            Input::Blocker { key, held } => {
                let before = !self.blockers.is_empty();
                if held {
                    self.blockers.insert(key);
                } else {
                    self.blockers.remove(&key);
                }
                let after = !self.blockers.is_empty();
                if before == after {
                    return false;
                }
                self.cause = if after {
                    Reason::Work
                } else {
                    Reason::WorkEnded
                };
                !self.disposed
            }
            Input::OnAc(on_ac) => {
                if on_ac == self.on_ac {
                    return false;
                }
                self.on_ac = on_ac;
                self.cause = if on_ac {
                    Reason::Charging
                } else {
                    Reason::OnBattery
                };
                !self.disposed
            }
            Input::Dispose => {
                if !self.disposed {
                    self.disposed = true;
                    self.release_pending = true;
                }
                false
            }
        }
    }

    /// Undo a hold a crashed process left (Windows: its lid setting). Once; every hold waits for it.
    pub fn start(&mut self, backend: &mut dyn Backend, log: Log) {
        if self.recovered {
            return;
        }
        self.recovered = true;
        match backend.recover() {
            Ok(Some(found)) => log(
                "recovered",
                details(json!({ "backend": backend.name() }), Some(&found)),
            ),
            Ok(None) => {}
            Err(error) => log(
                "failed",
                json!({ "step": "recover", "backend": backend.name(), "error": error }),
            ),
        }
    }

    /// Moves the backend toward the inputs until they agree. `poll` hands over inputs that arrived meanwhile; it runs
    /// after each backend call. A failure is logged and ends the run: the next change of an input tries again.
    pub fn converge(
        &mut self,
        backend: &mut dyn Backend,
        log: Log,
        poll: &mut dyn FnMut(&mut Policy),
    ) {
        self.start(backend, log);
        poll(self);
        while !self.disposed {
            let mut want = !self.blockers.is_empty() && self.on_ac;
            if want {
                want = self.is_laptop(backend, log);
                poll(self);
            }
            if self.disposed || want == self.applied {
                return;
            }
            let reason = self.cause;
            if want {
                let held = backend.hold();
                poll(self);
                match held {
                    Ok(outcome) => {
                        self.applied = true;
                        if self.disposed {
                            self.release_pending = false;
                            self.release_now(backend, log, Reason::Quit);
                            return;
                        }
                        log(
                            "held",
                            details(
                                json!({ "reason": reason.as_str(), "backend": backend.name(), "changed": outcome.changed }),
                                Some(&outcome.details),
                            ),
                        );
                    }
                    Err(error) => {
                        log(
                            "failed",
                            json!({ "step": "hold", "reason": reason.as_str(), "backend": backend.name(), "error": error }),
                        );
                        return;
                    }
                }
            } else {
                let released = backend.release();
                poll(self);
                match released {
                    Ok(()) => {
                        self.applied = false;
                        log(
                            "released",
                            json!({ "reason": reason.as_str(), "backend": backend.name() }),
                        );
                    }
                    Err(error) => {
                        log(
                            "failed",
                            json!({ "step": "release", "reason": reason.as_str(), "backend": backend.name(), "error": error }),
                        );
                        return;
                    }
                }
            }
        }
    }

    /// Quit: release at once, whatever runs (also what a failed hold or release left behind). A dispose that arrived
    /// inside `converge` is finished here.
    pub fn dispose(&mut self, backend: &mut dyn Backend, log: Log) {
        if self.disposed && !self.release_pending {
            return;
        }
        self.disposed = true;
        self.release_pending = false;
        self.release_now(backend, log, Reason::Quit);
    }

    fn is_laptop(&mut self, backend: &mut dyn Backend, log: Log) -> bool {
        if let Some(laptop) = self.laptop {
            return laptop;
        }
        let laptop = match backend.is_laptop() {
            Ok(laptop) => {
                if !laptop {
                    log(
                        "skipped",
                        json!({ "reason": "no battery", "backend": backend.name() }),
                    );
                }
                laptop
            }
            Err(error) => {
                log(
                    "failed",
                    json!({ "step": "battery", "backend": backend.name(), "error": error }),
                );
                false
            }
        };
        self.laptop = Some(laptop);
        laptop
    }

    fn release_now(&mut self, backend: &mut dyn Backend, log: Log, reason: Reason) {
        let applied = self.applied;
        self.applied = false;
        match backend.release_now() {
            Ok(()) => {
                if applied {
                    log(
                        "released",
                        json!({ "reason": reason.as_str(), "backend": backend.name() }),
                    );
                }
            }
            Err(error) => log(
                "failed",
                json!({ "step": "release", "reason": reason.as_str(), "backend": backend.name(), "error": error }),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The capture's fake backend (`scripts/shell-port/capture-boot.ts` `runLid`, in commit d8898998c).
    struct Fake {
        laptop: bool,
        hold_fails: bool,
        release_fails: i64,
        calls: Vec<String>,
    }

    impl Backend for Fake {
        fn name(&self) -> &'static str {
            "fake"
        }
        fn is_laptop(&mut self) -> Result<bool, String> {
            self.calls.push("isLaptop".into());
            Ok(self.laptop)
        }
        fn recover(&mut self) -> Result<Option<Map<String, Value>>, String> {
            self.calls.push("recover".into());
            Ok(None)
        }
        fn hold(&mut self) -> Result<Outcome, String> {
            self.calls.push("hold".into());
            if self.hold_fails {
                return Err("hold failed".into());
            }
            let mut details = Map::new();
            details.insert("scheme".into(), json!("s"));
            Ok(Outcome {
                changed: true,
                details,
            })
        }
        fn release(&mut self) -> Result<(), String> {
            self.calls.push("release".into());
            self.release_fails -= 1;
            if self.release_fails >= 0 {
                return Err("release failed".into());
            }
            Ok(())
        }
        fn release_now(&mut self) -> Result<(), String> {
            self.calls.push("releaseNow".into());
            Ok(())
        }
    }

    #[test]
    fn replays_the_lid_policy_as_captured() {
        let captured: Value = serde_json::from_str(include_str!("captured.json")).unwrap();
        let scenarios = captured["lid"].as_array().unwrap();
        assert_eq!(scenarios.len(), 13);
        for scenario in scenarios {
            let name = scenario["name"].as_str().unwrap();
            let options = &scenario["options"];
            let mut backend = Fake {
                laptop: options["laptop"].as_bool().unwrap_or(true),
                hold_fails: options["holdFails"].as_bool().unwrap_or(false),
                release_fails: options["releaseFails"].as_i64().unwrap_or(0),
                calls: Vec::new(),
            };
            let mut policy = Policy::new(options["onAc"].as_bool().unwrap_or(true));
            let logs = std::cell::RefCell::new(Vec::<Value>::new());
            let mut log = |message: &'static str, details: Value| {
                logs.borrow_mut()
                    .push(json!({ "message": message, "details": details }));
            };
            let mut started: Vec<String> = Vec::new();
            let mut after = Vec::new();
            for step in scenario["steps"].as_array().unwrap() {
                let step = step.as_str().unwrap();
                let input = match step {
                    "work" | "host" => {
                        let key = format!("{step}:{}", started.len() + 1);
                        started.push(key.clone());
                        Some(Input::Blocker { key, held: true })
                    }
                    "ac:on" => Some(Input::OnAc(true)),
                    "ac:off" => Some(Input::OnAc(false)),
                    "dispose" => None,
                    stop => {
                        let n: usize = stop.strip_prefix("stop:").unwrap().parse().unwrap();
                        let key = started
                            .get(n - 1)
                            .cloned()
                            .unwrap_or_else(|| format!("work:{}", 1000 + n));
                        Some(Input::Blocker { key, held: false })
                    }
                };
                match input {
                    Some(input) => {
                        if policy.apply(input) {
                            policy.converge(&mut backend, &mut log, &mut |_| {});
                        }
                    }
                    None => policy.dispose(&mut backend, &mut log),
                }
                after.push(json!({ "step": step, "held": policy.held(), "calls": backend.calls.len(), "logs": logs.borrow().len() }));
            }
            assert_eq!(json!(backend.calls), scenario["calls"], "{name}: calls");
            assert_eq!(json!(logs.into_inner()), scenario["logs"], "{name}: logs");
            assert_eq!(json!(after), scenario["after"], "{name}: after each step");
        }
    }

    #[test]
    fn a_dispose_that_arrives_during_a_hold_releases_once_the_hold_landed() {
        let mut backend = Fake {
            laptop: true,
            hold_fails: false,
            release_fails: 0,
            calls: Vec::new(),
        };
        let mut policy = Policy::new(true);
        let mut lines = Vec::new();
        let mut log = |message: &'static str, _: Value| lines.push(message);
        policy.apply(Input::Blocker {
            key: "work:1".into(),
            held: true,
        });
        let mut polled = 0;
        policy.converge(&mut backend, &mut log, &mut |p| {
            polled += 1;
            if polled == 3 {
                p.apply(Input::Dispose);
            }
        });
        policy.dispose(&mut backend, &mut log);
        assert!(!policy.held());
        assert_eq!(backend.calls, ["recover", "isLaptop", "hold", "releaseNow"]);
        assert_eq!(lines, ["released"]);
    }
}
