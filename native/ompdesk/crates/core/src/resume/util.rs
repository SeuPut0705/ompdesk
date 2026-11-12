//! Small tools the resume rules share: JavaScript's insertion-ordered `Map` and `Set`, and a task that starts the way
//! an `async` function does.

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};

use crate::hub::{self, LocalFuture};

/// A `Map<string, V>` with JavaScript's order: iteration follows first insertion; setting a key again keeps its place.
pub struct OrdMap<V> {
    items: Vec<(String, V)>,
}

impl<V> Default for OrdMap<V> {
    fn default() -> Self {
        OrdMap { items: Vec::new() }
    }
}

impl<V> OrdMap<V> {
    pub fn get(&self, key: &str) -> Option<&V> {
        self.items.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn contains(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn insert(&mut self, key: String, value: V) {
        match self.items.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => self.items.push((key, value)),
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<V> {
        let at = self.items.iter().position(|(k, _)| k == key)?;
        Some(self.items.remove(at).1)
    }

    pub fn keys(&self) -> Vec<String> {
        self.items.iter().map(|(k, _)| k.clone()).collect()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
        self.items.iter().map(|(k, v)| (k, v))
    }

    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.items.iter().map(|(_, v)| v)
    }

    /// Takes every entry, in order.
    pub fn drain(&mut self) -> Vec<(String, V)> {
        std::mem::take(&mut self.items)
    }

    pub fn retain(&mut self, keep: impl Fn(&str) -> bool) {
        self.items.retain(|(k, _)| keep(k));
    }
}

/// Runs `task` as an `async` function runs when it is called: at once, up to its first wait. What it then waits for
/// finishes in the hub's tasks. (A future may be polled again at any time; the wake-ups the first poll missed are
/// seen by the poll the hub's task makes next, in this job's microtasks.)
pub fn start(task: impl Future<Output = ()> + 'static) {
    let mut task: LocalFuture<()> = Box::pin(task);
    let mut context = Context::from_waker(Waker::noop());
    if task.as_mut().poll(&mut context).is_pending() {
        hub::spawn(task);
    }
}

/// `Promise.all` of futures that each were started in order: the first poll runs each one up to its first wait.
pub struct JoinAll {
    pub futures: Vec<Option<LocalFuture<()>>>,
}

impl Future for JoinAll {
    type Output = ();

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        let this = self.get_mut();
        let mut pending = false;
        for slot in &mut this.futures {
            if let Some(future) = slot {
                if future.as_mut().poll(context).is_ready() {
                    *slot = None;
                } else {
                    pending = true;
                }
            }
        }
        if pending {
            Poll::Pending
        } else {
            Poll::Ready(())
        }
    }
}
