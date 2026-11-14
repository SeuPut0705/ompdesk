//! Native handle of the existing Lane. No process, restart policy, worker, claim or caller authority is recreated.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::application::{Answer, Ask, Command as LaunchCommand, EffectFuture, SessionFree};
use super::lane::{Command, Msg};
use super::{LaneEvent, deliver, tell};
use crate::server::{Events, Fault};

pub use super::lane::{OpenParams as Config, Tuning};
pub use super::process::Start;

/// Existing native platform adapter. Windows quoting belongs to the Windows spawn owner.
pub trait SpawnAdapter: Send + Sync {
    fn prepare(&self, command: LaunchCommand) -> Result<Start, Fault>;
}

#[cfg(unix)]
pub struct DirectSpawn;

#[cfg(unix)]
impl SpawnAdapter for DirectSpawn {
    fn prepare(&self, command: LaunchCommand) -> Result<Start, Fault> {
        Ok(Start {
            bin: command.bin.to_string_lossy().into_owned(),
            args: command.args,
            env: command.env,
            cwd: command.cwd,
            shell: false,
        })
    }
}

/// The application's ordered event consumer. `before_response` flushes the very stream `event` delivered to.
pub trait Sink: Send + Sync {
    fn event(&self, event: LaneEvent);
    fn before_response(&self);
    fn remove_listeners(&self);
    fn sync_settings(&self) -> EffectFuture<'_, ()>;
}

struct State {
    cwd: String,
    status: String,
    pid: Option<u32>,
    alive: bool,
    bridge: bool,
    generation: u64,
    session: Option<Value>,
}

type Pending = HashMap<u64, oneshot::Sender<Option<Arc<[u8]>>>>;

pub struct Service {
    tab: String,
    next: AtomicU64,
    fence: AtomicU64,
    cwd_fence: AtomicU64,
    disposed: AtomicBool,
    state: Mutex<State>,
    pending: Arc<Mutex<Pending>>,
    sink: Arc<dyn Sink>,
    spawn: Arc<dyn SpawnAdapter>,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The existing engine's lifetime. Base keeps it under the same supervised native app lifetime.
pub type Held = EffectFuture<'static, Result<(), Fault>>;

impl Service {
    pub fn new(
        config: Config,
        events: Events,
        sink: Arc<dyn Sink>,
        spawn: Arc<dyn SpawnAdapter>,
    ) -> Result<(Arc<Self>, Held), Fault> {
        let receiver = super::subscribe(&config.tab);
        let tab = config.tab.clone();
        let next = config.seq + 1;
        let cwd = config.cwd.clone();
        let answer = super::open_native(config, events)?;
        let service = Arc::new(Self {
            tab,
            next: AtomicU64::new(next),
            fence: AtomicU64::new(0),
            cwd_fence: AtomicU64::new(0),
            disposed: AtomicBool::new(false),
            state: Mutex::new(State {
                cwd,
                status: "asleep".into(),
                pid: None,
                alive: false,
                bridge: false,
                generation: 0,
                session: None,
            }),
            pending: Arc::new(Mutex::new(HashMap::new())),
            sink,
            spawn,
        });
        tokio::spawn(pump(
            Arc::downgrade(&service),
            Arc::clone(&service.sink),
            receiver,
        ));
        let held = Box::pin(async move { answer.await.map_err(|_| disconnected())? });
        Ok((service, held))
    }

    pub fn tab(&self) -> &str {
        &self.tab
    }

    fn send(&self, command: Command, lifecycle: bool) -> u64 {
        let seq = self.next.fetch_add(1, Ordering::Relaxed);
        if lifecycle {
            self.fence.fetch_max(seq, Ordering::SeqCst);
        }
        deliver(&self.tab, seq, command);
        seq
    }

    pub fn current(&self, ask: Ask) -> bool {
        !self.disposed.load(Ordering::SeqCst) && ask.cmd >= self.fence.load(Ordering::SeqCst)
    }

    pub fn start(&self) {
        self.send(Command::Start, true);
    }
    pub fn restart(&self, cwd: Option<String>, session: Option<String>) {
        self.send(
            Command::Restart {
                cwd,
                resume_session_path: session,
            },
            true,
        );
    }
    pub fn sleep(&self) {
        self.send(Command::Sleep, true);
    }
    pub fn kill(&self) {
        self.send(Command::Kill, true);
    }
    pub fn arm_gate(&self) {
        self.send(Command::Gate, false);
    }

    pub fn dispose(&self, stdin_grace: Duration) {
        if !self.disposed.swap(true, Ordering::SeqCst) {
            self.send(Command::Dispose { stdin_grace }, true);
        }
    }

    pub fn adopt_cwd(&self, cwd: &str) -> bool {
        let mut state = locked(&self.state);
        if state.cwd == cwd {
            return false;
        }
        state.cwd = cwd.into();
        drop(state);
        let seq = self.next.fetch_add(1, Ordering::Relaxed);
        self.cwd_fence.fetch_max(seq, Ordering::SeqCst);
        deliver(&self.tab, seq, Command::Cwd(cwd.into()));
        true
    }

    pub fn facts(&self) -> Value {
        let state = locked(&self.state);
        let mut facts = json!({"cwd": state.cwd, "status": state.status, "processAlive": state.alive,
            "shared": false, "sleep": true, "rpc": state.alive, "bridge": true});
        if let Some(pid) = state.pid {
            facts["pid"] = Value::from(pid);
        }
        facts
    }

    pub fn session(&self) -> Option<Value> {
        locked(&self.state).session.clone()
    }
    pub fn bridge_connected(&self) -> bool {
        locked(&self.state).bridge
    }

    pub fn answer(&self, ask: Ask, answer: Answer) {
        if !self.current(ask) {
            return;
        }
        let message = match answer {
            Answer::Resolved { outcome, message } => Msg::Resolved {
                ask: ask.ask,
                outcome: outcome.into(),
                message,
            },
            Answer::Launched {
                command,
                host_tools,
            } => match self.spawn.prepare(command) {
                Ok(start) => Msg::Launched {
                    ask: ask.ask,
                    start: Some(start),
                    host_tools: Some(host_tools),
                    error: None,
                },
                Err(error) => Msg::Launched {
                    ask: ask.ask,
                    start: None,
                    host_tools: None,
                    error: Some(error.message),
                },
            },
            Answer::LaunchFailed(error) => Msg::Launched {
                ask: ask.ask,
                start: None,
                host_tools: None,
                error: Some(error),
            },
            Answer::Gated(cwd) => Msg::Gated { ask: ask.ask, cwd },
            Answer::SessionFreed(free) => Msg::SessionFreed {
                ask: ask.ask,
                free: free == SessionFree::Free,
            },
        };
        tell(&self.tab, message);
    }

    pub fn side_channel(&self, frame: Value) -> Result<(), Fault> {
        let frame = serde_json::value::to_raw_value(&frame)
            .map_err(|error| Fault::new("invalid_params", error.to_string()))?;
        self.send(Command::Send(frame), false);
        Ok(())
    }

    pub fn stock(
        &self,
        command: Value,
        timeout: Option<Duration>,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        let command = match serde_json::value::to_raw_value(&command) {
            Ok(command) => command,
            Err(error) => {
                return Box::pin(
                    async move { Err(Fault::new("invalid_params", error.to_string())) },
                );
            }
        };
        let seq = self.next.fetch_add(1, Ordering::Relaxed);
        let (frame, framed) = oneshot::channel();
        locked(&self.pending).insert(seq, frame);
        let (reply, answered) = oneshot::channel();
        deliver(
            &self.tab,
            seq,
            Command::Stock {
                seq,
                command,
                timeout,
                reply,
            },
        );
        let waiting = Waiting {
            pending: Arc::downgrade(&self.pending),
            seq,
        };
        Box::pin(async move {
            let _waiting = waiting;
            answered.await.map_err(|_| disconnected())??;
            let bytes = framed
                .await
                .map_err(|_| disconnected())?
                .ok_or_else(disconnected)?;
            let frame: Value = serde_json::from_slice(&bytes)
                .map_err(|error| Fault::new("sidecar_frame", error.to_string()))?;
            Ok(crate::remote::events::slim::without_frame_bookkeeping(&frame).unwrap_or(frame))
        })
    }

    pub fn bridge(
        &self,
        method: String,
        params: Option<Value>,
        timeout: Option<Duration>,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        let params = match params
            .map(|params| serde_json::value::to_raw_value(&params))
            .transpose()
        {
            Ok(params) => params,
            Err(error) => {
                return Box::pin(
                    async move { Err(Fault::new("invalid_params", error.to_string())) },
                );
            }
        };
        let (reply, answer) = oneshot::channel();
        self.send(
            Command::Bridge {
                method,
                params,
                timeout,
                reply,
            },
            false,
        );
        Box::pin(async move {
            match answer
                .await
                .map_err(|_| Fault::new("bridge_disconnected", "gui-bridge not connected"))??
            {
                Some(result) => serde_json::from_str(result.get())
                    .map_err(|error| Fault::new("bridge_frame", error.to_string())),
                None => Ok(Value::Null),
            }
        })
    }

    /// Captured synchronously before a following dispose, as SidecarPool's exact-close receipt requires.
    pub fn when_exited(&self) -> EffectFuture<'static, Result<(), Fault>> {
        let (reply, answer) = oneshot::channel();
        self.send(Command::NativeWhenExited(reply), false);
        Box::pin(async move { answer.await.map_err(|_| disconnected())? })
    }

    pub fn barrier(&self) -> EffectFuture<'static, Result<(), Fault>> {
        let seq = self.next.fetch_add(1, Ordering::Relaxed);
        let (frame, framed) = oneshot::channel();
        locked(&self.pending).insert(seq, frame);
        let (reply, answered) = oneshot::channel();
        deliver(&self.tab, seq, Command::Barrier(seq, reply));
        let waiting = Waiting {
            pending: Arc::downgrade(&self.pending),
            seq,
        };
        Box::pin(async move {
            let _waiting = waiting;
            answered.await.map_err(|_| disconnected())?;
            let _ = framed.await.map_err(|_| disconnected())?;
            Ok(())
        })
    }
}

fn disconnected() -> Fault {
    Fault::new("sidecar_disconnected", "Sidecar disconnected")
}

struct Waiting {
    pending: Weak<Mutex<Pending>>,
    seq: u64,
}
impl Drop for Waiting {
    fn drop(&mut self) {
        if let Some(pending) = self.pending.upgrade() {
            locked(&pending).remove(&self.seq);
        }
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        self.dispose(Duration::ZERO);
    }
}

async fn pump(
    service: Weak<Service>,
    sink: Arc<dyn Sink>,
    mut events: tokio::sync::mpsc::UnboundedReceiver<LaneEvent>,
) {
    while let Some(event) = events.recv().await {
        let Some(service) = service.upgrade() else {
            if event.name == "sidecar.disposed" {
                sink.event(event);
                break;
            }
            continue;
        };
        let cmd = event.data["cmd"].as_u64().unwrap_or(0);
        let stale =
            service.disposed.load(Ordering::SeqCst) || cmd < service.fence.load(Ordering::SeqCst);
        if !stale
            || ((event.name == "sidecar.nativeGeneration" || event.name == "sidecar.disposed")
                && cmd >= service.fence.load(Ordering::SeqCst))
        {
            let mut state = locked(&service.state);
            state.generation = event.generation;
            match event.name.as_str() {
                "sidecar.nativeGeneration" => {
                    state.bridge = false;
                }
                "sidecar.status" => {
                    if let Some(status) = event.data["payload"]["status"].as_str() {
                        state.status = status.into();
                    }
                    if cmd >= service.cwd_fence.load(Ordering::SeqCst)
                        && let Some(cwd) = event.data["payload"]["cwd"].as_str()
                    {
                        state.cwd = cwd.into();
                    }
                }
                "sidecar.spawned" => {
                    state.pid = event.data["pid"]
                        .as_u64()
                        .and_then(|pid| u32::try_from(pid).ok());
                    state.alive = true;
                }
                "sidecar.exited" => {
                    state.pid = None;
                    state.alive = false;
                    state.bridge = false;
                }
                "sidecar.bridgeState" => {
                    state.bridge = event.data["connected"].as_bool().unwrap_or(false);
                }
                "sidecar.bridgeLost" => {
                    state.bridge = false;
                }
                "sidecar.session" => {
                    state.session = event
                        .data
                        .get("identity")
                        .filter(|value| !value.is_null())
                        .cloned();
                }
                _ => {}
            }
        }
        if event.name == "sidecar.nativeGeneration" {
            continue;
        }
        if event.name == "sidecar.answer" {
            service.sink.before_response();
            if let Some(seq) = event.data["seq"].as_u64()
                && let Some(waiting) = locked(&service.pending).remove(&seq)
            {
                let _ = waiting.send(event.bin);
            }
        } else if !stale || event.name == "sidecar.disposed" {
            service.sink.event(event);
        }
    }
    if let Some(service) = service.upgrade() {
        locked(&service.pending).clear();
    }
}

impl crate::pool::application::Sidecar for Service {
    type Error = Fault;
    fn facts(&self) -> Value {
        Service::facts(self)
    }
    fn generation(&self) -> u64 {
        locked(&self.state).generation
    }
    fn bridge_connected(&self) -> bool {
        Service::bridge_connected(self)
    }
    fn before_response(&self) {
        self.sink.before_response();
    }
    fn start(&self) {
        Service::start(self);
    }
    fn restart(&self, session: Option<&str>) {
        Service::restart(self, None, session.map(str::to_owned));
    }
    fn sleep(&self) {
        Service::sleep(self);
    }
    fn adopt_cwd(&self, cwd: &str) -> bool {
        Service::adopt_cwd(self, cwd)
    }
    fn send(&self, frame: Value) -> EffectFuture<'_, Result<(), Fault>> {
        let result = self.side_channel(frame);
        Box::pin(async move { result })
    }
    fn send_now(&self, frame: Value) -> Result<(), Fault> {
        self.side_channel(frame)
    }
    fn stock(&self, command: Value) -> EffectFuture<'static, Result<Value, Fault>> {
        Service::stock(self, command, Some(Duration::from_secs(8)))
    }
    fn bridge(
        &self,
        method: String,
        params: Option<Value>,
        timeout_ms: Option<u64>,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        Service::bridge(self, method, params, timeout_ms.map(Duration::from_millis))
    }
    fn exit_waiter(&self) -> EffectFuture<'static, Result<(), Fault>> {
        self.when_exited()
    }
    fn remove_listeners(&self) {
        self.sink.remove_listeners();
    }
    fn dispose(&self) {
        Service::dispose(self, Duration::ZERO);
    }
    fn sync_settings(&self) -> EffectFuture<'_, ()> {
        self.sink.sync_settings()
    }
}

#[cfg(test)]
#[path = "native_tests.rs"]
mod tests;
