//! `updater.*` (batch SX4, PROTOCOL.md §15.8): the app's own updater, moved out of Node (`updater.ts`,
//! `update-auth.ts`, `nsis-updater.ts`, `updater-state.ts`, `update-provider.ts`, `update-release.ts`). Its rules are
//! `shell_core::updater_core`; the work is `service.rs`. Node's client is `src/main/shell-host/modules/updater.ts`.

mod fetch;
mod platform;
mod service;
mod token;

use std::sync::{Arc, OnceLock};

use serde_json::json;

use super::{Ctx, Module};
use crate::host::Call;
use service::Service;

pub struct Updater;

static SERVICE: OnceLock<Arc<Service>> = OnceLock::new();

/// The one service; made at the module's first frame, so its `Ctx` is the module's.
fn service_with(ctx: Ctx) -> Arc<Service> {
    SERVICE.get_or_init(|| Arc::new(Service::new(ctx))).clone()
}

fn service() -> Arc<Service> {
    SERVICE
        .get()
        .expect("the updater service exists once a frame reached it")
        .clone()
}

/// Runs a request's work on a thread of its own (the reader thread never waits for the network or a process).
fn answer(
    call: Call,
    work: impl FnOnce(&Arc<Service>, &Call) -> Result<serde_json::Value, (&'static str, String)>
    + Send
    + 'static,
) {
    let service = service();
    std::thread::spawn(move || match work(&service, &call) {
        Ok(result) => call.ok(result),
        Err((code, message)) => call.err(code, message),
    });
}

impl Module for Updater {
    fn namespace(&self) -> &'static str {
        "updater"
    }

    fn request(&self, ctx: Ctx, call: Call) {
        service_with(ctx);
        match call.method.as_str() {
            "updater.start" => answer(call, |s, call| {
                let version = call.str("version").unwrap_or_default();
                Ok(s.start(&version))
            }),
            "updater.check" => answer(call, |s, _| Ok(s.check())),
            "updater.download" => answer(call, |s, _| Ok(s.download())),
            "updater.install" => answer(call, |s, call| {
                let trigger = call.str("trigger").unwrap_or_else(|| "user click".into());
                Ok(s.install(&trigger, call.str("presence").as_deref()))
            }),
            "updater.authInfo" => answer(call, |s, _| Ok(token::info(s))),
            "updater.authTest" => answer(call, |s, call| {
                Ok(token::test(s, call.str("token").as_deref()))
            }),
            "updater.authSave" => answer(call, |s, call| {
                token::save(s, &call.str("token").unwrap_or_default())
            }),
            "updater.authClear" => answer(call, |s, _| {
                token::clear(s);
                Ok(token::info(s))
            }),
            _ => call.unsupported(),
        }
    }

    fn event(&self, ctx: Ctx, name: &str, data: serde_json::Value, _bin: Option<Vec<u8>>) {
        if name != "updater.quit" {
            return crate::log::log("host.event_ignored", json!({ "event": name }));
        }
        let service = service_with(ctx);
        let trigger = data["trigger"].as_str().unwrap_or("quit").to_string();
        let presence = data["presence"].as_str().map(String::from);
        service.quit(&trigger, presence.as_deref());
    }

    fn shutdown(&self, _ctx: Ctx) {
        if let Some(service) = SERVICE.get() {
            service.shutdown();
        }
    }
}
