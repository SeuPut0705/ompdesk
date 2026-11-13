//! Capacity in the contract's one shape (`Pool`): GitHub's hosted runners per operating system, counted from the
//! jobs the poller sees against the account's limits, and each computer's heavy slots as its own `ompdesk heavy`
//! tells them.
//!
//! The account's limits are GitHub's plan (`docs/design/check-control.md` §1: 5 macOS jobs at once, 40 jobs of any
//! kind) and are spelled once for this repository's scripts, `RUNNER_LIMITS` in `scripts/ci-run.ts`; the numbers
//! here are those (a test reads that file). A repository variable `CHECKS_RUNNER_LIMITS` (`{"jobs":40,"macos":5}`)
//! says otherwise for an account on another plan, and more jobs seen running at once than a limit allows raise it:
//! the account evidently may.

use serde::Deserialize;

use super::wire::{Runner, runner_of};
use crate::checks::contract::{Os, Pool, PoolState, Timestamp, Where};
use crate::checks::sources::{GithubJob, LocalPool};

/// The repository variable that overrides `Limits`.
pub const LIMITS_VARIABLE: &str = "CHECKS_RUNNER_LIMITS";

/// What the account may run at once on GitHub's own runners.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub struct Limits {
    /// Jobs of any operating system.
    pub jobs: u32,
    pub macos: u32,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits { jobs: 40, macos: 5 }
    }
}

impl Limits {
    /// The variable's value; none when it is not this shape (the defaults then hold).
    pub fn parse(value: &str) -> Option<Limits> {
        serde_json::from_str(value).ok()
    }

    /// The larger of each: what any watched repository's variable allows, the account may.
    pub fn widest(self, other: Limits) -> Limits {
        Limits {
            jobs: self.jobs.max(other.jobs),
            macos: self.macos.max(other.macos),
        }
    }
}

pub fn hosted_id(os: Os) -> String {
    format!("github-{}", os.word())
}

pub fn device_id(device: &str) -> String {
    format!("device-{device}")
}

/// Where a job counts: the pool's id and its operating system. None for a job that takes nobody's slot yet (no
/// runner label) or a runner this code cannot place.
pub fn pool_of(job: &GithubJob) -> Option<(String, Os)> {
    match runner_of(&job.labels) {
        Runner::Hosted(os) => Some((hosted_id(os), os)),
        Runner::SelfHosted | Runner::Unknown => None,
    }
}

/// The most jobs seen running at once per operating system, and in all.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Observed {
    macos: u32,
    all: u32,
}

/// GitHub's hosted runners as three pools, from the unfinished jobs of every watched repository. The limit of
/// Windows and Linux is the account's whole allowance, which the three share: GitHub has no smaller one for them.
/// `as_of` is when the oldest of those facts was confirmed; `live` whether all of them are within their window.
pub fn hosted<'a>(
    limits: Limits,
    observed: &mut Observed,
    jobs: impl Iterator<Item = &'a GithubJob>,
    as_of: Timestamp,
    live: bool,
    now: Timestamp,
) -> Vec<Pool> {
    let mut counts = [(0u32, 0u32, None::<Timestamp>); 3];
    for job in jobs {
        let Runner::Hosted(os) = runner_of(&job.labels) else {
            continue;
        };
        let (running, queued, oldest) = &mut counts[os as usize];
        match job.status.as_str() {
            "completed" => {}
            "in_progress" => *running += 1,
            _ => {
                *queued += 1;
                *oldest = Some(oldest.map_or(job.created_at, |at| at.min(job.created_at)));
            }
        }
    }
    let running_all: u32 = counts.iter().map(|(running, ..)| running).sum();
    observed.macos = observed.macos.max(counts[Os::Macos as usize].0);
    observed.all = observed.all.max(running_all);
    Os::ALL
        .iter()
        .map(|&os| {
            let (running, queued, oldest) = counts[os as usize];
            Pool {
                id: hosted_id(os),
                os,
                place: Where::GithubHosted,
                limit: match os {
                    Os::Macos => limits.macos.max(observed.macos),
                    Os::Windows | Os::Linux => limits.jobs.max(observed.all),
                },
                running,
                queued,
                oldest_wait_ms: oldest.map_or(0, |at| now.saturating_sub(at)),
                disk_free_gb: None,
                // Other repositories' jobs on the account are not seen until they are watched (design §11).
                foreign: Vec::new(),
                as_of,
                state: if live {
                    PoolState::Live
                } else {
                    PoolState::Stale
                },
            }
        })
        .collect()
}

/// A computer's heavy slots, and the heavy work beside them that holds none (`foreign`, counted, never managed). One
/// whose link is lost offers nothing (`limit` 0) and says `offline`; what it was last seen running stays, so it does
/// not read as an idle computer.
pub fn device(pool: &LocalPool, live: bool) -> Pool {
    let free = pool
        .volumes
        .iter()
        .map(|volume| volume.free_gb)
        .min_by(f64::total_cmp);
    Pool {
        id: device_id(&pool.device),
        os: pool.os,
        place: Where::Device {
            device_id: pool.device.clone(),
        },
        limit: if pool.offline { 0 } else { pool.slots },
        running: pool.held,
        queued: pool.queued,
        oldest_wait_ms: pool.oldest_wait_ms,
        disk_free_gb: free,
        foreign: pool.foreign.clone(),
        as_of: pool.as_of,
        state: if pool.offline {
            PoolState::Offline
        } else if live {
            PoolState::Live
        } else {
            PoolState::Stale
        },
    }
}

#[cfg(test)]
mod tests {
    use super::super::wire::fixtures::*;
    use super::super::wire::{Answer, JobRow, JobsPage, rows};
    use super::*;
    use crate::checks::contract::ForeignLoad;
    use crate::checks::sources::LocalVolume;

    const T0: Timestamp = 1_794_596_700_000;

    fn recorded_jobs() -> Vec<GithubJob> {
        let page: JobsPage = rows(&Answer::read(JOBS_IN_PROGRESS).unwrap().body).unwrap();
        page.jobs.into_iter().map(JobRow::into_job).collect()
    }

    fn pool(pools: &[Pool], os: Os) -> &Pool {
        pools.iter().find(|pool| pool.os == os).unwrap()
    }

    #[test]
    fn the_limits_are_the_ones_this_repositorys_scripts_spell() {
        let script = include_str!("../../../../../../../scripts/ci-run.ts");
        let block = script
            .split("export const RUNNER_LIMITS = {")
            .nth(1)
            .and_then(|rest| rest.split("};").next())
            .expect("RUNNER_LIMITS in scripts/ci-run.ts");
        let number = |name: &str| -> u32 {
            block
                .lines()
                .find_map(|line| line.trim().strip_prefix(&format!("{name}: ")))
                .and_then(|value| value.trim_end_matches(',').parse().ok())
                .unwrap_or_else(|| panic!("{name} in RUNNER_LIMITS"))
        };
        assert_eq!(
            Limits::default(),
            Limits {
                jobs: number("jobs"),
                macos: number("macos")
            }
        );
    }

    #[test]
    fn the_recorded_jobs_count_into_their_pools() {
        let jobs = recorded_jobs();
        let mut observed = Observed::default();
        let pools = hosted(Limits::default(), &mut observed, jobs.iter(), T0, true, T0);
        assert_eq!(
            pools
                .iter()
                .map(|pool| pool.id.as_str())
                .collect::<Vec<_>>(),
            ["github-macos", "github-windows", "github-linux"]
        );
        // One macOS and one Windows job in progress; the four finished ones take nothing.
        let seen = |os| {
            let pool = pool(&pools, os);
            (pool.limit, pool.running, pool.queued, pool.oldest_wait_ms)
        };
        assert_eq!(seen(Os::Macos), (5, 1, 0, 0));
        assert_eq!(seen(Os::Windows), (40, 1, 0, 0));
        assert_eq!(seen(Os::Linux), (40, 0, 0, 0));
        assert!(pools.iter().all(|pool| pool.state == PoolState::Live
            && pool.as_of == T0
            && pool.place == Where::GithubHosted));
        assert_eq!(
            pool_of(&jobs[0]),
            Some(("github-windows".to_owned(), Os::Windows))
        );
    }

    #[test]
    fn waiting_jobs_are_queued_with_the_oldest_ones_wait() {
        let mut jobs = recorded_jobs();
        for (index, job) in jobs.iter_mut().enumerate() {
            job.status = "queued".to_owned();
            job.created_at = T0 - 60_000 * (index as u64 + 1);
        }
        // A job no runner is chosen for yet, and one on the repository's own runner, wait in no pool of GitHub's.
        jobs[1].labels = Vec::new();
        jobs[2].labels = vec!["self-hosted".to_owned(), "macOS".to_owned()];
        let pools = hosted(
            Limits::default(),
            &mut Observed::default(),
            jobs.iter(),
            T0 - 90_000,
            false,
            T0,
        );
        let macos = pool(&pools, Os::Macos);
        assert_eq!(
            (macos.running, macos.queued, macos.oldest_wait_ms),
            (0, 3, 6 * 60_000)
        );
        assert_eq!(pool(&pools, Os::Windows).queued, 1);
        assert_eq!(pool(&pools, Os::Linux).queued, 0);
        assert!(
            pools
                .iter()
                .all(|pool| pool.state == PoolState::Stale && pool.as_of == T0 - 90_000)
        );
        assert_eq!(pool_of(&jobs[1]), None);
        assert_eq!(pool_of(&jobs[2]), None);
    }

    #[test]
    fn more_seen_running_than_a_limit_allows_raises_it_for_good() {
        let mut jobs: Vec<GithubJob> = recorded_jobs()
            .into_iter()
            .cycle()
            .take(42)
            .map(|mut job| {
                job.status = "in_progress".to_owned();
                job
            })
            .collect();
        let mut observed = Observed::default();
        let busy = hosted(Limits::default(), &mut observed, jobs.iter(), T0, true, T0);
        // 21 macOS, 14 Windows and 7 Linux jobs at once: the plan is evidently not 5 and 40.
        assert_eq!(
            (pool(&busy, Os::Macos).limit, pool(&busy, Os::Macos).running),
            (21, 21)
        );
        assert_eq!(pool(&busy, Os::Linux).limit, 42);
        jobs.truncate(1);
        let quiet = hosted(Limits::default(), &mut observed, jobs.iter(), T0, true, T0);
        assert_eq!(
            (
                pool(&quiet, Os::Macos).limit,
                pool(&quiet, Os::Windows).limit
            ),
            (21, 42)
        );
    }

    #[test]
    fn a_repository_variable_says_the_limits_of_another_plan() {
        assert_eq!(
            Limits::parse("{\"jobs\":500,\"macos\":50}"),
            Some(Limits {
                jobs: 500,
                macos: 50
            })
        );
        for not_limits in [
            "",
            "50",
            "{\"macos\":50}",
            "{\"jobs\":\"many\",\"macos\":5}",
        ] {
            assert_eq!(Limits::parse(not_limits), None, "{not_limits}");
        }
        assert_eq!(
            Limits::default().widest(Limits {
                jobs: 20,
                macos: 50
            }),
            Limits {
                jobs: 40,
                macos: 50
            }
        );
    }

    #[test]
    fn a_computers_slots_are_a_pool_and_a_lost_link_offers_nothing() {
        let local = LocalPool {
            device: "local".to_owned(),
            os: Os::Macos,
            slots: 2,
            held: 1,
            queued: 3,
            oldest_wait_ms: 42_000,
            volumes: vec![
                LocalVolume {
                    path: "/".to_owned(),
                    free_gb: 192.5,
                    total_gb: 927.0,
                    low: false,
                },
                LocalVolume {
                    path: "/Volumes/BACKUP".to_owned(),
                    free_gb: 8.25,
                    total_gb: 465.0,
                    low: true,
                },
            ],
            as_of: T0,
            offline: false,
            check_store_bytes: None,
            foreign: vec![ForeignLoad {
                kind: "godot".to_owned(),
                pid: 31,
                command: "godot --headless -s tests/run.gd".to_owned(),
                processes: 1,
            }],
        };
        let live = device(&local, true);
        assert_eq!(live.id, "device-local");
        assert_eq!(
            live.place,
            Where::Device {
                device_id: "local".to_owned()
            }
        );
        assert_eq!(
            (live.limit, live.running, live.queued, live.oldest_wait_ms),
            (2, 1, 3, 42_000)
        );
        assert_eq!(
            (live.disk_free_gb, live.state),
            (Some(8.25), PoolState::Live)
        );
        // Another project's work beside the slots is told with the pool, so its load is `running + foreign`.
        assert_eq!(
            live.foreign
                .iter()
                .map(|work| (work.kind.as_str(), work.pid))
                .collect::<Vec<_>>(),
            [("godot", 31)]
        );
        assert_eq!(device(&local, false).state, PoolState::Stale);

        let lost = device(
            &LocalPool {
                device: "0123456789abcdefghijklmnop".to_owned(),
                offline: true,
                volumes: Vec::new(),
                ..local
            },
            true,
        );
        assert_eq!(
            (lost.limit, lost.running, lost.state, lost.disk_free_gb),
            (0, 1, PoolState::Offline, None)
        );
    }
}
