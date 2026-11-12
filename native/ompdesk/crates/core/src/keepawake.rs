//! Keep-awake's policy (native-rust ledger R5; was `src/main/remote/keep-awake.ts`'s `KeepAwakePolicy`): while the
//! option is on and a paired device is connected, or a host tab runs a turn, this computer must not sleep. The
//! blocker is wanted at once and let go after a quiet period, so a device that drops and reconnects does not flap it;
//! turning the option off lets it go immediately. Electron's `powerSaveBlocker` stays in main, which starts one on
//! `held: true` and stops it on `held: false`; this only decides when.
//!
//! One policy per use, each by its number: main's own tabs ("keep awake while working") and the host role's devices.
//! Methods: `keepAwake.open {releaseMs?}` → `{policy}`, `keepAwake.update {policy, enabled, connected, running}` →
//! `{held}` (answered after the events the update caused), `keepAwake.dispose {policy}`. Event: `keepAwake.changed
//! {policy, held, own}` each time `held` flips; `own` is true for the quiet period's release, the one change that
//! comes on the policy's own schedule and not inside an `update` or a `dispose`. The quiet period waits on
//! `crate::clock`, so a test moves it.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::clock;
use crate::server::{Call, Events, Fault, Registry, Reply};

/// What the policy decides from (the same three facts main's `KeepAwakeInput` carried).
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Input {
    /// The option is on (and the host role is running).
    pub enabled: bool,
    /// At least one paired device is connected.
    pub connected: bool,
    /// At least one host tab is running a turn.
    pub running: bool,
}

/// A pending release: which arming of the timer it is, so a timer that already woke when it was cancelled does nothing.
struct Pending {
    generation: u64,
    timer: clock::Timer,
}

struct Policy {
    events: Events,
    release: Duration,
    held: bool,
    timer: Option<Pending>,
}

#[derive(Default)]
struct State {
    last_policy: u64,
    last_generation: u64,
    policies: HashMap<u64, Policy>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(Mutex::default);

fn state() -> MutexGuard<'static, State> {
    STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Serialize)]
struct Changed {
    policy: u64,
    held: bool,
    own: bool,
}

/// Events are sent with the state locked, so two updates' changes reach main in the order they were made.
fn announce(policy: &Policy, id: u64, own: bool) {
    policy.events.send(
        "keepAwake.changed",
        &Changed {
            policy: id,
            held: policy.held,
            own,
        },
    );
}

/// Stops the pending release, if any.
fn cancel(policy: &mut Policy) {
    if let Some(pending) = policy.timer.take() {
        pending.timer.cancel();
    }
}

/// Lets the blocker go now, whatever the state.
fn release_now(policy: &mut Policy, id: u64) {
    cancel(policy);
    if policy.held {
        policy.held = false;
        announce(policy, id, false);
    }
}

/// A new policy, nothing held. `release` is the quiet period.
pub fn open(events: Events, release: Duration) -> u64 {
    let mut state = state();
    state.last_policy += 1;
    let id = state.last_policy;
    state.policies.insert(
        id,
        Policy {
            events,
            release,
            held: false,
            timer: None,
        },
    );
    id
}

/// The update, answering whether the blocker is held after it; None for a policy that is not open.
fn apply(id: u64, input: Input) -> Option<bool> {
    let mut guard = state();
    let State {
        last_generation,
        policies,
        ..
    } = &mut *guard;
    let policy = policies.get_mut(&id)?;
    if input.enabled && (input.connected || input.running) {
        cancel(policy);
        if !policy.held {
            policy.held = true;
            announce(policy, id, false);
        }
    } else if !input.enabled {
        release_now(policy, id);
    } else if policy.held && policy.timer.is_none() {
        *last_generation += 1;
        let generation = *last_generation;
        // On a manual clock the callback runs inside `clock.advance`, so the change it sends reaches main before
        // the advance is answered, as the fake timer's callback ran inside `advanceTimersByTime`.
        policy.timer = Some(Pending {
            generation,
            timer: clock::after(policy.release, move || expire(id, generation)),
        });
    }
    Some(policy.held)
}

/// The quiet period ended: the blocker goes, on the policy's own schedule.
fn expire(id: u64, generation: u64) {
    let mut state = state();
    let Some(policy) = state.policies.get_mut(&id) else {
        return;
    };
    if policy.timer.as_ref().map(|pending| pending.generation) != Some(generation) {
        return;
    }
    policy.timer = None;
    policy.held = false;
    announce(policy, id, true);
}

/// Feeds the policy; the changes it causes are sent before this returns. A policy that is not open ignores it.
pub fn update(policy: u64, input: Input) {
    let _ = apply(policy, input);
}

/// Whether the blocker is held now: in use, or within the quiet period after.
pub fn held(policy: u64) -> bool {
    state()
        .policies
        .get(&policy)
        .is_some_and(|policy| policy.held)
}

/// Lets go now and forgets the policy (a quit, or the host role stopping).
pub fn dispose(policy: u64) {
    let mut state = state();
    if let Some(mut gone) = state.policies.remove(&policy) {
        release_now(&mut gone, policy);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenParams {
    release_ms: Option<u64>,
}

#[derive(Deserialize)]
struct UpdateParams {
    policy: u64,
    #[serde(flatten)]
    input: Input,
}

#[derive(Deserialize)]
struct PolicyParams {
    policy: u64,
}

pub fn register(registry: &mut Registry) {
    registry.add("keepAwake.open", |call| Box::pin(open_call(call)));
    registry.add("keepAwake.update", |call| Box::pin(update_call(call)));
    registry.add("keepAwake.dispose", |call| Box::pin(dispose_call(call)));
}

/// The quiet period main gave when it did not name one: a minute, as `KEEP_AWAKE_RELEASE_MS` was.
const DEFAULT_RELEASE: Duration = Duration::from_secs(60);

async fn open_call(call: Call) -> Result<Reply, Fault> {
    let params: OpenParams = call.params()?;
    let release = params
        .release_ms
        .map_or(DEFAULT_RELEASE, Duration::from_millis);
    Reply::json(&serde_json::json!({"policy": open(call.events.clone(), release)}))
}

async fn update_call(call: Call) -> Result<Reply, Fault> {
    let params: UpdateParams = call.params()?;
    match apply(params.policy, params.input) {
        Some(held) => Reply::json(&serde_json::json!({"held": held})),
        None => Err(unknown(params.policy)),
    }
}

/// Disposing a policy twice is fine (a quit races the core's own end).
async fn dispose_call(call: Call) -> Result<Reply, Fault> {
    let params: PolicyParams = call.params()?;
    dispose(params.policy);
    Reply::json(&())
}

fn unknown(policy: u64) -> Fault {
    Fault::new(
        "unknown_policy",
        format!("keep-awake policy {policy} is not open"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::Frame;
    use serde_json::Value;
    use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

    /// What the TypeScript policy did on `keepawake-captured.json`'s sequences: the blocker it started and stopped
    /// and the `onChange` calls it made, after each step.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        release_ms: u64,
        steps: Vec<Step>,
        after: Vec<After>,
        disposed: Disposed,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    enum Step {
        Update(Input),
        Advance(u64),
    }

    #[derive(Deserialize, Debug, PartialEq)]
    struct After {
        held: bool,
        started: usize,
        stopped: Vec<u32>,
        changes: usize,
    }

    #[derive(Deserialize, Debug, PartialEq)]
    struct Disposed {
        held: bool,
        stopped: Vec<u32>,
    }

    /// Main's side: starts a blocker on `held: true`, stops it on `held: false`, calls `onChange` for an own release.
    #[derive(Default)]
    struct Main {
        next: u32,
        id: Option<u32>,
        started: usize,
        stopped: Vec<u32>,
        changes: usize,
    }

    impl Main {
        fn hear(&mut self, frames: &mut UnboundedReceiver<Frame>, policy: u64) {
            while let Ok(frame) = frames.try_recv() {
                let (head, _) = frame.parts();
                let head: Value = serde_json::from_slice(head).unwrap();
                assert_eq!(head["event"], "keepAwake.changed");
                assert_eq!(head["data"]["policy"], policy);
                if head["data"]["held"] == true {
                    assert!(self.id.is_none(), "held twice in a row");
                    self.next += 1;
                    self.id = Some(self.next);
                    self.started += 1;
                } else {
                    self.stopped
                        .push(self.id.take().expect("released while not held"));
                    if head["data"]["own"] == true {
                        self.changes += 1;
                    }
                }
            }
        }

        fn after(&self) -> After {
            After {
                held: self.id.is_some(),
                started: self.started,
                stopped: self.stopped.clone(),
                changes: self.changes,
            }
        }
    }

    fn open_captured(release_ms: u64) -> (u64, UnboundedReceiver<Frame>, UnboundedSender<Frame>) {
        let (events, keep, frames) = Events::capture();
        let policy = open(events, Duration::from_millis(release_ms));
        (policy, frames, keep)
    }

    fn input(enabled: bool, connected: bool, running: bool) -> Input {
        Input {
            enabled,
            connected,
            running,
        }
    }

    #[tokio::test]
    async fn every_captured_sequence_does_what_the_typescript_policy_did() {
        let _serial = clock::TEST_CLOCK.lock().await;
        let rows: Vec<Row> = serde_json::from_str(include_str!("keepawake-captured.json")).unwrap();
        assert_eq!(rows.len(), 247);
        for (number, row) in rows.iter().enumerate() {
            clock::set_manual(1_700_000_000_000);
            let (policy, mut frames, _keep) = open_captured(row.release_ms);
            let mut main = Main::default();
            for (index, (step, want)) in row.steps.iter().zip(&row.after).enumerate() {
                match step {
                    Step::Update(next) => update(policy, *next),
                    Step::Advance(ms) => clock::advance(*ms).await,
                }
                main.hear(&mut frames, policy);
                assert_eq!(&main.after(), want, "row {number}, after step {index}");
                assert_eq!(held(policy), want.held, "row {number}");
            }
            dispose(policy);
            main.hear(&mut frames, policy);
            assert_eq!(
                Disposed {
                    held: main.id.is_some(),
                    stopped: main.stopped.clone(),
                },
                row.disposed,
                "row {number}, disposed"
            );
            assert!(!held(policy));
            clock::set_real();
        }
    }

    #[tokio::test]
    async fn an_update_sends_its_change_before_it_returns_and_only_the_quiet_release_is_own() {
        let _serial = clock::TEST_CLOCK.lock().await;
        clock::set_manual(0);
        let (policy, mut frames, _keep) = open_captured(60_000);
        let seen = |frames: &mut UnboundedReceiver<Frame>| -> Vec<Value> {
            let mut all = Vec::new();
            while let Ok(frame) = frames.try_recv() {
                let (head, _) = frame.parts();
                all.push(serde_json::from_slice::<Value>(head).unwrap()["data"].take());
            }
            all
        };

        update(policy, input(true, true, false));
        assert_eq!(
            seen(&mut frames),
            vec![serde_json::json!({"policy": policy, "held": true, "own": false})]
        );
        // Still in use: nothing changes, nothing is sent.
        update(policy, input(true, true, true));
        assert!(seen(&mut frames).is_empty());

        update(policy, input(true, false, false));
        assert!(held(policy));
        clock::advance(59_999).await;
        assert!(seen(&mut frames).is_empty());
        clock::advance(1).await;
        assert_eq!(
            seen(&mut frames),
            vec![serde_json::json!({"policy": policy, "held": false, "own": true})]
        );
        assert!(!held(policy));

        update(policy, input(true, true, false));
        update(policy, input(false, true, false));
        assert_eq!(
            seen(&mut frames),
            vec![
                serde_json::json!({"policy": policy, "held": true, "own": false}),
                serde_json::json!({"policy": policy, "held": false, "own": false}),
            ]
        );
        dispose(policy);
        clock::set_real();
    }

    #[tokio::test]
    async fn a_disposed_policy_lets_go_once_and_is_forgotten() {
        let _serial = clock::TEST_CLOCK.lock().await;
        clock::set_manual(0);
        let (policy, mut frames, _keep) = open_captured(1_000);
        update(policy, input(true, false, true));
        update(policy, input(true, false, false));
        dispose(policy);
        dispose(policy);
        // The timer it had is cancelled: the clock passing the period sends nothing more.
        clock::advance(5_000).await;
        let mut main = Main::default();
        main.hear(&mut frames, policy);
        assert_eq!(
            (main.started, main.stopped.clone(), main.changes),
            (1, vec![1], 0)
        );
        assert_eq!(apply(policy, input(true, true, true)), None);
        assert!(!held(policy));
        clock::set_real();
    }

    #[test]
    fn the_methods_read_their_params_as_main_sends_them() {
        let params: UpdateParams =
            serde_json::from_str(r#"{"policy":3,"enabled":true,"connected":false,"running":true}"#)
                .unwrap();
        assert_eq!(params.policy, 3);
        assert!(params.input.enabled && !params.input.connected && params.input.running);
        let open: OpenParams = serde_json::from_str("{}").unwrap();
        assert_eq!(open.release_ms, None);
        let open: OpenParams = serde_json::from_str(r#"{"releaseMs":1000}"#).unwrap();
        assert_eq!(open.release_ms, Some(1000));
    }
}
