use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const IDLE_MS: f64 = 120_000.0;
pub const MAX_WAIT_MS: f64 = 1_800_000.0;
pub const COUNTDOWN_MS: f64 = 60_000.0;
pub const CARD_HOLD_MS: f64 = 600_000.0;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub enabled: bool,
    pub installable: bool,
    #[serde(default)]
    pub start_failed_before: bool,
    pub resumes: bool,
    pub busy: bool,
    #[serde(default)]
    pub asking: bool,
    #[serde(default)]
    pub plan_waiting: bool,
    #[serde(default)]
    pub compacting: bool,
    pub focused: bool,
    pub idle_ms: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub enum Trigger {
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "user click")]
    UserClick,
    #[serde(rename = "quit")]
    Quit,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Effect {
    Announce {
        #[serde(rename = "restartAt")]
        restart_at: f64,
    },
    Withdraw,
    Install,
    Log {
        event: String,
        details: Value,
    },
}

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub idle_ms: f64,
    pub max_wait_ms: f64,
    pub countdown_ms: f64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            idle_ms: IDLE_MS,
            max_wait_ms: MAX_WAIT_MS,
            countdown_ms: COUNTDOWN_MS,
        }
    }
}

pub struct Scheduler {
    config: Config,
    waiting_since: Option<f64>,
    restart_at: Option<f64>,
    logged_wait: Option<&'static str>,
    installed: bool,
    postponed: bool,
    logged_hold: Option<&'static str>,
    card_since: Option<f64>,
    card_gave_way: bool,
    logged_start_failed: bool,
}

fn log(effects: &mut Vec<Effect>, event: &str, details: Value) {
    effects.push(Effect::Log {
        event: event.to_owned(),
        details,
    });
}

fn wait_reason(f: &Facts) -> &'static str {
    if f.busy {
        if f.asking {
            "open ask"
        } else if f.compacting {
            "compaction"
        } else {
            "busy turn"
        }
    } else {
        "focused+active input"
    }
}

fn unsafe_reason(f: &Facts) -> Option<&'static str> {
    if f.asking {
        Some("open ask")
    } else if f.compacting {
        Some("compaction")
    } else {
        None
    }
}

impl Scheduler {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            waiting_since: None,
            restart_at: None,
            logged_wait: None,
            installed: false,
            postponed: false,
            logged_hold: None,
            card_since: None,
            card_gave_way: false,
            logged_start_failed: false,
        }
    }

    pub fn restart_at(&self) -> Option<f64> {
        self.restart_at
    }

    pub fn tick(&mut self, now: f64, f: &Facts) -> Vec<Effect> {
        let mut effects = Vec::new();
        if !f.enabled || !f.installable {
            self.logged_start_failed = false;
            self.reset(
                if f.enabled {
                    "update not ready"
                } else {
                    "pref off"
                },
                &mut effects,
            );
            return effects;
        }
        if f.start_failed_before {
            let shown = self.restart_at.is_some();
            self.reset("start failed before", &mut effects);
            if !shown && !self.logged_start_failed {
                log(
                    &mut effects,
                    "withdrawn",
                    json!({"reason": "start failed before"}),
                );
            }
            self.logged_start_failed = true;
            return effects;
        }
        self.logged_start_failed = false;
        if self.installed {
            return effects;
        }
        let waited = now - *self.waiting_since.get_or_insert(now);
        if f.asking {
            self.card_since.get_or_insert(now);
        } else {
            self.card_since = None;
            self.card_gave_way = false;
        }
        if let Some(deadline) = self.restart_at {
            if now < deadline {
                return effects;
            }
            if !f.resumes && f.busy {
                self.restart_at = None;
                self.waiting_since = Some(now);
                self.logged_wait = None;
                log(
                    &mut effects,
                    "withdrawn",
                    json!({"reason": "work started, resume off"}),
                );
                effects.push(Effect::Withdraw);
                return effects;
            }
            let hold = if f.resumes { unsafe_reason(f) } else { None };
            if hold == Some("open ask") && self.card_gives_way(f, now, &mut effects) {
                if self.logged_hold.is_some() {
                    self.logged_hold = None;
                    self.announce(now, &mut effects);
                    return effects;
                }
            } else if let Some(reason) = hold {
                if self.logged_hold != Some(reason) {
                    log(&mut effects, "held", json!({"reason": reason}));
                }
                self.logged_hold = Some(reason);
                return effects;
            }
            effects.extend(self.install_started(Trigger::Auto));
            effects.push(Effect::Install);
            return effects;
        }
        if f.resumes && !self.postponed {
            let reason = unsafe_reason(f);
            if let Some(reason) = reason
                && (reason != "open ask" || !self.card_gives_way(f, now, &mut effects))
            {
                if self.logged_wait != Some(reason) {
                    self.logged_wait = Some(reason);
                    log(
                        &mut effects,
                        "waiting",
                        json!({"reason": reason, "waitedMs": waited}),
                    );
                }
                return effects;
            }
            self.logged_wait = None;
            if reason.is_none() {
                log(
                    &mut effects,
                    "safe",
                    json!({"waitedMs": waited, "running": f.busy, "resume": true}),
                );
            }
            self.announce(now, &mut effects);
            return effects;
        }
        let quiet = !f.busy && (!f.focused || f.idle_ms >= self.config.idle_ms);
        let forced = !quiet && f.resumes && waited >= self.config.max_wait_ms;
        if !quiet && !forced {
            let reason = wait_reason(f);
            if self.logged_wait != Some(reason) {
                self.logged_wait = Some(reason);
                log(
                    &mut effects,
                    "waiting",
                    json!({"reason": reason, "waitedMs": waited}),
                );
            }
            return effects;
        }
        self.logged_wait = None;
        if forced {
            log(
                &mut effects,
                "forced",
                json!({"waitedMs": waited, "maxWaitMs": self.config.max_wait_ms, "resume": true, "reason": wait_reason(f)}),
            );
        } else {
            log(
                &mut effects,
                "quiet",
                json!({"waitedMs": waited, "idleMs": f.idle_ms, "focused": f.focused}),
            );
        }
        self.announce(now, &mut effects);
        effects
    }

    pub fn postpone(&mut self, now: f64) -> Vec<Effect> {
        if self.restart_at.is_none() {
            return Vec::new();
        }
        self.restart_at = None;
        self.postponed = true;
        self.logged_hold = None;
        self.waiting_since = Some(now);
        self.logged_wait = None;
        let mut effects = Vec::new();
        log(&mut effects, "postponed", json!({"by": "user"}));
        effects.push(Effect::Withdraw);
        effects
    }

    pub fn install_started(&mut self, trigger: Trigger) -> Vec<Effect> {
        if self.installed {
            return Vec::new();
        }
        self.installed = true;
        self.restart_at = None;
        self.logged_hold = None;
        self.postponed = false;
        let mut effects = Vec::new();
        log(&mut effects, "install", json!({"trigger": trigger}));
        effects
    }

    fn card_gives_way(&mut self, f: &Facts, now: f64, effects: &mut Vec<Effect>) -> bool {
        let held = now - self.card_since.unwrap_or(now);
        let gives =
            !f.plan_waiting && !f.compacting && held >= CARD_HOLD_MS && f.idle_ms >= CARD_HOLD_MS;
        if gives && !self.card_gave_way {
            log(
                effects,
                "unattended",
                json!({"heldMs": held, "idleMs": f.idle_ms}),
            );
        }
        self.card_gave_way = gives;
        gives
    }

    fn announce(&mut self, now: f64, effects: &mut Vec<Effect>) {
        let restart_at = now + self.config.countdown_ms;
        self.restart_at = Some(restart_at);
        log(effects, "countdown", json!({"restartAt": restart_at}));
        effects.push(Effect::Announce { restart_at });
    }

    fn reset(&mut self, reason: &str, effects: &mut Vec<Effect>) {
        self.installed = false;
        self.postponed = false;
        self.logged_hold = None;
        self.logged_wait = None;
        self.waiting_since = None;
        self.card_since = None;
        self.card_gave_way = false;
        if self.restart_at.take().is_some() {
            log(effects, "withdrawn", json!({"reason": reason}));
            effects.push(Effect::Withdraw);
        }
    }
}

#[cfg(test)]
#[path = "scheduler_tests.rs"]
mod tests;
