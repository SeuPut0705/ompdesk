use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::{mpsc, watch};

type Publication = (Option<Value>, Vec<String>);

#[derive(Clone)]
struct Capture {
    current: Arc<AtomicBool>,
    quiet: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    events: mpsc::UnboundedSender<Publication>,
}
impl Capture {
    fn new() -> (Self, mpsc::UnboundedReceiver<Publication>) {
        let (events, rx) = mpsc::unbounded_channel();
        (
            Self {
                current: Arc::new(AtomicBool::new(true)),
                quiet: Arc::new(AtomicBool::new(false)),
                running: Arc::new(AtomicBool::new(false)),
                events,
            },
            rx,
        )
    }
}
impl Sink for Capture {
    fn current(&self) -> bool {
        self.current.load(Ordering::SeqCst)
    }
    fn running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
    fn quiet(&self) -> bool {
        self.quiet.load(Ordering::SeqCst)
    }
    fn publish(&self, mark: Option<Value>, lines: &[String]) -> bool {
        if !self.current() {
            return false;
        }
        self.events.send((mark, lines.to_vec())).is_ok()
    }
    fn failure(&self, _: &str, error: Option<&str>) {
        if let Some(error) = error {
            panic!("source failed: {error}");
        }
    }
}
struct Fixture {
    session: Mutex<Option<mpsc::UnboundedReceiver<SessionNotice>>>,
    attached: watch::Sender<bool>,
    stopped: Arc<AtomicUsize>,
}
impl Fixture {
    fn new() -> (Arc<Self>, mpsc::UnboundedSender<SessionNotice>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Arc::new(Self {
                session: Mutex::new(Some(rx)),
                attached: watch::channel(false).0,
                stopped: Arc::new(AtomicUsize::new(0)),
            }),
            tx,
        )
    }
}
impl Services for Fixture {
    async fn git(&self) -> Result<ToolRunner, Fault> {
        Err(Fault::new("fixture", "unexpected git source"))
    }
    async fn github(&self) -> Result<GithubTool, Fault> {
        Err(Fault::new("fixture", "unexpected GitHub source"))
    }
    fn sessions(&self) -> Result<SessionSubscription, Fault> {
        let rx = locked(&self.session).take().unwrap();
        self.attached.send_replace(true);
        let stopped = Arc::clone(&self.stopped);
        Ok(SessionSubscription::new(
            rx,
            Arc::new(move || {
                stopped.fetch_add(1, Ordering::SeqCst);
            }),
        ))
    }
    async fn mailbox(&self, _: &str) -> Result<Option<Mailbox>, Fault> {
        Err(Fault::new("fixture", "unexpected mail source"))
    }
}
fn tab(id: &str) -> SessionTab {
    SessionTab {
        tab_id: id.into(),
        session_file: Some(format!("/{id}.jsonl")),
        cwd: "/fixture/project".into(),
        title: id.into(),
        device: None,
        opened_by: None,
        opened_by_session: None,
    }
}

#[tokio::test]
async fn session_driver_deduplicates_edges_excludes_own_family_and_unsubscribes_on_stop() {
    let (services, tx) = Fixture::new();
    let (sink, mut rx) = Capture::new();
    let schedule = json!({"wakeSession":"/owner.jsonl","frequency":{"event":{"source":"session","events":["done","waiting","failed"]}}});
    let mut process = start(
        Arc::clone(&services),
        &schedule,
        None,
        sink,
        Config::default(),
    )
    .unwrap();
    services
        .attached
        .subscribe()
        .wait_for(|attached| *attached)
        .await
        .unwrap();
    let done = |id: &str| Activity::Idle {
        tab_id: id.into(),
        outcome: Some(Outcome {
            stop_reason: "stop".into(),
            error_message: None,
        }),
    };
    let owner = tab("owner");
    let mut child = tab("child");
    child.opened_by = Some("owner".into());
    let peer = tab("peer");
    let mut remote = tab("remote");
    remote.device = Some("paired".into());
    let tabs = vec![owner, child, peer, remote];
    for activity in [
        done("owner"),
        done("child"),
        done("remote"),
        done("peer"),
        done("peer"),
        Activity::Ask {
            tab_id: "peer".into(),
            request_id: "q1".into(),
            text: "Proceed?".into(),
        },
        Activity::Ask {
            tab_id: "peer".into(),
            request_id: "q1".into(),
            text: "Proceed?".into(),
        },
        Activity::Busy {
            tab_id: "peer".into(),
        },
        done("peer"),
    ] {
        tx.send(SessionNotice {
            activity,
            tabs: tabs.clone(),
        })
        .unwrap();
    }
    assert!(rx.recv().await.unwrap().1[0].contains("finished its turn"));
    assert!(rx.recv().await.unwrap().1[0].contains("Proceed?"));
    assert!(rx.recv().await.unwrap().1[0].contains("finished its turn"));
    (process.stop)();
    process.take_done().unwrap().await;
    assert_eq!(services.stopped.load(Ordering::SeqCst), 1);
    assert!(
        tx.send(SessionNotice {
            activity: done("peer"),
            tabs
        })
        .is_err()
    );
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn native_file_driver_delivers_a_real_write_then_joins_its_watcher() {
    let dir = crate::fs::disk::make_temp_dir("ompdesk-routine-watch-").unwrap();
    let (services, _) = Fixture::new();
    let (sink, mut rx) = Capture::new();
    let schedule = json!({"frequency":{"event":{"source":"files","path":dir.to_string_lossy()}}});
    let config = Config {
        file_debounce: Duration::from_millis(5),
        scan_poll: Duration::from_millis(5),
        ..Config::default()
    };
    let mut process = start(services, &schedule, None, sink, config).unwrap();
    let (mark, lines) = rx.recv().await.unwrap();
    assert!(mark.is_some());
    assert!(lines.is_empty());
    std::fs::write(dir.join("changed.txt"), "new contents").unwrap();
    loop {
        let (_, lines) = rx.recv().await.unwrap();
        if !lines.is_empty() {
            assert!(lines[0].contains("changed.txt"));
            break;
        }
    }
    (process.stop)();
    process.take_done().unwrap().await;
    std::fs::remove_dir_all(dir).unwrap();
}
struct GitFixture;
impl Services for GitFixture {
    async fn git(&self) -> Result<ToolRunner, Fault> {
        Ok(crate::git::run::tests::runner())
    }
    async fn github(&self) -> Result<GithubTool, Fault> {
        Err(Fault::new("fixture", "unexpected GitHub source"))
    }
    fn sessions(&self) -> Result<SessionSubscription, Fault> {
        Err(Fault::new("fixture", "unexpected session source"))
    }
    async fn mailbox(&self, _: &str) -> Result<Option<Mailbox>, Fault> {
        Err(Fault::new("fixture", "unexpected email source"))
    }
}

#[tokio::test]
async fn git_run_completion_rebases_own_commits_before_external_changes_can_fire() {
    let dir = crate::fs::disk::make_temp_dir("ompdesk-routine-git-").unwrap();
    let git = crate::git::run::tests::git();
    let cwd = dir.to_str().unwrap();
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.name", "Fixture"],
        vec!["config", "user.email", "fixture@example.invalid"],
        vec!["config", "commit.gpgsign", "false"],
        vec!["config", "maintenance.auto", "0"],
        vec!["commit", "--allow-empty", "-qm", "baseline"],
    ] {
        git.text(cwd, &args).await.unwrap();
    }
    let (sink, mut events) = Capture::new();
    let schedule = json!({"frequency":{"event":{"source":"git","repo":dir.to_string_lossy(),"branch":"main"}}});
    let mut process = start(
        Arc::new(GitFixture),
        &schedule,
        None,
        sink.clone(),
        Config {
            git_poll: Duration::from_millis(5),
            ..Config::default()
        },
    )
    .unwrap();
    assert!(events.recv().await.unwrap().1.is_empty());
    sink.running.store(true, Ordering::SeqCst);
    git.text(
        cwd,
        &["commit", "--allow-empty", "-qm", "own routine output"],
    )
    .await
    .unwrap();
    let own = git
        .text(cwd, &["rev-parse", "HEAD"])
        .await
        .unwrap()
        .trim()
        .to_owned();
    sink.running.store(false, Ordering::SeqCst);
    (process.run_ended.as_ref().unwrap())();
    let (mark, lines) = events.recv().await.unwrap();
    assert_eq!(mark.unwrap()["head"], own);
    assert!(lines.is_empty());
    git.text(cwd, &["commit", "--allow-empty", "-qm", "external change"])
        .await
        .unwrap();
    loop {
        let (_, lines) = events.recv().await.unwrap();
        if !lines.is_empty() {
            assert!(lines[0].contains("external change"));
            assert!(!lines[0].contains("own routine output"));
            break;
        }
    }
    (process.stop)();
    process.take_done().unwrap().await;
    std::fs::remove_dir_all(dir).unwrap();
}
struct GithubFixture {
    script: PathBuf,
    data: PathBuf,
    home: PathBuf,
}
impl Services for GithubFixture {
    async fn git(&self) -> Result<ToolRunner, Fault> {
        Err(Fault::new("fixture", "unexpected git source"))
    }
    async fn github(&self) -> Result<GithubTool, Fault> {
        let (bin, args) = if cfg!(windows) {
            (
                "cmd.exe".to_owned(),
                vec![
                    "/d".into(),
                    "/c".into(),
                    self.script.to_string_lossy().into_owned(),
                    self.data.to_string_lossy().into_owned(),
                ],
            )
        } else {
            (
                "/bin/sh".into(),
                vec![
                    self.script.to_string_lossy().into_owned(),
                    self.data.to_string_lossy().into_owned(),
                ],
            )
        };
        Ok(GithubTool {
            runner: Some(ToolRunner {
                bin,
                args,
                env: std::env::vars()
                    .filter(|(key, _)| !key.starts_with("GH_") && !key.starts_with("GITHUB_"))
                    .collect(),
                timeout_ms: 5000,
                max_bytes: 100_000,
            }),
            home: self.home.clone(),
        })
    }
    fn sessions(&self) -> Result<SessionSubscription, Fault> {
        Err(Fault::new("fixture", "unexpected session source"))
    }
    async fn mailbox(&self, _: &str) -> Result<Option<Mailbox>, Fault> {
        Err(Fault::new("fixture", "unexpected email source"))
    }
}

#[tokio::test]
async fn github_driver_restores_the_persisted_baseline_and_never_replays_old_rows() {
    let dir = crate::fs::disk::make_temp_dir("ompdesk-routine-gh-").unwrap();
    let data = dir.join("rows.json");
    let script = dir.join(if cfg!(windows) {
        "fixture.cmd"
    } else {
        "fixture.sh"
    });
    std::fs::write(
        &script,
        if cfg!(windows) {
            "@type %1\r\n"
        } else {
            "cat \"$1\"\n"
        },
    )
    .unwrap();
    let services = Arc::new(GithubFixture {
        script,
        data: data.clone(),
        home: dir.clone(),
    });
    let schedule =
        json!({"frequency":{"event":{"source":"github","repo":"fixture/repo","events":["issue"]}}});
    std::fs::write(
        &data,
        r#"[{"id":1,"number":1,"title":"old","html_url":"https://example.invalid/1"}]"#,
    )
    .unwrap();
    let (sink, mut events) = Capture::new();
    let mut process = start(
        Arc::clone(&services),
        &schedule,
        None,
        sink,
        Config {
            github_poll: Duration::from_millis(5),
            ..Config::default()
        },
    )
    .unwrap();
    let (mark, lines) = events.recv().await.unwrap();
    assert!(lines.is_empty());
    (process.stop)();
    process.take_done().unwrap().await;
    std::fs::write(&data, r#"[{"id":2,"number":2,"title":"new issue","html_url":"https://example.invalid/2"},{"id":1,"number":1,"title":"old","html_url":"https://example.invalid/1"}]"#).unwrap();
    let (sink, mut events) = Capture::new();
    let mut process = start(services, &schedule, mark, sink, Config::default()).unwrap();
    let (_, lines) = events.recv().await.unwrap();
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("new issue"));
    (process.stop)();
    process.take_done().unwrap().await;
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn quiet_file_writes_update_the_relaunch_mark_without_firing() {
    let dir = crate::fs::disk::make_temp_dir("ompdesk-routine-quiet-").unwrap();
    let (services, _) = Fixture::new();
    let (sink, mut rx) = Capture::new();
    sink.quiet.store(true, Ordering::SeqCst);
    let schedule = json!({"frequency":{"event":{"source":"files","path":dir.to_string_lossy()}}});
    let config = Config {
        file_debounce: Duration::from_millis(5),
        scan_poll: Duration::from_millis(5),
        ..Config::default()
    };
    let mut process = start(Arc::clone(&services), &schedule, None, sink, config).unwrap();
    rx.recv().await.unwrap();
    std::fs::write(dir.join("own.txt"), "routine output").unwrap();
    let mark = loop {
        let (mark, lines) = rx.recv().await.unwrap();
        assert!(lines.is_empty());
        if mark
            .as_ref()
            .is_some_and(|mark| mark["listing"]["entries"].get("own.txt").is_some())
        {
            break mark;
        }
    };
    (process.stop)();
    process.take_done().unwrap().await;
    while let Ok((_, lines)) = rx.try_recv() {
        assert!(lines.is_empty());
    }
    let (sink, mut rx) = Capture::new();
    let mut process = start(services, &schedule, mark, sink, config).unwrap();
    assert!(rx.recv().await.unwrap().1.is_empty());
    (process.stop)();
    process.take_done().unwrap().await;
    while let Ok((_, lines)) = rx.try_recv() {
        assert!(lines.is_empty());
    }
    std::fs::remove_dir_all(dir).unwrap();
}

struct PendingGit {
    entered: watch::Sender<bool>,
}
impl Services for PendingGit {
    async fn git(&self) -> Result<ToolRunner, Fault> {
        self.entered.send_replace(true);
        std::future::pending().await
    }
    async fn github(&self) -> Result<GithubTool, Fault> {
        panic!("not used")
    }
    fn sessions(&self) -> Result<SessionSubscription, Fault> {
        panic!("not used")
    }
    async fn mailbox(&self, _: &str) -> Result<Option<Mailbox>, Fault> {
        panic!("not used")
    }
}

#[tokio::test]
async fn stop_cancels_a_pending_tool_resolution_before_any_native_child_exists() {
    let service = Arc::new(PendingGit {
        entered: watch::channel(false).0,
    });
    let (sink, mut rx) = Capture::new();
    let schedule = json!({"frequency":{"event":{"source":"git","repo":"fixture","branch":"main"}}});
    let mut source = start(
        Arc::clone(&service),
        &schedule,
        None,
        sink,
        Config::default(),
    )
    .unwrap();
    service
        .entered
        .subscribe()
        .wait_for(|entered| *entered)
        .await
        .unwrap();
    (source.stop)();
    source.take_done().unwrap().await;
    assert!(rx.try_recv().is_err());
}
struct MailFixture {
    port: u16,
    tls: Arc<rustls::ClientConfig>,
}
impl Services for MailFixture {
    async fn git(&self) -> Result<ToolRunner, Fault> {
        panic!("not used")
    }
    async fn github(&self) -> Result<GithubTool, Fault> {
        panic!("not used")
    }
    fn sessions(&self) -> Result<SessionSubscription, Fault> {
        panic!("not used")
    }
    async fn mailbox(&self, name: &str) -> Result<Option<Mailbox>, Fault> {
        assert_eq!(name, "Work");
        Ok(Some(
            Mailbox::new(
                "canonical-account".into(),
                "Work".into(),
                "owner@example.invalid".into(),
                "127.0.0.1".into(),
                self.port,
                crate::routines::imap::Login::new(
                    "fixture".into(),
                    "unused".into(),
                    "INBOX".into(),
                ),
            )
            .trusted_fixture(Arc::clone(&self.tls)),
        ))
    }
}

#[tokio::test]
async fn email_driver_reads_tls_and_publishes_its_cursor_with_filtered_news() {
    use crate::routines::imap::tests::{tls, transaction};
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let (server, tls) = tls();
    let serving = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        transaction(
            tokio_rustls::TlsAcceptor::from(server)
                .accept(stream)
                .await
                .unwrap(),
            false,
        )
        .await;
    });
    let (sink, mut events) = Capture::new();
    let schedule = json!({"frequency":{"event":{"source":"email","account":"Work","from":"a@"}}});
    let mark = Some(json!({"accountId":"canonical-account","validity":7,"uid":5}));
    let mut process = start(
        Arc::new(MailFixture { port, tls }),
        &schedule,
        mark,
        sink,
        Config::default(),
    )
    .unwrap();
    let (mark, lines) = events.recv().await.unwrap();
    assert_eq!(
        mark.unwrap(),
        json!({"accountId":"canonical-account","validity":7,"uid":30})
    );
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("안녕"));
    assert!(lines[0].contains("hello"));
    (process.stop)();
    process.take_done().unwrap().await;
    serving.await.unwrap();
}
