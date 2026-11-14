//! Direct stdio client for the core process.

use std::collections::{BTreeMap, HashMap};
use std::io::{self, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::wire::{self, Incoming, WireError};
use serde_json::Value;

const MAX_ID: u64 = (1 << 53) - 1;
type Callback = Box<dyn FnOnce(Result<Value, WireError>, Option<Vec<u8>>) + Send + 'static>;
type Delivery = (Callback, Result<Value, WireError>, Option<Vec<u8>>);

pub struct Config {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

pub trait Handler: Send + Sync + 'static {
    fn event(&self, name: String, data: Value, bin: Option<Vec<u8>>);
    fn request(&self, call: Call);
    fn cancel(&self, id: u64);
    fn disconnected(&self);
}

pub struct Call {
    pub method: String,
    pub params: Value,
    pub bin: Option<Vec<u8>>,
    id: u64,
    writer: mpsc::Sender<Vec<u8>>,
    answered: bool,
}

impl Call {
    pub(crate) fn new(
        id: u64,
        method: String,
        params: Value,
        bin: Option<Vec<u8>>,
        writer: mpsc::Sender<Vec<u8>>,
    ) -> Self {
        Self {
            id,
            method,
            params,
            bin,
            writer,
            answered: false,
        }
    }
    pub fn id(&self) -> u64 {
        self.id
    }
    pub fn ok(mut self, result: Value, bin: Option<Vec<u8>>) {
        self.answered = true;
        let _ = self
            .writer
            .send(wire::answer_ok(self.id, result, bin.as_deref()));
    }
    pub fn err(mut self, code: &str, message: impl Into<String>) {
        self.answered = true;
        let _ = self
            .writer
            .send(wire::answer_err(self.id, &WireError::new(code, message)));
    }
}

impl Drop for Call {
    fn drop(&mut self) {
        if !self.answered {
            let error = WireError::new(
                "failed",
                format!("{} was dropped without an answer", self.method),
            );
            let _ = self.writer.send(wire::answer_err(self.id, &error));
        }
    }
}

struct Pending {
    deadline: Instant,
    callback: Callback,
}
struct State {
    next_id: u64,
    closed: bool,
    pending: HashMap<u64, Pending>,
}
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    writer: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    deliveries: Mutex<Option<mpsc::Sender<Delivery>>>,
    handler: Arc<dyn Handler>,
}

impl Shared {
    fn send(&self, frame: Vec<u8>) -> bool {
        self.writer
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|tx| tx.send(frame).is_ok())
    }
    fn deliver(&self, callback: Callback, result: Result<Value, WireError>, bin: Option<Vec<u8>>) {
        let delivery = (callback, result, bin);
        let failed = match self.deliveries.lock().unwrap().as_ref() {
            Some(sender) => sender.send(delivery).err().map(|error| error.0),
            None => Some(delivery),
        };
        if let Some((callback, result, bin)) = failed {
            callback(result, bin);
        }
    }
    fn close(&self) {
        let pending = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            state.closed = true;
            self.changed.notify_all();
            std::mem::take(&mut state.pending)
        };
        if let Some(writer) = self.writer.lock().unwrap().take() {
            let _ = writer.send(Vec::new());
        }
        for (_, pending) in pending {
            self.deliver(
                pending.callback,
                Err(WireError::new("unavailable", "The core connection closed")),
                None,
            );
        }
        self.handler.disconnected();
    }
}

pub struct Core {
    shared: Arc<Shared>,
    child: Mutex<Option<Child>>,
    threads: Mutex<Vec<JoinHandle<()>>>,
}

impl Core {
    pub fn spawn(config: Config, handler: Arc<dyn Handler>) -> io::Result<Arc<Self>> {
        Self::spawn_with(config, handler, |_, _| Ok(()))
    }

    fn spawn_with(
        config: Config,
        handler: Arc<dyn Handler>,
        mut before_thread: impl FnMut(usize, u32) -> io::Result<()>,
    ) -> io::Result<Arc<Self>> {
        let mut command = Command::new(config.program);
        command
            .args(config.args)
            .envs(config.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn()?;
        let Some(stdin) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("core stdin unavailable"));
        };
        let Some(stdout) = child.stdout.take() else {
            drop(stdin);
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("core stdout unavailable"));
        };
        let (writer, rx) = mpsc::channel::<Vec<u8>>();
        let (deliveries, replies) = mpsc::channel::<Delivery>();
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                next_id: 1,
                closed: false,
                pending: HashMap::new(),
            }),
            changed: Condvar::new(),
            writer: Mutex::new(Some(writer)),
            deliveries: Mutex::new(Some(deliveries)),
            handler,
        });
        let pid = child.id();
        let core = Arc::new(Self {
            shared: shared.clone(),
            child: Mutex::new(Some(child)),
            threads: Mutex::new(Vec::new()),
        });
        macro_rules! start_thread {
            ($index:expr, $body:expr) => {{
                before_thread($index, pid)?;
                let handle = thread::Builder::new().spawn($body)?;
                core.threads.lock().unwrap().push(handle);
            }};
        }
        let writer_shared = shared.clone();
        start_thread!(0, move || {
            let mut stdin = stdin;
            for frame in rx {
                if frame.is_empty() || wire::write_all(&mut stdin, &frame).is_err() {
                    break;
                }
            }
            writer_shared.close();
        });
        let reader_shared = shared.clone();
        start_thread!(1, move || {
            let mut reader = BufReader::new(stdout);
            while let Ok(Some(frame)) = wire::read_frame(&mut reader) {
                match frame {
                    Incoming::Answer { id, result, bin } => {
                        let pending = reader_shared.state.lock().unwrap().pending.remove(&id);
                        if let Some(pending) = pending {
                            reader_shared.deliver(pending.callback, result, bin);
                        }
                    }
                    Incoming::Request {
                        id,
                        method,
                        params,
                        bin,
                    } => {
                        let writer = reader_shared.writer.lock().unwrap().clone();
                        if let Some(writer) = writer {
                            reader_shared
                                .handler
                                .request(Call::new(id, method, params, bin, writer));
                        }
                    }
                    Incoming::Event { event, data, bin } => {
                        reader_shared.handler.event(event, data, bin)
                    }
                    Incoming::Cancel(id) => reader_shared.handler.cancel(id),
                    Incoming::Skipped(_) => {}
                }
            }
            reader_shared.close();
        });
        let timer_shared = shared.clone();
        start_thread!(2, move || {
            let mut state = timer_shared.state.lock().unwrap();
            loop {
                if state.closed {
                    break;
                }
                let now = Instant::now();
                let expired: Vec<_> = state
                    .pending
                    .iter()
                    .filter_map(|(&id, p)| (p.deadline <= now).then_some(id))
                    .collect();
                if !expired.is_empty() {
                    let calls: Vec<_> = expired
                        .into_iter()
                        .filter_map(|id| state.pending.remove(&id).map(|p| (id, p)))
                        .collect();
                    drop(state);
                    for (id, pending) in calls {
                        timer_shared.send(wire::cancel(id));
                        timer_shared.deliver(
                            pending.callback,
                            Err(WireError::new("timeout", "The core request timed out")),
                            None,
                        );
                    }
                    state = timer_shared.state.lock().unwrap();
                } else if let Some(deadline) = state.pending.values().map(|p| p.deadline).min() {
                    state = timer_shared
                        .changed
                        .wait_timeout(state, deadline.saturating_duration_since(now))
                        .unwrap()
                        .0;
                } else {
                    state = timer_shared.changed.wait(state).unwrap();
                }
            }
        });
        start_thread!(3, move || {
            for (callback, result, bin) in replies {
                callback(result, bin);
            }
        });
        Ok(core)
    }

    pub fn request(
        &self,
        method: &str,
        params: Value,
        bin: Option<Vec<u8>>,
        timeout: Duration,
        callback: impl FnOnce(Result<Value, WireError>, Option<Vec<u8>>) + Send + 'static,
    ) -> u64 {
        let mut state = self.shared.state.lock().unwrap();
        if state.closed || state.next_id > MAX_ID {
            let code = if state.closed {
                "unavailable"
            } else {
                "id_exhausted"
            };
            drop(state);
            self.shared.deliver(
                Box::new(callback),
                Err(WireError::new(code, "Cannot start core request")),
                None,
            );
            return 0;
        }
        let id = state.next_id;
        state.next_id += 1;
        state.pending.insert(
            id,
            Pending {
                deadline: Instant::now()
                    .checked_add(timeout)
                    .unwrap_or(Instant::now()),
                callback: Box::new(callback),
            },
        );
        let sent = self
            .shared
            .send(wire::request(id, method, params, bin.as_deref()));
        self.shared.changed.notify_one();
        drop(state);
        if !sent {
            self.shared.close();
        }
        id
    }

    pub fn cancel(&self, id: u64) {
        let pending = self.shared.state.lock().unwrap().pending.remove(&id);
        if let Some(pending) = pending {
            self.shared.send(wire::cancel(id));
            self.shared.deliver(
                pending.callback,
                Err(WireError::new(
                    "cancelled",
                    "The core request was cancelled",
                )),
                None,
            );
        }
    }

    pub fn stop(&self, grace: Duration) {
        self.shared.close();
        let mut child = self.child.lock().unwrap();
        if let Some(mut child) = child.take() {
            let deadline = Instant::now()
                .checked_add(grace)
                .unwrap_or_else(Instant::now);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if Instant::now() < deadline => thread::sleep(
                        Duration::from_millis(10)
                            .min(deadline.saturating_duration_since(Instant::now())),
                    ),
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                }
            }
        }
        drop(child);
        let mut threads = std::mem::take(&mut *self.threads.lock().unwrap());
        let delivery = threads.pop();
        for worker in threads {
            if worker.thread().id() != thread::current().id() {
                let _ = worker.join();
            }
        }
        self.shared.deliveries.lock().unwrap().take();
        if let Some(worker) = delivery
            && worker.thread().id() != thread::current().id()
        {
            let _ = worker.join();
        }
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        self.stop(Duration::ZERO);
    }
}

#[cfg(all(test, unix))]
#[path = "core_client_tests.rs"]
mod tests;
