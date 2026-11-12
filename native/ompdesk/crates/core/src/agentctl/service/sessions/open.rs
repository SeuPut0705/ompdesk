//! `ompdesk_session_open`: `#openCommands`, `#resolveModel`, `#openMany`, `#openOne`, `#openText`, `#ensureStarted`
//! and the public `openSessions`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::time::Instant;

use super::{CloseHow, TabClose};
use crate::agentctl::service::AgentControl;
use crate::agentctl::service::fail::{Fail, R, fail};
use crate::agentctl::service::host::Deadline;
use crate::agentctl::service::js::one_line;
use crate::agentctl::service::resolve::{DeviceScope, Wanted};
use crate::agentctl::service::text::{
    folder_key, label, open_in_text, response_data, saved_id_of_path, start_failure,
    unreached_text, with_dispatch,
};
use crate::agentctl::service::types::{
    ChildWorktree, ControlDevice, ControlTab, ModelInfo, OpenArgs, OpenOne, OpenedChild,
    RpcResponse, SpawnRequest, SpawnWorktree, StoredSession, WorktreeArg, WorktreeRemoval,
};
use crate::agentctl::service::wrap::{agent_task_title, wrap_agent_message};

/// One session of an open, as it came out: its tab and what was set up, or why it did not open.
#[derive(Clone, Debug, Default)]
pub struct OpenResult {
    /// "" when the session did not open.
    pub tab_id: String,
    pub error: Option<String>,
    pub notes: Vec<String>,
    pub worktree: Option<String>,
    pub started: bool,
    /// Where it opened: its folder, and the computer when that is a paired one.
    pub where_: Option<String>,
}

/// The commands of an open (worker marker, model, plan mode, first message or goal) to one child, none with a
/// deadline (`#openCommands`).
pub struct OpenCommand<'a> {
    control: &'a AgentControl,
    tab_id: &'a str,
    caller_tab_id: &'a str,
    until: Option<Instant>,
}

static RESERVED: AtomicU64 = AtomicU64::new(0);

impl AgentControl {
    /// The commands of an open to the child `tab_id`. None has a deadline (the owner's rule: no fixed time limit ends
    /// work as an error): a command is waited for as long as the child lives, and only a child that closed, exited or
    /// failed ends it, with the reason its omp gave. A child that answers `sidecar_not_ready` or
    /// `sidecar_not_connected` is briefly not ready: wait for its status to read ready again (an `error` for at most
    /// `open_ready_retry_ms`), then send the command once more.
    pub(in crate::agentctl::service) fn open_commands<'a>(
        &'a self,
        tab_id: &'a str,
        caller_tab_id: &'a str,
    ) -> OpenCommand<'a> {
        OpenCommand {
            control: self,
            tab_id,
            caller_tab_id,
            until: None,
        }
    }

    /// `#resolveModel`: `wanted` is a `provider/id`, a model id, or one of the person's model roles (`task`, `smol`,
    /// ...: stock's `modelRoles` in config.yml, read through the caller's omp at open time), which names what that
    /// role runs on now. Never a model id written down anywhere in OMPdesk (the owner's rule, 4 Nov 2026).
    async fn resolve_model(&self, send: &mut OpenCommand<'_>, wanted: &str) -> R<ModelInfo> {
        let answer = send.send(json!({ "type": "get_available_models" })).await?;
        let data = response_data(&answer, "Reading the model list")?;
        let models: Vec<ModelInfo> = data
            .get("models")
            .and_then(Value::as_array)
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| serde_json::from_value(model.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();
        let lowered = wanted.to_lowercase();
        let named = |model: &ModelInfo| format!("{}/{}", model.provider, model.id);
        if !wanted.contains('/') {
            let answer = send
                .send(json!({ "type": "get_model_roles", "compact": true }))
                .await?;
            let roles = response_data(&answer, "Reading the model roles")?;
            let role = roles
                .get("roles")
                .and_then(Value::as_array)
                .and_then(|roles| {
                    roles.iter().find(|entry| {
                        entry
                            .get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| id.to_lowercase() == lowered)
                    })
                });
            if let Some(role) = role {
                let id = role.get("id").and_then(Value::as_str).unwrap_or("");
                let selector = role
                    .pointer("/effective/model")
                    .and_then(Value::as_str)
                    .or_else(|| role.get("model").and_then(Value::as_str))
                    .filter(|selector| !selector.is_empty());
                let found = selector.and_then(|selector| {
                    models
                        .iter()
                        .find(|model| named(model).to_lowercase() == selector.to_lowercase())
                });
                if let Some(found) = found {
                    return Ok(found.clone());
                }
                return fail(match selector {
                    Some(selector) => format!(
                        "The {id} role is set to \"{selector}\", which no available model matches. Fix the role in Settings › Models, or give provider/id."
                    ),
                    None => format!(
                        "The {id} role names no model. Set it in Settings › Models, or give provider/id."
                    ),
                });
            }
        }
        if let Some(exact) = models
            .iter()
            .find(|model| named(model).to_lowercase() == lowered)
        {
            return Ok(exact.clone());
        }
        let by_id: Vec<&ModelInfo> = models
            .iter()
            .filter(|model| model.id.to_lowercase() == lowered)
            .collect();
        if by_id.len() == 1 {
            return Ok(by_id[0].clone());
        }
        let near: Vec<String> = models
            .iter()
            .filter(|model| named(model).to_lowercase().contains(&lowered))
            .take(8)
            .map(named)
            .collect();
        fail(if by_id.len() > 1 {
            format!(
                "Model \"{wanted}\" is offered by several providers: {}. Give provider/id.",
                by_id
                    .iter()
                    .map(|model| named(model))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        } else if near.is_empty() {
            format!("No model \"{wanted}\". Use provider/id as the model picker lists it.")
        } else {
            format!("No model \"{wanted}\". Close matches: {}.", near.join(", "))
        })
    }

    /// What `opened` (the caller's set of tabs it opened) gains: a tab, or a reservation for one still starting.
    fn opened_add(&self, caller_tab_id: &str, id: &str) {
        let mut mem = self.mem();
        let set = mem.opened.entry(caller_tab_id.to_owned()).or_default();
        if !set.iter().any(|held| held == id) {
            set.push(id.to_owned());
        }
    }

    fn opened_delete(&self, caller_tab_id: &str, id: &str) {
        if let Some(set) = self.mem().opened.get_mut(caller_tab_id) {
            set.retain(|held| held != id);
        }
    }

    /// `#openMany`: every session of an open, at once; one that fails is a result with an error, never a failure of
    /// the others.
    pub(in crate::agentctl::service) async fn open_many(
        &self,
        caller: &ControlTab,
        tabs: &[ControlTab],
        items: &[OpenOne],
        show: Option<&str>,
        tag: Option<&str>,
    ) -> R<Vec<OpenResult>> {
        if self.stopping(&caller.tab_id) {
            return fail("Autopilot is ending: start nothing new.");
        }
        // Read for what it records (the tabs main kept the opener of), before the reservations are added.
        let _ = self.opened_by(&self.host.state(), &caller.tab_id, tabs);
        // Marked before the first await, so "opened by you" covers sessions still starting.
        let reservations: Vec<String> = items
            .iter()
            .map(|_| {
                format!(
                    "pending:{}-{}",
                    RESERVED.fetch_add(1, Ordering::Relaxed),
                    self.now()
                )
            })
            .collect();
        for key in &reservations {
            self.opened_add(&caller.tab_id, key);
        }
        let outcomes = crate::agentctl::service::util::join::all(
            items
                .iter()
                .zip(&reservations)
                .map(|(item, reservation)| {
                    crate::agentctl::service::util::join::boxed(self.open_one(
                        caller,
                        item,
                        reservation,
                        tag,
                    ))
                })
                .collect(),
        )
        .await;
        let results: Vec<OpenResult> = outcomes
            .into_iter()
            .map(|outcome| match outcome {
                Ok(result) => result,
                Err(error) => OpenResult {
                    error: Some(error.message()),
                    ..OpenResult::default()
                },
            })
            .collect();
        let first = results.iter().find(|result| !result.tab_id.is_empty());
        if let (Some(show), Some(first)) = (show, first)
            && show != "background"
        {
            self.host.view(&caller.tab_id, &first.tab_id, show, false);
        }
        let state = self.host.state();
        let live = state.tabs(&caller.tab_id);
        Ok(results
            .into_iter()
            .map(|result| {
                let tab = if result.tab_id.is_empty() {
                    None
                } else {
                    live.as_ref()
                        .and_then(|tabs| tabs.iter().find(|entry| entry.tab_id == result.tab_id))
                };
                let where_ = tab.map(|tab| {
                    format!(
                        "{}{}",
                        tab.cwd,
                        tab.device_name
                            .as_deref()
                            .filter(|name| !name.is_empty())
                            .map_or_else(String::new, |name| format!(" on {name}"))
                    )
                });
                OpenResult { where_, ..result }
            })
            .collect())
    }

    /// `#openOne`.
    async fn open_one(
        &self,
        caller: &ControlTab,
        args: &OpenOne,
        reservation: &str,
        tag: Option<&str>,
    ) -> R<OpenResult> {
        let worktree_arg: Option<SpawnWorktree> = match &args.worktree {
            Some(WorktreeArg::Flag(true)) => Some(SpawnWorktree::default()),
            Some(WorktreeArg::Flag(false)) | None => None,
            Some(WorktreeArg::Spec(spec)) => Some(spec.clone()),
        };
        // `device`: absent, this computer (`Some(None)`) or a paired host.
        let mut device: Option<Option<String>> = None;
        let mut target: DeviceScope = None;
        if let Some(name) = &args.device {
            let named = self.device(name)?;
            let reached: Option<ControlDevice> = match named {
                Some(named) => Some(self.reach(named).await?),
                None => None,
            };
            device = Some(reached.as_ref().map(|device| device.id.clone()));
            target = Some(reached);
        }
        let mut session_path: Option<String> = None;
        // The saved session a reopen names.
        let mut reopened: Option<StoredSession> = None;
        // A reopen of a session open in a tab elsewhere: where, as the lists say it. It joins that tab (`join`).
        let mut joined: Option<String> = None;
        if let Some(reopen) = args.reopen.as_deref().filter(|reopen| !reopen.is_empty()) {
            let (found, unreached) = self.stored_session(reopen, target.as_ref()).await?;
            let Some(row) = found else {
                return fail(format!(
                    "No saved session \"{reopen}\" {}{}. List them with ompdesk_sessions {{\"scope\":\"stored\"}} (with device for a paired device's).",
                    match &target {
                        Some(Some(target)) => format!("on {}", target.name),
                        Some(None) => "on this computer".to_owned(),
                        None => "on this computer or a paired device".to_owned(),
                    },
                    unreached_text(&unreached)
                ));
            };
            if row.hidden {
                return fail("The user hid that session from other agents.");
            }
            let now = self.current_row(&row).await;
            let open = self.live_tab(
                &self.host.state().tabs(&caller.tab_id).unwrap_or_default(),
                &now,
            );
            if let Some(open) = open {
                return fail(format!(
                    "That session is already open as {}: use it directly (ompdesk_session_send, ompdesk_session_read).",
                    open.tab_id
                ));
            }
            if let Some(asked) = &device
                && *asked != row.device
            {
                return fail(
                    "A saved session opens on the device it is saved on; leave device out with reopen.",
                );
            }
            if let Some(elsewhere) = &now.elsewhere {
                let computer = match now.device.as_deref().filter(|device| !device.is_empty()) {
                    Some(device) => now.device_name.as_deref().unwrap_or(device),
                    None => "this computer",
                };
                joined = Some(open_in_text(computer, elsewhere.holder.as_deref()));
            }
            if let (Some(joined), Some(true)) = (&joined, args.throwaway) {
                return fail(format!(
                    "That session is {joined}: it is not yours to throw away. Reopen it without throwaway."
                ));
            }
            let home = row
                .device
                .as_deref()
                .and_then(|id| self.host.state().device(id).cloned());
            if let Some(home) = home {
                self.reach(home).await?;
            }
            // It opens in the folder it worked in, never another: the same folder named again is no conflict.
            if let Some(folder) = &args.folder
                && folder_key(folder) != folder_key(&row.cwd)
            {
                return fail(format!(
                    "A saved session opens in the folder it worked in ({}), never another: leave folder out with reopen. To work in {folder}, open a new session there and name this one in its brief (its transcript: ompdesk_session_read {{\"session\":\"{}\"}}).",
                    row.cwd, row.id
                ));
            }
            session_path = Some(row.path.clone());
            device = Some(row.device.clone());
            reopened = Some(row);
        }
        // Its row reads as the work it was opened for from its first frame, not "New session" until stock names it.
        let task = match (&args.message, &session_path) {
            (Some(message), None) if !message.is_empty() => {
                agent_task_title(&wrap_agent_message(message, &caller.title, None))
            }
            _ => None,
        };
        let spawned = self
            .host
            .spawn(
                &caller.tab_id,
                &SpawnRequest {
                    folder: if session_path.is_some() {
                        None
                    } else {
                        args.folder.clone()
                    },
                    worktree: worktree_arg,
                    device,
                    session_path: session_path.clone(),
                    restore_saved: session_path.is_some() && args.restore == Some(true),
                    tag: tag.filter(|tag| !tag.is_empty()).map(str::to_owned),
                    task,
                    join: joined.is_some(),
                },
            )
            .await;
        self.opened_delete(&caller.tab_id, reservation);
        let spawned = match spawned {
            Ok(spawned) => spawned,
            Err(Fail::FolderMissing { folder, saved }) => {
                let (Some(reopen), Some(reopened)) = (args.reopen.as_deref(), &reopened) else {
                    return Err(Fail::FolderMissing { folder, saved });
                };
                if reopen.is_empty() {
                    return Err(Fail::FolderMissing { folder, saved });
                }
                return fail(self.folder_gone(
                    &folder,
                    saved.as_ref(),
                    reopen,
                    &reopened.path,
                    reopened.device.as_deref(),
                    Wanted::Reopen,
                ));
            }
            Err(error) => return Err(error),
        };
        let tab_id = spawned.tab_id.clone();
        let worktree = spawned.worktree.clone();
        // A session joined where it is open stays whoever's it was: never "opened by you".
        if joined.is_none() {
            self.opened_add(&caller.tab_id, &tab_id);
        }
        if let Some(key) = crate::agentctl::service::call_key()
            && let Some(mut journal) = self.calls()
            && let Err(error) = journal.note(&key, &tab_id)
        {
            eprintln!("[call-journal] opened tab not noted: {error}");
        }
        let set_up = self
            .set_up(
                caller,
                args,
                &tab_id,
                &spawned.worktree,
                spawned.prepared.as_deref(),
                session_path.is_some(),
                joined.as_deref(),
                tag,
            )
            .await;
        let error = match set_up {
            Ok(result) => return Ok(result),
            Err(error) => error,
        };
        // A child that cannot be set up does not linger half-configured, nor does the worktree made for it.
        self.opened_delete(&caller.tab_id, &tab_id);
        self.mem().throwaway.remove(&tab_id);
        let tab_device = self
            .host
            .state()
            .tabs(&caller.tab_id)
            .and_then(|tabs| tabs.into_iter().find(|tab| tab.tab_id == tab_id))
            .and_then(|tab| tab.device);
        let Some(made) = worktree else {
            // Closed in the background: the caller is not kept waiting for a tab that is going.
            let control = self.clone();
            let (caller_id, closing_id) = (caller.tab_id.clone(), tab_id.clone());
            let wait_ms = self.tuning.close_wait_ms;
            tokio::spawn(async move {
                let _ = control
                    .close_tab(
                        &caller_id,
                        &closing_id,
                        CloseHow {
                            auto: false,
                            wait_ms,
                            cleared: false,
                        },
                    )
                    .await;
            });
            return Err(error);
        };
        let message = error.message();
        // Its worktree goes only once the tab is gone and its omp has exited (it works there until then): a tab
        // still open (the window kept it, or it is slow to close) works there, so the worktree stays and is named.
        let closed = self
            .close_tab(
                &caller.tab_id,
                &tab_id,
                CloseHow {
                    auto: false,
                    wait_ms: self.tuning.close_wait_ms,
                    cleared: false,
                },
            )
            .await
            .unwrap_or(TabClose::Kept);
        if closed != TabClose::Closed {
            return Err(Fail::other(format!(
                "{message} (its tab is still open, so its worktree {} and branch {} were kept)",
                made.path, made.branch
            )));
        }
        let removal = self
            .host
            .discard_worktree(&made.reference(), tab_device.as_deref())
            .await
            .ok()
            .flatten();
        if removal == Some(WorktreeRemoval::Removed) {
            return Err(error);
        }
        Err(Fail::other(match removal {
            Some(WorktreeRemoval::BranchKept) => format!(
                "{message} (its worktree {} was removed; git kept the branch {})",
                made.path, made.branch
            ),
            _ => format!(
                "{message} (git kept its worktree {} and branch {}: something changed there or it is in use)",
                made.path, made.branch
            ),
        }))
    }

    /// The part of `#openOne` that can fail once the tab exists: wait for it, set it up, send its first message.
    #[allow(clippy::too_many_arguments)]
    async fn set_up(
        &self,
        caller: &ControlTab,
        args: &OpenOne,
        tab_id: &str,
        worktree: &Option<crate::agentctl::service::types::TabWorktree>,
        prepared: Option<&str>,
        reopened: bool,
        joined: Option<&str>,
        tag: Option<&str>,
    ) -> R<OpenResult> {
        self.when_ready(tab_id, &caller.tab_id, None).await?;
        let mut send = self.open_commands(tab_id, &caller.tab_id);
        let mut notes: Vec<String> = Vec::new();
        // Journaled in the child, so its main agent gets the worker contract (gui-bridge agent-control.ts) from its
        // first turn on, across relaunches; a session the user opened (and reopened here) never carries it.
        if let Some(joined) = joined {
            notes.push(format!(
                "joined: it is {joined}, so this tab views that one (no second omp, not your child)"
            ));
        } else if reopened {
            notes.push("reopened".to_owned());
        } else {
            let from = if caller.title.is_empty() {
                "another session"
            } else {
                &caller.title
            };
            let answer = send
                .send(json!({ "type": "agent_control_worker", "from": from }))
                .await?;
            response_data(&answer, "Marking the session as a worker")?;
        }
        if let Some(wanted) = args.model.as_deref().filter(|model| !model.is_empty()) {
            let model = self.resolve_model(&mut send, wanted).await?;
            let answer = send
                .send(
                    json!({ "type": "set_model", "provider": model.provider, "modelId": model.id }),
                )
                .await?;
            response_data(&answer, "Setting the model")?;
            notes.push(format!("model {}/{}", model.provider, model.id));
        }
        if args.mode.as_deref() == Some("plan") {
            let answer = send
                .send(json!({ "type": "set_plan_mode", "enabled": true }))
                .await?;
            response_data(&answer, "Turning on plan mode")?;
            notes.push("plan mode".to_owned());
        }
        if let Some(worktree) = worktree {
            notes.push(format!("worktree {}", worktree.branch));
        }
        if let Some(prepared) = prepared.filter(|prepared| !prepared.is_empty()) {
            notes.push(prepared.to_owned());
        }
        self.host
            .before_first_prompt(&OpenedChild {
                tab_id: tab_id.to_owned(),
                caller_tab_id: caller.tab_id.clone(),
                worktree: worktree.as_ref().map(|worktree| ChildWorktree {
                    path: worktree.path.clone(),
                    branch: worktree.branch.clone(),
                }),
                tag: tag.filter(|tag| !tag.is_empty()).map(str::to_owned),
            })
            .await?;
        // Before its first message: a quick lookup may end before this call returns.
        if args.throwaway == Some(true) {
            self.mem().throwaway.insert(tab_id.to_owned());
            notes.push(
                "throwaway: closed and deleted once its Result: ok answer reaches you".to_owned(),
            );
        }
        if let Some(message) = args
            .message
            .as_deref()
            .filter(|message| !message.is_empty())
        {
            if args.mode.as_deref() == Some("goal") {
                // The goal command starts the objective turn itself.
                let answer = send
                    .send(json!({ "type": "set_goal", "objective": message }))
                    .await?;
                response_data(&answer, "Setting the goal")?;
                notes.push("goal set".to_owned());
            } else {
                let dispatch = self.mailbox.dispatch(tab_id);
                let answer = send
                    .send(json!({
                        "type": "prompt",
                        "message": wrap_agent_message(
                            &with_dispatch(message, Some(&dispatch), None),
                            &caller.title,
                            saved_id_of_path(caller.session_path.as_deref()).as_deref(),
                        ),
                        "streamingBehavior": "followUp",
                    }))
                    .await?;
                response_data(&answer, "Sending the first message")?;
            }
        }
        Ok(OpenResult {
            tab_id: tab_id.to_owned(),
            error: None,
            notes,
            worktree: worktree.as_ref().map(|worktree| worktree.branch.clone()),
            started: args.message.is_some(),
            where_: None,
        })
    }

    /// `#openText`.
    fn open_text(results: &[OpenResult]) -> String {
        let mut lines: Vec<String> = results
            .iter()
            .map(|result| {
                if result.tab_id.is_empty() {
                    return format!(
                        "Could not open a session: {}",
                        result.error.as_deref().unwrap_or("undefined")
                    );
                }
                format!(
                    "Opened session {}{}{}. {}",
                    result.tab_id,
                    result
                        .where_
                        .as_ref()
                        .map_or_else(String::new, |where_| format!(" in {where_}")),
                    if result.notes.is_empty() {
                        String::new()
                    } else {
                        format!(" ({})", result.notes.join(", "))
                    },
                    if result.started {
                        "It is working on your message.".to_owned()
                    } else {
                        format!(
                            "It is idle; give it work with ompdesk_session_send {{\"session\":\"{}\",\"message\":\"…\"}}.",
                            result.tab_id
                        )
                    }
                )
            })
            .collect();
        let ids: Vec<&str> = results
            .iter()
            .filter(|result| !result.tab_id.is_empty())
            .map(|result| result.tab_id.as_str())
            .collect();
        if !ids.is_empty() && results.iter().any(|result| result.started) {
            lines.push(format!(
                "They report back to you with ompdesk_report (done, question): end your turn and you are woken. To block now instead: ompdesk_session_result {{\"sessions\":{},\"wait\":true}}.",
                serde_json::to_string(&ids).unwrap_or_default()
            ));
        }
        lines.join("\n")
    }

    /// `ompdesk_session_open`: the `T.open` arm of `#dispatch`.
    pub(in crate::agentctl::service) async fn open_tool(
        &self,
        caller: &ControlTab,
        tabs: &[ControlTab],
        args: OpenArgs,
    ) -> R<String> {
        let OpenArgs {
            sessions,
            show,
            single,
        } = args;
        let items = sessions.unwrap_or_else(|| vec![single]);
        let results = self
            .open_many(caller, tabs, &items, show.as_deref(), None)
            .await?;
        let text = Self::open_text(&results);
        if !results.iter().any(|result| !result.tab_id.is_empty()) {
            return fail(text);
        }
        Ok(text)
    }

    /// `openSessions`: the programmatic open (Autopilot): the same path as the tool, with a tag the tool never sets.
    pub async fn open_sessions(
        &self,
        caller_tab_id: &str,
        sessions: Vec<OpenOne>,
        tag: Option<String>,
    ) -> R<Vec<String>> {
        let Some(tabs) = self.host.state().tabs(caller_tab_id) else {
            return fail("This session's tab is gone.");
        };
        let Some(caller) = tabs.iter().find(|tab| tab.tab_id == caller_tab_id) else {
            return fail("This session's tab is gone.");
        };
        Ok(self
            .open_many(caller, &tabs, &sessions, None, tag.as_deref())
            .await?
            .into_iter()
            .map(|entry| entry.tab_id)
            .collect())
    }

    /// `#ensureStarted`: a tab that has no omp yet is started and waited for; a stopped one is the user's to restart.
    pub(in crate::agentctl::service) async fn ensure_started(
        &self,
        target: &ControlTab,
        caller_tab_id: &str,
    ) -> R<()> {
        if target.status.is_up() {
            return Ok(());
        }
        use crate::agentctl::service::types::TabStatus;
        if matches!(target.status, TabStatus::Error | TabStatus::Exited) {
            let why = target
                .failure
                .as_deref()
                .filter(|failure| !crate::agentctl::service::js::trim(failure).is_empty())
                .map_or_else(String::new, |failure| {
                    format!(": {}", one_line(failure, 300))
                });
            return fail(format!(
                "{} is stopped ({}{why}); the user has to restart it.",
                label(target),
                target.status.as_str()
            ));
        }
        if target.status == TabStatus::Asleep {
            self.host.start(&target.tab_id);
        }
        self.when_ready(&target.tab_id, caller_tab_id, None).await
    }
}

impl OpenCommand<'_> {
    /// Why the child can answer nothing any more, or None while it lives.
    fn ended(&self) -> Option<String> {
        use crate::agentctl::service::types::TabStatus;
        let tab = self
            .control
            .host
            .state()
            .tabs(self.caller_tab_id)
            .and_then(|tabs| tabs.into_iter().find(|entry| entry.tab_id == self.tab_id));
        let Some(tab) = tab else {
            return Some("The new session's tab closed before it was set up.".to_owned());
        };
        (tab.status == TabStatus::Exited || (tab.status == TabStatus::Error && !tab.session_held))
            .then(|| start_failure(&tab))
    }

    /// The command's answer, however long the child takes; a child that ended answers with why.
    async fn answer_of(&self, command: &Value) -> R<RpcResponse> {
        let answer = self
            .control
            .host
            .command(self.tab_id, command, Deadline::None);
        tokio::pin!(answer);
        loop {
            tokio::select! {
                settled = &mut answer => {
                    return match settled {
                        Ok(response) => Ok(response),
                        // An omp that died answers nothing more: its tab's status says so.
                        Err(error) => match self.ended() {
                            Some(why) => Ok(RpcResponse::refused(why)),
                            None => Err(error),
                        },
                    };
                }
                () = self.control.host.next_change(self.control.tuning.poll_ms) => {
                    if let Some(why) = self.ended() {
                        // The tab's status and main's answer to the command reach the core as two messages: a
                        // child whose command was refused because it is not ready reads `error` a moment before
                        // the refusal arrives. The answer, if it is on its way, says more than the status does.
                        let grace = Duration::from_millis(self.control.tuning.answer_grace_ms);
                        return match tokio::time::timeout(grace, &mut answer).await {
                            Ok(Ok(response)) => Ok(response),
                            _ => Ok(RpcResponse::refused(why)),
                        };
                    }
                }
            }
        }
    }

    /// One command of the open, sent again while the child is briefly not ready.
    pub async fn send(&mut self, command: Value) -> R<RpcResponse> {
        let tuning = &self.control.tuning;
        loop {
            let response = self.answer_of(&command).await?;
            if response.success {
                return Ok(response);
            }
            let said = response
                .error
                .clone()
                .unwrap_or_else(|| "No answer".to_owned());
            let because = |why: Option<String>| match why {
                Some(why) if !why.is_empty() && why != said => {
                    RpcResponse::refused(format!("{said}. {why}"))
                }
                _ => response.clone(),
            };
            if !matches!(
                response.code.as_deref(),
                Some("sidecar_not_ready" | "sidecar_not_connected")
            ) {
                return Ok(because(self.ended()));
            }
            let until = *self.until.get_or_insert_with(|| {
                Instant::now() + Duration::from_millis(tuning.open_ready_retry_ms)
            });
            if Instant::now() >= until {
                return Ok(because(self.ended()));
            }
            let left = until.saturating_duration_since(Instant::now());
            self.control
                .host
                .next_change(left.as_millis().min(u128::from(tuning.open_ready_pause_ms)) as u64)
                .await;
            if let Err(error) = self
                .control
                .when_ready(self.tab_id, self.caller_tab_id, Some(until))
                .await
            {
                return Ok(because(error.is_tool().then(|| error.message())));
            }
        }
    }
}
