//! Concrete adapters and the real Lane child, not Root's page/CEF ingress or enabled REA/memory execution.

use std::sync::atomic::AtomicUsize;

use super::*;
use crate::application::memory_host::MemoryHost;
use crate::application::readiness::FirstTab;
use crate::application::runtime_log::{RuntimeLogContext, Writer};
use crate::application::session_authority::SessionAuthority;
use crate::application::session_ownership_host::SessionOwnershipHost;
use crate::application::stock_launcher::StockLauncher;
use crate::application::tools::HostTools;
use crate::remote::application_host::tests::service as hosted_service;
use crate::mcp_hub::tests::Fixture as McpFixture;
use crate::setup::runner::Runner as SetupRunner;
use crate::sidecar::LaneEvent;
use crate::sidecar::application::{Application, Command as LaunchCommand, Dispatch};
use crate::sidecar::native::{self, DirectSpawn, Held};
use crate::stock::native::Service as Stock;
use tokio::sync::mpsc;

struct Rig {
    callers: Arc<Callers>,
    owner: Owner,
    source: Arc<NativeSidecar>,
    held: Held,
    events: mpsc::UnboundedReceiver<LaneEvent>,
    stock: Arc<Stock>,
    sessions: Arc<SessionIndex>,
    memory: Arc<Memory>,
    hub: Arc<McpHub>,
    ownership: Arc<SessionOwnership>,
    process_file: PathBuf,
    scratch_file: PathBuf,
    unwritten: PathBuf,
    child_log: PathBuf,
    launch_env: PathBuf,
    omp: PathBuf,
    env: machine::Environment,
    base_tools: Arc<[Value]>,
    _transport: mpsc::UnboundedSender<crate::wire::Frame>,
    _frames: mpsc::UnboundedReceiver<crate::wire::Frame>,
    _mcp_fixture: McpFixture,
    fixture: Fixture,
}

impl Rig {
    async fn new(name: &str) -> (Self, Config) {
        let fixture = Fixture::new(name);
        let tools = HostTools::bundled().unwrap();
        let home = fixture.dir.join("home");
        let data = fixture.dir.join("data");
        let agent = fixture.dir.join("agent");
        let bridge = fixture.dir.join("bridge");
        let builtin = fixture.dir.join("builtin");
        let sessions_root = fixture.dir.join("sessions");
        for path in [&home, &data, &agent, &bridge, &sessions_root, &builtin] {
            std::fs::create_dir_all(path).unwrap();
        }
        let exe = std::env::current_exe().unwrap().to_string_lossy().replace('\'', "'\\''");
        let supervisor = fixture.script("supervisor", &format!(
            "export OMPDESK_MANUAL_SUPERVISOR_CHILD=1\nexec '{exe}' --exact worktree_lifecycle::manual::prepare::tests::supervisor_child --nocapture",
        ));
        let launch_env = fixture.dir.join("launch-environment.txt");
        let launch_env_shell = launch_env.to_string_lossy().replace('\'', "'\\''");
        let omp = fixture.script("omp", &format!(
            "if [ \"$1\" = '--version' ]; then printf 'omp/18.20.0\\n'; exit 0; fi\nprintf '%s\\n' \"$OMP_GUI_SESSION_TAG\" \"$OMP_GUI_SCRATCH\" \"$OMP_GUI_MCP_AUTH\" > '{launch_env_shell}'\nexec '{exe}' --nocapture --exact sidecar::tests::fake_omp_stand_in -- \"$@\"",
        ));
        let shell = fixture.script("shell", "printf '%s\\n' '__OMP_ENV_BEGIN__' 'PATH=/usr/bin:/bin' '__OMP_ENV_END__'");
        let child_log = fixture.dir.join("child.log");
        let env = machine::Environment::from([
            ("HOME".into(), home.to_string_lossy().into_owned()),
            ("USERPROFILE".into(), home.to_string_lossy().into_owned()),
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("SHELL".into(), shell.to_string_lossy().into_owned()),
            ("OMP_GUI_OMP".into(), omp.to_string_lossy().into_owned()),
            ("OMPDESK_FAKE_OMP".into(), "normal".into()),
            ("OMPDESK_FAKE_LOG".into(), child_log.to_string_lossy().into_owned()),
            // The actual launch assembler must strip another execution's plumbing before spawn.
            ("OMP_GUI_SESSION_TAG".into(), "parent-session-tag".into()),
            ("OMP_GUI_SCRATCH".into(), "parent-session-scratch".into()),
            ("OMP_GUI_MCP_AUTH".into(), "parent-hub-auth".into()),
            ("OMPDESK_CONTROL_OFF".into(), "1".into()),
        ]);
        let (events, transport, frames) = Events::capture();
        let prefs = Prefs::open(&data).unwrap();
        for key in ["agentControl", "pstack", "ecc", "builtinMcp.rea"] {
            prefs.set(key, json!(false)).unwrap();
        }
        prefs.set("computerUse", json!("builtin")).unwrap();
        // Exercise the real configured-proxy branch without asking an unattached native shell for PAC.
        prefs.set("proxyUrl", json!("http://127.0.0.1:9")).unwrap();
        let machine = Machine::new(machine::Config {
            platform: machine::Platform::Other, home: home.clone(), user_data: data.clone(),
            tools_dir: fixture.dir.join("tools"), agent_desktop_bundle: None,
            core_bin: supervisor.clone(), agent_dir: agent,
            inherited_env: env.clone(),
        }, Arc::new(ShellProxy::new(Arc::clone(&prefs), events.clone())));
        let stock = Arc::new(Stock::new(crate::stock::native::Config {
            host: fixture.dir.file_name().unwrap().to_string_lossy().into_owned(), events: events.clone(),
        }, Arc::new(StockLauncher::new(Arc::clone(&machine), bridge.clone()))));
        let sessions = SessionIndex::new(Arc::clone(&stock), sessions_root.clone(), fixture.dir.clone(), Arc::new(SessionAuthority::open(Some(data.join("deleted-sessions.json")))), data.join("session-kinds.json"));
        let first_tab = Arc::new(FirstTab::default());
        first_tab.ready();
        let memory = Arc::new(Memory::open(crate::aimemory::application::Config {
            name: fixture.dir.file_name().unwrap().to_string_lossy().into_owned(),
            platform: "other".into(), arch: std::env::consts::ARCH.into(), automatic: false,
            tools_dir: fixture.dir.join("tools"), bundled_dir: None, binary_override: None,
            no_service: true, home: home.clone(), root_dir: fixture.dir.join("memory/omp-ext"),
            recall_file: Some(data.join("recall.json")), uid: 0,
            builds: crate::aimemory::application::Builds {
                binaries: serde_json::Map::new(), manifest: data.join("memory-builds.json").to_string_lossy().into_owned(),
                version: "1.0.0".into(), mac_stage_key: "fixture".into(), requirement: String::new(),
            },
            hub_entry: json!({"type":"http","url":"${OMP_GUI_MCP_HUB}/memory"}),
        }, Arc::new(MemoryHost::new(Arc::clone(&machine), Arc::clone(&prefs), SetupRunner::new(supervisor, fixture.dir.join("setup-scratch")), first_tab)), events.clone()));
        let (hosted, _effects, _quota) = hosted_service();
        let writer = Arc::new(Writer::new(data.join("runtime.jsonl"), RuntimeLogContext {
            app_version: "launch-fixture".into(), platform: std::env::consts::OS.into(),
            pid: std::process::id(), window_id: Some(17.0), cwd: None,
        }));
        let ownership_config = crate::session_ownership::Config::new(&data, fixture.dir.join("scratch"));
        let process_file = ownership_config.process_file.clone();
        let scratch_file = ownership_config.scratch_file.clone();
        let ownership = SessionOwnership::new(ownership_config, SessionOwnershipHost::new(hosted, writer));
        let callers = Arc::new(Callers::new(1));
        let page = callers.admit_page(ompdesk_app_contract::NativeCaller::Desktop { win_id: 17, wc_id: 117 }).unwrap();
        let tab = fixture.dir.file_name().unwrap().to_string_lossy().into_owned();
        let reservation = callers.reserve_execution(&page.owner, &tab, 17).unwrap();
        let owner = callers.execution_owner(&tab).unwrap();
        callers.keep_execution(&owner).unwrap();
        callers.finish_execution_reservation(reservation, true);
        let unwritten = sessions_root.join("not-written.jsonl");
        let (record, recorded) = mpsc::unbounded_channel();
        let sink = Arc::new(native::tests::Recorder { events: record, flushes: AtomicUsize::new(0) });
        let (source, held) = NativeSidecar::new(native::Config {
            tab, seq: 0, cwd: fixture.dir.to_string_lossy().into_owned(), fresh: false,
            event_filter: Vec::new(), bridge: false, ledger_file: None, start_slow_ms: None,
            entry_id_timeout_ms: None, tuning: None,
            session_path: Some(unwritten.to_string_lossy().into_owned()), is_new: Some(false),
        }, events, sink, Arc::new(DirectSpawn)).unwrap();
        let browsers = BrowserState::new(Arc::clone(&machine), browsers::Places {
            platform: "other".into(), home: home.to_string_lossy().into_owned(),
            app_dirs: Vec::new(), program_dirs: Vec::new(), local_app_data: String::new(),
        }).unwrap();
        let mcp_fixture = McpFixture::new().await;
        let hub = Arc::new(McpHub::start(mcp_fixture.config()).await.unwrap());
        let config = Config {
            owner: owner.clone(), tab: callers.execution_facts(&owner).unwrap().tab,
            callers: Arc::clone(&callers), source: Arc::clone(&source), machine, prefs,
            sessions: Arc::clone(&sessions), memory: Arc::clone(&memory), hub: Arc::clone(&hub),
            ownership: Arc::clone(&ownership), browsers,
            bridge_dir: bridge, builtin_dir: builtin,
            memory_state_file: data.join("recall.json"), roles_file: data.join("roles.json"),
            rotation_ledger: data.join("rotation.json"), control_environment: machine::Environment::new(),
            user_flags: Vec::new(), host_tools: Arc::clone(&tools.base), control_tools: tools.control,
            origin: None, kind: policy::LaunchKind::Agent, device: None,
            session_owned_text: "The session is owned by another omp process.".into(), device_reply_language: Some("English".into()),
        };
        (Self {
            callers, owner, source, held, events: recorded, stock, sessions, memory, hub, ownership,
            process_file, scratch_file, unwritten, child_log, launch_env, omp, env, base_tools: tools.base,
            _transport: transport, _frames: frames, _mcp_fixture: mcp_fixture, fixture,
        }, config)
    }

    fn stdin(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.child_log).unwrap().lines().filter_map(|line| line.strip_prefix("in "))
            .map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    fn tags(&self) -> Value { serde_json::from_slice(&std::fs::read(&self.process_file).unwrap()).unwrap() }
    fn scratch(&self) -> Value { serde_json::from_slice(&std::fs::read(&self.scratch_file).unwrap()).unwrap() }

    async fn close(self) {
        self.ownership.freeze();
        self.ownership.closing(&self.owner);
        self.callers.retire_execution(&self.owner);
        let exited = self.source.when_exited();
        self.source.dispose(Duration::ZERO);
        let exit = exited.await;
        let held = self.held.await;
        self.sessions.stop();
        self.memory.close().await;
        let hub = self.hub.shutdown().await;
        let stock = self.stock.close().await;
        self.callers.finish_execution_retirement(&self.owner);
        self.callers.stop();
        exit.unwrap();
        held.unwrap();
        hub.unwrap();
        stock.unwrap();
    }
}

async fn run<F>(name: &str, scenario: F)
where F: for<'a> FnOnce(&'a mut Rig, Config) -> EffectFuture<'a, ()> + Send + 'static {
    let (rig, config) = Rig::new(name).await;
    let rig = Arc::new(tokio::sync::Mutex::new(rig));
    let task_rig = Arc::clone(&rig);
    let result = tokio::spawn(async move { scenario(&mut *task_rig.lock().await, config).await }).await;
    Arc::try_unwrap(rig).ok().unwrap().into_inner().close().await;
    result.unwrap();
}

#[tokio::test]
async fn actual_launch_host_mounts_canonical_tools_and_keeps_unwritten_paths_on_the_original_execution() {
    run("launch-concrete-original", |rig, config| Box::pin(async move {
        let formal = config.builtin_dir.join("formal").to_string_lossy().into_owned();
        let host = LaunchHost::new(config).unwrap();
        let app = Arc::new(Application::new(Arc::clone(&host)));
        rig.source.start();
        native::tests::ready_application(Arc::clone(&app), &mut rig.events).await;
        rig.source.barrier().await.unwrap();
        assert_eq!(rig.source.facts()["processAlive"], true);
        assert!(!rig.unwritten.exists(), "an unwritten file must remain absent; opening it is not a stock mutation");
        assert!(rig.source.session().is_some_and(|identity| identity["sessionFile"].is_null()));
        let first = rig.tags();
        assert_eq!(first["tags"][0]["sessionPath"], rig.unwritten.to_string_lossy().as_ref());
        assert_eq!(first["tags"][0]["cwd"], rig.fixture.dir.to_string_lossy().as_ref());
        let tag = first["tags"][0]["tag"].as_str().unwrap().to_owned();
        assert_ne!(tag, "parent-session-tag");
        let scratch = rig.fixture.dir.join("scratch").join(&tag);
        assert!(scratch.is_dir());
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&scratch).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(&rig.process_file).unwrap().permissions().mode() & 0o777, 0o600);
        let actual_env = std::fs::read_to_string(&rig.launch_env).unwrap();
        assert_eq!(actual_env.lines().collect::<Vec<_>>(), [tag.as_str(), scratch.to_str().unwrap(), ""]);
        let sent = rig.stdin();
        let mounted = sent.iter().find(|frame| frame["type"] == "set_host_tools").unwrap();
        assert_eq!(mounted["tools"], Value::Array(rig.base_tools.iter().cloned().collect()));
        let builtin = host.builtin().await.unwrap();
        assert_eq!(builtin.args, ["-e", formal.as_str()]);
        assert_eq!(builtin.env["OMP_GUI_COMPUTER_USE"], "builtin");
        assert_eq!(builtin.env["OMP_GUI_PSTACK"], "0");
        assert_eq!(builtin.env["OMP_GUI_ECC"], "0");
        assert!(!builtin.env.contains_key("OMP_GUI_MCP_AUTH"));
        assert_ne!(rig.memory.state().phase, "ready");
        let next_cwd = rig.fixture.dir.join("next-workspace");
        std::fs::create_dir_all(&next_cwd).unwrap();
        let next_path = rig.unwritten.with_file_name("second-not-written.jsonl");
        rig.source.restart(Some(next_cwd.to_string_lossy().into_owned()), Some(next_path.to_string_lossy().into_owned()));
        native::tests::ready_application(Arc::clone(&app), &mut rig.events).await;
        rig.source.barrier().await.unwrap();
        let next = rig.tags();
        assert_eq!(next["tags"][0]["tag"], tag);
        assert_eq!(next["tags"][0]["sessionPath"], next_path.to_string_lossy().as_ref());
        assert_eq!(next["tags"][0]["cwd"], next_cwd.to_string_lossy().as_ref());
        assert!(!next_path.exists());
        assert!(rig.source.session().is_some_and(|identity| identity["sessionFile"].is_null()));
        assert_eq!(rig.scratch()["scratch"][0]["sessions"], json!([rig.unwritten, next_path]));
        assert!(rig.callers.retire_execution(&rig.owner));
        assert_eq!(rig.source.facts()["processAlive"], true, "retirement must not pretend the retained source has already exited");
        assert!(host.processes("/not-an-admitted-update", None).is_err());
        assert_eq!(rig.tags(), next, "retiring the original Owner must not retarget its still-live tag");
    })).await;
}

// Observe an event without applying policy; Application::dispatch remains the only native ask decoder/router.
async fn event(events: &mut mpsc::UnboundedReceiver<LaneEvent>, name: &str) -> LaneEvent {
    loop {
        let event = events.recv().await.expect("the real Lane remains open");
        if event.name == name { return event; }
    }
}

#[tokio::test]
async fn retiring_the_original_owner_refuses_a_real_pending_launch_answer_and_process_identity() {
    run("launch-concrete-retired", |rig, config| Box::pin(async move {
        let host = LaunchHost::new(config).unwrap();
        let app = Arc::new(Application::new(Arc::clone(&host)));
        rig.source.start();
        let resolve = event(&mut rig.events, "sidecar.resolve").await;
        match app.dispatch(&resolve).unwrap() {
            Dispatch::Pending(pending) => pending.await,
            _ => panic!("the actual resolve must run its concrete native effects"),
        }
        let launch = event(&mut rig.events, "sidecar.launch").await;
        let ask = Ask { ask: launch.data["ask"].as_u64().unwrap(), cmd: launch.data["cmd"].as_u64().unwrap() };
        assert!(host.current(ask));
        assert!(rig.source.current(ask));
        assert_eq!(launch.data["sessionPath"], rig.unwritten.to_string_lossy().as_ref());
        assert!(rig.callers.retire_execution(&rig.owner));
        assert!(rig.source.current(ask), "the same real pending Lane ask remains current independently of admission");
        assert!(!host.current(ask));
        assert!(host.processes(&host.cwd(), Some(&rig.unwritten.to_string_lossy())).is_err());
        assert!(rig.ownership.held().is_empty());
        assert!(!rig.process_file.exists());
        assert!(matches!(app.dispatch(&launch).unwrap(), Dispatch::Done));
        host.answer(ask, Answer::Launched {
            command: LaunchCommand { bin: rig.omp.clone(), args: Vec::new(), env: rig.env.clone(), cwd: rig.fixture.dir.to_string_lossy().into_owned() },
            host_tools: host.host_tools(),
        });
        // End the outstanding native ask through its original source. If Host.answer wrongly enqueues first,
        // that launch wins the Lane's ordered reply channel and this sentinel cannot supersede its real child.
        rig.source.answer(ask, Answer::LaunchFailed("Retired fixture ask completed without a child".into()));
        loop {
            let status = event(&mut rig.events, "sidecar.status").await;
            if let Some(status) = status.data["payload"]["status"].as_str()
                && matches!(status, "ready" | "error" | "restarting") {
                assert_eq!(status, "restarting", "only the direct-source refusal may complete this retired Owner's pending launch");
                break;
            }
        }
        assert_eq!(rig.source.facts()["processAlive"], false);
        assert!(!rig.child_log.exists());
        assert!(!rig.launch_env.exists());
        assert!(!rig.process_file.exists());
    })).await;
}

#[tokio::test]
async fn a_retired_execution_cannot_construct_a_new_host_over_its_retained_source() {
    run("launch-concrete-new-retired", |rig, config| Box::pin(async move {
        assert!(rig.callers.retire_execution(&rig.owner));
        let error = LaunchHost::new(config).err().expect("retired execution admission must fail");
        assert_eq!(error.code, "caller_closed");
        rig.source.barrier().await.unwrap();
        assert!(!rig.child_log.exists());
        assert!(rig.ownership.held().is_empty());
    })).await;
}
