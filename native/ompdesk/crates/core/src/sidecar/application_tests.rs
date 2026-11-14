use super::*;

struct Rig {
    settings: Settings,
    builtin: Builtin,
    inherited: Environment,
    shell: Environment,
    proxy: Environment,
    control: Environment,
}

impl Rig {
    fn new() -> Self {
        Self {
            settings: Settings::default(),
            builtin: Builtin::default(),
            inherited: Environment::new(),
            shell: Environment::new(),
            proxy: Environment::new(),
            control: Environment::new(),
        }
    }

    fn launch<'a>(&'a self, open: &'a Open) -> Launch<'a> {
        Launch {
            bin: Path::new("/tools/omp"),
            cwd: "/workspace",
            open,
            bridge: Some((Path::new("/bridge"), "/socket")),
            model: None,
            builtin: &self.builtin,
            user_flags: &[],
            profile: None,
            settings: &self.settings,
            inherited: &self.inherited,
            shell: &self.shell,
            proxy: &self.proxy,
            control: &self.control,
            bun_install: Path::new("/bun"),
            browser_dir: None,
            origin: None,
            process_tag: None,
            scratch: None,
        }
    }
}

#[test]
fn launch_opens_only_the_session_selected_by_the_lane() {
    let rig = Rig::new();
    let bridge = Path::new("/bridge");
    let entry = bridge.join("index.ts").to_string_lossy().into_owned();
    let config = bridge
        .join("fresh-launch.yml")
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        rig.launch(&Open::New).command().args,
        ["--mode", "rpc-ui", "--config", &config, "-e", &entry]
    );
    assert_eq!(
        rig.launch(&Open::Session("/session".into())).command().args,
        ["--mode", "rpc-ui", "--session", "/session", "-e", &entry]
    );
    assert_eq!(
        rig.launch(&Open::Default).command().args,
        ["--mode", "rpc-ui", "-e", &entry]
    );
}

#[test]
fn profile_values_that_look_like_owned_flags_remain_data() {
    let rig = Rig::new();
    let profile = json!({"systemPrompt": "--session", "addDirs": ["  /extra ", 4], "tools": [" bash ", "", "read"], "profile": " work ", "--session": "stolen"});
    let flags = [
        "--session",
        "/stolen",
        "--mode=json",
        "--system-prompt",
        "--mode",
        "--api-key",
        "secret",
        "--no-title",
    ]
    .map(String::from);
    let mut launch = rig.launch(&Open::Default);
    launch.profile = Some(&profile);
    launch.user_flags = &flags;
    launch.bridge = None;
    assert_eq!(
        launch.command().args,
        [
            "--mode",
            "rpc-ui",
            "--system-prompt",
            "--mode",
            "--system-prompt",
            "--session",
            "--add-dir",
            "/extra",
            "--tools",
            "bash,read",
            "--profile",
            "work"
        ]
    );
}

#[test]
fn a_spawn_does_not_inherit_another_session_or_control_endpoint() {
    let mut rig = Rig::new();
    for key in SESSION_ENV.iter().chain(CONTROL_ENV) {
        rig.inherited.insert((*key).into(), "parent".into());
        rig.shell.insert((*key).into(), "shell-parent".into());
    }
    rig.inherited.insert("HOME".into(), "/home".into());
    rig.control.insert("OMPDESK_CONTROL_OFF".into(), "1".into());
    let mut launch = rig.launch(&Open::New);
    launch.process_tag = Some("0123456789abcdef0123456789abcdef");
    launch.scratch = Some("/scratch");
    let env = launch.command().env;
    for key in SESSION_ENV.iter().chain(CONTROL_ENV) {
        assert!(
            !env.get(*key)
                .is_some_and(|value| value == "parent" || value == "shell-parent"),
            "{key}"
        );
    }
    assert_eq!(
        env.get("OMP_GUI_BRIDGE").map(String::as_str),
        Some("/socket")
    );
    assert_eq!(
        env.get("OMP_GUI_SESSION_TAG").map(String::as_str),
        launch.process_tag
    );
    assert_eq!(
        env.get("OMP_GUI_SCRATCH").map(String::as_str),
        Some("/scratch")
    );
    assert_eq!(
        env.get("OMPDESK_CONTROL_OFF").map(String::as_str),
        Some("1")
    );
    assert!(!env.contains_key("OMPDESK_SOCKET"));
    assert_eq!(env.get("HOME").map(String::as_str), Some("/home"));
}

#[test]
fn shell_proxy_builtin_and_control_precedence_matches_the_host() {
    let mut rig = Rig::new();
    rig.inherited
        .insert("HTTPS_PROXY".into(), "inherited".into());
    rig.shell.insert("HTTPS_PROXY".into(), "shell".into());
    rig.proxy.insert("HTTPS_PROXY".into(), "proxy-pref".into());
    rig.builtin.env.insert("OMP_GUI_PSTACK".into(), "1".into());
    rig.builtin
        .env
        .insert("OMP_GUI_REPLY_LANGUAGE".into(), "builtin".into());
    rig.settings.reply_language = Some("Korean".into());
    let env = rig.launch(&Open::Default).command().env;
    assert_eq!(env["HTTPS_PROXY"], "proxy-pref");
    assert_eq!(env["OMP_GUI_REPLY_LANGUAGE"], "builtin");
    assert_eq!(env["OMP_GUI_PSTACK"], "1");
    assert_eq!(env["OTEL_SDK_DISABLED"], "true");
    assert_eq!(env["PI_NOTIFICATIONS"], "off");
}

#[test]
fn path_adds_the_runtime_bun_and_browser_without_duplicates() {
    let mut rig = Rig::new();
    let path = std::env::join_paths([Path::new("/tools"), Path::new("/bin")]).unwrap();
    rig.shell
        .insert("PATH".into(), path.to_string_lossy().into_owned());
    let mut launch = rig.launch(&Open::Default);
    launch.browser_dir = Some(Path::new("/browser"));
    assert_eq!(
        std::env::split_paths(&launch.command().env["PATH"]).collect::<Vec<_>>(),
        [
            PathBuf::from("/tools"),
            PathBuf::from("/bin"),
            PathBuf::from("/bun/bin"),
            PathBuf::from("/browser")
        ]
    );
}

#[test]
fn settings_keep_explicit_false_and_omit_absent_values() {
    let mut settings = Settings::default();
    assert!(settings.environment(false).is_empty());
    settings.judge_assist = Some(false);
    settings.credit_spend = Some(false);
    settings.delegation = Some("default".into());
    settings.user_profile = Some(json!({"name": "", "experience": null}));
    assert_eq!(
        settings.environment(false),
        Environment::from([
            ("OMP_GUI_JUDGE_ASSIST".into(), "0".into()),
            ("OMP_GUI_CREDIT_SPEND".into(), "0".into())
        ])
    );
    settings.credit_spend = Some(true);
    assert_eq!(settings.environment(false)["OMP_GUI_CREDIT_SPEND"], "1");
}

#[test]
fn title_suppression_is_read_from_shell_over_inherited_on_every_launch() {
    let mut rig = Rig::new();
    rig.settings.auto_title = Some(json!({"enabled": true, "evolve": true, "suppressed": false}));
    rig.inherited.insert("PI_NO_TITLE".into(), "1".into());
    let env = rig.launch(&Open::New).command().env;
    assert_eq!(
        serde_json::from_str::<Value>(&env["OMP_GUI_AUTO_TITLE"]).unwrap()["suppressed"],
        true
    );
    rig.shell.insert("PI_NO_TITLE".into(), "0".into());
    let env = rig.launch(&Open::New).command().env;
    assert_eq!(
        serde_json::from_str::<Value>(&env["OMP_GUI_AUTO_TITLE"]).unwrap()["suppressed"],
        false
    );
    assert_eq!(
        rig.settings.auto_title.as_ref().unwrap()["suppressed"],
        false
    );
}

#[test]
fn live_updates_use_the_same_values_as_the_next_spawn() {
    let settings = Settings {
        reply_language: Some("Korean".into()),
        user_profile: Some(json!({"name": "Test", "experience": "expert"})),
        next_prompt: Some(json!({"suggestions": false, "inline": true})),
        auto_title: Some(json!({"enabled": false, "evolve": true})),
        judge_assist: Some(false),
        credit_spend: Some(true),
        account_rotation: Some("even".into()),
        browser: Some(Browser::Relay {
            name: "Chromium".into(),
            url: "http://127.0.0.1:9224".into(),
        }),
        ..Settings::default()
    };
    let updates = settings
        .updates(true)
        .into_iter()
        .collect::<BTreeMap<_, _>>();
    let env = settings.environment(true);
    assert_eq!(
        updates["reply_language_set"]["language"],
        env["OMP_GUI_REPLY_LANGUAGE"]
    );
    assert_eq!(
        updates["auto_title_set"],
        serde_json::from_str::<Value>(&env["OMP_GUI_AUTO_TITLE"]).unwrap()
    );
    assert_eq!(
        updates["next_prompt_set"],
        serde_json::from_str::<Value>(&env["OMP_GUI_NEXT_PROMPT"]).unwrap()
    );
    assert_eq!(updates["credit_spend_set"]["enabled"], true);
    assert_eq!(updates["judge_assist_set"]["enabled"], false);
    assert_eq!(
        env["OMP_GUI_BROWSER"],
        "relay:Chromium@http://127.0.0.1:9224"
    );
}

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct TestHost {
    cmd: AtomicU64,
    hold_runtime: AtomicBool,
    hold_bridge: AtomicBool,
    started: tokio::sync::Notify,
    resume: tokio::sync::Notify,
    answers: Mutex<Vec<Answer>>,
    settings: Mutex<Settings>,
    updates: Mutex<Vec<(&'static str, Value)>>,
}

impl Host for TestHost {
    fn current(&self, ask: Ask) -> bool {
        self.cmd.load(Ordering::SeqCst) == ask.cmd
    }
    fn runtime(&self) -> EffectFuture<'_, Result<Runtime, String>> {
        Box::pin(async {
            if self.hold_runtime.load(Ordering::SeqCst) {
                self.started.notify_one();
                self.resume.notified().await;
            }
            Ok(Runtime {
                bin: "/tools/omp".into(),
                version: "18.18.9".into(),
                bun_install: "/bun".into(),
            })
        })
    }
    fn shell_environment(&self) -> EffectFuture<'_, Result<Environment, String>> {
        Box::pin(async { Ok(Environment::new()) })
    }
    fn proxy_environment(&self) -> EffectFuture<'_, Result<Environment, String>> {
        Box::pin(async { Ok(Environment::new()) })
    }
    fn builtin(&self) -> EffectFuture<'_, Result<Builtin, String>> {
        Box::pin(async { Ok(Builtin::default()) })
    }
    fn session_free<'a>(&'a self, _: &'a str) -> EffectFuture<'a, Result<SessionFree, String>> {
        Box::pin(async { Ok(SessionFree::Owned) })
    }
    fn session_owned_text(&self) -> String {
        "This session is still open in another omp process.".into()
    }
    fn browser(&self) -> EffectFuture<'_, Result<Option<Browser>, String>> {
        Box::pin(async { Ok(Some(Browser::Builtin)) })
    }
    fn browser_directory(&self) -> EffectFuture<'_, Result<Option<PathBuf>, String>> {
        Box::pin(async { Ok(None) })
    }
    fn settings(&self) -> Settings {
        lock(&self.settings).clone()
    }
    fn cwd(&self) -> String {
        "/workspace".into()
    }
    fn bridge_directory(&self) -> Option<PathBuf> {
        Some("/bridge".into())
    }
    fn inherited_environment(&self) -> Environment {
        Environment::new()
    }
    fn control_environment(&self) -> Environment {
        Environment::new()
    }
    fn user_flags(&self) -> Vec<String> {
        Vec::new()
    }
    fn launch_profile(&self, _: &str) -> Option<Value> {
        None
    }
    fn origin(&self) -> Option<Value> {
        None
    }
    fn processes(&self, _: &str) -> Result<ProcessIdentity, String> {
        Ok(ProcessIdentity::default())
    }
    fn host_tools(&self) -> Value {
        json!([])
    }
    fn bridge_connected(&self) -> bool {
        true
    }
    fn arm_gate(&self) {}
    fn answer(&self, _: Ask, answer: Answer) {
        lock(&self.answers).push(answer);
    }
    fn bridge<'a>(
        &'a self,
        method: &'static str,
        params: Value,
    ) -> EffectFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            lock(&self.updates).push((method, params));
            if method == "reply_language_set" && self.hold_bridge.load(Ordering::SeqCst) {
                self.resume.notified().await;
            }
            Ok(Value::Null)
        })
    }
}

#[tokio::test]
async fn a_resolve_superseded_by_stop_does_not_install_launch_facts() {
    let host = Arc::new(TestHost::default());
    host.hold_runtime.store(true, Ordering::SeqCst);
    let app = Arc::new(Application::new(Arc::clone(&host)));
    let resolving = Arc::clone(&app);
    let task = tokio::spawn(async move { resolving.resolve(Ask { ask: 1, cmd: 0 }, None).await });
    host.started.notified().await;
    host.cmd.store(1, Ordering::SeqCst);
    host.resume.notify_one();
    task.await.unwrap();
    assert!(lock(&host.answers).is_empty());
    app.launch(Ask { ask: 2, cmd: 1 }, &Open::New, Some("/socket"), None);
    assert!(
        matches!(lock(&host.answers).as_slice(), [Answer::LaunchFailed(message)] if message == "omp is not resolved")
    );
}

#[tokio::test]
async fn an_owned_session_is_not_resolved_as_spawnable() {
    let host = Arc::new(TestHost::default());
    let app = Application::new(Arc::clone(&host));
    app.resolve(Ask { ask: 1, cmd: 0 }, Some("/session")).await;
    assert!(matches!(
        lock(&host.answers).as_slice(),
        [Answer::Resolved {
            outcome: "owned",
            ..
        }]
    ));
    app.session_wait(Ask { ask: 2, cmd: 0 }, "/session").await;
    assert!(matches!(
        lock(&host.answers).last(),
        Some(Answer::SessionFreed(SessionFree::Owned))
    ));
}

#[tokio::test]
async fn the_start_gate_is_consumed_once_and_its_completed_old_answer_is_discarded() {
    let host = Arc::new(TestHost::default());
    let app = Arc::new(Application::new(Arc::clone(&host)));
    let (started, on_started) = tokio::sync::oneshot::channel();
    let (resume, resumed) = tokio::sync::oneshot::channel();
    app.set_start_gate(Box::new(move || {
        Box::pin(async move {
            started.send(()).unwrap();
            resumed.await.unwrap();
            Ok(Some("/worktree".into()))
        })
    }));
    let running = Arc::clone(&app);
    let task = tokio::spawn(async move { running.gate(Ask { ask: 1, cmd: 0 }).await });
    on_started.await.unwrap();
    host.cmd.store(1, Ordering::SeqCst);
    resume.send(()).unwrap();
    task.await.unwrap();
    assert!(lock(&host.answers).is_empty());
    app.gate(Ask { ask: 2, cmd: 1 }).await;
    assert!(matches!(
        lock(&host.answers).as_slice(),
        [Answer::Gated(None)]
    ));
}

#[tokio::test]
async fn a_later_spawn_reads_new_settings_without_reresolving_the_runtime() {
    let host = Arc::new(TestHost::default());
    let app = Application::new(Arc::clone(&host));
    app.resolve(Ask { ask: 1, cmd: 0 }, None).await;
    lock(&host.settings).reply_language = Some("Korean".into());
    app.launch(Ask { ask: 2, cmd: 0 }, &Open::New, Some("/socket"), None);
    lock(&host.settings).reply_language = Some("English".into());
    app.launch(Ask { ask: 3, cmd: 0 }, &Open::New, Some("/socket"), None);
    let answers = lock(&host.answers);
    let commands = answers
        .iter()
        .filter_map(|answer| match answer {
            Answer::Launched { command, .. } => Some(command),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(commands[0].env["OMP_GUI_REPLY_LANGUAGE"], "Korean");
    assert_eq!(commands[1].env["OMP_GUI_REPLY_LANGUAGE"], "English");
}

#[tokio::test]
async fn a_stalled_live_setting_does_not_block_other_settings_or_current_browser_resolution() {
    let host = Arc::new(TestHost::default());
    host.hold_bridge.store(true, Ordering::SeqCst);
    *lock(&host.settings) = Settings {
        reply_language: Some("Korean".into()),
        credit_spend: Some(false),
        browser: Some(Browser::Ego),
        ..Settings::default()
    };
    let app = Application::new(Arc::clone(&host));
    let mut syncing = std::pin::pin!(app.sync_settings());
    std::future::poll_fn(|cx| {
        assert!(syncing.as_mut().poll(cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    let updates = lock(&host.updates)
        .clone()
        .into_iter()
        .collect::<BTreeMap<_, _>>();
    assert_eq!(updates["credit_spend_set"], json!({"enabled": false}));
    assert_eq!(
        updates["default_browser_set"],
        json!({"browser": {"kind": "builtin"}})
    );
    host.resume.notify_one();
    syncing.await;
}
