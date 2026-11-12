//! The one model call the upkeep and the care make (was `src/main/ai-memory/distill-model.ts`): `omp -p` on the cheap
//! role, no tools, no session, no extensions (so ai-memory's own extension does not record the call), a system prompt
//! of our own and the digest on stdin.
//!
//! It runs in an empty folder of its own, never the project's: omp reads the folder's context files (AGENTS.md) into
//! every request, and this repository's alone is 157k tokens, which turned a $0.015 call into a $0.64 one when
//! measured.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};

use super::asks::Asker;
use crate::fs::error::{Codes, NodeError, uv_code};
use crate::fs::order::js_trim;
use crate::json::whole_surrogates;
use crate::run::{KILL_GRACE, Runner, terminate};
use crate::server::{Call, Fault, Registry, Reply};

const MODEL_ROLE: &str = "pi/smol";
const TIMEOUT: Duration = Duration::from_secs(180);
/// What a run's stdout and stderr may hold before the rest is read and dropped (node kept all of it).
const OUTPUT_CAP: usize = 64 * 1024 * 1024;

/// How omp starts, as main hands it over: the binary and the whole environment (main's, `PATH` with omp's own
/// folders, telemetry off).
#[derive(Debug, Clone, Deserialize)]
pub struct OmpLaunch {
    pub bin: String,
    pub env: BTreeMap<String, String>,
}

/// The system prompt and the text on stdin (`DistillMessage`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub system: String,
    pub user: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelResult {
    pub text: String,
    pub model: String,
    pub input_tokens: f64,
    pub output_tokens: f64,
    /// What the provider billed for the call (omp's own accounting), in US dollars.
    pub cost_usd: f64,
}

/// `value` as `record()` read it: the members of an object, else nothing (`Value::Null` has none).
fn member<'a>(value: &'a Value, name: &str) -> &'a Value {
    match value {
        Value::Object(members) => members.get(name).unwrap_or(&Value::Null),
        _ => &Value::Null,
    }
}

/// `typeof value === "number" && Number.isFinite(value) ? value : 0`.
fn count(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number
            .as_f64()
            .filter(|number| number.is_finite())
            .unwrap_or(0.0),
        _ => 0.0,
    }
}

/// `text` with each number JavaScript reads as ±Infinity (`1e999`) written as `null`, which every reader of the
/// message sees as it saw the infinity: not a number (a count of 0), not a string, not an object.
fn nulled_overflows(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut copied, mut at, mut in_string) = (0, 0, false);
    while at < bytes.len() {
        let byte = bytes[at];
        if in_string {
            match byte {
                b'\\' => at += 1,
                b'"' => in_string = false,
                _ => {}
            }
            at += 1;
        } else if byte == b'"' {
            in_string = true;
            at += 1;
        } else if byte == b'-' || byte.is_ascii_digit() {
            let length = bytes[at..]
                .iter()
                .take_while(|byte| matches!(byte, b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'))
                .count();
            let end = at + length;
            if text[at..end].parse::<f64>().is_ok_and(f64::is_infinite) {
                out.push_str(&text[copied..at]);
                out.push_str("null");
                copied = end;
            }
            at = end;
        } else {
            at += 1;
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// One line of omp's JSON events as `JSON.parse` read it: a line that is no JSON is `None`.
fn parse_line(line: &str) -> Option<Value> {
    let text = whole_surrogates(line);
    match serde_json::from_str(&text) {
        Ok(value) => Some(value),
        Err(error) if error.to_string().starts_with("number out of range") => {
            serde_json::from_str(&nulled_overflows(&text)).ok()
        }
        Err(_) => None,
    }
}

/// The last assistant message of `omp --mode json`'s event lines (their text, the model, tokens and cost), or none.
pub fn parse_omp_json(stdout: &str) -> Option<ModelResult> {
    let mut result = None;
    for line in stdout.split('\n') {
        if !line.starts_with('{') {
            continue;
        }
        let Some(event) = parse_line(line) else {
            continue;
        };
        let message = member(&event, "message");
        if member(&event, "type") != "message_end" || member(message, "role") != "assistant" {
            continue;
        }
        let usage = member(message, "usage");
        let parts: &[Value] = match member(message, "content") {
            Value::Array(parts) => parts,
            _ => &[],
        };
        result = Some(ModelResult {
            text: parts
                .iter()
                .map(|part| match member(part, "text") {
                    Value::String(text) => text.as_str(),
                    _ => "",
                })
                .collect(),
            model: match member(message, "model") {
                Value::String(model) => model.clone(),
                _ => String::new(),
            },
            input_tokens: count(member(usage, "input"))
                + count(member(usage, "cacheRead"))
                + count(member(usage, "cacheWrite")),
            output_tokens: count(member(usage, "output")),
            cost_usd: count(member(member(usage, "cost"), "total")),
        });
    }
    result
}

/// What omp wrote and how it ended.
struct Ran {
    code: i32,
    stdout: String,
    stderr: String,
}

/// Reads `pipe` to its end, keeping its first `OUTPUT_CAP` bytes and reading (and dropping) the rest, so the process
/// never blocks on a full pipe.
async fn read_kept(mut pipe: impl tokio::io::AsyncRead + Unpin) -> Vec<u8> {
    let mut kept = Vec::new();
    let _ = (&mut pipe)
        .take(OUTPUT_CAP as u64)
        .read_to_end(&mut kept)
        .await;
    let _ = tokio::io::copy(&mut pipe, &mut tokio::io::sink()).await;
    kept
}

/// Asks the process to end and kills it if it has not exited `KILL_GRACE` later.
async fn end(child: &mut Child) {
    terminate(child);
    if tokio::time::timeout(KILL_GRACE, child.wait())
        .await
        .is_err()
    {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

/// Runs omp with `args` in `cwd`, `input` on its stdin. Dropping the future ends the process (`kill_on_drop`): a
/// cancelled request leaves no omp behind.
async fn run_omp(
    launch: &OmpLaunch,
    args: Vec<String>,
    cwd: &Path,
    input: &str,
    timeout: Duration,
) -> Result<Ran, Fault> {
    let runner = Runner {
        bin: launch.bin.clone(),
        args,
        env: launch.env.clone(),
        timeout_ms: 0,
        max_bytes: 0,
    };
    // A `.cmd` omp (npm's shim on Windows) starts through cmd.exe, each argument escaped for it: the standard
    // library does both for a batch file (and refuses an argument with a line break there).
    let mut command = Command::new(&runner.bin);
    command
        .args(&runner.args)
        .current_dir(cwd)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Telemetry export stays off for an internal call, whatever `OTEL_*` the user's environment names.
    runner.environment(&mut command, &[("OTEL_SDK_DISABLED", "true")]);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|error| {
        Fault::new(
            "spawn_failed",
            format!("spawn {} {}", runner.bin, uv_code(&error)),
        )
    })?;
    let (Some(mut stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Err(Fault::new("internal", "the process's pipes were not open"));
    };
    // Beside the reads: input larger than the pipe is taken only as omp reads it. An omp that ended before it read
    // everything closes the pipe: its exit code says so, not this write.
    let feed = async move {
        let _ = stdin.write_all(input.as_bytes()).await;
    };
    let finished = tokio::time::timeout(timeout, async {
        tokio::join!(child.wait(), read_kept(stdout), read_kept(stderr), feed)
    })
    .await;
    match finished {
        Ok((status, stdout, stderr, ())) => Ok(Ran {
            code: status.ok().and_then(|status| status.code()).unwrap_or(1),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        }),
        Err(_) => {
            end(&mut child).await;
            Err(Fault::new(
                "omp_timeout",
                format!("omp -p timed out after {}ms", timeout.as_millis()),
            ))
        }
    }
}

/// Runs the message on the user's cheap model through their own omp. Fails with omp's own words when it does.
pub async fn run_smol(
    launch: &OmpLaunch,
    message: &Message,
    cwd: &Path,
) -> Result<ModelResult, Fault> {
    run_smol_within(launch, message, cwd, TIMEOUT).await
}

async fn run_smol_within(
    launch: &OmpLaunch,
    message: &Message,
    cwd: &Path,
    timeout: Duration,
) -> Result<ModelResult, Fault> {
    let folder = cwd.to_owned();
    tokio::task::spawn_blocking(move || std::fs::create_dir_all(folder))
        .await
        .map_err(|error| Fault::new("internal", error.to_string()))?
        .map_err(|error| {
            NodeError::new(&error, "mkdir", Some(&cwd.to_string_lossy())).fault(Codes::None)
        })?;
    let args = [
        "-p",
        "--mode",
        "json",
        "--no-tools",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-rules",
        "--no-title",
        "--model",
        MODEL_ROLE,
        "--thinking",
        "off",
        "--system-prompt",
        &message.system,
    ]
    .map(str::to_owned)
    .to_vec();
    let ran = run_omp(launch, args, cwd, &message.user, timeout).await?;
    let result = parse_omp_json(&ran.stdout);
    match result {
        Some(result) if ran.code == 0 => Ok(result),
        _ => {
            let stderr = js_trim(&ran.stderr);
            let detail = stderr.split('\n').next_back().unwrap_or_default();
            Err(Fault::new(
                "omp_failed",
                match detail {
                    "" => format!("omp exited {}", ran.code),
                    detail => format!("omp exited {}: {detail}", ran.code),
                },
            ))
        }
    }
}

/// Where the model call goes.
pub enum Model {
    /// Ask main where omp is (`omp` `{}` → `{bin, env}`) and run it in `cwd`.
    Omp(Asker, PathBuf),
    /// Ask main for the answer (`model` `{message}` → `ModelResult`): a test's fake model.
    Main(Asker),
}

impl Model {
    /// `Main` when `asks` lists `model`, else omp in `cwd`.
    pub fn choose(asker: &Asker, asks: &[String], cwd: PathBuf) -> Model {
        if asks.iter().any(|kind| kind == "model") {
            Model::Main(asker.clone())
        } else {
            Model::Omp(asker.clone(), cwd)
        }
    }

    pub async fn call(&self, message: &Message) -> Result<ModelResult, Fault> {
        match self {
            Model::Omp(asker, cwd) => {
                let launch = asker.ask("omp", json!({})).await?;
                let launch: OmpLaunch = serde_json::from_value(launch).map_err(|error| {
                    Fault::new(
                        "memory_main",
                        format!("omp answered another shape than a launch: {error}"),
                    )
                })?;
                run_smol(&launch, message, cwd).await
            }
            Model::Main(asker) => {
                let answer = asker.ask("model", json!({ "message": message })).await?;
                serde_json::from_value(answer).map_err(|error| {
                    Fault::new(
                        "memory_main",
                        format!("model answered another shape than a result: {error}"),
                    )
                })
            }
        }
    }
}

#[derive(Deserialize)]
struct RunParams {
    launch: OmpLaunch,
    message: Message,
    cwd: PathBuf,
}

/// `upkeep.runSmol`: the thin client's call (`runSmol(launch, message, cwd)` in `distill-model.ts`).
async fn run(call: Call) -> Result<Reply, Fault> {
    let RunParams {
        launch,
        message,
        cwd,
    } = call.params()?;
    tokio::select! {
        result = run_smol(&launch, &message, &cwd) => Reply::json(&result?),
        () = call.scope.on_cancel() => Err(Fault::cancelled()),
    }
}

pub fn register(registry: &mut Registry) {
    registry.add("upkeep.runSmol", |call| Box::pin(run(call)));
}

#[cfg(test)]
mod tests {
    use super::super::asks::rig::{Rig, Said};
    use super::*;
    use crate::fs::disk::make_temp_dir;

    /// `distill-model.test.ts`'s two `parseOmpJson` cases and the rows captured from the TypeScript before it was
    /// deleted (the same cases, then edge rows: usage fields missing or of another type, numbers JavaScript reads
    /// as infinity, several `message_end` lines, lines that are no JSON, a BOM, CRLF), replayed.
    #[test]
    fn reads_the_last_assistant_message_as_the_typescript_did() {
        let tables: Value = serde_json::from_str(include_str!("model-captured.json")).unwrap();
        let rows = tables["parseOmpJson"].as_array().unwrap();
        assert!(rows.len() >= 72);
        for row in rows {
            let name = row["name"].as_str().unwrap();
            let expected: Option<ModelResult> =
                serde_json::from_value(row["expected"].clone()).unwrap();
            assert_eq!(
                parse_omp_json(row["stdout"].as_str().unwrap()),
                expected,
                "{name}"
            );
        }
    }

    fn temp(name: &str) -> PathBuf {
        make_temp_dir(&format!("ompdesk-core-smol-{name}-")).unwrap()
    }

    /// A stand-in omp in `dir`, a folder with a space in its name: a shell script, or on Windows a `.cmd` as npm's
    /// shim is. The script is written by a process of its own on POSIX, so that no process this test binary starts
    /// meanwhile holds it open for writing (exec would refuse it).
    fn stand_in(dir: &Path, sh: &str, cmd: &str) -> String {
        let folder = dir.join("fake omp");
        std::fs::create_dir_all(&folder).unwrap();
        if cfg!(windows) {
            let path = folder.join("omp.cmd");
            std::fs::write(
                &path,
                format!("@echo off\r\n{}\r\n", cmd.replace('\n', "\r\n")),
            )
            .unwrap();
            return path.to_string_lossy().into_owned();
        }
        let path = folder.join("omp").to_string_lossy().into_owned();
        let written = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                "printf '#!/bin/sh\\n%s\\n' \"$1\" > \"$2\" && chmod 755 \"$2\"",
                "sh",
                sh,
                &path,
            ])
            .status()
            .unwrap();
        assert!(written.success());
        path
    }

    /// A stand-in that records its argv, folder, stdin and `OTEL_SDK_DISABLED` into `$REC`, then prints `$REC/out`,
    /// writes `$REC/err` to stderr and exits with the number in `$REC/code`.
    fn recorder(dir: &Path) -> String {
        stand_in(
            dir,
            "printf '%s\\n' \"$@\" > \"$REC/argv\"; pwd > \"$REC/cwd\"; cat > \"$REC/stdin\"; printf '%s' \"$OTEL_SDK_DISABLED\" > \"$REC/otel\"; cat \"$REC/out\"; cat \"$REC/err\" >&2; exit \"$(cat \"$REC/code\")\"",
            "echo %*> \"%REC%\\argv\"\ncd > \"%REC%\\cwd\"\nfindstr \"^\" > \"%REC%\\stdin\"\necho %OTEL_SDK_DISABLED%> \"%REC%\\otel\"\ntype \"%REC%\\out\"\ntype \"%REC%\\err\" 1>&2\nexit /b %CODE%",
        )
    }

    fn launch(bin: &str, rec: &Path, code: i32) -> OmpLaunch {
        let mut env: BTreeMap<String, String> = std::env::vars().collect();
        env.insert("REC".to_owned(), rec.to_string_lossy().into_owned());
        env.insert("CODE".to_owned(), code.to_string());
        // Some other value: the run says what it wants.
        env.insert("OTEL_SDK_DISABLED".to_owned(), "false".to_owned());
        OmpLaunch {
            bin: bin.to_owned(),
            env,
        }
    }

    fn put(rec: &Path, name: &str, text: &str) {
        std::fs::write(rec.join(name), text).unwrap();
    }

    fn assistant(text: &str) -> String {
        json!({
            "type": "message_end",
            "message": {
                "role": "assistant", "model": "claude-sonnet-5-5",
                "content": [{ "type": "text", "text": text }],
                "usage": { "output": 1, "cost": { "total": 0.01 } },
            },
        })
        .to_string()
    }

    fn read(rec: &Path, name: &str) -> String {
        std::fs::read_to_string(rec.join(name)).unwrap()
    }

    /// The two `runSmol` cases of `distill-model.test.ts`: the smol role with no tools, no session, no extensions, in
    /// an empty folder of its own, the digest on stdin; and omp's own last line when it fails or answers nothing.
    #[tokio::test]
    async fn asks_the_smol_role_with_no_tools_in_a_folder_of_its_own_with_the_digest_on_stdin() {
        let root = temp("ask");
        let rec = root.join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        let bin = recorder(&root);
        put(&rec, "out", &assistant("ok"));
        put(&rec, "err", "");
        put(&rec, "code", "0");
        // Not there yet: `runSmol` makes it, as `mkdir -p`.
        let cwd = root.join("upkeep").join("nested");
        let result = run_smol(
            &launch(&bin, &rec, 0),
            &Message {
                system: "SYSTEM".into(),
                user: "USER digest\nsecond line".into(),
            },
            &cwd,
        )
        .await
        .unwrap();
        assert_eq!(result.text, "ok");
        assert_eq!(result.model, "claude-sonnet-5-5");
        assert_eq!(result.output_tokens, 1.0);
        assert_eq!(result.cost_usd, 0.01);
        assert!(cwd.is_dir());
        let argv = read(&rec, "argv");
        for flag in [
            "-p",
            "--mode",
            "json",
            "--no-tools",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-rules",
            "--no-title",
            "--model",
            "pi/smol",
            "--thinking",
            "off",
            "--system-prompt",
            "SYSTEM",
        ] {
            assert!(argv.contains(flag), "{flag} in {argv}");
        }
        // The system prompt follows its flag, last.
        assert!(argv.find("--system-prompt").unwrap() < argv.find("SYSTEM").unwrap());
        assert!(read(&rec, "stdin").starts_with("USER digest"));
        assert!(read(&rec, "stdin").contains("second line"));
        assert_eq!(read(&rec, "otel").trim(), "true");
        // omp ran in the folder (compared by its last component: a temp folder may be reached through a link).
        assert!(read(&rec, "cwd").trim().ends_with("nested"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn fails_with_omp_s_own_last_line_when_it_fails_or_answers_nothing() {
        let root = temp("fail");
        let rec = root.join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        let bin = recorder(&root);
        let message = Message {
            system: "s".into(),
            user: "u".into(),
        };
        put(&rec, "out", "");
        put(&rec, "err", "warn\nNo API key for anthropic\n");
        put(&rec, "code", "1");
        let fault = run_smol(&launch(&bin, &rec, 1), &message, &root.join("cwd"))
            .await
            .unwrap_err();
        assert_eq!(fault.message, "omp exited 1: No API key for anthropic");
        put(&rec, "err", "");
        put(&rec, "code", "0");
        let fault = run_smol(&launch(&bin, &rec, 0), &message, &root.join("cwd"))
            .await
            .unwrap_err();
        assert_eq!(fault.message, "omp exited 0");
        // A reply with a failing exit code fails, with no detail when stderr said nothing.
        put(&rec, "out", &assistant("fine"));
        put(&rec, "code", "3");
        let fault = run_smol(&launch(&bin, &rec, 3), &message, &root.join("cwd"))
            .await
            .unwrap_err();
        assert_eq!(fault.message, "omp exited 3");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_missing_omp_fails_as_a_spawn_does_and_a_slow_one_times_out() {
        let root = temp("slow");
        let message = Message {
            system: "s".into(),
            user: "u".into(),
        };
        let missing = OmpLaunch {
            bin: root.join("no omp here").to_string_lossy().into_owned(),
            env: BTreeMap::new(),
        };
        let fault = run_smol(&missing, &message, &root.join("cwd"))
            .await
            .unwrap_err();
        assert_eq!(fault.code, "spawn_failed");
        assert!(fault.message.starts_with("spawn "), "{}", fault.message);
        assert!(fault.message.ends_with(" ENOENT"), "{}", fault.message);
        let bin = stand_in(&root, "sleep 30", "ping -n 30 127.0.0.1 > nul");
        let slow = OmpLaunch {
            bin,
            env: std::env::vars().collect(),
        };
        let started = std::time::Instant::now();
        let fault = run_smol_within(
            &slow,
            &message,
            &root.join("cwd"),
            Duration::from_millis(400),
        )
        .await
        .unwrap_err();
        assert_eq!(fault.message, "omp -p timed out after 400ms");
        assert_eq!(fault.code, "omp_timeout");
        assert!(started.elapsed() < Duration::from_secs(20));
        // The service's own bound: 180 s, spelled as the TypeScript's message was.
        assert_eq!(TIMEOUT.as_millis(), 180_000);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A test method that calls the model the request chose.
    async fn calling(call: Call) -> Result<Reply, Fault> {
        #[derive(Deserialize)]
        struct Params {
            asks: Vec<String>,
            cwd: PathBuf,
        }
        let params: Params = call.params()?;
        let asker = Asker::new("model-1", call.events.clone());
        let model = Model::choose(&asker, &params.asks, params.cwd);
        let message = Message {
            system: "S".into(),
            user: "U".into(),
        };
        Reply::json(&model.call(&message).await?)
    }

    #[tokio::test]
    async fn the_model_is_main_s_in_a_test_and_omp_asked_of_main_otherwise() {
        let mut rig = Rig::start(|registry| {
            registry.add("test.model", |call| Box::pin(calling(call)));
            register(registry);
        })
        .await;
        let result = json!({
            "text": "t", "model": "m", "inputTokens": 3.0, "outputTokens": 2.0, "costUsd": 0.5,
        });
        let run = rig
            .run(
                "test.model",
                json!({ "asks": ["model"], "cwd": "x" }),
                |ask| {
                    assert_eq!(ask["kind"], "model");
                    assert_eq!(
                        ask["params"],
                        json!({ "message": { "system": "S", "user": "U" } })
                    );
                    Said::Value(result.clone())
                },
            )
            .await;
        assert_eq!(run.response["result"], result);
        let run = rig
            .run("test.model", json!({ "asks": [], "cwd": "x" }), |ask| {
                assert_eq!(ask["kind"], "omp");
                assert_eq!(ask["params"], json!({}));
                Said::Error("omp not found.")
            })
            .await;
        assert_eq!(run.response["error"]["message"], "omp not found.");
        // omp asked of main, then run: the stand-in prints a result.
        let root = temp("model");
        let rec = root.join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        let bin = recorder(&root);
        put(&rec, "out", &assistant("from omp"));
        put(&rec, "err", "");
        put(&rec, "code", "0");
        let started = launch(&bin, &rec, 0);
        let run = rig
            .run(
                "test.model",
                json!({ "asks": [], "cwd": root.join("work") }),
                |_| Said::Value(json!({ "bin": started.bin, "env": started.env })),
            )
            .await;
        assert_eq!(
            run.response["result"]["text"], "from omp",
            "{}",
            run.response
        );
        // The thin client's request: `upkeep.runSmol`.
        let run = rig
            .run(
                "upkeep.runSmol",
                json!({
                    "launch": { "bin": started.bin, "env": started.env },
                    "message": { "system": "S", "user": "U" },
                    "cwd": root.join("work2"),
                }),
                |_| Said::Nothing,
            )
            .await;
        assert_eq!(
            run.response["result"]["text"], "from omp",
            "{}",
            run.response
        );
        assert_eq!(run.response["result"]["costUsd"], 0.01);
        let _ = std::fs::remove_dir_all(&root);
    }
}
