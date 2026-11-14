//! Direct native dependencies of the existing Autopilot coordinator. Stock commands and bridge payloads are JSON
//! because those are stock's boundaries. Caller authority is a native handle and is never serialized here.

use std::sync::Arc;

use ompdesk_app_contract::Owner;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::coordinator::{Facts, SidecarFacts, Source};
use super::land_check::{Prepared, Shell};
use super::ship::{Fut, PrInput};
use crate::ports::Port;
use crate::run::Runner;
use crate::server::Fault;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Relaunch {
    AfterRestore,
    Now,
    Disabled,
}

#[derive(Debug, Clone, Serialize)]
pub struct Notice {
    pub kind: String,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone)]
pub struct TurnStop {
    pub tab: String,
    pub surface: &'static str,
    pub caller: Option<String>,
}

/// Implemented by Base over the actual native Pool, Machine, Setup, resume and notification services. No default
/// methods: an incomplete instance cannot claim that it cleared queues, ended a child, or delivered an answer.
pub trait Host: Send + Sync + 'static {
    fn source(&self, owner: &Owner, tab: &str) -> Result<Source, Fault>;
    fn today(&self) -> String;
    fn git_runner(&self) -> Fut<Result<Runner, Fault>>;
    fn gh_runner(&self) -> Fut<Result<Option<Runner>, Fault>>;
    fn stock(&self, tab: String, command: Value) -> Fut<Result<Value, Fault>>;
    fn bridge(
        &self,
        tab: String,
        method: String,
        params: Value,
        timeout_ms: Option<u64>,
    ) -> Fut<Result<Value, Fault>>;
    fn facts(&self, tab: String) -> Fut<Result<Option<Facts>, Fault>>;
    fn sidecar(&self, tab: String) -> Fut<Result<Option<SidecarFacts>, Fault>>;
    fn ready(&self, tab: String) -> Fut<Result<(), Fault>>;
    fn ready_cancel(&self, tab: &str);
    fn release(&self, tab: String) -> Fut<Result<(), Fault>>;
    fn note_stopped(&self, tab: &str);
    fn turn_stop(&self, stop: TurnStop);
    fn answer(&self, tab: String, id: String, response: Value) -> Fut<Result<bool, Fault>>;
    fn dispatch(
        &self,
        owner: Owner,
        tab: String,
        command: Value,
        timeout_ms: u64,
    ) -> Fut<Result<Value, Fault>>;
    fn spawn_tab(&self, owner: Owner, payload: Value) -> Fut<Result<Value, Fault>>;
    fn text(&self, key: String, params: Value) -> Fut<Result<String, Fault>>;
    fn pr_create(&self, cwd: String, input: PrInput) -> Fut<Result<(String, i64), Fault>>;
    fn prepare_worktree(&self, primary: String, tree: String) -> Fut<Result<Prepared, Fault>>;
    fn land_shell(&self, command: String) -> Fut<Result<Shell, Fault>>;
    fn clear_queue(&self, tab: String) -> Fut<Result<(), Fault>>;
    fn relaunch(&self, tab: String) -> Fut<Result<Relaunch, Fault>>;
    fn notify(&self, tab: &str, notice: Notice);
    fn run_ended(&self, root: &str);
    fn log(&self, message: &str);
    fn run_log(&self, message: &str, details: Value);
    fn mirror(&self, event: Value);
    fn child_run(&self, tab: &str, run: Option<(String, String)>);
}

pub struct Native {
    pub host: Arc<dyn Host>,
    pub quota_fallback_ms: f64,
    pub closing: std::sync::atomic::AtomicBool,
}

/// The wire branch is the existing process-parity entry. The native application chooses `Native` and calls typed
/// services directly. It never sends an effect to Node or serializes a caller as a page argument.
pub enum Backend {
    Wire(Arc<Port<()>>),
    Native(Native),
}

impl Backend {
    pub fn begin_close(&self) {
        match self {
            Self::Wire(port) => port.close(),
            Self::Native(native) => native
                .closing
                .store(true, std::sync::atomic::Ordering::Release),
        }
    }
    pub async fn git_runner(&self) -> Result<Runner, Fault> {
        match self {
            Self::Wire(port) => port.ask("gitRunner", &()).await.map_err(Fault::from),
            Self::Native(native) => native.host.git_runner().await,
        }
    }
    pub async fn stock(&self, tab: &str, command: Value) -> Result<Value, Fault> {
        match self {
            Self::Wire(port) => port
                .ask("stock", &json!({"tab":tab,"command":command}))
                .await
                .map_err(Fault::from),
            Self::Native(native) => native.host.stock(tab.to_owned(), command).await,
        }
    }
    pub async fn bridge(
        &self,
        tab: &str,
        method: &str,
        params: Value,
        timeout_ms: Option<u64>,
    ) -> Result<Value, Fault> {
        match self {
            Self::Wire(port) => {
                let mut args = json!({"tab":tab,"method":method,"params":params});
                if let Some(ms) = timeout_ms {
                    args["timeoutMs"] = json!(ms);
                }
                port.ask("bridge", &args).await.map_err(Fault::from)
            }
            Self::Native(native) => {
                native
                    .host
                    .bridge(tab.to_owned(), method.to_owned(), params, timeout_ms)
                    .await
            }
        }
    }
    pub async fn facts(&self, tab: &str) -> Result<Option<Facts>, Fault> {
        match self {
            Self::Wire(port) => port
                .ask("facts", &json!({"tab":tab}))
                .await
                .map_err(Fault::from),
            Self::Native(native) => native.host.facts(tab.to_owned()).await,
        }
    }
    pub async fn sidecar(&self, tab: &str) -> Result<Option<SidecarFacts>, Fault> {
        match self {
            Self::Wire(port) => port
                .ask("sidecar", &json!({"tab":tab}))
                .await
                .map_err(Fault::from),
            Self::Native(native) => native.host.sidecar(tab.to_owned()).await,
        }
    }
    pub async fn ready(&self, tab: &str) -> Result<(), Fault> {
        match self {
            Self::Wire(port) => port
                .ask::<Value, _>("ready", &json!({"tab":tab}))
                .await
                .map(|_| ())
                .map_err(Fault::from),
            Self::Native(native) => {
                if native.closing.load(std::sync::atomic::Ordering::Acquire) {
                    return Err(Fault::new("autopilot_closed", "Autopilot is closed"));
                }
                native.host.ready(tab.to_owned()).await
            }
        }
    }
    pub fn ready_cancel(&self, tab: &str) {
        match self {
            Self::Wire(port) => port.tell("readyCancel", &json!({"tab":tab})),
            Self::Native(native) => native.host.ready_cancel(tab),
        }
    }
    pub async fn release(&self, tab: &str) -> Result<(), Fault> {
        match self {
            Self::Wire(port) => port
                .ask::<Value, _>("release", &json!({"tab":tab}))
                .await
                .map(|_| ())
                .map_err(Fault::from),
            Self::Native(native) => native.host.release(tab.to_owned()).await,
        }
    }
    pub fn note_stopped(&self, tab: &str) {
        match self {
            Self::Wire(port) => port.tell("noteStopped", &json!({"tab":tab})),
            Self::Native(native) => native.host.note_stopped(tab),
        }
    }
    pub fn turn_stop(&self, tab: &str, surface: &'static str, caller: Option<&str>) {
        match self {
            Self::Wire(port) => {
                let mut args =
                    json!({"command":"abort","tab":tab,"by":"autopilot","surface":surface});
                if let Some(caller) = caller {
                    args["caller"] = json!(caller);
                }
                port.tell("turnStop", &args);
            }
            Self::Native(native) => native.host.turn_stop(TurnStop {
                tab: tab.to_owned(),
                surface,
                caller: caller.map(str::to_owned),
            }),
        }
    }
    pub async fn answer(&self, tab: &str, id: &str, response: Value) -> Result<bool, Fault> {
        match self {
            Self::Wire(port) => port
                .ask("answer", &json!({"tab":tab,"id":id,"response":response}))
                .await
                .map_err(Fault::from),
            Self::Native(native) => {
                native
                    .host
                    .answer(tab.to_owned(), id.to_owned(), response)
                    .await
            }
        }
    }
    pub async fn dispatch(
        &self,
        call: u64,
        owner: Option<&Owner>,
        tab: &str,
        command: Value,
        timeout_ms: u64,
    ) -> Result<Value, Fault> {
        match self {
            Self::Wire(port) => port
                .ask(
                    "dispatch",
                    &json!({"call":call,"tab":tab,"command":command,"timeoutMs":timeout_ms}),
                )
                .await
                .map_err(Fault::from),
            Self::Native(native) => {
                native
                    .host
                    .dispatch(
                        owner.cloned().ok_or_else(missing_owner)?,
                        tab.to_owned(),
                        command,
                        timeout_ms,
                    )
                    .await
            }
        }
    }
    pub async fn spawn_tab(
        &self,
        call: u64,
        owner: Option<&Owner>,
        payload: Value,
    ) -> Result<Value, Fault> {
        match self {
            Self::Wire(port) => port
                .ask("spawnTab", &json!({"call":call,"payload":payload}))
                .await
                .map_err(Fault::from),
            Self::Native(native) => {
                native
                    .host
                    .spawn_tab(owner.cloned().ok_or_else(missing_owner)?, payload)
                    .await
            }
        }
    }
    pub async fn text(&self, key: &str, params: Value) -> Result<String, Fault> {
        match self {
            Self::Wire(port) => port
                .ask("text", &json!({"key":key,"params":params}))
                .await
                .map_err(Fault::from),
            Self::Native(native) => native.host.text(key.to_owned(), params).await,
        }
    }
    pub async fn release_procedure(&self, root: &str) -> Result<Option<Value>, Fault> {
        match self {
            Self::Wire(port) => port
                .ask("releaseProcedure", &json!({"root":root}))
                .await
                .map_err(Fault::from),
            Self::Native(_) => {
                let root = std::path::PathBuf::from(root);
                crate::git::read::blocking(move || super::release::detect(&root))
                    .await?
                    .map(|procedure| {
                        serde_json::to_value(procedure)
                            .map_err(|error| Fault::new("internal", error.to_string()))
                    })
                    .transpose()
            }
        }
    }
    pub async fn pr_text(&self, branch: String, cycles: Value) -> Result<(String, String), Fault> {
        match self {
            Self::Wire(port) => {
                #[derive(Deserialize)]
                struct Text {
                    title: String,
                    body: String,
                }
                let result: Text = port
                    .ask("prText", &json!({"branch":branch,"cycles":cycles}))
                    .await
                    .map_err(Fault::from)?;
                Ok((result.title, result.body))
            }
            Self::Native(_) => {
                let result =
                    super::effects::pr_text(&branch, cycles.as_array().map_or(&[], Vec::as_slice));
                Ok((result.title, result.body))
            }
        }
    }
    pub async fn pr_create(&self, cwd: String, input: PrInput) -> Result<(String, i64), Fault> {
        match self {
            Self::Wire(port) => {
                #[derive(Deserialize)]
                struct Created {
                    url: String,
                    number: i64,
                }
                let result: Created = port
                    .ask("prCreate", &json!({"cwd":cwd,"input":input}))
                    .await
                    .map_err(Fault::from)?;
                Ok((result.url, result.number))
            }
            Self::Native(native) => native.host.pr_create(cwd, input).await,
        }
    }
    pub async fn gh_run(&self, cwd: String, url: &str) -> Result<Option<Value>, Fault> {
        match self {
            Self::Wire(port) => port
                .ask("ghRun", &json!({"cwd":cwd,"url":url}))
                .await
                .map_err(Fault::from),
            Self::Native(native) => {
                let gh =
                    crate::gh::Gh::new(native.host.gh_runner().await?, super::steps::step_scope());
                Ok(super::effects::gh_run(&gh, &cwd, url)
                    .await
                    .map(|run| json!({"status":run.status,"conclusion":run.conclusion})))
            }
        }
    }
    pub async fn probe_repo(&self, root: &str) -> Result<String, Fault> {
        match self {
            Self::Wire(port) => port
                .ask("probeRepo", &json!({"root":root}))
                .await
                .map_err(Fault::from),
            Self::Native(_) => Err(Fault::new(
                "internal",
                "Native repository probes run in the coordinator",
            )),
        }
    }
    pub async fn prepare_worktree(&self, primary: &str, tree: &str) -> Result<Prepared, Fault> {
        match self {
            Self::Wire(port) => port
                .ask("prepareWorktree", &json!({"primary":primary,"tree":tree}))
                .await
                .map_err(Fault::from),
            Self::Native(native) => {
                native
                    .host
                    .prepare_worktree(primary.to_owned(), tree.to_owned())
                    .await
            }
        }
    }
    pub async fn land_shell(&self, command: String) -> Result<Shell, Fault> {
        match self {
            Self::Wire(port) => port
                .ask("landShell", &json!({"command":command}))
                .await
                .map_err(Fault::from),
            Self::Native(native) => native.host.land_shell(command).await,
        }
    }
    pub async fn clear_queue(&self, tab: &str) -> Result<(), Fault> {
        match self {
            Self::Wire(port) => port
                .ask::<Value, _>("clearQueue", &json!({"tab":tab}))
                .await
                .map(|_| ())
                .map_err(Fault::from),
            Self::Native(native) => native.host.clear_queue(tab.to_owned()).await,
        }
    }
    pub async fn quota_wait(
        &self,
        reports: Value,
        provider: Option<String>,
        now: i64,
    ) -> Result<i64, Fault> {
        match self {
            Self::Wire(port) => port
                .ask(
                    "quotaWait",
                    &json!({"reports":reports,"provider":provider,"now":now}),
                )
                .await
                .map_err(Fault::from),
            Self::Native(native) => Ok(crate::resume::quota_wait_until(
                reports.as_array().map_or(&[], Vec::as_slice),
                provider.as_deref(),
                now as f64,
                native.quota_fallback_ms,
            ) as i64),
        }
    }
    pub async fn relaunch(&self, tab: &str) -> Result<Relaunch, Fault> {
        match self {
            Self::Wire(port) => {
                let value: String = port
                    .ask("relaunch", &json!({"tab":tab}))
                    .await
                    .map_err(Fault::from)?;
                Ok(match value.as_str() {
                    "after_restore" => Relaunch::AfterRestore,
                    "now" => Relaunch::Now,
                    _ => Relaunch::Disabled,
                })
            }
            Self::Native(native) => native.host.relaunch(tab.to_owned()).await,
        }
    }
    pub fn notify(&self, tab: &str, notice: Notice) {
        match self {
            Self::Wire(port) => port.tell("notify", &json!({"tab":tab,"notice":notice})),
            Self::Native(native) => native.host.notify(tab, notice),
        }
    }
    pub fn run_ended(&self, root: &str) {
        match self {
            Self::Wire(port) => port.tell("runEnded", &json!({"root":root})),
            Self::Native(native) => native.host.run_ended(root),
        }
    }
    pub fn log(&self, message: &str) {
        match self {
            Self::Wire(port) => port.tell("log", &json!({"message":message})),
            Self::Native(native) => native.host.log(message),
        }
    }
    pub fn run_log(&self, message: &str, details: Value) {
        match self {
            Self::Wire(port) => port.tell("runLog", &json!({"message":message,"details":details})),
            Self::Native(native) => native.host.run_log(message, details),
        }
    }
    pub fn mirror(&self, event: Value) {
        match self {
            Self::Wire(port) => port.tell("mirror", &event),
            Self::Native(native) => native.host.mirror(event),
        }
    }
    pub fn child_run(&self, tab: &str, run: Option<(String, String)>) {
        match self {
            Self::Wire(port) => port.tell("childRun", &json!({"tab":tab,"run":run.map(|(parent,root)|json!({"parentTab":parent,"root":root}))})),
            Self::Native(native) => native.host.child_run(tab,run),
        }
    }
}

fn missing_owner() -> Fault {
    Fault::new(
        "invalid_caller",
        "Native Autopilot start needs an authenticated owner",
    )
}
