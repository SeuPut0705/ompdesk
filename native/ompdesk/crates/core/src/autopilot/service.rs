//! Native application entry. This owns no second coordinator, retry timer, ship worker, or session ledger.

use std::sync::Arc;

use ompdesk_app_contract::Owner;
use serde_json::{Value, json};
use tokio::sync::{Mutex, oneshot};

use super::approval::{self, Card, Role};
use super::coordinator::{CommandParams, Contracts, Coordinator, Msg, locked};
use super::host::{Backend, Host, Native};
use super::run::Run;
use super::ship::Fut;
use super::util::{flag, text};
use super::{Tuning, now_ms};
use crate::server::Fault;

pub struct Config {
    pub contracts: Contracts,
    pub tuning: Tuning,
    /// Shared page/bridge contract values handed in by native bootstrap, not page arguments.
    pub quota_fallback_ms: f64,
    pub status_cycles: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Lifecycle {
    Open,
    Closing,
    Closed,
}

pub struct Service {
    coordinator: Arc<Coordinator>,
    host: Arc<dyn Host>,
    status_cycles: usize,
    lifecycle: std::sync::Mutex<Lifecycle>,
    close_gate: Mutex<()>,
}

impl Service {
    pub fn new(host: Arc<dyn Host>, config: Config) -> Arc<Self> {
        Arc::new(Self {
            coordinator: Coordinator::new(
                Arc::new(Backend::Native(Native {
                    host: host.clone(),
                    quota_fallback_ms: config.quota_fallback_ms,
                    closing: std::sync::atomic::AtomicBool::new(false),
                })),
                config.contracts,
                config.tuning,
                false,
            ),
            host,
            status_cycles: config.status_cycles,
            lifecycle: std::sync::Mutex::new(Lifecycle::Open),
            close_gate: Mutex::new(()),
        })
    }

    /// Admission and enqueue happen before returning the future, preserving the originating native caller's order.
    /// `source` resolves the real tab and checks caller ownership; none of its fields come from `command`.
    pub fn command(
        self: &Arc<Self>,
        owner: Owner,
        tab: String,
        command: Value,
    ) -> Fut<Result<Value, Fault>> {
        if *locked(&self.lifecycle) != Lifecycle::Open {
            return Box::pin(async { Err(closed()) });
        }
        let source = match self.host.source(&owner, &tab) {
            Ok(source) => source,
            Err(error) => return Box::pin(async move { Err(error) }),
        };
        let all_cycles =
            text(&command, "type") == Some("get_autopilot") && flag(&command, "allCycles");
        let (reply, response) = oneshot::channel();
        let params = CommandParams {
            call: 0,
            tab: tab.clone(),
            command,
            source,
            today: self.host.today(),
            now: Some(now_ms()),
            native_owner: Some(owner),
        };
        let sent = self.send(Msg::Command { params, reply });
        let this = self.clone();
        Box::pin(async move {
            sent?;
            let answer = received(response).await?;
            checked(&answer)?;
            let tab = text(&answer, "tabId").unwrap_or(&tab).to_owned();
            let status = answer.get("status").cloned().unwrap_or(Value::Null);
            let mut status = this
                .overlay_status(&tab, status, flag(&answer, "overlay"), all_cycles)
                .await;
            if answer.get("tabId").is_some() {
                status["tabId"] = json!(tab);
            }
            Ok(status)
        })
    }

    pub fn is_stopping(&self, tab: &str) -> bool {
        self.coordinator
            .runs_get(tab)
            .is_some_and(|run| run.lock().stopping)
    }

    pub fn run_root_of(&self, tab: &str) -> Option<String> {
        let parent = locked(&self.coordinator.child_runs)
            .get(tab)
            .map(|child| child.parent.clone());
        self.coordinator
            .runs_get(parent.as_deref().unwrap_or(tab))
            .map(|run| run.lock().root.clone())
    }

    pub fn holds_limit_wait(&self, tab: &str) -> bool {
        self.coordinator.runs_get(tab).is_some()
    }

    /// Called by the actual sidecar lane, not by an external page command.
    pub fn frame(&self, tab: &str, frame: Value) -> Result<(), Fault> {
        match text(&frame, "type") {
            Some(
                "autopilot_cycle_end"
                | "autopilot_nudge"
                | "autopilot_stop_requested"
                | "autopilot_settled",
            ) => self.send(Msg::Frame {
                tab: tab.to_owned(),
                frame,
            }),
            _ => Err(Fault::new(
                "invalid_frame",
                "Not an Autopilot lifecycle frame",
            )),
        }
    }

    pub fn ready(&self, tab: &str) -> Result<(), Fault> {
        self.send(Msg::Ready {
            tab: tab.to_owned(),
        })
    }
    pub fn released(&self, tab: &str) -> Result<(), Fault> {
        self.send(Msg::Released {
            tab: tab.to_owned(),
        })
    }
    pub fn idle_error(&self, tab: &str, message: Option<&str>) -> Result<(), Fault> {
        if !self.holds_limit_wait(tab) {
            return Ok(());
        }
        self.send(Msg::Activity {
            tab: tab.to_owned(),
            kind: if crate::resume::is_limit_wording(message) {
                "limit"
            } else {
                "error"
            }
            .into(),
        })
    }
    pub fn resume_settled(&self, tab: &str, outcome: &str) -> Result<(), Fault> {
        self.send(Msg::ResumeSettled {
            tab: tab.to_owned(),
            outcome: outcome.to_owned(),
        })
    }

    pub async fn aborted(&self, tab: &str) -> Result<(), Fault> {
        let (reply, response) = oneshot::channel();
        self.send(Msg::Aborted {
            tab: tab.to_owned(),
            reply,
        })?;
        checked(&received(response).await?)
    }
    pub async fn resume_goal(&self, tab: &str) -> Result<(), Fault> {
        let (reply, response) = oneshot::channel();
        self.send(Msg::ResumeGoal {
            tab: tab.to_owned(),
            reply,
        })?;
        checked(&received(response).await?)
    }
    pub async fn before_first_prompt(
        &self,
        tab: &str,
        parent: &str,
        worktree: Option<Value>,
        tag: Option<&str>,
    ) -> Result<(), Fault> {
        let (reply, response) = oneshot::channel();
        let mut child = json!({"tabId":tab,"callerTabId":parent});
        if let Some(worktree) = worktree {
            child["worktree"] = worktree;
        }
        if let Some(tag) = tag {
            child["tag"] = json!(tag);
        }
        self.send(Msg::BeforeFirstPrompt { child, reply })?;
        checked(&received(response).await?)
    }

    /// Enriches a lane's whole bridge status before it is sent to windows, devices, or the paired phone.
    pub async fn overlay_frame(&self, tab: &str, mut frame: Value) -> Result<Value, Fault> {
        if text(&frame, "type") != Some("autopilot_update") {
            return Ok(frame);
        }
        let Some(status) = frame
            .get("status")
            .filter(|status| flag(status, "active"))
            .cloned()
        else {
            return Ok(frame);
        };
        self.send(Msg::Status {
            tab: tab.to_owned(),
            status: status.clone(),
        })?;
        frame["status"] = self.overlay_status(tab, status, true, false).await;
        Ok(frame)
    }

    async fn overlay_status(
        &self,
        tab: &str,
        mut status: Value,
        overlay: bool,
        all_cycles: bool,
    ) -> Value {
        if let Some(run) = overlay.then(|| self.coordinator.runs_get(tab)).flatten() {
            let (policy, procedure, blocked, landing, end_after_ship, children, stalls) = {
                let state = run.lock();
                (
                    state.settings.ship().clone(),
                    state.release_procedure.clone(),
                    state.release_blocked.clone(),
                    state.landing.clone(),
                    state.end_after_ship.is_some(),
                    state.children.clone(),
                    state.stalls.clone(),
                )
            };
            let mut ship = status
                .get("ship")
                .filter(|ship| ship.is_object())
                .cloned()
                .unwrap_or_else(|| json!({"policy":policy,"queue":[]}));
            ship["queue"] = json!(run.ship.queue());
            if let Some(procedure) = procedure {
                ship["releaseProcedure"] = procedure;
            } else if let Some(blocked) = blocked {
                ship["releaseBlocked"] = json!(blocked);
            }
            if let Some(landing) = landing {
                ship["landing"] = landing;
            }
            if end_after_ship {
                ship["endAfterShip"] = json!(true);
            }
            status["ship"] = ship;
            let mut live = Vec::with_capacity(children.len());
            for child in children {
                let busy = self
                    .coordinator
                    .facts(&child.tab)
                    .await
                    .is_some_and(|facts| facts.busy);
                let mut item =
                    json!({"tabId":child.tab,"status":if busy {"running"} else {"done"}});
                if let Some(area) = child.area {
                    item["area"] = json!(area);
                }
                if let Some(branch) = child.branch {
                    item["branch"] = json!(branch);
                }
                live.push(item);
            }
            status["children"] = json!(live);
            if !stalls.is_empty() {
                status["stalls"] = json!(stalls);
            }
        }
        if !all_cycles {
            recent_cycles(&mut status, self.status_cycles);
        }
        status
    }

    fn approval_run(&self, tab: &str) -> Option<(Role, Arc<Run>)> {
        if let Some(run) = self.coordinator.runs_get(tab) {
            return Some((Role::Parent, run));
        }
        let parent = locked(&self.coordinator.child_runs)
            .get(tab)?
            .parent
            .clone();
        Some((Role::Child, self.coordinator.runs_get(&parent)?))
    }

    /// Returns immediately whether this run took the card; the tracked native send does not block the lane reader.
    pub fn extension_ui(self: &Arc<Self>, tab: &str, request: Value) -> bool {
        let lifecycle = locked(&self.lifecycle);
        if *lifecycle != Lifecycle::Open {
            return false;
        }
        let Some((role, run)) = self.approval_run(tab) else {
            return false;
        };
        let action = approval::classify(&request, role);
        if action == Card::Leave {
            return false;
        }
        let (this, tab) = (self.clone(), tab.to_owned());
        self.coordinator.track(async move {
            let response = match action {
                Card::Leave => unreachable!("a card left with its owner is not queued"),
                Card::Answer(response) => response,
                Card::Check { once, text: card } => {
                    let checked = this
                        .coordinator
                        .bridge(
                            &tab,
                            &this.coordinator.contracts.bridge.approval,
                            json!({"text":card}),
                            None,
                        )
                        .await;
                    let reason = match checked {
                        Ok(value) => match value.get("reason") {
                            Some(Value::Null) => None,
                            Some(Value::String(reason)) => Some(reason.clone()),
                            _ => Some("The approval guard returned no decision".into()),
                        },
                        Err(error) => Some(format!(
                            "The approval guard could not answer: {}",
                            error.message
                        )),
                    };
                    let current = this
                        .approval_run(&tab)
                        .is_some_and(|(now, current)| now == role && current.same(&run));
                    let reason = if current {
                        reason
                    } else {
                        Some("The Autopilot run ended before approval".into())
                    };
                    if let Some(reason) = &reason {
                        this.host.log(&format!("denied a card in {tab}: {reason}"));
                    }
                    approval::approval_response(&request, once, reason.as_deref())
                }
            };
            if let Some(id) = text(&request, "id") {
                if let Err(error) = this.coordinator.port.answer(&tab, id, response).await {
                    this.host
                        .log(&format!("approval answer in {tab}: {}", error.message));
                }
            }
        });
        true
    }

    pub async fn idle(&self) {
        self.coordinator.idle().await;
    }

    /// Called during native shutdown after admission is closed. The journal remains resumable; the old run's
    /// timers and child ownership are removed through the same release path as a real tab close.
    pub async fn close(&self) -> Result<(), Fault> {
        let _gate = self.close_gate.lock().await;
        {
            let mut lifecycle = locked(&self.lifecycle);
            if *lifecycle == Lifecycle::Closed {
                return Ok(());
            }
            *lifecycle = Lifecycle::Closing;
        }
        let (reply, response) = oneshot::channel();
        self.coordinator
            .inbox
            .send(Msg::Close { reply })
            .map_err(|_| closed())?;
        checked(&received(response).await?)?;
        *locked(&self.lifecycle) = Lifecycle::Closed;
        Ok(())
    }

    fn send(&self, message: Msg) -> Result<(), Fault> {
        let lifecycle = locked(&self.lifecycle);
        if *lifecycle != Lifecycle::Open {
            return Err(closed());
        }
        self.coordinator
            .inbox
            .send(message)
            .map_err(|_| Fault::new("autopilot_closed", "Autopilot is closed"))
    }
}

fn closed() -> Fault {
    Fault::new("autopilot_closed", "Autopilot is closed")
}

async fn received(response: oneshot::Receiver<Value>) -> Result<Value, Fault> {
    response
        .await
        .map_err(|_| Fault::new("autopilot_closed", "Autopilot ended before it answered"))
}
fn checked(answer: &Value) -> Result<(), Fault> {
    if flag(answer, "ok") {
        Ok(())
    } else {
        Err(Fault::new(
            text(answer, "code")
                .unwrap_or("autopilot_failed")
                .to_owned(),
            text(answer, "error").unwrap_or("Autopilot failed"),
        ))
    }
}
fn recent_cycles(status: &mut Value, keep: usize) {
    let Some(cycles) = status.get_mut("cycles").and_then(Value::as_array_mut) else {
        return;
    };
    if cycles.len() <= keep {
        return;
    }
    let count = cycles.len();
    cycles.drain(..count - keep);
    status["cycleCount"] = json!(count);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn long_status_frames_keep_the_newest_cycles_and_the_whole_count() {
        let mut status =
            json!({"active":true,"cycles":(1..=70).map(|n|json!({"n":n})).collect::<Vec<_>>()});
        recent_cycles(&mut status, 30);
        assert_eq!(status["cycleCount"], 70);
        assert_eq!(status["cycles"][0]["n"], 41);
        assert_eq!(status["cycles"][29]["n"], 70);
    }
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod native_tests;
