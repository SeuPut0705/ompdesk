//! `ompdesk_app` inside the service: the `AppPorts` this service gives `AppControl` (`ServicePorts`), the route of an
//! action's command to another computer (`#rpcOn`) with the background session it may open (`#utilityTab`,
//! `#closeUtilityTabs`, `#discardUtility`), and the `T.app`, `T.appList` and `#appAutopilot` arms.

use std::sync::{Arc, Weak};

use serde_json::{Map, Value, json};

use super::super::fail::{Fail, R, fail};
use super::super::host::Deadline;
use super::super::sessions::CloseHow;
use super::super::types::{
    AppArgs, AppListArgs, AutopilotArgs, ControlDevice, ControlTab, RpcCommand, RpcResponse,
    SpawnRequest,
};
use super::super::util::{Flight, join};
use super::super::{AgentControl, Inner, TAB_GONE};
use crate::agentctl::app::control::is_refusal;
use crate::agentctl::app::ports::{AppPorts, RpcResponse as AppResponse, SidebarView};
use crate::agentctl::app::{AppControl, catalog};
use crate::ports::PortError;
use crate::server::Fault;

/// `timeoutForCommand` (`RPC_COMMAND_TIMEOUTS` of `src/shared/rpc-client.ts`): the commands that resolve only after
/// long work get a window as large as their own budget; the others have none of their own.
pub fn command_timeout(kind: &str) -> Option<u64> {
    Some(match kind {
        "bash" | "eval" | "compact" | "handoff" | "plan_approval" | "switch_leaf" | "login" => {
            660_000
        }
        "set_model"
        | "cycle_model"
        | "get_transcript"
        | "get_transcript_page"
        | "get_subagent_messages"
        | "get_subagent_transcript"
        | "steer_subagent" => 30_000,
        "export_html"
        | "dump_session_archive"
        | "reload_plugins"
        | "redeem_reset_pass"
        | "pr_repo" => 120_000,
        "get_provider_accounts" | "get_usage" => 60_000,
        "worktree_create" | "restore_saved_worktree" => 960_000,
        "worktree_remove" | "git_commit" | "git_remote" | "git_stash" | "git_operation"
        | "git_branch" | "git_history_action" => 360_000,
        "pr_list" | "pr_get" | "pr_diff" | "pr_review" | "pr_comment" | "pr_edit" => 180_000,
        "pr_draft" => 650_000,
        "pr_create" | "pr_merge" => 230_000,
        "pr_checkout" => 770_000,
        "pr_comments" | "git_commit_message" => 240_000,
        "github" => 730_000,
        "git_stage"
        | "git_unstage"
        | "git_last_commit_message"
        | "git_undo_commit"
        | "git_branches"
        | "git_commit_detail"
        | "git_commit_diff" => 70_000,
        "git_discard" | "git_log" => 130_000,
        _ => return None,
    })
}

/// A failure as what a port's ask answers with.
fn port_error(error: Fail) -> PortError {
    let code = match &error {
        Fail::Other { code, .. } => code.clone(),
        _ => None,
    };
    PortError {
        message: error.message(),
        code,
    }
}

/// A fault of `AppControl` as the failure the tool ends in: a refusal is the agent's own message.
fn fail_of(fault: Fault) -> Fail {
    if is_refusal(&fault) {
        Fail::Tool(fault.message)
    } else {
        Fail::Other {
            message: fault.message,
            code: Some(fault.code.into_owned()),
        }
    }
}

fn app_response(response: RpcResponse) -> AppResponse {
    AppResponse {
        success: response.success,
        data: response.data,
        error: response.error,
    }
}

/// `AppPorts` of this service: what `host.ts`' `appPorts` answered, over the service's own host (main's asks and
/// tells) and its snapshot, plus `autopilot` and `rpcOn`, which are this service's own. Holds the service weakly: the
/// service owns its `AppControl`.
pub struct ServicePorts {
    service: Weak<Inner>,
}

impl ServicePorts {
    fn control(&self) -> Result<AgentControl, PortError> {
        self.service
            .upgrade()
            .map(AgentControl)
            .ok_or_else(|| PortError {
                message: "the agent-control service closed".to_owned(),
                code: Some("port_closed".to_owned()),
            })
    }
}

impl AppPorts for ServicePorts {
    async fn refresh(&self) -> Result<(), PortError> {
        self.control()?.host.fresh().await.map_err(port_error)?;
        Ok(())
    }

    fn manage_enabled(&self) -> bool {
        self.control()
            .is_ok_and(|control| control.host.state().app.manage)
    }

    fn full_enabled(&self) -> bool {
        self.control()
            .is_ok_and(|control| control.host.state().app.full)
    }

    fn localize(&self, en: &str, ko: &str) -> String {
        let korean = self
            .control()
            .is_ok_and(|control| control.host.state().app.korean);
        (if korean { ko } else { en }).to_owned()
    }

    fn sidebar_view(&self) -> SidebarView {
        self.control()
            .map(|control| control.host.state().app.sidebar.clone())
            .unwrap_or_default()
    }

    async fn get_pref(&self, key: &str) -> Result<Option<Value>, PortError> {
        self.control()?
            .host
            .app_get_pref(key)
            .await
            .map_err(port_error)
    }

    async fn device(&self, caller: &str) -> Result<Option<String>, PortError> {
        let state = self.control()?.host.state();
        Ok(state
            .tabs
            .iter()
            .find(|tab| tab.tab_id == caller)
            .and_then(|tab| tab.device.clone()))
    }

    async fn set_pref(&self, caller: &str, key: &str, value: &Value) -> Result<(), PortError> {
        self.control()?
            .host
            .app_set_pref(caller, key, value)
            .await
            .map_err(port_error)
    }

    async fn rpc(&self, caller: &str, command: &Value) -> Result<AppResponse, PortError> {
        self.control()?
            .host
            .app_rpc(caller, command)
            .await
            .map(app_response)
            .map_err(port_error)
    }

    async fn rpc_on(
        &self,
        caller: &str,
        device: &str,
        command: &Value,
    ) -> Result<AppResponse, PortError> {
        self.control()?
            .rpc_on(caller, device, command)
            .await
            .map(app_response)
            .map_err(port_error)
    }

    async fn invoke(
        &self,
        caller: &str,
        channel: &str,
        args: &[Value],
    ) -> Result<Value, PortError> {
        self.control()?
            .host
            .app_invoke(caller, channel, args)
            .await
            .map_err(port_error)
    }

    fn fire(&self, caller: &str, channel: &str, args: &[Value]) {
        if let Ok(control) = self.control() {
            control.host.app_fire(caller, channel, args);
        }
    }

    fn send(&self, caller: &str, event: &Value) {
        if let Ok(control) = self.control() {
            control.host.app_send(caller, event);
        }
    }

    async fn confirm(&self, caller: &str, title: &str, message: &str) -> Result<bool, PortError> {
        self.control()?
            .host
            .confirm(caller, title, message)
            .await
            .map_err(port_error)
    }

    async fn note(&self, caller: &str, text: &str) -> Result<(), PortError> {
        self.control()?
            .host
            .app_note(caller, text)
            .await
            .map_err(port_error)
    }

    async fn text(&self, key: &str, params: &[(&str, &str)]) -> Result<String, PortError> {
        Ok(self.control()?.host.state().text(key, params))
    }

    async fn open_privacy_pane(&self, pane: &str) -> Result<(), PortError> {
        self.control()?
            .host
            .app_open_privacy_pane(pane)
            .await
            .map_err(port_error)
    }

    async fn caller_title(&self, caller: &str) -> Result<String, PortError> {
        let state = self.control()?.host.state();
        if let Some(outside) = state.outside_callers.get(caller) {
            return Ok(outside.title.clone());
        }
        let title = state
            .tabs
            .iter()
            .find(|tab| tab.tab_id == caller)
            .map(|tab| tab.title.as_str())
            .filter(|title| !title.is_empty());
        Ok(title.unwrap_or("this session").to_owned())
    }

    async fn autopilot(&self, caller: &str, args: &Value) -> Result<String, PortError> {
        self.control()?
            .app_autopilot(caller, args)
            .await
            .map_err(port_error)
    }
}

impl AgentControl {
    /// `#appControl`: the `ompdesk_app` control, built at its first use; where main has no app ports there is none.
    pub(crate) fn app_control(&self) -> R<&AppControl<ServicePorts>> {
        if !self.host.caps().app_ports {
            return fail("App actions are not available here.");
        }
        Ok(self.app.get_or_init(|| {
            AppControl::new(
                ServicePorts {
                    service: Arc::downgrade(&self.0),
                },
                catalog::shipped(),
            )
        }))
    }

    /// `this.#app?.released(tabId)`: a session closed, so its undo is gone.
    pub(crate) fn app_released(&self, tab_id: &str) {
        if let Some(app) = self.app.get() {
            app.released(tab_id);
        }
    }

    /// `ompdesk_app_list`.
    pub(crate) async fn app_list(&self, args: AppListArgs) -> R<String> {
        let app = self.app_control()?;
        let mut raw = Map::new();
        if let Some(area) = args.area {
            raw.insert("area".into(), json!(area));
        }
        if let Some(query) = args.query {
            raw.insert("query".into(), json!(query));
        }
        app.list(&Value::Object(raw)).await.map_err(fail_of)
    }

    /// `ompdesk_app`: the `T.app` arm of `#dispatch`. While an action runs, `rpc_on` may open a background session on
    /// another computer; the caller's last running action closes and deletes them (`#closeUtilityTabs`).
    pub(crate) async fn app(&self, caller: &ControlTab, args: AppArgs) -> R<String> {
        *self
            .mem()
            .app_runs
            .entry(caller.tab_id.clone())
            .or_insert(0) += 1;
        let result = async {
            let app = self.app_control()?;
            let raw = args.args.map(Value::Object);
            app.run(&caller.tab_id, Some(&json!(args.action)), raw.as_ref())
                .await
                .map_err(fail_of)
        }
        .await;
        let last = {
            let mut mem = self.mem();
            let running = mem.app_runs.get(&caller.tab_id).copied().unwrap_or(1) - 1;
            if running > 0 {
                mem.app_runs.insert(caller.tab_id.clone(), running);
                false
            } else {
                mem.app_runs.remove(&caller.tab_id);
                true
            }
        };
        if last {
            self.close_utility_tabs(&caller.tab_id).await;
        }
        result
    }

    /// `#appAutopilot`: the app action's way into `ompdesk_autopilot`: same parse, same card.
    pub(crate) async fn app_autopilot(&self, caller_tab_id: &str, raw: &Value) -> R<String> {
        let (tabs, caller) = {
            let state = self.host.state();
            let tabs = state.tabs(caller_tab_id);
            let caller = tabs
                .as_deref()
                .and_then(|tabs| self.caller_of(&state, caller_tab_id, tabs));
            (tabs, caller)
        };
        let (Some(tabs), Some(caller)) = (tabs, caller) else {
            return fail(TAB_GONE);
        };
        let parsed = match self
            .host
            .parse_args("ompdesk_autopilot", raw, false)
            .await?
        {
            Ok(parsed) => parsed,
            Err(message) => return fail(message),
        };
        let args: AutopilotArgs = serde_json::from_value(parsed).map_err(|error| {
            Fail::other(format!(
                "ompdesk_autopilot: arguments as validated could not be read: {error}"
            ))
        })?;
        self.autopilot(&caller, &tabs, args).await
    }

    /// `#rpcOn`: `ompdesk_app`'s route to another computer (`AppPorts.rpcOn`): `command` to an omp on the computer
    /// `wanted` names. The caller's own session when it runs there, else another session of this app that runs there
    /// and is up, else a session opened there in the background (`utility_tab`): no message, no model call.
    pub(crate) async fn rpc_on(
        &self,
        caller_tab_id: &str,
        wanted: &str,
        command: &RpcCommand,
    ) -> R<RpcResponse> {
        let (tabs, caller) = {
            let state = self.host.state();
            let Some(tabs) = state.tabs(caller_tab_id) else {
                return fail(TAB_GONE);
            };
            let Some(caller) = self.caller_of(&state, caller_tab_id, &tabs) else {
                return fail(TAB_GONE);
            };
            (tabs, caller)
        };
        let named = self.device(wanted)?;
        let device = match named {
            Some(named) => Some(self.reach(named).await?),
            None => None,
        };
        let timeout_ms = command
            .get("type")
            .and_then(Value::as_str)
            .and_then(command_timeout)
            .unwrap_or(self.tuning.rpc_on_timeout_ms);
        let wanted_device = device.as_ref().map(|device| device.id.as_str());
        let via = {
            let mem = self.mem();
            let there = |tab: &ControlTab| {
                tab.device.as_deref() == wanted_device
                    && tab.status.is_up()
                    && !mem.closing.contains(&tab.tab_id)
            };
            if there(&caller) {
                Some(caller.tab_id.clone())
            } else {
                tabs.iter()
                    .find(|tab| there(tab) && !tab.hidden)
                    .map(|tab| tab.tab_id.clone())
            }
        };
        if let Some(via) = via {
            return self
                .host
                .command(&via, command, Deadline::Ms(timeout_ms))
                .await;
        }
        let scoped = self.mem().app_runs.contains_key(caller_tab_id);
        let sent = async {
            let tab = self.utility_tab(caller_tab_id, device.as_ref()).await?;
            self.host
                .command(&tab, command, Deadline::Ms(timeout_ms))
                .await
        }
        .await;
        // Outside an app action nothing ends the session later: it goes with this call.
        if !scoped {
            self.close_utility_tabs(caller_tab_id).await;
        }
        sent
    }

    /// `#utilityTab`: the background session `caller_tab_id`'s app action uses on `device` (None: this computer),
    /// opened at its first command there and shared by the action's other commands and by its caller's other running
    /// actions; all of them are closed and deleted when the caller's last running action ends (`close_utility_tabs`).
    /// One omp start per action, not one per command: reading a setting's schema, its value and writing it are three.
    async fn utility_tab(&self, caller_tab_id: &str, device: Option<&ControlDevice>) -> R<String> {
        let key = device.map(|device| device.id.clone()).unwrap_or_default();
        let (starting, owner) = {
            let mut mem = self.mem();
            let opened = mem
                .utility_tabs
                .entry(caller_tab_id.to_owned())
                .or_default();
            match opened.get(&key) {
                Some(known) => (known.clone(), false),
                None => {
                    let starting = Flight::new();
                    opened.insert(key.clone(), starting.clone());
                    (starting, true)
                }
            }
        };
        if !owner {
            return starting.wait().await.unwrap_or_else(|| {
                fail("The background session's start ended without an answer.")
            });
        }
        let guard = starting.guard();
        let started = async {
            let request = SpawnRequest {
                device: Some(device.map(|device| device.id.clone())),
                ..SpawnRequest::default()
            };
            let tab_id = self.host.spawn(caller_tab_id, &request).await?.tab_id;
            // Its close and delete are no close of a session anyone was given an id for.
            self.mem().closing.insert(tab_id.clone());
            if let Err(error) = self.when_ready(&tab_id, caller_tab_id, None).await {
                self.discard_utility(caller_tab_id, &tab_id).await;
                return Err(error);
            }
            Ok(tab_id)
        }
        .await;
        // A start that failed is none: the next command there starts another.
        if started.is_err()
            && let Some(opened) = self.mem().utility_tabs.get_mut(caller_tab_id)
        {
            opened.remove(&key);
        }
        starting.settle(started.clone());
        drop(guard);
        started
    }

    /// `#closeUtilityTabs`.
    async fn close_utility_tabs(&self, caller_tab_id: &str) {
        let Some(opened) = self.mem().utility_tabs.remove(caller_tab_id) else {
            return;
        };
        join::all(
            opened
                .into_values()
                .map(|starting| {
                    join::boxed(async move {
                        if let Some(Ok(tab_id)) = starting.wait().await {
                            self.discard_utility(caller_tab_id, &tab_id).await;
                        }
                    })
                })
                .collect(),
        )
        .await;
    }

    /// `#discardUtility`: stock wrote the session's file at once: the delete closes the tab and removes that file.
    /// One with no file yet only closes.
    async fn discard_utility(&self, caller_tab_id: &str, tab_id: &str) {
        if self
            .host
            .delete_session(caller_tab_id, tab_id)
            .await
            .is_err()
        {
            let _ = self
                .close_tab(
                    caller_tab_id,
                    tab_id,
                    CloseHow {
                        auto: false,
                        wait_ms: self.tuning.close_wait_ms,
                        cleared: false,
                    },
                )
                .await;
        }
        self.mem().closing.remove(tab_id);
    }
}
