//! Native scheduled-run owner. No transport callback starts a process: resolution is preparation, and
//! the final spawn or wake commit is fenced under the same lock as pause, edit, delete and stop.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{Notify, watch};
use tokio::task::JoinHandle;

use super::engine::{Commanded, Engine, Out};
use super::launch::{self, LaunchParams};
use super::triggers::{self, Effect, Start, Token, Triggers};
use super::{Journal, draft, locked, prepare_files, rules, system_now, uuid, webhook_key};
use crate::disk::saves::write_kept;
use crate::server::Fault;

pub use super::engine::Limits;

pub type RunFuture = Pin<Box<dyn Future<Output = RunResult> + Send>>;
pub type Stop = Arc<dyn Fn() + Send + Sync>;

#[derive(Debug)]
pub struct RunResult {
    pub code: Option<i64>,
    pub error: Option<String>,
}

pub struct RunProcess {
    pub stop: Stop,
    /// Settles only after the process tree or the woken turn has ended.
    pub done: RunFuture,
}

/// Created by the canonical Remote quota reservation. Dropping an unspent charge refunds it.
pub struct Charge(Option<Box<dyn FnOnce() -> Result<(), Fault> + Send>>);

impl Charge {
    pub fn new(refund: impl FnOnce() -> Result<(), Fault> + Send + 'static) -> Self {
        Self(Some(Box::new(refund)))
    }

    fn commit(mut self) {
        self.0.take();
    }
}

impl Drop for Charge {
    fn drop(&mut self) {
        if let Some(refund) = self.0.take()
            && let Err(error) = refund()
        {
            eprintln!(
                "ompdesk-core: couldn't refund a scheduled run: {}",
                error.message
            );
        }
    }
}

/// Machine supplies the resolved runtime and launch environment. Memory supplies extensions; the hub supplies
/// their MCP environment. These fields are native configuration, never deserialized from a page request.
pub struct LaunchCommand {
    pub supervisor: String,
    pub file: String,
    pub args: Vec<String>,
    pub shell: bool,
    pub env: BTreeMap<String, String>,
    pub header: String,
}

impl LaunchCommand {
    pub fn omp(
        supervisor: &std::path::Path,
        bin: &std::path::Path,
        mut env: BTreeMap<String, String>,
        extensions: Vec<String>,
        extension_env: BTreeMap<String, String>,
        schedule: &Value,
    ) -> Self {
        if !extensions.is_empty() {
            env.extend(extension_env);
        }
        env.insert("PI_NOTIFICATIONS".into(), "off".into());
        env.insert("PI_NO_PTY".into(), "1".into());
        env.insert("OTEL_SDK_DISABLED".into(), "true".into());
        let mut args = vec!["-p".to_owned()];
        args.extend(extensions);
        if let Some(model) = schedule["model"].as_str().filter(|model| !model.is_empty()) {
            args.extend(["--model".into(), model.into()]);
        }
        if schedule["autoApprove"] == true {
            args.push("--yolo".into());
        }
        let cwd = schedule["cwd"].as_str().unwrap_or_default();
        let header = format!("$ omp {}\n# {cwd}\n\n", args.join(" "));
        let bin = bin.to_string_lossy().into_owned();
        let lower = bin.to_ascii_lowercase();
        let shell = cfg!(windows) && (lower.ends_with(".cmd") || lower.ends_with(".bat"));
        let file = if shell { format!("\"{bin}\"") } else { bin };
        if shell {
            args = args
                .into_iter()
                .map(|arg| format!("\"{}\"", arg.replace('"', "\"\"")))
                .collect();
        }
        Self {
            supervisor: supervisor.to_string_lossy().into_owned(),
            file,
            args,
            shell,
            env,
            header,
        }
    }
}

use crate::routines::runtime::{self, SourceProcess};

/// Implemented by the native application's typed Machine/Remote/pool/inbox services. No Node port.
pub trait Host: runtime::Services {
    fn now(&self) -> i64 {
        system_now()
    }
    /// Pure preparation. Must not spawn or deliver a prompt before returning.
    fn resolve_launch(
        &self,
        schedule: &Value,
    ) -> impl Future<Output = Result<LaunchCommand, Fault>> + Send;
    fn reserve(&self, device: &str) -> Result<Charge, Fault>;
    /// Commit the authenticated native wake synchronously; `done` follows its actual turn.
    fn wake(&self, schedule: &Value, run: &str) -> Result<RunProcess, Fault>;
    fn changed(&self, state: Value);
    fn log(&self, message: &str);
}

pub struct Options {
    pub file: PathBuf,
    pub log_dir: PathBuf,
    pub marks_file: PathBuf,
    pub limits: Limits,
    pub tick_ms: u64,
    pub minute_ms: i64,
    pub quiet_ms: i64,
    pub sources: runtime::Config,
    /// Tests own the clock and call `tick`; production keeps its wall-clock timer.
    pub manual: bool,
}

impl Options {
    pub fn new(data_dir: PathBuf, limits: Limits) -> Self {
        Self {
            file: data_dir.join("schedules.json"),
            log_dir: data_dir.join("schedule-runs"),
            marks_file: data_dir.join("routine-marks.json"),
            limits,
            tick_ms: 30_000,
            minute_ms: 60_000,
            quiet_ms: triggers::QUIET_MS,
            sources: runtime::Config::default(),
            manual: false,
        }
    }
}

struct Slot {
    stop: Stop,
    committed: bool,
}

struct Inner {
    engine: Engine,
    charges: HashMap<u64, Charge>,
    runs: HashMap<String, Slot>,
    sources: HashMap<Token, SourceProcess>,
    source_tasks: usize,
    triggers: Triggers,
    warnings: HashMap<(Token, String), String>,
    ready: bool,
    closed: bool,
    deferred: Vec<Deferred>,
}

enum Deferred {
    Source(Effect),
}

pub struct Application<H: Host> {
    host: Arc<H>,
    options: Options,
    inner: Mutex<Inner>,
    journal: Journal,
    clock: Mutex<Option<JoinHandle<()>>>,
    ended: Notify,
    state_push: watch::Sender<Value>,
}

pub struct SourceContext<H: Host> {
    app: Weak<Application<H>>,
    token: Token,
}

impl<H: Host> Clone for SourceContext<H> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            token: self.token.clone(),
        }
    }
}

impl<H: Host> SourceContext<H> {
    pub fn current(&self) -> bool {
        self.app
            .upgrade()
            .is_some_and(|app| locked(&app.inner).triggers.current(&self.token))
    }
    pub fn running(&self) -> bool {
        self.app
            .upgrade()
            .is_some_and(|app| locked(&app.inner).triggers.running(&self.token))
    }
    pub fn quiet(&self) -> bool {
        self.app.upgrade().is_none_or(|app| {
            locked(&app.inner)
                .triggers
                .quiet(&self.token, app.host.now())
        })
    }

    /// Marks and all lines from one read are accepted atomically, with the mark kept before any fire.
    /// An old source can neither restore its mark nor fire after edit, pause, delete or close.
    pub fn publish(&self, mark: Option<Value>, lines: &[String]) -> bool {
        let Some(app) = self.app.upgrade() else {
            return false;
        };
        app.with(|inner| {
            if !inner.triggers.current(&self.token) {
                return false;
            }
            if let Some(mark) = mark
                && inner.triggers.save(&self.token, mark)
            {
                app.keep_marks(inner);
            }
            for line in lines {
                inner.engine.fire(self.token.id(), line, app.host.now());
            }
            true
        })
    }

    pub fn failure(&self, key: &str, error: Option<&str>) {
        let Some(app) = self.app.upgrade() else {
            return;
        };
        app.with(|inner| {
            if !inner.triggers.current(&self.token) {
                return;
            }
            let entry = (self.token.clone(), key.to_owned());
            let Some(error) = error else {
                inner.warnings.remove(&entry);
                return;
            };
            if inner.warnings.get(&entry).is_some_and(|old| old == error) {
                return;
            }
            inner.warnings.insert(entry, error.to_owned());
            let message = format!("{key}: {error}");
            app.host.log(&message);
            inner
                .engine
                .trigger_failed(self.token.id(), &message, app.host.now());
        });
    }
}

impl<H: Host> runtime::Sink for SourceContext<H> {
    fn current(&self) -> bool {
        SourceContext::current(self)
    }
    fn running(&self) -> bool {
        SourceContext::running(self)
    }
    fn quiet(&self) -> bool {
        SourceContext::quiet(self)
    }
    fn publish(&self, mark: Option<Value>, lines: &[String]) -> bool {
        SourceContext::publish(self, mark, lines)
    }
    fn failure(&self, key: &str, error: Option<&str>) {
        SourceContext::failure(self, key, error);
    }
}

impl<H: Host> Application<H> {
    pub fn open(host: Arc<H>, options: Options) -> Arc<Self> {
        let stored = std::fs::read_to_string(&options.file).ok();
        let marks = std::fs::read_to_string(&options.marks_file).ok();
        let now = host.now();
        let engine = Engine::new(
            options.limits.clone(),
            options.minute_ms,
            true,
            true,
            Box::new(rules::Local),
            Box::new(uuid),
            Box::new(webhook_key),
        );
        let journal = Journal::open(options.file.clone());
        let (state_push, mut state_changes) = watch::channel(Value::Null);
        let observer = Arc::clone(&host);
        tokio::spawn(async move {
            while state_changes.changed().await.is_ok() {
                let state = state_changes.borrow_and_update().clone();
                observer.changed(state);
            }
        });
        let app = Arc::new(Self {
            host,
            journal,
            inner: Mutex::new(Inner {
                engine,
                charges: HashMap::new(),
                runs: HashMap::new(),
                sources: HashMap::new(),
                source_tasks: 0,
                triggers: Triggers::new(marks.as_deref(), options.quiet_ms),
                warnings: HashMap::new(),
                ready: false,
                closed: false,
                deferred: Vec::new(),
            }),
            options,
            clock: Mutex::new(None),
            ended: Notify::new(),
            state_push,
        });
        app.with(|inner| inner.engine.load(stored.as_deref(), now));
        if !app.options.manual {
            let weak = Arc::downgrade(&app);
            let period = Duration::from_millis(app.options.tick_ms.max(1));
            *locked(&app.clock) = Some(tokio::spawn(async move {
                let mut timer =
                    tokio::time::interval_at(tokio::time::Instant::now() + period, period);
                timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    timer.tick().await;
                    let Some(app) = weak.upgrade() else {
                        return;
                    };
                    app.tick();
                }
            }));
        }
        app
    }

    pub fn state(&self) -> Value {
        locked(&self.inner).engine.state()
    }

    /// Called once the first window can accept a session opened by a restored trigger.
    pub fn ready(self: &Arc<Self>) {
        self.with(|inner| {
            if !inner.closed {
                inner.ready = true;
                self.sync_triggers(inner);
            }
        });
    }

    pub fn tick(self: &Arc<Self>) {
        self.with(|inner| inner.engine.tick(self.host.now()));
    }

    /// `origin` is supplied by Base's authenticated native caller, never extracted from page JSON.
    pub fn command(
        self: &Arc<Self>,
        request: &Value,
        origin: Option<&str>,
    ) -> Result<Value, Fault> {
        let mut cleaned;
        let request = if request["action"] == "save" {
            cleaned = request.clone();
            cleaned["draft"] = draft::clean(&request["draft"]);
            &cleaned
        } else {
            request
        };
        self.with(|inner| {
            if inner.closed {
                return Err(Fault::new("schedules_closed", "The schedules closed"));
            }
            let commanded = inner.engine.command(request, origin, self.host.now())?;
            let mut answer = None;
            self.settle(inner, &mut answer);
            for (run, slot) in &inner.runs {
                if !slot.committed && !inner.engine.launch_allowed(run) {
                    (slot.stop)();
                }
            }
            if let Commanded::Asked(ask) = commanded {
                match answer {
                    Some((answered, result)) if answered == ask => result?,
                    _ => {
                        return Err(Fault::new(
                            "internal",
                            "The schedule reservation did not settle",
                        ));
                    }
                }
            }
            Ok(inner.engine.state())
        })
    }

    pub fn create(self: &Arc<Self>, draft: &Value, origin: Option<&str>) -> Result<Value, Fault> {
        let draft = draft::clean(draft);
        self.with(|inner| {
            if inner.closed {
                return Err(Fault::new("schedules_closed", "The schedules closed"));
            }
            let id = inner.engine.create(&draft, origin, self.host.now())?;
            Ok(json!({"id":id,"state":inner.engine.state()}))
        })
    }

    pub fn fire(self: &Arc<Self>, id: &str, detail: &str) -> bool {
        self.with(|inner| inner.engine.fire(id, detail, self.host.now()))
    }

    pub fn webhook(self: &Arc<Self>, id: &str, bearer: &str, detail: &str) -> &'static str {
        self.with(|inner| inner.engine.webhook(id, bearer, detail, self.host.now()))
    }

    pub fn prune(self: &Arc<Self>, at: i64) {
        self.with(|inner| inner.engine.prune(at, self.host.now()));
    }

    pub fn read_log(&self, run: &str) -> Result<String, Fault> {
        if !locked(&self.inner).engine.has_run(run) {
            return Err(Fault::new("schedule_error", "Run not found"));
        }
        super::read_log_tail(&self.options.log_dir.join(format!("{run}.log")))
    }

    pub async fn close(self: &Arc<Self>) {
        self.with(|inner| {
            if inner.closed {
                return;
            }
            inner.closed = true;
            for slot in inner.runs.values() {
                (slot.stop)();
            }
            inner.charges.clear();
            inner
                .deferred
                .extend(inner.triggers.close().into_iter().map(Deferred::Source));
            self.keep_marks(inner);
            inner.engine.close(self.host.now());
        });
        if let Some(clock) = locked(&self.clock).take() {
            clock.abort();
        }
        loop {
            let ended = self.ended.notified();
            if {
                let inner = locked(&self.inner);
                inner.runs.is_empty() && inner.source_tasks == 0
            } {
                break;
            }
            ended.await;
        }
    }

    fn with<T>(self: &Arc<Self>, entry: impl FnOnce(&mut Inner) -> T) -> T {
        let (answer, deferred) = {
            let mut inner = locked(&self.inner);
            let answer = entry(&mut inner);
            self.settle(&mut inner, &mut None);
            (answer, std::mem::take(&mut inner.deferred))
        };
        for effect in deferred {
            self.deferred(effect);
        }
        answer
    }

    fn settle(self: &Arc<Self>, inner: &mut Inner, answer: &mut Option<(u64, Result<(), Fault>)>) {
        loop {
            let outs = std::mem::take(&mut inner.engine.outs);
            if outs.is_empty() {
                break;
            }
            for out in outs {
                let now = self.host.now();
                match out {
                    Out::Changed { state, journal } => {
                        self.journal.keep(journal);
                        if inner.ready {
                            self.sync_triggers(inner);
                        }
                        self.state_push.send_replace(state);
                    }
                    Out::Closed { journal } => self.journal.close(&journal),
                    Out::Reserve { ask, device } => {
                        let refused = match self.host.reserve(&device) {
                            Ok(charge) => {
                                inner.charges.insert(ask, charge);
                                None
                            }
                            Err(error) => Some(error.message),
                        };
                        if let Some(result) = inner.engine.reserved(ask, refused.as_deref(), now) {
                            *answer = Some((ask, result));
                        }
                    }
                    Out::Refund { charge } => {
                        inner.charges.remove(&charge);
                    }
                    Out::Prepare { run, prompt, cwd } => {
                        let error =
                            prepare_files(&self.options.log_dir, &run, &prompt, cwd.as_deref());
                        inner.engine.prepared(&run, error, now);
                    }
                    Out::Start {
                        run,
                        schedule,
                        wake,
                        charge,
                    } => self.prepare_run(inner, run, schedule, wake, charge),
                    Out::WakeLog { run, text } => {
                        let file = self.options.log_dir.join(format!("{run}.log"));
                        if let Err(error) = std::fs::write(&file, text) {
                            if let Some(slot) = inner.runs.get(&run) {
                                (slot.stop)();
                            }
                            inner.engine.ended(
                                &run,
                                None,
                                Some(crate::disk::tree::fault(&error, "open", &file).message),
                                now,
                            );
                        }
                    }
                    Out::Stop { run } => {
                        if let Some(slot) = inner.runs.get(&run) {
                            (slot.stop)();
                        }
                    }
                    Out::RemovePrompt { run } => {
                        let _ = std::fs::remove_file(
                            self.options.log_dir.join(format!("{run}.prompt")),
                        );
                    }
                    Out::RemoveLogs { runs } => {
                        for run in runs {
                            let _ = std::fs::remove_file(
                                self.options.log_dir.join(format!("{run}.log")),
                            );
                        }
                    }
                }
            }
        }
    }

    fn prepare_run(
        self: &Arc<Self>,
        inner: &mut Inner,
        run: String,
        schedule: Value,
        wake: bool,
        charge: Option<u64>,
    ) {
        if inner.runs.contains_key(&run) {
            return;
        }
        let (cancel, mut cancelled) = watch::channel(false);
        let stop: Stop = Arc::new(move || {
            cancel.send_replace(true);
        });
        inner.runs.insert(
            run.clone(),
            Slot {
                stop,
                committed: false,
            },
        );
        let weak = Arc::downgrade(self);
        let host = Arc::clone(&self.host);
        tokio::spawn(async move {
            let resolved = if wake {
                Ok(None)
            } else {
                tokio::select! {
                    biased;
                    _ = cancelled.changed() => Err(Fault::new("cancelled", "The run was stopped before launch")),
                    command = host.resolve_launch(&schedule) => command.map(Some),
                }
            };
            let Some(app) = weak.upgrade() else {
                return;
            };
            let process = app.with(|inner| {
                if inner.closed || !inner.engine.launch_allowed(&run) {
                    return Err(Fault::new("cancelled", "The run was stopped before launch"));
                }
                let command = resolved?;
                let process = match command {
                    None => app.host.wake(&schedule, &run)?,
                    Some(command) => app.spawn(&run, &schedule, command)?,
                };
                if let Some(slot) = inner.runs.get_mut(&run) {
                    slot.committed = true;
                    slot.stop = Arc::clone(&process.stop);
                }
                if let Some(charge) = charge.and_then(|ask| inner.charges.remove(&ask)) {
                    charge.commit();
                }
                inner.engine.started(&run, app.host.now());
                Ok(process)
            });
            drop(app);
            let result = match process {
                Ok(process) => process.done.await,
                Err(error) => RunResult {
                    code: (error.code == "cancelled").then_some(130),
                    error: Some(error.message),
                },
            };
            if let Some(app) = weak.upgrade() {
                app.with(|inner| {
                    inner.runs.remove(&run);
                    inner
                        .engine
                        .ended(&run, result.code, result.error, app.host.now());
                });
                app.ended.notify_waiters();
            }
        });
    }

    fn spawn(
        &self,
        run: &str,
        schedule: &Value,
        command: LaunchCommand,
    ) -> Result<RunProcess, Fault> {
        let params = LaunchParams {
            run: run.into(),
            supervisor: command.supervisor,
            file: command.file,
            args: command.args,
            shell: command.shell,
            env: command.env,
            cwd: schedule["cwd"].as_str().unwrap_or_default().into(),
            log: self
                .options
                .log_dir
                .join(format!("{run}.log"))
                .to_string_lossy()
                .into_owned(),
            prompt: self
                .options
                .log_dir
                .join(format!("{run}.prompt"))
                .to_string_lossy()
                .into_owned(),
            header: command.header,
        };
        let mut child = launch::spawn(&params)?;
        let stdin = Arc::new(Mutex::new(child.stdin.take()));
        let stop_stdin = Arc::clone(&stdin);
        Ok(RunProcess {
            stop: Arc::new(move || {
                locked(&stop_stdin).take();
            }),
            done: Box::pin(async move {
                let status = child.wait().await;
                locked(&stdin).take();
                match status {
                    Ok(status) => RunResult {
                        code: status.code().map(i64::from),
                        error: None,
                    },
                    Err(error) => RunResult {
                        code: None,
                        error: Some(error.to_string()),
                    },
                }
            }),
        })
    }

    fn keep_marks(&self, inner: &Inner) {
        let text = inner.triggers.stored();
        if let Err(error) = write_kept(
            &self.options.marks_file,
            text.as_bytes(),
            Some(0o600),
            0o700,
        ) {
            self.host.log(&error.message);
        }
    }

    fn sync_triggers(&self, inner: &mut Inner) {
        let before = inner.triggers.stored();
        inner.deferred.extend(
            inner
                .triggers
                .sync(&inner.engine.state(), self.host.now())
                .into_iter()
                .map(Deferred::Source),
        );
        if inner.triggers.stored() != before {
            self.keep_marks(inner);
        }
    }

    fn deferred(self: &Arc<Self>, effect: Deferred) {
        match effect {
            Deferred::Source(Effect::Stop(token)) => {
                let process = {
                    let mut inner = locked(&self.inner);
                    inner.warnings.retain(|(source, _), _| source != &token);
                    inner.sources.remove(&token)
                };
                if let Some(process) = process {
                    (process.stop)();
                }
            }
            Deferred::Source(Effect::RunEnded(token)) => {
                let notify = locked(&self.inner)
                    .sources
                    .get(&token)
                    .and_then(|source| source.run_ended.clone());
                if let Some(notify) = notify {
                    notify();
                }
            }
            Deferred::Source(Effect::Start(Start {
                token,
                schedule,
                mark,
            })) => {
                let context = SourceContext {
                    app: Arc::downgrade(self),
                    token: token.clone(),
                };
                let result = {
                    let mut inner = locked(&self.inner);
                    if !inner.triggers.current(&token) {
                        return;
                    }
                    match runtime::start(
                        Arc::clone(&self.host),
                        &schedule,
                        mark,
                        context.clone(),
                        self.options.sources,
                    ) {
                        Ok(mut process) => {
                            let done = process.take_done().expect("new source owns completion");
                            inner.source_tasks += 1;
                            inner.sources.insert(token, process);
                            Ok(done)
                        }
                        Err(error) => Err(error),
                    }
                };
                match result {
                    Ok(done) => {
                        let weak = Arc::downgrade(self);
                        tokio::spawn(async move {
                            done.await;
                            if let Some(app) = weak.upgrade() {
                                locked(&app.inner).source_tasks -= 1;
                                app.ended.notify_waiters();
                            }
                        });
                    }
                    Err(error) => {
                        context.failure("could not start its trigger", Some(&error.message))
                    }
                }
            }
        }
    }
}

impl<H: Host> Drop for Application<H> {
    fn drop(&mut self) {
        if let Some(clock) = locked(&self.clock).take() {
            clock.abort();
        }
        let inner = self
            .inner
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for slot in inner.runs.values() {
            (slot.stop)();
        }
        for process in inner.sources.values() {
            (process.stop)();
        }
        inner.engine.close(self.host.now());
        for out in std::mem::take(&mut inner.engine.outs) {
            if let Out::Closed { journal } = out {
                self.journal.close(&journal);
            }
        }
    }
}

#[cfg(test)]
#[path = "application_tests.rs"]
mod tests;
