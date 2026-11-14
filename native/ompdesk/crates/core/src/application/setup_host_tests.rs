use super::*;
use crate::models::test_rig::Fixture;
use crate::server::{Events, Fault, Scope};
use serde_json::json;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

struct NoProxy;
impl machine::Proxy for NoProxy {
    fn configured(&self) -> Option<String> {
        None
    }
    fn system<'a>(&'a self, _: &'a str) -> machine::Boxed<'a, Result<String, Fault>> {
        Box::pin(async { Ok("DIRECT".into()) })
    }
}

struct UnavailableLifecycleHooks;
impl Hooks for UnavailableLifecycleHooks {
    fn omp_ready(&self) {
        panic!("pool lifecycle is not available in this fixture")
    }
    fn git_aslr_log(&self, _: setup::git_aslr::Log) {
        panic!("runtime log is not available in this fixture")
    }
}

struct Worker;
impl stock::native::Launcher for Worker {
    fn launch(
        &self,
        _: stock::native::WorkerKind,
    ) -> Pin<Box<dyn Future<Output = Result<stock::native::LaunchCommand, Fault>> + Send + '_>>
    {
        Box::pin(async {
            Ok(stock::native::LaunchCommand {
                bin: "/bin/sh".into(),
                args: vec!["-c".into(), r#"while IFS= read -r line; do case "$line" in *'"id":'*) id=${line#*'"id":'}; id=${id%%,*}; printf '{"id":%s,"result":%s}\n' "$id" "$$";; esac; done"#.into()],
                env: Environment::new(),
                stamp_file: None,
            })
        })
    }
}

fn host(fixture: &Fixture, shell: &Path) -> SetupHost {
    let machine = machine::Service::new(
        machine::Config {
            platform: machine::Platform::Mac,
            home: fixture.dir.clone(),
            user_data: fixture.dir.clone(),
            tools_dir: fixture.dir.join("tools"),
            agent_desktop_bundle: None,
            core_bin: fixture.dir.join("core"),
            agent_dir: fixture.dir.join("agent"),
            inherited_env: Environment::from([
                ("PATH".into(), "/inherited".into()),
                ("SHELL".into(), shell.to_string_lossy().into_owned()),
            ]),
        },
        Arc::new(NoProxy),
    );
    let (events, _, _) = Events::capture();
    let stock = Arc::new(stock::native::Service::new(
        stock::native::Config {
            host: fixture.dir.to_string_lossy().into_owned(),
            events,
        },
        Arc::new(Worker),
    ));
    SetupHost::new(
        machine,
        stock,
        Arc::new(FirstTab::default()),
        Arc::new(UnavailableLifecycleHooks),
    )
}

#[tokio::test]
async fn refresh_reloads_the_machine_environment_for_setup_and_update() {
    let fixture = Fixture::new("setup-host-refresh");
    let shell = fixture.script(
        "shell",
        "printf '%s\\n' '__OMP_ENV_BEGIN__' 'PATH=/first' '__OMP_ENV_END__'",
    );
    let host = host(&fixture, &shell);
    assert!(host.environment().await.unwrap()["PATH"].contains("/first"));
    fixture.script(
        "shell",
        "printf '%s\\n' '__OMP_ENV_BEGIN__' 'PATH=/second' '__OMP_ENV_END__'",
    );
    host.refresh_path().await.unwrap();
    let env = host.update_environment("/chosen/bin/omp").await.unwrap();
    assert!(env["PATH"].starts_with("/chosen/bin:"));
    assert!(env["PATH"].contains("/second"));
    assert!(!env["PATH"].contains("/first"));
}

#[tokio::test]
async fn stopping_before_an_update_replaces_the_stock_worker() {
    let fixture = Fixture::new("setup-host-stop");
    let shell = fixture.script(
        "shell",
        "printf '%s\\n' '__OMP_ENV_BEGIN__' 'PATH=/none' '__OMP_ENV_END__'",
    );
    let host = host(&fixture, &shell);
    let request = || {
        host.stock.request(
            "sessions.list",
            &json!({}),
            Duration::from_secs(5),
            Scope::detached(),
        )
    };
    let before = request().await.unwrap();
    host.before_omp_update().await.unwrap();
    assert_ne!(request().await.unwrap(), before);
    host.stock.close().await;
}

#[tokio::test]
async fn optional_work_waits_until_the_first_tab_opens() {
    let fixture = Fixture::new("setup-host-first-tab");
    let shell = fixture.script(
        "shell",
        "printf '%s\\n' '__OMP_ENV_BEGIN__' 'PATH=/none' '__OMP_ENV_END__'",
    );
    let host = host(&fixture, &shell);
    let wait = host.before_optional();
    tokio::pin!(wait);
    assert!(
        std::future::poll_fn(|cx| { std::task::Poll::Ready(wait.as_mut().poll(cx).is_pending()) })
            .await
    );
    host.first_tab.ready();
    wait.await;
}
