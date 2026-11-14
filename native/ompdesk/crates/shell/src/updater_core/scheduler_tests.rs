use super::{Config, Effect, Facts, Scheduler, Trigger};
use serde_json::{Value, json};

fn equal_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equal_json(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| equal_json(value, other)))
        }
        _ => a == b,
    }
}

fn facts() -> Facts {
    serde_json::from_value(json!({"enabled": true, "installable": true, "resumes": true, "busy": false, "focused": true, "idleMs": 0})).unwrap()
}

#[test]
fn replay_typescript_scheduler_capture() {
    let steps: Vec<Value> = serde_json::from_str(include_str!("scheduler_captured.json")).unwrap();
    let mut scheduler = Scheduler::new(Config::default());
    for step in steps {
        let effects = match step["action"].as_str().unwrap() {
            "reset" => {
                scheduler = Scheduler::new(Config::default());
                Vec::new()
            }
            "tick" => scheduler.tick(
                step["now"].as_f64().unwrap(),
                &serde_json::from_value(step["facts"].clone()).unwrap(),
            ),
            "postpone" => scheduler.postpone(step["now"].as_f64().unwrap()),
            "installStarted" => {
                scheduler.install_started(serde_json::from_value(step["trigger"].clone()).unwrap())
            }
            action => panic!("unknown action {action}"),
        };
        assert!(
            equal_json(&serde_json::to_value(effects).unwrap(), &step["effects"]),
            "step {step}"
        );
        assert_eq!(
            scheduler.restart_at(),
            step["restartAt"].as_f64(),
            "step {step}"
        );
    }
}

#[test]
fn plan_and_compaction_hold_even_after_unattended_limit() {
    for plan in [false, true] {
        let mut s = Scheduler::new(Config::default());
        let mut f = facts();
        f.asking = true;
        f.plan_waiting = plan;
        f.compacting = !plan;
        f.idle_ms = 10_000_000.0;
        s.tick(0.0, &f);
        let effects = s.tick(10_000_000.0, &f);
        assert!(effects.is_empty());
        assert_eq!(s.restart_at(), None);
    }
}

#[test]
fn resume_off_withdraws_if_work_starts_during_countdown() {
    let mut s = Scheduler::new(Config::default());
    let mut f = facts();
    f.resumes = false;
    f.focused = false;
    s.tick(1.0, &f);
    f.busy = true;
    let effects = s.tick(60_001.0, &f);
    assert_eq!(effects.last(), Some(&Effect::Withdraw));
    assert_eq!(s.restart_at(), None);
    assert!(
        s.tick(10_000_000.0, &f)
            .iter()
            .all(|effect| !matches!(effect, Effect::Install | Effect::Announce { .. }))
    );
}

#[test]
fn install_started_is_idempotent_until_update_is_reset() {
    let mut s = Scheduler::new(Config::default());
    let mut f = facts();
    s.tick(100.0, &f);
    assert_eq!(s.install_started(Trigger::Quit).len(), 1);
    assert!(s.install_started(Trigger::Auto).is_empty());
    assert!(s.tick(100_000.0, &f).is_empty());
    f.installable = false;
    s.tick(100_001.0, &f);
    f.installable = true;
    assert!(
        s.tick(100_002.0, &f)
            .iter()
            .any(|effect| matches!(effect, Effect::Announce { .. }))
    );
}
