//! Where a job runs (check control §5 policy 5). The caller never chooses: `start` has no placement argument.
//!
//! - A private repository goes local first: a runner's minutes cost money there, a computer's cost none.
//! - A public repository goes to GitHub's runners, which are free for it and keep the computers free for people.
//! - macOS work goes local first whatever the repository: GitHub runs 5 macOS jobs at once for the whole account,
//!   so a runner takes it only when no local Mac has a slot.
//! - Nothing starts on a computer with a volume under `min_free`. That number is the heavy pool's
//!   (`ompdesk_checks::heavy::min_free`, read as `LocalVolume::low`); it is not computed again here. Making room is
//!   disk care's (`src/main/disk`, the core's `disk`): placement only says which volume is short, and the held start
//!   goes on once it is not.
//!
//! A computer whose link is lost has no capacity (`offline`), and one with waiters has no free slot: its own queue
//! comes first.

use serde::Serialize;

use super::contract::{DeviceId, Os, Where};
use super::sources::LocalPool;

pub struct Ask<'a> {
    pub os: Os,
    /// The repository is private.
    pub private: bool,
    /// A GitHub runner may take the job (the repository has a workflow for it and admission lets it through).
    pub runner: bool,
    pub pools: &'a [LocalPool],
}

/// A volume that keeps heavy work from starting on its computer.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Short {
    pub device: DeviceId,
    pub path: String,
    pub free_gb: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Placement {
    /// None: held until a slot or the disk frees.
    pub place: Option<Where>,
    /// Why, in the words the answer and the decision log carry.
    pub reason: String,
    /// The volumes under `min_free` that kept a computer out; disk care's page is where they are freed.
    pub short: Vec<Short>,
}

fn open(pool: &LocalPool) -> bool {
    pool.held < pool.slots && pool.queued == 0
}

fn short_of(pool: &LocalPool) -> impl Iterator<Item = Short> + '_ {
    pool.volumes.iter().filter(|v| v.low).map(|v| Short {
        device: pool.device.clone(),
        path: v.path.clone(),
        free_gb: v.free_gb,
    })
}

fn word(os: Os) -> &'static str {
    match os {
        Os::Macos => "Mac",
        Os::Windows => "Windows computer",
        Os::Linux => "Linux computer",
    }
}

pub fn place(ask: &Ask) -> Placement {
    let mine: Vec<&LocalPool> = ask
        .pools
        .iter()
        .filter(|p| p.os == ask.os && !p.offline)
        .collect();
    let short: Vec<Short> = mine.iter().flat_map(|p| short_of(p)).collect();
    // The least loaded computer with a free slot and room on its disks; the name breaks a tie the same way each time.
    let ready = mine
        .iter()
        .filter(|p| open(p) && !p.volumes.iter().any(|v| v.low))
        .min_by(|a, b| {
            (u64::from(a.held) * u64::from(b.slots))
                .cmp(&(u64::from(b.held) * u64::from(a.slots)))
                .then_with(|| a.device.cmp(&b.device))
        });
    let local_first = ask.private || ask.os == Os::Macos;
    let on = |pool: &LocalPool, reason: String| Placement {
        place: Some(Where::Device {
            device_id: pool.device.clone(),
        }),
        reason,
        short: Vec::new(),
    };
    // Why no computer takes it, for the runner's or the hold's reason.
    let none = || {
        if let Some(low) = short.first() {
            format!(
                "{} has {:.0} GB free on {}, under what heavy work needs (disk care frees it)",
                low.device, low.free_gb, low.path
            )
        } else if mine.is_empty() {
            format!("no local {} is online", word(ask.os))
        } else {
            format!("no local {} has a free slot", word(ask.os))
        }
    };
    match (ready, local_first, ask.runner) {
        (Some(pool), true, _) if ask.private => on(
            pool,
            format!(
                "private repository: runs on {} and uses no runner minutes",
                pool.device
            ),
        ),
        (Some(pool), true, _) => on(
            pool,
            format!(
                "{} has a free slot: GitHub's macOS runners are kept for when no local Mac has one",
                pool.device
            ),
        ),
        (_, false, true) => Placement {
            place: Some(Where::GithubHosted),
            reason: "public repository: GitHub's runners are free for it".to_string(),
            short: Vec::new(),
        },
        (None, true, true) => Placement {
            place: Some(Where::GithubHosted),
            reason: format!("{}: goes to a GitHub runner", none()),
            short,
        },
        (Some(pool), false, false) => on(
            pool,
            format!("no GitHub runner can take it: runs on {}", pool.device),
        ),
        (None, _, false) => Placement {
            place: None,
            reason: format!("held: {}", none()),
            short,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::super::sources::LocalVolume;
    use super::*;

    fn pool(device: &str, os: Os, slots: u32, held: u32) -> LocalPool {
        LocalPool {
            device: device.into(),
            os,
            slots,
            held,
            queued: 0,
            oldest_wait_ms: 0,
            volumes: vec![LocalVolume {
                path: "/".into(),
                free_gb: 212.0,
                total_gb: 926.0,
                low: false,
            }],
            check_store_bytes: None,
            as_of: 0,
            offline: false,
        }
    }

    fn low(mut pool: LocalPool) -> LocalPool {
        pool.volumes.push(LocalVolume {
            path: "/Volumes/BACKUP".into(),
            free_gb: 7.4,
            total_gb: 500.0,
            low: true,
        });
        pool
    }

    fn ask(os: Os, private: bool, runner: bool, pools: &[LocalPool]) -> Ask<'_> {
        Ask {
            os,
            private,
            runner,
            pools,
        }
    }

    fn device(placement: &Placement) -> Option<&str> {
        match &placement.place {
            Some(Where::Device { device_id }) => Some(device_id),
            _ => None,
        }
    }

    #[test]
    fn a_private_repository_goes_local_first_and_a_public_one_to_runners() {
        let pools = [
            pool("macbook", Os::Macos, 3, 2),
            pool("desktop", Os::Windows, 2, 0),
        ];
        let private = place(&ask(Os::Windows, true, true, &pools));
        assert_eq!(device(&private), Some("desktop"));
        assert!(private.reason.starts_with("private repository"));
        let public = place(&ask(Os::Windows, false, true, &pools));
        assert_eq!(public.place, Some(Where::GithubHosted));
        // No local computer of that system: the private one goes to a runner too, and says why.
        let linux = place(&ask(Os::Linux, true, true, &pools));
        assert_eq!(linux.place, Some(Where::GithubHosted));
        assert!(
            linux
                .reason
                .starts_with("no local Linux computer is online")
        );
    }

    #[test]
    fn macos_work_takes_a_runner_only_when_no_local_mac_has_a_slot() {
        let free = [
            pool("macbook", Os::Macos, 3, 2),
            pool("mini", Os::Macos, 1, 1),
        ];
        let placed = place(&ask(Os::Macos, false, true, &free));
        assert_eq!(device(&placed), Some("macbook"));
        let full = [
            pool("macbook", Os::Macos, 3, 3),
            pool("mini", Os::Macos, 1, 1),
        ];
        let placed = place(&ask(Os::Macos, false, true, &full));
        assert_eq!(placed.place, Some(Where::GithubHosted));
        assert!(placed.reason.starts_with("no local Mac has a free slot"));
        // A Mac whose own queue waits has no slot to give, and one whose link is lost has none at all.
        let mut waiting = pool("macbook", Os::Macos, 3, 1);
        waiting.queued = 2;
        let mut gone = pool("mini", Os::Macos, 1, 0);
        gone.offline = true;
        let placed = place(&ask(Os::Macos, true, true, &[waiting, gone]));
        assert_eq!(placed.place, Some(Where::GithubHosted));
    }

    #[test]
    fn the_least_loaded_computer_takes_it() {
        let pools = [
            pool("b", Os::Macos, 4, 2),
            pool("a", Os::Macos, 2, 1),
            pool("c", Os::Macos, 3, 1),
        ];
        assert_eq!(
            device(&place(&ask(Os::Macos, true, true, &pools))),
            Some("c")
        );
        let tie = [pool("b", Os::Macos, 4, 2), pool("a", Os::Macos, 2, 1)];
        assert_eq!(device(&place(&ask(Os::Macos, true, true, &tie))), Some("a"));
    }

    #[test]
    fn nothing_starts_on_a_computer_with_a_volume_under_min_free() {
        let pools = [
            low(pool("mini", Os::Macos, 1, 0)),
            pool("macbook", Os::Macos, 3, 0),
        ];
        assert_eq!(
            device(&place(&ask(Os::Macos, true, true, &pools))),
            Some("macbook")
        );
        // The only Mac is short of room: a runner takes it where one may, and the answer names the volume.
        let only = [low(pool("mini", Os::Macos, 1, 0))];
        let placed = place(&ask(Os::Macos, true, true, &only));
        assert_eq!(placed.place, Some(Where::GithubHosted));
        assert_eq!(placed.short[0].path, "/Volumes/BACKUP");
        assert!(
            placed
                .reason
                .contains("mini has 7 GB free on /Volumes/BACKUP")
        );
        // Where no runner may, it is held, never started.
        let held = place(&ask(Os::Macos, true, false, &only));
        assert_eq!(held.place, None);
        assert!(held.reason.starts_with("held: mini has 7 GB free"));
        assert!(held.reason.contains("disk care"));
        assert_eq!(held.short.len(), 1);
    }

    #[test]
    fn without_a_runner_a_public_job_runs_locally_or_is_held() {
        let pools = [pool("desktop", Os::Windows, 2, 1)];
        assert_eq!(
            device(&place(&ask(Os::Windows, false, false, &pools))),
            Some("desktop")
        );
        let full = [pool("desktop", Os::Windows, 2, 2)];
        let held = place(&ask(Os::Windows, false, false, &full));
        assert_eq!(
            (held.place, held.reason.as_str()),
            (None, "held: no local Windows computer has a free slot")
        );
    }
}
