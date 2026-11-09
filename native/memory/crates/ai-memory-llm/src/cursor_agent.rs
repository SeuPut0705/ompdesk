//! Cursor subscription provider.
//!
//! Consolidation calls the logged-in Cursor Agent CLI (`agent --print`)
//! instead of a platform API key. The CLI already holds the Cursor
//! subscription. Invocations stay in `--mode ask`: captured session text is
//! untrusted, and `--yolo` / `--force` would let that text run tools. For the
//! same reason the child gets an allowlisted environment
//! ([`cursor_child_env`]), never the server's: `AI_MEMORY_AUTH_TOKEN` and
//! other providers' keys stay out of its reach.
//!
//! The CLI has no JSON-schema mode. The schema travels in the prompt, the
//! answer is parsed leniently (code fences and surrounding prose stripped),
//! and the caller's serde deserialisation is the only validation: a value
//! that deserialises is accepted even if it breaks a schema constraint serde
//! does not check.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use tokio::process::Command;

use crate::auth::CursorAuth;
use crate::cli::{self, TempWorkspace};
use crate::error::{LlmError, LlmResult};
use crate::provider::LlmProvider;
use crate::types::{ChatRequest, ChatResponse};

/// Model used when `AI_MEMORY_LLM_MODEL` is unset.
///
/// `agent --list-models` labels this id "Grok 4.6". Override with any other id
/// from that list.
pub const CURSOR_DEFAULT_MODEL: &str = "cursor-grok-4.6-high";

const WHO: &str = "cursor agent";

/// Prefixes the child keeps beyond the shared allowlist: locale categories and
/// the CLI's own settings (`CURSOR_API_KEY` among them).
const CURSOR_CHILD_ENV_PREFIXES: &[&str] = &["LC_", "CURSOR_"];

/// The subset of `process_env` the Cursor Agent CLI child runs with.
///
/// The child reads untrusted captured session text, so everything outside
/// the allowlist — ai-memory's own token, other providers' keys, arbitrary
/// operator secrets — is dropped.
#[must_use]
pub fn cursor_child_env(process_env: &[(OsString, OsString)]) -> Vec<(OsString, OsString)> {
    cli::allowlisted_env(process_env, CURSOR_CHILD_ENV_PREFIXES)
}

/// Chat provider that shells out to the Cursor `agent` CLI.
pub struct CursorAgentProvider {
    model: String,
    auth: CursorAuth,
    timeout: Duration,
}

impl CursorAgentProvider {
    /// Construct the provider.
    ///
    /// The executable is not probed here: a missing `agent` binary fails on
    /// the first completion with a path-specific error.
    #[must_use]
    pub fn new(auth: CursorAuth, model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            auth,
            timeout: Duration::from_secs(crate::DEFAULT_REQUEST_TIMEOUT_SECS),
        }
    }

    /// Override the CLI wait ceiling.
    #[must_use]
    pub fn with_timeout_secs(mut self, secs: u64) -> Self {
        self.timeout = Duration::from_secs(secs);
        self
    }

    async fn complete_text(
        &self,
        request: &ChatRequest,
        schema: Option<&serde_json::Value>,
    ) -> LlmResult<String> {
        let workspace = TempWorkspace::create(&self.auth.temp_root, "cursor")?;
        let mut body = String::new();
        if let Some(system) = &request.system {
            body.push_str("# System\n");
            body.push_str(system);
            body.push_str("\n\n");
        }
        body.push_str(&cli::render_messages(request, schema));
        std::fs::write(workspace.path.join("request.md"), body)
            .map_err(|err| LlmError::UnexpectedShape(format!("writing cursor prompt: {err}")))?;

        let mut command = Command::new(&self.auth.executable);
        command
            .env_clear()
            .envs(
                self.auth
                    .child_env
                    .iter()
                    .map(|(name, value)| (name, value)),
            )
            .arg("--print")
            .arg("--mode")
            .arg("ask")
            .arg("--output-format")
            .arg("text")
            .arg("--trust")
            .arg("--workspace")
            .arg(&workspace.path);
        if self.model != "default" {
            command.arg("--model").arg(&self.model);
        }
        command
            .arg(
                "Read request.md in this workspace and answer it. \
                 Reply with only the requested answer. Do not use tools.",
            )
            .current_dir(&workspace.path);

        let output = cli::run(&mut command, None, self.timeout, WHO)
            .await
            .map_err(|err| match err {
                LlmError::NotConfigured(detail) => LlmError::NotConfigured(format!(
                    "{detail}. Install the Cursor agent or set AI_MEMORY_CURSOR_AGENT"
                )),
                other => other,
            })?;
        if !output.status.success() {
            return Err(cli::exit_error(&output));
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            return Err(LlmError::UnexpectedShape(
                "cursor agent returned an empty answer".into(),
            ));
        }
        Ok(text)
    }
}

#[async_trait]
impl LlmProvider for CursorAgentProvider {
    fn name(&self) -> &'static str {
        "cursor"
    }

    fn model(&self) -> &str {
        &self.model
    }

    async fn complete(&self, request: ChatRequest) -> LlmResult<ChatResponse> {
        let text = self.complete_text(&request, None).await?;
        Ok(ChatResponse {
            text,
            usage: None,
            model: self.model.clone(),
        })
    }

    async fn complete_structured_raw(
        &self,
        request: ChatRequest,
        schema: serde_json::Value,
    ) -> LlmResult<serde_json::Value> {
        let text = self.complete_text(&request, Some(&schema)).await?;
        cli::parse_json_answer(&text, WHO)
    }
}

/// Executable the provider will spawn. `AI_MEMORY_CURSOR_AGENT` wins; otherwise
/// the name `agent` is resolved from `PATH` at spawn time.
#[must_use]
pub fn cursor_executable(override_path: Option<&Path>) -> PathBuf {
    override_path
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("agent"))
}
