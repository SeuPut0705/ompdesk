//! A `ChecksHub` a test or the dev harness scripts (`checks.open {fake: true}`, driven by `checks.fake`): it decides
//! nothing and reads nothing. A start answers the next scripted reply (else `started` with a run id of its own), a
//! wait ends when a result is handed in for its run, `status` and `watch` show the snapshot last set, and every call
//! is kept for the test to read.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Notify, broadcast, watch};

use super::answer;
use super::contract::{
    Answer, LocalRunAsk, MainFact, Next, Note, NoteCode, Origin, RemoteRun, RunId, RunResult,
    Snapshot, StartDecision, StartReply, StartRequest, StatusRequest, Until, WAIT_DEFAULT_SECONDS,
    WaitRequest, Where,
};
use super::hub::{ChecksHub, Fut, RESULTS_KEPT, Runners};
use crate::clock;
use crate::server::{Fault, Scope};

/// What `checks.fake` takes. Read through `FakeOpWire` for the reason `MainFact` is (a snapshot holds numbers).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", try_from = "FakeOpWire")]
pub enum FakeOp {
    /// What `status` and `watch` show from now on.
    Snapshot { snapshot: Snapshot },
    /// What the next `start` answers.
    StartReply { reply: StartReply },
    /// A run's result arrived: its waits end and `checks.result` is sent.
    Finish { result: RunResult },
    /// Answers every call made so far (`FakeCall`), oldest first.
    Calls,
    /// A check placed on a paired computer: `checks.remoteRun` is sent.
    RemoteRun { run: RemoteRun },
}

/// `FakeOp` as it is read: one plain object, its fields by the op.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FakeOpWire {
    op: String,
    snapshot: Option<Snapshot>,
    reply: Option<StartReply>,
    result: Option<RunResult>,
    run: Option<RemoteRun>,
}

impl TryFrom<FakeOpWire> for FakeOp {
    type Error = String;
    fn try_from(wire: FakeOpWire) -> Result<FakeOp, String> {
        let missing = |field: &str| format!("checks.fake {} needs {field}", wire.op);
        Ok(match wire.op.as_str() {
            "snapshot" => FakeOp::Snapshot {
                snapshot: wire.snapshot.clone().ok_or_else(|| missing("snapshot"))?,
            },
            "startReply" => FakeOp::StartReply {
                reply: wire.reply.clone().ok_or_else(|| missing("reply"))?,
            },
            "finish" => FakeOp::Finish {
                result: wire.result.clone().ok_or_else(|| missing("result"))?,
            },
            "calls" => FakeOp::Calls,
            "remoteRun" => FakeOp::RemoteRun {
                run: wire.run.clone().ok_or_else(|| missing("run"))?,
            },
            other => return Err(format!("checks.fake has no op {other:?}")),
        })
    }
}

/// A call the fake hub got.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FakeCall {
    /// `start`, `wait`, `status`, `pause`, `told` (the request is the fact) or `runners` (the request says only
    /// which of gh and git came, never how they run).
    pub op: String,
    pub origin: Option<Origin>,
    pub request: Value,
}

#[derive(Default)]
struct State {
    replies: VecDeque<StartReply>,
    answers: HashMap<String, Answer>,
    calls: Vec<FakeCall>,
    started: u64,
    /// Grows with every `Snapshot` and `Finish`: what `until: any` waits on.
    changes: u64,
}

pub struct FakeHub {
    snapshot: watch::Sender<Arc<Snapshot>>,
    results: broadcast::Sender<RunResult>,
    remote: broadcast::Sender<RemoteRun>,
    state: Mutex<State>,
    changed: Notify,
}

impl Default for FakeHub {
    fn default() -> FakeHub {
        FakeHub {
            snapshot: watch::Sender::new(Arc::new(Snapshot::empty(clock::now_ms()))),
            results: broadcast::Sender::new(RESULTS_KEPT),
            remote: broadcast::Sender::new(RESULTS_KEPT),
            state: Mutex::default(),
            changed: Notify::new(),
        }
    }
}

impl FakeHub {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn called<T: Serialize>(&self, op: &str, origin: Option<&Origin>, request: &T) {
        self.state().calls.push(FakeCall {
            op: op.to_owned(),
            origin: origin.cloned(),
            request: serde_json::to_value(request).unwrap_or(Value::Null),
        });
    }

    /// One scripted step; what it answers (`Calls`: the calls, else null).
    pub fn apply(&self, op: FakeOp) -> Value {
        match op {
            FakeOp::Snapshot { snapshot } => {
                self.state().changes += 1;
                self.snapshot.send_replace(Arc::new(snapshot));
            }
            FakeOp::StartReply { reply } => {
                self.state().replies.push_back(reply);
                return Value::Null;
            }
            FakeOp::Finish { result } => {
                {
                    let mut state = self.state();
                    state.changes += 1;
                    state
                        .answers
                        .insert(result.run_id.clone(), result.answer.clone());
                }
                // Nobody listening is no failure.
                let _ = self.results.send(result);
            }
            FakeOp::Calls => return json!(self.state().calls),
            FakeOp::RemoteRun { run } => {
                let _ = self.remote.send(run);
                return Value::Null;
            }
        }
        self.changed.notify_waiters();
        Value::Null
    }
}

/// What a wait answers for a run with no result yet.
fn pending(run_id: &str, note: Note) -> Answer {
    answer::unknown(run_id, clock::now_ms(), Next::Wait, note)
}

impl ChecksHub for FakeHub {
    fn start(&self, origin: Origin, request: StartRequest) -> Fut<'_, Result<StartReply, Fault>> {
        Box::pin(async move {
            self.called("start", Some(&origin), &request);
            if self.snapshot.borrow().paused {
                return Ok(StartReply {
                    run_id: None,
                    decision: StartDecision::Refused,
                    placement: None,
                    expected_start_min: None,
                    reason: "paused by the owner".into(),
                });
            }
            let mut state = self.state();
            if let Some(reply) = state.replies.pop_front() {
                return Ok(reply);
            }
            state.started += 1;
            Ok(StartReply {
                run_id: Some(format!("fake-{}", state.started)),
                decision: StartDecision::Started,
                placement: Some(Where::GithubHosted),
                expected_start_min: Some(0),
                reason: "the fake hub starts everything".into(),
            })
        })
    }

    fn wait(
        &self,
        origin: Origin,
        request: WaitRequest,
        scope: Scope,
    ) -> Fut<'_, Result<Answer, Fault>> {
        Box::pin(async move {
            self.called("wait", Some(&origin), &request);
            let seconds = request.timeout_seconds.unwrap_or(WAIT_DEFAULT_SECONDS);
            let deadline = clock::now_ms().saturating_add(seconds.saturating_mul(1000));
            let before = self.state().changes;
            loop {
                // Made before the state is read, so a result handed in meanwhile still wakes this.
                let changed = self.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                {
                    let state = self.state();
                    if let Some(answer) = state.answers.get(&request.run_id) {
                        return Ok(answer.clone());
                    }
                    if request.until == Until::Any && state.changes > before {
                        return Ok(pending(&request.run_id, Note::new(NoteCode::RunChanged)));
                    }
                }
                let left = deadline.saturating_sub(clock::now_ms());
                if left == 0 {
                    return Ok(pending(
                        &request.run_id,
                        Note {
                            seconds: Some(seconds as u32),
                            ..Note::new(NoteCode::WaitTimedOut)
                        },
                    ));
                }
                tokio::select! {
                    () = &mut changed => {}
                    () = clock::sleep(Duration::from_millis(left)) => {}
                    () = scope.on_cancel() => return Err(Fault::cancelled()),
                }
            }
        })
    }

    fn status(&self, origin: Origin, request: StatusRequest) -> Fut<'_, Result<Snapshot, Fault>> {
        Box::pin(async move {
            self.called("status", Some(&origin), &request);
            Ok(Snapshot::clone(&self.snapshot.borrow()))
        })
    }

    fn watch(&self) -> watch::Receiver<Arc<Snapshot>> {
        self.snapshot.subscribe()
    }

    fn results(&self) -> broadcast::Receiver<RunResult> {
        self.results.subscribe()
    }

    fn pause(&self, paused: bool) -> Fut<'_, Result<(), Fault>> {
        Box::pin(async move {
            self.called("pause", None, &paused);
            let mut snapshot = Snapshot::clone(&self.snapshot.borrow());
            snapshot.paused = paused;
            self.state().changes += 1;
            self.snapshot.send_replace(Arc::new(snapshot));
            self.changed.notify_waiters();
            Ok(())
        })
    }

    fn told(&self, fact: MainFact) -> Fut<'_, Result<(), Fault>> {
        Box::pin(async move {
            self.called("told", None, &fact);
            Ok(())
        })
    }

    fn runners(&self, runners: Runners) -> Fut<'_, Result<(), Fault>> {
        Box::pin(async move {
            let came = json!({ "gh": runners.gh.is_some(), "git": runners.git.is_some() });
            self.called("runners", None, &came);
            Ok(())
        })
    }

    fn local_pool(&self) -> Fut<'_, Result<super::sources::LocalPool, Fault>> {
        Box::pin(async move {
            self.called("localPool", None, &Value::Null);
            Err(Fault::new(
                "not_built",
                "a scripted hub has no computer of its own",
            ))
        })
    }

    fn run_local(&self, ask: LocalRunAsk, _scope: Scope) -> Fut<'_, Result<Answer, Fault>> {
        Box::pin(async move {
            self.called("runLocal", None, &ask);
            Err(Fault::new(
                "not_built",
                "a scripted hub has no computer of its own",
            ))
        })
    }

    fn remote_runs(&self) -> broadcast::Receiver<RemoteRun> {
        self.remote.subscribe()
    }

    fn remote_answer(
        &self,
        id: RunId,
        answer: Result<Answer, String>,
    ) -> Fut<'_, Result<(), Fault>> {
        Box::pin(async move {
            let told = match answer {
                Ok(answer) => json!({"id": id, "answer": answer}),
                Err(error) => json!({"id": id, "error": error}),
            };
            self.called("remoteAnswer", None, &told);
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checks::contract::samples;

    #[tokio::test]
    async fn a_wait_ends_with_the_result_handed_in_for_its_run() {
        let hub = Arc::new(FakeHub::default());
        let mut results = hub.results();
        let waiting = {
            let hub = Arc::clone(&hub);
            tokio::spawn(async move {
                let request = WaitRequest {
                    run_id: "run-1".into(),
                    until: Until::Result,
                    timeout_seconds: Some(60),
                };
                hub.wait(samples::session(), request, Scope::detached())
                    .await
            })
        };
        // The wait is in: its call is recorded before it first sleeps.
        while hub.state().calls.is_empty() {
            tokio::task::yield_now().await;
        }
        let result = RunResult {
            run_id: "run-1".into(),
            origin: samples::session(),
            answer: samples::answer(),
        };
        hub.apply(FakeOp::Finish {
            result: result.clone(),
        });
        assert_eq!(waiting.await.unwrap().unwrap(), samples::answer());
        assert_eq!(results.recv().await.unwrap(), result);
    }

    #[tokio::test]
    async fn a_start_is_refused_while_the_owner_paused_admission() {
        let hub = FakeHub::default();
        hub.pause(true).await.unwrap();
        let request = StartRequest {
            purpose: crate::checks::contract::Purpose::Branch,
            scope: crate::checks::contract::StartScope::Changed,
            rerun: None,
            repo: None,
            git_ref: None,
            cwd: None,
            workflow: None,
        };
        let reply = hub.start(samples::session(), request).await.unwrap();
        assert_eq!(reply.decision, StartDecision::Refused);
        assert_eq!(reply.reason, "paused by the owner");
        assert!(hub.watch().borrow().paused);
    }
}
