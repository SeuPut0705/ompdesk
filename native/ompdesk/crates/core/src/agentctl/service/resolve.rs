//! How a name finds a session, and how a call reaches a paired computer (`service.ts`: `#find`, `#fateOf`,
//! `#storedSession`, `#liveTab`, `#resolveAny`, `#open`, `#joinStored`, `#join`, `#whenReady`, `#callerOf`,
//! `#device`, `#reach`, `#reachTab`, `#overLink`, `#sendTarget`, `#refuseHidden`, `#openedBy`, `#folderGone`,
//! `#refuseInUse`, `#openElsewhere`, `#devicesLine`). Shared by every family.
//!
//! A block that read the host's synchronous state in one go reads ONE `HostState` (`let state = self.host.state()`).

use std::collections::HashSet;
use std::time::Duration;

use serde_json::json;
use tokio::time::Instant;

use super::AgentControl;
use super::fail::{Fail, R, SavedFolder, fail, session_deleted};
use super::host::HostState;
use super::js::{len16, one_line, trim};
use super::text::{
    SESSION_PREFIX_MIN, StopFlags, TITLE_PREFIX_MIN, cleanup_of, in_use_refusal, label, named,
    open_in_text, saved_id_of_path, start_failure, stored_title, unquoted, unreached_text,
};
use super::types::{
    ControlDevice, ControlTab, DeviceState, SessionSummary, SpawnRequest, StoredSession, TabStatus,
    Target, hosted_summaries,
};
use crate::agentctl::journal::send_outbox::receiver_key;
use crate::agentctl::journal::session_fates::{FateState, FatedSession, SessionFate, fate_by};

/// Which computer a lookup is about: `None` any, `Some(None)` this one (`null`), `Some(Some(device))` that host.
pub type DeviceScope = Option<Option<ControlDevice>>;

/// What `find` came to: the session, or that it was deleted, and the devices whose saved lists could not be read.
#[derive(Debug, Default)]
pub struct Found {
    pub target: Option<Target>,
    pub gone: Option<SessionFate>,
    pub unreached: Vec<String>,
}

/// `open`'s options: `allow_self` is TypeScript's `self: false` (the caller itself may be the target), `reach: false`
/// does not wait for a paired device's tab to come back.
#[derive(Clone, Copy, Debug)]
pub struct OpenOptions {
    pub allow_self: bool,
    pub reach: bool,
}

impl Default for OpenOptions {
    fn default() -> Self {
        OpenOptions {
            allow_self: false,
            reach: true,
        }
    }
}

/// What a reopen or a send wanted when its saved session's folder is gone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wanted {
    Reopen,
    Send,
}

fn ms(ms: u64) -> Duration {
    Duration::from_millis(ms)
}

impl AgentControl {
    /// `#device`: `"local"` is this computer (None); a paired host by id or name, else a readable failure.
    pub fn device(&self, wanted: &str) -> R<Option<ControlDevice>> {
        let lowered = wanted.to_lowercase();
        if lowered == "local" || lowered == "this computer" {
            return Ok(None);
        }
        let state = self.host.state();
        let devices = &state.devices;
        let partial: Vec<&ControlDevice> = devices
            .iter()
            .filter(|device| device.name.to_lowercase().contains(&lowered))
            .collect();
        let found = devices
            .iter()
            .find(|device| device.id == wanted)
            .or_else(|| {
                devices
                    .iter()
                    .find(|device| device.name.to_lowercase() == lowered)
            })
            .or_else(|| {
                if partial.len() == 1 {
                    Some(partial[0])
                } else {
                    None
                }
            });
        match found {
            Some(device) => Ok(Some(device.clone())),
            None => fail(if devices.is_empty() {
                format!(
                    "No paired device \"{wanted}\": this computer has none (Settings › Devices pairs one)."
                )
            } else {
                format!(
                    "No paired device \"{wanted}\". Paired: {}; \"local\" is this computer.",
                    devices
                        .iter()
                        .map(|device| format!("{} ({})", device.name, device.id))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            }),
        }
    }

    /// `#reach`: a paired device once its link is up: waited for `link_wait_ms` while it connects or reconnects, so a
    /// blip never fails a call. A device that stays away fails with what to do.
    pub async fn reach(&self, device: ControlDevice) -> R<ControlDevice> {
        let deadline = Instant::now() + ms(self.tuning.link_wait_ms);
        let mut current = device.clone();
        while current.state != DeviceState::Online {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return fail(format!(
                    "{} is {} (waited {} s for its link). It has to be on, awake and on the tailnet (Settings › Devices); call again once ompdesk_sessions lists it online, or tell the user.",
                    current.name,
                    current.state.as_str(),
                    super::js::number(self.tuning.link_wait_ms as f64 / 1000.0)
                ));
            }
            let wait = left.as_millis().min(u128::from(self.tuning.link_poll_ms)) as u64;
            let id = device.id.clone();
            // A snapshot where it is online is seen even when it held only between two of main's pushes.
            let seen = self
                .host
                .wait_for(Some(wait), |state| {
                    state
                        .device(&id)
                        .filter(|d| d.state == DeviceState::Online)
                        .cloned()
                })
                .await;
            current = match seen {
                Some(online) => online,
                None => match self.host.state().device(&device.id) {
                    Some(now) => now.clone(),
                    None => {
                        return fail(format!(
                            "{} is no longer paired with this computer (Settings › Devices).",
                            device.name
                        ));
                    }
                },
            };
        }
        Ok(current)
    }

    /// `#reachTab`: a paired device's tab, once it can answer: while the device's link is down the tab reads
    /// `starting` (reconnecting) and refuses every command (`remote_offline`); back online it re-attaches. A local
    /// tab, and one whose device is online and settled, is returned as it is.
    pub async fn reach_tab(&self, tab: &ControlTab, caller_tab_id: &str) -> R<ControlTab> {
        let Some(device_id) = tab.device.as_deref() else {
            return Ok(tab.clone());
        };
        let Some(device) = self.host.state().device(device_id).cloned() else {
            return Ok(tab.clone());
        };
        let away = device.state != DeviceState::Online;
        if away {
            self.reach(device.clone()).await?;
        } else if tab.status != TabStatus::Error {
            return Ok(tab.clone());
        }
        // An `error` right after the link came back is the link's; one that stays is the host's own.
        let deadline = Instant::now() + ms(self.tuning.reattach_wait_ms);
        loop {
            let state = self.host.state();
            let now = state
                .tabs(caller_tab_id)
                .and_then(|tabs| tabs.into_iter().find(|entry| entry.tab_id == tab.tab_id));
            let Some(now) = now else {
                return fail(format!(
                    "{} was closed while {} reconnected.",
                    label(tab),
                    device.name
                ));
            };
            let settling = now.status == TabStatus::Error
                || (away
                    && matches!(
                        now.status,
                        TabStatus::Starting | TabStatus::Restarting | TabStatus::Waiting
                    ));
            let left = deadline.saturating_duration_since(Instant::now());
            if !settling || left.is_zero() {
                return Ok(now);
            }
            self.host
                .next_change(left.as_millis().min(u128::from(self.tuning.link_poll_ms)) as u64)
                .await;
        }
    }

    /// `#overLink`: a read from a paired device that a link drop cut short is made once more when the link is back
    /// (reads only: a prompt or an answer may have arrived before the drop, so those are never repeated).
    pub async fn over_link<T, F, Fut>(&self, device_id: Option<&str>, mut read: F) -> R<T>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = R<T>>,
    {
        match read().await {
            Ok(value) => Ok(value),
            Err(error) => {
                let device = device_id.and_then(|id| self.host.state().device(id).cloned());
                let Some(device) = device.filter(|_| error.has_code("remote_offline")) else {
                    return Err(error);
                };
                // The link's state turns a moment after the request failed.
                self.host.next_change(self.tuning.link_poll_ms).await;
                let now = self
                    .host
                    .state()
                    .device(&device.id)
                    .cloned()
                    .unwrap_or(device);
                self.reach(now).await?;
                read().await
            }
        }
    }

    /// `#devicesLine`.
    pub fn devices_line(&self, state: &HostState) -> String {
        if state.devices.is_empty() {
            return "No paired devices.".to_owned();
        }
        format!(
            "Paired devices: {}; \"local\" is this computer. A session open in a paired device's own window, or in another device's tab there, lists with scope app; message, answer or show it by its saved id and OMPdesk joins the tab that holds it (no second omp, not your child).",
            state
                .devices
                .iter()
                .map(|device| format!(
                    "{} (id {}, {})",
                    device.name,
                    device.id,
                    device.state.as_str()
                ))
                .collect::<Vec<_>>()
                .join("; ")
        )
    }

    /// `#openedBy`: tabs `caller_tab_id` opened: those this launch saw it open, and those whose opener main kept
    /// across a relaunch (`parentOf`), so ownership survives one. In the order they were first seen.
    pub fn opened_by(
        &self,
        state: &HostState,
        caller_tab_id: &str,
        tabs: &[ControlTab],
    ) -> Vec<String> {
        let live: HashSet<&str> = tabs.iter().map(|tab| tab.tab_id.as_str()).collect();
        let mut mem = self.mem();
        let set = mem.opened.entry(caller_tab_id.to_owned()).or_default();
        set.retain(|id| id.starts_with("pending:") || live.contains(id.as_str()));
        for tab in tabs {
            if tab.tab_id != caller_tab_id
                && state.parent_of(&tab.tab_id) == Some(caller_tab_id)
                && !set.contains(&tab.tab_id)
            {
                set.push(tab.tab_id.clone());
            }
        }
        set.clone()
    }

    /// `#refuseHidden`.
    pub fn refuse_hidden(&self, target: &ControlTab, caller: &ControlTab) -> R<()> {
        if target.hidden && target.tab_id != caller.tab_id {
            return fail(
                "The user hid this session from other agents. Ask them to show it or to tell you what they need from it.",
            );
        }
        Ok(())
    }

    /// `#liveTab`: the tab that has a saved session open now. A listed row's `tabId` is only what was true when it was
    /// listed; only the tab holding the row's file is it.
    pub fn live_tab(&self, tabs: &[ControlTab], row: &StoredSession) -> Option<ControlTab> {
        tabs.iter()
            .find(|tab| {
                tab.session_path.as_deref() == Some(row.path.as_str()) && tab.device == row.device
            })
            .cloned()
    }

    /// `#fateOf`: what became of the session `id` named, with what only other records know: a tombstone turns a closed
    /// session into a deleted one, and a close recorded before the fates existed is read from the closed-children list.
    pub fn fate_of(&self, state: &HostState, id: &str) -> Option<SessionFate> {
        let known = self.fates().find(id);
        let fate = known.or_else(|| {
            state
                .closed_children
                .iter()
                .rev()
                .find(|child| {
                    child
                        .tab_ids
                        .as_ref()
                        .is_some_and(|ids| ids.iter().any(|held| held == id))
                })
                .map(|legacy| SessionFate {
                    session: FatedSession {
                        ids: legacy
                            .tab_ids
                            .clone()
                            .unwrap_or_else(|| vec![id.to_owned()]),
                        path: Some(legacy.path.clone()),
                        device: legacy.device.clone().filter(|device| !device.is_empty()),
                        title: legacy.title.clone(),
                        hidden: false,
                        cwd: legacy.cwd.clone(),
                        opened_by_session: Some(legacy.opened_by_session.clone())
                            .filter(|opened| !opened.is_empty()),
                    },
                    state: FateState::Closed,
                    at: legacy.closed_at,
                    by: fate_by::AUTO_CLOSE.to_owned(),
                })
        })?;
        let Some(path) = fate.session.path.as_deref() else {
            return Some(fate);
        };
        if fate.state == FateState::Deleted {
            return Some(fate);
        }
        match state.deleted_at_path(path, fate.session.device.as_deref()) {
            None => Some(fate),
            Some(at) => Some(SessionFate {
                state: FateState::Deleted,
                at,
                by: fate_by::APP.to_owned(),
                ..fate
            }),
        }
    }

    /// `#openElsewhere`: the sessions open in a tab no window of this app holds, on `device` (every computer when
    /// None, this one when `Some(None)`), with the computer's name as the lines say it. Read from the summaries every
    /// row reads; the tabs of this app are left out.
    pub fn open_elsewhere(
        &self,
        state: &HostState,
        tabs: &[ControlTab],
        device: Option<&Option<ControlDevice>>,
    ) -> Vec<(SessionSummary, String)> {
        let held: HashSet<String> = tabs
            .iter()
            .map(|tab| {
                format!(
                    "{}\n{}",
                    tab.device.as_deref().unwrap_or(""),
                    tab.session_path.as_deref().unwrap_or("")
                )
            })
            .collect();
        let computers: Vec<Option<ControlDevice>> = match device {
            None => std::iter::once(None)
                .chain(state.devices.iter().cloned().map(Some))
                .collect(),
            Some(None) => vec![None],
            Some(Some(device)) => vec![Some(device.clone())],
        };
        let mut rows = Vec::new();
        for computer in computers {
            let sessions: Vec<SessionSummary> = match &computer {
                Some(computer) => state
                    .summaries(Some(&computer.id))
                    .iter()
                    .filter(|summary| !summary.is_unsaved())
                    .cloned()
                    .collect(),
                None => hosted_summaries(state.summaries(None)),
            };
            let id = computer
                .as_ref()
                .map_or("", |computer| computer.id.as_str());
            let name = computer
                .as_ref()
                .map_or("this computer", |computer| computer.name.as_str());
            for summary in sessions {
                if !held.contains(&format!("{id}\n{}", summary.session_path)) {
                    rows.push((summary, name.to_owned()));
                }
            }
        }
        rows
    }

    /// `#find`: every way an agent names a session, the first match wins: a tab id; an id the tab had before a
    /// relaunch; the saved (stock) id of the session a tab holds; a unique prefix of a tab id or of that saved id;
    /// the id of a tab that closed, in any launch (`fate_of`); the title, exactly or by a unique prefix in any case
    /// (a hidden session's title is private and never matched); then a saved session no tab holds (`stored_session`).
    /// An ambiguous name fails, naming the candidates.
    pub async fn find(
        &self,
        tabs: &[ControlTab],
        session: &str,
        device: Option<&Option<ControlDevice>>,
    ) -> R<Found> {
        let name = unquoted(session);
        let state = self.host.state();
        let only = |matches: Vec<&ControlTab>| -> R<Option<ControlTab>> {
            if matches.len() > 1 {
                return fail(format!(
                    "\"{name}\" matches several sessions: {}. Use the saved id of the one you mean.",
                    matches
                        .iter()
                        .take(6)
                        .map(|tab| format!("{} {}", tab.tab_id, named(tab)))
                        .collect::<Vec<_>>()
                        .join("; ")
                ));
            }
            Ok(matches.first().map(|tab| (*tab).clone()))
        };
        let listed = self.mem().stored.get(&name).cloned();
        let mut tab = tabs
            .iter()
            .find(|entry| entry.tab_id == name)
            .or_else(|| tabs.iter().find(|entry| entry.former_ids.contains(&name)))
            .or_else(|| {
                tabs.iter().find(|entry| {
                    saved_id_of_path(entry.session_path.as_deref()).as_deref()
                        == Some(name.as_str())
                })
            })
            .cloned();
        if tab.is_none() {
            tab = listed.as_ref().and_then(|row| self.live_tab(tabs, row));
        }
        if tab.is_none() && len16(&name) >= SESSION_PREFIX_MIN {
            tab = match only(
                tabs.iter()
                    .filter(|entry| entry.tab_id.starts_with(&name))
                    .collect(),
            )? {
                Some(tab) => Some(tab),
                None => only(
                    tabs.iter()
                        .filter(|entry| {
                            saved_id_of_path(entry.session_path.as_deref())
                                .is_some_and(|id| id.starts_with(&name))
                        })
                        .collect(),
                )?,
            };
        }
        if let Some(tab) = tab {
            return Ok(Found {
                target: Some(Target::Tab(Box::new(tab))),
                ..Found::default()
            });
        }
        // A tab that closed, whoever closed it and in whichever launch: its id still names the saved session it held
        // (or the tab that has it open again). A deleted session's id names what became of it.
        let fate = self.fate_of(&state, &name);
        if let Some(fate) = &fate
            && fate.state == FateState::Deleted
        {
            return Ok(Found {
                gone: Some(fate.clone()),
                ..Found::default()
            });
        }
        if let Some(fate) = &fate
            && let Some(path) = fate.session.path.as_deref()
            && saved_id_of_path(Some(path)).as_deref() != Some(name.as_str())
        {
            let held = self
                .mem()
                .stored
                .values()
                .find(|row| row.path == path && row.device == fate.session.device)
                .cloned();
            let closed = held.unwrap_or_else(|| StoredSession {
                id: name.clone(),
                path: path.to_owned(),
                title: fate.session.title.clone(),
                first_message: String::new(),
                cwd: fate.session.cwd.clone(),
                modified: String::new(),
                messages: 0,
                status: String::new(),
                hidden: fate.session.hidden,
                device: fate.session.device.clone(),
                device_name: fate
                    .session
                    .device
                    .as_ref()
                    .and_then(|id| state.device(id).map(|device| device.name.clone())),
                ..StoredSession::default()
            });
            let target = match self.live_tab(tabs, &closed) {
                Some(tab) => Target::Tab(Box::new(tab)),
                None => Target::Stored(Box::new(closed)),
            };
            return Ok(Found {
                target: Some(target),
                ..Found::default()
            });
        }
        let wanted = name.to_lowercase();
        let titled: Vec<&ControlTab> = tabs.iter().filter(|entry| !entry.hidden).collect();
        let title_of = |entry: &ControlTab| -> String {
            let title = if entry.title.is_empty() {
                entry.task.as_deref().unwrap_or("")
            } else {
                entry.title.as_str()
            };
            trim(title).to_lowercase()
        };
        // A session open in a tab no window of this app holds owns its title as much as a tab here does: a title both
        // hold is ambiguous, and a tab whose title only starts with a name that session holds whole is not the one meant.
        let away: Vec<(String, String)> = self
            .open_elsewhere(&state, tabs, None)
            .into_iter()
            .map(|(summary, computer)| {
                let title = summary
                    .title
                    .clone()
                    .filter(|t| !t.is_empty())
                    .or(summary.auto_title.clone())
                    .unwrap_or_default();
                let id = summary
                    .session_id
                    .as_deref()
                    .filter(|id| !id.is_empty())
                    .map_or_else(String::new, |id| format!("saved id {id}, "));
                (
                    trim(&title).to_lowercase(),
                    format!(
                        "\"{}\" ({id}{})",
                        one_line(&title, 80),
                        open_in_text(&computer, summary.open_for.as_deref())
                    ),
                )
            })
            .collect();
        let holders = |matches: &dyn Fn(&str) -> bool| -> R<(Option<ControlTab>, bool)> {
            let here: Vec<&&ControlTab> = titled
                .iter()
                .filter(|entry| matches(&title_of(entry)))
                .collect();
            let there: Vec<&(String, String)> = away
                .iter()
                .filter(|entry| !entry.0.is_empty() && matches(&entry.0))
                .collect();
            if here.len() + there.len() > 1 {
                return fail(format!(
                    "\"{name}\" matches several sessions: {}. Use the saved id of the one you mean.",
                    here.iter()
                        .map(|entry| format!("{} {}", entry.tab_id, named(entry)))
                        .chain(there.iter().map(|entry| entry.1.clone()))
                        .take(6)
                        .collect::<Vec<_>>()
                        .join("; ")
                ));
            }
            Ok((
                here.first().map(|entry| (***entry).clone()),
                !there.is_empty(),
            ))
        };
        let exact = holders(&|title| title == wanted)?;
        let by_title = match exact.0 {
            Some(tab) => Some(tab),
            None if !exact.1 && len16(&wanted) >= TITLE_PREFIX_MIN => {
                holders(&|title| title.starts_with(&wanted))?.0
            }
            None => None,
        };
        if let Some(tab) = by_title {
            return Ok(Found {
                target: Some(Target::Tab(Box::new(tab))),
                ..Found::default()
            });
        }
        // A saved id a tombstone names is listed by no index any more (and a row an earlier list printed is stale).
        if let Some(at) = state.deleted_at_id(&name) {
            return Ok(Found {
                gone: Some(SessionFate {
                    session: FatedSession {
                        ids: vec![name.clone()],
                        ..FatedSession::default()
                    },
                    state: FateState::Deleted,
                    at,
                    by: fate_by::APP.to_owned(),
                }),
                ..Found::default()
            });
        }
        let (row, unreached) = self.stored_session(&name, device).await?;
        let target = row.map(|row| match self.live_tab(tabs, &row) {
            Some(tab) => Target::Tab(Box::new(tab)),
            None => Target::Stored(Box::new(row)),
        });
        Ok(Found {
            target,
            gone: None,
            unreached,
        })
    }

    /// `#storedSession`: a saved session by stock id, unique id prefix or exact title: the rows the last stored
    /// lists printed first, then a fresh read of the index of `device` (this computer when `Some(None)`). With
    /// `device` None, a name not saved here is looked up on every paired device too. `unreached` names the devices
    /// whose index could not be read.
    pub async fn stored_session(
        &self,
        session: &str,
        device: Option<&Option<ControlDevice>>,
    ) -> R<(Option<StoredSession>, Vec<String>)> {
        let where_: Option<Option<String>> =
            device.map(|device| device.as_ref().map(|device| device.id.clone()));
        let find = || -> R<Option<StoredSession>> {
            let rows: Vec<StoredSession> = self
                .mem()
                .stored
                .values()
                .filter(|row| where_.as_ref().is_none_or(|wanted| row.device == *wanted))
                .cloned()
                .collect();
            if let Some(exact) = rows.iter().find(|row| row.id == session) {
                return Ok(Some(exact.clone()));
            }
            let several = |matches: Vec<&StoredSession>| -> R<Option<StoredSession>> {
                if matches.len() > 1 {
                    return fail(format!(
                        "\"{session}\" matches several saved sessions: {}. Use the full id.",
                        matches
                            .iter()
                            .take(6)
                            .map(|row| format!(
                                "{} \"{}\"",
                                row.id,
                                one_line(&stored_title(row), 60)
                            ))
                            .collect::<Vec<_>>()
                            .join("; ")
                    ));
                }
                Ok(matches.first().map(|row| (*row).clone()))
            };
            let wanted = session.to_lowercase();
            let by_prefix = if len16(session) >= SESSION_PREFIX_MIN {
                several(
                    rows.iter()
                        .filter(|row| row.id.starts_with(session))
                        .collect(),
                )?
            } else {
                None
            };
            if by_prefix.is_some() {
                return Ok(by_prefix);
            }
            several(
                rows.iter()
                    .filter(|row| !row.hidden && trim(&stored_title(row)).to_lowercase() == wanted)
                    .collect(),
            )
        };
        if let Some(known) = find()? {
            return Ok((Some(known), Vec::new()));
        }
        let load = |device_id: Option<String>| async move {
            let rows = self
                .over_link(device_id.as_deref(), || {
                    self.host.stored(device_id.as_deref(), None)
                })
                .await;
            let rows = match rows {
                Ok(rows) => rows,
                // This computer's index is read through omp's own session code (the stock helper): its error alone said
                // nothing of what the call did or that it can pass later.
                Err(error) => {
                    if device_id.is_some() || error.is_tool() {
                        return Err(error);
                    }
                    return fail(format!(
                        "This computer's list of saved sessions could not be read ({}), so \"{session}\" was not looked up and nothing was done. Try again in a moment.",
                        error.message()
                    ));
                }
            };
            let mut mem = self.mem();
            for row in rows {
                mem.stored.set(&row.id.clone(), row);
            }
            Ok(())
        };
        if let Some(device) = device {
            if let Some(device) = device {
                self.reach(device.clone()).await?;
            }
            load(device.as_ref().map(|device| device.id.clone())).await?;
            return Ok((find()?, Vec::new()));
        }
        load(None).await?;
        if let Some(local) = find()? {
            return Ok((Some(local), Vec::new()));
        }
        let paired = self.host.state().devices.clone();
        let mut unreached = Vec::new();
        let lookups = paired.iter().map(|device| {
            let load = &load;
            super::util::join::boxed(async move {
                let reached = self.reach(device.clone()).await?;
                load(Some(reached.id)).await
            })
        });
        let results = super::util::join::all(lookups.collect()).await;
        for (device, result) in paired.iter().zip(results) {
            if result.is_err() {
                unreached.push(device.name.clone());
            }
        }
        Ok((find()?, unreached))
    }

    /// `#resolveAny`: an open session, or a saved one (open in a tab: that tab). `device`: where a saved id is looked up.
    pub async fn resolve_any(
        &self,
        tabs: &[ControlTab],
        session: &str,
        caller: &ControlTab,
        verb: &str,
        device: DeviceScope,
    ) -> R<Target> {
        let found = self.find(tabs, session, device.as_ref()).await?;
        if let Some(gone) = found.gone {
            return Err(session_deleted(&unquoted(session), gone));
        }
        let Some(target) = found.target else {
            let where_ = match &device {
                Some(Some(device)) => format!("on {}", device.name),
                Some(None) => "on this computer".to_owned(),
                None => "on this computer or a paired device".to_owned(),
            };
            return fail(format!(
                "No session \"{session}\" open in this app or saved {where_}{}. Call ompdesk_sessions (scope app for open ones, scope stored for saved ones, with device for a paired device's) and use an id it lists.",
                unreached_text(&found.unreached)
            ));
        };
        let Target::Tab(tab) = target else {
            return Ok(target);
        };
        if tab.tab_id == caller.tab_id {
            return fail(format!(
                "You cannot {verb} your own session with this tool."
            ));
        }
        Ok(Target::Tab(Box::new(
            self.reach_tab(&tab, &caller.tab_id).await?,
        )))
    }

    /// `#open`: a session that has to be open in a tab, named any way `find` reads (never the caller itself unless
    /// `allow_self`). One saved and open in a tab elsewhere is joined through a view of that tab (`join`); one open
    /// nowhere fails with the call that opens it. `reach`: a paired device's tab is waited for while its link comes
    /// back.
    pub async fn open(
        &self,
        tabs: &[ControlTab],
        session: &str,
        caller: &ControlTab,
        verb: &str,
        options: OpenOptions,
    ) -> R<ControlTab> {
        let found = self.find(tabs, session, None).await?;
        if let Some(gone) = found.gone {
            return Err(session_deleted(&unquoted(session), gone));
        }
        let Some(target) = found.target else {
            return fail(format!(
                "No session \"{session}\" open in this app or saved{}. Call ompdesk_sessions (scope app for every window, scope stored for saved ones) and use an id it lists.",
                unreached_text(&found.unreached)
            ));
        };
        let tab = match target {
            Target::Tab(tab) => *tab,
            Target::Stored(row) => self.join_stored(caller, &row, verb).await?,
        };
        if !options.allow_self && tab.tab_id == caller.tab_id {
            return fail(format!(
                "You cannot {verb} your own session with this tool."
            ));
        }
        if options.reach {
            self.reach_tab(&tab, &caller.tab_id).await
        } else {
            Ok(tab)
        }
    }

    /// `#joinStored`: a saved session no tab of this app held when it was named, as its computer lists it now: the
    /// tab of this app that holds it since, else a view of the tab that holds it elsewhere (`join`). One open nowhere
    /// this app can see fails with the call that opens it, and one whose computer's list cannot be read now fails
    /// saying so.
    pub async fn join_stored(
        &self,
        caller: &ControlTab,
        row: &StoredSession,
        verb: &str,
    ) -> R<ControlTab> {
        let home = row
            .device
            .as_deref()
            .and_then(|id| self.host.state().device(id).cloned());
        let where_ = row
            .device_name
            .clone()
            .or_else(|| home.as_ref().map(|home| home.name.clone()))
            .unwrap_or_else(|| "this computer".to_owned());
        let now = async {
            if let Some(home) = &home {
                self.reach(home.clone()).await?;
            }
            let rows = self
                .over_link(row.device.as_deref(), || {
                    self.host.stored(row.device.as_deref(), None)
                })
                .await?;
            let current = rows
                .into_iter()
                .find(|entry| entry.path == row.path)
                .unwrap_or_else(|| row.clone());
            self.mem().stored.set(&current.id.clone(), current.clone());
            Ok::<_, Fail>(current)
        }
        .await;
        let now = match now {
            Ok(now) => now,
            Err(error) if error.is_tool() => return Err(error),
            Err(error) => {
                return fail(format!(
                    "What {where_} holds could not be read now ({}), so whether a tab there has \"{}\" ({}) open is not known: nothing was sent. Try again in a moment.",
                    error.message(),
                    one_line(&stored_title(row), 80),
                    row.id
                ));
            }
        };
        let state = self.host.state();
        if let Some(live) = self.live_tab(&state.tabs(&caller.tab_id).unwrap_or_default(), &now) {
            return Ok(live);
        }
        if now.hidden {
            return fail("The user hid that session from other agents.");
        }
        // What a computer lists as held is its windows' tabs and the tabs it runs for devices that are attached. A
        // paired device's tab restored by a relaunch and not shown since runs no omp and tells no computer.
        if now.elsewhere.is_none() {
            return fail(format!(
                "\"{}\" ({}) is saved{} and not open in any tab OMPdesk can see: no tab of this app, and none {where_} lists. A paired computer may still show it in a tab that has not started since a relaunch (it starts when the person shows it there), which no other computer sees. To {verb} it now, open it with ompdesk_session_open {{\"reopen\":\"{}\"}} and {verb} it by the id that returns: a tab elsewhere that shows it then views that tab's omp, never a second omp (ompdesk_session_read reads it without opening).",
                one_line(&stored_title(&now), 80),
                now.id,
                now.device_name
                    .as_deref()
                    .map_or_else(String::new, |name| format!(" on {name}")),
                now.id
            ));
        }
        self.join(caller, &now).await
    }

    /// `#join`: joins a saved session open in a tab elsewhere: a tab in the caller's window that views that tab's omp
    /// (the host's `tab.open`, or this computer's view of a tab it runs for a paired device), never a second omp on
    /// its file. It nests under nobody and is not "opened by you".
    pub async fn join(&self, caller: &ControlTab, row: &StoredSession) -> R<ControlTab> {
        let home = row
            .device
            .as_deref()
            .and_then(|id| self.host.state().device(id).cloned());
        if let Some(home) = home {
            self.reach(home).await?;
        }
        let spawned = self
            .host
            .spawn(
                &caller.tab_id,
                &SpawnRequest {
                    session_path: Some(row.path.clone()),
                    device: Some(row.device.clone()),
                    join: true,
                    ..SpawnRequest::default()
                },
            )
            .await?;
        self.when_ready(&spawned.tab_id, &caller.tab_id, None)
            .await?;
        let joined = self.host.state().tabs(&caller.tab_id).and_then(|tabs| {
            tabs.into_iter()
                .find(|entry| entry.tab_id == spawned.tab_id)
        });
        let Some(joined) = joined else {
            return fail(format!(
                "\"{}\" was joined as {}, and that tab closed again.",
                one_line(&stored_title(row), 80),
                spawned.tab_id
            ));
        };
        // A view just attached names nothing until its omp says: it is the saved session it joined.
        if joined.title.is_empty() && joined.task.as_deref().is_none_or(str::is_empty) {
            Ok(ControlTab {
                title: stored_title(row),
                ..joined
            })
        } else {
            Ok(joined)
        }
    }

    /// `#whenReady`: waits for a started tab to be ready, however long its start takes (queued, an omp slow to
    /// answer, a paired host's link down): a live start is never a failed one. Only a tab that closed, exited or
    /// reads `error` fails it, with the reason its omp gave (`start_failure`). `recover_until` is for a tab that was
    /// ready and then refused a command: an `error` it reads may still turn ready, so it is waited out until then.
    /// Every snapshot main pushes is looked at, so a ready that held between two pushes counts.
    pub async fn when_ready(
        &self,
        tab_id: &str,
        caller_tab_id: &str,
        recover_until: Option<Instant>,
    ) -> R<()> {
        enum Seen {
            Ready,
            Failed(String),
        }
        loop {
            let seen = self
                .host
                .wait_for(Some(self.tuning.ready_poll_ms), |state| {
                    let tab = state
                        .tabs(caller_tab_id)
                        .and_then(|tabs| tabs.into_iter().find(|entry| entry.tab_id == tab_id));
                    let Some(tab) = tab else {
                        return Some(Seen::Failed(
                            "The new session's tab closed before it was ready.".to_owned(),
                        ));
                    };
                    match tab.status {
                        TabStatus::Ready | TabStatus::Running => Some(Seen::Ready),
                        TabStatus::Exited => Some(Seen::Failed(start_failure(&tab))),
                        // Another omp still holds the session: the tab opens it by itself once that omp lets go.
                        TabStatus::Error if !tab.session_held => match recover_until {
                            Some(until) if Instant::now() < until => None,
                            _ => Some(Seen::Failed(start_failure(&tab))),
                        },
                        _ => None,
                    }
                })
                .await;
            match seen {
                Some(Seen::Ready) => return Ok(()),
                Some(Seen::Failed(message)) => return fail(message),
                None => {}
            }
        }
    }

    /// `#ownClosed`: a saved session the caller opened whose tab was closed: this launch, or recorded under the
    /// caller's session.
    pub fn own_closed(
        &self,
        state: &HostState,
        caller: &ControlTab,
        path: &str,
        device: Option<&str>,
    ) -> bool {
        if self
            .mem()
            .closed_openers
            .get(&receiver_key(path, device))
            .map(String::as_str)
            == Some(caller.tab_id.as_str())
        {
            return true;
        }
        let Some(session_path) = caller.session_path.as_deref() else {
            return false;
        };
        self.fates()
            .of(path, device)
            .and_then(|fate| fate.session.opened_by_session)
            .as_deref()
            == Some(session_path)
            || state.closed_children.iter().any(|child| {
                child.opened_by_session == session_path
                    && child.path == path
                    && child.device.as_deref() == device
            })
    }

    /// `#sendTarget`: where a message goes: an open session (`open`), or a child the caller opened whose tab was
    /// closed once its work was done, opened again in the background, since the message is more work for it.
    pub async fn send_target(
        &self,
        caller: &ControlTab,
        tabs: &[ControlTab],
        session: &str,
    ) -> R<ControlTab> {
        let found = self.find(tabs, session, None).await?.target;
        let row = match found {
            Some(Target::Stored(row))
                if !row.hidden
                    && self.own_closed(
                        &self.host.state(),
                        caller,
                        &row.path,
                        row.device.as_deref(),
                    ) =>
            {
                row
            }
            _ => {
                return self
                    .open(tabs, session, caller, "send to", OpenOptions::default())
                    .await;
            }
        };
        let home = row
            .device
            .as_deref()
            .and_then(|id| self.host.state().device(id).cloned());
        if let Some(home) = home {
            self.reach(home).await?;
        }
        let spawned = self
            .host
            .spawn(
                &caller.tab_id,
                &SpawnRequest {
                    session_path: Some(row.path.clone()),
                    device: Some(row.device.clone()),
                    ..SpawnRequest::default()
                },
            )
            .await;
        let spawned = match spawned {
            Ok(spawned) => spawned,
            Err(Fail::FolderMissing { folder, saved }) => {
                return fail(self.folder_gone(
                    &folder,
                    saved.as_ref(),
                    &unquoted(session),
                    &row.path,
                    row.device.as_deref(),
                    Wanted::Send,
                ));
            }
            Err(error) => return Err(error),
        };
        self.when_ready(&spawned.tab_id, &caller.tab_id, None)
            .await?;
        match self.host.state().tabs(&caller.tab_id).and_then(|tabs| {
            tabs.into_iter()
                .find(|entry| entry.tab_id == spawned.tab_id)
        }) {
            Some(tab) => Ok(tab),
            None => fail(format!(
                "\"{}\" was opened again as {}, and its tab closed before the message.",
                one_line(&stored_title(&row), 80),
                spawned.tab_id
            )),
        }
    }

    /// `#folderGone`: what a caller is told when a saved session cannot open because the folder it worked in is gone
    /// (a session never opens in another folder): what removed the folder, whether anything was lost, and the call
    /// that goes on from here. One text for a reopen and for a message to a closed child.
    pub fn folder_gone(
        &self,
        folder: &str,
        saved: Option<&SavedFolder>,
        session: &str,
        path: &str,
        device: Option<&str>,
        wanted: Wanted,
    ) -> String {
        let read = format!("ompdesk_session_read {{\"session\":\"{session}\"}}");
        if let Some(saved) = saved {
            let reopen = serde_json::to_string(&json!({ "reopen": session, "restore": true }))
                .unwrap_or_default();
            return format!(
                "The folder this saved session worked in ({folder}) was removed by OMPdesk's disk care, which saved it first (saved worktree {}{}, removed {}). Put it back and open the session there with ompdesk_session_open {reopen}{}; the person can also restore it from Work tree › Saved worktrees on the computer that holds it.",
                saved.id,
                saved
                    .branch
                    .as_deref()
                    .filter(|branch| !branch.is_empty())
                    .map_or_else(String::new, |branch| format!(", branch {branch}")),
                crate::aimemory::value::iso(saved.removed_at.max(0.0) as u64),
                if wanted == Wanted::Send {
                    ", then send your message to the id that returns"
                } else {
                    ""
                }
            );
        }
        // The control tools remove a finished child's worktree themselves once its work landed: then nothing was lost.
        let state = self.host.state();
        let landed = state.closed_children.iter().rev().find(|child| {
            child.path == path && child.device.as_deref() == device && child.cwd != folder
        });
        let why = match landed {
            Some(landed) => format!(
                ": OMPdesk removed that worktree when it closed the session on {}, because its work had landed (clean tree, its branch in {}), so nothing was lost",
                &crate::aimemory::value::iso(landed.closed_at.max(0.0) as u64)[..10],
                landed.cwd
            ),
            None => " and nothing of it was saved".to_owned(),
        };
        let mut next = serde_json::Map::new();
        next.insert("message".into(), json!("…"));
        if let Some(landed) = landed {
            next.insert("folder".into(), json!(landed.cwd));
        }
        next.insert("worktree".into(), json!(true));
        let next = serde_json::to_string(&next).unwrap_or_default();
        format!(
            "The folder this saved session worked in no longer exists ({folder}){why}. A session opens only in the folder it worked in, so this one takes no more work{}. Give the follow-up to a new session (ompdesk_session_open {next}) and name this one in its brief: its transcript stays readable with {read}.",
            if wanted == Wanted::Send {
                " and your message was not delivered"
            } else {
                ""
            }
        )
    }

    /// `#refuseInUse`: refuses a stop, close or delete `needsPersonTurn` holds back, asked in a turn the person's own
    /// message did not start (that rule stands), and keeps it as a pending cleanup: its caller is told the list
    /// once, at the start of its next turn the person starts (`personTyped`), when the same call works. A caller
    /// that is no tab (a process outside OMPdesk) has no such turn, so nothing is kept for it.
    pub fn refuse_in_use<T>(
        &self,
        caller: &ControlTab,
        tabs: &[ControlTab],
        target: &ControlTab,
        flags: StopFlags,
    ) -> R<T> {
        let kept = tabs.iter().any(|tab| tab.tab_id == caller.tab_id);
        if kept {
            let at = self.now();
            self.cleanups().add(cleanup_of(caller, target, flags, at));
        }
        fail(format!(
            "{}{}",
            in_use_refusal(target, flags),
            if kept {
                " OMPdesk kept this as a pending cleanup: it lists it to you at the start of your next turn the user's own message starts, and the same call works then."
            } else {
                ""
            }
        ))
    }
}
