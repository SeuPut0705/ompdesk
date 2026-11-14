use super::super::devices::{DEFAULT_GRANTS, Devices, MemoryDevices, NewDevice, PushSettings};
use super::*;
use std::sync::Mutex;

struct World {
    devices: Mutex<Vec<Device>>,
    visible: Mutex<HashSet<String>>,
    facts: Mutex<HashMap<String, TabFacts>>,
    language: &'static str,
}
impl Text for World {
    fn text(&self, key: &str, params: &[(&str, String)]) -> String {
        super::super::notification_fixture::text(key, self.language, params)
    }
}
impl Context for World {
    fn devices(&self) -> Vec<Device> {
        self.devices.lock().unwrap().clone()
    }
    fn device(&self, id: &str) -> Option<Device> {
        self.devices
            .lock()
            .unwrap()
            .iter()
            .find(|d| d.device_id == id)
            .cloned()
    }
    fn visible(&self, id: &str) -> bool {
        self.visible.lock().unwrap().contains(id)
    }
    fn tab(&self, id: &str) -> Option<TabFacts> {
        self.facts.lock().unwrap().get(id).map(|f| TabFacts {
            title: f.title.clone(),
            busy: f.busy,
            awaiting_connection: f.awaiting_connection,
            retrying: f.retrying,
        })
    }
}
impl World {
    fn new() -> Self {
        Self {
            devices: Mutex::default(),
            visible: Mutex::default(),
            facts: Mutex::default(),
            language: "en",
        }
    }
    fn phone(&self, id: &str, private: bool, categories: &[&str]) {
        let (mut device, _) = MemoryDevices::default().create(
            NewDevice {
                name: id.into(),
                user_agent: "Browser".into(),
                tailscale_login: None,
                node_id: None,
                public_key: None,
                grants: DEFAULT_GRANTS.iter().map(|s| (*s).to_owned()).collect(),
            },
            0,
        );
        device.device_id = id.into();
        device.push = Some(PushSettings {
            hide_content: private,
            categories: categories.iter().map(|s| (*s).to_owned()).collect(),
            subscription: Some(PushSubscription {
                endpoint: format!("https://push.example.invalid/{id}"),
                p256dh: "key".into(),
                auth: "key".into(),
            }),
        });
        self.devices.lock().unwrap().push(device);
    }
    fn tab(&self, id: &str, title: &str) {
        self.facts.lock().unwrap().insert(
            id.into(),
            TabFacts {
                title: title.into(),
                busy: false,
                awaiting_connection: false,
                retrying: false,
            },
        );
    }
}
fn done(reply: &str) -> Arc<Outcome> {
    Arc::new(Outcome {
        stop_reason: "stop".into(),
        reply: Some(reply.into()),
        error_message: None,
    })
}
fn ask(tab: &str, request: &str) -> Activity {
    Activity::Ask {
        tab: tab.into(),
        request: request.into(),
        text: "Secret question".into(),
    }
}

#[test]
fn privacy_visibility_categories_and_summary_never_leak_names() {
    let world = World::new();
    world.phone("private", true, &["ask", "completion", "error"]);
    world.phone("visible", false, &["ask", "completion"]);
    world.phone("off", false, &[]);
    world.visible.lock().unwrap().insert("visible".into());
    world.tab("a", "Secret A");
    world.tab("b", "Secret B");
    let mut notifier = Notifier::default();
    let mut sent = notifier.handle(ask("a", "q1"), 0, &world);
    sent.extend(notifier.handle(ask("b", "q2"), 1, &world));
    sent.extend(notifier.advance(4000, &world));
    assert_eq!(sent.len(), 2);
    assert!(sent.iter().all(|d| d.device == "private"));
    let payloads =
        serde_json::to_string(&sent.iter().map(|d| &d.payload).collect::<Vec<_>>()).unwrap();
    assert!(!payloads.contains("Secret"));
    assert_eq!(sent[0].payload["title"], "A task needs you");
    assert_eq!(
        sent[1].payload,
        json!({"v":1,"kind":"batch","title":"2 need you","body":"","tag":"tab:a","silent":true})
    );
    assert_eq!(sent[1].options.ttl, 21600);
    assert_eq!(sent[1].options.urgency, Urgency::High);
    world.visible.lock().unwrap().insert("private".into());
    assert!(
        notifier
            .handle(
                Activity::AskClosed {
                    request: "q1".into()
                },
                5000,
                &world
            )
            .is_empty()
    );
    assert!(
        notifier
            .handle(
                Activity::AskClosed {
                    request: "q2".into()
                },
                5000,
                &world
            )
            .is_empty()
    );
}

#[test]
fn debounce_checks_live_facts_and_dedups_the_same_run_not_equal_replies() {
    let world = World::new();
    world.phone("phone", false, &["completion", "error"]);
    world.tab("a", "Task");
    let mut notifier = Notifier::default();
    let outcome = done("## Summary\n- **Fixed** the `parser`.");
    notifier.handle(
        Activity::Idle {
            tab: "a".into(),
            outcome: Some(outcome.clone()),
        },
        0,
        &world,
    );
    assert!(notifier.advance(1499, &world).is_empty());
    let sent = notifier.advance(1500, &world);
    assert_eq!(sent[0].payload["body"], "Summary Fixed the parser.");
    notifier.handle(
        Activity::Idle {
            tab: "a".into(),
            outcome: Some(outcome),
        },
        2000,
        &world,
    );
    assert!(notifier.advance(3500, &world).is_empty());
    notifier.advance(5500, &world);
    notifier.handle(
        Activity::Idle {
            tab: "a".into(),
            outcome: Some(done("Same text")),
        },
        6000,
        &world,
    );
    notifier.handle(Activity::Busy { tab: "a".into() }, 6100, &world);
    assert!(notifier.advance(8000, &world).is_empty());
    for state in 0..4 {
        notifier.handle(
            Activity::Idle {
                tab: "a".into(),
                outcome: Some(done("Same text")),
            },
            9000,
            &world,
        );
        let mut facts = world.facts.lock().unwrap();
        let tab = facts.get_mut("a").unwrap();
        tab.busy = state == 0;
        tab.awaiting_connection = state == 1;
        tab.retrying = state == 2;
        if state == 3 {
            facts.remove("a");
        }
        drop(facts);
        assert!(notifier.advance(10500, &world).is_empty());
        world.tab("a", "Task");
    }
    let aborted = Arc::new(Outcome {
        stop_reason: "aborted".into(),
        reply: None,
        error_message: None,
    });
    notifier.handle(
        Activity::Idle {
            tab: "a".into(),
            outcome: Some(aborted),
        },
        11000,
        &world,
    );
    assert!(notifier.advance(12500, &world).is_empty());
    notifier.handle(
        Activity::Idle {
            tab: "a".into(),
            outcome: Some(done("Same text")),
        },
        13000,
        &world,
    );
    assert_eq!(
        notifier.advance(14500, &world)[0].payload["body"],
        "Same text"
    );
}

#[test]
fn asks_clear_once_retract_summaries_and_keep_other_open_asks() {
    let world = World::new();
    world.phone("phone", false, &["ask", "completion"]);
    world.tab("a", "A");
    world.tab("b", "B");
    let mut notifier = Notifier::default();
    assert_eq!(notifier.handle(ask("a", "q1"), 0, &world).len(), 1);
    assert!(notifier.handle(ask("a", "q1"), 1, &world).is_empty());
    notifier.advance(4000, &world);
    assert_eq!(notifier.handle(ask("a", "q2"), 5000, &world).len(), 1);
    assert!(
        notifier
            .handle(
                Activity::AskClosed {
                    request: "q1".into()
                },
                5001,
                &world
            )
            .is_empty()
    );
    let cleared = notifier.handle(
        Activity::AskClosed {
            request: "q2".into(),
        },
        5002,
        &world,
    );
    assert_eq!(
        cleared[0].payload,
        json!({"v":1,"kind":"clear","title":"","body":"","tabId":"a","tag":"tab:a","silent":true})
    );
    assert_eq!(cleared[0].options.ttl, 120);
    assert!(
        notifier
            .handle(
                Activity::AskClosed {
                    request: "q2".into()
                },
                5003,
                &world
            )
            .is_empty()
    );
    notifier.advance(9000, &world);
    notifier.handle(
        Activity::Idle {
            tab: "a".into(),
            outcome: Some(done("done")),
        },
        10000,
        &world,
    );
    notifier.advance(11500, &world);
    notifier.handle(ask("b", "q3"), 12000, &world);
    notifier.handle(
        Activity::AskClosed {
            request: "q3".into(),
        },
        12001,
        &world,
    );
    let sent = notifier.advance(15500, &world);
    assert_eq!(sent[0].payload["title"], "1 task finished");
    assert_eq!(sent[0].payload["tabId"], "a");
}

#[test]
fn revoked_devices_released_tabs_dispose_and_korean_error_privacy() {
    let mut world = World::new();
    world.language = "ko";
    world.phone("phone", true, &["error", "ask"]);
    world.tab("a", "Secret");
    let mut notifier = Notifier::default();
    let error = Arc::new(Outcome {
        stop_reason: "error".into(),
        reply: None,
        error_message: Some("private error".into()),
    });
    notifier.handle(
        Activity::Idle {
            tab: "a".into(),
            outcome: Some(error),
        },
        0,
        &world,
    );
    let sent = notifier.advance(1500, &world);
    assert_eq!(sent[0].payload["title"], "작업이 오류로 중단됐어요");
    assert_eq!(sent[0].payload["body"], "");
    notifier.handle(ask("a", "q1"), 2000, &world);
    notifier.drop_device("phone");
    world.devices.lock().unwrap().clear();
    assert!(notifier.advance(6000, &world).is_empty());
    assert!(
        notifier
            .handle(Activity::Released { tab: "a".into() }, 7000, &world)
            .is_empty()
    );
    notifier.dispose();
    assert_eq!(notifier.next_due(), None);
}
