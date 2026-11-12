//! What a tool call can fail with, as the TypeScript service threw it: `ToolError` (the agent's own message),
//! `SessionDeleted` (a `ToolError` that names a fate), `SessionFolderMissing` and any other `Error` (shown as
//! `<tool> failed: <message>`). `outcome_of` turns one into the tool's result.

use serde::{Deserialize, Serialize};

use super::types::ToolOutcome;
use crate::agentctl::journal::session_fates::{SessionFate, fate_when};
use crate::ports::PortError;

/// `IpcSavedFolder`: a worktree disk care saved before it removed it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFolder {
    pub id: String,
    #[serde(default)]
    pub branch: Option<String>,
    pub removed_at: f64,
}

#[derive(Clone, Debug)]
pub enum Fail {
    /// `ToolError`: the message is the agent's own, shown as it is.
    Tool(String),
    /// `SessionDeleted`: what an id names after the session was deleted. A `ToolError` too.
    Deleted {
        message: String,
        fate: Box<SessionFate>,
    },
    /// `SessionFolderMissing`: a stored session's folder is gone (`saved` = disk care kept it).
    FolderMissing {
        folder: String,
        saved: Option<SavedFolder>,
    },
    /// Any other `Error`; `code` is what main's handler threw (`ipcErrorCode`, or `timeout`).
    Other {
        message: String,
        code: Option<String>,
    },
}

/// A tool step's result.
pub type R<T> = Result<T, Fail>;

/// `fail(message)`: refuses with a message the agent reads as it is.
pub fn fail<T>(message: impl Into<String>) -> R<T> {
    Err(Fail::Tool(message.into()))
}

impl Fail {
    pub fn other(message: impl Into<String>) -> Fail {
        Fail::Other {
            message: message.into(),
            code: None,
        }
    }

    /// What a family fn answers while its TypeScript body is not yet ported.
    pub fn not_ported(what: &str) -> Fail {
        Fail::Other {
            message: format!("{what} is not ported to the core yet"),
            code: Some("not_ported".into()),
        }
    }

    /// `error.message`.
    pub fn message(&self) -> String {
        match self {
            Fail::Tool(message) | Fail::Deleted { message, .. } | Fail::Other { message, .. } => {
                message.clone()
            }
            Fail::FolderMissing { folder, .. } => format!(
                "The folder this saved session belongs in no longer exists ({folder}); it is not opened in any other folder."
            ),
        }
    }

    /// `error instanceof ToolError`.
    pub fn is_tool(&self) -> bool {
        matches!(self, Fail::Tool(_) | Fail::Deleted { .. })
    }

    /// Whether the failure carries IPC error code `code`: main's coded field, or the `[code] ` marker in the message
    /// (`ipcErrorCode`).
    pub fn has_code(&self, code: &str) -> bool {
        let Fail::Other {
            message,
            code: held,
        } = self
        else {
            return false;
        };
        held.as_deref() == Some(code) || message.contains(&format!("[{code}] "))
    }

    /// A command that never answered (`unanswered`): its outcome is unknown, the command may still run.
    pub fn unanswered(&self) -> bool {
        match self {
            Fail::Other { message, code } => {
                code.as_deref() == Some("timeout") || message.starts_with("RPC timeout (")
            }
            _ => false,
        }
    }
}

impl From<PortError> for Fail {
    fn from(error: PortError) -> Fail {
        Fail::Other {
            message: error.message,
            code: error.code,
        }
    }
}

/// `unanswered(response.error)`: a refusal's text that says the command timed out.
pub fn unanswered_text(error: Option<&str>) -> bool {
    error.is_some_and(|text| text.starts_with("RPC timeout ("))
}

/// The message of `SessionDeleted`: what the agent reads instead of "No session".
pub fn session_deleted(name: &str, fate: SessionFate) -> Fail {
    use crate::agentctl::journal::session_fates::fate_by;
    let title = if fate.session.title.is_empty() {
        String::new()
    } else {
        format!(" (\"{}\")", super::js::one_line(&fate.session.title, 80))
    };
    let throwaway = if fate.by == fate_by::THROWAWAY {
        " Its final answer reached the session that opened it as its done report."
    } else {
        ""
    };
    let message = format!(
        "Session \"{name}\"{title} was deleted{}: its saved conversation is gone, so there is nothing to read, message, stop or reopen.{throwaway} Do not look for it again; ompdesk_sessions lists the sessions that exist.",
        fate_when(fate.at, &fate.by)
    );
    Fail::Deleted {
        message,
        fate: Box::new(fate),
    }
}

/// A thrown error as a tool result: a `ToolError` is the agent's own message, anything else names the tool.
pub fn outcome_of(tool: &str, error: &Fail) -> ToolOutcome {
    if error.is_tool() {
        return ToolOutcome {
            text: error.message(),
            is_error: true,
        };
    }
    ToolOutcome {
        text: format!("{tool} failed: {}", error.message()),
        is_error: true,
    }
}
