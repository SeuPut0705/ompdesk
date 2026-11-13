//! Admission: what a `start` decides and when a held run takes a place. One `Admission` per hub, behind one lock: a
//! step reads and writes it whole and never awaits while it holds it (assumption A1 of `formal/checks-admission`).
//! The pump (`pump`) takes the lock to admit, writes the place into the ledger (`dispatching`) and only then releases
//! it and awaits the dispatch (A2), so no second pass can see that place free.
//!
//! The rules, each a property of the model (`formal/checks-admission/Properties.md`):
//! - a pool never holds more than its limit, its own runs and those it does not govern counted (P1);
//! - a run is admitted at most once: a dispatch that failed or whose answer never came is never queued again, since
//!   it may have started the run (P2);
//! - a free place goes to the first live entry in line: lane (release, land, branch, local), then arrival (P3, P4,
//!   P9); a release entry whose own pool is full holds one place of the account, which no entry behind it takes
//!   (P12, the owner's F1 decision);
//! - a start cancels only the older governed runs of the same repo, ref and workflow, never a release or merge-queue
//!   run (P5); it is answered `reused` only from a green run of the same input digest (P6); while paused it is refused
//!   and nothing is admitted (P7);
//! - an entry whose lease lapsed is never admitted and leaves the queue (P8, P11).
//!
//! Lane, pool, key and digest are fixed at `start` (A5): the caller gives none of them; policy computes them before.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use super::contract::{Lane, Origin, PoolId, RunId, Timestamp};

/// What makes two runs the same work for superseding: repo, ref and workflow.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Key {
    pub repo: String,
    pub git_ref: String,
    pub workflow: String,
}

/// What policy decided for a run before it asks for a place.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ask {
    pub id: RunId,
    pub origin: Origin,
    pub lane: Lane,
    pub pool: PoolId,
    pub key: Key,
    /// What a green result may be reused on (workflow file hash, inputs, tool digest). Never the sha alone.
    pub digest: String,
    /// Whether the run is the hub's to govern (supersede, cancel). A run a person or another program started is not.
    pub governed: bool,
}

/// Where an entry is (the model's `state`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Held,
    Dispatching,
    Running,
    Cancelling,
    Over(Ended),
}

/// How an entry left (the model's `Over`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ended {
    Refused,
    Reused,
    Failed,
    Green,
    Red,
    Cancelled,
    Expired,
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub ask: Ask,
    pub stage: Stage,
    /// The arrival number: within a lane, the earlier is first.
    pub arrival: u64,
    pub lease_until: Timestamp,
}

impl Entry {
    fn occupies(&self) -> bool {
        matches!(
            self.stage,
            Stage::Dispatching | Stage::Running | Stage::Cancelling
        )
    }

    /// The model's `Ahead`: the higher lane, then the earlier arrival.
    fn ahead_of(&self, other: &Entry) -> bool {
        (rank(self.ask.lane), self.arrival) < (rank(other.ask.lane), other.arrival)
    }
}

fn rank(lane: Lane) -> u8 {
    match lane {
        Lane::Release => 0,
        Lane::Land => 1,
        Lane::Branch => 2,
        Lane::Local => 3,
    }
}

/// A pool's capacity, and whether it counts against the account's limit on all hosted jobs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limit {
    pub places: u32,
    pub hosted: bool,
}

/// What `start` answers. `cancel`: the governed runs it superseded that hold a place, for GitHub's cancel (they keep
/// their place until the poller sees them end, `cancel_landed`); entries that only waited left at once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Started {
    pub stage: Stage,
    pub reused_from: Option<RunId>,
    pub cancel: Vec<RunId>,
    pub superseded: Vec<RunId>,
}

/// One hub's queue and its ledger of places.
pub struct Admission {
    entries: Vec<Entry>,
    limits: BTreeMap<PoolId, Limit>,
    /// The account's limit on all hosted jobs (GitHub's 40, macOS included).
    account: u32,
    /// Places taken by runs the hub does not govern, by pool, as the poller last counted them.
    outside: BTreeMap<PoolId, u32>,
    /// Green runs by input digest.
    greens: HashMap<String, RunId>,
    paused: bool,
    next_arrival: u64,
    lease_ms: u64,
}

impl Admission {
    pub fn new(limits: BTreeMap<PoolId, Limit>, account: u32, lease_ms: u64) -> Admission {
        Admission {
            entries: Vec::new(),
            limits,
            account,
            outside: BTreeMap::new(),
            greens: HashMap::new(),
            paused: false,
            next_arrival: 1,
            lease_ms,
        }
    }

    pub fn entry(&self, id: &str) -> Option<&Entry> {
        self.entries.iter().find(|entry| entry.ask.id == id)
    }

    fn entry_mut(&mut self, id: &str) -> Option<&mut Entry> {
        self.entries.iter_mut().find(|entry| entry.ask.id == id)
    }

    pub fn paused(&self) -> bool {
        self.paused
    }

    /// The limits and the outside load, as the poller read them last.
    pub fn set_pools(
        &mut self,
        limits: BTreeMap<PoolId, Limit>,
        account: u32,
        outside: BTreeMap<PoolId, u32>,
    ) {
        self.limits = limits;
        self.account = account;
        self.outside = outside;
    }

    /// `Start`: one step. Refused while paused, reused from a green run of the same digest, else held with the next
    /// arrival number, superseding the older governed runs of its key that are neither release nor land.
    pub fn start(&mut self, ask: Ask, now: Timestamp) -> Started {
        let arrival = self.next_arrival;
        self.next_arrival += 1;
        let reused_from = self.greens.get(&ask.digest).cloned();
        let stage = if self.paused {
            Stage::Over(Ended::Refused)
        } else if reused_from.is_some() {
            Stage::Over(Ended::Reused)
        } else {
            Stage::Held
        };
        let (mut cancel, mut superseded) = (Vec::new(), Vec::new());
        if stage == Stage::Held && ask.governed {
            for older in &mut self.entries {
                let replaced = older.ask.governed
                    && older.ask.key == ask.key
                    && !matches!(older.ask.lane, Lane::Release | Lane::Land)
                    && matches!(
                        older.stage,
                        Stage::Held | Stage::Dispatching | Stage::Running
                    );
                if !replaced {
                    continue;
                }
                superseded.push(older.ask.id.clone());
                if older.stage == Stage::Held {
                    older.stage = Stage::Over(Ended::Cancelled);
                } else {
                    older.stage = Stage::Cancelling;
                    cancel.push(older.ask.id.clone());
                }
            }
        }
        self.entries.push(Entry {
            ask,
            stage,
            arrival,
            lease_until: now.saturating_add(self.lease_ms),
        });
        Started {
            stage,
            reused_from: reused_from.filter(|_| stage == Stage::Over(Ended::Reused)),
            cancel,
            superseded,
        }
    }

    fn waiting(&self, entry: &Entry, now: Timestamp) -> bool {
        entry.stage == Stage::Held && now < entry.lease_until
    }

    fn limit(&self, pool: &str) -> Limit {
        self.limits.get(pool).copied().unwrap_or(Limit {
            places: 0,
            hosted: false,
        })
    }

    /// The model's `Places(p)`: the hub's own runs in the pool and those the poller counted.
    fn places(&self, pool: &str) -> u32 {
        let own = self
            .entries
            .iter()
            .filter(|entry| entry.ask.pool == pool && entry.occupies())
            .count() as u32;
        own + self.outside.get(pool).copied().unwrap_or(0)
    }

    fn account_places(&self) -> u32 {
        self.limits
            .iter()
            .filter(|(_, limit)| limit.hosted)
            .map(|(pool, _)| self.places(pool))
            .sum()
    }

    /// The model's `Holds(r)`: a live release entry of an account pool whose own pool is full.
    fn holds(&self, entry: &Entry, now: Timestamp) -> bool {
        let limit = self.limit(&entry.ask.pool);
        self.waiting(entry, now)
            && entry.ask.lane == Lane::Release
            && limit.hosted
            && self.places(&entry.ask.pool) >= limit.places
    }

    /// The model's `Room(j)`.
    fn room(&self, entry: &Entry, now: Timestamp) -> bool {
        let limit = self.limit(&entry.ask.pool);
        if self.places(&entry.ask.pool) >= limit.places {
            return false;
        }
        if !limit.hosted {
            return true;
        }
        let held_ahead = self
            .entries
            .iter()
            .filter(|other| {
                other.ask.id != entry.ask.id && self.holds(other, now) && other.ahead_of(entry)
            })
            .count() as u32;
        self.account_places() + held_ahead < self.account
    }

    /// `Admit`: the first live entry in line that has room takes its place (`dispatching`), unless paused. The caller
    /// sends its dispatch after releasing the lock and reports `dispatched` or `dispatch_failed`.
    pub fn admit(&mut self, now: Timestamp) -> Option<Ask> {
        if self.paused {
            return None;
        }
        let mut line: Vec<usize> = (0..self.entries.len())
            .filter(|&at| self.waiting(&self.entries[at], now))
            .collect();
        line.sort_by_key(|&at| (rank(self.entries[at].ask.lane), self.entries[at].arrival));
        let at = line
            .into_iter()
            .find(|&at| self.room(&self.entries[at], now))?;
        let entry = &mut self.entries[at];
        entry.stage = Stage::Dispatching;
        Some(entry.ask.clone())
    }

    /// `Dispatched`: the dispatch was accepted; the run exists.
    pub fn dispatched(&mut self, id: &str) {
        if let Some(entry) = self
            .entry_mut(id)
            .filter(|entry| entry.stage == Stage::Dispatching)
        {
            entry.stage = Stage::Running;
        }
    }

    /// `DispatchFails`: the dispatch failed or its answer never came. The entry ends and its place goes back; it is
    /// never queued again, because a dispatch whose answer was lost may have started the run.
    pub fn dispatch_failed(&mut self, id: &str) {
        if let Some(entry) = self
            .entry_mut(id)
            .filter(|entry| entry.stage == Stage::Dispatching)
        {
            entry.stage = Stage::Over(Ended::Failed);
        }
    }

    /// `RunEnds`: the poller saw the run end. A green one may be reused on its digest from now on.
    pub fn run_ended(&mut self, id: &str, green: bool) {
        let Some(entry) = self
            .entry_mut(id)
            .filter(|entry| entry.stage == Stage::Running)
        else {
            return;
        };
        entry.stage = Stage::Over(if green { Ended::Green } else { Ended::Red });
        if green {
            let (digest, id) = (entry.ask.digest.clone(), entry.ask.id.clone());
            self.greens.insert(digest, id);
        }
    }

    /// `CancelLands`: the poller saw a superseded run end; only now is its place free.
    pub fn cancel_landed(&mut self, id: &str) {
        if let Some(entry) = self
            .entry_mut(id)
            .filter(|entry| entry.stage == Stage::Cancelling)
        {
            entry.stage = Stage::Over(Ended::Cancelled);
        }
    }

    /// A heartbeat of a held entry's owner. A lease that already lapsed is never renewed: the entry is reaped and the
    /// answer is false (`expired`).
    pub fn heartbeat(&mut self, id: &str, now: Timestamp) -> bool {
        let lease_ms = self.lease_ms;
        let Some(entry) = self.entry_mut(id) else {
            return false;
        };
        if entry.stage != Stage::Held {
            return !matches!(entry.stage, Stage::Over(_));
        }
        if now >= entry.lease_until {
            entry.stage = Stage::Over(Ended::Expired);
            return false;
        }
        entry.lease_until = now.saturating_add(lease_ms);
        true
    }

    /// `Reap`: the lease sweep. Every held entry whose lease lapsed leaves the queue `expired`; their ids, to tell
    /// their owners.
    pub fn reap(&mut self, now: Timestamp) -> Vec<RunId> {
        let mut gone = Vec::new();
        for entry in &mut self.entries {
            if entry.stage == Stage::Held && now >= entry.lease_until {
                entry.stage = Stage::Over(Ended::Expired);
                gone.push(entry.ask.id.clone());
            }
        }
        gone
    }

    /// `Pause` and `Resume`: the owner's one control.
    pub fn pause(&mut self, paused: bool) {
        self.paused = paused;
    }

    /// A pool's places taken (its own runs and those it does not govern) and its limit, for the decision log.
    pub fn load(&self, pool: &str) -> (u32, u32) {
        (self.places(pool), self.limit(pool).places)
    }
}

/// One pump pass: admit under the lock, then send the dispatch with the lock released and record its answer. Returns
/// the run it admitted, or None when nothing could start.
pub async fn pump<F, Fut>(
    admission: &Mutex<Admission>,
    now: Timestamp,
    dispatch: F,
) -> Option<RunId>
where
    F: FnOnce(Ask) -> Fut,
    Fut: Future<Output = bool>,
{
    let ask = locked(admission).admit(now)?;
    let id = ask.id.clone();
    let accepted = dispatch(ask).await;
    let mut admission = locked(admission);
    if accepted {
        admission.dispatched(&id);
    } else {
        admission.dispatch_failed(&id);
    }
    Some(id)
}

fn locked(admission: &Mutex<Admission>) -> std::sync::MutexGuard<'_, Admission> {
    admission
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEASE: u64 = 60_000;

    fn pools(mac: u32, account: u32) -> Admission {
        let limits = BTreeMap::from([
            (
                "github-macos".to_owned(),
                Limit {
                    places: mac,
                    hosted: true,
                },
            ),
            (
                "github-linux".to_owned(),
                Limit {
                    places: 40,
                    hosted: true,
                },
            ),
            (
                "device-local".to_owned(),
                Limit {
                    places: 1,
                    hosted: false,
                },
            ),
        ]);
        Admission::new(limits, account, LEASE)
    }

    fn ask(id: &str, lane: Lane, pool: &str, git_ref: &str, digest: &str) -> Ask {
        Ask {
            id: id.into(),
            origin: Origin::Person,
            lane,
            pool: pool.into(),
            key: Key {
                repo: "example/app".into(),
                git_ref: git_ref.into(),
                workflow: "ci.yml".into(),
            },
            digest: digest.into(),
            governed: true,
        }
    }

    #[test]
    fn a_free_place_goes_to_the_release_lane_first_then_by_arrival() {
        let mut queue = pools(1, 40);
        queue.start(ask("b1", Lane::Branch, "github-macos", "a", "d1"), 0);
        queue.start(ask("r1", Lane::Release, "github-macos", "r", "d2"), 0);
        queue.start(ask("r2", Lane::Release, "github-macos", "s", "d3"), 0);
        assert_eq!(queue.admit(1).map(|ask| ask.id), Some("r1".into()));
        // Full: nothing more until a place frees.
        assert_eq!(queue.admit(1), None);
        queue.dispatched("r1");
        queue.run_ended("r1", true);
        assert_eq!(queue.admit(2).map(|ask| ask.id), Some("r2".into()));
    }

    #[test]
    fn a_pool_counts_the_runs_the_hub_does_not_govern() {
        let mut queue = pools(5, 40);
        queue.set_pools(
            queue.limits.clone(),
            40,
            BTreeMap::from([("github-macos".into(), 5)]),
        );
        queue.start(ask("b1", Lane::Branch, "github-macos", "a", "d1"), 0);
        assert_eq!(queue.admit(1), None);
        queue.set_pools(
            queue.limits.clone(),
            40,
            BTreeMap::from([("github-macos".into(), 4)]),
        );
        assert_eq!(queue.admit(1).map(|ask| ask.id), Some("b1".into()));
    }

    #[test]
    fn a_failed_dispatch_frees_its_place_and_is_never_admitted_again() {
        let mut queue = pools(1, 40);
        queue.start(ask("b1", Lane::Branch, "github-macos", "a", "d1"), 0);
        queue.start(ask("b2", Lane::Branch, "github-macos", "b", "d2"), 0);
        assert_eq!(queue.admit(1).map(|ask| ask.id), Some("b1".into()));
        queue.dispatch_failed("b1");
        assert_eq!(queue.entry("b1").unwrap().stage, Stage::Over(Ended::Failed));
        assert_eq!(queue.admit(2).map(|ask| ask.id), Some("b2".into()));
        assert_eq!(queue.admit(3), None);
    }

    #[test]
    fn a_start_supersedes_older_branch_runs_of_its_key_but_never_release_or_land() {
        let mut queue = pools(5, 40);
        let run = |queue: &mut Admission, ask: Ask, now| {
            queue.start(ask, now);
            while let Some(admitted) = queue.admit(now) {
                queue.dispatched(&admitted.id);
            }
        };
        run(
            &mut queue,
            ask("release", Lane::Release, "github-macos", "feat", "d1"),
            0,
        );
        run(
            &mut queue,
            ask("land", Lane::Land, "github-linux", "feat", "d2"),
            0,
        );
        run(
            &mut queue,
            ask("old-run", Lane::Branch, "github-macos", "feat", "d3"),
            0,
        );
        queue.start(
            ask("other-ref", Lane::Branch, "github-linux", "else", "d4"),
            1,
        );
        let started = queue.start(ask("new", Lane::Branch, "github-linux", "feat", "d5"), 2);
        assert_eq!(started.stage, Stage::Held);
        assert_eq!(started.superseded, vec!["old-run".to_owned()]);
        assert_eq!(started.cancel, vec!["old-run".to_owned()]);
        assert_eq!(queue.entry("release").unwrap().stage, Stage::Running);
        assert_eq!(queue.entry("land").unwrap().stage, Stage::Running);
        assert_eq!(queue.entry("other-ref").unwrap().stage, Stage::Held);
        assert_eq!(queue.entry("old-run").unwrap().stage, Stage::Cancelling);
        // A cancelled run keeps its place until the poller sees it end.
        queue.cancel_landed("old-run");
        assert_eq!(
            queue.entry("old-run").unwrap().stage,
            Stage::Over(Ended::Cancelled)
        );
    }

    #[test]
    fn a_held_entry_superseded_before_it_ran_leaves_at_once() {
        let mut queue = pools(0, 40);
        queue.start(ask("old", Lane::Branch, "github-macos", "feat", "d1"), 0);
        let started = queue.start(ask("new", Lane::Branch, "github-macos", "feat", "d2"), 1);
        assert_eq!(started.superseded, vec!["old".to_owned()]);
        assert!(started.cancel.is_empty());
        assert_eq!(
            queue.entry("old").unwrap().stage,
            Stage::Over(Ended::Cancelled)
        );
    }

    #[test]
    fn a_start_is_reused_only_from_a_green_run_of_the_same_digest() {
        let mut queue = pools(5, 40);
        queue.start(ask("red", Lane::Branch, "github-linux", "a", "same"), 0);
        queue.admit(1);
        queue.dispatched("red");
        queue.run_ended("red", false);
        let again = queue.start(ask("again", Lane::Branch, "github-linux", "b", "same"), 2);
        assert_eq!((again.stage, again.reused_from), (Stage::Held, None));
        queue.admit(3);
        queue.dispatched("again");
        queue.run_ended("again", true);
        let third = queue.start(ask("third", Lane::Branch, "github-linux", "c", "same"), 4);
        assert_eq!(third.stage, Stage::Over(Ended::Reused));
        assert_eq!(third.reused_from.as_deref(), Some("again"));
        let other = queue.start(ask("other", Lane::Branch, "github-linux", "d", "other"), 4);
        assert_eq!(other.stage, Stage::Held);
    }

    #[test]
    fn while_paused_a_start_is_refused_and_nothing_is_admitted() {
        let mut queue = pools(5, 40);
        queue.start(ask("held", Lane::Release, "github-macos", "a", "d1"), 0);
        queue.pause(true);
        assert_eq!(queue.admit(1), None);
        let refused = queue.start(ask("late", Lane::Release, "github-macos", "b", "d2"), 1);
        assert_eq!(refused.stage, Stage::Over(Ended::Refused));
        queue.pause(false);
        assert_eq!(queue.admit(2).map(|ask| ask.id), Some("held".into()));
    }

    #[test]
    fn a_lapsed_lease_is_never_admitted_and_never_renewed() {
        let mut queue = pools(1, 40);
        queue.start(ask("slow", Lane::Release, "github-macos", "a", "d1"), 0);
        queue.start(ask("next", Lane::Branch, "github-macos", "b", "d2"), 0);
        assert!(queue.heartbeat("next", LEASE - 1));
        // slow's lease lapsed at LEASE: it is passed over, and a late heartbeat reaps it.
        assert_eq!(queue.admit(LEASE).map(|ask| ask.id), Some("next".into()));
        assert!(!queue.heartbeat("slow", LEASE + 1));
        assert_eq!(
            queue.entry("slow").unwrap().stage,
            Stage::Over(Ended::Expired)
        );
    }

    #[test]
    fn the_sweep_reaps_every_lapsed_entry() {
        let mut queue = pools(0, 40);
        queue.start(ask("a", Lane::Branch, "github-macos", "a", "d1"), 0);
        queue.start(ask("b", Lane::Branch, "github-macos", "b", "d2"), 10);
        assert_eq!(queue.reap(LEASE), vec!["a".to_owned()]);
        assert_eq!(queue.reap(LEASE + 10), vec!["b".to_owned()]);
    }

    #[test]
    fn a_release_entry_waiting_on_macos_holds_an_account_place_from_those_behind_it() {
        // macOS full (1 of 1), the account at 2 of 3: one account place is free.
        let mut queue = pools(1, 3);
        queue.set_pools(
            queue.limits.clone(),
            3,
            BTreeMap::from([("github-macos".into(), 1), ("github-linux".into(), 1)]),
        );
        queue.start(ask("release", Lane::Release, "github-macos", "r", "d1"), 0);
        queue.start(ask("branch", Lane::Branch, "github-linux", "b", "d2"), 0);
        // The branch job behind it may not take the account place the release entry holds.
        assert_eq!(queue.admit(1), None);
        // macOS frees: the release entry takes it, the account still within its limit.
        queue.set_pools(
            queue.limits.clone(),
            3,
            BTreeMap::from([("github-macos".into(), 0), ("github-linux".into(), 1)]),
        );
        assert_eq!(queue.admit(2).map(|ask| ask.id), Some("release".into()));
        // Nothing is held any more: the branch job takes the account's last place.
        assert_eq!(queue.admit(3).map(|ask| ask.id), Some("branch".into()));
        // A device pool is outside the account: a job there is never held back by it.
        queue.start(ask("local", Lane::Local, "device-local", "l", "d3"), 3);
        assert_eq!(queue.admit(4).map(|ask| ask.id), Some("local".into()));
    }

    #[tokio::test]
    async fn the_place_is_in_the_ledger_before_the_dispatch_is_awaited() {
        let admission = Mutex::new(pools(1, 40));
        locked(&admission).start(ask("a", Lane::Branch, "github-macos", "a", "d1"), 0);
        locked(&admission).start(ask("b", Lane::Branch, "github-macos", "b", "d2"), 0);
        let admitted = pump(&admission, 1, |ask| {
            // While the dispatch is out, a second pass finds the place taken.
            assert_eq!(ask.id, "a");
            assert_eq!(locked(&admission).admit(1), None);
            assert_eq!(
                locked(&admission).entry("a").unwrap().stage,
                Stage::Dispatching
            );
            async { true }
        })
        .await;
        assert_eq!(admitted.as_deref(), Some("a"));
        assert_eq!(locked(&admission).entry("a").unwrap().stage, Stage::Running);
    }
}
