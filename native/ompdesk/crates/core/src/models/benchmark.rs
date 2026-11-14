//! `omp bench` invocation and its bounded result, formerly `src/main/benchmark-runner.ts`. Stock still owns every
//! benchmark. The native app only builds its CLI arguments, supervises one child per caller and checks its JSON.

use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::{Notify, oneshot};

use super::locked;
use crate::control::js::number;
use crate::fs::error::uv_code;
use crate::fs::order::js_trim;
use crate::machine::Runtime;
use crate::run::{KILL_GRACE, Runner, terminate};
use crate::server::Fault;

pub const TIMEOUT_MS: u64 = 15 * 60_000;
const MAX_OUTPUT: usize = 8 * 1024 * 1024;

fn integer(input: &Value, name: &str, min: f64, max: f64) -> Result<String, Fault> {
    input
        .get(name)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= min && *n <= max)
        .map(number)
        .ok_or_else(|| {
            Fault::new(
                "benchmark_invalid_option",
                format!(
                    "[benchmark_invalid_option] {name} must be between {} and {}",
                    number(min),
                    number(max)
                ),
            )
        })
}

pub fn args(input: &Value) -> Result<Vec<String>, Fault> {
    let models = input
        .get("models")
        .and_then(Value::as_array)
        .filter(|m| (1..=8).contains(&m.len()))
        .ok_or_else(|| {
            Fault::new(
                "benchmark_model_count",
                "[benchmark_model_count] Select between 1 and 8 models",
            )
        })?;
    let profile = input
        .get("profile")
        .and_then(Value::as_str)
        .filter(|p| matches!(*p, "mix" | "chat" | "prefill" | "generation"))
        .ok_or_else(|| {
            Fault::new(
                "benchmark_invalid_option",
                "[benchmark_invalid_option] Invalid benchmark profile",
            )
        })?;
    let mut args = vec!["bench".to_owned()];
    for model in models {
        let model = model
            .as_str()
            .map(js_trim)
            .filter(|m| !m.is_empty() && m.encode_utf16().count() <= 200 && !m.starts_with('-'))
            .ok_or_else(|| {
                Fault::new(
                    "benchmark_invalid_model",
                    "[benchmark_invalid_model] Invalid model selector",
                )
            })?;
        if !args[1..].iter().any(|existing| existing == model) {
            args.push(model.to_owned());
        }
    }
    args.extend([
        "--profile".into(),
        profile.into(),
        "--runs".into(),
        integer(input, "runs", 1.0, 20.0)?,
        "--par".into(),
        integer(input, "parallel", 1.0, 8.0)?,
        "--json".into(),
    ]);
    if input.get("maxTokens").is_some() {
        args.extend([
            "--max-tokens".into(),
            integer(input, "maxTokens", 1.0, 8192.0)?,
        ]);
    }
    Ok(args)
}

fn malformed() -> Fault {
    Fault::new("benchmark_summary", "Benchmark returned malformed JSON")
}
fn fields(value: &Value, names: &[&str]) -> Result<Map<String, Value>, Fault> {
    let mut out = Map::new();
    for name in names {
        let value = value
            .get(*name)
            .filter(|v| v.as_f64().is_some_and(f64::is_finite))
            .ok_or_else(malformed)?;
        out.insert((*name).to_owned(), value.clone());
    }
    Ok(out)
}
fn stats(value: &Value) -> Result<Value, Fault> {
    let mut out = fields(value, &["inputTokens", "outputTokens", "cost"])?;
    for metric in [
        "ttftMs",
        "durationMs",
        "tokensPerSecond",
        "generationTps",
        "prefillTps",
    ] {
        out.insert(
            metric.into(),
            Value::Object(fields(
                &value[metric],
                &["mean", "min", "p50", "p95", "max"],
            )?),
        );
    }
    Ok(Value::Object(out))
}

pub fn parse_summary(stdout: &str) -> Result<Value, Fault> {
    let raw: Value = serde_json::from_str(stdout)
        .map_err(|error| Fault::new("benchmark_json", error.to_string()))?;
    let runs = raw
        .get("runs")
        .filter(|v| {
            v.as_f64()
                .is_some_and(|v| v.is_finite() && v.fract() == 0.0 && v > 0.0)
        })
        .ok_or_else(malformed)?;
    let failures = raw
        .get("failures")
        .filter(|v| {
            v.as_f64()
                .is_some_and(|v| v.is_finite() && v.fract() == 0.0 && v >= 0.0)
        })
        .ok_or_else(malformed)?;
    let mut result = json!({"runs":runs,"failures":failures});
    if let Some(profile) = raw.get("profile") {
        if !profile
            .as_str()
            .is_some_and(|p| matches!(p, "mix" | "chat" | "prefill" | "generation"))
        {
            return Err(malformed());
        }
        result["profile"] = profile.clone();
    }
    let models = raw
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(malformed)?;
    let models: Result<Vec<_>,Fault> = models.iter().map(|model| {
        let selector = model.get("selector").and_then(Value::as_str).ok_or_else(malformed)?;
        let name = model.get("model").and_then(Value::as_str).ok_or_else(malformed)?;
        let parsed_stats = match model.get("stats") { Some(Value::Null) => Value::Null, Some(value) => stats(value)?, None => return Err(malformed()) };
        let mut challenges = Map::new();
        if let Some(value) = model.get("byChallenge") {
            for (name,value) in value.as_object().ok_or_else(malformed)? { challenges.insert(name.clone(),stats(value)?); }
        }
        let results = model.get("results").and_then(Value::as_array).ok_or_else(malformed)?;
        let results: Result<Vec<_>,Fault> = results.iter().map(|entry| {
            let ok = entry.get("ok").and_then(Value::as_bool).ok_or_else(malformed)?;
            let mut result = json!({"ok":ok});
            if let Some(error) = entry.get("error") { result["error"] = Value::String(error.as_str().ok_or_else(malformed)?.to_owned()); }
            Ok(result)
        }).collect();
        Ok(json!({"selector":selector,"model":name,"stats":parsed_stats,"byChallenge":challenges,"results":results?}))
    }).collect();
    result["models"] = Value::Array(models?);
    Ok(result)
}

#[derive(Default)]
struct Control {
    stop: Notify,
    reason: Mutex<Option<&'static str>>,
}
impl Control {
    fn stop(&self, reason: &'static str) {
        *locked(&self.reason) = Some(reason);
        self.stop.notify_one();
    }
}

#[derive(Clone, Default)]
pub struct BenchmarkRunner {
    live: Arc<Mutex<State>>,
}

#[derive(Default)]
struct State {
    closed: bool,
    current: Option<Arc<Control>>,
}

impl BenchmarkRunner {
    pub fn running(&self) -> bool {
        locked(&self.live).current.is_some()
    }
    pub fn abort(&self) -> bool {
        let live = locked(&self.live);
        let Some(control) = live.current.as_ref() else {
            return false;
        };
        control.stop("Benchmark cancelled");
        true
    }

    /// Owner teardown is irreversible; ordinary Stop remains reusable through `abort`.
    pub fn close(&self) {
        let mut live = locked(&self.live);
        live.closed = true;
        if let Some(control) = live.current.as_ref() {
            control.stop("Benchmark cancelled");
        }
    }

    pub async fn run(&self, runtime: Runtime, cwd: &str, options: &Value) -> Value {
        self.run_with_budget(runtime, cwd, options, Duration::from_millis(TIMEOUT_MS))
            .await
    }

    async fn run_with_budget(
        &self,
        mut runtime: Runtime,
        cwd: &str,
        options: &Value,
        budget: Duration,
    ) -> Value {
        let (control, mut child) = {
            let mut live = locked(&self.live);
            if live.closed {
                return json!({"success":false,"error":"Benchmark cancelled","code":"cancelled"});
            }
            if live.current.is_some() {
                return json!({"success":false,"error":"A benchmark is already running","code":"benchmark_running"});
            }
            let args = match args(options) {
                Ok(args) => args,
                Err(error) => {
                    return json!({"success":false,"error":error.message,"code":error.code});
                }
            };
            let control = Arc::new(Control::default());
            live.current = Some(Arc::clone(&control));
            runtime
                .env
                .insert("OTEL_SDK_DISABLED".into(), "true".into());
            let runner = Runner {
                bin: runtime.bin.to_string_lossy().into_owned(),
                args,
                env: runtime.env,
                timeout_ms: TIMEOUT_MS,
                max_bytes: MAX_OUTPUT,
            };
            let mut command = Command::new(&runner.bin);
            command
                .args(&runner.args)
                .current_dir(cwd)
                .env_clear()
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            runner.environment(&mut command, &[]);
            #[cfg(windows)]
            command.creation_flags(0x0800_0000);
            // Spawn and irreversible close share the admission lock.
            let child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    live.current.take();
                    return json!({"success":false,"error":format!("spawn {} {}",runner.bin,uv_code(&error))});
                }
            };
            (control, child)
        };
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            let _ = child.start_kill();
            let _ = child.wait().await;
            locked(&self.live).current.take();
            return json!({"success":false,"error":"The benchmark process's pipes were not open"});
        };
        let live = Arc::clone(&self.live);
        let child_control = Arc::clone(&control);
        let (send, receive) = oneshot::channel();
        tokio::spawn(async move {
            let bytes = AtomicUsize::new(0);
            let supervise = async {
                let status = tokio::select! {
                    status = child.wait() => Some(status),
                    () = child_control.stop.notified() => None,
                    () = tokio::time::sleep(budget) => { child_control.stop("Benchmark timed out after 15 minutes"); None },
                };
                let status = match status {
                    Some(status) => status,
                    None => {
                        terminate(&mut child);
                        match tokio::time::timeout(KILL_GRACE, child.wait()).await {
                            Ok(status) => status,
                            Err(_) => {
                                let _ = child.start_kill();
                                child.wait().await
                            }
                        }
                    }
                };
                status.ok().and_then(|status| status.code())
            };
            let (stdout, stderr, code) = tokio::join!(
                read(stdout, &bytes, &child_control),
                read(stderr, &bytes, &child_control),
                supervise
            );
            let stderr = String::from_utf8_lossy(&stderr).into_owned();
            let reason = *locked(&child_control.reason);
            let mut result = if let Some(reason) = reason {
                json!({"success":false,"error":reason})
            } else {
                match parse_summary(&String::from_utf8_lossy(&stdout)) {
                    Ok(summary) => json!({"success":true,"summary":summary,"exitCode":code}),
                    Err(error) => json!({"success":false,"error":error.message}),
                }
            };
            let kept_stderr = if reason.is_some() {
                stderr.as_str()
            } else {
                js_trim(&stderr)
            };
            if !kept_stderr.is_empty() {
                result["stderr"] = Value::String(kept_stderr.to_owned());
            }
            locked(&live).current.take();
            let _ = send.send(result);
        });
        let guard = CancelOnDrop(control);
        let result = receive
            .await
            .unwrap_or_else(|_| json!({"success":false,"error":"The benchmark supervisor exited"}));
        drop(guard);
        result
    }
}

struct CancelOnDrop(Arc<Control>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.stop("Benchmark cancelled");
    }
}

async fn read(mut pipe: impl AsyncRead + Unpin, bytes: &AtomicUsize, control: &Control) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut chunk = vec![0; 64 * 1024];
    while let Ok(read) = pipe.read(&mut chunk).await
        && read > 0
    {
        let total = bytes
            .fetch_add(read, Ordering::Relaxed)
            .saturating_add(read);
        if total > MAX_OUTPUT {
            control.stop("Benchmark output exceeded 8 MiB");
        } else {
            kept.extend_from_slice(&chunk[..read]);
        }
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn builds_argv_and_rejects_malformed_gui_results() {
        assert_eq!(args(&json!({"models":[" p/a ","p/a","other/b"],"profile":"mix","runs":3,"parallel":2,"maxTokens":8192})).unwrap(),["bench","p/a","other/b","--profile","mix","--runs","3","--par","2","--json","--max-tokens","8192"]);
        for options in [
            json!({"models":["--help"],"profile":"chat","runs":1,"parallel":1}),
            json!({"models":["p/a"],"profile":"chat","runs":0,"parallel":1}),
        ] {
            assert!(args(&options).is_err());
        }
        assert_eq!(
            parse_summary("{\"runs\":1,\"models\":[],\"failures\":0}").unwrap(),
            json!({"runs":1,"models":[],"failures":0})
        );
        for text in [
            "null",
            "{\"runs\":1,\"models\":[{\"model\":\"one\",\"results\":null}],\"failures\":0}",
        ] {
            assert_eq!(
                parse_summary(text).unwrap_err().message,
                "Benchmark returned malformed JSON"
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_stock_cli_shape_and_preserves_nonzero_summary_and_stderr() {
        use crate::models::test_rig::Fixture;
        let fixture = Fixture::new("benchmark-json");
        let runtime = fixture.runtime("printf '%s\\n' \"$@\" > argv; printf '{\"runs\":1,\"models\":[],\"failures\":0}'; printf ' warning \\n' >&2; exit 9");
        let runner = BenchmarkRunner::default();
        let result = runner
            .run(
                runtime,
                &fixture.dir.to_string_lossy(),
                &json!({"models":["p/m"],"profile":"chat","runs":1,"parallel":1}),
            )
            .await;
        assert_eq!(
            result,
            json!({"success":true,"summary":{"runs":1,"models":[],"failures":0},"exitCode":9,"stderr":"warning"})
        );
        assert_eq!(
            std::fs::read_to_string(fixture.dir.join("argv")).unwrap(),
            "bench\np/m\n--profile\nchat\n--runs\n1\n--par\n1\n--json\n"
        );
        assert!(!runner.running());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancels_before_the_start_answer_and_limits_combined_output() {
        use crate::models::test_rig::{Fixture, start_then};
        let fixture = Fixture::new("benchmark-cancel");
        let runtime = fixture.runtime("exec sleep 300");
        let runner = BenchmarkRunner::default();
        let options = json!({"models":["p/m"],"profile":"chat","runs":1,"parallel":1});
        let cwd = fixture.dir.to_string_lossy();
        let result = start_then(runner.run(runtime, &cwd, &options), || {
            assert!(runner.abort());
        })
        .await;
        assert_eq!(result["error"], "Benchmark cancelled");
        assert!(!runner.running());
        let runtime = fixture.runtime("exec yes oversized");
        let result = runner.run(runtime, &cwd, &options).await;
        assert_eq!(result["error"], "Benchmark output exceeded 8 MiB");
        assert!(!runner.running());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn owner_close_cancels_and_joins_but_a_fresh_owner_can_run() {
        use crate::models::test_rig::{Fixture, start_then};
        let fixture = Fixture::new("benchmark-owner-close");
        let cwd = fixture.dir.to_string_lossy();
        let options = json!({"models":["p/m"],"profile":"chat","runs":1,"parallel":1});
        let runner = BenchmarkRunner::default();
        let runtime = fixture.runtime("exec sleep 300");
        let result = start_then(runner.run(runtime, &cwd, &options), || runner.close()).await;
        assert_eq!(result["error"], "Benchmark cancelled");
        assert!(!runner.running());
        let runtime = fixture.runtime("printf started > stale-child");
        let result = runner.clone().run(runtime, &cwd, &options).await;
        assert_eq!(result["code"], "cancelled");
        assert!(!fixture.dir.join("stale-child").exists());
        let runtime = fixture.runtime("printf '{\"runs\":1,\"models\":[],\"failures\":0}'");
        assert_eq!(
            BenchmarkRunner::default()
                .run(runtime, &cwd, &options)
                .await["success"],
            true
        );
    }

    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn times_out_and_reaps_the_child() {
        use crate::models::test_rig::Fixture;
        let fixture = Fixture::new("benchmark-timeout");
        let runtime = fixture.runtime("exec sleep 300");
        let runner = BenchmarkRunner::default();
        let result = runner
            .run_with_budget(
                runtime,
                &fixture.dir.to_string_lossy(),
                &json!({"models":["p/m"],"profile":"chat","runs":1,"parallel":1}),
                Duration::from_secs(60),
            )
            .await;
        assert_eq!(result["error"], "Benchmark timed out after 15 minutes");
        assert!(!runner.running());
    }
}
