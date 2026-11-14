//! One desktop arbiter per computer. Root supplies authenticated local execution captures;
//! neither a page-supplied tab name nor a replacement process can authorize cleanup.

mod policy;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ompdesk_app_contract::Owner;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::Instant;

use crate::pool::application::Sidecar;
use crate::server::{Fault, Scope};
use crate::sidecar::application::EffectFuture;
use crate::sidecar::native::Service as NativeSidecar;
use policy::{Attempt, Effect, Lease, Policy, Reason};

pub use policy::Timing;

pub struct Config {
    pub timing: Timing,
    pub grant_timeout: Duration,
    pub revoke_command_timeout: Duration,
    pub kill_confirm: Duration,
    pub now_ms: fn() -> i64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            timing: Timing::default(),
            grant_timeout: Duration::from_secs(10),
            revoke_command_timeout: Duration::from_secs(15),
            kill_confirm: Duration::from_secs(5),
            now_ms: || {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
                    .unwrap_or(0)
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub tab_id: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Holder {
    #[serde(flatten)]
    pub session: Session,
    pub since: i64,
    #[serde(skip_serializing_if = "is_false")]
    pub revoke_failed: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct State {
    pub holder: Option<Holder>,
    pub queue: Vec<Session>,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
pub enum Frame {
    #[serde(rename = "desktop_slot_acquire")]
    Acquire {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    #[serde(rename = "desktop_slot_touch")]
    Touch,
    #[serde(rename = "desktop_slot_release")]
    Release,
}
pub struct Acquired {
    pub owner: Owner,
    pub tab: String,
    pub title: String,
    pub source: Arc<NativeSidecar>,
    pub generation: u64,
    pub exited: EffectFuture<'static, Result<(), Fault>>,
}

struct Execution {
    slot: Arc<()>,
    owner: Owner,
    tab: String,
    title: Mutex<String>,
    source: Arc<NativeSidecar>,
    generation: u64,
    retired: AtomicBool,
    exited: Mutex<Option<EffectFuture<'static, Result<(), Fault>>>>,
}

/// Not Deserialize. Only Root's actual local-sidecar admission constructs this capability.
#[derive(Clone)]
pub struct Capture(Arc<Execution>);

impl PartialEq for Capture {
    fn eq(&self, other: &Self) -> bool {
        self.0.owner == other.0.owner
            && self.0.tab == other.0.tab
            && self.0.generation == other.0.generation
            && Arc::ptr_eq(&self.0.source, &other.0.source)
            && Arc::ptr_eq(&self.0.slot, &other.0.slot)
    }
}

impl Eq for Capture {}

impl Capture {
    pub fn owner(&self) -> &Owner {
        &self.0.owner
    }
    pub fn tab(&self) -> &str {
        &self.0.tab
    }
    pub fn source(&self) -> &Arc<NativeSidecar> {
        &self.0.source
    }
    pub fn generation(&self) -> u64 {
        self.0.generation
    }
    fn session(&self) -> Session {
        Session {
            tab_id: self.0.tab.clone(),
            title: locked(&self.0.title).clone(),
        }
    }
}

enum Event {
    Frame(Capture, Frame),
    Depart(Capture, Reason, oneshot::Sender<()>),
    Retry,
    Inspect(oneshot::Sender<Option<Capture>>),
    Kill(Capture, oneshot::Sender<bool>),
    Rename(Capture, String),
}

enum Completed {
    Grant,
    Revoke(Arc<Attempt<Capture>>, bool),
    Exited(Capture, Result<(), Fault>),
    Killed(Arc<Lease<Capture>>, bool, oneshot::Sender<bool>),
    WaiterStopped,
}

pub struct Service {
    slot: Arc<()>,
    events: mpsc::UnboundedSender<Event>,
    state: watch::Sender<State>,
    stop: Scope,
    worker: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn closed() -> Fault {
    Fault::new("desktop_slot_closed", "The desktop slot service has closed")
}

impl Service {
    pub fn new(config: Config) -> Self {
        let (events, incoming) = mpsc::unbounded_channel();
        let (state, _) = watch::channel(State::default());
        let stop = Scope::detached();
        let worker = tokio::spawn(drive(config, incoming, state.clone(), stop.clone()));
        Self {
            slot: Arc::new(()),
            events,
            state,
            stop,
            worker: tokio::sync::Mutex::new(Some(worker)),
        }
    }

    /// Root captures the receipt for this exact generation before release/dispose forgets it.
    pub fn capture(&self, acquired: Acquired) -> Capture {
        Capture(Arc::new(Execution {
            slot: Arc::clone(&self.slot),
            owner: acquired.owner,
            tab: acquired.tab,
            title: Mutex::new(acquired.title),
            source: acquired.source,
            generation: acquired.generation,
            retired: AtomicBool::new(false),
            exited: Mutex::new(Some(acquired.exited)),
        }))
    }

    fn admit(&self, capture: &Capture) -> Result<(), Fault> {
        if self.stop.cancelled() || !Arc::ptr_eq(&self.slot, &capture.0.slot) {
            return Err(closed());
        }
        Ok(())
    }

    pub fn frame(&self, capture: &Capture, frame: Frame) -> Result<(), Fault> {
        self.admit(capture)?;
        if matches!(&frame, Frame::Acquire { .. })
            && (capture.0.retired.load(Ordering::Acquire)
                || capture.0.source.generation() != capture.0.generation)
        {
            return Err(Fault::new(
                "desktop_slot_stale",
                "The requesting execution is no longer current",
            ));
        }
        self.events
            .send(Event::Frame(capture.clone(), frame))
            .map_err(|_| closed())
    }

    pub fn rename(&self, capture: &Capture, title: String) -> Result<(), Fault> {
        self.admit(capture)?;
        self.events
            .send(Event::Rename(capture.clone(), title))
            .map_err(|_| closed())
    }

    pub fn state(&self) -> State {
        self.state.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<State> {
        self.state.subscribe()
    }

    pub async fn holder(&self) -> Result<Option<Capture>, Fault> {
        let (reply, answer) = oneshot::channel();
        self.events
            .send(Event::Inspect(reply))
            .map_err(|_| closed())?;
        answer.await.map_err(|_| closed())
    }

    pub async fn stop(&self, capture: &Capture) -> Result<(), Fault> {
        self.depart(capture, Reason::Stop).await
    }

    pub async fn released(&self, capture: &Capture) -> Result<(), Fault> {
        self.depart(capture, Reason::Closed).await
    }

    async fn depart(&self, capture: &Capture, reason: Reason) -> Result<(), Fault> {
        self.admit(capture)?;
        let (reply, answer) = oneshot::channel();
        self.events
            .send(Event::Depart(capture.clone(), reason, reply))
            .map_err(|_| closed())?;
        answer.await.map_err(|_| closed())
    }

    pub fn retry(&self) -> Result<(), Fault> {
        if self.stop.cancelled() {
            return Err(closed());
        }
        self.events.send(Event::Retry).map_err(|_| closed())
    }

    /// Root notes stopped and logs the stop under this same capture before calling stop/kill.
    pub async fn kill(&self, capture: &Capture) -> Result<bool, Fault> {
        self.admit(capture)?;
        let (reply, answer) = oneshot::channel();
        self.events
            .send(Event::Kill(capture.clone(), reply))
            .map_err(|_| closed())?;
        answer.await.map_err(|_| closed())
    }

    pub async fn close(&self) -> Result<(), Fault> {
        self.stop.cancel();
        let mut worker = self.worker.lock().await;
        if let Some(task) = worker.as_mut() {
            let result = task.await;
            worker.take();
            result.map_err(|error| Fault::new("desktop_slot_join", error.to_string()))?;
        }
        Ok(())
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

fn snapshot(policy: &Policy<Capture>) -> State {
    State {
        holder: policy.holder().map(|lease| Holder {
            session: lease.target.session(),
            since: lease.since,
            revoke_failed: policy.failed(),
        }),
        queue: policy.queue().map(Capture::session).collect(),
    }
}

fn now(origin: Instant) -> u64 {
    origin.elapsed().as_millis().min(u64::MAX as u128) as u64
}

async fn drive(
    config: Config,
    mut incoming: mpsc::UnboundedReceiver<Event>,
    state: watch::Sender<State>,
    stop: Scope,
) {
    let origin = Instant::now();
    let mut policy = Policy::new(config.timing);
    let mut tasks = JoinSet::new();
    let mut effects = Vec::with_capacity(4);
    let mut waiting: Vec<(Arc<Lease<Capture>>, oneshot::Sender<()>)> = Vec::new();
    let mut waiting_revokes: Vec<(Capture, oneshot::Sender<()>)> = Vec::new();
    loop {
        let deadline = policy.deadline();
        let changed = tokio::select! {
            biased;
            _ = stop.on_cancel() => break,
            _ = async {
                match deadline {
                    Some(at) => tokio::time::sleep_until(origin + Duration::from_millis(at)).await,
                    None => std::future::pending().await,
                }
            } => policy.tick(now(origin), &mut effects),
            completed = tasks.join_next(), if !tasks.is_empty() => {
                let now = now(origin);
                match completed {
                    Some(Ok(Completed::Revoke(attempt, confirmed))) => {
                        policy.answered(&attempt, confirmed, now, (config.now_ms)(), &mut effects)
                    }
                    Some(Ok(Completed::Exited(capture, Ok(())))) => {
                        policy.exited(&capture, now, (config.now_ms)(), &mut effects)
                    }
                    Some(Ok(Completed::Exited(_, Err(_)))) => {
                        eprintln!("desktop-slot: process exit was not confirmed; retaining its slot responsibility");
                        false
                    }
                    Some(Ok(Completed::Killed(lease, confirmed, reply))) => {
                        let changed = confirmed && policy.confirmed(&lease, now, (config.now_ms)(), &mut effects);
                        let _ = reply.send(confirmed);
                        changed
                    }
                    Some(Ok(Completed::Grant | Completed::WaiterStopped)) | None => false,
                    Some(Err(error)) => {
                        eprintln!("desktop-slot: effect did not complete; retaining slot responsibility: {error}");
                        false
                    }
                }
            }
            event = incoming.recv() => {
                let Some(event) = event else { break };
                let now = now(origin);
                match event {
                    Event::Frame(capture, Frame::Acquire { request_id }) => {
                        if capture.0.retired.load(Ordering::Acquire)
                            || capture.0.source.generation() != capture.0.generation
                        {
                            continue;
                        }
                        if !policy.contains(&capture)
                            && let Some(exited) = locked(&capture.0.exited).take()
                        {
                            let target = capture.clone();
                            tasks.spawn(async move { Completed::Exited(target, exited.await) });
                        }
                        policy.acquire(capture, request_id, now, (config.now_ms)(), &mut effects)
                    }
                    Event::Frame(capture, Frame::Touch) => {
                        policy.touch(&capture, now);
                        false
                    }
                    Event::Frame(capture, Frame::Release) => {
                        policy.release(&capture, now, (config.now_ms)(), &mut effects)
                    }
                    Event::Depart(capture, reason, reply) => {
                        let held = policy.holder().filter(|lease| lease.target == capture).cloned();
                        let queued = policy.contains(&capture);
                        if reason == Reason::Closed {
                            capture.0.retired.store(true, Ordering::Release);
                        }
                        if reason == Reason::Stop && queued {
                            let abort = capture.0.source.stock_for_generation(
                                capture.0.generation, json!({"type": "abort"}), None,
                            );
                            tasks.spawn(async move { let _ = abort.await; Completed::Grant });
                        }
                        let changed = policy.depart(&capture, reason, now, &mut effects);
                        if let Some(lease) = held {
                            waiting.push((lease, reply));
                        } else if queued && reason == Reason::Stop {
                            waiting_revokes.push((capture, reply));
                        } else {
                            let _ = reply.send(());
                        }
                        changed
                    }
                    Event::Retry => { policy.retry(now, &mut effects); false }
                    Event::Inspect(reply) => {
                        let _ = reply.send(policy.holder().map(|lease| lease.target.clone()));
                        false
                    }
                    Event::Rename(capture, title) => {
                        *locked(&capture.0.title) = title;
                        policy.contains(&capture)
                    }
                    Event::Kill(capture, reply) => {
                        if let Some(lease) = policy.holder().filter(|lease| lease.target == capture).cloned() {
                            let timeout = config.kill_confirm;
                            let abort = capture.0.source.stock_for_generation(
                                capture.0.generation, json!({"type": "abort"}), None,
                            );
                            tasks.spawn(async move { let _ = abort.await; Completed::Grant });
                            let restarted = capture.0.source.restart_for_generation(capture.0.generation);
                            tasks.spawn(async move {
                                let confirmed = matches!(tokio::time::timeout(timeout, restarted).await, Ok(Ok(())));
                                Completed::Killed(lease, confirmed, reply)
                            });
                        } else {
                            let _ = reply.send(false);
                        }
                        false
                    }
                }
            }
        };
        if changed {
            state.send_replace(snapshot(&policy));
        }
        let mut index = 0;
        while index < waiting.len() {
            if policy.revoking(&waiting[index].0) {
                index += 1;
            } else {
                let (_, reply) = waiting.swap_remove(index);
                let _ = reply.send(());
            }
        }
        for effect in effects.drain(..) {
            match effect {
                Effect::Grant {
                    lease,
                    request,
                    waited,
                } => {
                    let target = &lease.target.0;
                    let granted = target.source.bridge_for_generation(
                        target.generation,
                        "desktop_slot.grant".into(),
                        Some(json!({"requestId": request, "waited": waited})),
                        Some(config.grant_timeout),
                    );
                    tasks.spawn(async move {
                        let _ = granted.await;
                        Completed::Grant
                    });
                }
                Effect::Revoke(attempt) => {
                    let target = &attempt.lease.target.0;
                    let revoked = target.source.bridge_for_generation(
                        target.generation,
                        "desktop_slot.revoke".into(),
                        Some(json!({"reason": attempt.reason.as_str()})),
                        Some(config.revoke_command_timeout),
                    );
                    tasks.spawn(async move { Completed::Revoke(attempt, revoked.await.is_ok()) });
                }
                Effect::StopWaiter(capture) => {
                    let reply = waiting_revokes
                        .iter()
                        .position(|(target, _)| *target == capture)
                        .map(|index| waiting_revokes.swap_remove(index).1);
                    let revoked = capture.0.source.bridge_for_generation(
                        capture.0.generation,
                        "desktop_slot.revoke".into(),
                        Some(json!({"reason": "stop"})),
                        Some(config.revoke_command_timeout),
                    );
                    tasks.spawn(async move {
                        let _ = revoked.await;
                        if let Some(reply) = reply {
                            let _ = reply.send(());
                        }
                        Completed::WaiterStopped
                    });
                }
            }
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    state.send_replace(State::default());
}

#[cfg(test)]
mod native_tests;
