//! The process-wide deliveryId ledger (was `src/main/delivery-ledger.ts`). Local page RPC and hosted RPC inject
//! the same Arc, so a lost answer never causes a second reservation or a second prompt in this process.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::watch;

use super::requests::RemoteError;
use crate::server::Fault;

const KEPT: usize = 2000;
const KEPT_FOR: Duration = Duration::from_secs(24 * 60 * 60);
type ResultValue = Result<Value, RemoteError>;

struct Entry {
    serial: u64,
    at: Instant,
    answer: watch::Receiver<Option<ResultValue>>,
}
#[derive(Default)]
struct Entries {
    serial: u64,
    values: HashMap<String, Entry>,
    order: VecDeque<(String, u64)>,
}
#[derive(Clone, Default)]
pub struct DeliveryLedger(Arc<Mutex<Entries>>);

impl DeliveryLedger {
    pub fn known(&self, id: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values
            .get(id)
            .is_some_and(|entry| entry.at.elapsed() < KEPT_FOR)
    }

    pub async fn run<F, R>(&self, id: String, work: F) -> ResultValue
    where
        F: FnOnce() -> R + Send + 'static,
        R: Future<Output = ResultValue> + Send + 'static,
    {
        let mut answer = {
            let mut entries = self.0.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(entry) = entries
                .values
                .get(&id)
                .filter(|entry| entry.at.elapsed() < KEPT_FOR)
            {
                entry.answer.clone()
            } else {
                entries.serial += 1;
                let serial = entries.serial;
                let (sender, answer) = watch::channel(None);
                entries.values.insert(
                    id.clone(),
                    Entry {
                        serial,
                        at: Instant::now(),
                        answer: answer.clone(),
                    },
                );
                entries.order.push_back((id.clone(), serial));
                while entries.order.len() > KEPT {
                    if let Some((old, serial)) = entries.order.pop_front()
                        && entries
                            .values
                            .get(&old)
                            .is_some_and(|entry| entry.serial == serial)
                    {
                        entries.values.remove(&old);
                    }
                }
                let ledger = self.clone();
                tokio::spawn(async move {
                    let result = work().await;
                    if !result
                        .as_ref()
                        .is_ok_and(|response| response["success"] == true)
                    {
                        let mut entries = ledger.0.lock().unwrap_or_else(|p| p.into_inner());
                        if entries
                            .values
                            .get(&id)
                            .is_some_and(|entry| entry.serial == serial)
                        {
                            entries.values.remove(&id);
                        }
                    }
                    sender.send_replace(Some(result));
                });
                answer
            }
        };
        loop {
            if let Some(result) = answer.borrow_and_update().clone() {
                return result;
            }
            if answer.changed().await.is_err() {
                return Err(Fault::new(
                    "rpc_delivery_unknown",
                    "The RPC delivery ended without an answer",
                )
                .into());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[tokio::test]
    async fn concurrent_retries_share_work_and_a_refusal_can_be_tried_again() {
        let ledger = DeliveryLedger::default();
        let called = Arc::new(AtomicUsize::new(0));
        let send = || {
            let called = Arc::clone(&called);
            move || async move {
                called.fetch_add(1, Ordering::SeqCst);
                Ok(json!({"success":true,"data":"accepted"}))
            }
        };
        let (one, two) = tokio::join!(
            ledger.run("id".into(), send()),
            ledger.run("id".into(), send())
        );
        assert_eq!(one.unwrap(), two.unwrap());
        assert_eq!(called.load(Ordering::SeqCst), 1);
        assert!(ledger.known("id"));
        ledger
            .run("refused".into(), || async { Ok(json!({"success":false})) })
            .await
            .unwrap();
        assert!(!ledger.known("refused"));
        assert_eq!(
            ledger
                .run("refused".into(), || async { Ok(json!({"success":true})) })
                .await
                .unwrap()["success"],
            true
        );
    }
}
