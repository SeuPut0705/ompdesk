//! Where a started check runs (design §5 policy 5, `place::place`): on this computer or a paired one through
//! `ompdesk check` when policy names a command a computer runs (`policy::local_command`), else through admission on a
//! GitHub runner.
//!
//! - This computer: the run goes to the hub's `LocalRunner` in a task of its own; its journal is claimed as the hub's
//!   run the moment `ompdesk check` names it, and its journal is the answer.
//! - A paired computer: the run goes to main as a `RemoteRun` (event `checks.remoteRun`), main asks that computer's
//!   hub over the link (`checks.runLocal`) and hands its answer back (`checks.remoteAnswer`).
//! - A run that could not start where it was placed (no git yet, a fetch or setup that failed, a link that is gone, a
//!   computer of an older build) goes through admission to a GitHub runner under the same id, so its waits go on, and
//!   the log says why. Placement that wants a computer for a check no command was named for says so the same way.

use super::super::contract::Os;
use super::super::{local_run, place};
use super::*;

impl Core {
    /// `pending`'s check where placement puts it. `local`: the command a computer runs instead, when policy names one.
    pub(super) async fn place_and_admit(
        &self,
        id: RunId,
        pending: Pending,
        lane: Lane,
        local: Option<Vec<String>>,
    ) -> Result<StartReply, Fault> {
        let macos = pending.plan.macos;
        // An unknown visibility reads as public, which sends the check where it would go anyway.
        let private = !macos && self.github.is_private(&pending.repo).await.unwrap_or(false);
        let placement = place::place(&place::Ask {
            os: if macos { Os::Macos } else { Os::Linux },
            private,
            runner: true,
            pools: &self.poller.local_pools(),
        });
        let Some(Where::Device { device_id }) = placement.place.clone() else {
            return self.admit_entry(id, pending, lane).await;
        };
        if let Some(argv) = local {
            return Ok(self.run_on(id, pending, lane, device_id, argv, &placement.reason));
        }
        let why = format!(
            "placement picked {device_id} ({}), but this check names no command a computer runs (`local` in {}, or a \
             `check` script for a branch check), so it runs on a GitHub runner",
            placement.reason,
            policy::REPO_FILE
        );
        let mut reply = self.admit_entry(id.clone(), pending, lane).await?;
        if reply.decision != StartDecision::Reused && reply.run_id.is_some() {
            self.unavailable(&id, &device_id, why.clone());
            reply.reason = format!("{}; {why}", reply.reason);
        }
        Ok(reply)
    }

    fn unavailable(&self, id: &str, device: &str, why: String) {
        self.decide(
            "local-first",
            id,
            PolicyAction::Place,
            why,
            DecisionWhy {
                pool: Some(super::super::poller::pools::device_id(device)),
                ..DecisionWhy::new(WhyCode::LocalUnavailable)
            },
        );
    }

    fn run_on(
        &self,
        id: RunId,
        pending: Pending,
        lane: Lane,
        device: DeviceId,
        argv: Vec<String>,
        reason: &str,
    ) -> StartReply {
        let ask = LocalRunAsk {
            repo: pending.repo.clone(),
            sha: pending.sha.clone(),
            argv,
            release: lane == Lane::Release,
        };
        let claim = Claim {
            run_id: id.clone(),
            origin: pending.origin.clone(),
            lane,
            gate: pending.gate.clone(),
            digest: pending.digest.clone(),
        };
        {
            let mut book = locked(&self.book);
            book.pending.insert(id.clone(), pending.clone());
            book.away
                .insert(id.clone(), (pending, lane, device.clone()));
        }
        let command = ask.argv.join(" ");
        self.decide(
            "local-first",
            &id,
            PolicyAction::Place,
            format!("runs `{command}` on {device}: {reason}"),
            DecisionWhy {
                pool: Some(super::super::poller::pools::device_id(&device)),
                ..DecisionWhy::new(WhyCode::PlacedOn)
            },
        );
        let reply = StartReply {
            run_id: Some(id.clone()),
            decision: StartDecision::Started,
            placement: Some(Where::Device {
                device_id: device.clone(),
            }),
            expected_start_min: None,
            reason: format!("runs `{command}` on {device} with ompdesk check: {reason}"),
        };
        let Some(core) = self.me.upgrade() else {
            return reply;
        };
        if device == "local" {
            tokio::spawn(async move {
                let poller = Arc::clone(&core.poller);
                let ran = core
                    .runner
                    .run(
                        &ask,
                        Box::new(move |journal| poller.claim_local(journal, claim)),
                        Scope::detached(),
                    )
                    .await;
                match ran {
                    Ok(run) => {
                        if core.back(&id).is_some() {
                            let os = super::super::poller::local::this_os();
                            let answer = local_run::answer_of(
                                &id,
                                &run,
                                &device,
                                &ask.argv,
                                os,
                                clock::now_ms(),
                            );
                            core.finish(&id, answer);
                        }
                    }
                    Err(why) => core.fall_back(id, why).await,
                }
            });
        } else if self
            .remote
            .send(RemoteRun {
                id: id.clone(),
                device: device.clone(),
                ask,
            })
            .is_err()
        {
            tokio::spawn(async move {
                core.fall_back(id, format!("no link reaches {device}"))
                    .await;
            });
        }
        reply
    }

    /// Takes a run back from the computer it was placed on; None once it was answered or went to GitHub.
    fn back(&self, id: &str) -> Option<(Pending, Lane, DeviceId)> {
        locked(&self.book).away.remove(id)
    }

    /// A run that could not start where it was placed goes to a GitHub runner under the same id.
    async fn fall_back(&self, id: RunId, why: String) {
        let Some((pending, lane, device)) = self.back(&id) else {
            return;
        };
        self.unavailable(
            &id,
            &device,
            format!("{device} could not run it ({why}), so it runs on a GitHub runner"),
        );
        if let Err(fault) = self.admit_entry(id.clone(), pending, lane).await {
            let note = Note {
                error: Some(fault.message),
                ..Note::new(NoteCode::DispatchFailed)
            };
            self.finish(&id, answer::unknown(&id, clock::now_ms(), Next::Wait, note));
        }
    }

    /// What a paired computer answered for a run placed on it, or why it gave none.
    pub(super) async fn remote_answer(&self, id: RunId, answer: Result<Answer, String>) {
        let mut answer = match answer {
            Ok(answer) => answer,
            Err(why) => return self.fall_back(id, why).await,
        };
        let Some((_, _, device)) = self.back(&id) else {
            return;
        };
        // That computer answered as itself (`local`); here it is the computer the run was placed on.
        for note in &mut answer.said {
            if note.code == NoteCode::RanOn {
                note.device = Some(device.clone());
            }
        }
        answer.notes = super::super::note::english_of(&answer.said);
        answer.run_id = id.clone();
        self.finish(&id, answer);
    }

    /// `checks.runLocal`: a check another hub placed on this computer.
    pub(super) async fn run_here(&self, ask: LocalRunAsk, scope: Scope) -> Result<Answer, Fault> {
        let run = self
            .runner
            .run(&ask, Box::new(|_| {}), scope)
            .await
            .map_err(|why| Fault::new("local_run", why))?;
        let os = super::super::poller::local::this_os();
        Ok(local_run::answer_of(
            &run.id,
            &run,
            &"local".to_owned(),
            &ask.argv,
            os,
            clock::now_ms(),
        ))
    }

    /// How git runs now (main's `gitRunner`), and the environment a check this hub starts runs with.
    pub(crate) fn git_runner(&self) -> Option<Runner> {
        locked(&self.git).clone()
    }

    /// Where the hub keeps what lives on disk: its state folder, else (a test's hub) its queue's own folder.
    pub(crate) fn work_dir(&self) -> PathBuf {
        self.dir.clone().unwrap_or_else(|| self.queue_dir.clone())
    }
}
