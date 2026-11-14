//! Per-session worktrees. Stock owns settings, eligibility and creation through its live bridge;
//! this runtime owns the tab's start gate, questions and one cleanup owner across close and quit.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use ompdesk_app_contract::Owner;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Notify, oneshot};

use crate::server::Fault;

pub type Work<T> = Pin<Box<dyn Future<Output = Result<T, Fault>> + Send>>;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OnStart { Off, Ask, Create }

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OnExit { Keep, Ask, Remove }

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings { pub on_start: OnStart, pub on_exit: OnExit, pub eligible: bool }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    pub source_cwd: String,
    pub base_commit: String,
    pub root: String,
}

impl Worktree {
    fn valid(&self) -> bool {
        [&self.path, &self.branch, &self.source_cwd, &self.base_commit, &self.root]
            .iter().all(|part| !part.is_empty())
    }
    pub fn binding(&self) -> Value {
        json!({"name": self.branch, "branch": self.branch, "baseCwd": self.source_cwd,
            "path": self.path, "lifecycle": true})
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Risk { pub dirty: bool, pub moved: bool, pub off_branch: bool }

#[derive(Clone, Debug, Deserialize)]
pub struct Snapshot { pub state: Risk, pub fingerprint: String, pub present: bool }

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PromptBody {
    Start { cwd: String },
    Exit { path: String, branch: String, #[serde(flatten)] risk: Risk },
}

#[derive(Clone, Debug, Serialize)]
pub struct Prompt { pub id: String, #[serde(flatten)] pub body: PromptBody }

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Notice {
    CreateFailed { cwd: String, message: String },
    RemoveFailed { path: String, message: String },
    KeptRunning { path: String },
    KeptChanged { path: String },
}

pub enum UiEvent { Prompts(Vec<Prompt>), Notice(Notice) }

/// These are pool facts, not page arguments. In particular an existing worktree binding is never adopted.
#[derive(Clone, Debug)]
pub struct Spawn {
    pub owner: Owner,
    pub tab: String,
    pub window: u64,
    pub cwd: String,
    pub agent: bool,
    pub fresh: bool,
    pub session_path: Option<String>,
    pub device: Option<String>,
    pub explicit_worktree: bool,
    pub placeholder: bool,
    pub defer_start: bool,
}

impl Spawn {
    pub fn candidate(&self) -> bool {
        self.agent && self.fresh && self.session_path.as_ref().is_none_or(|s| s.is_empty())
            && self.device.as_ref().is_none_or(|s| s.is_empty()) && !self.explicit_worktree
            && !self.placeholder && !self.defer_start
    }
}

/// Effect-only native services. Implementations must use the existing stock bridge and native git services;
/// they must not decide onStart/onExit, ask whether to create/remove, or issue application authority.
pub trait Host: Send + Sync + 'static {
    type Source: Send + Sync + ?Sized + 'static;
    fn windows(&self) -> Vec<u64>;
    /// Delivery must enqueue synchronously and must not reenter this lifecycle.
    fn send(&self, window: u64, event: UiEvent);
    fn connected(&self, source: &Arc<Self::Source>) -> bool;
    fn bridge(&self, source: &Arc<Self::Source>, method: &str, params: Option<Value>) -> Work<Value>;
    fn branch_prefix(&self) -> Option<String>;
    /// Atomic against pool release. A false answer never attaches the worktree to a different incarnation.
    fn bind(&self, spawn: &Spawn, source: &Arc<Self::Source>, binding: Value) -> Work<bool>;
    fn inspect(&self, worktree: &Worktree) -> Work<Snapshot>;
    /// Existing canonical-root guard and repository lock surround the native session removal effect.
    fn remove(&self, worktree: &Worktree, moved: bool) -> Work<()>;
    fn stop_turn(&self, source: &Arc<Self::Source>) -> Work<()>;
    /// Must capture the exact pool disposal's exit future before releasing the tab.
    fn release(&self, spawn: &Spawn, source: &Arc<Self::Source>) -> Work<()>;
}

pub struct Config {
    pub start_settings: Duration,
    pub exit_settings: Duration,
    pub process_exit: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self { start_settings: Duration::from_secs(10), exit_settings: Duration::from_secs(3),
            process_exit: Duration::from_secs(10) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartPhase { Settings, Asking, Creating, Closed }

struct Start<S: ?Sized> { owner: Owner, source: Arc<S>, phase: StartPhase, exited: Option<Work<()>> }
struct Owned<S: ?Sized> { spawn: Spawn, source: Arc<S>, worktree: Worktree, policy: Mutex<OnExit> }
struct Question { window: u64, tab: Option<String>, body: Prompt, answer: oneshot::Sender<bool> }

struct State<S: ?Sized> {
    starts: HashMap<String, Arc<Mutex<Start<S>>>>,
    owned: HashMap<String, Arc<Owned<S>>>,
    questions: HashMap<u64, Question>,
    next_question: u64,
    tasks: usize,
    finalizing: bool,
}

impl<S: ?Sized> Default for State<S> {
    fn default() -> Self {
        Self { starts: HashMap::new(), owned: HashMap::new(), questions: HashMap::new(),
            next_question: 0, tasks: 0, finalizing: false }
    }
}

enum Exit { Quit, Released(Option<Work<()>>) }

pub struct Lifecycle<H: Host> { host: Arc<H>, config: Config, state: Mutex<State<H::Source>>, settled: Notify }

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl<H: Host> Lifecycle<H> {
    pub fn new(host: Arc<H>, config: Config) -> Arc<Self> {
        Arc::new(Self { host, config, state: Mutex::new(State::default()), settled: Notify::new() })
    }

    pub fn owns(&self, tab: &str) -> bool { lock(&self.state).owned.contains_key(tab) }

    /// Starts at most one gate for a tab. Dropping its waiter does not drop a stock create already in flight.
    pub fn start(self: &Arc<Self>, spawn: Spawn, source: Arc<H::Source>) -> Work<Option<String>> {
        let (reply, answer) = oneshot::channel();
        if !spawn.candidate() { return Box::pin(async { Ok(None) }); }
        let start = Arc::new(Mutex::new(Start { owner: spawn.owner.clone(), source: source.clone(),
            phase: StartPhase::Settings, exited: None }));
        {
            let mut state = lock(&self.state);
            if state.finalizing || state.starts.contains_key(&spawn.tab) || state.owned.contains_key(&spawn.tab) {
                return Box::pin(async { Ok(None) });
            }
            state.starts.insert(spawn.tab.clone(), start.clone());
            state.tasks += 1;
        }
        let this = self.clone();
        tokio::spawn(async move {
            let result = this.start_inner(&spawn, &source, &start).await;
            {
                let mut state = lock(&this.state);
                if state.starts.get(&spawn.tab).is_some_and(|current| Arc::ptr_eq(current, &start)) {
                    state.starts.remove(&spawn.tab);
                }
                state.tasks -= 1;
            }
            let _ = reply.send(result);
            this.settled.notify_waiters();
        });
        Box::pin(async move { Ok(answer.await.unwrap_or(None)) })
    }

    async fn settings(&self, source: &Arc<H::Source>, timeout: Duration) -> Option<Settings> {
        let value = tokio::time::timeout(timeout, self.host.bridge(
            source, "worktree_lifecycle_settings", None)).await.ok()?.ok()?;
        serde_json::from_value(value).ok()
    }

    async fn start_inner(self: &Arc<Self>, spawn: &Spawn, source: &Arc<H::Source>, start: &Arc<Mutex<Start<H::Source>>>) -> Option<String> {
        let settings = self.settings(source, self.config.start_settings).await?;
        if !settings.eligible || settings.on_start == OnStart::Off { return None; }
        {
            let mut start = lock(start);
            if start.phase == StartPhase::Closed { return None; }
            start.phase = StartPhase::Asking;
        }
        if settings.on_start == OnStart::Ask
            && !self.ask(spawn.window, Some(&spawn.tab), PromptBody::Start { cwd: spawn.cwd.clone() }).await {
            return None;
        }
        {
            let mut start = lock(start);
            if start.phase == StartPhase::Closed || !self.host.connected(source) { return None; }
            start.phase = StartPhase::Creating;
        }
        let params = self.host.branch_prefix().filter(|s| !s.is_empty()).map(|prefix| json!({"branchPrefix":prefix}));
        let created = self.host.bridge(source, "worktree_lifecycle_create", params).await
            .and_then(|value| serde_json::from_value::<Worktree>(value)
                .map_err(|_| Fault::new("invalid_worktree", "omp returned an unexpected worktree")))
            .and_then(|worktree| if worktree.valid() { Ok(worktree) } else {
                Err(Fault::new("invalid_worktree", "omp returned an unexpected worktree"))
            });
        let worktree = match created {
            Ok(worktree) => worktree,
            Err(error) => {
                if self.host.connected(source) {
                    self.notice(spawn.window, Notice::CreateFailed { cwd: spawn.cwd.clone(), message: error.message });
                }
                return None;
            }
        };
        let owned = Arc::new(Owned { spawn: spawn.clone(), source: source.clone(), worktree, policy: Mutex::new(settings.on_exit) });
        let should_bind = {
            let state = lock(&self.state);
            lock(start).phase != StartPhase::Closed && !state.finalizing
        };
        let bound = if should_bind {
            match self.host.bind(spawn, source, owned.worktree.binding()).await {
                Ok(bound) => bound,
                Err(error) => {
                    self.notice(spawn.window, Notice::CreateFailed { cwd: spawn.cwd.clone(), message: error.message });
                    false
                }
            }
        } else { false };
        // The hub's binding await may have raced release. It must not publish a new cleanup owner afterward.
        let bound = {
            let mut state = lock(&self.state);
            if bound && lock(start).phase != StartPhase::Closed && !state.finalizing {
                state.owned.insert(spawn.tab.clone(), owned.clone());
                true
            } else { false }
        };
        if bound { return Some(owned.worktree.path.clone()); }
        let exited = lock(start).exited.take();
        let quit = lock(&self.state).finalizing && exited.is_none();
        self.exit(owned, if quit { Exit::Quit } else { Exit::Released(exited) }).await;
        None
    }

    pub async fn refresh_exit_policy(&self, tab: &str) {
        let owned = lock(&self.state).owned.get(tab).cloned();
        if let Some(owned) = owned
            && let Some(settings) = self.settings(&owned.source, self.config.exit_settings).await {
            *lock(&owned.policy) = settings.on_exit;
        }
    }

    /// Called synchronously with pool release, before another task can claim this tab's exit.
    pub fn released(self: &Arc<Self>, owner: &Owner, tab: &str, source: &Arc<H::Source>, exited: Work<()>) {
        let mut exited = Some(exited);
        let owned = {
            let mut state = lock(&self.state);
            let same_start = state.starts.get(tab).is_some_and(|start| {
                let start = lock(start);
                start.owner == *owner && Arc::ptr_eq(&start.source, source)
            });
            let same_owned = state.owned.get(tab).is_some_and(|owned|
                owned.spawn.owner == *owner && Arc::ptr_eq(&owned.source, source));
            if !same_start && !same_owned { return; }
            if let Some(start) = state.starts.get(tab).filter(|_| same_start) {
                let mut start = lock(start);
                start.phase = StartPhase::Closed;
                if !same_owned && start.exited.is_none() { start.exited = exited.take(); }
            }
            let owned = if same_owned { state.owned.remove(tab) } else { None };
            if owned.is_some() { state.tasks += 1; }
            owned
        };
        self.withdraw_tab(tab);
        if let Some(owned) = owned {
            let this = self.clone();
            tokio::spawn(async move {
                this.exit(owned, Exit::Released(exited)).await;
                lock(&this.state).tasks -= 1;
                this.settled.notify_waiters();
            });
        }
    }

    /// Questions remain live during preparation; release races are resolved by identity under the state lock.
    pub async fn finalize(self: &Arc<Self>) {
        let owned = {
            let mut state = lock(&self.state);
            if state.finalizing { None } else {
                state.finalizing = true;
                for start in state.starts.values() { lock(start).phase = StartPhase::Closed; }
                state.tasks += state.owned.len();
                Some(state.owned.values().cloned().collect::<Vec<_>>())
            }
        };
        let tabs = lock(&self.state).starts.keys().cloned().collect::<Vec<_>>();
        for tab in tabs { self.withdraw_tab(&tab); }
        for owned in owned.into_iter().flatten() {
            let this = self.clone();
            tokio::spawn(async move {
                this.withdraw_tab(&owned.spawn.tab);
                let _ = this.host.stop_turn(&owned.source).await;
                this.refresh_exit_policy(&owned.spawn.tab).await;
                let taken = {
                    let mut state = lock(&this.state);
                    if state.owned.get(&owned.spawn.tab).is_some_and(|entry| Arc::ptr_eq(entry, &owned)) {
                        state.owned.remove(&owned.spawn.tab);
                        true
                    } else { false }
                };
                if taken { this.exit(owned, Exit::Quit).await; }
                lock(&this.state).tasks -= 1;
                this.settled.notify_waiters();
            });
        }
        self.settle().await;
    }

    pub async fn settle(&self) {
        loop {
            let notified = self.settled.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if lock(&self.state).tasks == 0 { return; }
            notified.await;
        }
    }

    async fn wait_exit(&self, owned: &Owned<H::Source>, exited: Work<()>) -> bool {
        if matches!(tokio::time::timeout(self.config.process_exit, exited).await, Ok(Ok(()))) { return true; }
        self.notice(owned.spawn.window, Notice::KeptRunning { path: owned.worktree.path.clone() });
        false
    }

    async fn plan(&self, owned: &Owned<H::Source>) -> Option<String> {
        let policy = *lock(&owned.policy);
        if policy == OnExit::Keep { return None; }
        let snapshot = match self.host.inspect(&owned.worktree).await {
            Ok(snapshot) => snapshot,
            Err(error) => { self.remove_failed(owned, error); return None; }
        };
        // Stock decideWorktreeExit; runs after stock has gone, where its JS cannot run.
        let risk = snapshot.state;
        if (policy == OnExit::Ask || risk.dirty || risk.moved || risk.off_branch)
            && !self.ask(owned.spawn.window, None, PromptBody::Exit {
                path: owned.worktree.path.clone(), branch: owned.worktree.branch.clone(), risk }).await {
            return None;
        }
        Some(snapshot.fingerprint)
    }

    async fn exit(&self, owned: Arc<Owned<H::Source>>, exit: Exit) {
        if *lock(&owned.policy) == OnExit::Keep { return; }
        let quit = matches!(&exit, Exit::Quit);
        // Quit plans while the windows exist, ordinary close waits for the captured disposal before inspecting.
        if let Exit::Released(exited) = exit {
            let exited = exited.unwrap_or_else(|| Box::pin(async {
                Err(Fault::new("exit_unavailable", "The released omp's exit was not captured"))
            }));
            if !self.wait_exit(&owned, exited).await { return; }
        }
        let Some(approved) = self.plan(&owned).await else { return };
        if quit && !self.wait_exit(&owned, self.host.release(&owned.spawn, &owned.source)).await { return; }
        let result = async {
            let now = self.host.inspect(&owned.worktree).await?;
            if now.present && now.fingerprint != approved {
                self.notice(owned.spawn.window, Notice::KeptChanged { path: owned.worktree.path.clone() });
                return Ok(());
            }
            self.host.remove(&owned.worktree, now.state.moved).await
        }.await;
        if let Err(error) = result { self.remove_failed(&owned, error); }
    }

    fn remove_failed(&self, owned: &Owned<H::Source>, error: Fault) {
        self.notice(owned.spawn.window, Notice::RemoveFailed { path: owned.worktree.path.clone(), message: error.message });
    }

    fn target(&self, preferred: u64) -> Option<u64> {
        let live = self.host.windows();
        live.contains(&preferred).then_some(preferred).or_else(|| live.first().copied())
    }

    fn notice(&self, window: u64, body: Notice) {
        if let Some(window) = self.target(window) { self.host.send(window, UiEvent::Notice(body)); }
        else { eprintln!("[worktree-lifecycle] {body:?}"); }
    }

    async fn ask(&self, window: u64, tab: Option<&str>, body: PromptBody) -> bool {
        let Some(window) = self.target(window) else { return false };
        let (answer, receiver) = oneshot::channel();
        let id = {
            let mut state = lock(&self.state);
            // Close may have withdrawn this start between its phase change and inserting the question.
            if tab.is_some_and(|tab| state.starts.get(tab).is_some_and(|s| lock(s).phase == StartPhase::Closed)) {
                return false;
            }
            state.next_question += 1;
            let id = state.next_question;
            let body = Prompt { id: format!("wt-{id}"), body };
            state.questions.insert(id, Question { window, tab: tab.map(str::to_owned), body, answer });
            id
        };
        self.push(window);
        let result = receiver.await.unwrap_or(false);
        // A cancelled receiver never grants approval; normal settlement already removed the question.
        self.resolve(window, id, false);
        result
    }

    pub fn prompts(&self, window: u64) -> Vec<Prompt> {
        Self::prompt_list(&lock(&self.state), window)
    }

    fn prompt_list(state: &State<H::Source>, window: u64) -> Vec<Prompt> {
        let mut questions = state.questions.iter().filter(|(_, q)| q.window == window).collect::<Vec<_>>();
        questions.sort_by_key(|(id, _)| **id);
        questions.into_iter().map(|(_, q)| q.body.clone()).collect()
    }

    pub fn answer(&self, window: u64, id: &str, accept: bool) -> bool {
        id.strip_prefix("wt-").and_then(|id| id.parse().ok())
            .is_some_and(|id| self.resolve(window, id, accept))
    }

    fn resolve(&self, window: u64, id: u64, accept: bool) -> bool {
        let question = {
            let mut state = lock(&self.state);
            if !state.questions.get(&id).is_some_and(|q| q.window == window) { return false; }
            state.questions.remove(&id)
        };
        if let Some(question) = question { let _ = question.answer.send(accept); }
        self.push(window);
        true
    }

    pub fn window_closed(&self, window: u64) { self.withdraw(|q| q.window == window); }
    fn withdraw_tab(&self, tab: &str) { self.withdraw(|q| q.tab.as_deref() == Some(tab)); }
    fn withdraw(&self, matches: impl Fn(&Question) -> bool) {
        let questions = lock(&self.state).questions.iter().filter(|(_, q)| matches(q))
            .map(|(id, q)| (*id, q.window)).collect::<Vec<_>>();
        for (id, window) in questions { self.resolve(window, id, false); }
    }
    fn push(&self, window: u64) {
        let state = lock(&self.state);
        if self.host.windows().contains(&window) {
            self.host.send(window, UiEvent::Prompts(Self::prompt_list(&state, window)));
        }
    }
}

#[cfg(test)]
mod tests;
