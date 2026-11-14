use std::collections::BTreeMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::git::{run::Git, seed};
use crate::run::Runner;
use crate::server::{Fault, Scope};

#[derive(Clone)]
pub struct Config {
    pub env: BTreeMap<String, String>,
    pub supervisor: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupReport {
    script: String,
    ok: bool,
    exit_code: Option<i32>,
    timed_out: bool,
    duration_ms: u128,
    log_path: String,
    output_tail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<seed::Report>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup: Option<SetupReport>,
}

pub async fn prepare(
    runner: &Runner,
    config: &Config,
    scope: Scope,
    primary: &str,
    target: &str,
) -> Result<Prepared, Fault> {
    let result = seed::seed(
        Git::new(runner.clone(), scope.clone()),
        scope.clone(),
        primary.to_owned(),
        target.to_owned(),
        seed::Limits {
            budget: Duration::from_secs(60),
            pretend_clones: None,
        },
    )
    .await;
    let seed = match result {
        Ok(seed) => seed,
        Err(_) if scope.cancelled() => return Err(Fault::cancelled()),
        Err(error) => Some(seed::Report {
            copied: 0,
            bytes: 0,
            cloned: false,
            skipped: vec![seed::Skipped {
                path: ".worktreeinclude".into(),
                reason: error.message,
            }],
        }),
    };
    let git = Git::new(runner.clone(), scope.clone());
    let script_name = if cfg!(windows) {
        ".ompdesk/worktree-setup.cmd"
    } else {
        ".ompdesk/worktree-setup"
    };
    let hook = seed::hook(
        &git,
        primary,
        target,
        script_name,
        "ompdesk-worktree-setup.log",
    )
    .await?;
    let Some(hook) = hook else {
        return Ok(Prepared { seed, setup: None });
    };
    let config = config.clone();
    let primary = primary.to_owned();
    let target = target.to_owned();
    let task_scope = scope.clone();
    let setup = tokio::spawn(async move {
        run_setup(
            &config,
            task_scope,
            &primary,
            &target,
            &hook.script,
            &hook.log_path,
        )
        .await
    })
    .await
    .map_err(|_| Fault::new("internal", "Worktree setup supervisor failed"))??;
    Ok(Prepared {
        seed,
        setup: Some(setup),
    })
}

async fn run_setup(
    config: &Config,
    scope: Scope,
    primary: &str,
    target: &str,
    script: &str,
    log_path: &str,
) -> Result<SetupReport, Fault> {
    if scope.cancelled() {
        return Err(Fault::cancelled());
    }
    let started = Instant::now();
    let spec = if cfg!(windows) {
        serde_json::json!({"file": format!("\"{script}\""), "args": [], "shell": true})
    } else {
        serde_json::json!({"file": "/bin/sh", "args": [script], "shell": false})
    };
    let mut command = Command::new(&config.supervisor);
    command
        .arg("--supervise")
        .current_dir(target)
        .env_clear()
        .envs(&config.env)
        .env("OMPDESK_ROOT_PATH", primary)
        .env("OMPDESK_WORKTREE_PATH", target)
        .env("OMPDESK_HOOK", "setup")
        .env("OMPDESK_SETUP_SPEC", spec.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let (exit_code, timed_out, output) = match command.spawn() {
        Err(error) => (None, false, format!("{error}\n")),
        Ok(mut child) => {
            let stdin = child.stdin.take();
            let stdout = child.stdout.take().expect("piped stdout");
            let stderr = child.stderr.take().expect("piped stderr");
            let bytes = Arc::new(Mutex::new(Vec::new()));
            let read_out = tokio::spawn(collect(stdout, Arc::clone(&bytes)));
            let read_err = tokio::spawn(collect(stderr, Arc::clone(&bytes)));
            let mut stdin = stdin;
            let mut timed_out = false;
            let status = tokio::select! {
                status = child.wait() => status,
                _ = tokio::time::sleep(Duration::from_secs(120)) => {
                    timed_out = true; drop(stdin.take()); child.wait().await
                },
                _ = scope.on_cancel() => { drop(stdin.take()); let _ = child.wait().await; let _ = read_out.await; let _ = read_err.await; return Err(Fault::cancelled()); }
            };
            drop(stdin);
            let _ = read_out.await;
            let _ = read_err.await;
            let buffer =
                std::mem::take(&mut *bytes.lock().unwrap_or_else(|error| error.into_inner()));
            let output = String::from_utf8(buffer)
                .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned());
            let code = status
                .ok()
                .and_then(|status| status.code())
                .filter(|code| *code != 130 && !timed_out);
            (code, timed_out, output)
        }
    };
    let mut units = [0u16; 4096];
    let mut start = units.len();
    'tail: for ch in output.chars().rev() {
        let mut pair = [0u16; 2];
        for unit in ch.encode_utf16(&mut pair).iter().rev() {
            if start == 0 {
                break 'tail;
            }
            start -= 1;
            units[start] = *unit;
        }
    }
    let output_tail = String::from_utf16_lossy(&units[start..]);
    let log_file = log_path.to_owned();
    let _ = crate::git::read::blocking(move || std::fs::write(log_file, output)).await;
    let path = std::path::Path::new(script);
    let relative = path
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| path.strip_prefix(p).ok())
        .unwrap_or(path);
    Ok(SetupReport {
        script: relative.to_string_lossy().into_owned(),
        ok: !timed_out && exit_code == Some(0),
        exit_code,
        timed_out,
        duration_ms: started.elapsed().as_millis(),
        log_path: log_path.to_owned(),
        output_tail,
    })
}

async fn collect(mut pipe: impl tokio::io::AsyncRead + Unpin, bytes: Arc<Mutex<Vec<u8>>>) {
    let mut chunk = [0; 8192];
    while let Ok(n) = pipe.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        bytes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend_from_slice(&chunk[..n]);
    }
}

#[cfg(test)]
#[path = "prepare_tests.rs"]
mod tests;
