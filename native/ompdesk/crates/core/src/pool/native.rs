//! Native facade of the existing hub pool. The hub remains the sole writer of claims, runs, layouts and views.

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use ompdesk_app_contract::Owner;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::{Application, EffectFuture, Sidecar, effects};
use crate::hub::{self, LocalFuture, NativeSink, Out, Outcome};
use crate::pool::{
    self as engine,
    state::{Ctx, P},
};
use crate::server::Fault;

pub struct Config {
    /// Allocated by Base's native instance registry, not page data.
    pub id: u64,
    pub layout_version: i64,
    pub max_former_tab_ids: usize,
    pub stop_session_wait_ms: u64,
    pub window_tabs_hook: bool,
    pub now_ms: fn() -> i64,
}

pub struct Acquire {
    pub tab: String,
    pub cwd: String,
    pub session_path: Option<String>,
    pub kind: String,
    pub worktree: Option<Value>,
    pub fresh: bool,
    pub placeholder: bool,
    pub defer_start: bool,
    pub title: Option<String>,
    pub device: Option<String>,
    pub task: Option<String>,
    pub former_ids: Option<Vec<String>>,
}

pub struct Selected<S: Sidecar + ?Sized> {
    pub tab: String,
    pub device: Option<String>,
    pub window: i64,
    pub session_file: Option<String>,
    pub sidecar: Arc<S>,
}

pub struct SessionTarget<S: Sidecar + ?Sized> {
    pub tab: String,
    pub window: i64,
    pub device: Option<String>,
    pub session_file: String,
    pub incarnation: u64,
    pub sidecar: Arc<S>,
}

impl<S: Sidecar + ?Sized> Clone for SessionTarget<S> {
    fn clone(&self) -> Self {
        Self {
            tab: self.tab.clone(),
            window: self.window,
            device: self.device.clone(),
            session_file: self.session_file.clone(),
            incarnation: self.incarnation,
            sidecar: Arc::clone(&self.sidecar),
        }
    }
}

pub trait Host: effects::Host<Sidecar: Sidecar<Error = Fault>> + 'static {
    type Reservation: Send + 'static;
    fn window_for(&self, owner: &Owner) -> Result<i64, Fault>;
    fn reserve_owner(&self, owner: &Owner, tab: &str) -> Result<Self::Reservation, Fault>;
    fn finish_reservation(&self, reservation: Self::Reservation, acquired: bool);
    fn authorize_tab(&self, owner: &Owner, tab: &str) -> Result<(), Fault>;
    /// The actual release receipt registered inside Application::dispose, not a wait captured before release.
    fn when_released(
        &self,
        tab: String,
        source: Arc<Self::Sidecar>,
    ) -> EffectFuture<'static, Result<(), Fault>>;
    /// Called on the hub thread with the snapshot captured at this activity, before the next job can change it.
    fn announce(&self, activity: Value, tabs: Value, outcome_id: Option<u64>);
}

struct Reserved<H: Host> {
    host: Arc<H>,
    value: Option<H::Reservation>,
}

impl<H: Host> Reserved<H> {
    fn finish(&mut self, acquired: bool) {
        if let Some(value) = self.value.take() {
            self.host.finish_reservation(value, acquired);
        }
    }
}

impl<H: Host> Drop for Reserved<H> {
    fn drop(&mut self) {
        self.finish(false);
    }
}

type Pending = HashMap<u64, oneshot::Sender<Result<Value, Fault>>>;

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Sink<H: Host> {
    id: u64,
    app: Arc<Application<H>>,
    pending: Arc<Mutex<Pending>>,
}

impl<H: Host> Sink<H> {
    fn incarnation_sidecar(&self, payload: &Value) -> Option<Arc<H::Sidecar>> {
        let tab = payload["tab"].as_str()?;
        let incarnation = payload["incarnation"].as_u64()?;
        let live = engine::POOLS.with(|pools| {
            pools.borrow().get(&self.id).is_some_and(|ctx| {
                ctx.with(|pool| {
                    pool.entry(tab)
                        .is_some_and(|entry| entry.seq == incarnation)
                })
            })
        });
        self.app.incarnation_sidecar(tab, incarnation, live)
    }
}

impl<H: Host> NativeSink for Sink<H> {
    fn item(&self, item: Value) {
        if matches!(item["k"].as_str(), Some("__native_pool_result" | "settle")) {
            let token = item["token"].as_u64().unwrap_or_default();
            if let Some(waiting) = locked(&self.pending).remove(&token) {
                let result = if item["ok"] == true {
                    Ok(item["value"].clone())
                } else {
                    Err(Fault::new(
                        item["code"].as_str().unwrap_or("main_error").to_owned(),
                        item["message"].as_str().unwrap_or_default(),
                    ))
                };
                let _ = waiting.send(result);
            }
            return;
        }
        if item["k"] == "command" && item["incarnation"].as_u64().is_some() {
            if let Some(sidecar) = self.incarnation_sidecar(&item) {
                let work = self.app.host.command(sidecar, item["command"].clone());
                hub::spawn(async move {
                    let _ = work.await;
                });
            }
            return;
        }

        // Application::effect performs synchronous delivery before yielding its optional continuation.
        if let Some(work) = self.app.effect(&item) {
            hub::spawn(work);
        }
    }

    fn ask(
        &self,
        question: String,
        payload: Value,
        _sync: bool,
    ) -> LocalFuture<Result<Value, Fault>> {
        if question == "rpc" && payload["incarnation"].as_u64().is_some() {
            let work = self
                .incarnation_sidecar(&payload)
                .map(|sidecar| self.app.host.command(sidecar, payload["command"].clone()));
            return Box::pin(async move {
                match work {
                    Some(work) => work.await,
                    None => Ok(Value::Null),
                }
            });
        }
        if question == "announce" {
            let ctx = engine::POOLS.with(|pools| pools.borrow().get(&self.id).cloned());
            let result = ctx.ok_or_else(closed).map(|ctx| {
                let tabs = snapshot(&ctx, &self.app);
                let activity = &payload["activity"];
                let outcome_id = (activity["type"] == "idle")
                    .then(|| {
                        ctx.with(|pool| {
                            pool.entry_any(activity["tabId"].as_str().unwrap_or_default())
                                .and_then(|entry| entry.tracking.last_run_id)
                        })
                    })
                    .flatten();
                self.app.host.announce(activity.clone(), tabs, outcome_id);
                Value::Null
            });
            return Box::pin(std::future::ready(result));
        }
        let app = Arc::clone(&self.app);
        Box::pin(async move { app.ask(&question, &payload).await })
    }
}

impl<H: Host> Drop for Sink<H> {
    fn drop(&mut self) {
        locked(&self.pending).clear();
    }
}

pub struct Service<H: Host> {
    out: Out,
    app: Arc<Application<H>>,
    pending: Arc<Mutex<Pending>>,
    next: AtomicU64,
    now_ms: fn() -> i64,
    window_tabs_hook: bool,
}

fn check_target<H: Host>(
    ctx: &Ctx,
    app: &Application<H>,
    owner: &Owner,
    target: &SessionTarget<H::Sidecar>,
) -> Result<(), Fault> {
    app.host.authorize_tab(owner, &target.tab)?;
    let current = ctx.with(|pool| {
        pool.owner_entry(target.device.as_deref(), &target.session_file)
            .is_some_and(|entry| entry.seq == target.incarnation && entry.tab_id == target.tab)
    });
    if !current
        || !app
            .sidecar(&target.tab)
            .is_some_and(|sidecar| Arc::ptr_eq(&sidecar, &target.sidecar))
    {
        return Err(Fault::new("tab_stale", "The session's sidecar has changed"));
    }
    Ok(())
}

impl<H: Host> Service<H> {
    pub async fn new(config: Config, app: Arc<Application<H>>) -> Result<Arc<Self>, Fault> {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let sink_app = Arc::clone(&app);
        let sink_pending = Arc::clone(&pending);
        let (bound, binding) = oneshot::channel();
        let now_ms = config.now_ms;
        let window_tabs_hook = config.window_tabs_hook;
        hub::post(move || {
            let sink = Rc::new(Sink {
                id: config.id,
                app: sink_app,
                pending: sink_pending,
            });
            let opts = serde_json::value::to_raw_value(&json!({
                "layoutVersion": config.layout_version, "maxFormerTabIds": config.max_former_tab_ids,
                "stopSessionWaitMs": config.stop_session_wait_ms,
            })).map_err(|error| Fault::new("invalid_params", error.to_string()));
            let result = opts.and_then(|opts| {
                hub::bind_native(config.id, &engine::KIND, sink, |out| {
                    engine::open(config.id, &opts, out)
                })
            });
            if let Err(Ok(out)) = bound.send(result) {
                out.close();
            }
        });
        let out = binding.await.map_err(|_| closed())??;
        Ok(Arc::new(Self {
            out,
            app,
            pending,
            next: AtomicU64::new(1),
            now_ms,
            window_tabs_hook,
        }))
    }

    fn execute(
        &self,
        late: bool,
        action: impl FnOnce(Ctx, u64) -> Outcome + Send + 'static,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        let token = self.next.fetch_add(1, Ordering::Relaxed);
        let (reply, answer) = oneshot::channel();
        locked(&self.pending).insert(token, reply);
        let out = self.out;
        let now_ms = self.now_ms;
        let window_tabs_hook = self.window_tabs_hook;
        let pending = Arc::clone(&self.pending);
        hub::post(move || {
            if !out.open() {
                if let Some(waiting) = locked(&pending).remove(&token) {
                    let _ = waiting.send(Err(closed()));
                }
                return;
            }
            let ctx = engine::POOLS.with(|pools| pools.borrow().get(&out.id()).cloned());
            let Some(ctx) = ctx else {
                finish(out, token, Err(closed()));
                return;
            };
            ctx.with(|pool| {
                pool.now = now_ms();
                pool.window_tabs_hook = window_tabs_hook;
            });
            let outcome = action(ctx, token);
            let done = move |result: Result<Value, Fault>| {
                if !late || result.is_err() {
                    finish(out, token, result);
                }
            };
            match outcome {
                Outcome::Now(result) => done(result),
                Outcome::Later(work) => hub::spawn(async move {
                    done(work.await);
                }),
            }
        });
        let waiting = Waiting {
            pending: Arc::downgrade(&self.pending),
            token,
        };
        Box::pin(async move {
            let _waiting = waiting;
            answer.await.map_err(|_| closed())?
        })
    }

    /// Internal engine calls retain Value as the engine's data model; nothing is encoded through a Node/IPC client.
    pub(crate) fn call(
        &self,
        method: &'static str,
        params: Value,
        late: bool,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        self.execute(late, move |ctx, token| {
            let mut params = params;
            if late {
                params["token"] = Value::from(token);
            }
            engine::dispatch(ctx, method, P(params))
        })
    }

    pub fn source(&self, owner: &Owner, tab: &str) -> Result<Arc<H::Sidecar>, Fault> {
        self.app.host.authorize_tab(owner, tab)?;
        self.app
            .sidecar(tab)
            .ok_or_else(|| Fault::new("tab_unknown", "The tab is not open"))
    }
    pub fn bind_if_live(
        &self,
        owner: &Owner,
        tab: &str,
        source: Arc<H::Sidecar>,
        binding: Value,
    ) -> EffectFuture<'static, Result<bool, Fault>> {
        let owner = owner.clone();
        let tab = tab.to_owned();
        let app = Arc::clone(&self.app);
        let work = self.execute(false, move |ctx, _| {
            Outcome::Later(Box::pin(async move {
                app.host.authorize_tab(&owner, &tab)?;
                let win = {
                    let handles = app.handles();
                    if !handles
                        .get(&super::HandleKey::Tab(tab.clone()))
                        .is_some_and(|handle| Arc::ptr_eq(&handle.sidecar, &source))
                    {
                        return Ok(Value::Bool(false));
                    }
                    ctx.bind_worktree_start(&tab, binding)
                };
                let Some(win) = win else {
                    return Ok(Value::Bool(false));
                };
                Ok(Value::Bool(ctx.bind_worktree_finish(&tab, win).await?))
            }))
        });
        Box::pin(async move { Ok(work.await? == Value::Bool(true)) })
    }

    pub fn bridge_if_live(
        &self,
        owner: &Owner,
        tab: &str,
        source: Arc<H::Sidecar>,
        method: String,
        params: Option<Value>,
        timeout_ms: Option<u64>,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        let owner = owner.clone();
        let tab = tab.to_owned();
        let app = Arc::clone(&self.app);
        self.execute(false, move |ctx, _| {
            if let Err(error) = app.host.authorize_tab(&owner, &tab) {
                return Outcome::Now(Err(error));
            }
            let live = ctx.with(|pool| pool.entry(&tab).is_some());
            if !live
                || !app
                    .sidecar(&tab)
                    .is_some_and(|current| Arc::ptr_eq(&current, &source))
            {
                return Outcome::Now(Err(Fault::new(
                    "tab_stale",
                    "The tab's sidecar has changed",
                )));
            }
            let request = source.bridge(method, params, timeout_ms);
            Outcome::Later(Box::pin(request))
        })
    }

    pub fn guard_plan(&self, tab: &str, own: bool) -> EffectFuture<'static, Result<(), Fault>> {
        let tab = tab.to_owned();
        let work = self.execute(false, move |ctx, _| {
            Outcome::Now(ctx.guard_plan(&tab, own).map(|()| Value::Null))
        });
        Box::pin(async move { work.await.map(|_| ()) })
    }

    pub fn note_prompted(&self, tab: &str) -> EffectFuture<'static, Result<(), Fault>> {
        self.note_counter(tab, false)
    }

    pub fn note_touched(&self, tab: &str) -> EffectFuture<'static, Result<(), Fault>> {
        self.note_counter(tab, true)
    }

    fn note_counter(&self, tab: &str, touched: bool) -> EffectFuture<'static, Result<(), Fault>> {
        let tab = tab.to_owned();
        let work = self.execute(false, move |ctx, _| {
            Outcome::Later(Box::pin(async move {
                ctx.note_counter(&tab, touched).await.map(|()| Value::Null)
            }))
        });
        Box::pin(async move { work.await.map(|_| ()) })
    }

    pub fn note_unstarted(
        &self,
        tab: &str,
        unstarted: bool,
    ) -> EffectFuture<'static, Result<(), Fault>> {
        let tab = tab.to_owned();
        let work = self.execute(false, move |ctx, _| {
            Outcome::Later(Box::pin(async move {
                ctx.note_unstarted(&tab, unstarted)
                    .await
                    .map(|()| Value::Null)
            }))
        });
        Box::pin(async move { work.await.map(|_| ()) })
    }

    pub fn note_draft(
        &self,
        tab: &str,
        window: i64,
        command: &str,
        empty: bool,
    ) -> EffectFuture<'static, Result<bool, Fault>> {
        let tab = tab.to_owned();
        let command = command.to_owned();
        let work = self.execute(false, move |ctx, _| {
            Outcome::Now(Ok(Value::Bool(
                ctx.note_draft(&tab, window, &command, empty),
            )))
        });
        Box::pin(async move { Ok(work.await? == Value::Bool(true)) })
    }

    pub fn note_subagent_level(
        &self,
        tab: &str,
        window: i64,
        level: &str,
    ) -> EffectFuture<'static, Result<String, Fault>> {
        let tab = tab.to_owned();
        let level = level.to_owned();
        let work = self.execute(false, move |ctx, _| {
            Outcome::Now(Ok(Value::String(ctx.note_subagent_level(
                &tab,
                engine::state::LevelKey::Window(window),
                &level,
            ))))
        });
        Box::pin(async move {
            match work.await? {
                Value::String(level) => Ok(level),
                _ => Err(Fault::new("invalid_result", "Invalid subagent level")),
            }
        })
    }

    pub fn foreign_session_owner(
        &self,
        tab: Option<&str>,
        path: &str,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        let tab = tab.map(str::to_owned);
        let path = path.to_owned();
        self.execute(false, move |ctx, _| {
            Outcome::Now(Ok(ctx.foreign_session_owner(tab.as_deref(), &path)))
        })
    }
    pub fn session_running(
        &self,
        path: &str,
        device: Option<&str>,
    ) -> EffectFuture<'static, Result<bool, Fault>> {
        let path = path.to_owned();
        let device = device.map(str::to_owned);
        let work = self.execute(false, move |ctx, _| {
            Outcome::Now(Ok(Value::Bool(
                ctx.session_running(&path, device.as_deref()),
            )))
        });
        Box::pin(async move { Ok(work.await? == Value::Bool(true)) })
    }

    pub fn session_owner(
        &self,
        path: &str,
        device: Option<&str>,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        let path = path.to_owned();
        let device = device.map(str::to_owned);
        self.execute(false, move |ctx, _| {
            Outcome::Now(Ok(ctx.session_owner(&path, device.as_deref())))
        })
    }

    pub fn session_owner_is_live(
        &self,
        path: &str,
        device: Option<&str>,
    ) -> EffectFuture<'static, Result<bool, Fault>> {
        let path = path.to_owned();
        let device = device.map(str::to_owned);
        let app = Arc::clone(&self.app);
        let work = self.execute(false, move |ctx, _| {
            let found = ctx.with(|pool| {
                pool.owner_entry(device.as_deref(), &path)
                    .map(|entry| (entry.tab_id.clone(), entry.status.clone()))
            });
            let Some((tab, status)) = found else {
                return Outcome::Now(Ok(Value::Bool(false)));
            };
            let Some(sidecar) = app.sidecar(&tab) else {
                return Outcome::Now(Err(Fault::new(
                    "tab_unknown",
                    "The session's sidecar is not open",
                )));
            };
            let alive = sidecar.facts()["processAlive"] == true
                || !matches!(status.as_str(), "asleep" | "exited" | "error");
            Outcome::Now(Ok(Value::Bool(alive)))
        });
        Box::pin(async move { Ok(work.await? == Value::Bool(true)) })
    }

    pub fn note_session_name(
        &self,
        owner: &Owner,
        tab: &str,
        source: Arc<H::Sidecar>,
        title: &str,
    ) -> EffectFuture<'static, Result<bool, Fault>> {
        let owner = owner.clone();
        let tab = tab.to_owned();
        let title = title.to_owned();
        let app = Arc::clone(&self.app);
        let work = self.execute(false, move |ctx, _| {
            Outcome::Later(Box::pin(async move {
                app.host.authorize_tab(&owner, &tab)?;
                let wins = {
                    let handles = app.handles();
                    if !handles
                        .get(&super::HandleKey::Tab(tab.clone()))
                        .is_some_and(|handle| Arc::ptr_eq(&handle.sidecar, &source))
                    {
                        return Ok(Value::Bool(false));
                    }
                    ctx.note_session_name_start(&tab, &title)
                };
                let Some(wins) = wins else {
                    return Ok(Value::Bool(false));
                };
                ctx.note_session_name_finish(&tab, &title, wins).await?;
                Ok(Value::Bool(true))
            }))
        });
        Box::pin(async move { Ok(work.await? == Value::Bool(true)) })
    }

    pub fn acquire(
        &self,
        owner: &Owner,
        request: Acquire,
    ) -> Result<EffectFuture<'static, Result<Value, Fault>>, Fault> {
        let window = self.app.host.window_for(owner)?;
        let mut reservation = Reserved {
            host: Arc::clone(&self.app.host),
            value: Some(self.app.host.reserve_owner(owner, &request.tab)?),
        };
        let args = engine::windows::Acquire {
            cwd: request.cwd,
            win: window,
            tab: request.tab,
            session_path: request.session_path,
            kind: request.kind,
            worktree: request.worktree,
            fresh: request.fresh,
            placeholder: request.placeholder,
            defer_start: request.defer_start,
            title: request.title,
            device: request.device,
            task: request.task,
            former_ids: request.former_ids,
        };
        Ok(self.execute(false, move |ctx, _| {
            Outcome::Later(Box::pin(async move {
                let (ok, added) = ctx.acquire(args).await?;
                reservation.finish(ok);
                Ok(json!({"ok": ok, "added": added}))
            }))
        }))
    }

    pub fn start(&self, owner: &Owner, tab: &str) -> Result<(), Fault> {
        self.source(owner, tab)?.start();
        Ok(())
    }

    pub fn restart(&self, owner: &Owner, tab: &str, session: Option<&str>) -> Result<(), Fault> {
        self.source(owner, tab)?.restart(session);
        Ok(())
    }

    pub fn sleep(&self, owner: &Owner, tab: &str) -> Result<(), Fault> {
        self.source(owner, tab)?.sleep();
        Ok(())
    }

    pub fn stock(
        &self,
        owner: &Owner,
        tab: &str,
        command: Value,
    ) -> Result<EffectFuture<'static, Result<Value, Fault>>, Fault> {
        Ok(self.source(owner, tab)?.stock(command))
    }

    pub fn bridge(
        &self,
        owner: &Owner,
        tab: &str,
        method: String,
        params: Option<Value>,
        timeout_ms: Option<u64>,
    ) -> Result<EffectFuture<'static, Result<Value, Fault>>, Fault> {
        Ok(self.source(owner, tab)?.bridge(method, params, timeout_ms))
    }

    pub fn side_channel(&self, owner: &Owner, tab: &str, frame: Value) -> Result<(), Fault> {
        self.source(owner, tab)?.send_now(frame)
    }

    pub fn target(
        &self,
        owner: &Owner,
        tab: Option<&str>,
    ) -> EffectFuture<'static, Result<Option<Selected<H::Sidecar>>, Fault>> {
        let owner = owner.clone();
        let tab = tab.map(str::to_owned);
        let app = Arc::clone(&self.app);
        let out = self.out;
        let (reply, answer) = oneshot::channel();
        hub::post(move || {
            if reply.is_closed() {
                return;
            }
            let selected = (|| {
                if !out.open() {
                    return Err(closed());
                }
                let window = app.host.window_for(&owner)?;
                let ctx = engine::POOLS
                    .with(|pools| pools.borrow().get(&out.id()).cloned())
                    .ok_or_else(closed)?;
                let Some(selected) = ctx.selected_target(window, tab.as_deref()) else {
                    return Ok(None);
                };
                app.host.authorize_tab(&owner, &selected.tab)?;
                Ok(app.sidecar(&selected.tab).map(|sidecar| Selected {
                    tab: selected.tab,
                    device: selected.device,
                    window: selected.window,
                    session_file: selected.session_file,
                    sidecar,
                }))
            })();
            let _ = reply.send(selected);
        });
        Box::pin(async move { answer.await.map_err(|_| closed())? })
    }

    pub fn session_target(
        &self,
        owner: &Owner,
        path: &str,
        device: Option<&str>,
    ) -> EffectFuture<'static, Result<Option<SessionTarget<H::Sidecar>>, Fault>> {
        let owner = owner.clone();
        let path = path.to_owned();
        let device = device.map(str::to_owned);
        let app = Arc::clone(&self.app);
        let out = self.out;
        let (reply, answer) = oneshot::channel();
        hub::post(move || {
            let result = (|| {
                if !out.open() {
                    return Err(closed());
                }
                let ctx = engine::POOLS
                    .with(|pools| pools.borrow().get(&out.id()).cloned())
                    .ok_or_else(closed)?;
                let entry = ctx.with(|pool| {
                    pool.owner_entry(device.as_deref(), &path).map(|entry| {
                        (
                            entry.tab_id.clone(),
                            entry.win_id,
                            entry.device.clone(),
                            entry.seq,
                        )
                    })
                });
                let Some((tab, window, device, incarnation)) = entry else {
                    return Ok(None);
                };
                app.host.authorize_tab(&owner, &tab)?;
                let sidecar = app.sidecar(&tab).ok_or_else(|| {
                    Fault::new("tab_unknown", "The session's sidecar is not open")
                })?;
                Ok(Some(SessionTarget {
                    tab,
                    window,
                    device,
                    session_file: path,
                    incarnation,
                    sidecar,
                }))
            })();
            let _ = reply.send(result);
        });
        Box::pin(async move { answer.await.map_err(|_| closed())? })
    }
    pub fn close_session_tab(
        &self,
        owner: &Owner,
        target: &SessionTarget<H::Sidecar>,
    ) -> EffectFuture<'static, Result<bool, Fault>> {
        let owner = owner.clone();
        let target = target.clone();
        let app = Arc::clone(&self.app);
        let work = self.execute(false, move |ctx, _| {
            Outcome::Later(Box::pin(async move {
                check_target(&ctx, &app, &owner, &target)?;
                if ctx.with(|pool| pool.entry(&target.tab).is_some_and(|entry| entry.busy())) {
                    return Ok(Value::Bool(false));
                }
                if !ctx.release_entry(&target.tab).await? {
                    return Err(Fault::new("tab_stale", "The session's tab is not open"));
                }
                ctx.notify_window_tabs_changed(target.window).await?;
                ctx.send_tab_list(target.window, Some(std::slice::from_ref(&target.tab)), None)
                    .await?;
                app.host.when_released(target.tab, target.sidecar).await?;
                Ok(Value::Bool(true))
            }))
        });
        Box::pin(async move { Ok(work.await? == Value::Bool(true)) })
    }

    pub fn stop_session(
        &self,
        owner: &Owner,
        target: &SessionTarget<H::Sidecar>,
    ) -> EffectFuture<'static, Result<(), Fault>> {
        let owner = owner.clone();
        let target = target.clone();
        let app = Arc::clone(&self.app);
        let work = self.execute(true, move |ctx, token| {
            Outcome::Later(Box::pin(async move {
                check_target(&ctx, &app, &owner, &target)?;
                ctx.stop_session(token, &target.session_file, target.device.as_deref())
                    .await?;
                Ok(Value::Null)
            }))
        });
        Box::pin(async move { work.await.map(|_| ()) })
    }

    pub fn command_for_session(
        &self,
        owner: &Owner,
        target: &SessionTarget<H::Sidecar>,
        command: Value,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        let owner = owner.clone();
        let target = target.clone();
        let app = Arc::clone(&self.app);
        self.execute(false, move |ctx, _| {
            if let Err(error) = check_target(&ctx, &app, &owner, &target) {
                return Outcome::Now(Err(error));
            }
            if !ctx.with(|pool| {
                pool.entry(&target.tab)
                    .is_some_and(|entry| entry.status == "ready")
            }) {
                return Outcome::Now(Ok(Value::Null));
            }
            let command = app.host.command(target.sidecar, command);
            Outcome::Later(Box::pin(command))
        })
    }

    pub fn facts(&self, tab: &str) -> EffectFuture<'static, Result<Value, Fault>> {
        self.call("tabFacts", json!({"tab": tab}), false)
    }

    pub fn pending_plan(&self, tab: &str) -> EffectFuture<'static, Result<Value, Fault>> {
        self.call("pendingPlan", json!({"tab": tab}), false)
    }

    pub fn note_stopped(&self, tab: &str) -> EffectFuture<'static, Result<Value, Fault>> {
        self.call("noteStopped", json!({"tab": tab}), false)
    }

    pub fn feed(
        &self,
        tab: &str,
        event: &str,
        payload: Value,
        from_link: bool,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        self.call(
            "feed",
            json!({"tab": tab, "event": event, "payload": payload, "fromLink": from_link}),
            false,
        )
    }

    pub fn attach_viewer(
        &self,
        owner: &Owner,
        tab: &str,
    ) -> Result<EffectFuture<'static, Result<Value, Fault>>, Fault> {
        let window = self.app.host.window_for(owner)?;
        self.app.host.authorize_tab(owner, tab)?;
        Ok(self.call("attachViewer", json!({"win": window, "tab": tab}), false))
    }

    pub fn close_tab(
        &self,
        owner: &Owner,
        tab: String,
    ) -> Result<EffectFuture<'static, Result<Value, Fault>>, Fault> {
        let window = self.app.host.window_for(owner)?;
        let source = self.source(owner, &tab)?;
        let released_tab = tab.clone();
        let expected = Arc::clone(&source);
        let owner = owner.clone();
        let checked_app = Arc::clone(&self.app);
        let closed = self.execute(false, move |ctx, _| {
            Outcome::Later(Box::pin(async move {
                checked_app.host.authorize_tab(&owner, &tab)?;
                if !checked_app
                    .sidecar(&tab)
                    .is_some_and(|current| Arc::ptr_eq(&current, &expected))
                {
                    return Ok(json!({"closed": false, "owner": false}));
                }
                let owns =
                    ctx.with(|pool| pool.entry(&tab).is_some_and(|entry| entry.win_id == window));
                let closed = if owns {
                    ctx.release_tab(&tab).await?
                } else {
                    ctx.detach_viewer(window, &tab).await?
                };
                Ok(json!({"closed": closed, "owner": owns}))
            }))
        });
        let app = Arc::clone(&self.app);
        Ok(Box::pin(async move {
            let result = closed.await?;
            if result["owner"] == true && result["closed"] == true {
                app.host.when_released(released_tab, source).await?;
            }
            Ok(result["closed"].clone())
        }))
    }

    pub fn answer(
        &self,
        owner: &Owner,
        tab: &str,
        id: &str,
        response: Value,
    ) -> Result<EffectFuture<'static, Result<Value, Fault>>, Fault> {
        let window = self.app.host.window_for(owner)?;
        self.app.host.authorize_tab(owner, tab)?;
        let choice = super::asks::describe_answer(&response);
        Ok(self.call(
            "routeSideChannel",
            json!({"tab": tab, "id": id, "frame": response, "responder": window, "choice": choice}),
            true,
        ))
    }

    pub fn snapshot(&self) -> EffectFuture<'static, Result<Value, Fault>> {
        let app = Arc::clone(&self.app);
        self.execute(false, move |ctx, _| Outcome::Now(Ok(snapshot(&ctx, &app))))
    }
}

fn snapshot<H: Host>(ctx: &Ctx, app: &Application<H>) -> Value {
    let rows = ctx.with(|pool| pool.entries.iter().map(|entry| json!({
        "tab": entry.tab_id, "device": entry.device, "sessionFile": entry.session_file, "kind": entry.kind,
        "openedBy": entry.opened_by, "openedBySession": entry.opened_by_session, "hosted": entry.hosted_view,
    })).collect::<Vec<_>>());
    Value::Array(
        rows.into_iter()
            .map(|mut row| {
                let tab = row["tab"].as_str().unwrap_or_default();
                let facts = ctx.tab_facts(tab);
                let plan = ctx.pending_plan(tab);
                let sidecar = app.sidecar(tab).map(|sidecar| sidecar.facts());
                row["facts"] = facts;
                row["pendingPlan"] = plan;
                if let Some(sidecar) = sidecar {
                    row["sidecar"] = sidecar;
                }
                row
            })
            .collect(),
    )
}

impl<H: Host> Drop for Service<H> {
    fn drop(&mut self) {
        locked(&self.pending).clear();
        let out = self.out;
        hub::post(move || out.close());
    }
}

fn finish(out: Out, token: u64, result: Result<Value, Fault>) {
    let item = match result {
        Ok(value) => {
            json!({"k": "__native_pool_result", "token": token, "ok": true, "value": value})
        }
        Err(error) => {
            json!({"k": "__native_pool_result", "token": token, "ok": false, "code": error.code, "message": error.message})
        }
    };
    out.push(&item);
}

fn closed() -> Fault {
    Fault::new("closed", "The native pool is closed")
}

struct Waiting {
    pending: Weak<Mutex<Pending>>,
    token: u64,
}
impl Drop for Waiting {
    fn drop(&mut self) {
        if let Some(pending) = self.pending.upgrade() {
            locked(&pending).remove(&self.token);
        }
    }
}

#[cfg(test)]
#[path = "native_tests.rs"]
mod tests;
