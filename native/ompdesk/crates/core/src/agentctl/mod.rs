//! The agent-control service (`ompdesk_*` tools; was `src/main/agent-control/**`): batch H3/H4a.
//!
//! - `journal`: the files the service keeps across launches (9g).
//! - `rules`: the small rules the service and its host read synchronously (9g).
//! - `app`: `ompdesk_app` and `ompdesk_app_list` (9l).

pub mod app;
pub mod journal;
pub mod rules;

use crate::server::Registry;

pub fn register(registry: &mut Registry) {
    app::register(registry);
}
