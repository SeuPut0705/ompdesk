use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::mpsc;

use super::accounts::Accounts;
use crate::machine;
use crate::routines::runtime::{
    Activity, GithubTool, Mailbox, Outcome, Services, SessionNotice, SessionSubscription,
    SessionTab, ToolRunner,
};
use crate::server::Fault;

pub struct Sources {
    machine: Arc<machine::Service>,
    accounts: Arc<Accounts>,
    sessions: Arc<SessionFeed>,
}

impl Sources {
    pub fn new(
        machine: Arc<machine::Service>,
        accounts: Arc<Accounts>,
        sessions: Arc<SessionFeed>,
    ) -> Self {
        Self {
            machine,
            accounts,
            sessions,
        }
    }
}

impl Services for Sources {
    async fn git(&self) -> Result<ToolRunner, Fault> {
        self.machine.git_runner().await
    }

    async fn github(&self) -> Result<GithubTool, Fault> {
        Ok(GithubTool {
            runner: self.machine.gh_runner().await?,
            home: self.machine.config().home.clone(),
        })
    }

    fn sessions(&self) -> Result<SessionSubscription, Fault> {
        self.sessions.subscribe()
    }

    async fn mailbox(&self, name: &str) -> Result<Option<Mailbox>, Fault> {
        self.accounts.mailbox(name).await
    }
}

struct Subscribers {
    next: u64,
    senders: HashMap<u64, mpsc::UnboundedSender<SessionNotice>>,
}

pub struct SessionFeed {
    subscribers: Mutex<Option<Subscribers>>,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn closed() -> Fault {
    Fault::new(
        "routine_sessions_closed",
        "The native session feed is closed",
    )
}

fn shape(field: &str) -> Fault {
    Fault::new(
        "routine_session_snapshot",
        format!("The native session announcement has no valid {field}"),
    )
}

fn text(value: &Value, field: &str) -> Result<String, Fault> {
    value[field]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| shape(field))
}

fn optional_text(value: &Value, field: &str) -> Result<Option<String>, Fault> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok((!text.is_empty()).then(|| text.clone())),
        Some(_) => Err(shape(field)),
    }
}

fn activity(value: &Value) -> Result<Option<Activity>, Fault> {
    let kind = value["type"].as_str().ok_or_else(|| shape("type"))?;
    if matches!(kind, "step" | "askClosed") {
        return Ok(None);
    }
    let tab_id = text(value, "tabId")?;
    Ok(Some(match kind {
        "busy" => Activity::Busy { tab_id },
        "released" => Activity::Released { tab_id },
        "idle" => Activity::Idle {
            tab_id,
            outcome: match value.get("outcome") {
                None | Some(Value::Null) => None,
                Some(outcome) => Some(Outcome {
                    stop_reason: text(outcome, "stopReason")?,
                    error_message: optional_text(outcome, "errorMessage")?,
                }),
            },
        },
        "ask" => Activity::Ask {
            tab_id,
            request_id: text(value, "requestId")?,
            text: text(value, "text")?,
        },
        _ => return Err(shape("type")),
    }))
}

fn tabs(value: &Value) -> Result<Vec<SessionTab>, Fault> {
    let rows = value.as_array().ok_or_else(|| shape("tabs"))?;
    let mut tabs = Vec::with_capacity(rows.len());
    for row in rows {
        // resumeFacts excludes hosted views. A row without a live sidecar has no authoritative cwd.
        if row["hosted"] == true || row.get("sidecar").is_none_or(Value::is_null) {
            continue;
        }
        tabs.push(SessionTab {
            tab_id: text(row, "tab")?,
            cwd: text(&row["sidecar"], "cwd")?,
            title: text(&row["facts"], "title")?,
            session_file: optional_text(row, "sessionFile")?,
            device: optional_text(row, "device")?,
            opened_by: optional_text(row, "openedBy")?,
            opened_by_session: optional_text(row, "openedBySession")?,
        });
    }
    Ok(tabs)
}

impl SessionFeed {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            subscribers: Mutex::new(Some(Subscribers {
                next: 0,
                senders: HashMap::new(),
            })),
        })
    }

    pub fn subscribe(self: &Arc<Self>) -> Result<SessionSubscription, Fault> {
        let mut state = locked(&self.subscribers);
        let state = state.as_mut().ok_or_else(closed)?;
        let id = state.next;
        state.next = id.checked_add(1).ok_or_else(closed)?;
        let (sender, receiver) = mpsc::unbounded_channel();
        state.senders.insert(id, sender);
        let feed = Arc::downgrade(self);
        Ok(SessionSubscription::new(
            receiver,
            Arc::new(move || {
                if let Some(feed) = feed.upgrade()
                    && let Some(state) = locked(&feed.subscribers).as_mut()
                {
                    state.senders.remove(&id);
                }
            }),
        ))
    }

    /// Both values must come from the same PoolHost::announce tick, never a later pool snapshot.
    pub fn publish(&self, activity_value: Value, tabs_value: Value) -> Result<(), Fault> {
        let mut state = locked(&self.subscribers);
        let state = state.as_mut().ok_or_else(closed)?;
        state.senders.retain(|_, sender| !sender.is_closed());
        if state.senders.is_empty() {
            return Ok(());
        }
        let Some(activity) = activity(&activity_value)? else {
            return Ok(());
        };
        let notice = SessionNotice {
            activity,
            tabs: tabs(&tabs_value)?,
        };
        let mut senders = state.senders.values();
        if let Some(mut sender) = senders.next() {
            for next in senders {
                let _ = sender.send(SessionNotice {
                    activity: notice.activity.clone(),
                    tabs: notice.tabs.clone(),
                });
                sender = next;
            }
            // A concurrently dropped subscription does not fail another subscriber's announcement.
            let _ = sender.send(notice);
        }
        Ok(())
    }

    pub fn close(&self) {
        locked(&self.subscribers).take();
    }
}

#[cfg(test)]
#[path = "routine_sources_tests.rs"]
mod tests;
