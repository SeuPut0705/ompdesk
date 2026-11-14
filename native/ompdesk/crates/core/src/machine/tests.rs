use super::*;
use crate::models::test_rig::Fixture;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Network {
    calls: AtomicUsize,
    configured: Option<String>,
}
impl Proxy for Network {
    fn configured(&self) -> Option<String> {
        self.configured.clone()
    }
    fn system<'a>(&'a self, _: &'a str) -> Boxed<'a, Result<String, Fault>> {
        Box::pin(async {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok("PROXY localhost:7890; DIRECT".into())
        })
    }
}

fn config(fixture: &Fixture, env: Environment) -> Config {
    Config {
        platform: Platform::Mac,
        home: fixture.dir.clone(),
        user_data: fixture.dir.clone(),
        tools_dir: fixture.dir.join("tools"),
        agent_desktop_bundle: None,
        core_bin: fixture.dir.join("ompdesk-core"),
        agent_dir: fixture.dir.join("agent"),
        inherited_env: env,
    }
}

pub(super) fn service(fixture: &Fixture, env: Environment) -> Arc<Service> {
    Service::new(
        config(fixture, env),
        Arc::new(Network {
            calls: AtomicUsize::new(0),
            configured: None,
        }),
    )
}

#[tokio::test]
async fn shares_login_and_omp_discovery_but_resolves_proxy_at_each_spawn() {
    let fixture = Fixture::new("machine-runtime");
    let shell=fixture.script("fake shell", "printf s >> shell-probes; printf '%s\\n' '__OMP_ENV_BEGIN__' 'PATH=/shell/tools' 'API_TOKEN=shell' 'EXPLICIT=shell' 'HOME=/wrong' 'HTTPS_PROXY=http://wrong' 'GIT_DIR=/wrong' '__OMP_ENV_END__'");
    let omp = fixture.script("omp", "printf v >> omp-probes; printf 'omp/18.20.0\\n'");
    let env = Environment::from([
        ("PATH".into(), "/inherited/tools".into()),
        ("SHELL".into(), shell.to_string_lossy().into_owned()),
        ("OMP_GUI_OMP".into(), omp.to_string_lossy().into_owned()),
        ("HOME".into(), fixture.dir.to_string_lossy().into_owned()),
        ("EXPLICIT".into(), "launch".into()),
        ("GIT_WORK_TREE".into(), "/foreign".into()),
    ]);
    let network = Arc::new(Network {
        calls: AtomicUsize::new(0),
        configured: None,
    });
    let service = Service::new(config(&fixture, env), network.clone());
    let (first, second) = tokio::join!(service.runtime(), service.runtime());
    let first = first.unwrap();
    second.unwrap();
    assert_eq!(first.version, "18.20.0");
    assert_eq!(first.env["API_TOKEN"], "shell");
    assert_eq!(first.env["EXPLICIT"], "launch");
    assert_eq!(first.env["HOME"], fixture.dir.to_string_lossy());
    assert!(first.env["PATH"].starts_with("/inherited/tools:/shell/tools:"));
    assert_eq!(first.env["HTTPS_PROXY"], "http://localhost:7890");
    assert_eq!(first.env["OTEL_SDK_DISABLED"], "true");
    assert!(!first.env.contains_key("GIT_DIR"));
    assert!(!first.env.contains_key("GIT_WORK_TREE"));
    assert_eq!(
        std::fs::read_to_string(fixture.dir.join("shell-probes")).unwrap(),
        "s"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.dir.join("omp-probes")).unwrap(),
        "v"
    );
    assert_eq!(network.calls.load(Ordering::SeqCst), 2);
    service.refresh().await.unwrap();
    service.runtime().await.unwrap();
    assert_eq!(
        std::fs::read_to_string(fixture.dir.join("shell-probes")).unwrap(),
        "ss"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.dir.join("omp-probes")).unwrap(),
        "vv"
    );
}

#[tokio::test]
async fn reads_the_actual_package_version_without_starting_omp() {
    let fixture = Fixture::new("machine-package");
    let root = fixture.dir.join("package");
    std::fs::create_dir_all(root.join("dist")).unwrap();
    std::fs::write(
        root.join("package.json"),
        r#"{"name":"@oh-my-pi/pi-coding-agent","version":"18.20.1"}"#,
    )
    .unwrap();
    let cli = fixture.script("cli", "printf forbidden > unexpectedly-started; exit 99");
    std::fs::rename(cli, root.join("dist/cli.js")).unwrap();
    let bin = fixture.dir.join("omp");
    std::os::unix::fs::symlink(root.join("dist/cli.js"), &bin).unwrap();
    let shell = fixture.script(
        "shell",
        "printf '%s\\n' '__OMP_ENV_BEGIN__' 'PATH=/none' '__OMP_ENV_END__'",
    );
    let env = Environment::from([
        ("OMP_GUI_OMP".into(), bin.to_string_lossy().into_owned()),
        ("SHELL".into(), shell.to_string_lossy().into_owned()),
    ]);
    let service = Service::new(
        config(&fixture, env),
        Arc::new(Network {
            calls: AtomicUsize::new(0),
            configured: Some("127.0.0.1:7890".into()),
        }),
    );
    let runtime = service.runtime().await.unwrap();
    assert_eq!(runtime.version, "18.20.1");
    assert_eq!(runtime.package_root.as_deref(), Some(root.as_path()));
    assert!(!fixture.dir.join("unexpectedly-started").exists());
    assert_eq!(runtime.env["PI_PROXY"], "http://127.0.0.1:7890");
}

#[tokio::test]
async fn an_unusable_omp_is_reprobed_after_it_is_repaired() {
    let fixture = Fixture::new("machine-repaired");
    let omp = fixture.script("omp", "printf 'omp/18.1.0\\n'");
    let shell = fixture.script(
        "shell",
        "printf '%s\\n' '__OMP_ENV_BEGIN__' 'PATH=/none' '__OMP_ENV_END__'",
    );
    let env = Environment::from([
        ("OMP_GUI_OMP".into(), omp.to_string_lossy().into_owned()),
        ("SHELL".into(), shell.to_string_lossy().into_owned()),
    ]);
    let service = Service::new(
        config(&fixture, env),
        Arc::new(Network {
            calls: AtomicUsize::new(0),
            configured: None,
        }),
    );
    assert!(matches!(
        service.resolution().await,
        Resolution::Failed {
            reason: Failure::TooOld { .. },
            ..
        }
    ));
    fixture.script("omp", "printf 'omp/18.20.0\\n'");
    assert_eq!(service.runtime().await.unwrap().version, "18.20.0");
}

#[test]
fn windows_environment_and_paths_keep_node_lookup_semantics() {
    let env = Environment::from([
        ("Path".into(), "C:\\bin".into()),
        ("localappdata".into(), "C:\\Local".into()),
        ("PROGRAMFILES".into(), "C:\\Programs".into()),
        ("git_dir".into(), "foreign".into()),
    ]);
    let mut canonical = paths::canonical_environment(&env, Platform::Windows);
    assert_eq!(canonical["PATH"], "C:\\bin");
    assert_eq!(canonical["LOCALAPPDATA"], "C:\\Local");
    assert_eq!(canonical["ProgramFiles"], "C:\\Programs");
    paths::drop_git_selectors(&mut canonical);
    assert!(!canonical.contains_key("GIT_DIR"));
    assert_eq!(
        paths::merge_paths(
            "C:\\Bin;D:\\Other",
            &["c:\\bin\\;e:\\tools".into()],
            Platform::Windows
        ),
        "C:\\Bin;D:\\Other;e:\\tools"
    );
}
