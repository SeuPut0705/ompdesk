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

pub trait Host: effects::Host<Sidecar: Sidecar<Error = Fault>> + 'static {
    type Reservation: Send + 'static;
    fn window_for(&self, owner: &Owner) -> Result<i64, Fault>;
    fn reserve_owner(&self, owner: &Owner, tab: &str) -> Result<Self::Reservation, Fault>;
    fn finish_reservation(&self, reservation: Self::Reservation, acquired: bool);
    fn authorize_tab(&self, owner: &Owner, tab: &str) -> Result<(), Fault>;
    /// The actual release receipt registered inside Application::dispose, not a wait captured before release.
    fn when_released(&self, tab: String) -> EffectFuture<'static, ()>;
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
        self.app.host.authorize_tab(owner, &tab)?;
        let released_tab = tab.clone();
        let closed = self.execute(false, move |ctx, _| {
            Outcome::Later(Box::pin(async move {
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
                app.host.when_released(released_tab).await;
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
