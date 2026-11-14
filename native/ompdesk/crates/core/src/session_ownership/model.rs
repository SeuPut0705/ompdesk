use std::path::{Component, Path, PathBuf};

use ompdesk_app_contract::Owner;
use serde::{Deserialize, Serialize};

use crate::server::Fault;

pub const SESSION_TAG_ENV: &str = "OMP_GUI_SESSION_TAG";
pub const STOCK_WORKER_ARG: &str = "__omp_worker_";
pub const RETRY_REMAINING_MS: u64 = 60_000;
pub const ARTIFACT_IDLE_MS: f64 = 3.0 * 24.0 * 60.0 * 60_000.0;

/// Locations supplied by the native application, never by a page request.
#[derive(Clone, Debug)]
pub struct Config {
    pub process_file: PathBuf,
    pub scratch_file: PathBuf,
    pub scratch_root: PathBuf,
}

impl Config {
    pub fn new(user_data: &Path, scratch_root: PathBuf) -> Self {
        Self {
            process_file: user_data.join("session-processes.json"),
            scratch_file: user_data.join("session-scratch.json"),
            scratch_root,
        }
    }
}

/// Authoritative launch facts resolved by Base from the opaque owner.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub cwd: String,
    #[serde(default, deserialize_with = "present_string", skip_serializing_if = "Option::is_none")]
    pub session_path: Option<String>,
    #[serde(default, deserialize_with = "present_string", skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
}

fn present_string<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRecord {
    pub tag: String,
    #[serde(flatten)]
    pub facts: Facts,
    pub since: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScratchRecord {
    pub tag: String,
    pub since: f64,
    pub sessions: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Phase {
    Left,
    Live(Owner),
    /// A released tab's omp must finish its own cleanup before its tag is ended.
    Closing(Owner),
    Ending,
}

pub(super) struct Entry {
    pub record: TagRecord,
    pub phase: Phase,
    pub pid: Option<u32>,
    pub retried: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lease {
    pub tag: String,
    pub scratch: Option<PathBuf>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagOwner {
    pub tag: String,
    #[serde(flatten)]
    pub facts: Facts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

#[derive(Debug, Default, Serialize)]
pub struct ScratchSweep {
    pub removed: Vec<u64>,
    pub kept: u64,
    pub failed: u64,
}

pub(super) fn valid_tag(tag: &str) -> bool {
    tag.len() == 32 && tag.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

pub(super) fn fresh_tag() -> Result<String, Fault> {
    let mut bytes = [0; 16];
    crate::sys::random(&mut bytes).map_err(|error| Fault::new("random_failed", error.to_string()))?;
    Ok(crate::hex(&bytes))
}

/// node path.normalize semantics relevant to saved session keys, without resolving a relative path against cwd.
pub(super) fn session_key(path: &str) -> String {
    let mut normalized = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if normalized.file_name().is_some_and(|name| name != "..") {
                    normalized.pop();
                } else if !normalized.has_root() {
                    normalized.push("..");
                }
            }
            other => normalized.push(other),
        }
    }
    let key = normalized.to_string_lossy();
    if cfg!(windows) { key.to_lowercase() } else { key.into_owned() }
}

pub(super) fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0)
}
