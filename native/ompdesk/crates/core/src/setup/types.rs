use std::collections::BTreeMap;
use std::pin::Pin;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type Environment = BTreeMap<String, String>;
pub type Boxed<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Darwin,
    Win32,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Item {
    Bun,
    Git,
    Omp,
    Gh,
    Node,
    AgentDesktop,
    Tailscale,
}

impl Item {
    pub const ALL: [Item; 7] = [
        Self::Bun,
        Self::Git,
        Self::Omp,
        Self::Gh,
        Self::Node,
        Self::AgentDesktop,
        Self::Tailscale,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Self::Bun => "bun",
            Self::Git => "git",
            Self::Omp => "omp",
            Self::Gh => "gh",
            Self::Node => "node",
            Self::AgentDesktop => "agent-desktop",
            Self::Tailscale => "tailscale",
        }
    }
    pub fn required(self, platform: Platform) -> bool {
        matches!(self, Self::Bun | Self::Omp) || (self == Self::Git && platform == Platform::Win32)
    }
    pub fn automatic(self) -> bool {
        self != Self::Tailscale
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Presence {
    Present {
        version: Option<String>,
        path: Option<String>,
        #[serde(flatten)]
        extra: BTreeMap<String, Value>,
    },
    Missing,
    Outdated {
        version: String,
        minimum: String,
        path: Option<String>,
    },
    Broken {
        detail: String,
        path: Option<String>,
    },
}

impl Presence {
    pub fn present(&self) -> bool {
        matches!(self, Self::Present { .. })
    }
    pub fn version(&self) -> Option<&str> {
        match self {
            Self::Present { version, .. } => version.as_deref(),
            Self::Outdated { version, .. } => Some(version),
            Self::Missing | Self::Broken { .. } => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Checking,
    Present,
    Queued,
    Running,
    Failed,
    Cancelled,
    Requested,
    Unavailable,
    Backoff,
    Idle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Method {
    BunScript,
    BunUpgrade,
    BunGlobal,
    AgentDesktopArchive,
    OmpUpdate,
    PortableGit,
    XcodeSelect,
    Brew,
    Winget,
    Archive,
    TailscaleZip,
    TailscaleMsi,
}

impl Method {
    pub fn name(self) -> &'static str {
        match self {
            Self::BunScript => "bun-script",
            Self::BunUpgrade => "bun-upgrade",
            Self::BunGlobal => "bun-global",
            Self::AgentDesktopArchive => "agent-desktop-archive",
            Self::OmpUpdate => "omp-update",
            Self::PortableGit => "portable-git",
            Self::XcodeSelect => "xcode-select",
            Self::Brew => "brew",
            Self::Winget => "winget",
            Self::Archive => "archive",
            Self::TailscaleZip => "tailscale-zip",
            Self::TailscaleMsi => "tailscale-msi",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnSpec {
    pub file: String,
    pub args: Vec<String>,
    pub shell: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_file: Option<String>,
    pub isolated: bool,
}

#[derive(Debug, Clone)]
pub struct PlanContext {
    pub platform: Platform,
    pub arch: String,
    pub bun_install: String,
    pub tools_dir: String,
    pub bun: Option<String>,
    pub omp: Option<String>,
    pub brew: Option<String>,
    pub winget: Option<String>,
    pub system_root: String,
}

#[derive(Debug, Clone)]
pub struct PlanDownload {
    pub url: String,
    pub sha256: String,
    pub file: String,
}

#[derive(Debug, Clone)]
pub struct InstallPlan {
    pub item: Item,
    pub method: Method,
    pub spawn: SpawnSpec,
    pub command: String,
    pub location: String,
    pub prompt: Option<&'static str>,
    pub download: Option<PlanDownload>,
}

#[derive(Debug, Clone)]
pub struct Detection {
    pub presence: BTreeMap<Item, Presence>,
    pub bun: Option<String>,
    pub omp: Option<String>,
    pub brew: Option<String>,
    pub winget: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

impl Failure {
    pub fn new(reason: &str, detail: impl Into<Option<String>>) -> Self {
        Self {
            reason: reason.to_owned(),
            detail: detail.into(),
            exit_code: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub received: u64,
    pub total: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub step: usize,
    pub steps: usize,
    pub started_at: f64,
    pub download: Option<DownloadProgress>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemState {
    pub id: Item,
    pub required: bool,
    pub phase: Phase,
    pub presence: Option<Presence>,
    pub method: Option<Method>,
    pub command: Option<String>,
    pub location: Option<String>,
    pub prompt: Option<&'static str>,
    pub progress: Option<Progress>,
    pub output: String,
    pub failure: Option<Failure>,
    pub manual_commands: Vec<String>,
    pub manual_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub platform: Platform,
    pub automatic: bool,
    pub omp_ready: bool,
    pub required_running: bool,
    pub items: Vec<ItemState>,
}

/// Native machine services supply these capabilities; neither page JSON nor a core request constructs them.
pub trait Host: Send + Sync + 'static {
    fn update_environment(&self, omp: &str) -> Boxed<'_, Result<Environment, String>>;
    fn compiled_omp(&self, file: &std::path::Path) -> bool;
    fn bun_minimum(&self, manifest: &Value) -> Option<String>;
    fn is_newer(&self, latest: &str, installed: Option<&str>) -> bool;
    fn detect(&self) -> Boxed<'_, Result<Detection, String>>;
    fn environment(&self) -> Boxed<'_, Result<Environment, String>>;
    fn refresh_path(&self) -> Boxed<'_, Result<(), String>>;
    fn before_omp_update(&self) -> Boxed<'_, Result<(), String>>;
    fn omp_ready(&self);
    fn before_optional(&self) -> Boxed<'_, ()>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOutcome {
    Succeeded,
    Cancelled,
    Failed {
        reason: &'static str,
        exit_code: Option<i32>,
        detail: Option<String>,
    },
}
