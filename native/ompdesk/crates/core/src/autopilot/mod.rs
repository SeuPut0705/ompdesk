//! Autopilot (was `src/main/autopilot*.ts`; docs/rust-remaining-units.md §2.4, units 9m and 9n): the run state machine
//! that drives a stock Goal, its steps and timers, the ship queue, the post-cycle git audit and the land check.
//!
//! - `coordinator`, `start`, `cycle`: the `Autopilot` class's logic. Main's `Autopilot` (`src/main/autopilot.ts`) is its
//!   typed client and keeps what a synchronous caller reads (`isStopping`, `runRootOf`, `holdsLimitWait`, the status
//!   overlay): a mirror written only from this side's `mirror` and `childRun` tells.
//! - `ship`, `audit`, `land_check` (9n): what main did to git on the run's behalf.
//! - `branches`: the start's branch rules and reads. `steps`: the run's bounded pipeline.
//! - `approval`, `release`, `effects`: native application rules. Approval text is checked by the existing guard in
//!   the real tab's stock bridge; the native host never accepts root, role or release scope from page arguments.
//!
//! What it reaches in main goes through one `Port` (`crate::ports`): the omp of a tab (stock commands and the bridge),
//! the pool's facts, the windows (`dispatch`, `spawnTab`), notices, text, and the few rules that stay TypeScript because
//! the page, the bridge or the turn-resume code share them (the log's Markdown, the quota wait, the release
//! procedure; the approval cards' answers are main's too: the approver keeps the bridge's ban rule). The wire is `autopilot.open {port, seq, state, config}` and then, naming the port: the events `frame`, `status`,
//! `ready`, `released`, `activity`, `aborted`, `resumeSettled` (applied in the order they came, as main
//! sent them), and the calls `command`, `resumeGoal`, `beforeFirstPrompt`, `idle`. The stateless requests the parity suites
//! of `audit`, `ship`, `land_check` and `branches` drive are `autopilot.snapshot`, `autopilot.audit`,
//! `autopilot.branchEntries`, `autopilot.branchInfo`, `autopilot.landCheck` and `autopilot.ship.*`.

pub mod approval;
pub mod audit;
pub mod branches;
mod coordinator;
mod cycle;
pub mod effects;
pub mod land_check;
pub mod release;
mod run;
pub mod ship;
mod start;
pub mod steps;
mod util;
mod wire;

use std::sync::Arc;

use serde::Deserialize;

use crate::git::run::Git;
use crate::ports::Port;
use crate::run::Runner;
use crate::server::{Fault, Registry};

pub use coordinator::register as register_coordinator;

/// The durations the core's clock runs: the real ones by default, shortened by the parity suites (the core's clock cannot
/// be moved, so a short one is waited out).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Tuning {
    /// How often a release run is looked at.
    pub release_poll_ms: u64,
    /// How long a repository's release procedure is remembered.
    pub release_cache_ms: u64,
    /// TurnResume arms its scheduled retry a beat after a failed turn is reported; a failure still standing after this is final.
    pub error_grace_ms: u64,
    /// The longest one ordinary step of a run's pipeline (a nudge, a stop, a quota wake) runs before it is stopped.
    pub step_max_ms: u64,
    /// A cycle's end holds the ship queue's drain: the drain's own bound fires first.
    pub cycle_end_max_ms: u64,
    /// The longest one drain of the ship queue runs.
    pub ship_drain_max_ms: u64,
    /// The least time between two nudges of a run, and after a failed model turn.
    pub nudge_ms: u64,
    pub error_nudge_ms: u64,
    /// A failed retry after a quota wake is tried again after this, doubling, never longer than the maximum.
    pub quota_retry_min_ms: u64,
    pub quota_retry_max_ms: u64,
    /// How long a probe that said `gone` waits before it is asked again.
    pub repo_recheck_ms: u64,
    /// After the land check's timeout asked the supervisor to stop it, how long it has before it is killed.
    pub land_stop_grace_ms: u64,
}

impl Default for Tuning {
    fn default() -> Self {
        Tuning {
            release_poll_ms: 15_000,
            release_cache_ms: 60_000,
            error_grace_ms: 3_000,
            step_max_ms: 15 * 60_000,
            cycle_end_max_ms: 4 * 60 * 60_000,
            ship_drain_max_ms: ship::SHIP_DRAIN_MAX_MS,
            nudge_ms: 20_000,
            error_nudge_ms: 60_000,
            quota_retry_min_ms: 30_000,
            quota_retry_max_ms: 10 * 60_000,
            repo_recheck_ms: 1_500,
            land_stop_grace_ms: land_check::STOP_GRACE_MS,
        }
    }
}

/// A git as main runs it now (`gitRunner`: the binary, the login shell's PATH, the environment), outside any request.
pub(crate) async fn git_from(port: &Port<()>) -> Result<Git, Fault> {
    let runner: Runner = port.ask("gitRunner", &()).await.map_err(Fault::from)?;
    // The scope of the step it is made in: a stopped step ends the gits it ran (`steps::step_scope`).
    Ok(Git::new(runner, steps::step_scope()))
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

pub fn register(registry: &mut Registry) {
    coordinator::register(registry);
    wire::register(registry);
}

/// Shared handle on a port to main.
pub(crate) type MainPort = Arc<Port<()>>;
