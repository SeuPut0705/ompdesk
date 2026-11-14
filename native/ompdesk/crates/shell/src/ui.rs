//! Work for CEF's UI thread (the process's main thread: CEF's message loop runs there) from any thread.

use std::sync::{Arc, Mutex};

use cef::*;

type Job = Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>;

wrap_task! {
    struct ClosureTask {
        f: Job,
    }
    impl Task {
        fn execute(&self) {
            let f = self.f.lock().unwrap().take();
            if let Some(f) = f {
                f();
            }
        }
    }
}

pub fn post(f: impl FnOnce() + Send + 'static) {
    let mut task = ClosureTask::new(Arc::new(Mutex::new(Some(Box::new(f)))));
    post_task(ThreadId::UI, Some(&mut task));
}

pub fn post_delayed(ms: i64, f: impl FnOnce() + Send + 'static) {
    let mut task = ClosureTask::new(Arc::new(Mutex::new(Some(Box::new(f)))));
    post_delayed_task(ThreadId::UI, Some(&mut task), ms);
}

pub fn on_ui_thread() -> bool {
    currently_on(ThreadId::UI) != 0
}

/// Runs `f` now when already on the UI thread, else posts it.
pub fn run(f: impl FnOnce() + Send + 'static) {
    if on_ui_thread() {
        f();
    } else {
        post(f);
    }
}
