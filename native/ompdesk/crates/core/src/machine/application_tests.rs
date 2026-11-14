use super::*;
use crate::machine::{Config, Environment, Platform, Proxy};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct Network;
impl Proxy for Network {
    fn configured(&self) -> Option<String> {
        None
    }
    fn system<'a>(&'a self, _: &'a str) -> Boxed<'a, Result<String, Fault>> {
        Box::pin(async { Ok("DIRECT".into()) })
    }
}

struct UpdateService {
    status: Mutex<Update>,
    restarts: AtomicUsize,
    postponed: AtomicUsize,
}
impl Desktop for UpdateService {
    fn version(&self) -> String {
        "1.2.3".into()
    }
    fn update(&self) -> Update {
        let state = lock(&self.status);
        Update {
            status: state.status.clone(),
            restartable: state.restartable,
            countdown: state.countdown,
        }
    }
    fn check(&self) -> Boxed<'_, Result<(), Fault>> {
        Box::pin(async { Ok(()) })
    }
    fn download(&self) -> Boxed<'_, Result<(), Fault>> {
        Box::pin(async { Ok(()) })
    }
    fn postpone(&self) {
        self.postponed.fetch_add(1, Ordering::SeqCst);
    }
    fn restart(&self) {
        self.restarts.fetch_add(1, Ordering::SeqCst);
    }
}

struct TestHost {
    prefs: Mutex<HashMap<&'static str, Value>>,
    steps: Mutex<Vec<String>>,
    updater: Arc<UpdateService>,
    busy: AtomicBool,
    remote_target: bool,
    calls: Mutex<Vec<Value>>,
    remote_reply: Mutex<Value>,
}
impl Host for TestHost {
    type Owner = String;
    fn target<'a>(
        &'a self,
        _: &'a NativeCaller,
        _: Option<&'a str>,
    ) -> Boxed<'a, Result<Target<String>, Fault>> {
        Box::pin(async {
            Ok(if self.remote_target {
                Target::Remote {
                    owner: "authenticated-peer".into(),
                    device: "host-b".into(),
                    tab: Some(RemoteTab {
                        rtab: "host-tab".into(),
                        cwd: PathBuf::from("/host/work"),
                    }),
                }
            } else {
                Target::Local {
                    owner: "window".into(),
                    cwd: None,
                }
            })
        })
    }
    fn remote<'a>(
        &'a self,
        owner: &'a String,
        device: &'a str,
        method: &'static str,
        params: Value,
        timeout_ms: Option<u64>,
    ) -> Boxed<'a, Result<Value, Fault>> {
        Box::pin(async move {
            lock(&self.calls).push(json!({"owner":owner,"device":device,"method":method,"params":params,"timeoutMs":timeout_ms}));
            Ok(lock(&self.remote_reply).clone())
        })
    }
    fn preference(&self, key: Preference) -> Value {
        lock(&self.prefs)
            .get(key.key())
            .cloned()
            .unwrap_or(Value::Null)
    }
    fn write_preference(&self, key: Preference, value: Value) -> Result<(), Fault> {
        lock(&self.steps).push(format!("store:{}", key.key()));
        if value.is_null() {
            lock(&self.prefs).remove(key.key());
        } else {
            lock(&self.prefs).insert(key.key(), value);
        }
        Ok(())
    }
    fn changed(&self, change: Changed) {
        lock(&self.steps).push(format!("broadcast:{change:?}"));
    }
    fn even_supported(&self) -> Boxed<'_, Result<Option<bool>, Fault>> {
        Box::pin(async {
            lock(&self.steps).push("probe".into());
            Ok(Some(true))
        })
    }
    fn set_local_engines(&self, enabled: bool) -> Boxed<'_, Result<(), Fault>> {
        Box::pin(async move {
            self.write_preference(Preference::LocalEngineDetect, json!(enabled))?;
            lock(&self.steps).push("detector".into());
            Ok(())
        })
    }
    fn install_node(&self) {
        lock(&self.steps).push("install-node".into());
    }
    fn desktop(&self) -> Arc<dyn Desktop> {
        self.updater.clone()
    }
    fn busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }
}

fn app(remote_target: bool) -> (Arc<Application<TestHost>>, Arc<TestHost>) {
    let root = std::env::var_os("OMPDESK_RUN_TEMP").map_or_else(std::env::temp_dir, PathBuf::from);
    let runtime = Service::new(
        Config {
            platform: Platform::Other,
            home: root.clone(),
            user_data: root.clone(),
            tools_dir: root.join("absent-managed-tools"),
            agent_desktop_bundle: None,
            core_bin: root.join("ompdesk-core"),
            agent_dir: root.join("agent"),
            inherited_env: Environment::new(),
        },
        Arc::new(Network),
    );
    let host = Arc::new(TestHost {
        prefs: Mutex::new(HashMap::new()),
        steps: Mutex::new(Vec::new()),
        updater: Arc::new(UpdateService {
            status: Mutex::new(Update {
                status: json!({"state":"downloaded","version":"2.0.0","mode":"relaunch","restartAt":5}),
                restartable: true,
                countdown: true,
            }),
            restarts: AtomicUsize::new(0),
            postponed: AtomicUsize::new(0),
        }),
        busy: AtomicBool::new(false),
        remote_target,
        calls: Mutex::new(Vec::new()),
        remote_reply: Mutex::new(Value::Null),
    });
    (Application::new(runtime, host.clone()), host)
}
fn caller() -> NativeCaller {
    NativeCaller::Desktop {
        win_id: 1,
        wc_id: 2,
    }
}

#[tokio::test]
async fn persists_before_broadcast_and_probe_and_refuses_invalid_preferences() {
    let (app, host) = app(false);
    assert_eq!(
        app.call(&caller(), None, Command::AccountRotation)
            .await
            .unwrap(),
        json!({"mode":"quota","evenSupported":true})
    );
    lock(&host.steps).clear();
    assert_eq!(
        app.call(&caller(), None, Command::SetAccountRotation(json!("even")))
            .await
            .unwrap(),
        json!({"mode":"even","evenSupported":true})
    );
    assert_eq!(
        *lock(&host.steps),
        [
            "store:accountRotation",
            "broadcast:AccountRotation(\"even\")",
            "probe"
        ]
    );
    lock(&host.steps).clear();
    let fault = app
        .call(&caller(), None, Command::SetCreditSpend(json!("yes")))
        .await
        .unwrap_err();
    assert_eq!(fault.code, "invalid_preference_key");
    assert!(lock(&host.steps).is_empty());
    assert_eq!(
        app.call(&caller(), None, Command::CreditSpend)
            .await
            .unwrap(),
        json!({"enabled":false})
    );
    assert_eq!(
        app.call(&caller(), None, Command::SetCreditSpend(json!(true)))
            .await
            .unwrap(),
        json!({"enabled":true})
    );
    assert_eq!(
        *lock(&host.steps),
        ["store:creditSpend", "broadcast:CreditSpend(true)"]
    );
    assert_eq!(
        app.call(&caller(), None, Command::SetResearchPick(json!("p/m")))
            .await
            .unwrap(),
        json!({"pick":"p/m"})
    );
    assert_eq!(
        app.call(&caller(), None, Command::SetResearchPick(Value::Null))
            .await
            .unwrap(),
        json!({"pick":null})
    );
    assert_eq!(
        app.call(&caller(), None, Command::SetLocalEngineDetect(json!(false)))
            .await
            .unwrap(),
        json!({"enabled":false})
    );
}

#[tokio::test(start_paused = true)]
async fn restarts_only_after_the_reply_delay_and_keeps_busy_countdown_policy() {
    let _clock = crate::clock::TEST_CLOCK.lock().await;
    let (app, host) = app(false);
    host.busy.store(true, Ordering::SeqCst);
    let fault = app
        .call(&caller(), None, Command::DesktopUpdate(json!("install")))
        .await
        .unwrap_err();
    assert_eq!(fault.code, "host_busy");
    app.call(
        &caller(),
        None,
        Command::DesktopUpdate(json!("restart-now")),
    )
    .await
    .unwrap();
    assert_eq!(host.updater.restarts.load(Ordering::SeqCst), 0);
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(499)).await;
    assert_eq!(host.updater.restarts.load(Ordering::SeqCst), 0);
    tokio::time::advance(Duration::from_millis(1)).await;
    tokio::task::yield_now().await;
    assert_eq!(host.updater.restarts.load(Ordering::SeqCst), 1);
    lock(&host.updater.status).countdown = false;
    assert_eq!(
        app.call(
            &caller(),
            None,
            Command::DesktopUpdate(json!("restart-now"))
        )
        .await
        .unwrap_err()
        .code,
        "host_busy"
    );
    app.call(&caller(), None, Command::DesktopUpdate(json!("postpone")))
        .await
        .unwrap();
    assert_eq!(host.updater.postponed.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn routes_only_the_native_selected_host_and_its_workspace() {
    let (app, host) = app(true);
    *lock(&host.remote_reply) = json!({"success":false,"error":"fake benchmark was not run"});
    let options = json!({"models":["p/m"],"profile":"chat","runs":1,"parallel":1});
    app.call(
        &caller(),
        Some("untrusted-requested-device"),
        Command::Benchmark(options.clone()),
    )
    .await
    .unwrap();
    assert_eq!(
        *lock(&host.calls),
        [
            json!({"owner":"authenticated-peer","device":"host-b","method":"host.bench.run","params":{"options":options,"rtab":"host-tab","cwd":"/host/work"},"timeoutMs":905000})
        ]
    );
    *lock(&host.remote_reply) = json!({"mode":"fastest"});
    assert_eq!(
        app.call(&caller(), None, Command::AccountRotation)
            .await
            .unwrap_err()
            .code,
        "invalid_remote_reply"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn closing_during_runtime_resolution_never_starts_a_child() {
    use crate::models::test_rig::Fixture;
    use tokio::sync::Notify;
    struct Blocked {
        entered: Notify,
        release: Notify,
    }
    impl Proxy for Blocked {
        fn configured(&self) -> Option<String> {
            None
        }
        fn system<'a>(&'a self, _: &'a str) -> Boxed<'a, Result<String, Fault>> {
            Box::pin(async {
                self.entered.notify_one();
                self.release.notified().await;
                Ok("DIRECT".into())
            })
        }
    }
    for setup in [false, true] {
        let fixture = Fixture::new("owner-resolving");
        let marker = fixture.dir.join("started");
        let runtime = fixture.runtime(&format!("printf started > '{}'; exit 1", marker.display()));
        let shell = fixture.script(
            "shell",
            "printf '%s\\n' '__OMP_ENV_BEGIN__' '__OMP_ENV_END__'",
        );
        let proxy = Arc::new(Blocked {
            entered: Notify::new(),
            release: Notify::new(),
        });
        let service = Service::new(
            Config {
                platform: Platform::Other,
                home: fixture.dir.clone(),
                user_data: fixture.dir.clone(),
                tools_dir: fixture.dir.join("tools"),
                agent_desktop_bundle: None,
                core_bin: fixture.dir.join("core"),
                agent_dir: fixture.dir.join("agent"),
                inherited_env: Environment::from([(
                    "SHELL".into(),
                    shell.to_string_lossy().into_owned(),
                )]),
            },
            proxy.clone(),
        );
        *service.runtime.lock().await = Some(runtime);
        let (_, host) = app(false);
        let application = Application::new(service, host);
        let command = if setup {
            Command::ModelSetup(
                json!({"researchModel":"p/r","models":[{"selector":"p/m","provider":"p"}],"roles":[{"id":"default","name":"Default"}]}),
            )
        } else {
            Command::Benchmark(json!({"models":["p/m"],"profile":"chat","runs":1,"parallel":1}))
        };
        let task_app = application.clone();
        let cwd = fixture.dir.clone();
        let task =
            tokio::spawn(async move { task_app.local("owner".into(), Some(cwd), command).await });
        proxy.entered.notified().await;
        application.close_owner(&"owner".into());
        proxy.release.notify_one();
        let result = task.await.unwrap().unwrap();
        assert!(!marker.exists(), "closed owner's child started: {result}");
    }
}
