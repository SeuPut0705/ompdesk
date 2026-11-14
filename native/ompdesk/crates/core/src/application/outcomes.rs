use std::collections::HashMap;
use std::sync::Arc;

use crate::server::Fault;
use crate::web::notifier::Outcome;

#[derive(Hash, PartialEq, Eq)]
pub struct TabGeneration {
    pub generation: u64,
    pub tab: String,
}

struct Current {
    id: u64,
    outcome: Arc<Outcome>,
}

/// Keeps the current run alive after the notifier retains only its Weak identity.
#[derive(Default)]
pub struct Outcomes {
    current: HashMap<TabGeneration, Current>,
}

impl Outcomes {
    pub fn idle(
        &mut self,
        key: TabGeneration,
        id: Option<u64>,
        outcome: Option<Outcome>,
    ) -> Result<Option<Arc<Outcome>>, Fault> {
        match (id, outcome) {
            (Some(id), Some(outcome)) => {
                if let Some(current) = self.current.get(&key)
                    && current.id == id
                {
                    return Ok(Some(Arc::clone(&current.outcome)));
                }
                let outcome = Arc::new(outcome);
                self.current.insert(
                    key,
                    Current {
                        id,
                        outcome: Arc::clone(&outcome),
                    },
                );
                Ok(Some(outcome))
            }
            (None, None) => {
                self.current.remove(&key);
                Ok(None)
            }
            _ => Err(Fault::new(
                "native_outcome",
                "The pool outcome and its native identity disagree",
            )),
        }
    }

    pub fn release(&mut self, key: &TabGeneration) {
        self.current.remove(key);
    }

    pub fn clear(&mut self) {
        self.current.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web::devices::Device;
    use crate::web::notification_batch::Text;
    use crate::web::notifier::{Activity, Context, Notifier, TabFacts};

    struct ContextWithoutDevices;
    impl Text for ContextWithoutDevices {
        fn text(&self, key: &str, _: &[(&str, String)]) -> String {
            key.to_owned()
        }
    }
    impl Context for ContextWithoutDevices {
        fn devices(&self) -> Vec<Device> {
            Vec::new()
        }
        fn device(&self, _: &str) -> Option<Device> {
            None
        }
        fn visible(&self, _: &str) -> bool {
            false
        }
        fn tab(&self, _: &str) -> Option<TabFacts> {
            Some(TabFacts {
                title: "Session".into(),
                busy: false,
                awaiting_connection: false,
                retrying: false,
            })
        }
    }

    fn key(generation: u64) -> TabGeneration {
        TabGeneration {
            generation,
            tab: "tab".into(),
        }
    }
    fn outcome() -> Outcome {
        Outcome {
            stop_reason: "stop".into(),
            reply: Some("done".into()),
            error_message: None,
        }
    }

    #[test]
    fn repeated_idle_after_debounce_does_not_schedule_another_notification() {
        let mut current = Outcomes::default();
        let mut notifier = Notifier::default();
        let context = ContextWithoutDevices;
        notifier.handle(
            Activity::Idle {
                tab: "tab".into(),
                outcome: current.idle(key(1), Some(7), Some(outcome())).unwrap(),
            },
            0,
            &context,
        );
        notifier.advance(1500, &context);
        assert_eq!(notifier.next_due(), None);
        notifier.handle(
            Activity::Idle {
                tab: "tab".into(),
                outcome: current.idle(key(1), Some(7), Some(outcome())).unwrap(),
            },
            2000,
            &context,
        );
        assert_eq!(notifier.next_due(), None);
        notifier.handle(
            Activity::Idle {
                tab: "tab".into(),
                outcome: current.idle(key(1), Some(8), Some(outcome())).unwrap(),
            },
            3000,
            &context,
        );
        assert_eq!(notifier.next_due(), Some(4500));
    }

    #[test]
    fn release_and_generation_replacement_do_not_reuse_an_old_outcome_identity() {
        let mut current = Outcomes::default();
        let old = current
            .idle(key(1), Some(7), Some(outcome()))
            .unwrap()
            .unwrap();
        let next = current
            .idle(key(2), Some(7), Some(outcome()))
            .unwrap()
            .unwrap();
        assert!(!Arc::ptr_eq(&old, &next));
        let weak = Arc::downgrade(&old);
        drop(old);
        current.release(&key(1));
        assert!(weak.upgrade().is_none());
        current.clear();
        assert!(current.idle(key(2), None, Some(outcome())).is_err());
    }
}
