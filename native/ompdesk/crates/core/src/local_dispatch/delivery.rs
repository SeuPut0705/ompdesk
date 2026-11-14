use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::sync::watch;

use super::protocol::RpcResponse;
use crate::server::Fault;

const KEPT: usize = 2000;
const KEPT_FOR: Duration = Duration::from_secs(24 * 60 * 60);

type Answer = Result<RpcResponse, Fault>;
type SharedAnswer = watch::Receiver<Option<Answer>>;

struct Entry {
    at: Instant,
    generation: u64,
    answer: SharedAnswer,
}

#[derive(Default)]
struct Entries {
    next: u64,
    by_id: HashMap<String, Entry>,
    order: VecDeque<(String, u64)>,
}

/// One ledger for the execution host, shared by every tab. A refusal or lost omp can be tried again; an accepted
/// delivery is retained for a day. The sender's correlation id is rebound by the dispatcher, not retained here.
#[derive(Clone, Default)]
pub struct DeliveryLedger(Arc<Mutex<Entries>>);

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl DeliveryLedger {
    pub fn known(&self, id: &str) -> bool {
        locked(&self.0).by_id.get(id).is_some_and(|entry| entry.at.elapsed() < KEPT_FOR)
    }

    pub async fn deliver<F, Fut>(&self, id: String, send: F) -> Answer
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Answer> + Send + 'static,
    {
        let mut answer = {
            let mut entries = locked(&self.0);
            match entries.by_id.get(&id) {
                Some(entry) if entry.at.elapsed() < KEPT_FOR => entry.answer.clone(),
                _ => {
                    entries.next += 1;
                    let generation = entries.next;
                    let (sender, receiver) = watch::channel(None);
                    entries.by_id.insert(id.clone(), Entry { at: Instant::now(), generation, answer: receiver.clone() });
                    entries.order.push_back((id.clone(), generation));
                    while entries.by_id.len() > KEPT {
                        if let Some((old, version)) = entries.order.pop_front() {
                            if entries.by_id.get(&old).is_some_and(|entry| entry.generation == version) {
                                entries.by_id.remove(&old);
                            }
                        }
                    }
                    // Expired/rejected replacements also leave old order entries. Keep this queue bounded even
                    // when repeated failures reuse the same id without growing the map.
                    if entries.order.len() > KEPT * 2 {
                        let current: HashMap<_, _> = entries.by_id.iter().map(|(id, entry)| (id.clone(), entry.generation)).collect();
                        entries.order.retain(|(id, generation)| current.get(id) == Some(generation));
                    }
                    let ledger = self.clone();
                    tokio::spawn(async move {
                        let result = send().await;
                        if !matches!(&result, Ok(response) if response.success) {
                            let mut entries = locked(&ledger.0);
                            if entries.by_id.get(&id).is_some_and(|entry| entry.generation == generation) {
                                entries.by_id.remove(&id);
                            }
                        }
                        sender.send_replace(Some(result));
                    });
                    receiver
                }
            }
        };
        loop {
            if let Some(result) = answer.borrow_and_update().clone() {
                return result;
            }
            if answer.changed().await.is_err() {
                return Err(Fault::new("rpc_delivery_unknown", "The delivery ended without an answer"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_dispatch::protocol::{CommandError, RpcCommand};
    use serde_json::{Value, json};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::oneshot;

    fn response(success: bool) -> RpcResponse {
        let command: RpcCommand = serde_json::from_value(json!({"type":"prompt","id":"first"})).unwrap();
        RpcResponse::local(&command, if success { Ok(Some(Value::Null)) } else { Err(CommandError::Other("refused".into())) })
    }

    #[tokio::test]
    async fn a_repeat_waits_for_the_accepted_delivery_and_never_runs_its_own_send() {
        let ledger = DeliveryLedger::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let (started, wait_started) = oneshot::channel();
        let (release, wait_release) = oneshot::channel();
        let first = tokio::spawn({
            let ledger = ledger.clone();
            let calls = calls.clone();
            async move { ledger.deliver("delivery".into(), move || async move {
                calls.fetch_add(1, Ordering::Relaxed);
                started.send(()).unwrap();
                wait_release.await.unwrap();
                Ok(response(true))
            }).await }
        });
        wait_started.await.unwrap();
        let second = tokio::spawn({
            let ledger = ledger.clone();
            async move { ledger.deliver("delivery".into(), || async { panic!("duplicate prompt reached omp") }).await }
        });
        release.send(()).unwrap();
        assert_eq!(first.await.unwrap().unwrap(), second.await.unwrap().unwrap());
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert!(ledger.known("delivery"));
    }

    #[tokio::test]
    async fn a_refusal_is_retriable_and_a_disconnected_waiter_does_not_cancel_delivery() {
        let ledger = DeliveryLedger::default();
        assert!(!ledger.deliver("rejected".into(), || async { Ok(response(false)) }).await.unwrap().success);
        assert!(!ledger.known("rejected"));
        assert!(ledger.deliver("rejected".into(), || async { Ok(response(true)) }).await.unwrap().success);
        let (started, wait_started) = oneshot::channel();
        let (release, wait_release) = oneshot::channel();
        let waiter = tokio::spawn({
            let ledger = ledger.clone();
            async move { ledger.deliver("lost-reply".into(), move || async move {
                started.send(()).unwrap();
                wait_release.await.unwrap();
                Ok(response(true))
            }).await }
        });
        wait_started.await.unwrap();
        waiter.abort();
        release.send(()).unwrap();
        assert!(ledger.deliver("lost-reply".into(), || async { panic!("delivery repeated after a lost reply") }).await.unwrap().success);
    }
}
