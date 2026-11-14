#![cfg(unix)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ompdesk_core::server::Scope;
use ompdesk_core::setup::plans;
use ompdesk_core::setup::runner::Runner;
use ompdesk_core::setup::service::{Config, SetupService};
use ompdesk_core::setup::types::*;
use serde_json::Value;
use tokio::sync::{Notify, watch};

struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new(name: &str) -> Self {
        let root = std::env::var_os("OMP_SETUP_SCRATCH")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!("{name}-{}", std::process::id()));
        std::fs::create_dir_all(root.join("bin")).unwrap();
        let installer = root.join("installer");
        executable(
            &installer,
            r#"#!/bin/sh
set -eu
case "$2" in
  aslr-fix) printf '[{"path":"%s","prior":1}]' "$ROOT/git/usr/bin/sh.exe" > "$4"; if [ -f "$ROOT/aslr-partial-fail" ]; then exit 1; fi; exit 0;;
  aslr-undo) cat "$3" > "$ROOT/undo-captured"; printf '["%s"]' "$ROOT/git/usr/bin/sh.exe" > "$4"; exit 0;;
esac
printf '%s:%s\n' "$1" "$2" >> "$ROOT/runs"
if [ -f "$ROOT/fail-$1-$2" ]; then rm "$ROOT/fail-$1-$2"; echo 'ConnectionRefused'; exit 1; fi
if [ -f "$ROOT/block-$1" ]; then
  trap 'echo stopped > "$ROOT/stopped"; exit 1' TERM INT
  echo BLOCKED
  if [ -p "$ROOT/ready" ]; then echo started > "$ROOT/ready"; fi
  sleep 60 &
  wait $!
fi
touch "$ROOT/installed-$1"
if [ "$1" = bun ] && [ -f "$ROOT/target-bun-version" ]; then cp "$ROOT/target-bun-version" "$ROOT/bun-version"; fi
echo "installed $1"
"#,
        );
        executable(
            &root.join("bin/bun"),
            "#!/bin/sh\nif [ \"$1\" = pm ]; then cat \"$ROOT/manifest\"; else touch \"$ROOT/installed-bun\"; fi\n",
        );
        std::fs::write(root.join("manifest"), r#"{"engines":{"bun":">=1.4.4"}}"#).unwrap();
        executable(
            &root.join("bin/omp"),
            "#!/bin/sh\ncat \"$ROOT/update-check\"\n",
        );
        std::fs::write(
            root.join("update-check"),
            "Current version: 18.18.9\nNew version available: 18.19.0\n",
        )
        .unwrap();
        Self { root }
    }
    fn runs(&self) -> Vec<String> {
        std::fs::read_to_string(self.root.join("runs"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }
    fn service(
        &self,
        platform: Platform,
        gate_open: bool,
        old_bun: bool,
    ) -> (Arc<SetupService>, Arc<FixtureHost>, watch::Receiver<bool>) {
        let (gate, _) = watch::channel(gate_open);
        let (blocked, blocked_rx) = watch::channel(false);
        let host = Arc::new(FixtureHost {
            root: self.root.clone(),
            gate,
            ready: Notify::new(),
            ready_count: AtomicUsize::new(0),
            old_bun,
        });
        let config = Config {
            platform,
            arch: "arm64".to_owned(),
            bun_install: self.root.to_string_lossy().into_owned(),
            tools_dir: self.root.join("tools").to_string_lossy().into_owned(),
            system_root: "C:\\Windows".to_owned(),
            state_path: self.root.join("setup-state.json"),
            app_version: Some("1.0.0".to_owned()),
            automatic: true,
            supervisor: PathBuf::from(env!("CARGO_BIN_EXE_ompdesk-core")),
            scratch: self.root.join("scratch"),
            mirror: None,
            test_installer: Some(self.root.join("installer")),
            test_download: None,
        };
        let service = SetupService::new(
            config,
            host.clone(),
            Arc::new(move |state| {
                if state
                    .items
                    .iter()
                    .any(|item| item.output.contains("BLOCKED"))
                {
                    blocked.send_replace(true);
                }
            }),
        );
        (service, host, blocked_rx)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn executable(path: &Path, text: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, text).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

struct FixtureHost {
    root: PathBuf,
    gate: watch::Sender<bool>,
    ready: Notify,
    ready_count: AtomicUsize,
    old_bun: bool,
}
impl Host for FixtureHost {
    fn detect(&self) -> Boxed<'_, Result<Detection, String>> {
        Box::pin(async move {
            let mut presence = BTreeMap::new();
            for id in Item::ALL {
                let installed = self.root.join(format!("installed-{}", id.name())).exists();
                let version = if id == Item::Bun {
                    std::fs::read_to_string(self.root.join("bun-version"))
                        .unwrap_or_else(|_| "1.4.4".to_owned())
                } else {
                    "18.18.9".to_owned()
                };
                presence.insert(
                    id,
                    if id == Item::Bun && self.old_bun && !installed {
                        Presence::Outdated {
                            version: "1.4.2".to_owned(),
                            minimum: "1.4.4".to_owned(),
                            path: Some(self.root.join("bin/bun").to_string_lossy().into_owned()),
                        }
                    } else if installed {
                        Presence::Present {
                            version: Some(version),
                            path: Some(
                                self.root
                                    .join(if id == Item::Git {
                                        "git".to_owned()
                                    } else {
                                        format!("bin/{}", id.name())
                                    })
                                    .to_string_lossy()
                                    .into_owned(),
                            ),
                            extra: BTreeMap::new(),
                        }
                    } else {
                        Presence::Missing
                    },
                );
            }
            Ok(Detection {
                bun: (self.old_bun || self.root.join("installed-bun").exists())
                    .then(|| self.root.join("bin/bun").to_string_lossy().into_owned()),
                omp: self
                    .root
                    .join("installed-omp")
                    .exists()
                    .then(|| self.root.join("bin/omp").to_string_lossy().into_owned()),
                brew: None,
                winget: None,
                presence,
            })
        })
    }
    fn environment(&self) -> Boxed<'_, Result<Environment, String>> {
        Box::pin(async move {
            Ok(BTreeMap::from([
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                ("ROOT".to_owned(), self.root.to_string_lossy().into_owned()),
            ]))
        })
    }
    fn update_environment(&self, _omp: &str) -> Boxed<'_, Result<Environment, String>> {
        self.environment()
    }
    fn compiled_omp(&self, _file: &Path) -> bool {
        false
    }
    fn bun_minimum(&self, manifest: &Value) -> Option<String> {
        manifest
            .pointer("/engines/bun")
            .and_then(Value::as_str)
            .and_then(|range| range.strip_prefix(">="))
            .map(str::to_owned)
    }
    fn is_newer(&self, latest: &str, installed: Option<&str>) -> bool {
        installed.is_none_or(|installed| {
            latest
                .split('.')
                .map(|v| v.parse::<u64>().unwrap())
                .collect::<Vec<_>>()
                > installed
                    .split('.')
                    .map(|v| v.parse::<u64>().unwrap())
                    .collect::<Vec<_>>()
        })
    }
    fn refresh_path(&self) -> Boxed<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn before_omp_update(&self) -> Boxed<'_, Result<(), String>> {
        Box::pin(async move {
            std::fs::write(self.root.join("before-update"), "paused")
                .map_err(|error| error.to_string())
        })
    }
    fn git_aslr_log(&self, entry: ompdesk_core::setup::git_aslr::Log) {
        std::fs::write(self.root.join("aslr-log"), format!("{:?}", entry.outcome)).unwrap();
    }
    fn omp_ready(&self) {
        self.ready_count.fetch_add(1, Ordering::SeqCst);
        self.ready.notify_one();
    }
    fn before_optional(&self) -> Boxed<'_, ()> {
        Box::pin(async move {
            let mut gate = self.gate.subscribe();
            let _ = gate.wait_for(|open| *open).await;
        })
    }
}

#[tokio::test]
async fn empty_machine_installs_essential_tools_before_first_tab_then_optionals() {
    let fixture = Fixture::new("empty");
    let (service, host, _) = fixture.service(Platform::Darwin, false, false);
    let start = tokio::spawn(service.start());
    host.ready.notified().await;
    assert_eq!(fixture.runs(), ["bun:bun-script", "omp:bun-global"]);
    assert!(service.state().omp_ready);
    assert!(!service.state().required_running);
    assert_eq!(host.ready_count.load(Ordering::SeqCst), 1);
    host.gate.send_replace(true);
    start.await.unwrap().unwrap();
    assert_eq!(
        fixture.runs(),
        [
            "bun:bun-script",
            "omp:bun-global",
            "git:xcode-select",
            "gh:archive",
            "node:archive",
            "agent-desktop:agent-desktop-archive"
        ]
    );
    assert!(!fixture.root.join("installed-tailscale").exists());
    service.dispose();
}

#[tokio::test]
async fn bun_upgrade_failure_falls_back_without_counting_two_attempts() {
    let fixture = Fixture::new("fallback");
    std::fs::write(fixture.root.join("fail-bun-bun-upgrade"), "").unwrap();
    let (service, host, _) = fixture.service(Platform::Darwin, false, true);
    let start = tokio::spawn(service.start());
    host.ready.notified().await;
    assert_eq!(
        fixture.runs(),
        ["bun:bun-upgrade", "bun:bun-script", "omp:bun-global"]
    );
    let ledger: Value =
        serde_json::from_slice(&std::fs::read(fixture.root.join("setup-state.json")).unwrap())
            .unwrap();
    assert!(ledger.get("bun").is_none());
    service.dispose();
    start.await.unwrap().unwrap();
}

#[tokio::test]
async fn cancelling_install_ends_tree_drops_backoff_and_stops_pipeline() {
    let fixture = Fixture::new("cancel");
    std::fs::write(fixture.root.join("block-bun"), "").unwrap();
    let (service, _, mut blocked) = fixture.service(Platform::Darwin, true, false);
    let start = tokio::spawn(service.start());
    blocked.wait_for(|blocked| *blocked).await.unwrap();
    assert!(service.cancel());
    start.await.unwrap().unwrap();
    assert_eq!(fixture.runs(), ["bun:bun-script"]);
    assert!(fixture.root.join("stopped").exists());
    assert_eq!(service.state().items[0].phase, Phase::Cancelled);
    let ledger: Value =
        serde_json::from_slice(&std::fs::read(fixture.root.join("setup-state.json")).unwrap())
            .unwrap();
    assert!(ledger.get("bun").is_none());
    service.dispose();
}

#[tokio::test]
async fn manual_retry_bypasses_daily_backoff_and_launch_limit() {
    let fixture = Fixture::new("retry");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    std::fs::write(
        fixture.root.join("setup-state.json"),
        format!(r#"{{"bun":{{"failures":3,"lastAttempt":{now},"app":"1.0.0"}}}}"#),
    )
    .unwrap();
    let (service, _, _) = fixture.service(Platform::Darwin, true, false);
    service.start().await.unwrap();
    assert!(fixture.runs().is_empty());
    service.retry(Item::Bun).await.unwrap();
    assert!(service.state().omp_ready);
    assert_eq!(&fixture.runs()[..2], ["bun:bun-script", "omp:bun-global"]);
    service.dispose();
}

#[tokio::test]
async fn isolated_runner_reports_file_output_and_removes_log() {
    let fixture = Fixture::new("isolated");
    let scope = Scope::detached();
    let runner = Runner::new(
        PathBuf::from(env!("CARGO_BIN_EXE_ompdesk-core")),
        fixture.root.join("scratch"),
    );
    let mut spec = plans::command(
        "/bin/sh",
        &["-c", "printf 'isolated-output'; exit 0"],
        Platform::Darwin,
    );
    spec.isolated = true;
    let text = Arc::new(Mutex::new(String::new()));
    let kept = text.clone();
    let result = runner
        .run(
            &spec,
            &BTreeMap::new(),
            &scope,
            Arc::new(move |chunk| kept.lock().unwrap().push_str(chunk)),
            None,
        )
        .await;
    assert_eq!(result, RunOutcome::Succeeded);
    assert_eq!(*text.lock().unwrap(), "isolated-output");
    assert_eq!(
        std::fs::read_dir(fixture.root.join("scratch"))
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn target_bun_requirement_is_upgraded_before_omp_and_helpers_pause() {
    let fixture = Fixture::new("release-bun");
    for id in ["bun", "omp"] {
        std::fs::write(fixture.root.join(format!("installed-{id}")), "").unwrap();
    }
    std::fs::write(
        fixture.root.join("manifest"),
        r#"{"engines":{"bun":">=1.5.0"}}"#,
    )
    .unwrap();
    std::fs::write(fixture.root.join("target-bun-version"), "1.5.0").unwrap();
    let (service, _, _) = fixture.service(Platform::Darwin, false, false);
    let start = tokio::spawn(service.start());
    let outcome = service.update_omp("18.18.9".to_owned()).await.unwrap();
    assert!(matches!(
        outcome,
        ompdesk_core::setup::service::UpdateOutcome::Updated(_)
    ));
    assert_eq!(fixture.runs(), ["bun:bun-upgrade", "omp:omp-update"]);
    assert!(fixture.root.join("before-update").exists());
    service.dispose();
    start.await.unwrap().unwrap();
}

#[tokio::test]
async fn standalone_release_and_failed_manifest_never_start_an_update() {
    for (name, manifest, reason) in [
        ("binary", r#"{"omp":{"dist":"binary"}}"#, "install"),
        ("bad-json", "registry refused", "check"),
    ] {
        let fixture = Fixture::new(name);
        for id in ["bun", "omp"] {
            std::fs::write(fixture.root.join(format!("installed-{id}")), "").unwrap();
        }
        std::fs::write(fixture.root.join("manifest"), manifest).unwrap();
        let (service, _, _) = fixture.service(Platform::Darwin, false, false);
        let start = tokio::spawn(service.start());
        let outcome = service.update_omp("18.18.9".to_owned()).await.unwrap();
        match outcome {
            ompdesk_core::setup::service::UpdateOutcome::Failed(failure) => {
                assert_eq!(failure.reason, reason)
            }
            other => panic!("{other:?}"),
        }
        assert!(fixture.runs().is_empty());
        assert!(!fixture.root.join("before-update").exists());
        service.dispose();
        start.await.unwrap().unwrap();
    }
}

#[tokio::test]
async fn native_tool_update_uses_shared_queue_without_mutating_setup_items() {
    let fixture = Fixture::new("tool-update");
    let (service, _, _) = fixture.service(Platform::Darwin, false, false);
    let before = serde_json::to_value(service.state()).unwrap();
    let result = service
        .run_tool_update(ompdesk_core::setup::service::ToolRequest {
            tool: "codex".to_owned(),
            method: "npm".to_owned(),
            spawn: None,
            managed: None,
            env: BTreeMap::new(),
        })
        .await;
    assert_eq!(result, ompdesk_core::setup::service::ToolOutcome::Succeeded);
    assert_eq!(fixture.runs(), ["cli-codex:npm"]);
    assert_eq!(serde_json::to_value(service.state()).unwrap(), before);
    service.dispose();
}

#[tokio::test]
async fn tool_update_cancel_stops_its_supervised_tree() {
    let fixture = Fixture::new("tool-cancel");
    let pipe = fixture.root.join("ready");
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&pipe)
            .status()
            .unwrap()
            .success()
    );
    std::fs::write(fixture.root.join("block-cli-codex"), "").unwrap();
    let ready = tokio::task::spawn_blocking(move || std::fs::read_to_string(pipe).unwrap());
    let (service, _, _) = fixture.service(Platform::Darwin, false, false);
    let work = tokio::spawn(
        service.run_tool_update(ompdesk_core::setup::service::ToolRequest {
            tool: "codex".to_owned(),
            method: "npm".to_owned(),
            spawn: None,
            managed: None,
            env: BTreeMap::new(),
        }),
    );
    assert_eq!(ready.await.unwrap().trim(), "started");
    assert!(service.cancel());
    assert_eq!(
        work.await.unwrap(),
        ompdesk_core::setup::service::ToolOutcome::Cancelled
    );
    assert!(fixture.root.join("stopped").exists());
    service.dispose();
}

#[tokio::test]
async fn latest_omp_reads_stock_update_check_from_the_detected_install() {
    let fixture = Fixture::new("latest-omp");
    for id in ["bun", "omp"] {
        std::fs::write(fixture.root.join(format!("installed-{id}")), "").unwrap();
    }
    let (service, _, _) = fixture.service(Platform::Darwin, false, false);
    let start = tokio::spawn(service.start());
    assert_eq!(service.latest_omp().await.unwrap(), "18.19.0");
    std::fs::write(
        fixture.root.join("update-check"),
        "Current version: 18.18.9\nAlready up to date\n",
    )
    .unwrap();
    assert_eq!(service.latest_omp().await.unwrap(), "18.18.9");
    assert!(fixture.runs().is_empty());
    service.dispose();
    start.await.unwrap().unwrap();
}

#[tokio::test]
async fn git_aslr_fix_records_prior_and_undo_restores_only_recorded_images() {
    use ompdesk_core::setup::git_aslr::{Action, Prior, Record};
    let fixture = Fixture::new("aslr");
    std::fs::write(fixture.root.join("installed-git"), "").unwrap();
    let (service, _, _) = fixture.service(Platform::Win32, false, false);
    assert_eq!(service.git_aslr(Action::Fix).await.unwrap(), 1);
    let root = fixture.root.join("git").to_string_lossy().into_owned();
    let record = fixture.root.join("git-aslr.json");
    assert_eq!(Record::read(&record).images(&root)[0].prior, Prior::On);
    assert_eq!(service.git_aslr(Action::Undo).await.unwrap(), 1);
    let input: Value =
        serde_json::from_slice(&std::fs::read(fixture.root.join("undo-captured")).unwrap())
            .unwrap();
    assert_eq!(input[0]["prior"], 1);
    assert_eq!(input[0]["path"], format!("{root}/usr/bin/sh.exe"));
    assert!(!record.exists());
    assert!(fixture.root.join("aslr-log").exists());
    assert!(!fixture.root.join("git-aslr-in.json").exists());
    assert!(!fixture.root.join("git-aslr-out.json").exists());
    service.dispose();
}

#[tokio::test]
async fn partially_failed_git_aslr_fix_keeps_the_exact_undo_record() {
    use ompdesk_core::setup::git_aslr::{Action, Prior, Record};
    let fixture = Fixture::new("aslr-partial");
    std::fs::write(fixture.root.join("installed-git"), "").unwrap();
    std::fs::write(fixture.root.join("aslr-partial-fail"), "").unwrap();
    let (service, _, _) = fixture.service(Platform::Win32, false, false);
    assert!(service.git_aslr(Action::Fix).await.is_err());
    let root = fixture.root.join("git").to_string_lossy().into_owned();
    assert_eq!(
        Record::read(&fixture.root.join("git-aslr.json")).images(&root)[0].prior,
        Prior::On
    );
    service.dispose();
}

#[tokio::test]
async fn dropping_runner_future_cancels_and_reaps_before_scope_is_released() {
    let fixture = Fixture::new("drop-runner");
    let pipe = fixture.root.join("ready");
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&pipe)
            .status()
            .unwrap()
            .success()
    );
    std::fs::write(fixture.root.join("block-bun"), "").unwrap();
    let ready = tokio::task::spawn_blocking(move || std::fs::read_to_string(pipe).unwrap());
    let runner = Runner::new(
        PathBuf::from(env!("CARGO_BIN_EXE_ompdesk-core")),
        fixture.root.join("scratch"),
    );
    let (scope, gone) = Scope::watched();
    let held = scope.clone();
    let spec = plans::command(
        &fixture.root.join("installer").to_string_lossy(),
        &["bun", "drop"],
        Platform::Darwin,
    );
    let env = BTreeMap::from([
        ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
        (
            "ROOT".to_owned(),
            fixture.root.to_string_lossy().into_owned(),
        ),
    ]);
    let work =
        tokio::spawn(async move { runner.run(&spec, &env, &held, Arc::new(|_| {}), None).await });
    assert_eq!(ready.await.unwrap().trim(), "started");
    work.abort();
    assert!(work.await.unwrap_err().is_cancelled());
    drop(scope);
    gone.wait().await;
    assert!(fixture.root.join("stopped").exists());
}

#[tokio::test]
async fn capture_separates_streams_and_drains_past_each_cap_without_stopping() {
    use ompdesk_core::setup::runner::CaptureOptions;
    let fixture = Fixture::new("capture");
    let scratch = fixture.root.join("scratch");
    let runner = Runner::new(
        PathBuf::from(env!("CARGO_BIN_EXE_ompdesk-core")),
        scratch.clone(),
    );
    let spec = plans::command(
        "/bin/sh",
        &[
            "-c",
            "cat; printf stdout-tail; printf error-tail >&2; touch \"$ROOT/drained\"",
        ],
        Platform::Darwin,
    );
    let env = BTreeMap::from([
        ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
        (
            "ROOT".to_owned(),
            fixture.root.to_string_lossy().into_owned(),
        ),
    ]);
    let captured = runner
        .capture(
            spec,
            env,
            Scope::detached(),
            CaptureOptions {
                cwd: Some(fixture.root.clone()),
                input: b"input payload".to_vec(),
                timeout: std::time::Duration::from_secs(30),
                max_bytes: 5,
            },
        )
        .await;
    assert_eq!(captured.outcome, RunOutcome::Succeeded);
    assert_eq!(captured.stdout, b"input");
    assert_eq!(captured.stderr, b"error");
    assert!(captured.stdout_truncated && captured.stderr_truncated);
    assert!(!captured.timed_out);
    assert!(fixture.root.join("drained").exists());
    assert_eq!(std::fs::read_dir(scratch).unwrap().count(), 0);
}

#[tokio::test]
async fn capture_rejects_isolated_commands_instead_of_merging_their_streams() {
    use ompdesk_core::setup::runner::CaptureOptions;
    let fixture = Fixture::new("capture-isolated");
    let runner = Runner::new(
        PathBuf::from(env!("CARGO_BIN_EXE_ompdesk-core")),
        fixture.root.join("scratch"),
    );
    let mut spec = plans::command(
        "/bin/sh",
        &["-c", "printf output; printf error >&2; touch \"$ROOT/ran\""],
        Platform::Darwin,
    );
    spec.isolated = true;
    let env = BTreeMap::from([(
        "ROOT".to_owned(),
        fixture.root.to_string_lossy().into_owned(),
    )]);
    let captured = runner
        .capture(
            spec,
            env,
            Scope::detached(),
            CaptureOptions {
                cwd: None,
                input: Vec::new(),
                timeout: std::time::Duration::from_secs(30),
                max_bytes: 4096,
            },
        )
        .await;
    assert!(matches!(captured.outcome, RunOutcome::Failed { .. }));
    assert!(!fixture.root.join("ran").exists());
    assert!(captured.stdout.is_empty() && captured.stderr.is_empty());
}

#[tokio::test]
async fn capture_timeout_ends_tree_before_removing_its_input_file() {
    use ompdesk_core::setup::runner::CaptureOptions;
    use std::time::Duration;
    let fixture = Fixture::new("capture-timeout");
    let pipe = fixture.root.join("ready");
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&pipe)
            .status()
            .unwrap()
            .success()
    );
    std::fs::write(fixture.root.join("block-bun"), "").unwrap();
    let ready = tokio::task::spawn_blocking(move || std::fs::read_to_string(pipe).unwrap());
    let runner = Runner::new(
        PathBuf::from(env!("CARGO_BIN_EXE_ompdesk-core")),
        fixture.root.join("scratch"),
    );
    let spec = plans::command(
        &fixture.root.join("installer").to_string_lossy(),
        &["bun", "timeout"],
        Platform::Darwin,
    );
    let env = BTreeMap::from([
        ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
        (
            "ROOT".to_owned(),
            fixture.root.to_string_lossy().into_owned(),
        ),
    ]);
    let work = tokio::spawn(async move {
        runner
            .capture(
                spec,
                env,
                Scope::detached(),
                CaptureOptions {
                    cwd: None,
                    input: b"timeout-input".to_vec(),
                    timeout: Duration::from_secs(180),
                    max_bytes: 1024,
                },
            )
            .await
    });
    assert_eq!(ready.await.unwrap().trim(), "started");
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(181)).await;
    let captured = work.await.unwrap();
    tokio::time::resume();
    assert!(captured.timed_out);
    assert!(matches!(captured.outcome, RunOutcome::Failed { .. }));
    assert!(fixture.root.join("stopped").exists());
    assert_eq!(
        std::fs::read_dir(fixture.root.join("scratch"))
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn dropped_capture_keeps_input_until_the_supervised_tree_has_exited() {
    use ompdesk_core::setup::runner::CaptureOptions;
    let fixture = Fixture::new("capture-drop");
    let pipe = fixture.root.join("ready");
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&pipe)
            .status()
            .unwrap()
            .success()
    );
    let ready = tokio::task::spawn_blocking(move || std::fs::read_to_string(pipe).unwrap());
    let script = fixture.root.join("capture-installer");
    executable(
        &script,
        "#!/bin/sh\npath=\"$(find \"$ROOT/scratch\" -type f -name 'input-*')\"\ntrap 'test -f \"$path\" && echo kept > \"$ROOT/input-kept\"; exit 1' TERM INT\necho started > \"$ROOT/ready\"\nsleep 60 &\nwait $!\n",
    );
    let runner = Runner::new(
        PathBuf::from(env!("CARGO_BIN_EXE_ompdesk-core")),
        fixture.root.join("scratch"),
    );
    let spec = plans::command(&script.to_string_lossy(), &[], Platform::Darwin);
    let env = BTreeMap::from([
        ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
        (
            "ROOT".to_owned(),
            fixture.root.to_string_lossy().into_owned(),
        ),
    ]);
    let (scope, gone) = Scope::watched();
    let held = scope.clone();
    let work = tokio::spawn(async move {
        runner
            .capture(
                spec,
                env,
                held,
                CaptureOptions {
                    cwd: None,
                    input: b"kept-through-exit".to_vec(),
                    timeout: std::time::Duration::from_secs(180),
                    max_bytes: 1024,
                },
            )
            .await
    });
    assert_eq!(ready.await.unwrap().trim(), "started");
    work.abort();
    assert!(work.await.unwrap_err().is_cancelled());
    drop(scope);
    gone.wait().await;
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("input-kept"))
            .unwrap()
            .trim(),
        "kept"
    );
    assert_eq!(
        std::fs::read_dir(fixture.root.join("scratch"))
            .unwrap()
            .count(),
        0
    );
}
