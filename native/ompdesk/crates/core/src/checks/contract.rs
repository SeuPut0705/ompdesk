//! The check-control contract (`docs/design/check-control.md` §3 and §6): every shape the hub, main, the page, the
//! agent tool and the CLI twin exchange. This file is the one source. `src/shared/checks-contract.ts` mirrors it and
//! both are pinned to `contract-samples.json`, which the tests below write from these types
//! (`OMPDESK_WRITE_CONTRACT=1 cargo test -p ompdesk-core checks::contract`): a field or word added here without the
//! file fails here, and the file without the mirror fails `src/shared/checks-contract.test.ts`.
//!
//! JSON: camelCase fields, a union is tagged by `kind`, a time is milliseconds since the epoch. A field §3 marks `?`
//! is left out when absent; one §3 types `| null` is always written.

use serde::{Deserialize, Serialize};

/// Milliseconds since the epoch, as `Date.now()` reads them.
pub type Timestamp = u64;
/// The computer a session runs on: `local` for the hub's own, else the paired device's OMPdesk id (`ControlTab.device`).
pub type DeviceId = String;
/// `owner/name`.
pub type RepoId = String;
pub type RunId = String;
pub type JobId = String;
pub type PoolId = String;
pub type GateId = String;
pub type ReleaseId = String;
/// A goal by its own short text, as the session's computer knows it when the run starts. Not an id to look up: a
/// screen shows it as written.
pub type GoalId = String;
/// A session's saved id: the id in its session file's name (`savedIdOfPath`), the one `<ompdesk-agent-message
/// session="…">` carries. A session with no file yet goes by its tab id.
pub type SavedSessionId = String;
pub type Sha = String;
pub type BatchId = String;
/// hash(repo, fully qualified test name).
pub type TestId = String;
/// What a result may be reused on: commit, workflow file hash, inputs and tool digest. Never the sha alone.
pub type InputsDigest = String;

/// An enum that is one word on the wire, with every word listed (`ALL`), so the samples file names each.
macro_rules! words {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident = $word:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $($(#[$vmeta])* #[serde(rename = $word)] $variant),+
        }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            pub fn word(self) -> &'static str {
                match self {
                    $($name::$variant => $word),+
                }
            }
        }
    };
}

words! {
    Os { Macos = "macos", Windows = "windows", Linux = "linux" }
}

words! {
    /// `stale`: the poll window passed without a read. `offline`: the link to that computer is lost (zero capacity).
    PoolState { Live = "live", Stale = "stale", Offline = "offline" }
}

words! {
    /// In admission order: a free slot goes to the oldest job of the first lane that has one.
    Lane { Release = "release", Land = "land", Branch = "branch", Local = "local" }
}

words! {
    Trigger {
        Push = "push",
        PullRequest = "pull_request",
        Dispatch = "dispatch",
        Queue = "queue",
        Local = "local",
    }
}

words! {
    RunVerdict { Green = "green", Red = "red", Cancelled = "cancelled" }
}

words! {
    /// `held`: admitted by nobody yet, waiting in OMPdesk's own queue, not at GitHub.
    JobState {
        Held = "held",
        Queued = "queued",
        Running = "running",
        Passed = "passed",
        Failed = "failed",
        Cancelled = "cancelled",
        Reused = "reused",
    }
}

words! {
    GateVerdict { Green = "green", Red = "red", Running = "running", Waiting = "waiting" }
}

words! {
    PolicyAction {
        CancelSuperseded = "cancel-superseded",
        Hold = "hold",
        Reuse = "reuse",
        Place = "place",
        Batch = "batch",
        Quarantine = "quarantine",
        RerunFailed = "rerun-failed",
    }
}

words! {
    PolicyMode { Enforce = "enforce", Advise = "advise" }
}

words! {
    /// Why a policy acted, as a code the screens translate (`DecisionWhy`).
    WhyCode {
        NewerRun = "newer-run",
        PoolFull = "pool-full",
        ReleaseAhead = "release-ahead",
        Paused = "paused",
        GreenOnSameInputs = "green-on-same-inputs",
        PlacedOn = "placed-on",
        Batched = "batched",
        Flaky = "flaky",
        FailedJobs = "failed-jobs",
        Other = "other",
    }
}

words! {
    QueueState {
        Waiting = "waiting",
        Testing = "testing",
        Ready = "ready",
        Landing = "landing",
        Failed = "failed",
        Removed = "removed",
    }
}

words! {
    Outcome { Pass = "pass", Fail = "fail", Skip = "skip" }
}

words! {
    TestState { Active = "active", Quarantined = "quarantined", Cleared = "cleared" }
}

words! {
    /// `unknown` whenever the facts are older than the poll window: never green from old data.
    AnswerVerdict { Green = "green", Red = "red", Unknown = "unknown" }
}

words! {
    /// What the agent does next; it follows this instead of judging the run itself.
    Next {
        Fix = "fix",
        RerunFailed = "rerun-failed",
        Wait = "wait",
        Land = "land",
        AskOwner = "ask-owner",
    }
}

words! {
    /// Why a check is started. The lane comes from it by policy, never from the caller.
    Purpose { Branch = "branch", Release = "release", Land = "land" }
}

words! {
    StartScope { Changed = "changed", Full = "full" }
}

words! {
    Rerun { Failed = "failed" }
}

words! {
    StartDecision { Started = "started", Reused = "reused", Held = "held", Refused = "refused" }
}

words! {
    /// `result`: the run's verdict. `any`: the first change of the run (a job starting or ending).
    Until { Result = "result", Any = "any" }
}

words! {
    StatusScope { Mine = "mine", Repo = "repo", All = "all" }
}

/// Where a job runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Where {
    Device { device_id: DeviceId },
    GithubHosted,
    SelfHosted { runner_id: String },
}

/// Slot and capacity per OS and machine: one shape for a computer's heavy slots and for GitHub's macOS limit.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pool {
    pub id: PoolId,
    pub os: Os,
    #[serde(rename = "where")]
    pub place: Where,
    pub limit: u32,
    pub running: u32,
    pub queued: u32,
    pub oldest_wait_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_free_gb: Option<f64>,
    pub as_of: Timestamp,
    pub state: PoolState,
    /// Heavy work on that computer that holds none of its slots: shown and counted, never managed. Its load is
    /// `running + foreign.len()` against `limit`. Empty for GitHub's pools.
    pub foreign: Vec<ForeignLoad>,
}

/// Heavy work on a computer that holds none of its slots (another project's own lock, a plain terminal), seen among
/// its processes. Shown and counted, never managed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignLoad {
    /// `cargo`, `godot`, `vitest`, `playwright`.
    pub kind: String,
    /// The topmost process of the work.
    pub pid: u32,
    /// Its command line, cut to 200 characters.
    pub command: String,
    /// The processes of its tree that are that kind (a cargo and its rustc's).
    pub processes: u32,
}

/// Who asked. Main-owned provenance, never read from text or tool arguments.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Origin {
    Session {
        session: SavedSessionId,
        device: DeviceId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        goal: Option<GoalId>,
    },
    /// A person started it (a push, a click on GitHub). Shown, never governed.
    Person,
    /// A process outside OMPdesk over the control socket; the name is its own claim.
    Outside { claimed_name: String },
    /// A run of another repo or program that eats shared capacity. Shown and counted, never touched.
    Foreign,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: RunId,
    pub repo: RepoId,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub sha: Sha,
    pub lane: Lane,
    pub trigger: Trigger,
    pub origin: Origin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<GateId>,
    pub jobs: Vec<Job>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<RunVerdict>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reused_from: Option<RunId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<RunId>,
    pub digest: InputsDigest,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: JobId,
    /// The workflow job's name (`mac-smoke`, `check (node 1/2)`), as a gate's `jobs` list it.
    pub name: String,
    pub os: Os,
    pub pool: PoolId,
    pub state: JobState,
    pub queued_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub billed_min: Option<f64>,
}

/// The jobs a gate names: a workflow file (`ci.yml`) and the job names in it (empty: every job).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSelector {
    pub workflow: String,
    pub jobs: Vec<String>,
}

/// A named set of jobs a release needs; progress is "6 of 10 gates green".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub id: GateId,
    pub release: ReleaseId,
    pub jobs: JobSelector,
    /// Always true: a gate that is not required is no gate.
    pub required: bool,
}

/// A gate as the board shows it: where it stands and the run that decides it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateStatus {
    pub gate: Gate,
    pub state: GateVerdict,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<RunId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub id: String,
    /// `global`, or the repo it holds for.
    pub scope: String,
    /// The condition in words (the rule itself is code, §5).
    pub when: String,
    pub action: PolicyAction,
    pub mode: PolicyMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_override: Option<bool>,
}

/// One line of the "Decided automatically" log. `reason` is English for agents and logs; `why` is what a screen
/// shows, translated from its code.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub policy: String,
    pub run: RunId,
    pub action: PolicyAction,
    pub reason: String,
    pub why: DecisionWhy,
    pub at: Timestamp,
}

/// Why a policy acted. On the wire a union tagged by `code` (TS `DecisionWhySchema`), each code with its own fields:
/// `newer-run {run}`, `pool-full {pool, running, limit}`, `release-ahead {pool, running, limit}`, `paused`,
/// `green-on-same-inputs {run}`, `placed-on {pool}`, `batched {batch}`, `flaky {fails, runs}`, `failed-jobs {count}`,
/// `other`. A flat struct here, not a tagged enum, so a workspace build reads its numbers (serde's
/// `arbitrary_precision`); build one with `DecisionWhy::new(code)` and set that code's fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionWhy {
    pub code: WhyCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<RunId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool: Option<PoolId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fails: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runs: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
}

impl DecisionWhy {
    pub fn new(code: WhyCode) -> DecisionWhy {
        DecisionWhy {
            code,
            run: None,
            pool: None,
            running: None,
            limit: None,
            batch: None,
            fails: None,
            runs: None,
            count: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub id: String,
    pub repo: RepoId,
    pub base: String,
    /// The branch that lands.
    pub branch: String,
    /// Its pull request, when it has one (a repo may land branches without).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<u64>,
    /// What lands, in a line: the pull request's title, else the subject of the branch's newest commit.
    pub title: String,
    pub sha: Sha,
    pub lane: Lane,
    pub position: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch: Option<BatchId>,
    pub state: QueueState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub test: TestId,
    pub run: RunId,
    pub outcome: Outcome,
    pub duration_ms: u64,
    pub digest: InputsDigest,
    pub attempt: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestHistory {
    pub test: TestId,
    /// The name a person reads (file and titles).
    pub name: String,
    /// Quarantine is per OS: a test that flakes on Windows is not suspect on Linux.
    pub os: Os,
    pub p50_ms_30d: u64,
    pub runs_7d: u32,
    pub fails_7d: u32,
    pub state: TestState,
    /// The inputs it both passed and failed on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flaked_on: Option<InputsDigest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quarantined_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleared_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quarantined_by: Option<Origin>,
    /// Clean runs on different inputs so far, of the 5 that clear it.
    pub clean_since: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedTest {
    pub test: String,
    pub first_error: String,
    pub known_flaky: bool,
    /// Its record in words ("failed 3 of the last 20 runs on unchanged inputs").
    pub history: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub passed: u32,
    pub failed: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlocksRelease {
    pub gate: GateId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reused {
    pub from: RunId,
    pub saved_min: u32,
}

/// What an agent receives. It carries the judgment, so the agent never reads logs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub run_id: RunId,
    pub verdict: AnswerVerdict,
    pub as_of: Timestamp,
    pub counts: Counts,
    pub failed: Vec<FailedTest>,
    pub blocks_release: Option<BlocksRelease>,
    pub expected_wait_min: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reused: Option<Reused>,
    pub next: Next,
    pub notes: Vec<String>,
}

/// `start`. There is no placement or lane argument: policy decides both and reports them back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub purpose: Purpose,
    pub scope: StartScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rerun: Option<Rerun>,
    /// Default: the repo of the caller's folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<RepoId>,
    /// Default: the branch of the caller's folder.
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
    /// The caller's folder, set by main (the tool has no such argument).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// A named workflow run instead of the one policy picks for `purpose` (`ompdesk checks start --workflow`, the
    /// front door `scripts/ci-run.ts` uses). The agent tool has no such argument.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<WorkflowAsk>,
}

/// A workflow run named by the caller: its file, the inputs it is dispatched with, and whether it asks for macOS
/// runners (which decides its pool and, from main or a `MAC_REFS` branch, the release lane).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAsk {
    pub file: String,
    pub inputs: std::collections::BTreeMap<String, String>,
    pub macos: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartReply {
    /// None only for `refused`.
    pub run_id: Option<RunId>,
    pub decision: StartDecision,
    pub placement: Option<Where>,
    pub expected_start_min: Option<u32>,
    pub reason: String,
}

/// `wait`. It ends when the result arrives or `timeoutSeconds` passed, whichever is first; a wait that ran out answers
/// `verdict: unknown, next: wait`, never an error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitRequest {
    pub run_id: RunId,
    pub until: Until,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusRequest {
    pub scope: StatusScope,
    /// For `repo`: which one (default: the repo of the caller's folder).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<RepoId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// The last answer an agent received, for the board.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub run_id: RunId,
    pub origin: Origin,
    pub answer: Answer,
}

/// "Are agents using it?" (§7 criterion 5).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Adoption {
    pub started: u32,
    pub refused: u32,
    pub polls: u32,
    pub wrong_greens: u32,
}

/// A test running over 1.3x its 30-day median, three runs in a row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Slowdown {
    pub test: TestId,
    pub name: String,
    pub os: Os,
    pub p50_ms_30d: u64,
    /// The recent durations, oldest first; the last three are the slow runs.
    pub last_ms: Vec<u64>,
    /// The commit of the first slow run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since_sha: Option<Sha>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerMinutes {
    pub os: Os,
    /// `YYYY-MM`.
    pub month: String,
    pub minutes: f64,
    /// The minutes at GitHub's published per-minute rate for the runner (an estimate, not a bill).
    pub cost_usd: f64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthPoint {
    pub at: Timestamp,
    pub pool: PoolId,
    pub queued: u32,
}

/// The "Tests and cost" tab (P4 fills it; empty until then).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trends {
    pub tests: Vec<TestHistory>,
    pub slowdowns: Vec<Slowdown>,
    pub minutes: Vec<RunnerMinutes>,
    pub queue_depth: Vec<DepthPoint>,
    /// Time lost to flaky failures in the last 7 days, and in the 7 before.
    pub lost_ms_7d: u64,
    pub lost_ms_prev_7d: u64,
    pub saved_by_rerun_ms_7d: u64,
    pub saved_by_reuse_ms_7d: u64,
    /// What the check logs and the reuse store hold on disk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_bytes: Option<u64>,
}

/// Everything `status` answers and `watch` streams: the hub's cache at `asOf`. It costs no GitHub request.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub as_of: Timestamp,
    /// The owner paused admission: every start is refused with "paused by the owner".
    pub paused: bool,
    pub pools: Vec<Pool>,
    pub runs: Vec<Run>,
    pub gates: Vec<GateStatus>,
    pub queue: Vec<QueueEntry>,
    pub decisions: Vec<Decision>,
    pub answers: Vec<RunResult>,
    pub adoption: Adoption,
    pub trends: Trends,
}

impl Snapshot {
    pub fn empty(as_of: Timestamp) -> Snapshot {
        Snapshot {
            as_of,
            paused: false,
            pools: Vec::new(),
            runs: Vec::new(),
            gates: Vec::new(),
            queue: Vec::new(),
            decisions: Vec::new(),
            answers: Vec::new(),
            adoption: Adoption {
                started: 0,
                refused: 0,
                polls: 0,
                wrong_greens: 0,
            },
            trends: Trends::default(),
        }
    }
}

/// What main knows and the hub cannot read itself; main says it again whenever it changes.
///
/// Read through `MainFactWire`, never serde's internally tagged form: that one buffers the object first, and a build
/// of the whole workspace has serde_json's `arbitrary_precision` (the CLI asks for it), under which a buffered number
/// is a map and a pool's free gigabytes fail to read (run 43493324223: "invalid type: map, expected f64").
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    try_from = "MainFactWire"
)]
pub enum MainFact {
    /// The repos to follow: those of the open sessions' checkouts. A start follows its repo by itself.
    Repos { repos: Vec<RepoId> },
    /// A paired computer's pool, as that computer answered over the link.
    DevicePool { pool: super::sources::LocalPool },
    /// The link to a paired computer is lost.
    DeviceOffline { device: DeviceId },
    /// Whose each session tag is (`OMP_GUI_SESSION_TAG`), so a local check run names the session that started it.
    Sessions {
        tags: std::collections::BTreeMap<String, Origin>,
    },
}

/// `MainFact` as it is read: one plain object, its fields by the kind.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MainFactWire {
    kind: String,
    repos: Option<Vec<RepoId>>,
    pool: Option<super::sources::LocalPool>,
    device: Option<DeviceId>,
    tags: Option<std::collections::BTreeMap<String, Origin>>,
}

impl TryFrom<MainFactWire> for MainFact {
    type Error = String;
    fn try_from(wire: MainFactWire) -> Result<MainFact, String> {
        let missing = |field: &str| format!("a {} fact needs {field}", wire.kind);
        Ok(match wire.kind.as_str() {
            "repos" => MainFact::Repos {
                repos: wire.repos.clone().ok_or_else(|| missing("repos"))?,
            },
            "devicePool" => MainFact::DevicePool {
                pool: wire.pool.clone().ok_or_else(|| missing("pool"))?,
            },
            "deviceOffline" => MainFact::DeviceOffline {
                device: wire.device.clone().ok_or_else(|| missing("device"))?,
            },
            "sessions" => MainFact::Sessions {
                tags: wire.tags.clone().ok_or_else(|| missing("tags"))?,
            },
            other => return Err(format!("no fact of kind {other:?}")),
        })
    }
}

/// The agent tool and its CLI twin (`ompdesk checks <op>`), by name.
pub const TOOL: &str = "ompdesk_checks";
pub const OPS: [&str; 3] = ["start", "wait", "status"];
/// `wait` ends after this long by default, and never waits longer than the maximum.
pub const WAIT_DEFAULT_SECONDS: u64 = 600;
pub const WAIT_MAX_SECONDS: u64 = 3600;

/// The core's methods (requests of main) and events (to main).
pub mod wire {
    pub const OPEN: &str = "checks.open";
    pub const CLOSE: &str = "checks.close";
    pub const START: &str = "checks.start";
    pub const WAIT: &str = "checks.wait";
    pub const STATUS: &str = "checks.status";
    pub const WATCH: &str = "checks.watch";
    pub const PAUSE: &str = "checks.pause";
    /// `{hub, fact}`: what main knows and the hub cannot read itself (`MainFact`).
    pub const FACTS: &str = "checks.facts";
    /// `{hub, gh, git, home}`: how gh and git run (main's `ghRunner` and `gitRunner`, null when not installed), sent
    /// after the open and again when the login shell's environment changed. Never kept in a log or an answer.
    pub const RUNNERS: &str = "checks.runners";
    /// `{hub}` → this computer's own `LocalPool` as its poller reads it: what a paired computer's link forwards to
    /// another hub as `MainFact::DevicePool` (with its own device id).
    pub const LOCAL_POOL: &str = "checks.localPool";
    /// Drives the fake hub (`checks.open {fake: true}`): tests and the dev harness only.
    pub const FAKE: &str = "checks.fake";
    /// Event: the snapshot changed, while `checks.watch {on: true}` holds.
    pub const SNAPSHOT: &str = "checks.snapshot";
    /// Event: a run's result arrived (`RunResult`), whoever waits.
    pub const RESULT: &str = "checks.result";
}

#[cfg(test)]
pub(crate) mod samples {
    use std::fmt::Debug;

    use serde::de::DeserializeOwned;
    use serde_json::{Map, Value, json};

    use super::*;
    use crate::checks::fake::{FakeCall, FakeOp};
    use crate::checks::sources::{LocalPool, LocalVolume};

    /// The values as JSON, each read back as itself.
    fn of<T: Serialize + DeserializeOwned + PartialEq + Debug>(values: Vec<T>) -> Value {
        Value::Array(
            values
                .into_iter()
                .map(|value| {
                    let json = serde_json::to_value(&value).unwrap();
                    let back: T = serde_json::from_value(json.clone()).unwrap();
                    assert_eq!(back, value);
                    json
                })
                .collect(),
        )
    }

    fn words<T: Serialize>(all: &[T]) -> Value {
        serde_json::to_value(all).unwrap()
    }

    pub(crate) fn session() -> Origin {
        Origin::Session {
            session: "0a1b2c3d".into(),
            device: "local".into(),
            goal: Some("goal-7".into()),
        }
    }

    pub(crate) fn pool() -> Pool {
        Pool {
            id: "github-macos".into(),
            os: Os::Macos,
            place: Where::GithubHosted,
            limit: 5,
            running: 5,
            queued: 3,
            oldest_wait_ms: 540_000,
            disk_free_gb: Some(41.5),
            as_of: 1_794_000_000_000,
            state: PoolState::Live,
            foreign: vec![ForeignLoad {
                kind: "cargo".into(),
                pid: 4242,
                command: "cargo build --release -p game".into(),
                processes: 9,
            }],
        }
    }

    fn job() -> Job {
        Job {
            id: "job-1".into(),
            name: "mac-smoke".into(),
            os: Os::Macos,
            pool: "github-macos".into(),
            state: JobState::Running,
            queued_at: 1_794_000_000_000,
            started_at: Some(1_794_000_060_000),
            ended_at: Some(1_794_000_660_000),
            billed_min: Some(10.5),
        }
    }

    pub(crate) fn run() -> Run {
        Run {
            id: "run-1".into(),
            repo: "example/app".into(),
            git_ref: "omp/agent/feature".into(),
            sha: "0123456789abcdef0123456789abcdef01234567".into(),
            lane: Lane::Branch,
            trigger: Trigger::Dispatch,
            origin: session(),
            gate: Some("gate-mac".into()),
            jobs: vec![job()],
            verdict: Some(RunVerdict::Red),
            reused_from: Some("run-0".into()),
            superseded_by: Some("run-2".into()),
            digest: "sha256:ab12".into(),
        }
    }

    fn gate() -> Gate {
        Gate {
            id: "gate-mac".into(),
            release: "v1.0.0".into(),
            jobs: JobSelector {
                workflow: "ci.yml".into(),
                jobs: vec!["mac-smoke".into(), "mac-native".into()],
            },
            required: true,
        }
    }

    fn history() -> TestHistory {
        TestHistory {
            test: "t-91ac".into(),
            name: "e2e/smoke.e2e.ts › opens a tab".into(),
            os: Os::Windows,
            p50_ms_30d: 4_200,
            runs_7d: 140,
            fails_7d: 11,
            state: TestState::Quarantined,
            flaked_on: Some("sha256:a31f".into()),
            quarantined_at: Some(1_793_900_000_000),
            cleared_at: Some(1_793_990_000_000),
            quarantined_by: Some(session()),
            clean_since: 2,
        }
    }

    pub(crate) fn answer() -> Answer {
        Answer {
            run_id: "run-1".into(),
            verdict: AnswerVerdict::Red,
            as_of: 1_794_000_700_000,
            counts: Counts {
                passed: 1_143,
                failed: 1,
            },
            failed: vec![FailedTest {
                test: "src/main/a.test.ts > saves the file".into(),
                first_error: "AssertionError: expected 1 to be 2".into(),
                known_flaky: true,
                history: "failed 3 of the last 20 runs on unchanged inputs".into(),
            }],
            blocks_release: Some(BlocksRelease {
                gate: "gate-mac".into(),
            }),
            expected_wait_min: Some(18),
            reused: Some(Reused {
                from: "run-0".into(),
                saved_min: 12,
            }),
            next: Next::RerunFailed,
            notes: vec!["1 rerun left for this run".into()],
        }
    }

    /// Every code of `DecisionWhy` with the fields it carries.
    fn why_samples() -> Vec<DecisionWhy> {
        let full = |code| DecisionWhy {
            pool: Some("github-macos".into()),
            running: Some(5),
            limit: Some(5),
            ..DecisionWhy::new(code)
        };
        vec![
            DecisionWhy {
                run: Some("run-42".into()),
                ..DecisionWhy::new(WhyCode::NewerRun)
            },
            full(WhyCode::PoolFull),
            full(WhyCode::ReleaseAhead),
            DecisionWhy::new(WhyCode::Paused),
            DecisionWhy {
                run: Some("run-40".into()),
                ..DecisionWhy::new(WhyCode::GreenOnSameInputs)
            },
            DecisionWhy {
                pool: Some("device-mini".into()),
                ..DecisionWhy::new(WhyCode::PlacedOn)
            },
            DecisionWhy {
                batch: Some("batch-3".into()),
                ..DecisionWhy::new(WhyCode::Batched)
            },
            DecisionWhy {
                fails: Some(3),
                runs: Some(20),
                ..DecisionWhy::new(WhyCode::Flaky)
            },
            DecisionWhy {
                count: Some(2),
                ..DecisionWhy::new(WhyCode::FailedJobs)
            },
            DecisionWhy::new(WhyCode::Other),
        ]
    }

    pub(crate) fn snapshot() -> Snapshot {
        Snapshot {
            as_of: 1_794_000_700_000,
            paused: false,
            pools: vec![pool()],
            runs: vec![run()],
            gates: vec![GateStatus {
                gate: gate(),
                state: GateVerdict::Running,
                run: Some("run-1".into()),
            }],
            queue: vec![QueueEntry {
                id: "q-1".into(),
                repo: "example/app".into(),
                base: "main".into(),
                branch: "omp/agent/search-index".into(),
                pr: Some(12),
                title: "Index the search results".into(),
                sha: "0123456789abcdef0123456789abcdef01234567".into(),
                lane: Lane::Land,
                position: 1,
                batch: Some("batch-3".into()),
                state: QueueState::Testing,
            }],
            decisions: vec![Decision {
                policy: "cancel-superseded".into(),
                run: "run-0".into(),
                action: PolicyAction::CancelSuperseded,
                reason: "run-1 is a newer run of the same ref and workflow".into(),
                why: DecisionWhy {
                    run: Some("run-1".into()),
                    ..DecisionWhy::new(WhyCode::NewerRun)
                },
                at: 1_794_000_100_000,
            }],
            answers: vec![RunResult {
                run_id: "run-1".into(),
                origin: session(),
                answer: answer(),
            }],
            adoption: Adoption {
                started: 14,
                refused: 2,
                polls: 0,
                wrong_greens: 0,
            },
            trends: Trends {
                tests: vec![history()],
                slowdowns: vec![Slowdown {
                    test: "t-91ac".into(),
                    name: "e2e/smoke.e2e.ts › opens a tab".into(),
                    os: Os::Linux,
                    p50_ms_30d: 4_200,
                    last_ms: vec![4_100, 5_900, 6_100, 6_300],
                    since_sha: Some("0123456789abcdef0123456789abcdef01234567".into()),
                }],
                minutes: vec![RunnerMinutes {
                    os: Os::Macos,
                    month: "2026-11".into(),
                    minutes: 412.5,
                    cost_usd: 33.0,
                }],
                queue_depth: vec![DepthPoint {
                    at: 1_794_000_000_000,
                    pool: "github-macos".into(),
                    queued: 3,
                }],
                lost_ms_7d: 5_400_000,
                lost_ms_prev_7d: 9_000_000,
                saved_by_rerun_ms_7d: 21_600_000,
                saved_by_reuse_ms_7d: 14_400_000,
                store_bytes: Some(6_800_000_000),
            },
        }
    }

    /// One value of every shape with every optional field present, every variant of every union, and every word of
    /// every enum: what `contract-samples.json` holds.
    pub(crate) fn all() -> Value {
        let mut enums = Map::new();
        enums.insert("Os".into(), words(Os::ALL));
        enums.insert("PoolState".into(), words(PoolState::ALL));
        enums.insert("Lane".into(), words(Lane::ALL));
        enums.insert("Trigger".into(), words(Trigger::ALL));
        enums.insert("RunVerdict".into(), words(RunVerdict::ALL));
        enums.insert("JobState".into(), words(JobState::ALL));
        enums.insert("GateVerdict".into(), words(GateVerdict::ALL));
        enums.insert("PolicyAction".into(), words(PolicyAction::ALL));
        enums.insert("PolicyMode".into(), words(PolicyMode::ALL));
        enums.insert("QueueState".into(), words(QueueState::ALL));
        enums.insert("WhyCode".into(), words(WhyCode::ALL));
        enums.insert("Outcome".into(), words(Outcome::ALL));
        enums.insert("TestState".into(), words(TestState::ALL));
        enums.insert("AnswerVerdict".into(), words(AnswerVerdict::ALL));
        enums.insert("Next".into(), words(Next::ALL));
        enums.insert("Purpose".into(), words(Purpose::ALL));
        enums.insert("StartScope".into(), words(StartScope::ALL));
        enums.insert("Rerun".into(), words(Rerun::ALL));
        enums.insert("StartDecision".into(), words(StartDecision::ALL));
        enums.insert("Until".into(), words(Until::ALL));
        enums.insert("StatusScope".into(), words(StatusScope::ALL));

        let mut types = Map::new();
        types.insert(
            "Where".into(),
            of(vec![
                Where::Device {
                    device_id: "macbook".into(),
                },
                Where::GithubHosted,
                Where::SelfHosted {
                    runner_id: "mini-1".into(),
                },
            ]),
        );
        types.insert(
            "Origin".into(),
            of(vec![
                session(),
                Origin::Person,
                Origin::Outside {
                    claimed_name: "cli".into(),
                },
                Origin::Foreign,
            ]),
        );
        types.insert("Pool".into(), of(vec![pool()]));
        types.insert("Job".into(), of(vec![job()]));
        types.insert("Run".into(), of(vec![run()]));
        types.insert("Gate".into(), of(vec![gate()]));
        types.insert(
            "Policy".into(),
            of(vec![Policy {
                id: "release-first".into(),
                scope: "global".into(),
                when: "a macOS slot is free and a release job is held".into(),
                action: PolicyAction::Hold,
                mode: PolicyMode::Enforce,
                owner_override: Some(false),
            }]),
        );
        types.insert("DecisionWhy".into(), of(why_samples()));
        types.insert(
            "TestResult".into(),
            of(vec![TestResult {
                test: "t-91ac".into(),
                run: "run-1".into(),
                outcome: Outcome::Fail,
                duration_ms: 6_300,
                digest: "sha256:ab12".into(),
                attempt: 2,
            }]),
        );
        types.insert("TestHistory".into(), of(vec![history()]));
        types.insert("Answer".into(), of(vec![answer()]));
        types.insert(
            "StartRequest".into(),
            of(vec![StartRequest {
                purpose: Purpose::Branch,
                scope: StartScope::Changed,
                rerun: Some(Rerun::Failed),
                repo: Some("example/app".into()),
                git_ref: Some("omp/agent/feature".into()),
                cwd: Some("/work/app".into()),
                workflow: Some(WorkflowAsk {
                    file: "ci.yml".into(),
                    inputs: std::collections::BTreeMap::from([("batch".into(), "true".into())]),
                    macos: false,
                }),
            }]),
        );
        types.insert(
            "StartReply".into(),
            of(vec![StartReply {
                run_id: Some("run-1".into()),
                decision: StartDecision::Held,
                placement: Some(Where::GithubHosted),
                expected_start_min: Some(9),
                reason: "macOS is full (5 of 5); 3 release jobs are ahead".into(),
            }]),
        );
        types.insert(
            "WaitRequest".into(),
            of(vec![WaitRequest {
                run_id: "run-1".into(),
                until: Until::Result,
                timeout_seconds: Some(600),
            }]),
        );
        types.insert(
            "StatusRequest".into(),
            of(vec![StatusRequest {
                scope: StatusScope::Repo,
                repo: Some("example/app".into()),
                cwd: Some("/work/app".into()),
            }]),
        );
        types.insert(
            "RunResult".into(),
            of(vec![RunResult {
                run_id: "run-1".into(),
                origin: session(),
                answer: answer(),
            }]),
        );
        types.insert("Snapshot".into(), of(vec![snapshot()]));
        let device_pool = LocalPool {
            device: "mac-mini".into(),
            os: Os::Macos,
            slots: 1,
            held: 1,
            queued: 2,
            oldest_wait_ms: 120_000,
            volumes: vec![LocalVolume {
                path: "/".into(),
                free_gb: 18.9,
                total_gb: 245.1,
                low: true,
            }],
            as_of: 1_794_000_700_000,
            offline: false,
            check_store_bytes: Some(6_800_000_000),
            foreign: vec![ForeignLoad {
                kind: "vitest".into(),
                pid: 5150,
                command: "node vitest run".into(),
                processes: 4,
            }],
        };
        types.insert("LocalPool".into(), of(vec![device_pool.clone()]));
        types.insert(
            "MainFact".into(),
            of(vec![
                MainFact::Repos {
                    repos: vec!["example/app".into()],
                },
                MainFact::DevicePool { pool: device_pool },
                MainFact::DeviceOffline {
                    device: "mac-mini".into(),
                },
                MainFact::Sessions {
                    tags: [("3f9a".to_owned(), session())].into(),
                },
            ]),
        );
        types.insert(
            "FakeOp".into(),
            of(vec![
                FakeOp::Snapshot {
                    snapshot: snapshot(),
                },
                FakeOp::StartReply {
                    reply: StartReply {
                        run_id: None,
                        decision: StartDecision::Refused,
                        placement: None,
                        expected_start_min: None,
                        reason: "paused by the owner".into(),
                    },
                },
                FakeOp::Finish {
                    result: RunResult {
                        run_id: "run-1".into(),
                        origin: session(),
                        answer: answer(),
                    },
                },
                FakeOp::Calls,
            ]),
        );
        types.insert(
            "FakeCall".into(),
            of(vec![FakeCall {
                op: "wait".into(),
                origin: Some(session()),
                request: json!({ "runId": "run-1", "until": "result" }),
            }]),
        );
        json!({
            "tool": TOOL,
            "ops": OPS,
            "limits": {
                "waitDefaultSeconds": WAIT_DEFAULT_SECONDS,
                "waitMaxSeconds": WAIT_MAX_SECONDS,
            },
            "wire": {
                "open": wire::OPEN,
                "close": wire::CLOSE,
                "start": wire::START,
                "wait": wire::WAIT,
                "status": wire::STATUS,
                "watch": wire::WATCH,
                "pause": wire::PAUSE,
                "fake": wire::FAKE,
                "snapshot": wire::SNAPSHOT,
                "facts": wire::FACTS,
                "runners": wire::RUNNERS,
                "localPool": wire::LOCAL_POOL,
                "result": wire::RESULT,
            },
            "enums": enums,
            "types": types,
        })
    }

    /// Main's requests are read from text, as the wire reads them. In a build of the whole workspace serde_json has
    /// `arbitrary_precision` (the CLI's), under which a tagged union serde buffers read a float as a map (run
    /// 43493367345); the CI `native` job runs this under it.
    #[test]
    fn a_tagged_request_with_floats_reads_from_text() {
        let pool = serde_json::to_string(&json!({
            "op": "snapshot", "snapshot": snapshot()
        }))
        .unwrap();
        let FakeOp::Snapshot { snapshot: read } = serde_json::from_str::<FakeOp>(&pool).unwrap()
        else {
            panic!("not a snapshot")
        };
        assert_eq!(read, snapshot());
        let fact = serde_json::to_string(&MainFact::DevicePool {
            pool: serde_json::from_value(all()["types"]["LocalPool"][0].clone()).unwrap(),
        })
        .unwrap();
        assert!(matches!(
            serde_json::from_str::<MainFact>(&fact).unwrap(),
            MainFact::DevicePool { pool } if pool.volumes[0].free_gb == 18.9
        ));
        assert!(serde_json::from_str::<MainFact>(r#"{"kind":"repos"}"#).is_err());
    }

    #[test]
    fn the_samples_file_holds_the_contract_as_these_types_write_it() {
        let file = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/checks/contract-samples.json"
        );
        let text = format!("{}\n", serde_json::to_string_pretty(&all()).unwrap());
        if std::env::var_os("OMPDESK_WRITE_CONTRACT").is_some() {
            std::fs::write(file, &text).unwrap();
        }
        let kept = std::fs::read_to_string(file).unwrap_or_default();
        assert!(
            kept.replace("\r\n", "\n") == text,
            "contract-samples.json is not what contract.rs writes: run OMPDESK_WRITE_CONTRACT=1 cargo test -p ompdesk-core checks::contract, then update src/shared/checks-contract.ts"
        );
    }
}
