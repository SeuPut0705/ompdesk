//! The `chrome` module (PROTOCOL.md §15.5, batch SX1): the app windows' life, the application menu, the tray, the
//! quit, deep links, the GPU fallback and the main-thread watchdog. One file per area; each area serves the methods and
//! events of its own and returns what is not its (`request` gives the call back, `event` answers false). The pure rules
//! are `shell_core::chrome_core`.

use serde_json::Value;

use super::{Ctx, Module};
use crate::host::Call;

pub mod deep_link;
pub mod gpu;
pub mod hang;
mod menu;
pub mod quit;
mod tray;
pub mod window;

pub struct Chrome;

/// A request for an area: `Some(call)` back when the method is not one of the area's.
type Request = fn(Ctx, Call) -> Option<Call>;
/// An event for an area: false when the name is not one of the area's.
type Event = fn(Ctx, &str, &Value) -> bool;

struct Area {
    request: Request,
    event: Event,
    ready: fn(Ctx),
    shutdown: fn(Ctx),
}

/// In the order `ready` runs (`shutdown` the other way round).
const AREAS: &[Area] = &[
    Area {
        request: window::request,
        event: window::event,
        ready: window::ready,
        shutdown: window::shutdown,
    },
    Area {
        request: menu::request,
        event: menu::event,
        ready: menu::ready,
        shutdown: menu::shutdown,
    },
    Area {
        request: tray::request,
        event: tray::event,
        ready: tray::ready,
        shutdown: tray::shutdown,
    },
    Area {
        request: quit::request,
        event: quit::event,
        ready: quit::ready,
        shutdown: quit::shutdown,
    },
    Area {
        request: deep_link::request,
        event: deep_link::event,
        ready: deep_link::ready,
        shutdown: deep_link::shutdown,
    },
    Area {
        request: gpu::request,
        event: gpu::event,
        ready: gpu::ready,
        shutdown: gpu::shutdown,
    },
    Area {
        request: hang::request,
        event: hang::event,
        ready: hang::ready,
        shutdown: hang::shutdown,
    },
];

impl Module for Chrome {
    fn namespace(&self) -> &'static str {
        "chrome"
    }

    fn request(&self, ctx: Ctx, call: Call) {
        let mut call = call;
        for area in AREAS {
            match (area.request)(ctx, call) {
                Some(back) => call = back,
                None => return,
            }
        }
        call.unsupported();
    }

    fn event(&self, ctx: Ctx, name: &str, data: Value, _bin: Option<Vec<u8>>) {
        if !AREAS.iter().any(|area| (area.event)(ctx, name, &data)) {
            crate::log::log("host.event_ignored", serde_json::json!({ "event": name }));
        }
    }

    fn ready(&self, ctx: Ctx) {
        for area in AREAS {
            (area.ready)(ctx);
        }
    }

    fn shutdown(&self, ctx: Ctx) {
        for area in AREAS.iter().rev() {
            (area.shutdown)(ctx);
        }
    }
}
