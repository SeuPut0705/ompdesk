use super::*;
use crate::machine::{Boxed, Config, Environment, Platform, Proxy};
use crate::models::test_rig::Fixture;

struct NoProxy;
impl Proxy for NoProxy {
    fn configured(&self) -> Option<String> {
        None
    }
    fn system<'a>(&'a self, _: &'a str) -> Boxed<'a, Result<String, Fault>> {
        Box::pin(async { panic!("stock launcher must not resolve a system proxy") })
    }
}

fn machine(fixture: &Fixture, env: Environment) -> Arc<Service> {
    Service::new(
        Config {
            platform: Platform::Mac,
            home: fixture.dir.clone(),
            user_data: fixture.dir.clone(),
            tools_dir: fixture.dir.join("tools"),
            agent_desktop_bundle: None,
            core_bin: fixture.dir.join("core"),
            agent_dir: fixture.dir.join("agent"),
            inherited_env: env,
        },
        Arc::new(NoProxy),
    )
}

fn package(fixture: &Fixture) -> (PathBuf, PathBuf) {
    let root = fixture.dir.join("package");
    std::fs::create_dir_all(root.join("dist")).unwrap();
    std::fs::write(
        root.join("package.json"),
        r#"{"name":"@oh-my-pi/pi-coding-agent","version":"18.20.1"}"#,
    )
    .unwrap();
    std::fs::write(root.join("dist/cli.js"), "#!/usr/bin/env bun\n").unwrap();
    let omp = fixture.dir.join("omp");
    std::os::unix::fs::symlink(root.join("dist/cli.js"), &omp).unwrap();
    (root, omp)
}

#[tokio::test]
async fn builds_each_worker_launch_from_machine_runtime_without_leaking_shell_exports() {
    let fixture = Fixture::new("stock-launch");
    let (root, omp) = package(&fixture);
    let bun = fixture.script("bun", "exit 99");
    let shell = fixture.script("shell", "printf '%s\\n' '__OMP_ENV_BEGIN__' 'PATH=/shell/bin' 'SHELL_ONLY=secret' 'BUN_INSTALL=/shell/bun' '__OMP_ENV_END__'");
    let env = Environment::from([
        ("PATH".into(), fixture.dir.to_string_lossy().into_owned()),
        ("SHELL".into(), shell.to_string_lossy().into_owned()),
        ("OMP_GUI_OMP".into(), omp.to_string_lossy().into_owned()),
        ("BUN_INSTALL".into(), "/inherited/bun".into()),
        ("OMPDESK_SOCKET".into(), "socket".into()),
        ("OMPDESK_CONTROL_DIR".into(), "dir".into()),
        ("OMPDESK_CONTROL_OFF".into(), "1".into()),
        ("ompdesk_socket".into(), "kept".into()),
        ("GIT_DIR".into(), "kept".into()),
        ("HTTPS_PROXY".into(), "inherited".into()),
        ("PI_NOTIFICATIONS".into(), "on".into()),
    ]);
    let bridge = fixture.dir.join("bridge");
    let launcher = StockLauncher::new(machine(&fixture, env), bridge.clone());
    for (kind, name) in [
        (WorkerKind::Stock, "stock"),
        (WorkerKind::Terminals, "terminals"),
        (WorkerKind::Extensions, "extensions"),
    ] {
        let start = launcher.launch(kind).await.unwrap();
        assert_eq!(start.bin, bun.to_string_lossy());
        assert_eq!(
            start.args,
            vec![
                bridge
                    .join("stock-helper/host.ts")
                    .to_string_lossy()
                    .into_owned(),
                name.to_owned()
            ]
        );
        assert_eq!(start.stamp_file, Some(root.join("package.json")));
        assert_eq!(
            start.env["PATH"],
            format!("{}:/shell/bin:/inherited/bun/bin", fixture.dir.display())
        );
        assert_eq!(start.env["OMP_PACKAGE_ROOT"], root.to_string_lossy());
        assert_eq!(start.env["PI_NOTIFICATIONS"], "off");
        assert_eq!(start.env["ompdesk_socket"], "kept");
        assert_eq!(start.env["GIT_DIR"], "kept");
        assert_eq!(start.env["HTTPS_PROXY"], "inherited");
        for key in [
            "OMPDESK_SOCKET",
            "OMPDESK_CONTROL_DIR",
            "OMPDESK_CONTROL_OFF",
            "SHELL_ONLY",
        ] {
            assert!(!start.env.contains_key(key));
        }
    }
}

#[tokio::test]
async fn refuses_a_runtime_without_a_package_or_bun() {
    let fixture = Fixture::new("stock-missing");
    let shell = fixture.script(
        "shell",
        "printf '%s\\n' '__OMP_ENV_BEGIN__' 'PATH=/no-such-bin' '__OMP_ENV_END__'",
    );
    let omp = fixture.script("omp", "printf 'omp/18.20.0\\n'");
    let env = Environment::from([
        ("PATH".into(), fixture.dir.to_string_lossy().into_owned()),
        ("SHELL".into(), shell.to_string_lossy().into_owned()),
        ("OMP_GUI_OMP".into(), omp.to_string_lossy().into_owned()),
    ]);
    let launcher = StockLauncher::new(machine(&fixture, env.clone()), fixture.dir.clone());
    assert_eq!(
        launcher
            .launch(WorkerKind::Stock)
            .await
            .unwrap_err()
            .message,
        "Cannot locate omp package"
    );
    std::fs::remove_file(&omp).unwrap();
    let (_, omp) = package(&fixture);
    let mut env = env;
    env.insert("OMP_GUI_OMP".into(), omp.to_string_lossy().into_owned());
    let launcher = StockLauncher::new(machine(&fixture, env), fixture.dir.clone());
    assert_eq!(
        launcher.launch(WorkerKind::Stock).await.unwrap_err().code,
        "bun_missing"
    );
}
