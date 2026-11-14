//! A session's own wake-up (`ompdesk_schedule` with `target: "self"`, run by `ScheduleService`): the schedule's prompt
//! reaches that session as a mail that starts a turn, through the outbox like every report (an omp that misses it
//! gets it again). Main reaches the session (`reach`: an asleep tab is started, a session no tab holds is opened in a
//! background tab of the front window, a failure fails the run); the core keeps the mail, hands it to the tab and then
//! follows the turn it started (or the one it joined): the run ends when that turn ends, with the turn's error if it
//! failed; a tab closed meanwhile, or no turn within `wake_turn_start_ms`, fails it. Main is told with `wakeDone`.

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use tokio::task::JoinHandle;

use super::activity::{Activity, ActivityKind};
use super::{Runtime, runtime_of};
use crate::agentctl::journal::Persistence;
use crate::agentctl::journal::mail_outbox::OutboxMail;
use crate::agentctl::rules::mail::{Mail, MailDelivery, MailKind, mail_details, mail_text};
use crate::agentctl::service::fail::{Fail, R, fail};
use crate::agentctl::service::host::HostState;
use crate::agentctl::service::types::DeviceState;
use crate::server::{Call, Fault, Registry, Reply, at_once};

/// A run waiting for the turn its wake-up mail starts.
pub struct Wake {
    session_path: String,
    started: bool,
    /// After the delivery any `idle` ends the turn the mail started or joined: a turn that starts and ends within one
    /// event batch is announced as `idle` alone, with no `busy` before it.
    delivered: bool,
    tab_id: Option<String>,
    /// The exit code a stopped run reports (`SUPERVISOR_STOPPED_CODE`).
    stopped_code: i64,
    timer: Option<JoinHandle<()>>,
}

impl Wake {
    pub fn cancel(self) {
        if let Some(timer) = self.timer {
            timer.abort();
        }
    }
}

/// The tab holding `session_path` on this computer (`pool.sessionOwner(path)?.tabId`).
fn owner_of<'a>(
    state: &'a HostState,
    session_path: &str,
) -> Option<&'a crate::agentctl::service::types::ControlTab> {
    state
        .tabs
        .iter()
        .find(|tab| tab.session_path.as_deref() == Some(session_path) && tab.device.is_none())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WakeParams {
    port: u64,
    run_id: String,
    session_path: String,
    /// The schedule's name with its prefix taken off ("Scheduled wake" when nothing is left).
    from_title: String,
    /// The schedule's prompt.
    text: String,
    stopped_code: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MailRecipient {
    pub session_path: String,
    pub device: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnqueueParams {
    port: u64,
    delivery_id: String,
    tab_id: String,
    from_title: String,
    text: String,
    expected: MailRecipient,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopParams {
    port: u64,
    run_id: String,
}

impl Runtime {
    /// Transfers one stable source delivery into the outbox, not into model-consumed context.
    pub(crate) fn enqueue_mail(
        self: &Arc<Self>,
        delivery_id: &str,
        tab_id: &str,
        from_title: &str,
        text: &str,
        expected: &MailRecipient,
    ) -> R<Persistence> {
        if delivery_id.is_empty() {
            return fail("A durable mail delivery needs its source id.");
        }
        let state = self.host().state();
        if !state.enabled {
            return fail("OMPdesk control tools are disabled.");
        }
        let target = state
            .tabs
            .iter()
            .find(|tab| tab.tab_id == tab_id)
            .ok_or_else(|| Fail::other("The resolved mail target is no longer open."))?;
        let path = target
            .session_path
            .as_deref()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| Fail::other("The resolved mail target has no saved session path."))?;
        let device = target.device.as_deref().filter(|device| !device.is_empty());
        if path != expected.session_path
            || device
                != expected
                    .device
                    .as_deref()
                    .filter(|device| !device.is_empty())
        {
            return fail("The resolved mail recipient changed before acceptance.");
        }
        if target.hidden || state.deleted_at_path(path, device).is_some() {
            return fail("The resolved mail recipient is hidden or deleted.");
        }
        if let Some(device) = device
            && !state
                .device(device)
                .is_some_and(|peer| peer.state == DeviceState::Online)
        {
            return fail("The resolved mail recipient is offline or no longer paired.");
        }
        let outbox = self
            .host()
            .outbox()
            .cloned()
            .ok_or_else(|| Fail::other("This runtime has no mail outbox."))?;
        let id = format!("system-{delivery_id}");
        let mail = Mail::new(
            &id,
            "ompdesk",
            from_title,
            tab_id,
            MailKind::Note,
            text,
            self.control.now(),
        );
        let delivery = MailDelivery {
            trigger_turn: true,
            aside: true,
        };
        let (content, details) = (mail_text(&mail), mail_details(&mail));
        let persistence = outbox
            .keep(OutboxMail {
                id: id.clone(),
                session_path: path.to_owned(),
                device: device.map(str::to_owned),
                from: None,
                from_device: None,
                content: content.clone(),
                details: details.clone(),
                delivery,
                attachments: None,
                attachments_corrupt: false,
                at: mail.at,
            })
            .map_err(Fail::other)?;
        if persistence == Persistence::Disk {
            let me = self.clone();
            let tab = tab_id.to_owned();
            tokio::spawn(async move {
                if let Ok(Some(answer)) = me
                    .host()
                    .send_mail(&tab, &content, &details, delivery)
                    .await
                    && answer.duplicate
                    && answer.journaled
                {
                    outbox.settle(&id);
                }
            });
        }
        Ok(persistence)
    }

    /// Delivers the wake-up of run `run_id` to the session `session_path` and follows its turn. Fails when the session
    /// cannot be reached (no window to open it in, the open failed): nothing is kept then.
    pub async fn wake(
        self: &Arc<Self>,
        run_id: &str,
        session_path: &str,
        from_title: &str,
        text: &str,
        stopped_code: i64,
    ) -> R<()> {
        // Watched from before the delivery, so a turn that starts and ends at once is never missed.
        {
            let state = self.host().state();
            let owner = owner_of(&state, session_path);
            self.rt().wakes.insert(
                run_id.to_owned(),
                Wake {
                    session_path: session_path.to_owned(),
                    started: owner.is_some_and(|tab| tab.busy),
                    delivered: false,
                    tab_id: owner.map(|tab| tab.tab_id.clone()),
                    stopped_code,
                    timer: None,
                },
            );
        }
        let reached = self.host().reach(session_path).await;
        let existing = match reached {
            Ok(tab) => tab,
            Err(error) => {
                if let Some(wake) = self.rt().wakes.remove(run_id) {
                    wake.cancel();
                }
                return Err(error);
            }
        };
        let id = format!("wake-{run_id}");
        let mut mail = Mail::new(
            &id,
            "ompdesk",
            from_title,
            existing.as_deref().unwrap_or(""),
            MailKind::Note,
            text,
            self.control.now(),
        );
        mail.instruction =
            Some("One of your routines started this turn: act on it now.".to_owned());
        let delivery = MailDelivery {
            trigger_turn: true,
            aside: true,
        };
        let (content, details) = (mail_text(&mail), mail_details(&mail));
        // Kept until the session's journal holds it, and sent to its tab when there is one; with none yet, or its omp
        // starting, the outbox pass sends it once the tab answers.
        let Some(outbox) = self.host().outbox().cloned() else {
            if let Some(wake) = self.rt().wakes.remove(run_id) {
                wake.cancel();
            }
            return fail("This runtime has no mail outbox.");
        };
        if let Err(error) = outbox.keep(OutboxMail {
            id: id.clone(),
            session_path: session_path.to_owned(),
            device: None,
            from: None,
            from_device: None,
            content: content.clone(),
            details: details.clone(),
            delivery,
            attachments: None,
            attachments_corrupt: false,
            at: mail.at,
        }) {
            if let Some(wake) = self.rt().wakes.remove(run_id) {
                wake.cancel();
            }
            return Err(Fail::other(error));
        }
        if let Some(tab) = existing {
            let (me, outbox) = (self.clone(), outbox);
            tokio::spawn(async move {
                if let Ok(Some(answer)) = me
                    .host()
                    .send_mail(&tab, &content, &details, delivery)
                    .await
                    && answer.duplicate
                    && answer.journaled
                {
                    outbox.settle(&id);
                }
            });
        }
        let state = self.host().state();
        let owner = owner_of(&state, session_path);
        let timer = {
            let (me, run) = (self.clone(), run_id.to_owned());
            let wait = Duration::from_millis(self.config.wake_turn_start_ms);
            tokio::spawn(async move {
                tokio::time::sleep(wait).await;
                let late = me.rt().wakes.get(&run).is_some_and(|wake| !wake.started);
                if late {
                    me.finish_wake(
                        &run,
                        None,
                        Some("The session started no turn on the wake-up within 2 minutes".into()),
                    );
                }
            })
        };
        let mut rt = self.rt();
        match rt.wakes.get_mut(run_id) {
            Some(wake) => {
                wake.delivered = true;
                if let Some(tab) = owner {
                    wake.tab_id = Some(tab.tab_id.clone());
                    if tab.busy {
                        wake.started = true;
                    }
                }
                wake.timer = Some(timer);
            }
            // The turn ended before the delivery returned: main was told already.
            None => timer.abort(),
        }
        Ok(())
    }

    /// Stops the run: the exit code a stopped run reports goes to main, and with it who held the session and whether
    /// its turn had started, so main can abort that turn.
    pub fn wake_stop(&self, run_id: &str) -> (Option<String>, bool) {
        let state = self.host().state();
        let (path, started) = {
            let rt = self.rt();
            match rt.wakes.get(run_id) {
                Some(wake) => (Some(wake.session_path.clone()), wake.started),
                None => (None, false),
            }
        };
        let holder = path
            .as_deref()
            .and_then(|path| owner_of(&state, path))
            .map(|tab| tab.tab_id.clone());
        let code = self.rt().wakes.get(run_id).map(|wake| wake.stopped_code);
        if let Some(code) = code {
            self.finish_wake(run_id, Some(code), None);
        }
        (holder, started)
    }

    /// Ends run `run_id`: main is told how.
    fn finish_wake(&self, run_id: &str, code: Option<i64>, error: Option<String>) {
        let Some(wake) = self.rt().wakes.remove(run_id) else {
            return;
        };
        wake.cancel();
        let mut done = json!({ "runId": run_id, "code": code });
        if let Some(error) = error {
            done["error"] = json!(error);
        }
        self.host().port().tell("wakeDone", &done);
    }

    /// A tab's activity, as every run waiting for its turn watches it.
    pub(super) fn wake_activity(&self, activity: &Activity) {
        let runs: Vec<String> = {
            let state = self.host().state();
            let mut rt = self.rt();
            if rt.wakes.is_empty() {
                return;
            }
            let mut watching = Vec::new();
            for (run, wake) in rt.wakes.iter_mut() {
                if let Some(tab) = owner_of(&state, &wake.session_path) {
                    wake.tab_id = Some(tab.tab_id.clone());
                }
                if wake.tab_id.as_deref() != Some(activity.tab_id.as_str()) {
                    continue;
                }
                if activity.kind == ActivityKind::Busy {
                    wake.started = true;
                }
                if matches!(activity.kind, ActivityKind::Released | ActivityKind::Idle) {
                    watching.push((run.clone(), wake.started || wake.delivered));
                }
            }
            watching
                .into_iter()
                .filter(|(_, turn)| activity.kind == ActivityKind::Released || *turn)
                .map(|(run, _)| run)
                .collect()
        };
        for run in runs {
            if activity.kind == ActivityKind::Released {
                self.finish_wake(
                    &run,
                    None,
                    Some("The session's tab closed before its turn ended".into()),
                );
                continue;
            }
            let outcome = activity.outcome.clone().unwrap_or_default();
            match outcome.stop_reason.as_deref() {
                Some("aborted") => {
                    let code = self.rt().wakes.get(&run).map(|wake| wake.stopped_code);
                    self.finish_wake(&run, code, None);
                }
                Some("error") => self.finish_wake(
                    &run,
                    None,
                    Some(
                        outcome
                            .error_message
                            .filter(|message| !message.is_empty())
                            .unwrap_or_else(|| "The turn ended with an error".into()),
                    ),
                ),
                _ => self.finish_wake(&run, Some(0), None),
            }
        }
    }
}

/// `agentRuntime.wake`: see `Runtime::wake`.
async fn wake_call(call: Call) -> Result<Reply, Fault> {
    let params: WakeParams = call.params()?;
    let runtime = runtime_of(params.port)?;
    match runtime
        .wake(
            &params.run_id,
            &params.session_path,
            &params.from_title,
            &params.text,
            params.stopped_code,
        )
        .await
    {
        Ok(()) => Reply::json(&()),
        Err(error) => Err(super::fault_of(&error)),
    }
}

fn enqueue_call(call: &Call) -> Result<Reply, Fault> {
    let params: EnqueueParams = call.params()?;
    let persistence = runtime_of(params.port)?
        .enqueue_mail(
            &params.delivery_id,
            &params.tab_id,
            &params.from_title,
            &params.text,
            &params.expected,
        )
        .map_err(|error| super::fault_of(&error))?;
    Reply::json(&json!({ "deliveryId": params.delivery_id, "persistence": persistence }))
}

/// `agentRuntime.wakeStop {port, runId}` → `{holder, started}`. Done as its line is read, after the activity before it.
fn wake_stop_call(call: &Call) -> Result<Reply, Fault> {
    let params: StopParams = call.params()?;
    let (holder, started) = runtime_of(params.port)?.wake_stop(&params.run_id);
    Reply::json(&json!({ "holder": holder, "started": started }))
}

pub fn register(registry: &mut Registry) {
    registry.add("agentRuntime.enqueueMail", |call| {
        at_once(enqueue_call(&call))
    });
    registry.add("agentRuntime.wake", |call| Box::pin(wake_call(call)));
    registry.add("agentRuntime.wakeStop", |call| {
        at_once(wake_stop_call(&call))
    });
}
