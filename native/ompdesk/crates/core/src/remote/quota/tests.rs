use super::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
struct Records(Mutex<HashMap<String, QuotaRecord>>);
impl QuotaStore for Records {
    fn update(
        &self,
        id: &str,
        change: &mut dyn FnMut(&mut QuotaRecord) -> bool,
    ) -> Result<bool, Fault> {
        let mut records = self.0.lock().unwrap();
        let Some(record) = records.get_mut(id) else {
            return Ok(false);
        };
        change(record);
        Ok(true)
    }
}

fn quota() -> (PeerQuota, Arc<AtomicU64>) {
    let records = Arc::new(Records::default());
    records
        .0
        .lock()
        .unwrap()
        .insert("device".into(), QuotaRecord::default());
    let day = Arc::new(AtomicU64::new(14));
    let now = Arc::clone(&day);
    (
        PeerQuota {
            store: records,
            day: Arc::new(move || format!("2026-11-{}", now.load(Ordering::SeqCst))),
        },
        day,
    )
}

#[test]
fn concurrent_weighted_reservations_are_atomic_and_refund_is_consuming() {
    let (quota, _) = quota();
    quota
        .set_limits(
            "device",
            Limits {
                requests_per_day: Some(10.0),
                tokens_per_day: None,
            },
        )
        .unwrap();
    quota.record("device", 9.0, 0.0).unwrap();
    let outcomes = std::thread::scope(|scope| {
        let threads: Vec<_> = (0..12)
            .map(|_| scope.spawn(|| quota.reserve("device", 1.0)))
            .collect();
        threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>()
    });
    let mut accepted = outcomes.into_iter().filter_map(Result::ok);
    let receipt = accepted.next().unwrap();
    assert!(accepted.next().is_none());
    assert_eq!(quota.usage("device").unwrap().requests, 10.0);
    receipt.refund().unwrap();
    assert_eq!(quota.usage("device").unwrap().requests, 9.0);
    assert_eq!(
        quota.reserve("device", 2.0).err().unwrap().code,
        "remote_limit_reached"
    );
    assert_eq!(quota.usage("device").unwrap().requests, 9.0);
}

#[test]
fn midnight_refund_cannot_take_from_a_new_day_and_tokens_stop_the_next_request() {
    let (quota, day) = quota();
    quota
        .set_limits(
            "device",
            Limits {
                requests_per_day: Some(5.0),
                tokens_per_day: Some(100.0),
            },
        )
        .unwrap();
    let previous = quota.reserve("device", 3.0).unwrap();
    day.store(15, Ordering::SeqCst);
    let current = quota.reserve("device", 1.0).unwrap();
    previous.refund().unwrap();
    assert_eq!(quota.usage("device").unwrap().requests, 1.0);
    quota.record("device", 0.0, 120.0).unwrap();
    assert_eq!(
        quota.reserve("device", 1.0).err().unwrap().message,
        "This device's token limit for today on this computer's models is used up."
    );
    current.refund().unwrap();
    assert_eq!(quota.usage("device").unwrap().tokens, 120.0);
    assert_eq!(quota.usage("device").unwrap().requests, 0.0);
    quota.set_limits("device", Limits::default()).unwrap();
    assert!(quota.reserve("device", 100.0).is_ok());
}

#[test]
fn unknown_device_has_no_record_and_limits_cannot_create_one() {
    let (quota, _) = quota();
    quota.reserve("unknown", 10.0).unwrap().refund().unwrap();
    assert_eq!(quota.usage("unknown").unwrap().requests, 0.0);
    assert!(!quota.set_limits("unknown", Limits::default()).unwrap());
}

#[test]
fn peer_usage_survives_reopening_the_existing_store() {
    let root = std::env::temp_dir().join(format!(
        "ompdesk-native-quota-{}-{}",
        std::process::id(),
        crate::remote::next_id()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let store = super::super::store::open(&root, super::super::store::Kind::Peers);
    store.lock().unwrap().put(json!({"deviceId":"device","name":"test","staticPub":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","nodeId":"node","login":null,"pairedAt":0})
        .as_object().unwrap().clone()).unwrap();
    let quota = PeerQuota::new(Arc::new(PeerStore(Arc::clone(&store))));
    quota
        .set_limits(
            "device",
            Limits {
                requests_per_day: Some(5.0),
                tokens_per_day: None,
            },
        )
        .unwrap();
    drop(quota.reserve("device", 4.0).unwrap());
    quota.record("device", 0.0, 42.0).unwrap();
    store.lock().unwrap().reload();
    let reopened = PeerQuota::new(Arc::new(PeerStore(store)));
    assert_eq!(reopened.usage("device").unwrap().requests, 4.0);
    assert_eq!(reopened.usage("device").unwrap().tokens, 42.0);
    assert!(reopened.reserve("device", 2.0).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn conditional_commands_and_unknown_commands_preserve_model_policy() {
    for (command, charged) in [
        (json!({"type":"prompt"}), true),
        (json!({"type":"not_in_this_build"}), true),
        (json!({"type":"get_state"}), false),
        (json!({"type":"bash"}), false),
        (json!({"type":"switch_leaf"}), false),
        (json!({"type":"switch_leaf","summarize":true}), true),
        (
            json!({"type":"plan_approval","approved":true,"option":"save"}),
            false,
        ),
        (
            json!({"type":"plan_approval","approved":true,"option":"execute"}),
            true,
        ),
        (
            json!({"type":"plan_approval","approved":false,"feedback":" \t\u{3000}"}),
            false,
        ),
        (
            json!({"type":"plan_approval","approved":false,"feedback":"revise"}),
            true,
        ),
        (json!({"type":"set_goal","objective":" \n"}), false),
        (json!({"type":"set_goal","objective":"do it"}), true),
        (json!({"type":"set_goal","action":"resume"}), true),
        (json!({"type":"set_autopilot","action":"start"}), true),
        (json!({"type":"set_autopilot","action":"resume"}), true),
        (json!({"type":"set_autopilot","action":"pause"}), false),
    ] {
        assert_eq!(command_uses_model(&command), charged, "{command}");
    }
    assert_eq!(
        assistant_tokens(
            &json!({"type":"message_end","message":{"role":"assistant","usage":{"totalTokens":17}}})
        ),
        17.0
    );
    assert_eq!(
        assistant_tokens(
            &json!({"type":"message_end","message":{"role":"toolResult","usage":{"totalTokens":17}}})
        ),
        0.0
    );
    assert_eq!(
        assistant_tokens(
            &json!({"type":"message_update","message":{"role":"assistant","usage":{"totalTokens":17}}})
        ),
        0.0
    );
}
