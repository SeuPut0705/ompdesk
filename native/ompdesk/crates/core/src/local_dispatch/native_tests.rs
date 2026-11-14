#![cfg(unix)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::{Commands, Config, fingerprints, protocol::RpcCommand};
use crate::application::{omp_cli, prefs::Prefs, proxy::ShellProxy, stock_launcher::StockLauncher};
use crate::git::session_lifecycle::test_support::{repo_at, runner, sh};
use crate::machine::{self, Environment, Platform};
use crate::models::test_rig::Fixture;
use crate::pool::application::Sidecar;
use crate::server::{Events, Fault, Scope};
use crate::sidecar::LaneEvent;
use crate::sidecar::application::{Command as LaunchCommand, EffectFuture};
use crate::sidecar::native::{self, DirectSpawn, Service as NativeSidecar, Sink, SpawnAdapter, Start};
use crate::stock::native::Service as Stock;

// This observes the actual Lane's event/flush stream, not a RootHost or authority stand-in.
struct Recorder {
    events: mpsc::UnboundedSender<LaneEvent>,
    flushes: AtomicUsize,
}

impl Sink for Recorder {
    fn event(&self, event: LaneEvent) { let _ = self.events.send(event); }
    fn before_response(&self) { self.flushes.fetch_add(1, Ordering::SeqCst); }
    fn remove_listeners(&self) {}
    fn sync_settings(&self) -> EffectFuture<'_, ()> { Box::pin(async {}) }
}

struct LoggedSpawn {
    log: PathBuf,
    home: PathBuf,
}

impl SpawnAdapter for LoggedSpawn {
    fn prepare(&self, mut command: LaunchCommand) -> Result<Start, Fault> {
        command.env.insert("OMPDESK_FAKE_LOG".into(), self.log.to_string_lossy().into_owned());
        command.env.insert("HOME".into(), self.home.to_string_lossy().into_owned());
        command.env.insert("USERPROFILE".into(), self.home.to_string_lossy().into_owned());
        // The existing fake omp must not bind a bridge inherited from the agent running this test.
        command.env.remove("OMP_GUI_BRIDGE");
        DirectSpawn.prepare(command)
    }
}

struct Rig {
    source: Arc<NativeSidecar>,
    commands: Commands<NativeSidecar>,
    held: native::Held,
    stock: Arc<Stock>,
    fingerprints: Arc<fingerprints::Service>,
    sink: Arc<Recorder>,
    recorded: mpsc::UnboundedReceiver<LaneEvent>,
    log: PathBuf,
    // Keep the real event transport and the private files until the child has exited.
    _transport: mpsc::UnboundedSender<crate::wire::Frame>,
    _frames: mpsc::UnboundedReceiver<crate::wire::Frame>,
    fixture: Fixture,
}

impl Rig {
    async fn new(name: &str) -> Self {
        let fixture = Fixture::new(name);
        let home = fixture.dir.join("home");
        let user_data = fixture.dir.join("data");
        let agent_dir = fixture.dir.join("agent");
        let bridge_dir = fixture.dir.join("bridge");
        for path in [&home, &user_data, &agent_dir, &bridge_dir] {
            std::fs::create_dir_all(path).unwrap();
        }
        let exe = std::env::current_exe().unwrap();
        // Invoke the existing real supervise::run test entry; do not implement a second supervisor.
        let supervisor = fixture.script("supervisor", &format!(
            "export OMPDESK_MANUAL_SUPERVISOR_CHILD=1\nexec '{}' --exact worktree_lifecycle::manual::prepare::tests::supervisor_child --nocapture",
            exe.to_string_lossy().replace('\'', "'\\''"),
        ));
        let (events, transport, frames) = Events::capture();
        let env = Environment::from([
            ("HOME".into(), home.to_string_lossy().into_owned()),
            ("USERPROFILE".into(), home.to_string_lossy().into_owned()),
            ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            ("GIT_CONFIG_GLOBAL".into(), fixture.dir.join("git-config").to_string_lossy().into_owned()),
            ("GIT_OPTIONAL_LOCKS".into(), "0".into()),
            ("LC_ALL".into(), "C".into()),
        ]);
        std::fs::write(fixture.dir.join("git-config"), "").unwrap();
        let machine = machine::Service::new(machine::Config {
            platform: if cfg!(target_os = "macos") { Platform::Mac } else { Platform::Other },
            home: home.clone(), user_data: user_data.clone(), tools_dir: fixture.dir.join("tools"),
            agent_desktop_bundle: None, core_bin: supervisor.clone(), agent_dir, inherited_env: env.clone(),
        }, Arc::new(ShellProxy::new(Prefs::open(&user_data).unwrap(), events.clone())));
        let stock = Arc::new(Stock::new(crate::stock::native::Config {
            host: fixture.dir.file_name().unwrap().to_string_lossy().into_owned(), events: events.clone(),
        }, Arc::new(StockLauncher::new(Arc::clone(&machine), bridge_dir))));
        let omp = omp_cli::Service::new(machine, crate::setup::runner::Runner::new(supervisor, fixture.dir.join("scratch")));
        let mut git = runner();
        git.env = env;
        let fingerprints = Arc::new(fingerprints::Service::new(Some(git.clone())));
        let (record, mut recorded) = mpsc::unbounded_channel();
        let sink = Arc::new(Recorder { events: record, flushes: AtomicUsize::new(0) });
        let log = fixture.dir.join("stock-stdin.log");
        let cwd = fixture.dir.to_string_lossy().into_owned();
        let (source, held) = NativeSidecar::new(native::Config {
            tab: fixture.dir.file_name().unwrap().to_string_lossy().into_owned(), seq: 0, cwd: cwd.clone(),
            fresh: true, event_filter: Vec::new(), bridge: false, ledger_file: None,
            start_slow_ms: None, entry_id_timeout_ms: None, tuning: None, session_path: None, is_new: Some(true),
        }, events, sink.clone(), Arc::new(LoggedSpawn { log: log.clone(), home })).unwrap();
        source.start();
        native::tests::ready(&source, &mut recorded).await;
        source.barrier().await.unwrap();
        let generation = source.generation();
        let commands = Commands::from_captured(Arc::clone(&source), Config {
            version: "18.20.0".into(), templates: Arc::from([]), stock: Arc::clone(&stock), omp,
            git: Some(git), gh: None, fingerprints: Arc::clone(&fingerprints),
        }, generation).unwrap();
        Self {
            source, commands, held, stock, fingerprints, sink, recorded, log,
            _transport: transport, _frames: frames, fixture,
        }
    }

    fn stdin(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.log).unwrap().lines()
            .filter_map(|line| line.strip_prefix("in "))
            .map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    async fn command(&self, value: Value) -> Value {
        let command: RpcCommand = serde_json::from_value(value).unwrap();
        self.commands.command_with_captured_cwd(
            self.source.generation(), Arc::from(self.fixture.dir.to_string_lossy().as_ref()), command, Scope::detached(),
        ).await.unwrap()
    }

    async fn close(self) {
        let exited = self.source.when_exited();
        self.source.dispose(Duration::ZERO);
        exited.await.unwrap();
        self.held.await.unwrap();
        self.stock.close().await;
        self.fingerprints.dispose();
    }
}

#[tokio::test]
async fn failed_local_hits_write_no_stock_stdin_and_unknown_stock_is_delivered_once() {
    let rig = Rig::new("local-consumer-routing").await;
    let before = rig.stdin();
    let flushes = rig.sink.flushes.load(Ordering::SeqCst);
    let refusal = rig.command(json!({"type":"set_autopilot","id":"page-chosen"})).await;
    assert_eq!(refusal, json!({
        "type":"response","id":"gui-1","command":"set_autopilot","success":false,
        "error":"Autopilot is controlled from the OMPdesk window on this computer.","code":"autopilot_local_only",
    }));
    assert!(rig.sink.flushes.load(Ordering::SeqCst) > flushes);
    assert_eq!(rig.stdin(), before, "a local refusal must not become an omp command or model prompt");

    let flushes = rig.sink.flushes.load(Ordering::SeqCst);
    let invalid = rig.command(json!({"type":"add_directory","path":"folder\nname","id":"page-chosen"})).await;
    assert_eq!(invalid, json!({
        "type":"response","id":"gui-2","command":"add_directory","success":false,
        "error":"path must not contain line breaks or NUL",
    }));
    assert!(rig.sink.flushes.load(Ordering::SeqCst) > flushes);
    assert_eq!(rig.stdin(), before);

    let flushes = rig.sink.flushes.load(Ordering::SeqCst);
    let bridge_failure = rig.command(json!({"type":"get_autopilot"})).await;
    assert_eq!(bridge_failure, json!({
        "type":"response","id":"gui-3","command":"get_autopilot","success":false,"error":"gui-bridge not connected",
    }));
    assert!(rig.sink.flushes.load(Ordering::SeqCst) > flushes);
    assert_eq!(rig.stdin(), before, "a real Lane bridge error must not fall through to stock");

    let flushes = rig.sink.flushes.load(Ordering::SeqCst);
    let response = rig.command(json!({"type":"native_dispatch_unhandled","id":"page-chosen"})).await;
    let after = rig.stdin();
    assert_eq!(after.len(), before.len() + 1, "one unknown command reaches the actual child stdin exactly once");
    let sent = after.last().unwrap();
    assert_eq!(sent["type"], "native_dispatch_unhandled");
    assert_ne!(sent["id"], "page-chosen");
    assert_eq!(response, json!({
        "type":"response","id":sent["id"],"command":"native_dispatch_unhandled","success":true,"data":{},
    }));
    assert!(rig.sink.flushes.load(Ordering::SeqCst) > flushes, "the actual child response is flushed before its consumer resumes");
    rig.close().await;
}

#[tokio::test]
async fn captured_cwd_scope_and_generation_reach_actual_git_and_lane_consumers() {
    let mut rig = Rig::new("local-consumer-capture").await;
    let repo = rig.fixture.dir.join("captured-repo");
    repo_at(&repo);
    let branch = format!("captured-{}", rig.fixture.dir.file_name().unwrap().to_string_lossy());
    sh(&repo, &["checkout", "-qb", &branch]);
    let generation = rig.source.generation();
    let cwd: Arc<str> = Arc::from(repo.to_string_lossy().as_ref());
    let before = rig.stdin();
    let command: RpcCommand = serde_json::from_value(json!({
        "type":"get_git_status","cwd":rig.fixture.dir,"id":"page-chosen",
    })).unwrap();
    let cancelled = Scope::detached();
    cancelled.cancel();
    let response = rig.commands.command_with_captured_cwd(generation, Arc::clone(&cwd), command.clone(), cancelled).await.unwrap();
    assert_eq!(response, json!({
        "type":"response","id":"gui-1","command":"get_git_status","success":false,"error":"The request was cancelled",
    }));
    let response = rig.commands.command_with_captured_cwd(generation, Arc::clone(&cwd), command, Scope::detached()).await.unwrap();
    assert_eq!(response["success"], true);
    assert_eq!(response["data"]["isRepo"], true);
    assert_eq!(response["data"]["branch"], branch);
    assert_eq!(rig.stdin(), before, "native Git uses captured cwd and never stock or a page cwd");

    let command = serde_json::from_value(json!({"type":"native_dispatch_stale"})).unwrap();
    let late = rig.commands.command_with_captured_cwd(generation, cwd, command, Scope::detached());
    rig.source.restart(None, None);
    native::tests::ready(&rig.source, &mut rig.recorded).await;
    rig.source.barrier().await.unwrap();
    assert_ne!(rig.source.generation(), generation);
    let after_restart = rig.stdin();
    assert_eq!(late.await.unwrap_err().code, "sidecar_disconnected");
    assert_eq!(rig.stdin(), after_restart, "a captured old generation must not write to its replacement child");
    rig.close().await;
}
