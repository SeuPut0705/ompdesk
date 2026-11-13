//! The Preview (PROTOCOL.md §15.6; panels-sidebar › Preview, multi-viewer-web › Phone preview): each window's tabs of
//! sandboxed pages, a paired viewer's offscreen pages streamed as JPEG frames, the agent's browsing through stock's
//! relay, and the agent's visuals (`gui_visualize`). The pages are this module's alone: `wc.rs` hands their events and
//! questions here (`page_event`, `may_navigate`, …) and Node hears nothing about them (§15.4 rule 4). Node keeps the
//! IPC handlers (`PREVIEW_*`) and calls this module's client (`src/main/shell-host/modules/preview.ts`).
//!
//! Every function here runs on the UI thread; the wire's handlers move there first.

mod host;
mod page;
mod relay;
mod scheme;
mod stream;
mod visualize;

use std::sync::OnceLock;

use serde_json::Value;

use super::{Ctx, Module};
use crate::host::Call;

pub struct Preview;

static CTX: OnceLock<Ctx> = OnceLock::new();

/// The module's wire (set in `ready`, before Node can send anything).
fn ctx() -> Ctx {
    *CTX.get().expect("the preview module is ready")
}

impl Module for Preview {
    fn namespace(&self) -> &'static str {
        "preview"
    }

    fn request(&self, _ctx: Ctx, call: Call) {
        crate::ui::run(move || host::request(call));
    }

    fn event(&self, _ctx: Ctx, name: &str, data: Value, _bin: Option<Vec<u8>>) {
        let name = name.to_owned();
        crate::ui::run(move || host::post(&name, data));
    }

    fn ready(&self, ctx: Ctx) {
        let _ = CTX.set(ctx);
    }

    fn shutdown(&self, _ctx: Ctx) {
        host::shutdown();
    }
}

// ------------------------------------------------------------------ what `wc.rs` hands over for the module's pages

/// A page event, in Electron's argument shapes (PROTOCOL.md §4).
pub fn page_event(wc_id: u64, name: &str, args: &Value) {
    host::page_event(wc_id, name, args);
}

/// The page's mirrored state changed (url, title, loading, history).
pub fn page_state(wc_id: u64) {
    host::page_event(wc_id, "state", &Value::Null);
}

/// `window.open` / `target=_blank` (always cancelled by the caller).
pub fn popup(wc_id: u64, url: &str) {
    host::popup(wc_id, url);
}

/// Whether the page may go to `url` on its own (a link, `location`, a form, a frame's load, a redirect).
pub fn may_navigate(wc_id: u64, main_frame: bool, redirect: bool, url: &str) -> bool {
    host::may_navigate(wc_id, main_frame, redirect, url)
}

/// `__ompdeskSendSync(channel, payload)` of the viewer pages' dialog preload; `answer` gets the value once.
pub fn sync_call(wc_id: u64, channel: &str, payload: Value, answer: impl FnOnce(Value) + 'static) {
    stream::sync_call(wc_id, channel, payload, Box::new(answer));
}

/// A download the page started (always cancelled by the caller).
pub fn download(wc_id: u64, url: &str) {
    host::download(wc_id, url);
}

/// An offscreen page painted (its pixels are in the page's entry).
pub fn painted(wc_id: u64) {
    stream::painted(wc_id);
}
