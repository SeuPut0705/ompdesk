//! One run's state (was `Run` in `src/main/autopilot.ts`) and the part of it main mirrors for its synchronous readers.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::Mutex as AsyncMutex;

use super::audit::Snapshot;
use super::ship::{QueueItem, ShipRunner};
use super::steps::Steps;
use super::util::{Cancel, flag, text};

/// `AutopilotSettings` as the bridge keeps it: read through these accessors, handed back to the bridge as it came.
#[derive(Debug, Clone)]
pub struct Settings(pub Value);

impl Settings {
    pub fn ship(&self) -> &Value {
        self.0.get("ship").unwrap_or(&Value::Null)
    }

    pub fn remote(&self) -> String {
        text(self.ship(), "remote").unwrap_or("origin").to_owned()
    }

    pub fn auto_push(&self) -> bool {
        flag(self.ship(), "autoPush")
    }

    pub fn land(&self) -> bool {
        flag(self.ship(), "land")
    }

    pub fn auto_release(&self) -> bool {
        self.ship()
            .get("autoRelease")
            .is_some_and(|release| flag(release, "on"))
    }

    pub fn tokens_limit(&self) -> Option<i64> {
        self.0
            .get("limits")
            .and_then(|limits| limits.get("tokens"))
            .and_then(Value::as_i64)
            .filter(|tokens| *tokens != 0)
    }
}

/// A child session the run's cycle opened.
#[derive(Debug, Clone)]
pub struct Child {
    pub tab: String,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    pub area: Option<String>,
}

/// A tab that is a child of a run, by the tab (`ChildRun`).
#[derive(Debug, Clone)]
pub struct ChildRun {
    pub parent: String,
    pub root: String,
}

/// The title this run gave its session, and the cycle item it last named it after.
#[derive(Debug, Clone)]
pub struct Title {
    pub name: String,
    pub item: Option<String>,
}

/// A step of the pipeline that ran past its bound (`AutopilotStall`).
#[derive(Debug, Clone, Serialize)]
pub struct Stall {
    pub step: String,
    pub at: i64,
    pub ms: u64,
}

pub struct RunState {
    pub run: String,
    pub root: String,
    pub branch: String,
    pub base_branch: String,
    /// The user's default checkout of the repository (where a merge lands).
    pub checkout_root: String,
    /// Where Push pushes (`HEAD:<target>`) when the run works on a branch of its own off a target another worktree holds.
    pub target: Option<String>,
    pub settings: Settings,
    pub status: Option<Value>,
    pub snapshot: Option<Snapshot>,
    /// Ref moves the ShipRunner journaled since the snapshot, for the audit.
    pub expected_refs: Vec<String>,
    pub checkout_may_move: bool,
    pub config_may_change: bool,
    /// A verified user request to release was seen: the audit's release scope is open for this cycle.
    pub release_requested: bool,
    pub release_procedure: Option<Value>,
    pub release_blocked: Option<String>,
    /// The project's default branch green cycles land on (Automatic shipping).
    pub land_to: Option<String>,
    /// Landing fell back to a pull request (a protected default branch): told once, shown in the status.
    pub landing: Option<Value>,
    /// Cycles whose commit the default branch got this launch (the end summary also asks git).
    pub landed_count: u32,
    /// When the person chose "ship, then stop" (epoch ms): the first cycle that begins after it carries the note to ship,
    /// and the run ends once that cycle has ended and its work shipped. In memory only: a relaunch carries on running.
    pub end_after_ship: Option<i64>,
    /// "Ship, then stop": the cycle's work shipped and its release run is still going; the run ends when it succeeds.
    pub ship_stop_waits_release: bool,
    /// "Ship, then stop": a release since the choice failed; the run ends only after a later one succeeds.
    pub release_owed: bool,
    pub children: Vec<Child>,
    pub child_branches: BTreeSet<String>,
    pub stopping: bool,
    /// The earliest time the next nudge may go out.
    pub next_nudge_at: i64,
    /// A nudge that came inside the window is asked again when the window passes (one at a time).
    pub nudge_later: bool,
    /// Cancels the wake armed for the end of a quota wait (`waiting_quota`).
    pub quota_wake: Option<Cancel>,
    /// Steps the pipeline stopped for running past their bound (newest few); shown in the run's status.
    pub stalls: Vec<Stall>,
    /// Failed retries since the quota wait began: the backoff's exponent.
    pub quota_retries: u32,
    pub refreshing: bool,
    pub refresh_again: bool,
    pub title: Option<Title>,
    pub stop_polling: Option<Cancel>,
    pub release_item: Option<String>,
    /// `start` is still arming this new run: its first readiness is no restart.
    pub starting: bool,
}

pub struct Run {
    pub tab: String,
    pub state: Mutex<RunState>,
    /// The cycle-end pipeline of one run is sequential, and every step of it has a bound.
    pub steps: Steps,
    pub ship: Arc<ShipRunner>,
    /// Renames of the run's session go one after another, each checking the name the one before it set.
    pub titling: AsyncMutex<()>,
}

impl Run {
    pub fn lock(&self) -> MutexGuard<'_, RunState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn same(&self, other: &Arc<Run>) -> bool {
        std::ptr::eq(self, Arc::as_ptr(other))
    }
}

/// What main reads of a run synchronously (`Autopilot.isStopping`, `runRootOf`, `holdsLimitWait` and the status overlay):
/// sent whole at every change, never read back.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Mirror<'a> {
    tab: &'a str,
    root: &'a str,
    base_branch: &'a str,
    stopping: bool,
    one_shot_release: bool,
    children: Vec<Value>,
    queue: Vec<QueueItem>,
    policy: &'a Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    release_procedure: &'a Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    release_blocked: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    landing: &'a Option<Value>,
    end_after_ship: bool,
    stalls: &'a [Stall],
}

impl Run {
    /// The mirror main keeps of this run, as the tell carries it.
    pub fn mirror(&self) -> Value {
        let state = self.lock();
        let children = state
            .children
            .iter()
            .map(|child| {
                let mut entry = json!({"tabId": child.tab});
                if let Some(area) = &child.area {
                    entry["area"] = json!(area);
                }
                if let Some(branch) = &child.branch {
                    entry["branch"] = json!(branch);
                }
                entry
            })
            .collect();
        let mirror = Mirror {
            tab: &self.tab,
            root: &state.root,
            base_branch: &state.base_branch,
            stopping: state.stopping,
            one_shot_release: state.settings.auto_release() || state.release_requested,
            children,
            queue: self.ship.queue(),
            policy: state.settings.ship(),
            release_procedure: &state.release_procedure,
            release_blocked: &state.release_blocked,
            landing: &state.landing,
            end_after_ship: state.end_after_ship.is_some(),
            stalls: &state.stalls,
        };
        serde_json::to_value(mirror).unwrap_or(Value::Null)
    }
}
