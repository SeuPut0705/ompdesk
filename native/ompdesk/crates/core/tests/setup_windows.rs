use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ompdesk_core::server::Scope;
use ompdesk_core::setup::runner::{CaptureOptions, Runner};
use ompdesk_core::setup::types::{Environment, RunOutcome, SpawnSpec};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

const ROLE: &str = "OMPDESK_SETUP_WINDOWS_PROBE";
const ADDRESS: &str = "OMPDESK_SETUP_WINDOWS_ADDRESS";
const LIMIT: Duration = Duration::from_secs(30);

// The test executable is the isolated fixture command, never an installed tool or a shell script.
#[test]
#[ignore]
fn probe() {
    let role = std::env::var(ROLE).unwrap();
    if role == "streams" {
        let mut input = Vec::new();
        std::io::stdin().read_to_end(&mut input).unwrap();
        assert_eq!(input, b"native input\0bytes");
        let mut out = std::io::stdout().lock();
        let mut err = std::io::stderr().lock();
        out.write_all(b"stdout-only-marker\n").unwrap();
        err.write_all(b"stderr-only-marker\n").unwrap();
        for _ in 0..32 {
            out.write_all(&[b'o'; 8192]).unwrap();
            err.write_all(&[b'e'; 8192]).unwrap();
        }
        out.flush().unwrap();
        err.flush().unwrap();
        std::net::TcpStream::connect(std::env::var(ADDRESS).unwrap())
            .unwrap()
            .write_all(b"drained\n")
            .unwrap();
        return;
    }
    if role == "output" {
        println!("isolated-stdout-marker");
        eprintln!("isolated-stderr-marker");
        return;
    }
    let mut child = if role == "parent" {
        Some(
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "probe", "--ignored", "--nocapture"])
                .env(ROLE, "descendant")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        )
    } else {
        assert_eq!(role, "descendant");
        None
    };
    let mut signal = std::net::TcpStream::connect(std::env::var(ADDRESS).unwrap()).unwrap();
    writeln!(signal, "{}", std::process::id()).unwrap();
    let mut release = [0; 1];
    let _ = signal.read(&mut release);
    // On a failed test, closing its sockets lets the fixtures exit without leaving a process behind.
    if let Some(child) = &mut child {
        child.wait().unwrap();
    }
}

struct Fixture {
    root: PathBuf,
    runner: Runner,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let root = std::env::var_os("OMP_SETUP_SCRATCH")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!("setup-windows-{label}-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        Self {
            runner: Runner::new(
                PathBuf::from(env!("CARGO_BIN_EXE_ompdesk-core")),
                root.clone(),
            ),
            root,
        }
    }

    fn command(&self, role: &str, isolated: bool) -> (SpawnSpec, Environment) {
        let spec = SpawnSpec {
            file: std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            args: ["--exact", "probe", "--ignored", "--nocapture"]
                .map(str::to_owned)
                .into(),
            shell: false,
            input_file: None,
            isolated,
        };
        let mut env: Environment = std::env::vars().collect();
        env.insert(ROLE.to_owned(), role.to_owned());
        (spec, env)
    }

    fn empty(&self) {
        assert_eq!(std::fs::read_dir(&self.root).unwrap().count(), 0);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessWitness {
    pid: u32,
    started_ms: Option<u64>,
}

async fn processes() -> Vec<ProcessWitness> {
    use ompdesk_core::server::{Registry, serve};
    use tokio::io::AsyncWriteExt;
    let (client, server) = tokio::io::duplex(64 * 1024);
    let (input, output) = tokio::io::split(server);
    let mut registry = Registry::default();
    ompdesk_core::procs::register(&mut registry);
    let serving = tokio::spawn(serve(input, output, registry));
    let (input, mut output) = tokio::io::split(client);
    let mut input = BufReader::new(input);
    let mut line = String::new();
    input.read_line(&mut line).await.unwrap();
    output
        .write_all(
            b"{\"id\":1,\"method\":\"procs.list\",\"params\":{\"env\":\"OMPDESK_SETUP_WINDOWS_PROBE\",\"timeoutMs\":30000}}\n",
        )
        .await
        .unwrap();
    line.clear();
    input.read_line(&mut line).await.unwrap();
    let answer: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert!(answer.get("error").is_none(), "{answer}");
    let rows = serde_json::from_value(answer["result"].clone()).unwrap();
    drop(output);
    drop(input);
    serving.await.unwrap().unwrap();
    rows
}

async fn ready(listener: &TcpListener) -> Vec<(ProcessWitness, TcpStream)> {
    let mut children = Vec::new();
    for _ in 0..2 {
        let (stream, _) = listener.accept().await.unwrap();
        let mut stream = BufReader::new(stream);
        let mut pid = String::new();
        stream.read_line(&mut pid).await.unwrap();
        let pid: u32 = pid.trim().parse().unwrap();
        let process = processes()
            .await
            .into_iter()
            .find(|row| row.pid == pid)
            .expect("ready fixture process is visible to the native process scanner");
        assert!(process.started_ms.is_some());
        children.push((process, stream.into_inner()));
    }
    children
}

async fn ended(children: &[(ProcessWitness, TcpStream)]) {
    let rows = processes().await;
    for (process, _) in children {
        assert!(
            !rows
                .iter()
                .any(|row| row.pid == process.pid && row.started_ms == process.started_ms),
            "supervised process still runs"
        );
    }
}

#[tokio::test]
async fn isolated_supervisor_returns_both_log_streams_and_removes_log() {
    let fixture = Fixture::new("output");
    let (spec, env) = fixture.command("output", true);
    let output = Arc::new(Mutex::new(String::new()));
    let sink = output.clone();
    let outcome = tokio::time::timeout(
        LIMIT,
        fixture.runner.run(
            &spec,
            &env,
            &Scope::detached(),
            Arc::new(move |text| sink.lock().unwrap().push_str(text)),
            None,
        ),
    )
    .await
    .unwrap();
    assert_eq!(outcome, RunOutcome::Succeeded);
    let output = output.lock().unwrap();
    assert!(output.contains("isolated-stdout-marker"));
    assert!(output.contains("isolated-stderr-marker"));
    fixture.empty();
}

#[tokio::test]
async fn isolated_cancel_joins_parent_and_descendant_before_returning() {
    let fixture = Fixture::new("cancel");
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let (spec, mut env) = fixture.command("parent", true);
    env.insert(
        ADDRESS.to_owned(),
        listener.local_addr().unwrap().to_string(),
    );
    let scope = Scope::detached();
    let held = scope.clone();
    let runner = fixture.runner.clone();
    let work =
        tokio::spawn(async move { runner.run(&spec, &env, &held, Arc::new(|_| {}), None).await });
    let children = tokio::time::timeout(LIMIT, ready(&listener)).await;
    scope.cancel();
    let outcome = tokio::time::timeout(LIMIT, work).await.unwrap().unwrap();
    let children = children.unwrap();
    assert_eq!(outcome, RunOutcome::Cancelled);
    ended(&children).await;
    fixture.empty();
}

#[tokio::test]
async fn capture_keeps_streams_separate_and_drains_each_after_cap() {
    let fixture = Fixture::new("capture");
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let (spec, mut env) = fixture.command("streams", false);
    env.insert(
        ADDRESS.to_owned(),
        listener.local_addr().unwrap().to_string(),
    );
    let captured = fixture
        .runner
        .capture(
            spec,
            env,
            Scope::detached(),
            CaptureOptions {
                cwd: None,
                input: b"native input\0bytes".to_vec(),
                timeout: LIMIT,
                max_bytes: 4096,
            },
        )
        .await;
    assert_eq!(captured.outcome, RunOutcome::Succeeded);
    assert!(!captured.timed_out);
    assert!(captured.stdout_truncated && captured.stderr_truncated);
    let out = String::from_utf8_lossy(&captured.stdout);
    let err = String::from_utf8_lossy(&captured.stderr);
    assert!(out.contains("stdout-only-marker"));
    assert!(!out.contains("stderr-only-marker"));
    assert!(err.contains("stderr-only-marker"));
    assert!(!err.contains("stdout-only-marker"));
    let (mut stream, _) = tokio::time::timeout(LIMIT, listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut finished = String::new();
    stream.read_to_string(&mut finished).await.unwrap();
    assert_eq!(finished, "drained\n");
    fixture.empty();
}

#[tokio::test]
async fn dropped_capture_joins_tree_before_scope_and_input_are_released() {
    let fixture = Fixture::new("capture-drop");
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let (spec, mut env) = fixture.command("parent", false);
    env.insert(
        ADDRESS.to_owned(),
        listener.local_addr().unwrap().to_string(),
    );
    let (scope, gone) = Scope::watched();
    let runner = fixture.runner.clone();
    let work = tokio::spawn(async move {
        runner
            .capture(
                spec,
                env,
                scope,
                CaptureOptions {
                    cwd: None,
                    input: b"held until tree exit".to_vec(),
                    timeout: LIMIT,
                    max_bytes: 4096,
                },
            )
            .await
    });
    let children = tokio::time::timeout(LIMIT, ready(&listener)).await;
    work.abort();
    let _ = work.await;
    tokio::time::timeout(LIMIT, gone.wait()).await.unwrap();
    let children = children.unwrap();
    ended(&children).await;
    fixture.empty();
}

#[tokio::test]
async fn capture_timeout_joins_tree_and_cleans_input() {
    let fixture = Fixture::new("capture-timeout");
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let (spec, mut env) = fixture.command("parent", false);
    env.insert(
        ADDRESS.to_owned(),
        listener.local_addr().unwrap().to_string(),
    );
    let scope = Scope::detached();
    let held = scope.clone();
    let runner = fixture.runner.clone();
    let work = tokio::spawn(async move {
        runner
            .capture(
                spec,
                env,
                held,
                CaptureOptions {
                    cwd: None,
                    input: b"held until timeout".to_vec(),
                    timeout: Duration::from_secs(180),
                    max_bytes: 4096,
                },
            )
            .await
    });
    let children = tokio::time::timeout(LIMIT, ready(&listener)).await;
    if children.is_err() {
        scope.cancel();
        let _ = tokio::time::timeout(LIMIT, work).await;
        panic!("fixture tree did not become ready");
    }
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(181)).await;
    tokio::time::resume();
    let captured = tokio::time::timeout(LIMIT, work).await.unwrap().unwrap();
    assert!(captured.timed_out);
    assert!(matches!(captured.outcome, RunOutcome::Failed { .. }));
    ended(&children.unwrap()).await;
    fixture.empty();
}
