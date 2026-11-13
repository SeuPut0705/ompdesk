//! Runner minutes and what they cost, by operating system.
//!
//! **An estimate, computed from the jobs**: each job's duration rounded up to a whole minute, as GitHub bills it,
//! times GitHub's published per-minute rate for the job's runner label. GitHub's billing usage report was the first
//! choice (§4) and was checked on 13 Nov 2026: `GET /users/<login>/settings/billing/usage` does carry a `sku` per line,
//! but it answers 404 to gh's default token (it needs the `user` scope, which OMPdesk's GitHub sign-in does not ask
//! for), an organization's needs an administrator, and `actions/runs/<id>/timing` reports 0 billable milliseconds
//! for every job of a public repository. The jobs are read anyway, so this costs no request. A public repository's
//! standard runners are free: the figure is then what the same minutes would cost, not a bill.
//!
//! Rates read on 13 Nov 2026 from docs.github.com/en/billing/reference/actions-runner-pricing, in millionths of a US
//! dollar per minute. A larger runner with a custom label is priced as its system's standard runner.

use serde::{Deserialize, Serialize};

use crate::checks::contract::Os;

pub const BASIS: &str = "estimated: each job's duration rounded up to a whole minute, times GitHub's published per-minute rate for its runner";

/// Minutes and their price in millionths of a US dollar.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Use {
    pub minutes: u64,
    pub micros: u64,
}

impl Use {
    pub fn add(&mut self, other: Use) {
        self.minutes += other.minutes;
        self.micros += other.micros;
    }

    pub fn usd(&self) -> f64 {
        self.micros as f64 / 1_000_000.0
    }
}

/// The system a job's runner labels name; None for labels that name none (a job that never got a runner).
pub fn os_of(labels: &[String]) -> Option<Os> {
    labels.iter().find_map(|label| {
        let label = label.to_ascii_lowercase();
        if label.starts_with("macos") {
            Some(Os::Macos)
        } else if label.starts_with("windows") {
            Some(Os::Windows)
        } else if label.starts_with("ubuntu") || label.starts_with("linux") {
            Some(Os::Linux)
        } else {
            None
        }
    })
}

/// Millionths of a dollar per minute; None for a self-hosted runner (the owner's own machine: no GitHub minutes).
fn rate(os: Os, labels: &[String]) -> Option<u64> {
    let labels: Vec<String> = labels.iter().map(|l| l.to_ascii_lowercase()).collect();
    if labels.iter().any(|l| l == "self-hosted") {
        return None;
    }
    let has = |part: &str| labels.iter().any(|l| l.contains(part));
    Some(match os {
        Os::Macos if has("-xlarge") => 102_000,
        Os::Macos if has("-large") => 77_000,
        Os::Macos => 62_000,
        Os::Windows => 10_000,
        Os::Linux if has("-slim") => 2_000,
        Os::Linux if has("-arm") => 5_000,
        Os::Linux => 6_000,
    })
}

/// What a job that ran from `started` to `ended` used; None when it used no GitHub runner.
pub fn price(os: Os, labels: &[String], started: u64, ended: u64) -> Option<Use> {
    let ms = ended.saturating_sub(started);
    if ms == 0 || labels.is_empty() {
        return None;
    }
    let minutes = ms.div_ceil(60_000);
    Some(Use {
        minutes,
        micros: minutes * rate(os, labels)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn a_job_is_billed_by_the_started_minute_at_its_runners_rate() {
        let mac = labels(&["macos-15"]);
        assert_eq!(
            price(Os::Macos, &mac, 0, 1),
            Some(Use {
                minutes: 1,
                micros: 62_000
            })
        );
        assert_eq!(
            price(Os::Macos, &mac, 0, 60_000).map(|u| u.minutes),
            Some(1)
        );
        assert_eq!(
            price(Os::Macos, &mac, 0, 60_001).map(|u| u.minutes),
            Some(2)
        );
        let used = price(Os::Linux, &labels(&["ubuntu-latest"]), 1_000, 601_000).unwrap();
        assert_eq!((used.minutes, used.usd()), (10, 0.06));
        assert_eq!(
            price(Os::Windows, &labels(&["windows-latest"]), 0, 60_000).map(|u| u.micros),
            Some(10_000)
        );
    }

    #[test]
    fn the_label_picks_the_rate() {
        let per_minute =
            |os, names: &[&str]| price(os, &labels(names), 0, 60_000).map(|u| u.micros);
        assert_eq!(
            per_minute(Os::Macos, &["macos-latest-xlarge"]),
            Some(102_000)
        );
        assert_eq!(per_minute(Os::Macos, &["macos-15-large"]), Some(77_000));
        assert_eq!(per_minute(Os::Macos, &["macos-15-intel"]), Some(62_000));
        assert_eq!(per_minute(Os::Linux, &["ubuntu-24.04-arm"]), Some(5_000));
        assert_eq!(per_minute(Os::Linux, &["ubuntu-slim"]), Some(2_000));
        assert_eq!(per_minute(Os::Windows, &["windows-11-arm"]), Some(10_000));
    }

    #[test]
    fn a_self_hosted_runner_and_a_job_that_never_ran_use_nothing() {
        assert_eq!(
            price(
                Os::Macos,
                &labels(&["self-hosted", "macOS", "ARM64"]),
                0,
                600_000
            ),
            None
        );
        assert_eq!(price(Os::Linux, &labels(&["ubuntu-latest"]), 5, 5), None);
        assert_eq!(price(Os::Linux, &[], 0, 600_000), None);
    }

    #[test]
    fn labels_name_their_system() {
        assert_eq!(os_of(&labels(&["macos-15"])), Some(Os::Macos));
        assert_eq!(
            os_of(&labels(&["self-hosted", "Windows", "X64"])),
            Some(Os::Windows)
        );
        assert_eq!(os_of(&labels(&["self-hosted", "Linux"])), Some(Os::Linux));
        assert_eq!(os_of(&labels(&["ubuntu-latest"])), Some(Os::Linux));
        assert_eq!(os_of(&[]), None);
    }
}
