//! A scheduled run's omp (was `ompRunLauncher` of `src/main/schedules.ts`): `omp -p [--model m] [--yolo]` under the
//! supervisor (`supervise.rs`, this binary in its `--supervise` mode), the prompt file as its stdin, stdout and
//! stderr appended to the run's log. omp reads a piped stdin as its prompt and never watches it for its end, so the
//! supervisor hands it the prompt file and ends omp's whole process tree when its own stdin closes: a stop
//! (`schedules.launchStop`), or the end of this process, however it ends.
//!
//! Main hands how to run with the request, as it does for git and gh: the supervisor's path, the omp and its
//! arguments (already spelled for a shell where a `.cmd` needs one), the whole environment, the folder. It names the
//! run. `schedules.launch` answers once the supervisor was started (or could not be: then the run ends at once, as
//! node told a spawn's failure); `schedules.launchEnded` `{run, code, error?}` says how it ended.
//!
//! The supervisor leads a session of its own on POSIX: main kills this process's group once it is gone, and a
//! supervisor in it would die before it ended omp's tree. On Windows it is in this process's job, and omp's tree in
//! a job that ends with the supervisor.

use std::collections::{BTreeMap, HashMap};
use std::fs::OpenOptions;
use std::io::Write;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use tokio::process::{ChildStdin, Command};

use super::locked;
use crate::fs::error::uv_code;
use crate::run::Runner;
use crate::server::{Call, Fault, Registry, Reply};

/// The variable the supervisor reads its command from (`SPEC_ENV` in `supervise.rs`).
const SPEC_ENV: &str = "OMPDESK_SETUP_SPEC";

/// The stdin of each supervisor that runs, by the name main gave its run: closing it stops the run.
static RUNS: LazyLock<Mutex<HashMap<String, ChildStdin>>> = LazyLock::new(Default::default);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchParams {
    run: String,
    /// This binary, as main finds it (`nativeBinPath`).
    supervisor: String,
    file: String,
    args: Vec<String>,
    shell: bool,
    env: BTreeMap<String, String>,
    cwd: String,
    /// The run's log, appended to.
    log: String,
    /// The file omp reads as its stdin.
    prompt: String,
    /// The log's first lines: the command and its folder.
    header: String,
}

#[derive(Serialize)]
struct Spec<'a> {
    file: &'a str,
    args: &'a [String],
    shell: bool,
    #[serde(rename = "inputFile")]
    input_file: &'a str,
}

#[derive(Serialize)]
struct Ended<'a> {
    run: &'a str,
    code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn launch(call: &Call) -> Result<Reply, Fault> {
    let params: LaunchParams = call.params()?;
    let spec = serde_json::to_string(&Spec {
        file: &params.file,
        args: &params.args,
        shell: params.shell,
        input_file: &params.prompt,
    })
    .map_err(|error| Fault::new("internal", error.to_string()))?;
    // A log that cannot be written (disk full, folder removed) must not stop the run: it goes on unlogged.
    let log = OpenOptions::new()
        .append(true)
        .create(true)
        .open(&params.log)
        .and_then(|mut log| log.write_all(params.header.as_bytes()).map(|()| log))
        .ok();
    // One file for both streams, so they keep their order of arrival.
    let output = || {
        log.as_ref()
            .and_then(|log| log.try_clone().ok())
            .map_or_else(Stdio::null, Stdio::from)
    };
    let runner = Runner {
        bin: params.supervisor,
        args: Vec::new(),
        env: params.env,
        timeout_ms: 0,
        max_bytes: 0,
    };
    let mut command = Command::new(&runner.bin);
    command
        .arg("--supervise")
        .env_clear()
        .current_dir(&params.cwd)
        .stdin(Stdio::piped())
        .stdout(output())
        .stderr(output());
    runner.environment(&mut command, &[(SPEC_ENV, &spec)]);
    #[cfg(unix)]
    crate::sys::new_session(command.as_std_mut());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let events = call.events.clone();
    let run = params.run;
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            // Node told a spawn's failure as the child's `error` event: the run was started, and ended at once.
            let error = Some(format!("spawn {} {}", runner.bin, uv_code(&error)));
            events.send(
                "schedules.launchEnded",
                &Ended {
                    run: &run,
                    code: None,
                    error,
                },
            );
            return Reply::json(&());
        }
    };
    if let Some(stdin) = child.stdin.take() {
        locked(&RUNS).insert(run.clone(), stdin);
    }
    tokio::spawn(async move {
        let status = child.wait().await;
        locked(&RUNS).remove(&run);
        let code = status.ok().and_then(|status| status.code());
        events.send(
            "schedules.launchEnded",
            &Ended {
                run: &run,
                code,
                error: None,
            },
        );
    });
    Reply::json(&())
}

#[derive(Deserialize)]
struct StopParams {
    run: String,
}

pub fn register(registry: &mut Registry) {
    registry.add("schedules.launch", |call| {
        Box::pin(async move { launch(&call) })
    });
    registry.add("schedules.launchStop", |call| {
        Box::pin(async move {
            let StopParams { run } = call.params()?;
            // The supervisor ends omp's tree as its stdin closes; a run that ended already has none.
            Reply::json(&locked(&RUNS).remove(&run).is_some())
        })
    });
}
