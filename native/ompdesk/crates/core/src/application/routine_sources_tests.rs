use super::*;
use serde_json::json;
use std::path::PathBuf;
use tokio::sync::watch;

use super::super::accounts::{SecretBox, SecretFuture};
use crate::routines::runtime::{self, Sink};

struct NoProxy;
impl machine::Proxy for NoProxy {
    fn configured(&self) -> Option<String> {
        None
    }
    fn system<'a>(&'a self, _: &'a str) -> machine::Boxed<'a, Result<String, Fault>> {
        Box::pin(async { Err(Fault::new("fixture", "No system proxy in this fixture")) })
    }
}

struct FixtureSecrets;
impl SecretBox for FixtureSecrets {
    fn available(&self) -> SecretFuture<'_, bool> {
        Box::pin(async { Ok(true) })
    }
    fn blocked(&self) -> SecretFuture<'_, bool> {
        Box::pin(async { Ok(false) })
    }
    fn encrypt<'a>(&'a self, text: &'a str) -> SecretFuture<'a, Vec<u8>> {
        Box::pin(async move { Ok(text.as_bytes().to_vec()) })
    }
    fn decrypt<'a>(&'a self, bytes: &'a [u8]) -> SecretFuture<'a, String> {
        Box::pin(async move { String::from_utf8(bytes.to_vec()).map_err(|_| ()) })
    }
}

struct Fixture {
    dir: PathBuf,
    sources: Arc<Sources>,
}
impl Fixture {
    fn new(env: machine::Environment, platform: machine::Platform) -> Self {
        let root =
            std::env::var_os("OMPDESK_RUN_TEMP").map_or_else(std::env::temp_dir, PathBuf::from);
        let dir = root.join(format!("routine-sources-{}", crate::web::router::uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        let machine = machine::Service::new(
            machine::Config {
                platform,
                home: dir.clone(),
                user_data: dir.clone(),
                tools_dir: dir.join("tools"),
                agent_desktop_bundle: None,
                core_bin: dir.join("ompdesk-core"),
                agent_dir: dir.join("agent"),
                inherited_env: env,
            },
            Arc::new(NoProxy),
        );
        let accounts = Accounts::open(&dir, Arc::new(FixtureSecrets), true);
        Self {
            dir,
            sources: Arc::new(Sources::new(machine, accounts, SessionFeed::new())),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.sources.sessions.close();
        std::fs::remove_dir_all(&self.dir).unwrap();
    }
}

fn rows(title: &str) -> Value {
    json!([
        {"tab":"peer","sessionFile":"/sessions/peer.jsonl","device":null,
         "hosted":false,"openedBy":null,"openedBySession":null,
         "facts":{"title":title,"busy":false},"sidecar":{"cwd":"/projects/app"}},
        {"tab":"paired","sessionFile":"/host/peer.jsonl","device":"remote",
         "hosted":false,"facts":{"title":"Remote"},"sidecar":{"cwd":"/host/app"}},
        {"tab":"view","hosted":true,"facts":{"title":"View"}},
        {"tab":"asleep","hosted":false,"facts":{"title":"Asleep"}}
    ])
}

#[tokio::test]
async fn same_tick_snapshots_keep_order_and_do_not_requery_later_tab_facts() {
    let feed = SessionFeed::new();
    let mut first = feed.subscribe().unwrap();
    let mut second = feed.subscribe().unwrap();
    feed.publish(json!({"type":"busy","tabId":"peer"}), rows("Working"))
        .unwrap();
    feed.publish(
        json!({"type":"idle","tabId":"peer","outcome":{"stopReason":"error","errorMessage":"failure"}}),
        rows("Finished"),
    )
    .unwrap();
    for subscription in [&mut first, &mut second] {
        let busy = subscription.events.recv().await.unwrap();
        assert!(matches!(busy.activity, Activity::Busy { tab_id } if tab_id == "peer"));
        assert_eq!(busy.tabs[0].title, "Working");
        assert_eq!(busy.tabs[0].cwd, "/projects/app");
        assert_eq!(busy.tabs[1].device.as_deref(), Some("remote"));
        assert_eq!(busy.tabs.len(), 2);
        let idle = subscription.events.recv().await.unwrap();
        assert!(
            matches!(idle.activity, Activity::Idle { outcome: Some(Outcome { stop_reason, error_message: Some(error) }), .. }
            if stop_reason == "error" && error == "failure")
        );
        assert_eq!(idle.tabs[0].title, "Finished");
    }
    drop(first);
    assert_eq!(locked(&feed.subscribers).as_ref().unwrap().senders.len(), 1);
    feed.close();
    assert!(second.events.recv().await.is_none());
    assert!(feed.subscribe().is_err());
    assert_eq!(
        feed.publish(json!({"type":"busy","tabId":"peer"}), rows("late"))
            .unwrap_err()
            .code,
        "routine_sessions_closed"
    );
}

#[tokio::test]
async fn malformed_snapshot_never_partially_notifies_and_subscription_does_not_keep_feed_alive() {
    let feed = SessionFeed::new();
    let mut subscription = feed.subscribe().unwrap();
    let mut malformed = rows("Valid");
    malformed[1]["sidecar"]["cwd"] = json!(7);
    assert!(
        feed.publish(json!({"type":"busy","tabId":"peer"}), malformed)
            .is_err()
    );
    assert!(subscription.events.try_recv().is_err());
    let weak = Arc::downgrade(&feed);
    drop(feed);
    assert!(weak.upgrade().is_none());
    assert!(subscription.events.recv().await.is_none());
}

struct Started {
    sources: Arc<Sources>,
    attached: watch::Sender<bool>,
}
impl Services for Started {
    async fn git(&self) -> Result<ToolRunner, Fault> {
        self.sources.git().await
    }
    async fn github(&self) -> Result<GithubTool, Fault> {
        self.sources.github().await
    }
    async fn mailbox(&self, name: &str) -> Result<Option<Mailbox>, Fault> {
        self.sources.mailbox(name).await
    }
    fn sessions(&self) -> Result<SessionSubscription, Fault> {
        let subscription = self.sources.sessions()?;
        self.attached.send_replace(true);
        Ok(subscription)
    }
}

#[derive(Clone)]
struct Capture(mpsc::UnboundedSender<Result<String, String>>);
impl Sink for Capture {
    fn current(&self) -> bool {
        true
    }
    fn running(&self) -> bool {
        false
    }
    fn quiet(&self) -> bool {
        true
    }
    fn publish(&self, _: Option<Value>, lines: &[String]) -> bool {
        lines
            .iter()
            .all(|line| self.0.send(Ok(line.clone())).is_ok())
    }
    fn failure(&self, _: &str, error: Option<&str>) {
        if let Some(error) = error {
            let _ = self.0.send(Err(error.to_owned()));
        }
    }
}

#[tokio::test]
async fn actual_session_driver_consumes_edges_and_cancellation_unsubscribes() {
    let fixture = Fixture::new(machine::Environment::new(), machine::Platform::Windows);
    let (attached, mut ready) = watch::channel(false);
    let services = Arc::new(Started {
        sources: Arc::clone(&fixture.sources),
        attached,
    });
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut process = runtime::start(
        services,
        &json!({"frequency":{"event":{"source":"session","events":["done","waiting","failed"],"folder":"/projects/app"}}}),
        None,
        Capture(tx),
        runtime::Config::default(),
    )
    .unwrap();
    ready.wait_for(|ready| *ready).await.unwrap();
    let feed = &fixture.sources.sessions;
    let idle = json!({"type":"idle","tabId":"peer","outcome":{"stopReason":"stop"}});
    feed.publish(idle.clone(), rows("First")).unwrap();
    feed.publish(idle.clone(), rows("Duplicate")).unwrap();
    feed.publish(json!({"type":"busy","tabId":"peer"}), rows("Running"))
        .unwrap();
    feed.publish(idle, rows("Second")).unwrap();
    assert_eq!(
        rx.recv().await.unwrap().unwrap(),
        "Session \"First\" in /projects/app finished its turn"
    );
    assert_eq!(
        rx.recv().await.unwrap().unwrap(),
        "Session \"Second\" in /projects/app finished its turn"
    );
    (process.stop)();
    process.take_done().unwrap().await;
    assert!(rx.try_recv().is_err());
    assert!(
        locked(&feed.subscribers)
            .as_ref()
            .unwrap()
            .senders
            .is_empty()
    );
}

#[tokio::test]
async fn closed_feed_is_reported_by_actual_session_driver() {
    let fixture = Fixture::new(machine::Environment::new(), machine::Platform::Windows);
    fixture.sources.sessions.close();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut process = runtime::start(
        Arc::clone(&fixture.sources),
        &json!({"frequency":{"event":{"source":"session","events":["done"]}}}),
        None,
        Capture(tx),
        runtime::Config::default(),
    )
    .unwrap();
    process.take_done().unwrap().await;
    assert_eq!(
        rx.recv().await.unwrap().unwrap_err(),
        "The native session feed is closed"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn delegates_to_actual_machine_tools_and_account_mailbox() {
    let scripts = crate::models::test_rig::Fixture::new("routine-tools");
    let git = scripts.script("git", "exit 0");
    let gh = scripts.script("gh", "exit 0");
    let shell = scripts.script(
        "login-shell",
        &format!(
            "printf '%s\\n' '__OMP_ENV_BEGIN__' 'PATH={}' '__OMP_ENV_END__'",
            scripts.dir.display()
        ),
    );
    let fixture = Fixture::new(
        machine::Environment::from([
            ("SHELL".into(), shell.to_string_lossy().into_owned()),
            ("OMP_GUI_TEST_BREW_DIRS".into(), String::new()),
            ("GIT_DIR".into(), "/foreign".into()),
        ]),
        machine::Platform::Mac,
    );
    let sources = &fixture.sources;
    let runner = sources.git().await.unwrap();
    assert_eq!(runner.bin, git.to_string_lossy());
    assert_eq!(runner.env["GIT_TERMINAL_PROMPT"], "0");
    assert!(!runner.env.contains_key("GIT_DIR"));
    let github = sources.github().await.unwrap();
    assert_eq!(github.home, fixture.dir);
    assert_eq!(github.runner.unwrap().bin, gh.to_string_lossy());
    sources
        .accounts
        .save(
            &json!({
                "label":"Routine mail","host":"imap.example.invalid","port":993,
                "username":"sample@example.invalid","mailbox":"INBOX","password":"fixture-only"
            }),
            None,
        )
        .await
        .unwrap();
    let mailbox = sources.mailbox("routine MAIL").await.unwrap().unwrap();
    assert_eq!(mailbox.label, "Routine mail");
    assert_eq!(mailbox.address, "sample@example.invalid");
    assert!(sources.mailbox("missing").await.unwrap().is_none());
}
