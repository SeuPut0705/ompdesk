mod operations;

pub use operations::{ToolOutcome, ToolRequest, parse_update_check};

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};

use super::archives::{self, ArchiveRelease, TailscaleRelease};
use super::compiled;
use super::download;
use super::ledger::Ledger;
use super::net::Http;
use super::plans;
use super::runner::{OutputSink, Runner};
use super::types::*;
use crate::server::Scope;

const STEP_MAX: Duration = Duration::from_secs(30 * 60);
const OUTPUT_TAIL: usize = 64 * 1024;

/// Trusted process configuration. Page requests name an Item, never an installer, environment, or path.
pub struct Config {
    pub platform: Platform,
    pub arch: String,
    pub bun_install: String,
    pub tools_dir: String,
    pub system_root: String,
    pub state_path: PathBuf,
    pub app_version: Option<String>,
    pub automatic: bool,
    pub supervisor: PathBuf,
    pub scratch: PathBuf,
    pub mirror: Option<String>,
    pub test_installer: Option<PathBuf>,
    pub test_download: Option<PlanDownload>,
}

#[derive(Debug, Clone)]
pub enum UpdateOutcome {
    Updated(String),
    Failed(Failure),
    Skipped,
}

pub type StateSink = Arc<dyn Fn(State) + Send + Sync>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |duration| duration.as_millis() as f64)
}

struct Shared {
    state: Mutex<State>,
    active: Mutex<Option<Scope>>,
    disposed: AtomicBool,
    external_running: AtomicBool,
    shutdown: watch::Sender<bool>,
    output_emitted: AtomicU64,
    on_state: StateSink,
}

impl Shared {
    fn emit(&self) {
        let state = lock(&self.state).clone();
        (self.on_state)(state);
    }
    fn item(&self, id: Item) -> ItemState {
        lock(&self.state).items[index(id)].clone()
    }
    fn change(&self, id: Item, change: impl FnOnce(&mut ItemState)) {
        change(&mut lock(&self.state).items[index(id)]);
    }
    fn cancelled(&self, scope: &Scope) -> bool {
        self.disposed.load(Ordering::Acquire) || scope.cancelled()
    }
}
fn index(id: Item) -> usize {
    match id {
        Item::Bun => 0,
        Item::Git => 1,
        Item::Omp => 2,
        Item::Gh => 3,
        Item::Node => 4,
        Item::AgentDesktop => 5,
        Item::Tailscale => 6,
    }
}

fn output(shared: &Arc<Shared>, id: Item) -> OutputSink {
    let shared = shared.clone();
    Arc::new(move |chunk| {
        shared.change(id, |item| {
            item.output.push_str(chunk);
            trim_tail(&mut item.output, OUTPUT_TAIL);
        });
        let time = now() as u64;
        let old = shared.output_emitted.load(Ordering::Relaxed);
        if time.saturating_sub(old) >= 100
            && shared
                .output_emitted
                .compare_exchange(old, time, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
        {
            shared.emit();
        }
    })
}

/// Keeps a UTF-16 budget as the page's String.slice did, without breaking UTF-8.
pub fn trim_tail(text: &mut String, maximum: usize) {
    let mut units = 0;
    let mut start = text.len();
    for (at, ch) in text.char_indices().rev() {
        units += ch.len_utf16();
        if units > maximum {
            break;
        }
        start = at;
    }
    if start > 0 {
        text.drain(..start);
    }
}

enum Operation {
    Required(bool),
    Optional(Vec<Item>, bool),
    Detect,
    Update(String),
    Latest,
    Managed(Item),
    Tool(ToolRequest),
    GitAslr(crate::setup::git_aslr::Action),
}
enum Answer {
    Done,
    Update(UpdateOutcome),
    Version(String),
    Tool(ToolOutcome),
    GitAslr(Result<usize, String>),
}
struct Queued {
    operation: Operation,
    done: oneshot::Sender<Result<Answer, String>>,
}

pub struct SetupService {
    config: Arc<Config>,
    host: Arc<dyn Host>,
    shared: Arc<Shared>,
    queue: mpsc::UnboundedSender<Queued>,
}

impl SetupService {
    pub fn new(config: Config, host: Arc<dyn Host>, on_state: StateSink) -> Arc<Self> {
        let state = State {
            platform: config.platform,
            automatic: config.automatic,
            omp_ready: false,
            required_running: false,
            items: Item::ALL
                .into_iter()
                .map(|id| {
                    let (manual_commands, manual_url) = plans::manual_steps(id, config.platform);
                    ItemState {
                        id,
                        required: id.required(config.platform),
                        phase: Phase::Checking,
                        presence: None,
                        method: None,
                        command: None,
                        location: None,
                        prompt: None,
                        progress: None,
                        output: String::new(),
                        failure: None,
                        manual_commands,
                        manual_url,
                    }
                })
                .collect(),
        };
        let shared = Arc::new(Shared {
            state: Mutex::new(state),
            active: Mutex::new(None),
            disposed: AtomicBool::new(false),
            external_running: AtomicBool::new(false),
            shutdown: watch::channel(false).0,
            output_emitted: AtomicU64::new(0),
            on_state,
        });
        let config = Arc::new(config);
        let (queue, receive) = mpsc::unbounded_channel();
        let data = Data {
            ledger: Ledger::open(config.state_path.clone(), config.app_version.clone()),
            runner: Runner::new(config.supervisor.clone(), config.scratch.clone()),
            config: config.clone(),
            host: host.clone(),
            shared: shared.clone(),
            detection: None,
        };
        tokio::spawn(data.run(receive));
        Arc::new(Self {
            config,
            host,
            shared,
            queue,
        })
    }

    pub fn state(&self) -> State {
        lock(&self.shared.state).clone()
    }

    fn enqueue(&self, operation: Operation) -> Boxed<'static, Result<Answer, String>> {
        let (done, receive) = oneshot::channel();
        let sent = if self.shared.disposed.load(Ordering::Acquire) {
            false
        } else {
            self.queue.send(Queued { operation, done }).is_ok()
        };
        Box::pin(async move {
            if !sent {
                return Err("Machine setup is disposed".to_owned());
            }
            receive
                .await
                .map_err(|_| "Machine setup stopped".to_owned())?
        })
    }

    pub fn start(self: &Arc<Self>) -> Boxed<'static, Result<(), String>> {
        let required = self.enqueue(Operation::Required(false));
        let service = self.clone();
        Box::pin(async move {
            required.await?;
            if !service.config.automatic || service.config.platform == Platform::Other {
                return Ok(());
            }
            let mut shutdown = service.shared.shutdown.subscribe();
            // The first-tab gate cannot hold the install queue or a person's Retry.
            tokio::select! {
                () = service.host.before_optional() => {},
                _ = shutdown.wait_for(|closed| *closed) => return Ok(()),
            }
            service
                .enqueue(Operation::Optional(Vec::new(), false))
                .await?;
            Ok(())
        })
    }

    pub fn retry(&self, item: Item) -> Boxed<'static, Result<(), String>> {
        if self.config.platform == Platform::Other {
            return Box::pin(async { Err("Setup is not available on this platform".to_owned()) });
        }
        let required = item.required(self.config.platform);
        self.mark_queued(if required {
            Item::ALL
                .into_iter()
                .filter(|id| id.required(self.config.platform))
                .collect()
        } else {
            vec![item]
        });
        let work = self.enqueue(if required {
            Operation::Required(true)
        } else {
            Operation::Optional(vec![item], true)
        });
        Box::pin(async move { work.await.map(|_| ()) })
    }

    pub fn install_for_connection(
        self: &Arc<Self>,
        item: Item,
    ) -> Boxed<'static, Result<ItemState, String>> {
        if item.required(self.config.platform) {
            return Box::pin(async { Err("Not an optional setup item".to_owned()) });
        }
        let work = self.enqueue(
            if self.config.automatic && self.config.platform != Platform::Other {
                Operation::Optional(vec![item], true)
            } else {
                Operation::Detect
            },
        );
        let service = self.clone();
        Box::pin(async move {
            work.await?;
            Ok(service.shared.item(item))
        })
    }

    pub fn update_omp(&self, target: String) -> Boxed<'static, Result<UpdateOutcome, String>> {
        let work = self.enqueue(Operation::Update(target));
        Box::pin(async move {
            match work.await? {
                Answer::Update(outcome) => Ok(outcome),
                _ => Err("Unexpected setup update answer".to_owned()),
            }
        })
    }

    pub fn latest_omp(&self) -> Boxed<'static, Result<String, String>> {
        let work = self.enqueue(Operation::Latest);
        Box::pin(async move { match work.await? { Answer::Version(version) => Ok(version), _ => Err("Unexpected setup version answer".to_owned()) } })
    }

    pub fn latest_managed(&self, item: Item) -> Boxed<'static, Result<String, String>> {
        let work = self.enqueue(Operation::Managed(item));
        Box::pin(async move { match work.await? { Answer::Version(version) => Ok(version), _ => Err("Unexpected managed version answer".to_owned()) } })
    }

    pub fn run_tool_update(&self, request: ToolRequest) -> Boxed<'static, ToolOutcome> {
        if self.shared.disposed.load(Ordering::Acquire) { return Box::pin(async { ToolOutcome::Skipped }); }
        let work = self.enqueue(Operation::Tool(request));
        Box::pin(async move { match work.await { Ok(Answer::Tool(outcome)) => outcome, Err(detail) => ToolOutcome::Failed { detail: Some(detail) }, _ => ToolOutcome::Failed { detail: Some("Unexpected tool update answer".to_owned()) } } })
    }

    pub fn git_aslr(&self, action: crate::setup::git_aslr::Action) -> Boxed<'static, Result<usize, String>> {
        let work = self.enqueue(Operation::GitAslr(action));
        Box::pin(async move { match work.await? { Answer::GitAslr(result) => result, _ => Err("Unexpected Git ASLR answer".to_owned()) } })
    }

    pub fn cancel(&self) -> bool {
        if !self.shared.external_running.load(Ordering::Acquire) && !lock(&self.shared.state)
            .items
            .iter()
            .any(|item| item.phase == Phase::Running)
        {
            return false;
        }
        let active = lock(&self.shared.active);
        if let Some(scope) = &*active {
            scope.cancel();
            true
        } else {
            false
        }
    }

    pub fn dispose(&self) {
        self.shared.disposed.store(true, Ordering::Release);
        self.shared.shutdown.send_replace(true);
        if let Some(scope) = &*lock(&self.shared.active) {
            scope.cancel();
        }
    }

    fn mark_queued(&self, items: Vec<Item>) {
        let mut state = lock(&self.shared.state);
        for id in items {
            let item = &mut state.items[index(id)];
            if !item.presence.as_ref().is_some_and(Presence::present)
                && item.phase != Phase::Running
            {
                item.phase = Phase::Queued;
            }
            if item.required {
                state.required_running = true;
            }
        }
        drop(state);
        self.shared.emit();
    }
}

struct Data {
    config: Arc<Config>,
    host: Arc<dyn Host>,
    shared: Arc<Shared>,
    runner: Runner,
    ledger: Ledger,
    detection: Option<Detection>,
}

impl Data {
    async fn run(mut self, mut queue: mpsc::UnboundedReceiver<Queued>) {
        while let Some(queued) = queue.recv().await {
            if self.shared.disposed.load(Ordering::Acquire) {
                let _ = queued
                    .done
                    .send(Err("Machine setup is disposed".to_owned()));
                continue;
            }
            let update = matches!(&queued.operation, Operation::Update(_));
            let tool = matches!(&queued.operation, Operation::Tool(_));
            let aslr = matches!(&queued.operation, Operation::GitAslr(_));
            let lookup = matches!(&queued.operation, Operation::Latest | Operation::Managed(_));
            let scope = Scope::detached();
            *lock(&self.shared.active) = Some(scope.clone());
            let mut stalled = false;
            let mut answer = {
                let mut work = Box::pin(self.perform(queued.operation, &scope));
                tokio::select! { answer = &mut work => answer, () = tokio::time::sleep(STEP_MAX) => { stalled = true; scope.cancel(); work.await } }
            };
            if stalled { answer = Err("machine setup step was stopped after 30 minutes".to_owned()); }
            else if scope.cancelled() {
                answer = if update { Ok(Answer::Update(UpdateOutcome::Failed(Failure::new("cancelled", None)))) }
                    else if tool { Ok(Answer::Tool(ToolOutcome::Cancelled)) }
                    else if aslr { Ok(Answer::GitAslr(Err("cancelled".to_owned()))) }
                    else if lookup { Err("cancelled".to_owned()) }
                    else { Ok(Answer::Done) };
            }
            *lock(&self.shared.active) = None;
            let _ = queued.done.send(answer);
        }
    }

    async fn perform(&mut self, operation: Operation, scope: &Scope) -> Result<Answer, String> {
        if matches!(&operation, Operation::Required(_) | Operation::Optional(..) | Operation::Detect | Operation::Update(_) | Operation::GitAslr(_)) { self.detect(scope).await?; }
        match operation {
            Operation::Detect => Ok(Answer::Done),
            Operation::Latest => self.latest_omp(scope).await.map(Answer::Version),
            Operation::Managed(item) => self.latest_managed(item, scope).await.map(Answer::Version),
            Operation::Tool(request) => Ok(Answer::Tool(self.tool_update(request, scope).await)),
            Operation::GitAslr(action) => Ok(Answer::GitAslr(self.git_aslr(action, scope).await)),
            Operation::Required(manual) => {
                if (manual || self.config.automatic) && self.config.platform != Platform::Other {
                    self.required(manual, true, scope).await?;
                }
                if manual
                    && self.config.automatic
                    && self
                        .shared
                        .item(Item::Omp)
                        .presence
                        .as_ref()
                        .is_some_and(Presence::present)
                {
                    let optional: Vec<_> = Item::ALL
                        .into_iter()
                        .filter(|id| !id.required(self.config.platform) && id.automatic())
                        .collect();
                    self.install_each(&optional, false, scope).await?;
                }
                Ok(Answer::Done)
            }
            Operation::Optional(ids, manual) => {
                if !manual
                    && !self
                        .shared
                        .item(Item::Omp)
                        .presence
                        .as_ref()
                        .is_some_and(Presence::present)
                {
                    return Ok(Answer::Done);
                }
                let ids = if ids.is_empty() {
                    Item::ALL
                        .into_iter()
                        .filter(|id| !id.required(self.config.platform) && id.automatic())
                        .collect()
                } else {
                    ids
                };
                self.install_each(&ids, manual, scope).await?;
                Ok(Answer::Done)
            }
            Operation::Update(target) => Ok(Answer::Update(self.update(&target, scope).await)),
        }
    }

    async fn detect(&mut self, scope: &Scope) -> Result<(), String> {
        let mut detection = tokio::select! { biased; () = scope.on_cancel() => return Err("cancelled".to_owned()), detection = self.host.detect() => detection? };
        if self.shared.cancelled(scope) {
            return Err("cancelled".to_owned());
        }
        if let Some(Presence::Present {
            path: Some(root),
            extra,
            ..
        }) = detection.presence.get_mut(&Item::Git)
            && extra.get("gitAslrOverride").and_then(Value::as_bool) == Some(true)
            && let Some(dir) = self.config.state_path.parent()
            && !crate::setup::git_aslr::Record::read(&dir.join("git-aslr.json"))
                .images(root)
                .is_empty()
        {
            extra.insert("gitAslrUndoable".to_owned(), Value::Bool(true));
        }
        for id in Item::ALL {
            let presence = detection
                .presence
                .get(&id)
                .ok_or_else(|| format!("Machine detection omitted {}", id.name()))?
                .clone();
            if presence.present() {
                self.ledger.clear(id);
            }
            let backoff =
                id.automatic() && self.config.automatic && !self.ledger.may_attempt(id, now());
            self.shared.change(id, |item| {
                if presence.present() && item.phase != Phase::Running {
                    item.phase = Phase::Present;
                    item.failure = None;
                } else if item.phase == Phase::Checking {
                    item.phase = if backoff { Phase::Backoff } else { Phase::Idle };
                }
                item.presence = Some(presence);
            });
        }
        let omp_ready = self
            .shared
            .item(Item::Omp)
            .presence
            .as_ref()
            .is_some_and(Presence::present);
        lock(&self.shared.state).omp_ready = omp_ready;
        self.detection = Some(detection);
        self.shared.emit();
        Ok(())
    }

    async fn required(
        &mut self,
        manual: bool,
        announce: bool,
        scope: &Scope,
    ) -> Result<(), String> {
        let was_ready = self
            .shared
            .item(Item::Omp)
            .presence
            .as_ref()
            .is_some_and(Presence::present);
        let ids: Vec<_> = Item::ALL
            .into_iter()
            .filter(|id| id.required(self.config.platform))
            .collect();
        lock(&self.shared.state).required_running = true;
        let result = self.install_each(&ids, manual, scope).await;
        lock(&self.shared.state).required_running = false;
        self.shared.emit();
        if result.is_ok()
            && announce
            && !was_ready
            && self
                .shared
                .item(Item::Omp)
                .presence
                .as_ref()
                .is_some_and(Presence::present)
            && !self.shared.cancelled(scope)
        {
            self.host.omp_ready();
        }
        result
    }

    async fn install_each(
        &mut self,
        ids: &[Item],
        manual: bool,
        scope: &Scope,
    ) -> Result<(), String> {
        let run: BTreeSet<_> = ids
            .iter()
            .copied()
            .filter(|id| {
                !self
                    .shared
                    .item(*id)
                    .presence
                    .as_ref()
                    .is_some_and(Presence::present)
                    && (manual || self.ledger.may_attempt(*id, now()))
            })
            .collect();
        for &id in &run {
            self.shared.change(id, |item| item.phase = Phase::Queued);
        }
        self.shared.emit();
        let mut step = 0;
        let mut result = Ok(());
        for &id in ids {
            if self.shared.cancelled(scope) {
                result = Err("cancelled".to_owned());
                break;
            }
            if run.contains(&id) {
                step += 1;
            }
            if let Err(error) = self.ensure(id, manual, step, run.len(), scope).await {
                result = Err(error);
                break;
            }
        }
        for &id in ids {
            self.shared.change(id, |item| {
                if item.phase == Phase::Queued {
                    item.phase = Phase::Idle;
                }
            });
        }
        self.shared.emit();
        result
    }

    fn context(&self) -> Option<PlanContext> {
        let d = self.detection.as_ref()?;
        Some(PlanContext {
            platform: self.config.platform,
            arch: self.config.arch.clone(),
            bun_install: self.config.bun_install.clone(),
            tools_dir: self.config.tools_dir.clone(),
            bun: d.bun.clone(),
            omp: d.omp.clone(),
            brew: d.brew.clone(),
            winget: d.winget.clone(),
            system_root: self.config.system_root.clone(),
        })
    }

    async fn resolve(&self, item: Item, scope: &Scope) -> Result<ArchiveRelease, String> {
        let http = Http {
            mirror: self.config.mirror.as_deref(),
            token: None,
        };
        let work = async {
            if item == Item::AgentDesktop {
                let platform = if self.config.platform == Platform::Win32 {
                    archives::Platform::Win32
                } else {
                    archives::Platform::Darwin
                };
                archives::resolve_agent_desktop(&http, platform, &self.config.arch).await
            } else {
                archives::resolve_archive(&http, item.name(), &self.config.arch).await
            }
        };
        tokio::select! { biased; () = scope.on_cancel() => Err("cancelled".to_owned()), release = work => release }
    }

    async fn ensure(
        &mut self,
        id: Item,
        manual: bool,
        step: usize,
        steps: usize,
        scope: &Scope,
    ) -> Result<(), String> {
        let presence = self.shared.item(id).presence;
        let Some(presence) = presence.filter(|presence| !presence.present()) else {
            return Ok(());
        };
        if !manual && !self.ledger.may_attempt(id, now()) {
            self.shared.change(id, |item| item.phase = Phase::Backoff);
            self.shared.emit();
            return Ok(());
        }
        let Some(ctx) = self.context() else {
            return Ok(());
        };
        let Some(mut method) = plans::select_method(id, &presence, &ctx) else {
            self.shared.change(id, |item| {
                item.phase = Phase::Unavailable;
                item.method = None;
            });
            self.shared.emit();
            return Ok(());
        };
        let mut fallback = false;
        loop {
            let ctx = self
                .context()
                .ok_or_else(|| "Machine detection is missing".to_owned())?;
            let mut release = None;
            let mut tailscale = None;
            if matches!(method, Method::Archive | Method::AgentDesktopArchive) {
                if self.config.test_installer.is_some() {
                    release = Some(ArchiveRelease {
                        item: id.name(),
                        version: "0.0.0".to_owned(),
                        file: "test".to_owned(),
                        url: "https://example.invalid/test".to_owned(),
                        sha256: "0".repeat(64),
                    });
                } else {
                    match self.resolve(id, scope).await {
                        Ok(found) => release = Some(found),
                        Err(detail) => {
                            if scope.cancelled() {
                                return Err(detail);
                            }
                            self.fail(id, Failure::new("download", Some(detail)));
                            return Ok(());
                        }
                    }
                }
            }
            if matches!(method, Method::TailscaleZip | Method::TailscaleMsi) {
                if self.config.test_installer.is_some() {
                    tailscale = Some(TailscaleRelease {
                        version: "0.0.0".to_owned(),
                        file: if method == Method::TailscaleZip {
                            "test.zip"
                        } else {
                            "test.msi"
                        }
                        .to_owned(),
                        url: "https://example.invalid/test".to_owned(),
                        sha256: "0".repeat(64),
                    });
                } else {
                    let http = Http {
                        mirror: self.config.mirror.as_deref(),
                        token: None,
                    };
                    let platform = if method == Method::TailscaleZip {
                        archives::Platform::Darwin
                    } else {
                        archives::Platform::Win32
                    };
                    let resolved = tokio::select! { biased; () = scope.on_cancel() => return Err("cancelled".to_owned()), found = archives::resolve_tailscale(&http, platform, plans::msi_arch(&self.config.arch)) => found };
                    match resolved {
                        Ok(found) => tailscale = Some(found),
                        Err(detail) => {
                            self.fail(id, Failure::new("download", Some(detail)));
                            return Ok(());
                        }
                    }
                }
            }
            let Some(plan) =
                plans::build_plan(id, method, &ctx, release.as_ref(), tailscale.as_ref())
            else {
                self.fail(id, Failure::new("prerequisite", Some("bun".to_owned())));
                return Ok(());
            };
            if self.shared.cancelled(scope) {
                return Err("cancelled".to_owned());
            }
            let download = if self.config.test_installer.is_some() {
                self.config.test_download.clone()
            } else {
                plan.download.clone()
            };
            self.shared.change(id, |item| {
                item.method = Some(method);
                item.command = Some(plan.command.clone());
                item.location = Some(plan.location.clone());
                item.prompt = plan.prompt;
                item.output.clear();
                item.failure = None;
                item.phase = Phase::Running;
                item.progress = Some(Progress {
                    step,
                    steps,
                    started_at: now(),
                    download: download.as_ref().map(|_| DownloadProgress {
                        received: 0,
                        total: None,
                    }),
                });
            });
            self.ledger.begin(id, now(), fallback);
            self.shared.emit();
            let moved = if method == Method::BunGlobal {
                compiled::set_aside(
                    &self.config.bun_install,
                    self.config.platform,
                    now(),
                    |path| self.host.compiled_omp(path),
                )
            } else {
                None
            };
            let outcome = self.execute(id, &plan, download.as_ref(), scope).await;
            if let Some(moved) = &moved {
                compiled::settle(moved);
            }
            if let Some(download) = &download {
                let _ = std::fs::remove_file(&download.file);
            }
            self.shared.change(id, |item| item.progress = None);
            match outcome {
                Ok(RunOutcome::Cancelled) => {
                    self.ledger.cancel();
                    self.shared.change(id, |item| {
                        item.phase = Phase::Cancelled;
                        item.failure = None;
                    });
                    self.shared.emit();
                    return Err("cancelled".to_owned());
                }
                Err(failure) => {
                    if scope.cancelled() {
                        self.ledger.cancel();
                        self.shared.change(id, |item| {
                            item.phase = Phase::Cancelled;
                            item.failure = None;
                        });
                        self.shared.emit();
                        return Err("cancelled".to_owned());
                    }
                    self.fail(id, failure);
                }
                Ok(RunOutcome::Failed {
                    reason,
                    exit_code,
                    detail,
                }) => {
                    let text = self.shared.item(id).output;
                    let reason = if text.contains("SHA-256 mismatch") || text.contains(": FAILED") {
                        "checksum"
                    } else if reason == "exit" && offline(&text) {
                        "network"
                    } else {
                        reason
                    };
                    self.fail(
                        id,
                        Failure {
                            reason: reason.to_owned(),
                            exit_code,
                            detail,
                        },
                    );
                }
                Ok(RunOutcome::Succeeded) => {
                    let refreshed = tokio::select! { biased; () = scope.on_cancel() => Err("cancelled".to_owned()), refreshed = self.host.refresh_path() => refreshed };
                    if let Err(detail) = refreshed {
                        if scope.cancelled() {
                            self.ledger.cancel();
                            return Err(detail);
                        }
                        self.fail(id, Failure::new("not-detected", Some(detail)));
                    } else {
                        self.shared.change(id, |item| item.phase = Phase::Checking);
                        if let Err(detail) = self.detect(scope).await {
                            self.ledger.cancel();
                            return Err(detail);
                        }
                        if !self
                            .shared
                            .item(id)
                            .presence
                            .as_ref()
                            .is_some_and(Presence::present)
                        {
                            if method == Method::XcodeSelect {
                                self.shared.change(id, |item| item.phase = Phase::Requested);
                                self.shared.emit();
                            } else {
                                self.fail(id, Failure::new("not-detected", None));
                            }
                        }
                    }
                }
            }
            self.ledger.settle();
            if method != Method::BunUpgrade
                || self.shared.item(id).phase != Phase::Failed
                || self.shared.cancelled(scope)
            {
                break;
            }
            method = Method::BunScript;
            fallback = true;
        }
        Ok(())
    }

    async fn environment(&self, scope: &Scope) -> Result<Environment, Failure> {
        let mut env = tokio::select! { biased; () = scope.on_cancel() => return Err(Failure::new("spawn", Some("cancelled".to_owned()))), env = self.host.environment() => env.map_err(|detail| Failure::new("spawn", Some(detail)))? };
        env.insert("BUN_INSTALL".to_owned(), self.config.bun_install.clone());
        if self.config.platform == Platform::Win32 {
            env.retain(|key, _| !key.eq_ignore_ascii_case("PSMODULEPATH"));
        }
        Ok(env)
    }

    async fn execute(
        &self,
        id: Item,
        plan: &InstallPlan,
        download: Option<&PlanDownload>,
        scope: &Scope,
    ) -> Result<RunOutcome, Failure> {
        if let Some(download) = download {
            let report = |received, total| {
                self.shared.change(id, |item| {
                    if let Some(progress) = &mut item.progress {
                        progress.download = Some(DownloadProgress { received, total });
                    }
                });
                self.shared.emit();
            };
            download::fetch(download, self.config.mirror.clone(), scope, &report)
                .await
                .map_err(|fault| Failure::new(&fault.code, Some(fault.message)))?;
            self.shared.change(id, |item| {
                if let Some(progress) = &mut item.progress {
                    progress.download = None;
                }
            });
            self.shared.emit();
        }
        let env = self.environment(scope).await?;
        let spec = self.spec(id, plan.method, &plan.spawn);
        Ok(self
            .runner
            .run(&spec, &env, scope, output(&self.shared, id), None)
            .await)
    }

    fn spec(&self, id: Item, method: Method, real: &SpawnSpec) -> SpawnSpec {
        self.config.test_installer.as_ref().map_or_else(
            || real.clone(),
            |file| {
                plans::command(
                    &file.to_string_lossy(),
                    &[id.name(), method.name()],
                    self.config.platform,
                )
            },
        )
    }

    fn fail(&self, id: Item, failure: Failure) {
        self.shared.change(id, |item| {
            item.phase = Phase::Failed;
            item.failure = Some(failure);
        });
        self.shared.emit();
    }

    async fn ready_for_release(
        &mut self,
        target: &str,
        env: &Environment,
        scope: &Scope,
    ) -> Option<Failure> {
        let bun = self.detection.as_ref()?.bun.clone()?;
        let runner = crate::run::Runner {
            bin: bun.clone(),
            args: vec![
                "pm".to_owned(),
                "view".to_owned(),
                format!("{}@{target}", plans::OMP_PACKAGE),
                "--json".to_owned(),
            ],
            env: env.clone(),
            timeout_ms: 60_000,
            max_bytes: 16 * 1024 * 1024,
        };
        let result = crate::run::Exec::new(runner, scope.clone(), "setup")
            .run(".", &[], crate::run::Opts::default())
            .await;
        let text = match result {
            Ok(output) if output.code == 0 && !output.truncated => output.text(),
            Ok(output) => {
                return Some(Failure::new(
                    "check",
                    Some(format!(
                        "omp {target}'s requirements: {}",
                        update_detail(&output.stderr)
                            .or_else(|| update_detail(&output.text()))
                            .unwrap_or_else(|| format!(
                                "bun pm view exited with code {}",
                                output.code
                            ))
                    )),
                ));
            }
            Err(fault) => {
                return Some(Failure::new(
                    "check",
                    Some(format!("omp {target}'s requirements: {}", fault.message)),
                ));
            }
        };
        let manifest: Value = match serde_json::from_str(&text) {
            Ok(manifest) => manifest,
            Err(_) => {
                return Some(Failure::new(
                    "check",
                    Some(format!(
                        "bun pm view printed no manifest for {}@{target}",
                        plans::OMP_PACKAGE
                    )),
                ));
            }
        };
        if manifest.pointer("/omp/dist").and_then(Value::as_str) == Some("binary") {
            return Some(Failure::new(
                "install",
                Some(format!(
                    "omp {target} ships only as a standalone build, which OMPdesk cannot run"
                )),
            ));
        }
        let minimum = self.host.bun_minimum(&manifest)?;
        let meets = |item: &ItemState| {
            item.presence.as_ref().is_some_and(|presence| {
                presence.present()
                    && presence
                        .version()
                        .is_some_and(|version| !self.host.is_newer(&minimum, Some(version)))
            })
        };
        if meets(&self.shared.item(Item::Bun)) {
            return None;
        }
        let version = self
            .shared
            .item(Item::Bun)
            .presence
            .as_ref()
            .and_then(|p| p.version().map(str::to_owned))
            .unwrap_or_else(|| "unknown".to_owned());
        self.shared.change(Item::Bun, |item| {
            item.presence = Some(Presence::Outdated {
                version,
                minimum: minimum.clone(),
                path: Some(bun),
            })
        });
        if self.ensure(Item::Bun, true, 1, 1, scope).await.is_err() {
            return Some(Failure::new("cancelled", None));
        }
        let presence = self.shared.item(Item::Bun).presence;
        if presence.as_ref().is_some_and(|p| {
            p.present()
                && p.version()
                    .is_some_and(|v| !self.host.is_newer(&minimum, Some(v)))
        }) {
            None
        } else {
            Some(Failure::new(
                "install",
                Some(format!(
                    "omp {target} needs Bun {minimum} or newer; Bun could not be upgraded to it"
                )),
            ))
        }
    }

    async fn update(&mut self, target: &str, scope: &Scope) -> UpdateOutcome {
        if self.shared.cancelled(scope)
            || self.config.platform == Platform::Other
            || !self
                .shared
                .item(Item::Omp)
                .presence
                .as_ref()
                .is_some_and(Presence::present)
        {
            return UpdateOutcome::Skipped;
        }
        let Some(ctx) = self.context() else {
            return UpdateOutcome::Skipped;
        };
        let Some(plan) = plans::build_plan(Item::Omp, Method::OmpUpdate, &ctx, None, None) else {
            return UpdateOutcome::Skipped;
        };
        let Some(omp) = ctx.omp else {
            return UpdateOutcome::Skipped;
        };
        let mut env = tokio::select! {
            biased;
            () = scope.on_cancel() => return UpdateOutcome::Failed(Failure::new("cancelled", None)),
            env = self.host.update_environment(&omp) => match env { Ok(env) => env, Err(detail) => return UpdateOutcome::Failed(Failure::new("check", Some(detail))) },
        };
        if self.config.platform == Platform::Win32 {
            env.retain(|key, _| !key.eq_ignore_ascii_case("PSMODULEPATH"));
        }
        if let Some(failure) = self.ready_for_release(target, &env, scope).await {
            return UpdateOutcome::Failed(failure);
        }
        if self.shared.cancelled(scope) {
            return UpdateOutcome::Failed(Failure::new("cancelled", None));
        }
        tokio::select! {
            biased;
            () = scope.on_cancel() => return UpdateOutcome::Failed(Failure::new("cancelled", None)),
            _ = self.host.before_omp_update() => {},
        }
        self.shared.change(Item::Omp, |item| {
            item.method = Some(Method::OmpUpdate);
            item.command = Some(plan.command.clone());
            item.location = Some(plan.location.clone());
            item.output.clear();
            item.failure = None;
            item.phase = Phase::Running;
            item.progress = Some(Progress {
                step: 1,
                steps: 1,
                started_at: now(),
                download: None,
            });
        });
        self.shared.emit();
        let outcome = self
            .runner
            .run(
                &self.spec(Item::Omp, Method::OmpUpdate, &plan.spawn),
                &env,
                scope,
                output(&self.shared, Item::Omp),
                None,
            )
            .await;
        self.shared.change(Item::Omp, |item| {
            item.progress = None;
            item.phase = Phase::Checking;
        });
        if scope.cancelled() {
            return UpdateOutcome::Failed(Failure::new("cancelled", None));
        }
        let refreshed = tokio::select! { biased; () = scope.on_cancel() => return UpdateOutcome::Failed(Failure::new("cancelled", None)), refreshed = self.host.refresh_path() => refreshed };
        if let Err(detail) = refreshed {
            return UpdateOutcome::Failed(Failure::new("unusable", Some(detail)));
        }
        if let Err(detail) = self.detect(scope).await {
            return UpdateOutcome::Failed(Failure::new("unusable", Some(detail)));
        }
        if !self
            .shared
            .item(Item::Omp)
            .presence
            .as_ref()
            .is_some_and(Presence::present)
        {
            let _ = self.required(true, false, scope).await;
        }
        if let RunOutcome::Failed {
            exit_code, detail, ..
        } = outcome
        {
            return UpdateOutcome::Failed(Failure {
                reason: "install".to_owned(),
                exit_code,
                detail,
            });
        }
        let item = self.shared.item(Item::Omp);
        match item.presence {
            Some(Presence::Present {
                version: Some(version),
                ..
            }) if !self.host.is_newer(target, Some(&version)) => UpdateOutcome::Updated(version),
            Some(Presence::Present { .. }) => {
                UpdateOutcome::Failed(Failure::new("not-updated", update_detail(&item.output)))
            }
            _ => UpdateOutcome::Failed(Failure::new("unusable", update_detail(&item.output))),
        }
    }
}

fn offline(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    [
        "enotfound",
        "eai_again",
        "etimedout",
        "econnrefused",
        "econnreset",
        "enetunreach",
        "connectionrefused",
        "connectionclosed",
        "failedtoopensocket",
        "getaddrinfo",
        "could not resolve host",
        "couldn't resolve host",
        "temporary failure in name resolution",
        "network is unreachable",
        "curl: (6)",
        "curl: (7)",
        "curl: (28)",
        "remote name could not be resolved",
        "unable to connect to the remote server",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

pub fn update_detail(text: &str) -> Option<String> {
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for ch in chars.by_ref() {
                if ('@'..='~').contains(&ch) {
                    break;
                }
            }
        } else {
            plain.push(ch);
        }
    }
    let lines: Vec<_> = plain
        .split(['\n', '\r'])
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let tail = lines[lines.len().saturating_sub(6)..].join("\n");
    (!tail.is_empty()).then_some(tail)
}
