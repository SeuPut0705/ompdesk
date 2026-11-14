//! The release gates the board shows (`Snapshot.gates`), read from the runs the poller sees and the answers the hub
//! wrote. A run of the release lane that the hub started carries its gate (`Run.gate`); the newest such run of a
//! repository's ref and gate decides it. Pure: the hub calls it at every change of its runs or answers.

use std::collections::BTreeMap;

use super::contract::{
    Gate, GateStatus, GateVerdict, JobSelector, JobState, Lane, Run, RunResult, RunVerdict,
};

/// A release as a person reads it: the repository's name, the ref and the commit (`app main@1a2b3c4`).
fn release_of(run: &Run) -> String {
    let name = run.repo.rsplit('/').next().unwrap_or(&run.repo);
    let sha = run.sha.get(..7).unwrap_or(&run.sha);
    format!("{name} {}@{sha}", run.git_ref)
}

/// When the run's jobs were first queued: a later run of the same gate replaces an earlier one.
fn queued(run: &Run) -> u64 {
    run.jobs.iter().map(|job| job.queued_at).min().unwrap_or(0)
}

fn state(run: &Run, answers: &[RunResult]) -> GateVerdict {
    if let Some(result) = answers.iter().rev().find(|result| result.run_id == run.id) {
        return match result.answer.verdict {
            super::contract::AnswerVerdict::Green if result.answer.blocks_release.is_none() => {
                GateVerdict::Green
            }
            super::contract::AnswerVerdict::Green | super::contract::AnswerVerdict::Red => {
                GateVerdict::Red
            }
            super::contract::AnswerVerdict::Unknown => GateVerdict::Waiting,
        };
    }
    match run.verdict {
        Some(RunVerdict::Red) => GateVerdict::Red,
        Some(RunVerdict::Green) => GateVerdict::Waiting,
        // A cancelled run decided nothing: the gate waits for the next.
        Some(RunVerdict::Cancelled) => GateVerdict::Waiting,
        None if run.jobs.iter().any(|job| job.state == JobState::Running) => GateVerdict::Running,
        None => GateVerdict::Waiting,
    }
}

/// Every gate of a release run, in the order the runs came; `workflow_of` names a run's workflow file (the hub's own
/// record), and a run it does not know has no gate on the board.
pub fn gates(
    runs: &[Run],
    answers: &[RunResult],
    workflow_of: impl Fn(&str) -> Option<String>,
) -> Vec<GateStatus> {
    let mut newest: BTreeMap<(&str, &str, &str), &Run> = BTreeMap::new();
    let mut order = Vec::new();
    for run in runs.iter().filter(|run| run.lane == Lane::Release) {
        let Some(gate) = run.gate.as_deref() else {
            continue;
        };
        let key = (run.repo.as_str(), run.git_ref.as_str(), gate);
        match newest.get(&key) {
            Some(kept) if queued(kept) > queued(run) => {}
            Some(_) => {
                newest.insert(key, run);
            }
            None => {
                order.push(key);
                newest.insert(key, run);
            }
        }
    }
    order
        .into_iter()
        .filter_map(|key| {
            let run = newest[&key];
            Some(GateStatus {
                gate: Gate {
                    id: key.2.to_owned(),
                    release: release_of(run),
                    jobs: JobSelector {
                        workflow: workflow_of(&run.id)?,
                        jobs: Vec::new(),
                    },
                    required: true,
                },
                state: state(run, answers),
                run: Some(run.id.clone()),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checks::contract::{BlocksRelease, Job, Origin, Trigger, samples};

    fn job(state: JobState, queued_at: u64) -> Job {
        Job {
            id: format!("j{queued_at}"),
            name: "check".into(),
            os: crate::checks::contract::Os::Linux,
            pool: "github-linux".into(),
            state,
            queued_at,
            started_at: None,
            ended_at: None,
            billed_min: None,
        }
    }

    fn run(
        id: &str,
        lane: Lane,
        gate: Option<&str>,
        jobs: Vec<Job>,
        verdict: Option<RunVerdict>,
    ) -> Run {
        Run {
            id: id.into(),
            repo: "o/app".into(),
            git_ref: "main".into(),
            sha: "0123456789abcdef".into(),
            lane,
            trigger: Trigger::Dispatch,
            origin: Origin::Person,
            gate: gate.map(Into::into),
            jobs,
            verdict,
            reused_from: None,
            superseded_by: None,
            digest: String::new(),
        }
    }

    fn ci(_: &str) -> Option<String> {
        Some("ci.yml".into())
    }

    #[test]
    fn the_newest_release_run_of_a_gate_decides_it_and_other_lanes_have_none() {
        let runs = vec![
            run(
                "old",
                Lane::Release,
                Some("release ci.yml"),
                vec![job(JobState::Failed, 10)],
                Some(RunVerdict::Red),
            ),
            run(
                "new",
                Lane::Release,
                Some("release ci.yml"),
                vec![job(JobState::Running, 20)],
                None,
            ),
            run(
                "branch",
                Lane::Branch,
                None,
                vec![job(JobState::Running, 30)],
                None,
            ),
            run(
                "person",
                Lane::Release,
                None,
                vec![job(JobState::Running, 40)],
                None,
            ),
        ];
        let gates = gates(&runs, &[], ci);
        assert_eq!(gates.len(), 1);
        assert_eq!(gates[0].run.as_deref(), Some("new"));
        assert_eq!(gates[0].state, GateVerdict::Running);
        assert_eq!(gates[0].gate.id, "release ci.yml");
        assert_eq!(gates[0].gate.release, "app main@0123456");
        assert_eq!(gates[0].gate.jobs.workflow, "ci.yml");
        assert!(gates[0].gate.required);
    }

    #[test]
    fn a_green_run_whose_quarantined_test_failed_does_not_pass_the_gate() {
        let runs = vec![run(
            "r",
            Lane::Release,
            Some("release ci.yml"),
            vec![job(JobState::Passed, 1)],
            Some(RunVerdict::Green),
        )];
        assert_eq!(gates(&runs, &[], ci)[0].state, GateVerdict::Waiting);
        let mut blocked = samples::answer();
        blocked.blocks_release = Some(BlocksRelease {
            gate: "release ci.yml".into(),
        });
        let answers = vec![RunResult {
            run_id: "r".into(),
            origin: Origin::Person,
            answer: blocked,
        }];
        assert_eq!(gates(&runs, &answers, ci)[0].state, GateVerdict::Red);
        // A run whose workflow the hub does not know is not shown as a gate.
        assert!(gates(&runs, &answers, |_| None).is_empty());
    }

    #[test]
    fn an_unknown_answer_never_shows_a_previously_green_run_as_a_green_gate() {
        let runs = vec![run(
            "r",
            Lane::Release,
            Some("release ci.yml"),
            vec![job(JobState::Passed, 1)],
            Some(RunVerdict::Green),
        )];
        let mut unknown = samples::answer();
        unknown.verdict = crate::checks::contract::AnswerVerdict::Unknown;
        unknown.blocks_release = None;
        let answers = vec![RunResult {
            run_id: "r".into(),
            origin: Origin::Person,
            answer: unknown,
        }];
        assert_eq!(gates(&runs, &answers, ci)[0].state, GateVerdict::Waiting);
    }
}
