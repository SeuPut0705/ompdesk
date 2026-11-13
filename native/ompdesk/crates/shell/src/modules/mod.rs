//! Subsystems moved out of the Node main into the shell (batch SX, PROTOCOL.md §15). Each module owns one namespace
//! (`<namespace>.<name>` for every method, event and ask of it) and is one line of `MODULES`. Its CEF-bound code lives
//! in `modules/<namespace>/`; its pure rules live in the library (`src/<namespace>_core/`, declared in `lib.rs`), where
//! `cargo test` runs them and the tables captured from the TypeScript (PROTOCOL.md §15.3) without CEF.
//!
//! Threads: `request` and `event` run on the host's reader thread and must not block it: CEF work goes to the UI
//! thread (`crate::ui::post`), anything slow to a thread of its own; CEF objects are touched on the UI thread only.
//! A module reaches CEF through the crate's existing modules (`crate::window`, `crate::wc`, `crate::view`,
//! `crate::session`, `crate::tray`, …), never a second copy of them; Node through its `Ctx`; the core through
//! `Ctx::core`.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::{Value, json};
use shell_core::namespaces::{check_modules, namespace_of};
use shell_core::wire::WireError;

use crate::host::{self, Call};
use crate::log::log;

pub mod chrome;

/// A moved subsystem. One unit struct per module; its state lives in the module's own statics.
pub trait Module: Sync {
    /// The namespace it owns (`shell_core::namespaces::check_modules` rules).
    fn namespace(&self) -> &'static str;

    /// A request from Node in this namespace (`call.method` is the full name). Answer it exactly once; dropping it
    /// unanswered answers `failed`, and a name the module does not serve answers `call.unsupported()`.
    fn request(&self, ctx: Ctx, call: Call);

    /// An event from Node in this namespace. Default: logged and dropped.
    fn event(&self, ctx: Ctx, name: &str, data: Value, bin: Option<Vec<u8>>) {
        let _ = (ctx, data, bin);
        log("host.event_ignored", json!({ "event": name }));
    }

    /// CEF's context is up, just before `app.ready` goes to Node (so before Node can send this module anything).
    /// Runs on the UI thread: start OS hooks and CEF-side state here.
    fn ready(&self, ctx: Ctx) {
        let _ = ctx;
    }

    /// Node's `app.exit` arrived: release what the module holds before every window closes and CEF shuts down. Runs on
    /// the UI thread, in reverse registration order. Not run when Node died (the shell then exits at once).
    fn shutdown(&self, ctx: Ctx) {
        let _ = ctx;
    }
}

/// The registration list: one line per moved module, in the order `ready` runs. Batch SX's slices each add theirs
/// (PROTOCOL.md §15.1): `&chrome::Chrome`, `&preview::Preview`, `&services::Services`, `&updater::Updater`,
/// `&boot::Boot`.
static MODULES: &[&dyn Module] = &[&chrome::Chrome];

/// What a module may do on the wire, scoped to its namespace: every name it emits or asks is `<namespace>.<name>`.
#[derive(Clone, Copy)]
pub struct Ctx {
    namespace: &'static str,
}

#[expect(
    dead_code,
    reason = "the registry's API before batch SX's slices call it; the slice that makes the last of it live removes this"
)]
impl Ctx {
    fn full(&self, name: &str) -> String {
        format!("{}.{name}", self.namespace)
    }

    /// An event to Node, `<namespace>.<name>`. Dropped before Node connected.
    pub fn emit(&self, name: &str, data: Value) {
        host::event(&self.full(name), data);
    }

    /// An event to Node with raw bytes.
    pub fn emit_bin(&self, name: &str, data: Value, bin: &[u8]) {
        host::event_bin(&self.full(name), data, bin);
    }

    /// A request to Node, `<namespace>.<name>`, served by the module's TypeScript client (`serve`). `answer` runs on the
    /// reader thread. Returns the request's id (for a `{cancel: id}`).
    pub fn ask(
        &self,
        name: &str,
        params: Value,
        bin: Option<&[u8]>,
        answer: impl FnOnce(Result<Value, WireError>, Option<Vec<u8>>) + Send + 'static,
    ) -> u64 {
        host::request(&self.full(name), params, bin, answer)
    }

    /// A request to `ompdesk-core`, relayed by Node (`core.call`, PROTOCOL.md §15.2): Node owns the core's process
    /// until the core moves under the shell, when only this body changes. `timeout_ms` replaces the core client's 30 s.
    /// A fault keeps the core's `code`. `answer` runs on the reader thread.
    pub fn core(
        &self,
        method: &str,
        params: Value,
        bin: Option<&[u8]>,
        timeout_ms: Option<u64>,
        answer: impl FnOnce(Result<Value, WireError>, Option<Vec<u8>>) + Send + 'static,
    ) -> u64 {
        let mut relay = json!({ "method": method, "params": params });
        if let Some(ms) = timeout_ms {
            relay["timeoutMs"] = json!(ms);
        }
        host::request("core.call", relay, bin, answer)
    }

    /// A line of `<userData>/logs/gui-runtime.jsonl` (PROTOCOL.md §15.2 `log.runtime`): Node is the file's one writer.
    /// `report` is a `RuntimeLogReport` (`src/main/runtime-log-core.ts`: `kind`, `message`, `details`, …); `window_id`
    /// is Node's id of the window the line is about.
    pub fn runtime_log(&self, report: Value, window_id: Option<u64>) {
        let mut data = json!({ "report": report });
        if let Some(id) = window_id {
            data["windowId"] = json!(id);
        }
        host::event("log.runtime", data);
    }

    /// `runtime_log` with the window's project folder in the line's context (a window's own lines, as `window.ts` wrote
    /// them).
    pub fn runtime_log_in(&self, report: Value, window_id: u64, cwd: &str) {
        host::event(
            "log.runtime",
            json!({ "report": report, "windowId": window_id, "cwd": cwd }),
        );
    }
}

/// `MODULES` by namespace, its rules asserted once (a broken list is a programming error, as the core's `Registry`).
static REGISTRY: LazyLock<HashMap<&'static str, &'static dyn Module>> = LazyLock::new(|| {
    let namespaces: Vec<&str> = MODULES.iter().map(|m| m.namespace()).collect();
    if let Err(problem) = check_modules(&namespaces) {
        panic!("{problem}");
    }
    MODULES.iter().map(|m| (m.namespace(), *m)).collect()
});

fn ctx(module: &dyn Module) -> Ctx {
    Ctx {
        namespace: module.namespace(),
    }
}

/// A request no shim namespace took: its module's, else `unsupported`.
pub fn request(call: Call) {
    match REGISTRY.get(namespace_of(&call.method)) {
        Some(module) => module.request(ctx(*module), call),
        None => call.unsupported(),
    }
}

/// An event no shim namespace took: its module's, else logged and dropped.
pub fn event(name: &str, data: Value, bin: Option<Vec<u8>>) {
    match REGISTRY.get(namespace_of(name)) {
        Some(module) => module.event(ctx(*module), name, data, bin),
        None => log("host.event_ignored", json!({ "event": name })),
    }
}

/// Every module's `ready`, in registration order (`on_context_initialized`, before `app.ready`).
pub fn ready() {
    LazyLock::force(&REGISTRY);
    for module in MODULES {
        module.ready(ctx(*module));
    }
}

/// Every module's `shutdown`, in reverse registration order (the UI thread, on `app.exit`).
pub fn shutdown() {
    for module in MODULES.iter().rev() {
        module.shutdown(ctx(*module));
    }
}
