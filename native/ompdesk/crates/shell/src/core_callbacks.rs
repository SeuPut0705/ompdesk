//! Owns the core's OS callbacks without blocking its stdio reader or the CEF UI thread.

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};

use serde_json::Value;

use crate::core_client::{Call, Handler};

pub trait Events: Send + Sync + 'static {
    fn event(&self, name: String, data: Value, bin: Option<Vec<u8>>);
    fn disconnected(&self);
}

type Cancel = Arc<AtomicBool>;
type Pending = Arc<Mutex<HashMap<u64, Cancel>>>;
type Execute = Box<dyn Fn(Call) + Send>;

struct Work {
    call: Call,
    cancelled: Cancel,
}

pub struct Callbacks {
    events: Arc<dyn Events>,
    pending: Pending,
    sender: Mutex<Option<mpsc::Sender<Work>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Callbacks {
    pub fn open(
        user_data: PathBuf,
        resolve_proxy: fn(&str) -> String,
        events: Arc<dyn Events>,
    ) -> io::Result<Self> {
        Self::with_executor(
            events,
            Box::new(move |call| {
                if call.method.starts_with("native.secret.") {
                    crate::secrets::request(&user_data, call);
                } else if call.method == "native.proxy.resolve" {
                    let Some(url) = call.params.get("url").and_then(Value::as_str) else {
                        call.err("invalid_params", "The native proxy request has no URL");
                        return;
                    };
                    let result = resolve_proxy(url);
                    call.ok(Value::String(result), None);
                } else {
                    call.err("unsupported", "Unknown native OS callback");
                }
            }),
        )
    }

    fn with_executor(events: Arc<dyn Events>, execute: Execute) -> io::Result<Self> {
        let (sender, receiver) = mpsc::channel::<Work>();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let held = Arc::clone(&pending);
        let worker = thread::Builder::new()
            .name("native-os-callbacks".into())
            .spawn(move || {
                for work in receiver {
                    let id = work.call.id();
                    if work.cancelled.load(Ordering::Acquire) {
                        work.call
                            .err("cancelled", "The native callback was cancelled");
                    } else {
                        execute(work.call);
                    }
                    held.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
                }
            })?;
        Ok(Self {
            events,
            pending,
            sender: Mutex::new(Some(sender)),
            worker: Mutex::new(Some(worker)),
        })
    }

    /// Joins an in-flight OS read. Cancelled queued work never calls the platform API.
    pub fn stop(&self) {
        let mut sender = self.sender.lock().unwrap_or_else(|p| p.into_inner());
        for cancelled in self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
        {
            cancelled.store(true, Ordering::Release);
        }
        sender.take();
        drop(sender);
        if let Some(worker) = self.worker.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = worker.join();
        }
    }
}

impl Handler for Callbacks {
    fn event(&self, name: String, data: Value, bin: Option<Vec<u8>>) {
        self.events.event(name, data, bin);
    }

    fn request(&self, call: Call) {
        let sender = self.sender.lock().unwrap_or_else(|p| p.into_inner());
        let Some(sender) = sender.as_ref() else {
            call.err("unavailable", "The native callbacks have stopped");
            return;
        };
        let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
        let id = call.id();
        if pending.contains_key(&id) {
            call.err(
                "invalid_request",
                "The native callback identity is already active",
            );
            return;
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        pending.insert(id, Arc::clone(&cancelled));
        if let Err(error) = sender.send(Work { call, cancelled }) {
            pending.remove(&id);
            error
                .0
                .call
                .err("unavailable", "The native callback worker ended");
        }
    }

    fn cancel(&self, id: u64) {
        if let Some(cancelled) = self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&id)
        {
            cancelled.store(true, Ordering::Release);
        }
    }

    fn disconnected(&self) {
        for cancelled in self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
        {
            cancelled.store(true, Ordering::Release);
        }
        self.events.disconnected();
    }
}

impl Drop for Callbacks {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
#[path = "core_callbacks_tests.rs"]
mod tests;
