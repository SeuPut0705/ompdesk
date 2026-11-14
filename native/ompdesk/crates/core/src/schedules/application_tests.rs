use super::*;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};

struct TestHost {
    now: AtomicI64,
    charged: Arc<AtomicI64>,
    refunds: Arc<AtomicUsize>,
    entered: watch::Sender<usize>,
    resolve: watch::Sender<bool>,
    resolution_error: bool,
    quota_refused: AtomicBool,
    state: watch::Sender<Value>,
    contexts: Mutex<Vec<SourceContext<Self>>>,
    source_stops: Arc<AtomicUsize>,
    wakes: AtomicUsize,
    wake_end: watch::Sender<Option<i64>>,
}

impl TestHost {
    fn new(resolution_error: bool) -> Arc<Self> {
        Arc::new(Self {
            now: AtomicI64::new(1_800_000_000_000),
            charged: Arc::new(AtomicI64::new(0)),
            refunds: Arc::new(AtomicUsize::new(0)),
            entered: watch::channel(0).0,
            resolve: watch::channel(false).0,
            resolution_error,
            quota_refused: AtomicBool::new(false),
            state: watch::channel(Value::Null).0,
            contexts: Mutex::new(Vec::new()),
            source_stops: Arc::new(AtomicUsize::new(0)),
            wakes: AtomicUsize::new(0),
            wake_end: watch::channel(None).0,
        })
    }
}

impl Host for TestHost {
    fn now(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    async fn resolve_launch(&self, _: &Value) -> Result<LaunchCommand, Fault> {
        self.entered.send_modify(|count| *count += 1);
        let mut gate = self.resolve.subscribe();
        gate.wait_for(|released| *released).await.unwrap();
        if self.resolution_error {
            return Err(Fault::new("omp_missing", "omp is not installed"));
        }
        let executable = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        Ok(LaunchCommand {
            supervisor: executable.clone(),
            file: executable,
            args: Vec::new(),
            shell: false,
            env: BTreeMap::new(),
            header: "UNEXPECTED LATE LAUNCH\n".into(),
        })
    }
    fn reserve(&self, _: &str) -> Result<Charge, Fault> {
        if self.quota_refused.load(Ordering::SeqCst) {
            return Err(Fault::new(
                "remote_limit_reached",
                "This device's daily model limit is used up",
            ));
        }
        self.charged.fetch_add(1, Ordering::SeqCst);
        let charged = Arc::clone(&self.charged);
        let refunds = Arc::clone(&self.refunds);
        Ok(Charge::new(move || {
            charged.fetch_sub(1, Ordering::SeqCst);
            refunds.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }))
    }
    fn wake(&self, _: &Value, _: &str) -> Result<RunProcess, Fault> {
        self.wakes.fetch_add(1, Ordering::SeqCst);
        self.entered.send_modify(|count| *count += 1);
        let stopped = self.wake_end.clone();
        let mut ended = self.wake_end.subscribe();
        Ok(RunProcess {
            stop: Arc::new(move || {
                stopped.send_replace(Some(130));
            }),
            done: Box::pin(async move {
                let code = *ended.wait_for(|code| code.is_some()).await.unwrap();
                RunResult { code, error: None }
            }),
        })
    }
    fn source_start(
        &self,
        _: SourceRequest,
        context: SourceContext<Self>,
    ) -> Result<SourceProcess, Fault> {
        locked(&self.contexts).push(context);
        let stops = Arc::clone(&self.source_stops);
        Ok(SourceProcess {
            stop: Arc::new(move || {
                stops.fetch_add(1, Ordering::SeqCst);
            }),
            run_ended: None,
        })
    }
    fn changed(&self, state: Value) {
        self.state.send_replace(state);
    }
    fn log(&self, _: &str) {}
}

struct Rig {
    dir: PathBuf,
    app: Arc<Application<TestHost>>,
    host: Arc<TestHost>,
}

impl Rig {
    fn new(resolution_error: bool) -> Self {
        let dir = crate::fs::disk::make_temp_dir("ompdesk-native-schedules-").unwrap();
        let host = TestHost::new(resolution_error);
        let mut options = Options::new(
            dir.clone(),
            Limits {
                runs_kept: 200,
                runs_per_schedule: 20,
                once_done_kept: 20,
                chain_limit: 10,
                agent_prefix: "[agent] ".into(),
            },
        );
        options.manual = true;
        let app = Application::open(Arc::clone(&host), options);
        Self { dir, app, host }
    }
    fn draft(&self, wake: bool, event: bool) -> Value {
        let mut draft = json!({"name":"Tidy", "prompt":"Tidy", "cwd":self.dir.to_string_lossy(), "frequency":{"kind":"interval","minutes":60}, "model":null,"enabled":true,"autoApprove":false});
        if wake {
            draft["wakeSession"] = "/session.jsonl".into();
        }
        if event {
            draft["frequency"] = json!({"kind":"event","event":{"source":"files","path":self.dir.to_string_lossy()}});
        }
        draft
    }
    fn create(&self, wake: bool, event: bool) -> String {
        self.app.create(&self.draft(wake, event), None).unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }
    async fn resolved(&self) {
        self.host
            .entered
            .subscribe()
            .wait_for(|count| *count > 0)
            .await
            .unwrap();
    }
    async fn terminal(&self) -> Value {
        self.host
            .state
            .subscribe()
            .wait_for(|state| {
                state["runs"].as_array().is_some_and(|runs| {
                    !runs.is_empty() && runs.iter().all(|run| run["status"] != "running")
                })
            })
            .await
            .unwrap()
            .clone()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let mut inner = locked(&self.app.inner);
        for slot in inner.runs.values() {
            (slot.stop)();
        }
        inner.engine.close(self.host.now());
        self.app.settle(&mut inner, &mut None);
        drop(inner);
        std::fs::remove_dir_all(&self.dir).unwrap();
    }
}

#[tokio::test]
async fn pending_runtime_lookup_never_launches_after_pause_edit_delete_disable_or_stop() {
    for action in ["pause", "edit", "delete", "disable", "stop"] {
        let rig = Rig::new(false);
        let id = rig.create(false, false);
        let state = rig
            .app
            .command(&json!({"action":"runNow","id":id}), Some("device-a"))
            .unwrap();
        let run = state["runs"][0]["id"].as_str().unwrap().to_owned();
        rig.resolved().await;
        assert_eq!(rig.host.charged.load(Ordering::SeqCst), 1);
        let request = match action {
            "pause" => json!({"action":"setPaused","paused":true}),
            "edit" => json!({"action":"save","id":id,"draft":rig.draft(false, false)}),
            "delete" => json!({"action":"delete","id":id}),
            "disable" => json!({"action":"setEnabled","id":id,"enabled":false}),
            _ => json!({"action":"stop","runId":run}),
        };
        rig.app.command(&request, None).unwrap();
        // Even restoring the same configuration cannot revive the old preparation.
        if action == "pause" {
            rig.app
                .command(&json!({"action":"setPaused","paused":false}), None)
                .unwrap();
        }
        if action == "disable" {
            rig.app
                .command(&json!({"action":"setEnabled","id":id,"enabled":true}), None)
                .unwrap();
        }
        rig.host.resolve.send_replace(true);
        let state = rig.terminal().await;
        assert_eq!(state["runs"][0]["status"], "stopped", "{action}");
        assert_eq!(rig.host.charged.load(Ordering::SeqCst), 0, "{action}");
        assert_eq!(rig.host.refunds.load(Ordering::SeqCst), 1, "{action}");
        assert!(
            !rig.dir
                .join("schedule-runs")
                .join(format!("{run}.log"))
                .exists(),
            "{action} spawned a stale run"
        );
        rig.app.close().await;
    }
}

#[tokio::test]
async fn failed_runtime_preparation_refunds_and_writes_its_completion() {
    let rig = Rig::new(true);
    let id = rig.create(false, false);
    rig.app
        .command(&json!({"action":"runNow","id":id}), Some("device-a"))
        .unwrap();
    rig.resolved().await;
    rig.host.resolve.send_replace(true);
    let state = rig.terminal().await;
    assert_eq!(state["runs"][0]["status"], "failed");
    assert_eq!(state["runs"][0]["error"], "omp is not installed");
    assert_eq!(rig.host.charged.load(Ordering::SeqCst), 0);
    assert_eq!(rig.host.refunds.load(Ordering::SeqCst), 1);
    rig.app.close().await;
    let journal: Value =
        serde_json::from_slice(&std::fs::read(rig.dir.join("schedules.json")).unwrap()).unwrap();
    assert_eq!(journal["runs"], state["runs"]);
}

#[tokio::test]
async fn a_committed_wake_is_charged_once_and_close_waits_for_its_turn() {
    let rig = Rig::new(false);
    let id = rig.create(true, false);
    let state = rig
        .app
        .command(&json!({"action":"runNow","id":id}), Some("device-a"))
        .unwrap();
    let run = state["runs"][0]["id"].as_str().unwrap().to_owned();
    rig.resolved().await;
    // Duplicate acknowledgement must not log or charge a second wake.
    rig.app
        .with(|inner| inner.engine.started(&run, rig.host.now()));
    assert_eq!(rig.host.wakes.load(Ordering::SeqCst), 1);
    let log = rig.app.read_log(&run).unwrap();
    assert_eq!(log.matches("Woke /session.jsonl").count(), 1);
    rig.app.close().await;
    assert_eq!(rig.host.charged.load(Ordering::SeqCst), 1);
    assert_eq!(rig.host.refunds.load(Ordering::SeqCst), 0);
    assert!(locked(&rig.app.inner).runs.is_empty());
    let journal: Value =
        serde_json::from_slice(&std::fs::read(rig.dir.join("schedules.json")).unwrap()).unwrap();
    assert_eq!(journal["runs"][0]["status"], "stopped");
    assert_eq!(journal["runs"][0]["error"], "OMPdesk closed during the run");
}

#[tokio::test]
async fn retired_source_cannot_save_fire_or_report_failure_even_after_same_key_resume() {
    let rig = Rig::new(false);
    let id = rig.create(true, true);
    assert!(locked(&rig.host.contexts).is_empty());
    rig.app.ready();
    let old = locked(&rig.host.contexts)[0].clone();
    assert!(old.publish(Some(json!({"listing":"before"})), &[]));
    rig.app
        .command(&json!({"action":"setPaused","paused":true}), None)
        .unwrap();
    assert!(!old.publish(Some(json!({"listing":"late"})), &["late event".into()]));
    old.failure("watch", Some("late failure"));
    rig.app
        .command(&json!({"action":"setPaused","paused":false}), None)
        .unwrap();
    assert!(!old.current());
    assert_eq!(rig.host.source_stops.load(Ordering::SeqCst), 1);
    let current = locked(&rig.host.contexts)[1].clone();
    assert!(current.publish(Some(json!({"listing":"fresh"})), &[]));
    let marks: Value =
        serde_json::from_slice(&std::fs::read(rig.dir.join("routine-marks.json")).unwrap())
            .unwrap();
    assert_eq!(marks["marks"][&id]["mark"], json!({"listing":"fresh"}));
    rig.app
        .command(&json!({"action":"delete","id":id}), None)
        .unwrap();
    assert!(!current.publish(None, &["late event".into()]));
    assert!(rig.app.state()["runs"].as_array().unwrap().is_empty());
    rig.app.close().await;
}

#[tokio::test]
async fn refused_quota_starts_no_preparation_or_run() {
    let rig = Rig::new(false);
    let id = rig.create(false, false);
    rig.host.quota_refused.store(true, Ordering::SeqCst);
    let error = rig
        .app
        .command(&json!({"action":"runNow","id":id}), Some("device-a"))
        .unwrap_err();
    assert_eq!(error.code, "remote_limit_reached");
    assert!(rig.app.state()["runs"].as_array().unwrap().is_empty());
    assert_eq!(*rig.host.entered.borrow(), 0);
    assert_eq!(rig.host.charged.load(Ordering::SeqCst), 0);
    rig.app.close().await;
}

#[test]
fn scheduled_command_keeps_memory_mcp_and_terminal_environment_parity() {
    let schedule = json!({"cwd":"/work","model":"provider/model","autoApprove":true});
    let env = BTreeMap::from([
        ("PATH".into(), "/machine/runtime/bin".into()),
        ("OTEL_SDK_DISABLED".into(), "false".into()),
    ]);
    let extensions = vec!["-e".into(), "/memory/extension".into()];
    let extension_env = BTreeMap::from([
        ("MCP_SOCKET".into(), "native-socket".into()),
        ("PI_NO_PTY".into(), "0".into()),
    ]);
    let command = LaunchCommand::omp(
        std::path::Path::new("/core"),
        std::path::Path::new("/omp"),
        env.clone(),
        extensions,
        extension_env.clone(),
        &schedule,
    );
    assert_eq!(
        command.args,
        [
            "-p",
            "-e",
            "/memory/extension",
            "--model",
            "provider/model",
            "--yolo"
        ]
    );
    assert_eq!(command.env["PATH"], "/machine/runtime/bin");
    assert_eq!(command.env["MCP_SOCKET"], "native-socket");
    assert_eq!(command.env["OTEL_SDK_DISABLED"], "true");
    assert_eq!(command.env["PI_NOTIFICATIONS"], "off");
    assert_eq!(command.env["PI_NO_PTY"], "1");
    let plain = LaunchCommand::omp(
        std::path::Path::new("/core"),
        std::path::Path::new("/omp"),
        env,
        Vec::new(),
        extension_env,
        &schedule,
    );
    assert!(!plain.env.contains_key("MCP_SOCKET"));
}
