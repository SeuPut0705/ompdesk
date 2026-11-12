//! Small tools the service shares: an insertion-ordered map (a JavaScript `Map`), a one-shot result many tasks wait
//! for (a shared `Promise`), and `join::all` (`Promise.all`).

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::Poll;

use tokio::sync::watch;

/// A `Map` keyed by text that keeps insertion order: setting an existing key keeps its place.
#[derive(Clone, Debug)]
pub struct OrderedMap<V> {
    order: Vec<String>,
    values: HashMap<String, V>,
}

impl<V> Default for OrderedMap<V> {
    fn default() -> Self {
        OrderedMap {
            order: Vec::new(),
            values: HashMap::new(),
        }
    }
}

impl<V> OrderedMap<V> {
    pub fn get(&self, key: &str) -> Option<&V> {
        self.values.get(key)
    }

    pub fn set(&mut self, key: &str, value: V) {
        if self.values.insert(key.to_owned(), value).is_none() {
            self.order.push(key.to_owned());
        }
    }

    pub fn delete(&mut self, key: &str) -> Option<V> {
        let removed = self.values.remove(key);
        if removed.is_some() {
            self.order.retain(|held| held != key);
        }
        removed
    }

    /// The values in insertion order.
    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.order.iter().filter_map(|key| self.values.get(key))
    }
}

enum Slot<T> {
    Pending,
    Done(T),
    /// The task that was to settle it ended without doing so.
    Abandoned,
}

/// A result one task produces and any number wait for (a `Promise` several callers `await`). Clones share it.
pub struct Flight<T>(Arc<watch::Sender<Slot<T>>>);

impl<T> Clone for Flight<T> {
    fn clone(&self) -> Self {
        Flight(self.0.clone())
    }
}

impl<T: Clone> Default for Flight<T> {
    fn default() -> Self {
        Flight::new()
    }
}

impl<T: Clone> Flight<T> {
    pub fn new() -> Flight<T> {
        Flight(Arc::new(watch::channel(Slot::Pending).0))
    }

    /// Settles it; a second settle is ignored.
    pub fn settle(&self, value: T) {
        self.0.send_if_modified(|slot| {
            if matches!(slot, Slot::Pending) {
                *slot = Slot::Done(value);
                true
            } else {
                false
            }
        });
    }

    /// Settles it as abandoned when dropped before `settle`: waiters get None instead of waiting for ever.
    pub fn guard(&self) -> FlightGuard<T> {
        FlightGuard(self.clone())
    }

    /// The result, once settled; None when its producer was dropped first.
    pub async fn wait(&self) -> Option<T> {
        let mut receiver = self.0.subscribe();
        let seen = receiver
            .wait_for(|slot| !matches!(slot, Slot::Pending))
            .await
            .ok()?;
        match &*seen {
            Slot::Done(value) => Some(value.clone()),
            _ => None,
        }
    }
}

pub struct FlightGuard<T: Clone>(Flight<T>);

impl<T: Clone> Drop for FlightGuard<T> {
    fn drop(&mut self) {
        (self.0).0.send_if_modified(|slot| {
            if matches!(slot, Slot::Pending) {
                *slot = Slot::Abandoned;
                true
            } else {
                false
            }
        });
    }
}

/// `Promise.all` over futures run on the calling task (never spawned, so a task-local such as the recorded call's
/// scope stays visible to each).
pub mod join {
    use super::*;

    pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

    pub fn boxed<'a, T>(future: impl Future<Output = T> + Send + 'a) -> BoxFut<'a, T> {
        Box::pin(future)
    }

    /// Every result, in the order of the futures.
    pub async fn all<T>(futures: Vec<BoxFut<'_, T>>) -> Vec<T> {
        let mut slots: Vec<Option<BoxFut<'_, T>>> = futures.into_iter().map(Some).collect();
        let mut results: Vec<Option<T>> = slots.iter().map(|_| None).collect();
        std::future::poll_fn(|cx| {
            let mut pending = false;
            for (slot, result) in slots.iter_mut().zip(results.iter_mut()) {
                if let Some(future) = slot {
                    match future.as_mut().poll(cx) {
                        Poll::Ready(value) => {
                            *result = Some(value);
                            *slot = None;
                        }
                        Poll::Pending => pending = true,
                    }
                }
            }
            if pending {
                Poll::Pending
            } else {
                Poll::Ready(())
            }
        })
        .await;
        results.into_iter().flatten().collect()
    }
}
