//! `routines/triggers.ts` lifecycle. A token belongs to one live source instance, not to its JSON key.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

pub const QUIET_MS: i64 = 3_000;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Token {
    id: String,
    generation: u64,
}

impl Token {
    pub fn id(&self) -> &str {
        &self.id
    }
}

pub(super) struct Start {
    pub token: Token,
    pub schedule: Value,
    pub mark: Option<Value>,
}

pub(super) enum Effect {
    Start(Start),
    Stop(Token),
    RunEnded(Token),
}

struct Live {
    token: Token,
    key: String,
}

pub(super) struct Triggers {
    live: HashMap<String, Live>,
    marks: serde_json::Map<String, Value>,
    running: HashSet<String>,
    ended: HashMap<String, i64>,
    next: u64,
    quiet_ms: i64,
    closed: bool,
}

fn key(schedule: &Value, event: &Value) -> String {
    json!([event, schedule.get("wakeSession").unwrap_or(&Value::Null)]).to_string()
}

impl Triggers {
    pub fn new(stored: Option<&str>, quiet_ms: i64) -> Self {
        let marks = stored
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .and_then(|value| value.get("marks").and_then(Value::as_object).cloned())
            .unwrap_or_default();
        Self {
            live: HashMap::new(),
            marks,
            running: HashSet::new(),
            ended: HashMap::new(),
            next: 0,
            quiet_ms,
            closed: false,
        }
    }

    pub fn sync(&mut self, state: &Value, now: i64) -> Vec<Effect> {
        if self.closed {
            return Vec::new();
        }
        let running: HashSet<String> = state
            .get("runs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|run| run["status"] == "running")
            .filter_map(|run| run["scheduleId"].as_str().map(str::to_owned))
            .collect();
        let ended: Vec<String> = self.running.difference(&running).cloned().collect();
        self.running = running;
        for id in &ended {
            self.ended.insert(id.clone(), now);
        }
        self.ended
            .retain(|_, at| now.saturating_sub(*at) < self.quiet_ms);
        let wanted: HashMap<String, (&Value, String)> = state
            .get("schedules")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|schedule| {
                state["paused"] != true
                    && schedule["enabled"] == true
                    && schedule["frequency"]["kind"] == "event"
                    && schedule["frequency"]["event"]["source"] != "webhook"
            })
            .filter_map(|schedule| {
                let id = schedule["id"].as_str()?;
                let event = &schedule["frequency"]["event"];
                Some((id.to_owned(), (schedule, key(schedule, event))))
            })
            .collect();
        let mut effects = Vec::new();
        self.live.retain(|id, live| {
            if wanted.get(id).is_some_and(|(_, key)| key == &live.key) {
                return true;
            }
            effects.push(Effect::Stop(live.token.clone()));
            self.marks.shift_remove(id);
            false
        });
        self.marks.retain(|id, _| wanted.contains_key(id));
        for (id, (schedule, key)) in wanted {
            if self.live.contains_key(&id) {
                continue;
            }
            // A restored mark for a different trigger cannot become this source's baseline.
            if self
                .marks
                .get(&id)
                .is_some_and(|entry| entry["key"].as_str() != Some(&key))
            {
                self.marks.shift_remove(&id);
            }
            self.next += 1;
            let token = Token {
                id: id.clone(),
                generation: self.next,
            };
            let mark = self
                .marks
                .get(&id)
                .and_then(|entry| entry.get("mark"))
                .cloned();
            self.live.insert(
                id,
                Live {
                    token: token.clone(),
                    key,
                },
            );
            effects.push(Effect::Start(Start {
                token,
                schedule: schedule.clone(),
                mark,
            }));
        }
        for id in ended {
            if let Some(live) = self.live.get(&id) {
                effects.push(Effect::RunEnded(live.token.clone()));
            }
        }
        effects
    }

    pub fn current(&self, token: &Token) -> bool {
        !self.closed
            && self
                .live
                .get(&token.id)
                .is_some_and(|live| live.token == *token)
    }

    pub fn running(&self, token: &Token) -> bool {
        self.current(token) && self.running.contains(&token.id)
    }

    pub fn quiet(&self, token: &Token, now: i64) -> bool {
        !self.current(token)
            || self.running(token)
            || self
                .ended
                .get(&token.id)
                .is_some_and(|at| now < at.saturating_add(self.quiet_ms))
    }

    pub fn save(&mut self, token: &Token, mark: Value) -> bool {
        if !self.current(token) {
            return false;
        }
        let key = &self.live[&token.id].key;
        let entry = json!({"key":key, "mark":mark});
        if self.marks.get(&token.id) == Some(&entry) {
            return false;
        }
        self.marks.insert(token.id.clone(), entry);
        true
    }

    pub fn stored(&self) -> String {
        json!({"version":1,"marks":self.marks}).to_string()
    }

    pub fn close(&mut self) -> Vec<Effect> {
        self.closed = true;
        self.ended.clear();
        self.live
            .drain()
            .map(|(_, live)| Effect::Stop(live.token))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> Value {
        json!({"paused":false,"schedules":[{"id":"a","enabled":true,"frequency":{"kind":"event","event":{"source":"files","path":"/work"}}}],"runs":[]})
    }
    fn first(effects: Vec<Effect>) -> Token {
        effects
            .into_iter()
            .find_map(|effect| match effect {
                Effect::Start(start) => Some(start.token),
                _ => None,
            })
            .unwrap()
    }

    #[test]
    fn stale_results_cannot_fire_or_restore_a_mark_after_pause_and_resume() {
        let mut triggers = Triggers::new(None, QUIET_MS);
        let mut state = state();
        let old = first(triggers.sync(&state, 0));
        triggers.save(&old, json!({"listing":"old"}));
        state["paused"] = true.into();
        assert!(matches!(
            triggers.sync(&state, 1).as_slice(),
            [Effect::Stop(_)]
        ));
        assert_eq!(triggers.stored(), "{\"version\":1,\"marks\":{}}");
        state["paused"] = false.into();
        let new = first(triggers.sync(&state, 2));
        assert_ne!(old, new);
        assert!(!triggers.current(&old));
        assert!(!triggers.save(&old, json!({"late":true})));
        assert!(triggers.current(&new));
        assert!(triggers.save(&new, json!({"fresh":true})));
    }

    #[test]
    fn edit_and_delete_retire_the_exact_instance_and_quit_keeps_its_mark() {
        let mut triggers = Triggers::new(None, QUIET_MS);
        let mut state = state();
        let old = first(triggers.sync(&state, 0));
        triggers.save(&old, json!({"head":"before"}));
        state["schedules"][0]["frequency"]["event"]["path"] = "/other".into();
        let new = first(triggers.sync(&state, 1));
        assert!(!triggers.current(&old));
        triggers.save(&new, json!({"head":"after"}));
        let saved = triggers.stored();
        triggers.close();
        assert_eq!(triggers.stored(), saved);
        assert!(!triggers.current(&new));
        let mut restored = Triggers::new(Some(&saved), QUIET_MS);
        state["schedules"] = json!([]);
        restored.sync(&state, 2);
        assert_eq!(restored.stored(), "{\"version\":1,\"marks\":{}}");
    }

    #[test]
    fn completion_notifies_once_and_quiet_ends_at_the_boundary() {
        let mut triggers = Triggers::new(None, QUIET_MS);
        let mut state = state();
        let token = first(triggers.sync(&state, 0));
        state["runs"] = json!([{"scheduleId":"a","status":"running"}]);
        triggers.sync(&state, 1);
        assert!(triggers.running(&token));
        state["runs"][0]["status"] = "succeeded".into();
        assert!(matches!(
            triggers.sync(&state, 10).as_slice(),
            [Effect::RunEnded(_)]
        ));
        assert!(triggers.sync(&state, 11).is_empty());
        assert!(triggers.quiet(&token, 3009));
        assert!(!triggers.quiet(&token, 3010));
    }
}
