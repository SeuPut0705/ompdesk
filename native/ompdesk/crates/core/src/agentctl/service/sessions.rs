//! Family 1, sessions: listing, opening, stopping, reading and waiting for sessions.
//!
//! Owns these TypeScript methods (service.ts): `#list`, `#listStored`, `#storedStep`, `#paceOf`, `#currentRow`,
//! `#sessionSummary`, `#result`, `#resultUntil`, `#read` and `#readStored` here; `#openCommands`, `#resolveModel`,
//! `#openMany`, `#openOne`, `#openText`, `#ensureStarted` and the public `openSessions` in `open`; `#stop`,
//! `#stopStored`, `#personTurn`, `#abort`, `#within`, `#deleteWhenIdle`, `#journalClose`, `#dropWorktree`,
//! `#whenGone`, `#closeTab`, `#rememberClosed` and `#fated` in `stop`. `#cost`, `#split`, `#tabRow`,
//! `#transcript` and `#deleteThrowaway` are the work family's.
//!
//! Already shared (not ported again): `find`, `open`, `join`, `when_ready`, `reach`, `reach_tab`, `session_state`,
//! `state_line`, `with_pickup`, `opened_by`, `open_elsewhere`, `devices_line`, `refuse_in_use`, `folder_gone`.

mod open;
mod stop;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde_json::json;
use tokio::time::Instant;

pub use open::OpenResult;
pub(super) use stop::{CloseHow, TabClose};

use super::AgentControl;
use super::fail::{R, fail};
use super::host::Deadline;
use super::js::{cut, number, one_line};
use super::pace::{Pace, pace_short};
use super::resolve::DeviceScope;
use super::text::{
    LIST_DEFAULT_ROWS, SUMMARY_CHARS, current_step, label, open_elsewhere_text, open_in_text,
    render_page, response_data, saved_id_of_path, stale_cursor_note, stored_title, todo_progress,
    transcript_ending, transcript_page, waits,
};
use super::types::{
    ControlTab, DeviceState, ListArgs, ReadArgs, ResultArgs, StoredSession, TabStatus, Target,
    running_agent_count,
};
use super::util::join;

/// `RESULT_WAIT_DEFAULT_SECONDS`, `RESULT_MAX_CHARS`, `RESULT_TABLE_ANSWER_CHARS`, `READ_DEFAULT_MESSAGES`
/// (`tools.ts`).
const RESULT_WAIT_DEFAULT_SECONDS: u64 = 600;
const RESULT_MAX_CHARS: usize = 20_000;
const RESULT_TABLE_ANSWER_CHARS: usize = 1_500;
const READ_DEFAULT_MESSAGES: usize = 12;

/// One session's lines in a result: whether it is settled, and what it says.
#[derive(Clone, Debug)]
pub struct Summary {
    pub settled: bool,
    pub text: String,
}

/// One row of a list: how it is sorted by `status`, and its text.
struct Row {
    kind: &'static str,
    text: String,
}

impl AgentControl {
    /// `#paceOf`: a session's pace, or None: a pace never blocks or fails the caller.
    pub(in crate::agentctl::service) async fn pace_of(
        &self,
        path: &str,
        device: Option<&str>,
    ) -> Option<Pace> {
        self.host
            .session_pace(path, device.filter(|device| !device.is_empty()))
            .await
            .ok()
            .flatten()
            .and_then(Pace::from_value)
    }

    /// `ompdesk_sessions` (`#list`).
    pub(in crate::agentctl::service) async fn list(
        &self,
        caller: &ControlTab,
        listed: &[ControlTab],
        args: ListArgs,
    ) -> R<String> {
        let named: DeviceScope = match &args.device {
            None => None,
            Some(name) => Some(self.device(name)?),
        };
        // A device asked for by name is waited for while its link comes back; its tabs re-attach meanwhile.
        let device: DeviceScope = match &named {
            Some(Some(device)) => Some(Some(self.reach(device.clone()).await?)),
            other => other.clone(),
        };
        let away = matches!(&named, Some(Some(device)) if device.state != DeviceState::Online);
        let tabs: Vec<ControlTab> = if away {
            self.host
                .state()
                .tabs(&caller.tab_id)
                .unwrap_or_else(|| listed.to_vec())
        } else {
            listed.to_vec()
        };
        let limit = args.limit.unwrap_or(LIST_DEFAULT_ROWS);
        if args.scope.as_deref() == Some("stored") {
            return self
                .list_stored(caller, &tabs, &args, device.as_ref(), limit)
                .await;
        }
        let opened: HashSet<String> = self
            .opened_by(&self.host.state(), &caller.tab_id, &tabs)
            .into_iter()
            .collect();
        let query = args
            .query
            .as_deref()
            .filter(|query| !query.is_empty())
            .map(str::to_lowercase);
        let folder = args.folder.as_deref().filter(|folder| !folder.is_empty());
        let app = args.scope.as_deref() == Some("app") || device.is_some();
        let mine = args.mine == Some(true);
        let wanted: Vec<&ControlTab> = tabs
            .iter()
            .filter(|tab| {
                (app || tab.here)
                    && match &device {
                        None => true,
                        Some(None) => tab.device.as_deref().is_none_or(str::is_empty),
                        Some(Some(device)) => tab.device.as_deref() == Some(device.id.as_str()),
                    }
                    && folder.is_none_or(|folder| tab.cwd.contains(folder))
                    && (!mine || opened.contains(&tab.tab_id))
                    && query.as_ref().is_none_or(|query| {
                        !tab.hidden && tab.title.to_lowercase().contains(query.as_str())
                    })
            })
            .collect();
        let reaching = matches!(&device, Some(Some(_)));
        let candidates: Vec<ControlTab> = join::all(
            wanted
                .into_iter()
                .map(|tab| {
                    join::boxed(async move {
                        if reaching {
                            self.reach_tab(tab, &caller.tab_id)
                                .await
                                .unwrap_or_else(|_| tab.clone())
                        } else {
                            tab.clone()
                        }
                    })
                })
                .collect(),
        )
        .await;
        let mut rows: Vec<Row> = join::all(
            candidates
                .iter()
                .map(|tab| join::boxed(self.list_row(caller, tab, &opened)))
                .collect(),
        )
        .await;
        // Sessions open in a tab no window of this app holds: one this computer runs for a paired device, and a
        // paired host's open in its own window or in another device's tab there. Their rows show them from the same
        // summaries; a saved id reaches each through a view of the tab that holds it (`join`).
        if app && !mine {
            let state = self.host.state();
            for (summary, computer) in self.open_elsewhere(&state, &tabs, device.as_ref()) {
                if folder.is_some_and(|folder| !summary.cwd.contains(folder)) {
                    continue;
                }
                let title = summary
                    .title
                    .as_deref()
                    .filter(|title| !title.is_empty())
                    .or(summary.auto_title.as_deref());
                if let Some(query) = &query
                    && !title.unwrap_or("").to_lowercase().contains(query.as_str())
                {
                    continue;
                }
                let waiting = summary.ask.is_some();
                let running =
                    !waiting && matches!(summary.status, TabStatus::Running | TabStatus::Starting);
                let state_text = if waiting {
                    "waiting for the user's answer there".to_owned()
                } else if summary.status == TabStatus::Running {
                    if summary.settling {
                        "running (background work still going)".to_owned()
                    } else {
                        "running".to_owned()
                    }
                } else if summary.status == TabStatus::Ready {
                    "idle".to_owned()
                } else if let Some(message) = summary
                    .failure
                    .as_ref()
                    .and_then(|failure| failure.message.as_deref())
                    .filter(|message| !message.is_empty())
                {
                    format!(
                        "{}: {}",
                        summary.status.as_str(),
                        one_line(message, SUMMARY_CHARS)
                    )
                } else {
                    summary.status.as_str().to_owned()
                };
                let agents = running_agent_count(Some(&summary));
                let mut parts = vec![state_text, format!("folder {}", summary.cwd)];
                if agents > 0 {
                    parts.push(format!("{agents} subagent(s) running"));
                }
                let id = summary
                    .session_id
                    .as_deref()
                    .filter(|id| !id.is_empty())
                    .map_or_else(String::new, |id| format!(" (saved id {id})"));
                rows.push(Row {
                    kind: if waiting {
                        "waiting"
                    } else if running {
                        "running"
                    } else {
                        "idle"
                    },
                    text: format!(
                        "- {}{id} [{}]\n  {}",
                        match title {
                            Some(title) if !title.is_empty() =>
                                format!("\"{}\"", one_line(title, 80)),
                            _ => "(untitled)".to_owned(),
                        },
                        open_in_text(&computer, summary.open_for.as_deref()),
                        parts.join("; ")
                    ),
                });
            }
        }
        let status = args.status.as_deref().filter(|status| !status.is_empty());
        let kept: Vec<&Row> = rows
            .iter()
            .filter(|row| status.is_none_or(|status| row.kind == status))
            .collect();
        let where_ = match &device {
            Some(Some(device)) => format!("on {}", device.name),
            Some(None) => "on this computer".to_owned(),
            None if app => "in this app (every window)".to_owned(),
            None => "in this window".to_owned(),
        };
        let more = if kept.len() > limit {
            format!(
                "\n… {} more; narrow with folder, status, query or limit.",
                kept.len() - limit
            )
        } else {
            String::new()
        };
        let state = self.host.state();
        let elsewhere = tabs.iter().filter(|tab| !tab.here).count();
        let away = if app {
            0
        } else {
            self.open_elsewhere(&state, &tabs, device.as_ref()).len()
        };
        let others = if app {
            String::new()
        } else {
            format!(
                "\n{}{}Saved sessions, closed ones too: scope stored.",
                if elsewhere > 0 {
                    format!("{elsewhere} more open in other windows (scope app). ")
                } else {
                    String::new()
                },
                if away > 0 {
                    format!(
                        "{away} more open in tabs this app does not hold, on this computer for a paired device or on a paired device (scope app). "
                    )
                } else {
                    String::new()
                }
            )
        };
        let shown = kept
            .iter()
            .take(limit)
            .map(|row| row.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let mut views = Vec::new();
        if args.scope.as_deref() == Some("app") && !mine {
            for view in self.host.list_views().await? {
                let tab = &view.tab;
                let kind = if waits(tab) {
                    "waiting"
                } else if tab.busy || tab.resuming || tab.status == TabStatus::Running {
                    "running"
                } else {
                    "idle"
                };
                if folder.is_some_and(|folder| !tab.cwd.contains(folder))
                    || status.is_some_and(|status| status != kind)
                    || query.as_ref().is_some_and(|query| {
                        tab.hidden || !tab.title.to_lowercase().contains(query.as_str())
                    })
                {
                    continue;
                }
                views.push(
                    serde_json::to_string(&view.handle)
                        .map_err(|error| super::fail::Fail::other(error.to_string()))?,
                );
            }
        }
        let view_lines = if views.is_empty() {
            String::new()
        } else {
            format!(
                "\nExact view handles (close:true with view):\n{}",
                views.join("\n")
            )
        };
        Ok(format!(
            "{} session{} {where_}:\n{shown}{more}{others}\n{}{view_lines}",
            kept.len(),
            if kept.len() == 1 { "" } else { "s" },
            self.devices_line(&state)
        ))
    }

    /// One row of `ompdesk_sessions`.
    async fn list_row(
        &self,
        caller: &ControlTab,
        tab: &ControlTab,
        opened: &HashSet<String>,
    ) -> Row {
        let mut marks: Vec<&str> = Vec::new();
        if tab.tab_id == caller.tab_id {
            marks.push("this session");
        }
        if opened.contains(&tab.tab_id) {
            marks.push("opened by you");
        }
        if !tab.here {
            marks.push("another window");
        }
        let marked = if marks.is_empty() {
            String::new()
        } else {
            format!(" [{}]", marks.join(", "))
        };
        if tab.hidden && tab.tab_id != caller.tab_id {
            return Row {
                kind: "idle",
                text: format!("- {} (hidden from agents by the user){marked}", tab.tab_id),
            };
        }
        let (session, pace) = tokio::join!(self.session_state(tab), async {
            match tab.session_path.as_deref().filter(|path| !path.is_empty()) {
                Some(path) => self.pace_of(path, tab.device.as_deref()).await,
                None => None,
            }
        });
        let state = self.host.state();
        let line = self.state_line(&state, tab, &session);
        let mut parts = vec![
            self.with_pickup(&state, caller, tab, &session, &line),
            format!("folder {}", tab.cwd),
        ];
        if let Some(worktree) = &tab.worktree {
            parts.push(format!("worktree {}", worktree.branch));
        }
        if let Some(name) = tab.device_name.as_deref().filter(|name| !name.is_empty()) {
            parts.push(format!("on {name}"));
        }
        if let Some(model) = session
            .state
            .as_ref()
            .and_then(|state| state.model.as_ref())
        {
            parts.push(format!("model {}/{}", model.provider, model.id));
        }
        if session
            .state
            .as_ref()
            .is_some_and(|state| state.plan_mode_enabled)
        {
            parts.push("plan mode".to_owned());
        }
        if session.subagents > 0 {
            parts.push(format!("{} subagent(s) running", session.subagents));
        }
        if let Some(todos) = session
            .state
            .as_ref()
            .and_then(|state| todo_progress(&state.todo_phases))
        {
            parts.push(todos);
        }
        if let Some(pace) = &pace {
            parts.push(pace_short(pace));
        }
        // The saved id is the session's on every computer and across relaunches; the tab id is this app's, this launch.
        let saved = saved_id_of_path(tab.session_path.as_deref());
        let head = format!(
            "- {} {}{}{marked}",
            tab.tab_id,
            label(tab),
            saved.map_or_else(String::new, |saved| format!(" (saved id {saved})"))
        );
        let answer = session
            .last
            .as_deref()
            .filter(|last| !last.is_empty())
            .map_or_else(String::new, |last| {
                format!("\n  last answer: {}", one_line(last, SUMMARY_CHARS))
            });
        let kind = if waits(tab) {
            "waiting"
        } else if line.starts_with("running") || line.starts_with("starting") {
            "running"
        } else {
            "idle"
        };
        Row {
            kind,
            text: format!("{head}\n  {}{answer}", parts.join("; ")),
        }
    }

    /// `#listStored`.
    async fn list_stored(
        &self,
        caller: &ControlTab,
        tabs: &[ControlTab],
        args: &ListArgs,
        device: Option<&Option<super::types::ControlDevice>>,
        limit: usize,
    ) -> R<String> {
        if args
            .status
            .as_deref()
            .is_some_and(|status| !status.is_empty())
        {
            return fail("status filters open sessions; leave it out with scope stored.");
        }
        let opened: HashSet<String> = self
            .opened_by(&self.host.state(), &caller.tab_id, tabs)
            .into_iter()
            .collect();
        let held: HashSet<&str> = tabs
            .iter()
            .filter(|tab| opened.contains(&tab.tab_id))
            .filter_map(|tab| tab.session_path.as_deref())
            .collect();
        let device_id = device
            .and_then(|device| device.as_ref())
            .map(|device| device.id.as_str());
        let query = args.query.as_deref();
        let folder = args.folder.as_deref().filter(|folder| !folder.is_empty());
        let mut rows: Vec<StoredSession> = self
            .over_link(device_id, || self.host.stored(device_id, query))
            .await?
            .into_iter()
            .filter(|row| {
                folder.is_none_or(|folder| row.cwd.contains(folder))
                    && (args.mine != Some(true) || held.contains(row.path.as_str()))
            })
            .collect();
        // Newest first; the sort is stable, as `Array.prototype.sort` is.
        rows.sort_by(|a, b| b.modified.cmp(&a.modified));
        {
            let mut mem = self.mem();
            for row in &rows {
                mem.stored.set(&row.id, row.clone());
            }
        }
        let shown = &rows[..rows.len().min(limit)];
        let paces: Vec<Option<Pace>> = join::all(
            shown
                .iter()
                .map(|row| {
                    join::boxed(async move {
                        if row.hidden {
                            None
                        } else {
                            self.pace_of(&row.path, row.device.as_deref()).await
                        }
                    })
                })
                .collect(),
        )
        .await;
        let lines: Vec<String> = join::all(
            shown
                .iter()
                .zip(&paces)
                .map(|(row, pace)| {
                    join::boxed(async move {
                        if row.hidden {
                            return format!("- {} (hidden from agents by the user)", row.id);
                        }
                        let title = stored_title(row);
                        let elsewhere = if row.tab_id.is_some() {
                            String::new()
                        } else {
                            open_elsewhere_text(row, self.stored_step(row).await.as_deref())
                        };
                        let open = match (&row.tab_id, elsewhere.is_empty()) {
                            (Some(tab_id), _) => format!("; open in tab {tab_id}"),
                            (None, false) => format!("; {elsewhere}"),
                            (None, true) => String::new(),
                        };
                        let hit = row
                            .snippet
                            .as_deref()
                            .filter(|snippet| !snippet.is_empty())
                            .map_or_else(String::new, |snippet| {
                                format!("\n  match: {}", one_line(snippet, SUMMARY_CHARS))
                            });
                        // Before `changed`: the row ends with when it changed and where it is open, as every reader of it
                        // expects.
                        let pace = pace
                            .as_ref()
                            .map_or_else(String::new, |pace| format!("; {}", pace_short(pace)));
                        format!(
                            "- {} \"{}\"\n  folder {}; {} message(s); {}{pace}; changed {}{open}{hit}",
                            row.id,
                            one_line(&title, 80),
                            row.cwd,
                            row.messages,
                            row.status,
                            row.modified
                        )
                    })
                })
                .collect(),
        )
        .await;
        let where_ = match device {
            Some(Some(device)) => format!("saved on {}", device.name),
            _ => "saved on this computer".to_owned(),
        };
        let more = if rows.len() > limit {
            format!(
                "\n… {} more; narrow with folder, query or limit.",
                rows.len() - limit
            )
        } else {
            String::new()
        };
        Ok(format!(
            "{} session{} {where_}{}:\n{}{more}\nRead one with ompdesk_session_read; open it again with ompdesk_session_open {{\"reopen\":\"<id>\"}}.\n{}",
            rows.len(),
            if rows.len() == 1 { "" } else { "s" },
            args.query
                .as_deref()
                .filter(|query| !query.is_empty())
                .map_or_else(String::new, |query| format!(" matching \"{query}\"")),
            lines.join("\n"),
            self.devices_line(&self.host.state())
        ))
    }

    /// `#storedStep`: the tool call a saved session runs in a tab elsewhere (its turn's `current_step`, from the saved
    /// transcript).
    async fn stored_step(&self, row: &StoredSession) -> Option<String> {
        if row.elsewhere.as_ref().and_then(|open| open.work) != Some(super::types::StoredWork::Turn)
        {
            return None;
        }
        let messages = self.host.stored_messages(row).await.unwrap_or_default();
        current_step(&messages)
    }

    /// `#currentRow`: `row` as its computer lists it now (kept for the next lookup); the row itself when that list
    /// cannot be read.
    pub(in crate::agentctl::service) async fn current_row(
        &self,
        row: &StoredSession,
    ) -> StoredSession {
        let rows = self
            .host
            .stored(row.device.as_deref(), None)
            .await
            .unwrap_or_default();
        let Some(now) = rows.into_iter().find(|entry| entry.path == row.path) else {
            return row.clone();
        };
        self.mem().stored.set(&now.id, now.clone());
        now
    }

    /// `#sessionSummary`.
    async fn session_summary(
        &self,
        caller: &ControlTab,
        tab: &ControlTab,
        per_answer: usize,
    ) -> R<Summary> {
        self.refuse_hidden(tab, caller)?;
        let session = self.session_state(tab).await;
        let state = self.host.state();
        let line = self.state_line(&state, tab, &session);
        let settled =
            line == "idle" || line.starts_with("stopped") || line.starts_with("not started");
        let todos = session
            .state
            .as_ref()
            .and_then(|state| todo_progress(&state.todo_phases));
        let hint = if waits(tab) {
            " It needs an answer: ompdesk_session_answer, or tell the user."
        } else {
            ""
        };
        let body = match session.last.as_deref().filter(|last| !last.is_empty()) {
            Some(last) => cut(last, per_answer),
            None => "(no answer yet)".to_owned(),
        };
        let pace = match tab.session_path.as_deref().filter(|path| !path.is_empty()) {
            Some(path) => self.pace_of(path, tab.device.as_deref()).await,
            None => None,
        };
        let state = self.host.state();
        Ok(Summary {
            settled: settled || waits(tab),
            text: format!(
                "{} [{}]: {}.{}{hint}\n{}Last answer:\n{body}",
                label(tab),
                tab.tab_id,
                self.with_pickup(&state, caller, tab, &session, &line),
                todos.map_or_else(String::new, |todos| format!(" {todos}.")),
                pace.map_or_else(String::new, |pace| format!("{}\n", pace_short(&pace)))
            ),
        })
    }

    /// `ompdesk_session_result` (`#result`). `several`: `sessions` was given.
    pub(in crate::agentctl::service) async fn result(
        &self,
        caller: &ControlTab,
        targets: Vec<Target>,
        args: ResultArgs,
        several: bool,
    ) -> R<String> {
        let seconds = args.timeout_seconds.unwrap_or(RESULT_WAIT_DEFAULT_SECONDS);
        let deadline = Instant::now() + Duration::from_secs(seconds);
        let per_answer = if several {
            RESULT_TABLE_ANSWER_CHARS
        } else {
            RESULT_MAX_CHARS
        };
        // A saved session no tab holds is finished as its file says; it is read once.
        let mut reads = Vec::new();
        for target in &targets {
            let Target::Stored(row) = target else {
                continue;
            };
            if row.hidden {
                return fail("The user hid a session you asked about from other agents.");
            }
            reads.push(join::boxed(async move {
                let (messages, pace) = tokio::join!(
                    self.over_link(row.device.as_deref(), || self.host.stored_messages(row)),
                    self.pace_of(&row.path, row.device.as_deref())
                );
                let messages = messages?;
                let last = transcript_ending(&messages).last;
                let where_ = format!(
                    "saved{}, not open in any tab",
                    row.device_name
                        .as_deref()
                        .filter(|name| !name.is_empty())
                        .map_or_else(String::new, |name| format!(" on {name}"))
                );
                Ok::<_, super::fail::Fail>((
                    row.id.clone(),
                    Summary {
                        settled: true,
                        text: format!(
                            "\"{}\" [{}]: {where_}.\n{}Last answer:\n{}",
                            one_line(&stored_title(row), 80),
                            row.id,
                            pace.map_or_else(String::new, |pace| format!(
                                "{}\n",
                                pace_short(&pace)
                            )),
                            match last.as_deref().filter(|last| !last.is_empty()) {
                                Some(last) => cut(last, per_answer),
                                None => "(no answer)".to_owned(),
                            }
                        ),
                    },
                ))
            }));
        }
        let saved: HashMap<String, Summary> = join::all(reads)
            .await
            .into_iter()
            .collect::<R<Vec<_>>>()?
            .into_iter()
            .collect();
        let ids: Vec<String> = targets
            .iter()
            .map(|target| match target {
                Target::Tab(tab) => tab.tab_id.clone(),
                Target::Stored(row) => row.id.clone(),
            })
            .collect();
        // Inside a blocking wait main owns, the caller cannot read a steer until the call returns: it says so to a
        // sender (`block`), and the wait ends when a message reaches the caller (`arrivals`).
        let _blocked = (args.wait == Some(true)).then(|| self.block(&caller.tab_id));
        self.result_until(
            caller, &targets, &ids, &saved, &args, seconds, deadline, per_answer,
        )
        .await
    }

    /// `#resultUntil`.
    #[allow(clippy::too_many_arguments)]
    async fn result_until(
        &self,
        caller: &ControlTab,
        targets: &[Target],
        ids: &[String],
        saved: &HashMap<String, Summary>,
        args: &ResultArgs,
        seconds: u64,
        deadline: Instant,
        per_answer: usize,
    ) -> R<String> {
        let arrived_before = self.arrivals(&caller.tab_id);
        loop {
            // Created before the state is read: an arrival from here on wakes the pause below.
            let arrived = self.arrived.notified();
            let tabs = self.host.state().tabs(&caller.tab_id);
            let current: Vec<Option<Target>> = targets
                .iter()
                .map(|target| match target {
                    Target::Tab(tab) => tabs
                        .as_ref()
                        .and_then(|tabs| tabs.iter().find(|entry| entry.tab_id == tab.tab_id))
                        .map(|tab| Target::Tab(Box::new(tab.clone()))),
                    Target::Stored(_) => Some(target.clone()),
                })
                .collect();
            if let Some(gone) = current.iter().position(Option::is_none)
                && let Target::Tab(tab) = &targets[gone]
            {
                return fail(format!("{} was closed while you waited.", label(tab)));
            }
            let summaries: Vec<Summary> = join::all(
                current
                    .iter()
                    .zip(ids)
                    .map(|(target, id)| {
                        join::boxed(async move {
                            match target {
                                Some(Target::Tab(tab)) => {
                                    self.session_summary(caller, tab, per_answer).await
                                }
                                _ => Ok(saved.get(id).cloned().unwrap_or(Summary {
                                    settled: true,
                                    text: String::new(),
                                })),
                            }
                        })
                    })
                    .collect(),
            )
            .await
            .into_iter()
            .collect::<R<Vec<_>>>()?;
            let done = summaries.iter().filter(|summary| summary.settled).count();
            let ready = if args.until.as_deref() == Some("any") {
                done > 0
            } else {
                done == summaries.len()
            };
            let timed_out = Instant::now() >= deadline;
            let waiting = args.wait == Some(true);
            // A steer or report reached the waiting session: the call ends so it is read at its next step.
            let woken =
                waiting && !ready && !timed_out && self.arrivals(&caller.tab_id) > arrived_before;
            if !waiting || ready || timed_out || woken {
                // The opener has the answer now: the session may close once its work landed.
                {
                    let mut mem = self.mem();
                    for (summary, target) in summaries.iter().zip(&current) {
                        if let (true, Some(Target::Tab(tab))) = (summary.settled, target) {
                            mem.collected.insert(tab.tab_id.clone());
                        }
                    }
                }
                let note = if woken {
                    format!(
                        "Returned early: a message reached you while you waited (a steer or a report), so you read it at your next step. {done}/{} finished so far; call ompdesk_session_result again to keep waiting.\n",
                        summaries.len()
                    )
                } else if waiting && timed_out && !ready {
                    format!(
                        "Still running after waiting {seconds} s ({done}/{} finished).\n",
                        summaries.len()
                    )
                } else {
                    String::new()
                };
                return Ok(format!(
                    "{note}{}",
                    summaries
                        .iter()
                        .map(|summary| summary.text.as_str())
                        .collect::<Vec<_>>()
                        .join("\n\n")
                ));
            }
            let left = deadline.saturating_duration_since(Instant::now());
            tokio::select! {
                () = self.host.next_change(
                    left.as_millis().min(u128::from(self.tuning.poll_ms)) as u64
                ) => {}
                () = arrived => {}
            }
        }
    }

    /// `ompdesk_session_read` of an open session (`#read`).
    pub(in crate::agentctl::service) async fn read(
        &self,
        target: &ControlTab,
        args: &ReadArgs,
    ) -> R<String> {
        // Nobody calls: a hidden session is hidden from every caller.
        let nobody = ControlTab {
            tab_id: String::new(),
            ..target.clone()
        };
        self.refuse_hidden(target, &nobody)?;
        if !target.status.is_up() {
            // A tab with no omp (deferred after a relaunch, asleep): its saved file on the computer it runs on
            // answers, and nothing starts it.
            if let Some(path) = target
                .session_path
                .as_deref()
                .filter(|path| !path.is_empty())
            {
                return self.read_stored(&self.tab_row(target, path), args).await;
            }
            return fail(format!(
                "{} has not started; there is no transcript to read yet.",
                label(target)
            ));
        }
        let limit = args.limit.unwrap_or(READ_DEFAULT_MESSAGES);
        let ask = |cursor: Option<&str>| {
            let command = match cursor {
                Some(cursor) if !cursor.is_empty() => {
                    json!({ "type": "get_transcript_page", "cursor": cursor, "limit": limit })
                }
                _ => json!({ "type": "get_transcript_page", "fromEnd": true, "limit": limit }),
            };
            self.over_link(target.device.as_deref(), move || {
                let command = command.clone();
                async move {
                    let response = self
                        .host
                        .command(&target.tab_id, &command, Deadline::Ms(30_000))
                        .await?;
                    if !response.success && response.code.as_deref() == Some("remote_offline") {
                        return Err(super::fail::Fail::other(format!(
                            "[remote_offline] {}",
                            response.error.as_deref().unwrap_or("undefined")
                        )));
                    }
                    Ok(response)
                }
            })
        };
        let mut response = ask(args.before.as_deref()).await?;
        // A cursor names a page of the transcript as it was: one more message since makes it stale
        // (`stale_cursor`), and the index a saved read returned is none of a live tab's. The newest page answers
        // instead of a failure.
        let restarted = !response.success && args.before.is_some();
        if restarted {
            response = ask(None).await?;
        }
        let data = response_data(&response, "Reading the transcript")?;
        let Some(page) = transcript_page(&data) else {
            return fail("The transcript page came back empty.");
        };
        self.mem().collected.insert(target.tab_id.clone());
        Ok(render_page(
            &label(target),
            &target.tab_id,
            &page.messages,
            page.total_messages,
            page.prev_cursor.as_deref(),
            restarted
                .then(|| stale_cursor_note(args.before.as_deref()))
                .as_deref(),
        ))
    }

    /// `ompdesk_session_read` of a saved session (`#readStored`): paged from its end; the cursor is the index of the
    /// page's first message. The header says where it is open as the stored list does, read again now: a listed row
    /// says only what was true then. A cursor that is no index of this transcript (past its end, or the cursor a read
    /// of its open tab returned) restarts from the newest page.
    pub(in crate::agentctl::service) async fn read_stored(
        &self,
        row: &StoredSession,
        args: &ReadArgs,
    ) -> R<String> {
        if row.hidden {
            return fail("The user hid this session from other agents.");
        }
        let (messages, now) = tokio::join!(
            self.over_link(row.device.as_deref(), || self.host.stored_messages(row)),
            async {
                if row.tab_id.is_some() {
                    row.clone()
                } else {
                    self.current_row(row).await
                }
            }
        );
        let messages = messages?;
        // The row a closed tab's id resolved to says what was true when it closed; the list says what is true now.
        if now.hidden {
            return fail("The user hid this session from other agents.");
        }
        let limit = args.limit.unwrap_or(READ_DEFAULT_MESSAGES);
        let asked: Option<f64> = args
            .before
            .as_deref()
            .filter(|before| !before.is_empty() && before.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|before| before.parse().ok());
        let restarted = args.before.is_some()
            && match asked {
                None => true,
                Some(asked) => asked > messages.len() as f64,
            };
        let end = match asked {
            Some(asked) if !restarted => asked as usize,
            _ => messages.len(),
        };
        let start = end.saturating_sub(limit);
        let open = match &now.tab_id {
            Some(tab_id) => format!("open in tab {tab_id}"),
            None => {
                let step = if now.elsewhere.as_ref().and_then(|open| open.work)
                    == Some(super::types::StoredWork::Turn)
                {
                    current_step(&messages)
                } else {
                    None
                };
                let text = open_elsewhere_text(&now, step.as_deref());
                if text.is_empty() {
                    "not open".to_owned()
                } else {
                    text
                }
            }
        };
        let title = format!(
            "\"{}\" (saved{}, {open})",
            one_line(&stored_title(row), 80),
            row.device_name
                .as_deref()
                .filter(|name| !name.is_empty())
                .map_or_else(String::new, |name| format!(" on {name}"))
        );
        let prev = (start > 0).then(|| number(start as f64));
        Ok(render_page(
            &title,
            &row.id,
            &messages[start..end],
            messages.len(),
            prev.as_deref(),
            restarted
                .then(|| stale_cursor_note(args.before.as_deref()))
                .as_deref(),
        ))
    }
}
