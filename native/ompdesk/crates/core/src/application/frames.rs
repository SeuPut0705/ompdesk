use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread::ThreadId;
use std::time::Duration;

use serde_json::Value;
use tokio::runtime::Handle;

use crate::pool::application::{Delivery, FullChannel};

pub trait DeliverySink: Send + Sync {
    fn deliver(&self, delivery: Delivery);
}

struct Tab {
    channel: FullChannel,
    timer: Option<u64>,
}

#[derive(Default)]
struct State {
    tabs: HashMap<String, Tab>,
    generation: u64,
    closed: bool,
    queue: VecDeque<(u64, Delivery)>,
    next_delivery: u64,
    delivered: u64,
    delivering: Option<ThreadId>,
}

struct Inner {
    state: Mutex<State>,
    changed: Condvar,
    sink: Arc<dyn DeliverySink>,
    runtime: Handle,
}

pub struct Frames {
    inner: Arc<Inner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

impl Frames {
    pub fn new(runtime: Handle, sink: Arc<dyn DeliverySink>) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State::default()),
                changed: Condvar::new(),
                sink,
                runtime,
            }),
        }
    }

    fn change(&self, f: impl FnOnce(&mut State, &mut Vec<Delivery>)) {
        self.inner.change(f);
    }

    pub fn attach(&self, tab: &str, window: i64) {
        self.change(|state, _| {
            state
                .tabs
                .entry(tab.to_owned())
                .or_insert_with(|| Tab {
                    channel: FullChannel::new(tab),
                    timer: None,
                })
                .channel
                .attach(window);
        });
    }

    pub fn detach(&self, tab: &str, window: i64) {
        self.change(|state, deliveries| {
            if let Some(tab) = state.tabs.get_mut(tab) {
                tab.channel
                    .detach(window, &mut |delivery| deliveries.push(delivery));
                if !deliveries.is_empty() {
                    tab.timer = None;
                }
            }
        });
    }

    pub fn resnapshot(&self, tab: &str, window: i64) {
        self.change(|state, _| {
            if let Some(tab) = state.tabs.get_mut(tab) {
                tab.channel.resnapshot(window);
            }
        });
    }

    pub fn subagent(&self, tab: &str, frame: Value) {
        let mut timer = None;
        self.change(|state, _| {
            if let Some(entry) = state.tabs.get_mut(tab)
                && entry.channel.subagent(frame)
            {
                state.generation = state.generation.wrapping_add(1);
                entry.timer = Some(state.generation);
                timer = Some(state.generation);
            }
        });
        if let Some(generation) = timer {
            let weak = Arc::downgrade(&self.inner);
            let tab = tab.to_owned();
            self.inner.runtime.spawn(async move {
                tokio::time::sleep(Duration::from_millis(32)).await;
                timer_fired(&weak, &tab, generation);
            });
        }
    }

    pub fn events(&self, tab: &str, events: Arc<[Value]>) {
        self.change(|state, deliveries| {
            if let Some(tab) = state.tabs.get_mut(tab) {
                tab.timer = None;
                tab.channel
                    .events(events, &mut |delivery| deliveries.push(delivery));
            }
        });
    }

    pub fn forward(&self, tab: &str, channel: &'static str, payload: Value) {
        self.change(|state, deliveries| {
            if let Some(tab) = state.tabs.get(tab) {
                tab.channel
                    .forward(channel, payload, &mut |delivery| deliveries.push(delivery));
            }
        });
    }

    pub fn flush(&self, tab: &str) {
        self.change(|state, deliveries| {
            if let Some(tab) = state.tabs.get_mut(tab) {
                tab.timer = None;
                tab.channel.flush(&mut |delivery| deliveries.push(delivery));
            }
        });
    }

    pub fn release(&self, tab: &str) {
        self.change(|state, deliveries| {
            if let Some(mut tab) = state.tabs.remove(tab) {
                tab.channel.flush(&mut |delivery| deliveries.push(delivery));
            }
        });
    }

    pub fn close(&self) {
        let mut state = lock(&self.inner.state);
        state.closed = true;
        state.tabs.clear();
        state.queue.clear();
        let current = std::thread::current().id();
        while state.delivering.is_some() && state.delivering != Some(current) {
            state = self
                .inner
                .changed
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
    }
}

impl Inner {
    fn change(&self, f: impl FnOnce(&mut State, &mut Vec<Delivery>)) {
        let mut state = lock(&self.state);
        if state.closed {
            return;
        }
        let mut deliveries = Vec::new();
        f(&mut state, &mut deliveries);
        for delivery in deliveries {
            state.next_delivery += 1;
            let id = state.next_delivery;
            state.queue.push_back((id, delivery));
        }
        let target = state.next_delivery;
        let current = std::thread::current().id();
        if state.delivering == Some(current) {
            return;
        }
        while state.delivering.is_some() && !state.closed && state.delivered < target {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
        if state.closed || state.delivered >= target {
            return;
        }
        state.delivering = Some(current);
        while let Some((id, delivery)) = state.queue.pop_front() {
            drop(state);
            self.sink.deliver(delivery);
            state = lock(&self.state);
            state.delivered = id;
            self.changed.notify_all();
        }
        state.delivering = None;
        self.changed.notify_all();
    }
}

fn timer_fired(inner: &Weak<Inner>, tab: &str, generation: u64) {
    if let Some(inner) = inner.upgrade() {
        inner.change(|state, deliveries| {
            if let Some(tab) = state.tabs.get_mut(tab)
                && tab.timer == Some(generation)
            {
                tab.timer = None;
                tab.channel.flush(&mut |delivery| deliveries.push(delivery));
            }
        });
    }
}

#[cfg(test)]
#[path = "frames_tests.rs"]
mod tests;
