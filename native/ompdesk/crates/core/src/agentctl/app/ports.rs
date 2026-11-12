//! What `ompdesk_app` needs from the app (was `AppPorts` of `app-control.ts`). The agent-control service implements
//! this trait when it moves; until then `PortPorts` implements it over a port to main (`crate::ports::Port`), whose
//! state is the snapshot of what the TypeScript read synchronously.
//!
//! Reads that main answered synchronously and that can be listed (`manage`, `full`, the app's language, what the
//! sidebar holds) are the snapshot; the ones that depend on an argument (a preference's value, the device a tab runs
//! on, a caller's title, a text) are asks. Everything that acts on the app is an ask or, when nothing answers
//! (`fire`, `send`), a tell.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::ports::{Port, PortError};

/// An omp's answer to one command.
#[derive(Debug, Clone, Deserialize)]
pub struct RpcResponse {
    pub success: bool,
    #[serde(default)]
    pub data: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
}

/// What the person's sidebar holds of pins, aliases and project order (never the agent-hidden list).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarView {
    #[serde(default)]
    pub pinned_projects: Vec<String>,
    #[serde(default)]
    pub pinned_sessions: Vec<String>,
    #[serde(default)]
    pub aliases: HashMap<String, String>,
    #[serde(default)]
    pub project_order: Vec<String>,
}

/// Main's synchronous reads, as main last said them.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AppState {
    /// `agentControlManage`.
    #[serde(default)]
    pub manage: bool,
    /// `agentControlFull`: no card at all, and the agent-power switches become writable.
    #[serde(default)]
    pub full: bool,
    /// The app's language is Korean (`localize` picks the Korean text).
    #[serde(default)]
    pub korean: bool,
    #[serde(default)]
    pub sidebar: SidebarView,
}

/// The futures of every method are `Send`: an action may run on any worker thread of the core.
pub trait AppPorts: Send + Sync + 'static {
    /// Reads main's state as of now. Every call of `list` and `run` starts with it, so a switch the person flipped
    /// between two calls is read as flipped; within a call the state is what main last answered with.
    fn refresh(&self) -> impl Future<Output = Result<(), PortError>> + Send;
    fn manage_enabled(&self) -> bool;
    /// `agentControlFull`: no card at all, and the agent-power switches become writable.
    fn full_enabled(&self) -> bool;
    /// The English or the Korean text, by the app's language.
    fn localize(&self, en: &str, ko: &str) -> String;
    /// What the person's sidebar holds of pins, aliases and project order.
    fn sidebar_view(&self) -> SidebarView;
    /// A stored preference's value on this computer; `None` when nothing is stored.
    fn get_pref(&self, key: &str) -> impl Future<Output = Result<Option<Value>, PortError>> + Send;
    /// The paired host the calling session's tab runs on (its `device`); `None` = this computer.
    fn device(
        &self,
        caller: &str,
    ) -> impl Future<Output = Result<Option<String>, PortError>> + Send;
    /// Writes a preference through `PREFS_SET` (its validation and side effects included).
    fn set_pref(
        &self,
        caller: &str,
        key: &str,
        value: &Value,
    ) -> impl Future<Output = Result<(), PortError>> + Send;
    fn rpc(
        &self,
        caller: &str,
        command: &Value,
    ) -> impl Future<Output = Result<RpcResponse, PortError>> + Send;
    /// Sends an omp command to the computer `device` names (a paired device by name or id as `ompdesk_sessions`
    /// lists it, or "local"): the caller's own session when it runs there, else another open session there, else a
    /// background session opened for the running action and closed and deleted after it. Fails with a readable
    /// message when the device is unknown or unreachable.
    fn rpc_on(
        &self,
        caller: &str,
        device: &str,
        command: &Value,
    ) -> impl Future<Output = Result<RpcResponse, PortError>> + Send;
    fn invoke(
        &self,
        caller: &str,
        channel: &str,
        args: &[Value],
    ) -> impl Future<Output = Result<Value, PortError>> + Send;
    fn fire(&self, caller: &str, channel: &str, args: &[Value]);
    /// An event for the caller's window (`AgentAppEvent`).
    fn send(&self, caller: &str, event: &Value);
    fn confirm(
        &self,
        caller: &str,
        title: &str,
        message: &str,
    ) -> impl Future<Output = Result<bool, PortError>> + Send;
    /// Journals a line in the caller's session. Best effort.
    fn note(&self, caller: &str, text: &str) -> impl Future<Output = Result<(), PortError>> + Send;
    /// A text of the app's own (`appTitle`, `appMessage`, `appChanged`) with its parameters.
    fn text(
        &self,
        key: &str,
        params: &[(&str, &str)],
    ) -> impl Future<Output = Result<String, PortError>> + Send;
    /// Opens a macOS Privacy & Security pane (this computer's System Settings); fails off macOS.
    fn open_privacy_pane(&self, pane: &str) -> impl Future<Output = Result<(), PortError>> + Send;
    fn caller_title(&self, caller: &str) -> impl Future<Output = Result<String, PortError>> + Send;
    /// `ompdesk_autopilot` itself (its card and folder rules); the app actions go through it, never around it.
    fn autopilot(
        &self,
        caller: &str,
        args: &Value,
    ) -> impl Future<Output = Result<String, PortError>> + Send;
}

/// `AppPorts` over a port to main: the methods of main's `AppControl` client (`app-control.ts`) answer the asks.
pub struct PortPorts {
    port: Arc<Port<AppState>>,
}

impl PortPorts {
    pub fn new(port: Arc<Port<AppState>>) -> PortPorts {
        PortPorts { port }
    }
}

#[derive(Deserialize)]
struct PrefAnswer {
    found: bool,
    #[serde(default)]
    value: Value,
}

impl AppPorts for PortPorts {
    async fn refresh(&self) -> Result<(), PortError> {
        self.port.fresh().await.map(|_| ())
    }

    fn manage_enabled(&self) -> bool {
        self.port.state().manage
    }

    fn full_enabled(&self) -> bool {
        self.port.state().full
    }

    fn localize(&self, en: &str, ko: &str) -> String {
        (if self.port.state().korean { ko } else { en }).to_string()
    }

    fn sidebar_view(&self) -> SidebarView {
        self.port.state().sidebar.clone()
    }

    async fn get_pref(&self, key: &str) -> Result<Option<Value>, PortError> {
        let answer: PrefAnswer = self.port.ask("getPref", &json!({ "key": key })).await?;
        Ok(answer.found.then_some(answer.value))
    }

    async fn device(&self, caller: &str) -> Result<Option<String>, PortError> {
        self.port.ask("device", &json!({ "caller": caller })).await
    }

    async fn set_pref(&self, caller: &str, key: &str, value: &Value) -> Result<(), PortError> {
        let _: Value = self
            .port
            .ask(
                "setPref",
                &json!({ "caller": caller, "key": key, "value": value }),
            )
            .await?;
        Ok(())
    }

    async fn rpc(&self, caller: &str, command: &Value) -> Result<RpcResponse, PortError> {
        self.port
            .ask("rpc", &json!({ "caller": caller, "command": command }))
            .await
    }

    async fn rpc_on(
        &self,
        caller: &str,
        device: &str,
        command: &Value,
    ) -> Result<RpcResponse, PortError> {
        self.port
            .ask(
                "rpcOn",
                &json!({ "caller": caller, "device": device, "command": command }),
            )
            .await
    }

    async fn invoke(
        &self,
        caller: &str,
        channel: &str,
        args: &[Value],
    ) -> Result<Value, PortError> {
        self.port
            .ask(
                "invoke",
                &json!({ "caller": caller, "channel": channel, "args": args }),
            )
            .await
    }

    fn fire(&self, caller: &str, channel: &str, args: &[Value]) {
        self.port.tell(
            "fire",
            &json!({ "caller": caller, "channel": channel, "args": args }),
        );
    }

    fn send(&self, caller: &str, event: &Value) {
        self.port
            .tell("send", &json!({ "caller": caller, "event": event }));
    }

    async fn confirm(&self, caller: &str, title: &str, message: &str) -> Result<bool, PortError> {
        self.port
            .ask(
                "confirm",
                &json!({ "caller": caller, "title": title, "message": message }),
            )
            .await
    }

    async fn note(&self, caller: &str, text: &str) -> Result<(), PortError> {
        let _: Value = self
            .port
            .ask("note", &json!({ "caller": caller, "text": text }))
            .await?;
        Ok(())
    }

    async fn text(&self, key: &str, params: &[(&str, &str)]) -> Result<String, PortError> {
        let params: serde_json::Map<String, Value> = params
            .iter()
            .map(|(name, value)| ((*name).to_string(), json!(value)))
            .collect();
        self.port
            .ask("text", &json!({ "key": key, "params": params }))
            .await
    }

    async fn open_privacy_pane(&self, pane: &str) -> Result<(), PortError> {
        let _: Value = self
            .port
            .ask("openPrivacyPane", &json!({ "pane": pane }))
            .await?;
        Ok(())
    }

    async fn caller_title(&self, caller: &str) -> Result<String, PortError> {
        self.port
            .ask("callerTitle", &json!({ "caller": caller }))
            .await
    }

    async fn autopilot(&self, caller: &str, args: &Value) -> Result<String, PortError> {
        self.port
            .ask("autopilot", &json!({ "caller": caller, "args": args }))
            .await
    }
}
