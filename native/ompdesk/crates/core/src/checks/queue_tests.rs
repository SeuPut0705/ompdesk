//! The queue's rules against a made-up remote. A commit is named by what is on it ("e1+e2"; "root" for nothing), so
//! "built on", "fast-forward" and "the check passes" are plain comparisons, as in `formal/checks-queue`.

use std::collections::HashSet;

use super::*;

const WINDOW: u64 = 1000;

fn name(content: &[String]) -> String {
    if content.is_empty() {
        "root".to_owned()
    } else {
        content.join("+")
    }
}

fn content(commit: &str) -> Vec<String> {
    if commit == "root" {
        Vec::new()
    } else {
        commit.split('+').map(str::to_owned).collect()
    }
}

fn ask(number: u32, goal: &str) -> Ask {
    Ask {
        branch: format!("b{number}"),
        pr: None,
        title: format!("change {number}"),
        sha: format!("e{number}"),
        goal: Some(goal.to_owned()),
        origin: Origin::Person,
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Pushed {
    NotYet,
    Taken,
    Refused,
}

/// The remote, the check and whoever runs the queue: it keeps what the queue asked for until a test answers it.
struct World {
    queue: LandQueue,
    now: u64,
    main: Vec<String>,
    bad: HashSet<String>,
    builds: Vec<(String, String)>,
    runs: Vec<String>,
    lands: Vec<(String, String, Pushed)>,
    /// Every commit a run was asked for, in order.
    tested: Vec<String>,
    green: HashSet<String>,
    red: HashSet<String>,
    landed: Vec<String>,
    failed: Vec<(String, String)>,
    dropped: Vec<String>,
}

impl World {
    fn new(batch_size: usize, bad: &[&str]) -> World {
        let tuning = Tuning {
            batch_size,
            window_ms: WINDOW,
        };
        World {
            queue: LandQueue::new(
                "o/r".into(),
                "main".into(),
                "q".into(),
                "root".into(),
                tuning,
            ),
            now: 0,
            main: Vec::new(),
            bad: bad.iter().map(|sha| (*sha).to_owned()).collect(),
            builds: Vec::new(),
            runs: Vec::new(),
            lands: Vec::new(),
            tested: Vec::new(),
            green: HashSet::new(),
            red: HashSet::new(),
            landed: Vec::new(),
            failed: Vec::new(),
            dropped: Vec::new(),
        }
    }

    fn take(&mut self, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::Build {
                    candidate,
                    tip,
                    parts,
                } => {
                    let mut built = content(&tip);
                    built.extend(parts.into_iter().map(|part| part.sha));
                    self.builds.push((candidate, name(&built)));
                }
                Effect::Test { commit, .. } => {
                    self.tested.push(commit.clone());
                    self.runs.push(commit);
                }
                Effect::Land { candidate, commit } => {
                    assert!(
                        self.green.contains(&commit),
                        "the queue pushes {commit}, which no run reported green"
                    );
                    self.lands.push((candidate, commit, Pushed::NotYet));
                }
                Effect::Drop { candidate } => self.dropped.push(candidate),
                Effect::Tell { entry, told } => match told {
                    Told::Landed { commit } => {
                        assert!(content(&commit).contains(&entry.sha));
                        assert!(
                            self.main.contains(&entry.sha),
                            "{} is told landed and is not on the base",
                            entry.sha
                        );
                        self.landed.push(entry.sha);
                    }
                    Told::Failed { why } => {
                        let mut alone = content(self.queue.tip());
                        alone.push(entry.sha.clone());
                        assert!(
                            self.red.contains(&name(&alone)),
                            "{} failed on {}, which no run reported red",
                            entry.sha,
                            name(&alone)
                        );
                        self.failed.push((entry.sha, why));
                    }
                },
            }
        }
    }

    fn enqueue(&mut self, number: u32, goal: &str) -> String {
        let (id, effects) = self
            .queue
            .enqueue(ask(number, goal), self.now)
            .expect("queued");
        self.take(effects);
        id
    }

    fn remove(&mut self, id: &str) -> Result<(), Refusal> {
        let effects = self.queue.remove(id, self.now)?;
        self.take(effects);
        Ok(())
    }

    fn pass(&mut self, ms: u64) {
        self.now += ms;
        let effects = self.queue.tick(self.now);
        self.take(effects);
    }

    fn answer_build(&mut self, index: usize) {
        let (candidate, commit) = self.builds.remove(index);
        let effects = self.queue.built(&candidate, Ok(commit), self.now);
        self.take(effects);
    }

    fn end_run(&mut self, index: usize) {
        let commit = self.runs.remove(index);
        let green = content(&commit).iter().all(|sha| !self.bad.contains(sha));
        if green {
            self.green.insert(commit.clone());
        } else {
            self.red.insert(commit.clone());
        }
        let effects = self
            .queue
            .verdict(&commit, green, "the check failed", self.now);
        self.take(effects);
    }

    /// Git's side of a land: the base takes the commit only as a fast-forward.
    fn push(&mut self, index: usize) {
        let (_, commit, pushed) = &mut self.lands[index];
        let to = content(commit);
        if to.len() > self.main.len() && to[..self.main.len()] == self.main[..] {
            self.main = to;
            *pushed = Pushed::Taken;
        } else {
            *pushed = Pushed::Refused;
        }
    }

    fn answer_land(&mut self, index: usize) {
        let (candidate, _, pushed) = self.lands.remove(index);
        let tip = name(&self.main);
        let effects = match pushed {
            Pushed::Taken => self.queue.landed(&candidate, tip, self.now),
            Pushed::Refused => self.queue.moved(&candidate, tip, self.now),
            Pushed::NotYet => unreachable!("answered before it was pushed"),
        };
        self.take(effects);
    }

    fn outside_push(&mut self, what: &str) {
        self.main.push(what.to_owned());
    }

    fn read_base(&mut self) {
        let effects = self.queue.base_read(name(&self.main), self.now);
        self.take(effects);
    }

    /// Answers everything asked, oldest first, until the queue asks for nothing more.
    fn settle(&mut self) {
        for _ in 0..1000 {
            if !self.builds.is_empty() {
                self.answer_build(0);
            } else if !self.runs.is_empty() {
                self.end_run(0);
            } else if !self.lands.is_empty() {
                if self.lands[0].2 == Pushed::NotYet {
                    self.push(0);
                }
                self.answer_land(0);
            } else {
                return;
            }
        }
        panic!("the queue never came to rest");
    }

    fn check(&self) {
        let on_main: HashSet<&String> = self.main.iter().collect();
        assert_eq!(
            on_main.len(),
            self.main.len(),
            "landed twice: {:?}",
            self.main
        );
        assert!(
            self.main.iter().all(|sha| !self.bad.contains(sha)),
            "a change that fails the check is on the base: {:?}",
            self.main
        );
    }
}

fn states(world: &World) -> Vec<(String, QueueState, u32)> {
    world
        .queue
        .entries()
        .into_iter()
        .map(|entry| (entry.sha, entry.state, entry.position))
        .collect()
}

#[test]
fn a_full_batch_is_built_once_and_lands_as_the_commit_that_was_tested() {
    let mut world = World::new(4, &[]);
    for number in 1..=3 {
        world.enqueue(number, "g");
        assert!(world.builds.is_empty(), "a batch formed before it was full");
    }
    world.enqueue(4, "g");
    world.settle();
    assert_eq!(world.tested, ["e1+e2+e3+e4"]);
    assert_eq!(world.main, ["e1", "e2", "e3", "e4"]);
    assert_eq!(world.landed, ["e1", "e2", "e3", "e4"]);
    assert!(world.queue.is_empty());
    assert_eq!(world.queue.tip(), "e1+e2+e3+e4");
}

#[test]
fn a_batch_that_is_not_full_forms_when_its_oldest_entry_waited_the_window() {
    let mut world = World::new(4, &[]);
    world.enqueue(1, "g");
    world.pass(400);
    world.enqueue(2, "g");
    assert_eq!(world.queue.next_wake(), Some(WINDOW));
    world.pass(WINDOW - 401);
    assert!(world.builds.is_empty());
    world.pass(1);
    assert_eq!(world.builds.len(), 1);
    assert_eq!(world.queue.next_wake(), None);
    world.settle();
    assert_eq!(world.tested, ["e1+e2"]);
    assert_eq!(world.main, ["e1", "e2"]);
}

#[test]
fn a_batch_is_of_one_goal_and_the_others_keep_their_place() {
    let mut world = World::new(2, &[]);
    world.enqueue(1, "a");
    world.enqueue(2, "b");
    world.enqueue(3, "a");
    assert_eq!(
        states(&world),
        [
            ("e1".to_owned(), QueueState::Testing, 1),
            ("e3".to_owned(), QueueState::Testing, 2),
            ("e2".to_owned(), QueueState::Waiting, 3),
        ]
    );
    world.settle();
    world.pass(WINDOW);
    world.settle();
    assert_eq!(world.tested, ["e1+e3", "e1+e3+e2"]);
    assert_eq!(world.main, ["e1", "e3", "e2"]);
}

#[test]
fn a_red_batch_is_bisected_and_only_the_entry_that_fails_alone_is_failed() {
    let mut world = World::new(4, &["e3"]);
    for number in 1..=4 {
        world.enqueue(number, "g");
    }
    world.settle();
    assert_eq!(
        world.tested,
        ["e1+e2+e3+e4", "e1+e2", "e1+e2+e3", "e1+e2+e4"]
    );
    assert_eq!(world.main, ["e1", "e2", "e4"]);
    assert_eq!(world.landed, ["e1", "e2", "e4"]);
    assert_eq!(
        world.failed,
        [("e3".to_owned(), "the check failed".to_owned())]
    );
    assert!(world.queue.is_empty());
}

#[test]
fn a_combination_already_known_red_is_not_built_again() {
    let mut world = World::new(4, &["e4"]);
    for number in 1..=4 {
        world.enqueue(number, "g");
    }
    world.settle();
    // The whole batch was red, and after e1+e2 and e3 landed that is e4 alone on the tip: no fourth run.
    assert_eq!(world.tested, ["e1+e2+e3+e4", "e1+e2", "e1+e2+e3"]);
    assert_eq!(world.main, ["e1", "e2", "e3"]);
    assert_eq!(world.failed.len(), 1);
    assert_eq!(world.failed[0].0, "e4");
}

#[test]
fn what_was_known_is_not_carried_past_someone_else_s_push() {
    let mut world = World::new(2, &["e2"]);
    world.enqueue(1, "g");
    world.enqueue(2, "g");
    world.answer_build(0);
    world.end_run(0);
    world.answer_build(0);
    world.end_run(0);
    world.push(0);
    world.outside_push("x1");
    world.answer_land(0);
    // e1+e2 was red, but the base is now e1+x1: e2 is tested on it before it is failed.
    world.settle();
    assert_eq!(world.tested, ["e1+e2", "e1", "e1+x1+e2"]);
    assert_eq!(world.failed[0].0, "e2");
    assert_eq!(world.main, ["e1", "x1"]);
}

#[test]
fn a_result_for_a_trial_dropped_at_a_base_move_is_ignored() {
    let mut world = World::new(1, &[]);
    world.enqueue(1, "g");
    world.answer_build(0);
    world.outside_push("x1");
    world.read_base();
    assert_eq!(world.dropped, ["q-c3"]);
    // The run of the dropped trial ends green: nothing lands on its word.
    world.end_run(0);
    assert!(world.lands.is_empty());
    world.settle();
    assert_eq!(world.tested, ["e1", "x1+e1"]);
    assert_eq!(world.main, ["x1", "e1"]);
}

#[test]
fn a_push_the_base_refuses_as_not_a_fast_forward_starts_over_on_the_new_tip() {
    let mut world = World::new(2, &[]);
    world.enqueue(1, "g");
    world.enqueue(2, "g");
    world.answer_build(0);
    world.end_run(0);
    world.outside_push("x1");
    world.settle();
    assert_eq!(world.tested, ["e1+e2", "x1+e1+e2"]);
    assert_eq!(world.main, ["x1", "e1", "e2"]);
    assert_eq!(world.landed, ["e1", "e2"]);
}

#[test]
fn a_base_read_while_the_queue_s_own_push_is_under_way_changes_nothing() {
    let mut world = World::new(1, &[]);
    world.enqueue(1, "g");
    world.answer_build(0);
    world.end_run(0);
    world.push(0);
    world.read_base();
    assert!(world.builds.is_empty());
    world.settle();
    assert_eq!(world.tested, ["e1"]);
    assert_eq!(world.main, ["e1"]);
}

#[test]
fn withdrawing_an_entry_drops_the_trial_that_holds_it_and_no_other() {
    let mut world = World::new(3, &[]);
    let ids: Vec<String> = (1..=3).map(|number| world.enqueue(number, "g")).collect();
    world.answer_build(0);
    world.remove(&ids[1]).expect("withdrawn");
    assert_eq!(
        world.dropped.len(),
        1,
        "the trial that held e2 was not dropped"
    );
    world.settle();
    assert_eq!(world.tested, ["e1+e2+e3", "e1+e3"]);
    assert_eq!(world.main, ["e1", "e3"]);
    assert!(
        states(&world).contains(&("e2".to_owned(), QueueState::Removed, 0)),
        "{:?}",
        states(&world)
    );
}

#[test]
fn an_entry_outside_the_commit_under_test_is_withdrawn_without_touching_the_trial() {
    let mut world = World::new(4, &["e2"]);
    let ids: Vec<String> = (1..=4).map(|number| world.enqueue(number, "g")).collect();
    world.answer_build(0);
    world.end_run(0);
    // Bisection now tests e1+e2; e4 is not in it.
    world.remove(&ids[3]).expect("withdrawn");
    assert_eq!(world.dropped.len(), 1, "only the red batch's branch goes");
    world.settle();
    assert_eq!(world.main, ["e1", "e3"]);
    assert_eq!(world.failed[0].0, "e2");
}

#[test]
fn an_entry_is_not_withdrawn_while_the_commit_that_holds_it_is_pushed() {
    let mut world = World::new(1, &[]);
    let id = world.enqueue(1, "g");
    world.answer_build(0);
    world.end_run(0);
    assert_eq!(world.remove(&id), Err(Refusal::Landing));
    assert_eq!(states(&world), [("e1".to_owned(), QueueState::Landing, 1)]);
    world.settle();
    assert_eq!(world.main, ["e1"]);
    assert_eq!(world.remove(&id), Err(Refusal::Unknown));
}

#[test]
fn a_branch_queued_again_takes_its_new_commit() {
    let mut world = World::new(2, &[]);
    let first = world.enqueue(1, "g");
    let mut again = ask(1, "g");
    again.sha = "e9".into();
    let (id, effects) = world
        .queue
        .enqueue(again.clone(), world.now)
        .expect("queued");
    world.take(effects);
    assert_eq!(id, first, "a waiting branch keeps its place");

    world.enqueue(2, "g");
    world.answer_build(0);
    // In the flight its old commit is what is under test: it leaves and waits again.
    again.sha = "e7".into();
    let (id, effects) = world.queue.enqueue(again, world.now).expect("queued");
    world.take(effects);
    assert_ne!(id, first);
    world.settle();
    world.pass(WINDOW);
    world.settle();
    assert_eq!(world.main, ["e2", "e7"]);
}

#[test]
fn a_branch_that_does_not_merge_is_failed_with_its_files_named() {
    let mut world = World::new(2, &[]);
    world.enqueue(1, "g");
    world.enqueue(2, "g");
    let (candidate, _) = world.builds.remove(0);
    let conflict = Conflict {
        at: 2,
        files: vec!["src/a.ts".into()],
    };
    let effects = world.queue.built(&candidate, Err(conflict), world.now);
    // No run reports it: the build that did not merge is the red result.
    world.red.insert("e1+e2".into());
    world.take(effects);
    world.answer_build(0);
    world.end_run(0);
    world.push(0);
    world.answer_land(0);
    assert_eq!(world.main, ["e1"]);
    assert_eq!(world.failed.len(), 1);
    assert_eq!(world.failed[0].0, "e2");
    assert!(
        world.failed[0].1.contains("src/a.ts"),
        "{}",
        world.failed[0].1
    );
    assert_eq!(world.tested, ["e1"], "a build that failed starts no run");
}

#[test]
fn a_base_that_takes_no_push_of_the_queue_fails_every_entry_with_the_remote_s_words() {
    let mut world = World::new(1, &[]);
    world.enqueue(1, "g");
    world.enqueue(2, "g");
    world.answer_build(0);
    world.end_run(0);
    let (candidate, _, _) = world.lands.remove(0);
    world.red.extend(["e1".to_owned(), "e2".to_owned()]);
    let effects = world
        .queue
        .refused(&candidate, "protected branch hook declined");
    world.take(effects);
    assert!(world.queue.is_empty());
    assert_eq!(world.failed.len(), 2);
    assert!(world.failed[1].1.contains("protected branch hook declined"));
    assert!(world.main.is_empty());
}

#[test]
fn a_run_that_ended_without_a_result_is_asked_for_again() {
    let mut world = World::new(1, &[]);
    world.enqueue(1, "g");
    world.answer_build(0);
    world.runs.clear();
    let effects = world.queue.lost("q-c3", world.now);
    world.take(effects);
    world.settle();
    assert_eq!(world.tested, ["e1", "e1"]);
    assert_eq!(world.main, ["e1"]);
}

#[test]
fn a_saved_queue_asks_again_for_what_a_restart_interrupted() {
    let mut world = World::new(1, &[]);
    world.enqueue(1, "g");
    let reload = |queue: &LandQueue| -> LandQueue {
        serde_json::from_str(&serde_json::to_string(queue).expect("written")).expect("read")
    };
    let saved = reload(&world.queue);
    assert_eq!(saved, world.queue);
    assert!(matches!(saved.resume()[..], [Effect::Build { .. }]));

    world.answer_build(0);
    assert!(matches!(
        reload(&world.queue).resume()[..],
        [Effect::Test { .. }]
    ));
    world.end_run(0);
    world.push(0);
    // Stopped after the push went through and before its answer was taken: the push is asked again, and the base
    // already holding the commit reads as landed.
    world.queue = reload(&world.queue);
    let again = world.queue.resume();
    assert!(matches!(again[..], [Effect::Land { .. }]));
    world.answer_land(0);
    assert_eq!(world.landed, ["e1"]);
    assert!(world.queue.is_empty());
    assert!(reload(&world.queue).resume().is_empty());
}

/// xorshift64: the same orders on every run and every computer.
struct Dice(u64);

impl Dice {
    fn roll(&mut self, sides: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % sides as u64) as usize
    }
}

/// The model's properties (`formal/checks-queue/Properties.md`) on this code: any order of arrivals, withdrawals,
/// results (also of dropped trials), pushes by others and base reads. `take` and `check` hold the invariants at every
/// step; the end holds that the queue drains once the world leaves it alone.
#[test]
fn any_order_of_events_lands_only_tested_commits_in_order_and_drains() {
    for seed in 1..=3000u64 {
        let mut dice = Dice(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        let total = 5;
        let bad: Vec<String> = (1..=total)
            .filter(|_| dice.roll(3) == 0)
            .map(|number| format!("e{number}"))
            .collect();
        let bad: Vec<&str> = bad.iter().map(String::as_str).collect();
        let mut world = World::new(1 + dice.roll(4), &bad);
        let mut ids: Vec<String> = Vec::new();
        let mut removed: HashSet<String> = HashSet::new();
        let mut outside = 0;
        for _ in 0..80 {
            match dice.roll(9) {
                0 if ids.len() < total => {
                    let number = ids.len() as u32 + 1;
                    let goal = if number.is_multiple_of(2) { "a" } else { "b" };
                    ids.push(world.enqueue(number, goal));
                }
                1 if !ids.is_empty() && removed.len() < 2 => {
                    let index = dice.roll(ids.len());
                    if world.remove(&ids[index]).is_ok() {
                        removed.insert(format!("e{}", index + 1));
                    }
                }
                2 => world.pass(dice.roll(WINDOW as usize) as u64),
                3 if !world.builds.is_empty() => world.answer_build(dice.roll(world.builds.len())),
                4 if !world.runs.is_empty() => world.end_run(dice.roll(world.runs.len())),
                5 if world.lands.iter().any(|land| land.2 == Pushed::NotYet) => world.push(0),
                6 if world.lands.iter().any(|land| land.2 != Pushed::NotYet) => {
                    world.answer_land(0)
                }
                7 if outside < 2 => {
                    outside += 1;
                    world.outside_push(&format!("x{outside}"));
                }
                8 => world.read_base(),
                _ => {}
            }
            world.check();
        }
        for _ in 0..20 {
            world.read_base();
            world.settle();
            world.pass(WINDOW);
        }
        world.settle();
        world.check();
        assert!(
            world.queue.is_empty(),
            "seed {seed}: the queue did not drain"
        );
        for goal in [0, 1] {
            let order: Vec<u32> = world
                .main
                .iter()
                .filter_map(|sha| sha.strip_prefix('e')?.parse().ok())
                .filter(|number: &u32| number % 2 == goal)
                .collect();
            assert!(
                order.is_sorted(),
                "seed {seed}: a goal landed out of order: {:?}",
                world.main
            );
        }
        for number in 1..=ids.len() {
            let sha = format!("e{number}");
            let ends = [
                world.landed.contains(&sha),
                world.failed.iter().any(|(failed, _)| *failed == sha),
                removed.contains(&sha),
            ];
            assert_eq!(
                ends.iter().filter(|end| **end).count(),
                1,
                "seed {seed}: {sha} landed, failed, withdrawn: {ends:?}"
            );
            assert_eq!(world.main.contains(&sha), ends[0], "seed {seed}: {sha}");
        }
    }
}
