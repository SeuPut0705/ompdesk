//! omp provider: the operator's own `omp` agent CLI on one of its model roles.
//!
//! A host that already runs omp (OMPdesk) has signed in to its providers there;
//! this provider lets ai-memory use that sign-in instead of an API key of its
//! own. Each call is a one-shot `omp -p --mode json` on a role (`pi/smol`, the
//! cheap model, by default; never a model id, so it follows the operator's
//! role setting) with every tool, extension, skill, rule and session off: the
//! prompt is captured session text, so nothing in it may run anything, and
//! ai-memory's own omp extension must not record the call. It runs in an empty
//! private folder (omp reads a folder's context files into every request) with
//! an allowlisted environment, like the Cursor provider.
//!
//! omp has no JSON-schema mode in print mode: the schema travels in the prompt,
//! the answer is parsed leniently, and the caller's serde deserialisation is
//! the only validation.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use serde::Serialize;
use tokio::process::Command;

use crate::cli::{self, TempWorkspace};
use crate::error::{LlmError, LlmResult};
use crate::provider::LlmProvider;
use crate::types::{ChatRequest, ChatResponse, Usage};

/// The model role used when none is given: omp's cheap model.
pub const OMP_DEFAULT_MODEL: &str = "pi/smol";

const WHO: &str = "omp";

/// Prefixes the child keeps beyond the shared allowlist: locale categories and
/// omp's own settings (`PI_CODING_AGENT_DIR` among them).
const OMP_CHILD_ENV_PREFIXES: &[&str] = &["LC_", "PI_"];

/// Used when the request has no system prompt: omp's own agent prompt would
/// otherwise ride along with every call.
const PLAIN_SYSTEM_PROMPT: &str = "Answer the request. Reply with only the requested answer.";

/// What the calls through one provider cost so far, as omp reported it.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq)]
pub struct OmpUsage {
    /// Completed calls (failed ones included).
    pub calls: u64,
    /// Prompt tokens, cache reads and writes included.
    pub input_tokens: u64,
    /// Generated tokens.
    pub output_tokens: u64,
    /// What the provider billed, in US dollars (omp's own accounting).
    pub cost_usd: f64,
}

/// Chat provider that shells out to `omp -p`.
pub struct OmpProvider {
    executable: PathBuf,
    model: String,
    temp_root: PathBuf,
    child_env: Vec<(OsString, OsString)>,
    timeout: Duration,
    usage: Mutex<OmpUsage>,
}

impl OmpProvider {
    /// Construct the provider.
    ///
    /// `process_env` is filtered to the allowlist; the executable's own folder
    /// is put first on the child's `PATH`, because omp is a Bun script whose
    /// `bun` normally sits beside it and a service manager's `PATH` (launchd)
    /// does not hold that folder. The executable is not probed here: a missing
    /// one fails on the first completion with a path-specific error.
    #[must_use]
    pub fn new(
        executable: PathBuf,
        model: impl Into<String>,
        temp_root: PathBuf,
        process_env: &[(OsString, OsString)],
    ) -> Self {
        let mut child_env = cli::allowlisted_env(process_env, OMP_CHILD_ENV_PREFIXES);
        if let Some(dir) = executable.parent().filter(|dir| dir.is_absolute()) {
            let inherited = child_env
                .iter()
                .position(|(name, _)| name.eq_ignore_ascii_case("PATH"))
                .map(|index| child_env.remove(index));
            let mut paths = vec![dir.to_path_buf()];
            if let Some((_, value)) = &inherited {
                paths.extend(std::env::split_paths(value));
            }
            if let Ok(joined) = std::env::join_paths(paths) {
                let name = inherited.map_or_else(|| OsString::from("PATH"), |(name, _)| name);
                child_env.push((name, joined));
            }
        }
        // omp's telemetry export stays off for an internal call, whatever
        // `OTEL_*` the environment names (none pass the allowlist anyway).
        child_env.push(("OTEL_SDK_DISABLED".into(), "true".into()));
        Self {
            executable,
            model: model.into(),
            temp_root,
            child_env,
            timeout: Duration::from_secs(crate::DEFAULT_REQUEST_TIMEOUT_SECS),
            usage: Mutex::new(OmpUsage::default()),
        }
    }

    /// Override the CLI wait ceiling.
    #[must_use]
    pub fn with_timeout_secs(mut self, secs: u64) -> Self {
        self.timeout = Duration::from_secs(secs);
        self
    }

    /// The executable this provider spawns.
    #[must_use]
    pub fn executable(&self) -> &Path {
        &self.executable
    }

    /// Calls, tokens and cost so far.
    #[must_use]
    pub fn usage(&self) -> OmpUsage {
        *self
            .usage
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    async fn complete_text(
        &self,
        request: &ChatRequest,
        schema: Option<&serde_json::Value>,
    ) -> LlmResult<Answer> {
        let workspace = TempWorkspace::create(&self.temp_root, "omp")?;
        let mut command = Command::new(&self.executable);
        command
            .env_clear()
            .envs(self.child_env.iter().map(|(name, value)| (name, value)))
            .args([
                "-p",
                "--mode",
                "json",
                "--no-tools",
                "--no-session",
                "--no-extensions",
                "--no-skills",
                "--no-rules",
                "--no-title",
                "--thinking",
                "off",
                "--model",
            ])
            .arg(&self.model)
            .arg("--system-prompt")
            .arg(request.system.as_deref().unwrap_or(PLAIN_SYSTEM_PROMPT))
            .current_dir(&workspace.path);
        let input = cli::render_messages(request, schema).into_bytes();
        let output = cli::run(&mut command, Some(input), self.timeout, WHO).await;
        let answer = output.and_then(|output| {
            if !output.status.success() {
                return Err(cli::exit_error(&output));
            }
            parse_events(&String::from_utf8_lossy(&output.stdout))
        });
        let mut usage = self
            .usage
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        usage.calls += 1;
        if let Ok(answer) = &answer {
            usage.input_tokens += answer.input_tokens;
            usage.output_tokens += answer.output_tokens;
            usage.cost_usd += answer.cost_usd;
        }
        answer
    }
}

/// The last assistant message of one `omp --mode json` run.
#[derive(Debug, PartialEq)]
struct Answer {
    text: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cost_usd: f64,
}

/// The final assistant `message_end` event among omp's JSON event lines.
fn parse_events(stdout: &str) -> LlmResult<Answer> {
    let mut last: Option<serde_json::Value> = None;
    for line in stdout.lines() {
        if !line.starts_with('{') {
            continue;
        }
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if event["type"] == "message_end" && event["message"]["role"] == "assistant" {
            last = Some(event["message"].clone());
        }
    }
    let message =
        last.ok_or_else(|| LlmError::UnexpectedShape("omp printed no assistant message".into()))?;
    if message["stopReason"] == "error" || message["stopReason"] == "aborted" {
        let detail = message["errorMessage"].as_str().unwrap_or("no detail");
        return Err(LlmError::Provider {
            status: 502,
            body: format!(
                "omp's model call failed: {}",
                cli::truncate_chars(detail, 500)
            ),
        });
    }
    let text: String = message["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|part| part["type"] == "text")
        .filter_map(|part| part["text"].as_str())
        .collect();
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(LlmError::UnexpectedShape(
            "omp returned an empty answer".into(),
        ));
    }
    let usage = &message["usage"];
    let tokens = |key: &str| usage[key].as_u64().unwrap_or(0);
    Ok(Answer {
        text,
        model: message["model"].as_str().unwrap_or_default().to_string(),
        input_tokens: tokens("input") + tokens("cacheRead") + tokens("cacheWrite"),
        output_tokens: tokens("output"),
        cost_usd: usage["cost"]["total"].as_f64().unwrap_or(0.0),
    })
}

#[async_trait]
impl LlmProvider for OmpProvider {
    fn name(&self) -> &'static str {
        "omp"
    }

    fn model(&self) -> &str {
        &self.model
    }

    async fn complete(&self, request: ChatRequest) -> LlmResult<ChatResponse> {
        let answer = self.complete_text(&request, None).await?;
        Ok(ChatResponse {
            text: answer.text,
            usage: Some(Usage {
                input_tokens: u32::try_from(answer.input_tokens).unwrap_or(u32::MAX),
                output_tokens: u32::try_from(answer.output_tokens).unwrap_or(u32::MAX),
            }),
            model: if answer.model.is_empty() {
                self.model.clone()
            } else {
                answer.model
            },
        })
    }

    async fn complete_structured_raw(
        &self,
        request: ChatRequest,
        schema: serde_json::Value,
    ) -> LlmResult<serde_json::Value> {
        let answer = self.complete_text(&request, Some(&schema)).await?;
        cli::parse_json_answer(&answer.text, WHO)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const END: &str = r#"{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\"a\":1}"}],"model":"claude-haiku-5-5","usage":{"input":319,"output":8,"cacheRead":10,"cacheWrite":2,"cost":{"total":0.0000359}},"stopReason":"stop"}}"#;

    #[test]
    fn the_last_assistant_message_is_the_answer() {
        let user = r#"{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"question"}]}}"#;
        let stdout = format!("{{\"type\":\"session\"}}\n{user}\nnot json\n{END}\n");
        let answer = parse_events(&stdout).unwrap();
        assert_eq!(answer.text, r#"{"a":1}"#);
        assert_eq!(answer.model, "claude-haiku-5-5");
        assert_eq!(answer.input_tokens, 331);
        assert_eq!(answer.output_tokens, 8);
        assert!((answer.cost_usd - 0.000_035_9).abs() < 1e-12);
    }

    #[test]
    fn a_failed_model_call_is_an_error_not_an_empty_answer() {
        let stdout = r#"{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"429 rate limited"}}"#;
        let err = parse_events(stdout).unwrap_err();
        assert!(err.to_string().contains("429 rate limited"), "{err}");
        assert!(parse_events("{\"type\":\"agent_end\"}").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn the_executables_folder_leads_the_childs_path() {
        let provider = OmpProvider::new(
            PathBuf::from("/opt/bun/bin/omp"),
            OMP_DEFAULT_MODEL,
            PathBuf::from("/tmp"),
            &[
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("AI_MEMORY_AUTH_TOKEN".into(), "secret".into()),
                ("PI_CODING_AGENT_DIR".into(), "/agent".into()),
            ],
        );
        let env: std::collections::HashMap<_, _> = provider.child_env.iter().cloned().collect();
        assert_eq!(
            env.get(&OsString::from("PATH")),
            Some(&OsString::from("/opt/bun/bin:/usr/bin:/bin"))
        );
        assert_eq!(
            env.get(&OsString::from("PI_CODING_AGENT_DIR")),
            Some(&OsString::from("/agent"))
        );
        assert!(!env.contains_key(&OsString::from("AI_MEMORY_AUTH_TOKEN")));
    }
}
