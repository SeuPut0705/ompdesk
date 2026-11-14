use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Notify, watch};

use super::*;

struct Fixture {
    root: PathBuf,
    url: String,
    http: tokio::task::JoinHandle<()>,
}

impl Fixture {
    async fn new() -> Self {
        let root = crate::fs::disk::make_temp_dir("ompdesk-native-memory-").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let http = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut request = [0; 4096];
                    let _ = socket.read(&mut request).await;
                    let _ = socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                        )
                        .await;
                });
            }
        });
        Self { root, url, http }
    }

    fn config(&self, name: &str) -> Config {
        fs::create_dir_all(self.root.join("data")).unwrap();
        fs::write(
            self.root.join("data/config.toml"),
            format!("server_url = \"{}\"\n", self.url),
        )
        .unwrap();
        Config {
            name: name.into(),
            platform: "darwin".into(),
            arch: "arm64".into(),
            automatic: true,
            tools_dir: self.root.join("tools"),
            bundled_dir: None,
            binary_override: Some(std::env::current_exe().unwrap()),
            no_service: true,
            home: self.root.clone(),
            root_dir: self.root.join("memory/omp-ext"),
            recall_file: None,
            uid: 0,
            builds: Builds {
                binaries: serde_json::Map::new(),
                manifest: "unused".into(),
                version: "1.0".into(),
                mac_stage_key: "current".into(),
                requirement: String::new(),
            },
            hub_entry: json!({"type":"http","url":"${OMP_GUI_MCP_HUB}/memory"}),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.http.abort();
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct TestHost {
    root: PathBuf,
    pref: Mutex<Option<bool>>,
    first_tab: watch::Sender<bool>,
    bun: AtomicBool,
    fail_setup: AtomicBool,
    block_setup: AtomicBool,
    started: Notify,
    cancelled: AtomicBool,
    calls: Mutex<Vec<(Vec<String>, Environment, bool)>>,
}

impl TestHost {
    fn new(root: &Path) -> Arc<Self> {
        Arc::new(Self {
            root: root.into(),
            pref: Mutex::new(None),
            first_tab: watch::channel(true).0,
            bun: AtomicBool::new(true),
            fail_setup: AtomicBool::new(false),
            block_setup: AtomicBool::new(false),
            started: Notify::new(),
            cancelled: AtomicBool::new(false),
            calls: Mutex::new(Vec::new()),
        })
    }
}

impl Host for TestHost {
    fn agent_dir(&self) -> PathBuf {
        self.root.join("agent")
    }
    fn terminal_pref(&self) -> Option<bool> {
        *locked(&self.pref)
    }
    fn persist_terminal(&self, enabled: bool) -> Result<(), Failure> {
        *locked(&self.pref) = Some(enabled);
        Ok(())
    }
    fn before_start(&self) -> Boxed<'_, Result<(), Failure>> {
        Box::pin(async move {
            self.first_tab
                .subscribe()
                .wait_for(|ready| *ready)
                .await
                .map_err(|_| Failure::Cancelled)?;
            Ok(())
        })
    }
    fn spawn_env(&self) -> Boxed<'_, Result<Environment, Failure>> {
        Box::pin(async move {
            Ok(Environment::from([(
                "PI_CODING_AGENT_DIR".into(),
                self.agent_dir().to_string_lossy().into_owned(),
            )]))
        })
    }
    fn bun_present(&self) -> Boxed<'_, Result<bool, Failure>> {
        Box::pin(async move { Ok(self.bun.load(Ordering::SeqCst)) })
    }
    fn omp_launch(&self) -> Boxed<'_, Result<OmpLaunch, Failure>> {
        Box::pin(async { Err(Failure::step("No model in service tests")) })
    }
    fn capture(&self, _: CaptureCommand, _: Scope) -> Boxed<'_, Result<CaptureOutput, Fault>> {
        unreachable!("service tests never invoke the model")
    }
    fn run(&self, command: RunCommand, scope: Scope) -> Boxed<'_, Result<RunOutput, Failure>> {
        Box::pin(async move {
            assert_eq!(command.cwd, self.root);
            locked(&self.calls).push((command.args.clone(), command.env.clone(), command.isolated));
            let mut output = String::new();
            let args = &command.args;
            if args.iter().any(|arg| arg == "--plan") {
                output = json!({"data_dir":self.root.join("data"),"config_path":self.root.join("data/config.toml"),"fresh":false}).to_string();
            } else if args.first().map(String::as_str) == Some("setup") {
                assert!(command.isolated);
                let agent = PathBuf::from(&command.env["PI_CODING_AGENT_DIR"]);
                fs::create_dir_all(agent.join("extensions")).unwrap();
                fs::write(
                    agent.join("extensions/ai-memory-omp.ts"),
                    "// Auto-generated by `ai-memory install-hooks --agent omp\n",
                )
                .unwrap();
                if self.block_setup.load(Ordering::SeqCst) {
                    self.started.notify_one();
                    scope.on_cancel().await;
                    assert!(
                        agent.exists(),
                        "scratch removed before supervised command settled"
                    );
                    self.cancelled.store(true, Ordering::SeqCst);
                    return Ok(RunOutput {
                        ok: false,
                        cancelled: true,
                        output,
                    });
                }
                if self.fail_setup.swap(false, Ordering::SeqCst) {
                    return Ok(RunOutput {
                        ok: false,
                        cancelled: false,
                        output: "problem: service refused".into(),
                    });
                }
            } else if let Some(index) = args.iter().position(|arg| arg == "--config-file") {
                let file = PathBuf::from(&args[index + 1]);
                fs::create_dir_all(file.parent().unwrap()).unwrap();
                fs::write(
                    file,
                    if args[0] == "install-mcp" {
                        "{\"mcpServers\":{\"ai-memory\":{}}}"
                    } else {
                        "generated extension"
                    },
                )
                .unwrap();
            } else if let Some(index) = args.iter().position(|arg| arg == "--target-dir") {
                let dir = PathBuf::from(&args[index + 1]);
                fs::create_dir_all(&dir).unwrap();
                fs::write(dir.join("skill.md"), "generated skill").unwrap();
            }
            Ok(RunOutput {
                ok: true,
                cancelled: false,
                output,
            })
        })
    }
}

#[tokio::test]
async fn native_service_wires_once_preserves_terminal_choice_and_never_asks_node() {
    let fixture = Fixture::new().await;
    let host = TestHost::new(&fixture.root);
    let (events, _keep, mut told) = Events::capture();
    let memory = Memory::open(fixture.config("native"), host.clone(), events);
    memory.start().await;
    assert_eq!(memory.state().phase, "ready");
    assert_eq!(host.terminal_pref(), Some(false));
    assert_eq!(
        memory.extension_args(None).await.unwrap(),
        ["-e", fixture.root.join("memory/omp-ext").to_str().unwrap()]
    );
    assert!(!fixture.root.join("memory/omp-ext.setup").exists());
    memory.set_terminal(true).await.unwrap();
    assert_eq!(host.terminal_pref(), Some(true));
    assert!(memory.extension_args(None).await.unwrap().is_empty());
    let setups = locked(&host.calls)
        .iter()
        .filter(|(args, _, _)| args[0] == "setup" && !args.iter().any(|arg| arg == "--plan"))
        .count();
    assert_eq!(
        setups, 2,
        "one server setup and one requested terminal setup"
    );
    while let Ok(frame) = told.try_recv() {
        assert!(!String::from_utf8_lossy(frame.parts().0).contains("aimemory.service.ask"));
    }
    memory.close().await;
}

#[tokio::test]
async fn native_service_recovers_when_bun_arrives_and_deduplicates_the_signal() {
    let fixture = Fixture::new().await;
    let host = TestHost::new(&fixture.root);
    host.bun.store(false, Ordering::SeqCst);
    let (events, _keep, _told) = Events::capture();
    let memory = Memory::open(fixture.config("bun"), host.clone(), events);
    memory.start().await;
    assert_eq!(memory.state().phase, "failed");
    assert!(locked(&host.calls).is_empty());
    host.bun.store(true, Ordering::SeqCst);
    memory.bun_installed();
    memory.bun_installed();
    // A barrier queued behind the resumed pass proves its completion without a clock or polling loop.
    memory.service.run_step(Op::Terminal(false)).await.unwrap();
    assert_eq!(memory.state().phase, "ready");
    assert_eq!(
        locked(&host.calls)
            .iter()
            .filter(|(args, _, _)| args.iter().any(|arg| arg == "--plan"))
            .count(),
        1
    );
    memory.close().await;
}

#[tokio::test]
async fn native_close_fences_a_waiting_first_tab_and_a_previous_generation() {
    let fixture = Fixture::new().await;
    let host = TestHost::new(&fixture.root);
    host.first_tab.send_replace(false);
    let (events, _keep, _told) = Events::capture();
    let memory = Arc::new(Memory::open(
        fixture.config("old"),
        host.clone(),
        events.clone(),
    ));
    let run = Arc::clone(&memory);
    let start = tokio::spawn(async move { run.start().await });
    memory.close().await;
    host.first_tab.send_replace(true);
    start.await.unwrap();
    assert!(locked(&host.calls).is_empty());
    let current = Memory::open(fixture.config("new"), host.clone(), events);
    current.start().await;
    assert_eq!(current.state().phase, "ready");
    memory.service.patch(|state| state.phase = "failed");
    assert_eq!(current.state().phase, "ready");
    current.close().await;
}

#[tokio::test]
async fn native_cancel_joins_setup_before_removing_its_scratch() {
    let fixture = Fixture::new().await;
    let host = TestHost::new(&fixture.root);
    host.block_setup.store(true, Ordering::SeqCst);
    let (events, _keep, _told) = Events::capture();
    let memory = Arc::new(Memory::open(fixture.config("cancel"), host.clone(), events));
    let run = Arc::clone(&memory);
    let start = tokio::spawn(async move { run.start().await });
    host.started.notified().await;
    memory.close().await;
    start.await.unwrap();
    assert!(host.cancelled.load(Ordering::SeqCst));
    assert!(!fixture.root.join("memory/omp-ext.setup").exists());
}

#[test]
fn disabled_extensions_accepts_yaml_json_and_only_strings() {
    let root = crate::fs::disk::make_temp_dir("ompdesk-native-memory-yaml-").unwrap();
    let file = root.join("config.yml");
    for (text, expected) in [
        (
            "disabledExtensions: [one, 2, true, null, two]",
            Some(vec!["one", "two"]),
        ),
        (
            "{\"disabledExtensions\":[\"a\",false,\"b\"]}",
            Some(vec!["a", "b"]),
        ),
        (
            "disabledExtensions:\n  - 'mcp:one'\n  - extension-module:other\n",
            Some(vec!["mcp:one", "extension-module:other"]),
        ),
        ("disabledExtensions: false", None),
        ("other: []", None),
        ("disabledExtensions: [", None),
        ("null", None),
    ] {
        fs::write(&file, text).unwrap();
        assert_eq!(
            disabled_in(&file),
            expected.map(|items| items.into_iter().map(str::to_owned).collect()),
            "{text}"
        );
    }
    fs::remove_dir_all(root).unwrap();
}
