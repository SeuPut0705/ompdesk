#![cfg(unix)]

use super::*;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::git::session_lifecycle::{Service as SessionGit, test_support};
use crate::server::{Events, Scope};
use crate::sidecar::application::{Answer, Ask, Command as LaunchCommand, EffectFuture};
use crate::sidecar::application::native::{Config as SourceConfig, DirectSpawn, Service, Sink};
use tokio::sync::mpsc;

const CHILD: &str = "OMPDESK_WORKTREE_CONSUMER_CHILD";
const WIN: Window = Window { id: 1, incarnation: 1 };

fn say(value: &Value) {
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{value}").unwrap();
    stdout.flush().unwrap();
}

/// A real owned child with stock's settings/create wire contract and a real stock-shaped git effect.
#[test]
fn child_bridge() {
    if std::env::var(CHILD).is_err() { return; }
    let address = std::env::var("OMP_GUI_BRIDGE").unwrap();
    let listener = std::os::unix::net::UnixListener::bind(address).unwrap();
    let root = PathBuf::from(std::env::var("WORKTREE_TEST_ROOT").unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let reader = std::io::BufReader::new(stream.try_clone().unwrap());
            for line in reader.lines() {
                let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
                let result = match request["method"].as_str().unwrap() {
                    "worktree_lifecycle_settings" => json!({"onStart":"create", "onExit":"remove", "eligible":true}),
                    "worktree_lifecycle_create" => {
                        let cwd = std::env::current_dir().unwrap();
                        let path = root.join("wt");
                        std::fs::create_dir_all(&root).unwrap();
                        let base = test_support::sh(&cwd, &["rev-parse", "HEAD"]);
                        test_support::sh(&cwd, &["worktree", "add", "-q", "-b", "wt/native-consumer", path.to_str().unwrap(), "HEAD"]);
                        json!({"path":path, "branch":"wt/native-consumer", "sourceCwd":cwd,
                            "baseCommit":base.trim(), "root":root})
                    }
                    _ => json!({}),
                };
                writeln!(stream, "{}", json!({"id":request["id"], "ok":true, "result":result})).unwrap();
                stream.flush().unwrap();
            }
        }
    });
    say(&json!({"type":"ready", "supportedProtocolVersions":[1,2], "maxFrameBytes":1048576, "maxReassembledFrameBytes":67108864}));
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(command) = serde_json::from_str::<Value>(&line) else { continue };
        let data = if command["type"] == "get_state" {
            json!({"sessionId":"native-worktree", "cwd":std::env::current_dir().unwrap()})
        } else { json!({}) };
        say(&json!({"type":"response", "id":command["id"], "command":command["type"], "success":true, "data":data}));
    }
    std::process::exit(0);
}

struct Recorder(mpsc::UnboundedSender<crate::sidecar::LaneEvent>);
impl Sink for Recorder {
    fn event(&self, event: crate::sidecar::LaneEvent) { let _ = self.0.send(event); }
    fn before_response(&self) {}
    fn remove_listeners(&self) {}
    fn sync_settings(&self) -> EffectFuture<'_, ()> { Box::pin(async {}) }
}

struct Hooks {
    source: Arc<Service>,
    owner: Owner,
    live: AtomicBool,
    binding: Mutex<Option<Value>>,
}

impl native::Hooks for Hooks {
    type Source = Service;
    fn windows(&self) -> Vec<Window> { vec![WIN] }
    fn send(&self, _: Window, event: UiEvent) {
        if let UiEvent::Notice(notice) = event { panic!("unexpected lifecycle notice: {notice:?}"); }
    }
    fn branch_prefix(&self) -> Option<String> { None }
    fn connected(&self, source: &Arc<Service>) -> bool { source.bridge_connected() }
    fn create(&self, spawn: &Spawn, source: &Arc<Service>, params: Option<Value>) -> Work<Value> {
        if !self.live.load(Ordering::SeqCst) || spawn.owner != self.owner || !Arc::ptr_eq(source, &self.source) {
            return Box::pin(async { Err(Fault::new("owner_revoked", "owner revoked")) });
        }
        source.bridge("worktree_lifecycle_create".into(), params, None)
    }
    fn bind_if_live(&self, spawn: &Spawn, source: &Arc<Service>, binding: Value) -> Work<bool> {
        let matched = self.live.load(Ordering::SeqCst) && spawn.owner == self.owner && Arc::ptr_eq(source, &self.source);
        if matched { *lock(&self.binding) = Some(binding); }
        Box::pin(async move { Ok(matched) })
    }
    fn release(&self, _: &Spawn, source: &Arc<Service>) -> Work<()> {
        let exited = source.when_exited();
        source.dispose(Duration::ZERO);
        exited
    }
}

struct Folder(PathBuf);
impl Drop for Folder { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

#[tokio::test]
async fn native_gate_creates_binds_restarts_and_removes_only_after_its_owned_child_exits() {
    let folder = Folder(std::env::temp_dir().join(format!("wt-consumer-{}", std::process::id())));
    std::fs::create_dir_all(&folder.0).unwrap();
    let repo = folder.0.join("repo");
    test_support::repo_at(&repo);
    let root = folder.0.join("worktrees");
    let owner = ompdesk_app_contract::OwnerIssuer::new(481).admit_authenticated().unwrap();
    let (events, _output, _frames) = Events::capture();
    let (record, mut recorded) = mpsc::unbounded_channel();
    let (source, held) = Service::new(SourceConfig {
        tab: format!("worktree-consumer-{}", std::process::id()), seq:0, cwd:repo.to_string_lossy().into_owned(),
        fresh:true, event_filter:Vec::new(), bridge:true, ledger_file:None, start_slow_ms:None,
        entry_id_timeout_ms:None, tuning:None, session_path:None, is_new:Some(true),
    }, events, Arc::new(Recorder(record)), Arc::new(DirectSpawn)).unwrap();
    let hooks = Arc::new(Hooks { source:source.clone(), owner:owner.clone(), live:AtomicBool::new(true), binding:Mutex::new(None) });
    let host = native::NativeHost::new(hooks.clone(), Arc::new(SessionGit::new(test_support::runner(), Scope::detached())));
    let lifecycle = Lifecycle::new(host, Config::default());
    let spawn = Spawn { owner, tab:source.tab().into(), window:WIN, cwd:repo.to_string_lossy().into_owned(),
        agent:true, fresh:true, session_path:None, device:None, explicit_worktree:false, placeholder:false, defer_start:false };
    source.arm_gate();
    source.start();
    let mut launches = 0;
    let mut gated = false;
    let mut addresses = Vec::new();
    loop {
        let event = recorded.recv().await.expect("native lane stays open until dispose");
        let ask = Ask { ask:event.data["ask"].as_u64().unwrap_or(0), cmd:event.data["cmd"].as_u64().unwrap() };
        match event.name.as_str() {
            "sidecar.resolve" => source.answer(ask, Answer::Resolved { outcome:"ok", message:None }),
            "sidecar.launch" => {
                launches += 1;
                let mut env: std::collections::BTreeMap<String,String> = std::env::vars().collect();
                env.insert(CHILD.into(), "1".into());
                env.insert("WORKTREE_TEST_ROOT".into(), root.to_string_lossy().into_owned());
                let address = event.data["bridgeAddress"].as_str().unwrap();
                env.insert("OMP_GUI_BRIDGE".into(), address.into());
                addresses.push(address.to_owned());
                source.answer(ask, Answer::Launched { command:LaunchCommand {
                    bin:std::env::current_exe().unwrap(),
                    args:vec!["--nocapture".into(), "--exact".into(), "worktree_lifecycle::native_tests::child_bridge".into()],
                    env, cwd:source.facts()["cwd"].as_str().unwrap().into(),
                }, host_tools:json!([]) });
            }
            "sidecar.gateAsk" => {
                let cwd = lifecycle.start(spawn.clone(), source.clone()).await.unwrap();
                assert_eq!(cwd.as_deref(), root.join("wt").to_str());
                assert!(root.join("wt").join("README.md").exists());
                source.answer(ask, Answer::Gated(cwd));
                gated = true;
            }
            "sidecar.status" if event.data["payload"]["status"] == "ready" => break,
            _ => {}
        }
    }
    assert!(gated);
    assert_eq!(launches, 2);
    assert_eq!(source.facts()["cwd"], root.join("wt").to_str().unwrap());
    assert_eq!(lock(&hooks.binding).as_ref().unwrap()["lifecycle"], true);
    let response = source.stock(json!({"type":"get_state"}), Some(Duration::from_secs(2))).await.unwrap();
    assert_eq!(response["data"]["cwd"], root.join("wt").to_str().unwrap());
    let exited = source.when_exited();
    hooks.live.store(false, Ordering::SeqCst);
    source.dispose(Duration::ZERO);
    lifecycle.released(&spawn.owner, &spawn.tab, &source, exited);
    lifecycle.settle().await;
    held.await.unwrap();
    assert!(!root.join("wt").exists());
    assert!(test_support::sh(&repo, &["branch", "--list", "wt/native-consumer"]).trim().is_empty());
    for address in addresses { assert!(!Path::new(&address).exists()); }
}
